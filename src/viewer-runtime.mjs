import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { pagerCommand } from './clipboard.mjs';
import { createHerdr } from './herdr.mjs';
import { t } from './i18n.mjs';
import { isActiveRun } from './model.mjs';
import { mouseTrackingSequence } from './mouse.mjs';
import { snapshotFreshness } from './render-view.mjs';
import { clean } from './text.mjs';
import { structuralFor } from './view-state.mjs';

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const PAGER_TIMEOUT_MS = 10 * 60_000;

// Frame pacing never replays missed intervals: a stall (pager, suspend) is
// coalesced into one immediate frame and the deadline is re-anchored to now.
export function nextFrameDeadline(previousDeadline, now, delayMs) {
  const base = previousDeadline < now - delayMs ? now : previousDeadline;
  return base + delayMs;
}

// Full-rate frames are only useful while something can visibly change. A
// static run or a quiet task list can idle; input and state changes request an
// immediate frame instead of waiting for the idle tick.
export function needsAnimationFrame(snapshot, ui, { demoMode = false, pagerActive = false, now = Date.now() } = {}) {
  if (!ui?.motion || pagerActive || ui.help || ui.switcher || ui.settingsMenu) return false;
  if (demoMode) return true;
  const scrolling = ['graph', 'tasks', 'runs', 'cells', 'details'].some(region =>
    (ui[`${region}Scroll`] ?? 0) !== (ui[`${region}ScrollTarget`] ?? 0));
  if (scrolling) return true;
  const run = snapshot?.runs?.[ui.runIndex];
  const live = (run && isActiveRun(run)) ||
    (snapshot?.tasks ?? []).some(task => task.status === 'running');
  // A stale capture freezes its activity animations on the capture instant, so
  // a full-rate loop would only repaint an unchanging frame.
  if (!live) return false;
  return !snapshotFreshness(snapshot, { now, staleAfterMs: ui.staleAfterMs }).stale;
}

// The wide three-pane layout must stay visibly animated: its LIVE pulse,
// gradient title, and breathing borders stutter at the narrow idle tick.
// Narrow/duty views keep the 1 fps idle tick to stay cheap.
export const WIDE_IDLE_FPS = 24;

export function framePacingFps(snapshot, ui, {
  demoMode = false, pagerActive = false, now = Date.now(), width = 120, preferredFps = 60, frameCostMs = 0,
} = {}) {
  const animated = needsAnimationFrame(snapshot, ui, { demoMode, pagerActive, now });
  // The pager owns the screen while it runs, and --no-motion asks for static
  // frames, so neither may inherit the wide floor.
  const floor = ui?.motion && !pagerActive && structuralFor(width) === 'investigation'
    ? WIDE_IDLE_FPS : 1;
  // A frame that does not fit its budget must not be requested at full rate:
  // on a slow terminal or a very large graph the 60 fps loop otherwise pins a
  // core to render frames the terminal cannot consume. The measured cost is
  // the previous frame's render time, so the cap is one frame behind but never
  // oscillates inside a single frame.
  const cost = Number(frameCostMs);
  if (!Number.isFinite(cost) || cost <= 0) {
    return Math.max(animated ? preferredFps : floor, floor);
  }
  const paced = cost >= 40 ? 10 : cost >= 25 ? 15 : cost >= 12 ? 30 : preferredFps;
  return animated
    ? Math.max(1, Math.min(Math.max(preferredFps, floor), paced))
    : Math.max(1, Math.min(floor, paced));
}

// The effective interval is unquantized so the footer's requested fps and the
// timer cadence agree (flooring 1000/60 produced 62.5 Hz).
export function frameIntervalMs(fps, motion = true) {
  return motion ? Math.max(8, 1000 / fps) : 1000;
}

// The demo engine produces a new raw world every frame, but the task/progress
// fields it changes are read at interface speed, not animation speed. Accept
// a demo snapshot at most ten times a second; animations still use the frame
// clock, and full normalization stops running 60 times a second.
export function demoSnapshotDue(now, lastAt, minMs = 100) {
  return !Number.isFinite(lastAt) || now - lastAt >= minMs;
}

// Pager input is untrusted record data. Strip terminal control sequences per
// line so cat/less -R cannot execute OSC/CSI bytes from a crafted JSON record.
export function sanitizePagerText(text) {
  return String(text ?? '').split('\n').map(line => clean(line)).join('\n');
}

export function terminalRestoreSequence() {
  return `${mouseTrackingSequence(false)}\x1b[?25h\x1b[?1049l`;
}

// close() is a fixed teardown sequence. Keeping it as data makes the order a
// single reviewable contract and lets a test assert it without timing tricks.
export const VIEWER_CLOSE_STEPS = Object.freeze([
  'timers', 'watcher', 'pager', 'pendingWrites', 'terminal', 'closePane', 'exit',
]);

export async function closeViewer(steps = {}) {
  for (const name of VIEWER_CLOSE_STEPS) {
    const step = steps[name];
    if (step) await step();
  }
}

// Race a promise against a deadline without leaving a live timer behind when
// the promise wins (a detached 10-minute pager timer would keep tests alive).
function withDeadline(promise, ms, value) {
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve(value), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function childExit(child) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once('error', error => done({ error }));
    child.once('exit', (status, signal) => done({ status, signal }));
  });
}

// The runtime owns terminal state, the frame clock, the pager child, stdin
// handlers, signals, and the close sequence. It receives draw/session/source
// adapters and never writes the session snapshot or view model.
export function createViewerRuntime({
  session,
  source,
  draw = () => {},
  stdout = process.stdout,
  interactive = false,
  demoMode = false,
  fps = 60,
  closePaneId,
  terminalWidth = () => 120,
  terminalHeight = () => 40,
  exitFn = code => process.exit(code),
  pagerCommandFn = pagerCommand,
  spawnFn = spawn,
  pagerTimeoutMs = PAGER_TIMEOUT_MS,
} = {}) {
  const ui = session.ui;
  let frameTimer;
  let frameDeadline = 0;
  let pagerChild;
  let pagerActive = false;
  let closing = false;
  let started = false;
  let fatalHandler;
  let ignoreKeysUntil = 0;

  function restoreTerminal() {
    if (!(interactive || stdout.isTTY)) return;
    process.stdin.setRawMode?.(false);
    stdout.write(terminalRestoreSequence());
  }

  function enterTerminal() {
    stdout.write(`\x1b[?1049h\x1b[?25l${mouseTrackingSequence(ui.mouseCapture !== false)}`);
    process.stdin.setRawMode?.(true);
  }

  function requestFrame() {
    clearTimeout(frameTimer);
    if (closing) return;
    // The next tick draws after the current state change; tickFrame then picks
    // the adaptive interval for the following frame.
    frameDeadline = Date.now();
    frameTimer = setTimeout(tickFrame, 0);
  }

  function scheduleFrame() {
    clearTimeout(frameTimer);
    if (closing) return;
    const delayMs = frameDelay();
    frameDeadline = Date.now() + delayMs;
    frameTimer = setTimeout(tickFrame, delayMs);
  }

  function frameDelay() {
    return frameIntervalMs(framePacingFps(session.snapshot, ui, {
      demoMode, pagerActive, width: terminalWidth(), preferredFps: fps,
    }), ui.motion);
  }

  function tickFrame() {
    if (closing) return;
    if (pagerActive) {
      frameTimer = setTimeout(tickFrame, frameDelay());
      return;
    }
    // Re-anchor a stale deadline so a long stall replays at most one frame
    // instead of one frame per missed interval.
    const now = Date.now();
    const delayMs = frameDelay();
    frameDeadline = nextFrameDeadline(frameDeadline, now, delayMs);
    frameTimer = setTimeout(tickFrame, Math.max(0, frameDeadline - now));
    void draw();
  }

  function setMouseCapture(enabled) {
    if (!session.applyMouseCapture(enabled)) return;
    if (interactive || process.stdout.isTTY) process.stdout.write(mouseTrackingSequence(enabled));
    void draw();
  }

  // Records are untrusted JSON. Copy a control-stripped version into a private
  // temporary file so even `cat`/`less -R` cannot emit embedded OSC/CSI bytes.
  async function preparePagerRecord(path) {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_RECORD_BYTES) return undefined;
    const text = await readFile(path, 'utf8');
    const dir = await mkdtemp(join(tmpdir(), 'dag-studio-record-'));
    const cleanedPath = join(dir, 'record.txt');
    await writeFile(cleanedPath, sanitizePagerText(text), { mode: 0o600 });
    return { dir, path: cleanedPath };
  }

  // The pager runs asynchronously so signal handlers and terminal restore stay
  // live while it owns the screen. The frame loop is suspended until it exits.
  async function openRecordInPager(path) {
    const pager = pagerCommandFn(process.env);
    if (!pager) {
      session.addToast(t(ui.language, 'diagnosisNoPager'), 'warning');
      return;
    }
    let prepared;
    pagerActive = true;
    clearTimeout(frameTimer);
    try {
      prepared = await preparePagerRecord(path);
      if (!prepared) {
        session.addToast(t(ui.language, 'diagnosisOpenUnavailable'), 'warning');
        return;
      }
      restoreTerminal();
      const child = spawnFn(pager.command, [...pager.args, prepared.path], {
        stdio: 'inherit',
        env: process.env,
      });
      pagerChild = child;
      const exit = childExit(child);
      const result = await withDeadline(exit, pagerTimeoutMs, { timeout: true });
      if (result.timeout) {
        child.kill('SIGTERM');
        await withDeadline(exit, 250, { timeout: true });
        child.kill('SIGKILL');
        session.addToast(t(ui.language, 'diagnosisOpenFailed'), 'warning');
      } else if (result.error || result.status !== 0) {
        session.addToast(t(ui.language, 'diagnosisOpenFailed'), 'warning');
      }
    } catch {
      session.addToast(t(ui.language, 'diagnosisOpenFailed'), 'warning');
    } finally {
      pagerChild = undefined;
      if (prepared) await rm(prepared.dir, { recursive: true, force: true }).catch(() => {});
      pagerActive = false;
      if (!closing && interactive) {
        enterTerminal();
        ignoreKeysUntil = Date.now() + 300;
        session.invalidateHelpFrame();
        requestFrame();
      }
    }
  }

  async function teardownPager() {
    if (!pagerChild) return;
    const child = pagerChild;
    pagerChild = undefined;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    await withDeadline(childExit(child), 100, { timeout: true });
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  async function close({ closePane = false, code = 0 } = {}) {
    if (closing) return;
    closing = true;
    if (fatalHandler) {
      process.removeListener('uncaughtException', fatalHandler);
      process.removeListener('unhandledRejection', fatalHandler);
      fatalHandler = undefined;
    }
    await closeViewer({
      timers: () => {
        clearTimeout(frameTimer);
        source?.clearTimers();
      },
      watcher: () => source?.closeWatcher(),
      pager: () => teardownPager(),
      pendingWrites: () => session.flushPendingWrites(),
      terminal: () => restoreTerminal(),
      closePane: async () => {
        if (!closePane || !closePaneId) return;
        try {
          await createHerdr()('close', closePaneId);
        } catch (error) {
          process.stderr.write(`dag-studio: cannot close pane: ${error.message}\n`);
        }
      },
      exit: () => exitFn(code),
    });
  }

  // The interactive bootstrap is the only place stdin/stdout/signals are
  // attached. main() decides whether the viewer is interactive; this method
  // performs the exact HEAD wiring and returns after the first frame is due.
  function startInteractive(input) {
    fatalHandler = error => {
      closing = true;
      restoreTerminal();
      process.stderr.write(`dag-studio: fatal: ${error?.stack ?? error}\n`);
      exitFn(1);
    };
    process.once('uncaughtException', fatalHandler);
    process.once('unhandledRejection', fatalHandler);
    try {
      enterTerminal();
      process.stdin.resume();
      // Keep stdin in Buffer mode: raw X10 mouse payload bytes must reach
      // onRawInput unchanged. emitKeypressEvents decodes its own UTF-8 copy
      // for the key handler.
      process.stdin.on('data', input.onRawInput);
      // readline otherwise waits 500ms for a possible escape sequence before
      // emitting a lone Esc, which makes modal dismissal feel unresponsive.
      emitKeypressEvents(process.stdin, { escapeCodeTimeout: 30 });
      process.stdin.on('keypress', (text, pressed) => {
        input.handleKey(text, pressed);
        requestFrame();
      });
      process.stdout.on('resize', () => {
        session.invalidateHelpFrame();
        requestFrame();
      });
      process.on('SIGTERM', () => { void close(); });
      process.on('SIGINT', () => { void close(); });
      process.on('SIGHUP', () => { void close(); });
      draw();
      scheduleFrame();
      started = true;
    } catch (error) {
      restoreTerminal();
      throw error;
    }
  }

  return {
    get pagerActive() { return pagerActive; },
    get closing() { return closing; },
    get started() { return started; },
    get ignoreKeysUntil() { return ignoreKeysUntil; },
    set ignoreKeysUntil(value) { ignoreKeysUntil = value; },
    requestFrame,
    scheduleFrame,
    setMouseCapture,
    openRecordInPager,
    restoreTerminal,
    startInteractive,
    close,
  };
}
