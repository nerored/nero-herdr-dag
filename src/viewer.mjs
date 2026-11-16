import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitKeypressEvents } from 'node:readline';
import { diagnosisForKey } from './diagnosis.mjs';
import { osc52, pagerCommand, payloadLines } from './clipboard.mjs';
import { DEFAULT_STALE_AFTER_MS, STALE_AFTER_ENV, loadConfig } from './config.mjs';
import { DemoEngine } from './demo.mjs';
import { createFrameBuffers } from './frame-primitives.mjs';
import { commandItems, filterCommands } from './commands.mjs';
import { normalizeLanguage, t } from './i18n.mjs';
import { isActiveRun } from './model.mjs';
import {
  detailsSubjectKey, diagnosisForSelection, recordForSelection, renderApp, snapshotFreshness,
} from './render.mjs';
import { recordForKey } from './records.mjs';
import {
  createTheme, normalizeThemeName, paletteFor, supportsTruecolor, themeNames,
} from './theme.mjs';
import { clean } from './text.mjs';
import { createHerdr } from './herdr.mjs';
import { extractMouse, mouseTrackingSequence, wheelDirectionFromButton } from './mouse.mjs';
import {
  GLOBAL_KEYMAP, MODAL_ORDER, PALETTE_KEYMAP, SETTINGS_KEYMAP, SWITCHER_KEYMAP, TOUR_KEYMAP,
  applyHelpScroll, helpKeyAction, helpScrollMetrics, isEscapeKey, keyToken, matchingKeys,
  resolveKey,
} from './viewer-keymap.mjs';
import { regionAt } from './scroll.mjs';
import {
  collapseTransition, expandTransition, loadViewState, saveViewState, structuralFor,
} from './view-state.mjs';
import { setNodeSubject } from './viewer-selection.mjs';
import {
  advanceScroll, applyFocus, attachFrame, hitTargetAt, selectRun, selectTask, settleScroll,
} from './view-model.mjs';
import { loadOmoAppearance, loadOmoTheme } from './omo.mjs';
import { readStateFile } from './viewer-snapshot.mjs';
import { createViewerSession } from './viewer-session.mjs';

// Snapshot I/O and validation live in viewer-snapshot.mjs. The re-export keeps
// the published viewer imports working for one release.
export {
  SNAPSHOT_LIMITS, ViewerSnapshotError, boundSnapshotInput, failedReadPlaceholder,
  pruneHiddenSubjects, readFailureEvidence, readStateFile, transitionChanges, viewSessionKey,
} from './viewer-snapshot.mjs';

// Selection reducers live in viewer-selection.mjs. Re-exporting them keeps the
// existing viewer imports and tests working while callers move to the module.
export {
  alignTaskSelection, applySwitcherSelection, applyTaskSelection, ensureSelectionState,
  revealScrollOffset, selectRunById, selectRunOverview, selectTaskAtPoint,
  selectTaskHit, selectionScrollTarget, setNodeSubject,
} from './viewer-selection.mjs';

// The view-model boundary owns reconciliation, focus, folding, scrolling and
// pointer resolution. Re-exporting the contract keeps the published viewer
// imports and tests working.
export {
  advanceScroll, applyFocus, applyFocusRequest, attachFrame, buildViewModel, chromeActionAt,
  focusForStructural, footerActionAt, hitTargetAt, reconcile, selectNode, selectRun, selectTask,
  settleScroll, toggleFold,
} from './view-model.mjs';

// Key normalization and the ordered key tables live in viewer-keymap.mjs.
// Re-exporting the pure helpers keeps the existing viewer imports and tests
// working while callers move to the module.
export {
  DUTY_FOCUS_KEYS, HELP_MAX_ROWS, HELP_ROWS, applyHelpScroll, dutyFocusForKey, helpKeyAction,
  helpScrollForKey, helpScrollMetrics, helpViewportRows, settingsHotkey,
} from './viewer-keymap.mjs';

// The session state factory and its pure scroll intents moved with the session
// module. Re-exporting them keeps existing viewer imports working.
export {
  createViewerState, keyboardScrollIntent, scrollRegionForFocus,
} from './viewer-session.mjs';


const INSTALL_GENERATION = (() => {
  const match = /(?:^|[/\\])(generation-\d+)(?:[/\\]|$)/.exec(fileURLToPath(import.meta.url));
  return match?.[1];
})();

// CLI parsing is pure so importing this module never reads argv, prints the
// help banner, or exits. Only the direct-invocation bootstrap at the bottom of
// this file consumes process.argv.
export class ViewerUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ViewerUsageError';
    this.exitCode = 2;
  }
}

const VIEWER_VALUE_FLAGS = new Map([
  ['--state', 'statePath'],
  ['--scenario', 'scenario'],
  ['--width', 'width'],
  ['--height', 'height'],
  ['--fps', 'fps'],
  ['--theme', 'theme'],
  ['--close-pane', 'closePaneId'],
]);

const VIEWER_BOOLEAN_FLAGS = new Map([
  ['--demo', 'demo'],
  ['--once', 'once'],
  ['--pane', 'pane'],
  ['--no-color', 'noColor'],
  ['--no-motion', 'noMotion'],
  ['--help', 'help'],
  ['-h', 'help'],
]);

const VIEWER_RANGES = Object.freeze({
  width: [20, 4096],
  height: [12, 512],
  fps: [2, 120],
});

const VIEWER_SCENARIOS = new Set(['early', 'late', 'integration']);

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const PAGER_TIMEOUT_MS = 10 * 60_000;

// Bounded exponential watch retry. A dead watch (directory removed, EMFILE,
// ENOSPC) is re-established instead of leaving the frame frozen forever.
export function watchRetryDelay(attempt, { base = 1_000, max = 30_000 } = {}) {
  return Math.min(max, base * 2 ** Math.max(0, attempt));
}

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

// Race a promise against a deadline without leaving a live timer behind when
// the promise wins (a detached 10-minute pager timer would keep tests alive).
function withDeadline(promise, ms, value) {
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve(value), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Install the watch before the first read so a one-shot producer that writes
// while the viewer is starting is not missed.
export async function loadInitialSnapshot({ statePath, interactive, setupWatch, load }) {
  if (statePath && interactive) setupWatch();
  return load();
}

function boundedInteger(flag, raw, [min, max]) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ViewerUsageError(`${flag} expects a number in ${min}..${max}`);
  }
  return Math.floor(value);
}

// Schema-driven CLI parser. Every value flag requires a real value (the next
// token must exist and must not itself be an option), numeric flags are finite
// and range-checked, and unknown tokens fail with exit code 2 instead of being
// ignored or consuming a following flag as data.
export function parseViewerArgs(argv = []) {
  const options = {
    help: false, demo: false, once: false, pane: false,
    noColor: false, noMotion: false, fps: 60, scenario: 'integration',
  };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    const booleanKey = VIEWER_BOOLEAN_FLAGS.get(token);
    if (booleanKey) {
      options[booleanKey] = true;
      continue;
    }
    const valueKey = VIEWER_VALUE_FLAGS.get(token);
    if (!valueKey) throw new ViewerUsageError(`unknown option ${token}`);
    const raw = argv[index + 1];
    if (raw === undefined || raw.startsWith('-')) {
      throw new ViewerUsageError(`${token} needs a value`);
    }
    index++;
    if (VIEWER_RANGES[valueKey]) {
      options[valueKey] = boundedInteger(token, raw, VIEWER_RANGES[valueKey]);
    } else if (valueKey === 'scenario') {
      if (!VIEWER_SCENARIOS.has(raw)) {
        throw new ViewerUsageError(`${token} expects early, late, or integration`);
      }
      options.scenario = raw;
    } else if (valueKey === 'theme') {
      const themeName = normalizeThemeName(raw);
      if (!themeName) throw new ViewerUsageError(`${token} expects ${themeNames.join(', ')}`);
      options.theme = themeName;
    } else {
      options[valueKey] = raw;
    }
  }
  return options;
}

export const HELP_TEXT = `herdr-dag-studio viewer

Usage:
  bun src/viewer.mjs --demo [options]
  bun src/viewer.mjs --state PATH [options]

Options:
  --demo              run the built-in fake workflow
  --scenario early|late  choose the demo start point
  --state PATH        watch a workflow snapshot file
  --once              render one frame and exit (default 120x40)
  --width N           frame width for --once (20..4096, default 120)
  --height N          frame height for --once (12..512, default 40)
  --fps N             animation frame rate (2..120, default 60)
  --theme NAME        system, dark, light, grok-day, or grok-night (default: OmO's theme)
  --no-color          disable ANSI color
  --no-motion         disable animated spinner, pulse, and edge dots
  --close-pane ID     close this Herdr pane on quit
  --pane              start compact; restore navigation when the pane is wide
  --help              show this help

Environment:
  ${STALE_AFTER_ENV}  capture age (ms) before a live snapshot is stale
                                 (default ${DEFAULT_STALE_AFTER_MS})
`;

// Fresh viewer UI state. createViewer() keeps its runtime (snapshot, render,
// watcher) in that instance's closure, so two viewers never share navigation
// state and tests can build isolated viewers instead of the process singleton.


// The duty body does not paint the tier-3 verbose blocks yet, so `d` is a
// wide/expanded-mode action there. The caller toasts that limitation instead of
// claiming a frame change that did not happen.
export function detailsVerboseAvailable(structural) {
  return structural === 'investigation' || structural === 'expanded';
}

export function runFooterAction(action, { toggleMouse, clear } = {}) {
  if (action === 'mouse') {
    toggleMouse?.();
    return true;
  }
  if (action === 'clear') {
    clear?.();
    return true;
  }
  return false;
}

// Input dispatch owns the key/mouse/modal event vocabulary and only writes the
// documented modal fields. It is declared at module scope so createViewer stays
// wiring + draw + main + the public API; the session object carries the durable
// state and commands it drives.
function createViewerInput(ctx) {
  const { session, state } = ctx;

  function onMouseEvent(mouse) {
    const { ui } = session;
    // Readline may also emit a keypress for the same bytes; ignore that copy.
    state.ignoreKeysUntil = Date.now() + 80;
    // Button bit 32 marks motion (drag). A terminal that leaves a motion mode
    // enabled must not turn dragging into repeated selection changes or modal
    // dismissal, so motion reports are never treated as clicks.
    if (mouse.button & 32) return;
    if (ui.settingsMenu) {
      if (!mouse.release && (mouse.button & 3) === 0) selectAt(mouse.x, mouse.y);
      return;
    }
    if (ui.help) {
      if (mouse.button & 64) {
        const direction = wheelDirectionFromButton(mouse.button);
        if (direction) session.scrollHelpPage(direction);
        return;
      }
      if (!mouse.release && (mouse.button & 3) === 0) {
        ui.help = false;
        ui.helpScroll = 0;
        session.helpFrameDrawn = false;
        void ctx.draw();
      }
      return;
    }
    if (mouse.button & 64) {
      applyWheel(mouse);
      return;
    }
    if (!mouse.release && (mouse.button & 3) === 0) selectAt(mouse.x, mouse.y);
  }

  function inputBytes(chunk) {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (chunk instanceof Uint8Array) {
      return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    // Already-decoded input (tests, embedding) keeps one character per byte.
    return Buffer.from(String(chunk), 'latin1');
  }

  function onRawInput(chunk) {
    if (state.pagerActive) return;
    state.rawInput = Buffer.concat([state.rawInput, inputBytes(chunk)]);
    if (state.rawInput.length > 8192) state.rawInput = state.rawInput.subarray(state.rawInput.length - 8192);
    const { events, rest, pending } = extractMouse(state.rawInput);
    const remainder = Buffer.isBuffer(rest) ? rest : Buffer.from(String(rest), 'latin1');
    state.rawInput = remainder.subarray(Math.max(0, remainder.length - 64));
    // readline also emits the partial report bytes as individual keys (its
    // digits are duty focus hotkeys), so key dispatch waits for the report to
    // finish instead of acting on a fragment.
    state.mousePendingUntil = pending ? Date.now() + 80 : 0;
    for (const event of events) onMouseEvent(event);
    if (events.length) ctx.requestFrame();
  }

  function applyWheel(mouse) {
    const { ui, vm } = session;
    const direction = wheelDirectionFromButton(mouse.button);
    if (!direction) return;
    // Wheel stays in the modal switcher; it never scrolls the frame underneath.
    if (ui.switcher) {
      session.moveSwitcherSelection(direction);
      return;
    }
    if (!vm.frame) return;
    const region = regionAt(mouse.x, mouse.y, vm.frame.hitboxes?.regions);
    if (!region) return;
    session.scrollRegionBy(region, direction * session.regionStep(region));
  }

  function selectAt(x, y) {
    const { ui, vm } = session;
    const snapshot = session.snapshot;
    if (!snapshot) return;
    // Read paths that install a failed-read placeholder do not redraw first;
    // point the model at the snapshot the next pointer event must resolve.
    vm.snapshot = snapshot;
    const target = hitTargetAt(vm, x, y);
    if (!target) return;
    if (target.kind === 'palette') {
      const items = filterCommands(commandItems(ui.language), ui.paletteFilter);
      const index = items.findIndex(item => item.id === target.id);
      if (index >= 0) {
        ui.paletteIndex = index;
        session.applyPaletteCommand(target.id);
      }
      return;
    }
    if (target.kind === 'palette-panel') return;
    if (target.kind === 'palette-backdrop') {
      session.closePalette();
      return;
    }
    if (target.kind === 'switcher') {
      session.confirmSwitcher(target.key);
      return;
    }
    if (target.kind === 'switcher-panel') return;
    if (target.kind === 'switcher-backdrop') {
      ui.switcher = null;
      return;
    }
    if (target.kind === 'settings') {
      const index = ['theme', 'animation', 'language'].indexOf(target.id);
      if (index >= 0) session.applySetting(index);
      return;
    }
    if (target.kind === 'settings-backdrop') {
      ui.settingsMenu = false;
      return;
    }
    if (target.kind === 'tasks-toggle') {
      ui.completedCollapsed = !ui.completedCollapsed;
      ui.tasksScroll = 0;
      ui.tasksScrollTarget = 0;
      return;
    }
    if (target.kind === 'context') {
      if (target.subject === 'run') {
        selectRun(vm, target.id, { overview: true });
        return;
      }
      if (target.subject === 'task') {
        session.selectTaskById(target.id, { announce: true });
        if (ui.expanded) {
          ui.focus = 'details';
          ui.lastFocus = 'tasks';
        }
        return;
      }
      // The breadcrumb node is painted from the previous frame. Re-resolve the
      // run in the current snapshot and require the node to still belong to it;
      // a stale hit must not retarget a same-id node in another run.
      const paintedRun = vm.frame?.run;
      const clickedNode = paintedRun?.nodes?.find(node => node.id === target.id);
      if (!paintedRun || !clickedNode) return;
      const index = session.runIndexById(paintedRun.id);
      if (index >= 0) {
        ui.runIndex = index;
        ui.selectedRunId = paintedRun.id;
        ui.runPinned = true;
      }
      ui.selectedNodeId = target.id;
      ui.runOverview = false;
      ui.selectedTaskId = clickedNode.taskId;
      ui.selectedTaskUnlinked = false;
      ui.follow = false;
      ui.followTarget = undefined;
      ui.manualScroll = false;
      if (ui.expanded) {
        ui.focus = 'details';
        ui.lastFocus = 'graph';
      } else {
        ui.focus = vm.frame?.layout?.layout === 'duty' ? 'cells' : 'graph';
      }
      return;
    }
    if (target.kind === 'chrome') {
      if (target.action === 'mouse' || target.action === 'clear') {
        runFooterAction(target.action, {
          toggleMouse: () => ctx.setMouseCapture(!ui.mouseCapture),
          clear: session.clearCompleted,
        });
      } else if (target.action === 'help') {
        ui.help = !ui.help;
        ui.helpScroll = 0;
        session.helpFrameDrawn = false;
      } else if (target.action === 'settings') {
        session.openSettingsMenu();
      }
      return;
    }
    if (target.kind === 'node') {
      const paintedRun = vm.frame?.run;
      const index = paintedRun ? session.runIndexById(paintedRun.id) : -1;
      const run = index >= 0 ? snapshot.runs[index] : undefined;
      const clickedNode = run?.nodes?.find(node => node.id === target.id);
      if (!run || !clickedNode) return;
      setNodeSubject(ui, snapshot, target.id, { runId: run.id, manualScroll: true });
      ui.focus = vm.frame?.layout?.layout === 'duty' ? 'cells' : 'graph';
      return;
    }
    if (target.kind === 'task') {
      const clicked = selectTask(vm, target.id);
      if (!clicked.handled) return;
      if (!clicked.linked) {
        session.addToast(t(ui.language, 'toastTaskUnlinked', { id: target.id }), 'warning');
      }
      if (ui.expanded) {
        ui.focus = 'details';
        ui.lastFocus = 'tasks';
      }
      return;
    }
    if (target.kind === 'run') {
      // A run row selects the run subject so the details pane paints RUN SUMMARY.
      selectRun(vm, target.id, { overview: true });
    }
  }

  function handleDiagnosisKey(key) {
    const { ui } = session;
    const snapshot = session.snapshot;
    if (!['c', 'p', 'o'].includes(key)) return false;
    if (key === 'o') {
      // Opening a raw record is status-independent: a completed task has no
      // diagnosis card, but its record is still the only place the full
      // final_response survives. The same safe-file gates apply to every status.
      const record = recordForSelection(snapshot, ui);
      if (!record) {
        session.addToast(t(ui.language, 'diagnosisNothing'), 'warning');
        return true;
      }
      const action = recordForKey('o', record);
      if (action.kind === 'open') void ctx.openRecordInPager(action.path);
      else session.addToast(t(ui.language, 'diagnosisOpenUnavailable'), 'warning');
      return true;
    }
    const diagnosis = diagnosisForSelection(snapshot, ui);
    if (!diagnosis) {
      session.addToast(t(ui.language, 'diagnosisNothing'), 'warning');
      return true;
    }
    // The copied bundle is the artifact the user keeps, so it must use the
    // same UI language as the diagnosis panel.
    const action = ctx.diagnosisForKey(key, diagnosis, undefined, ui.language);
    if (!action) return false;
    if (action.kind === 'copy-diagnosis' || action.kind === 'copy-paths') {
      if (!ctx.interactive || !process.stdout.isTTY) {
        session.addToast(t(ui.language, 'diagnosisCopyUnavailable'), 'warning');
        return true;
      }
      process.stdout.write(osc52(action.text));
      session.addToast(t(ui.language, 'diagnosisCopied', { lines: payloadLines(action.text) }), 'info');
    } else {
      session.addToast(t(ui.language, action.reason === 'no-paths' ? 'diagnosisNoPaths' : 'diagnosisOpenUnavailable'), 'warning');
    }
    return true;
  }

  function handlePaletteKey(key, pressed) {
    const { ui } = session;
    const action = resolveKey(PALETTE_KEYMAP, key, pressed);
    if (!action) return;
    if (action.id === 'close') { session.closePalette(); return; }
    if (action.id === 'move') { session.movePalette(action.value); return; }
    if (action.id === 'confirm') {
      const { active } = session.paletteView();
      if (active) session.applyPaletteCommand(active.id);
      return;
    }
    if (action.id === 'backspace') {
      ui.paletteFilter = ui.paletteFilter.slice(0, -1);
      ui.paletteIndex = 0;
      return;
    }
    if (action.id === 'type') {
      ui.paletteFilter += action.value;
      ui.paletteIndex = 0;
    }
  }

  function handleSwitcherKey(key, pressed) {
    const { ui } = session;
    const action = resolveKey(SWITCHER_KEYMAP, key, pressed);
    if (!action) return;
    switch (action.id) {
      case 'quit':
        void ctx.close({ closePane: true });
        return;
      case 'close':
        ui.switcher = null;
        return;
      case 'move':
        session.moveSwitcherSelection(action.value);
        return;
      case 'confirm':
        session.confirmSwitcher(undefined);
        return;
      case 'backspace': {
        const query = ui.switcher.query.slice(0, -1);
        ui.switcher = { ...ui.switcher, query };
        return;
      }
      case 'clearQuery':
        ui.switcher = { ...ui.switcher, query: '' };
        return;
      case 'type':
        ui.switcher = { ...ui.switcher, query: `${ui.switcher.query}${action.value}` };
        return;
      default:
        // '/' and every unconsumed key are modal no-ops: the switcher owns the
        // keyboard while it is open.
        return;
    }
  }

  function handleTourKey(key, pressed) {
    const { ui } = session;
    const action = resolveKey(TOUR_KEYMAP, key, pressed);
    if (action?.id === 'close') { ui.tour = 0; return; }
    if (action?.id === 'advance') { ui.tour = ui.tour >= 5 ? 0 : ui.tour + 1; }
  }

  function handleHelpKey(key, pressed) {
    const { ui } = session;
    const metrics = helpScrollMetrics(ctx.terminalHeight());
    const action = helpKeyAction(key, pressed, metrics);
    if (action === 'close') {
      ui.help = false;
      ui.helpScroll = 0;
      session.helpFrameDrawn = false;
      void ctx.draw();
    } else if (action === 'scroll' && applyHelpScroll(ui, key, pressed, metrics)) {
      session.helpFrameDrawn = false;
      void ctx.draw();
    }
  }

  function handleSettingsKey(key, pressed) {
    const { ui } = session;
    const action = resolveKey(SETTINGS_KEYMAP, key, pressed);
    if (!action) return;
    if (action.id === 'close') { ui.settingsMenu = false; return; }
    if (action.id === 'cycle') {
      ui.settingsIndex = (ui.settingsIndex + action.value + 3) % 3;
      return;
    }
    if (action.id === 'apply') session.applySetting(ui.settingsIndex);
  }

  const MODAL_HANDLERS = {
    switcher: handleSwitcherKey,
    palette: handlePaletteKey,
    tour: handleTourKey,
    help: handleHelpKey,
    settings: handleSettingsKey,
  };

  // Ordered modal dispatch: an open modal owns every key, and the first active
  // row in MODAL_ORDER wins. Global keys never fire underneath an overlay
  // unless the row explicitly yields that key (Settings yields the quit keys).
  function dispatchModal(key, pressed) {
    for (const modal of MODAL_ORDER) {
      if (!modal.active(session.ui)) continue;
      if (modal.preemptedBy?.(key, pressed)) continue;
      MODAL_HANDLERS[modal.id](key, pressed);
      return true;
    }
    return false;
  }

  function runGlobalAction({ id, value }, key, pressed) {
    const { ui, vm } = session;
    const snapshot = session.snapshot;
    switch (id) {
      case 'quit':
        void ctx.close({ closePane: true });
        return true;
      case 'escape': {
        if (ui.graphFilter !== 'all' || ui.graphFocus) {
          ui.graphFilter = 'all';
          ui.graphFocus = undefined;
          return true;
        }
        const collapsed = collapseTransition(ui);
        if (collapsed) Object.assign(ui, collapsed);
        return true;
      }
      case 'runOverviewBack': {
        const run = snapshot?.runs?.[ui.runIndex];
        if (!run) return false;
        selectRun(vm, run.id, { overview: true });
        return true;
      }
      case 'graphFilter':
        ui.graphFilter = ['all', 'failed', 'blocked', 'running', 'critical'][value];
        ui.graphFocus = undefined;
        return true;
      case 'focusNode': {
        const run = snapshot?.runs[ui.runIndex];
        if (!run?.nodes?.length) return true;
        if (ui.graphFocus) {
          ui.graphFocus = undefined;
          return true;
        }
        const nodeId = ui.selectedNodeId ?? run.nodes[0].id;
        ui.selectedNodeId = nodeId;
        ui.runOverview = false;
        ui.selectedTaskId = run.nodes.find(node => node.id === nodeId)?.taskId;
        ui.selectedTaskUnlinked = false;
        ui.focus = vm.frame?.layout?.layout === 'duty' ? 'cells' : 'graph';
        ui.graphFocus = nodeId;
        ui.follow = false;
        ui.followTarget = undefined;
        return true;
      }
      case 'stepNode':
        session.stepGraphNode(value);
        return true;
      case 'undo':
        session.undoCleared();
        return true;
      case 'palette':
        session.openPalette();
        return true;
      case 'help':
        ui.help = !ui.help;
        ui.helpScroll = 0;
        session.helpFrameDrawn = false;
        return true;
      case 'settings':
        session.openSettingsMenu();
        return true;
      case 'mouseCapture':
        ctx.setMouseCapture(!ui.mouseCapture);
        return true;
      case 'clearCompleted':
        session.clearCompleted();
        return true;
      case 'restoreHidden':
        session.restoreHidden();
        return true;
      case 'sidebar':
        if (ctx.terminalWidth() >= 112) {
          ui.sidebar = !ui.sidebar;
          session.addToast(t(ui.language, ui.sidebar ? 'toastSidebarOn' : 'toastSidebarOff'), 'info');
        } else session.addToast(t(ui.language, 'toastSidebarHidden'), 'warning');
        return true;
      case 'follow':
        ui.follow = !ui.follow;
        if (ui.follow) {
          ui.runPinned = false;
          session.follow();
        }
        session.addToast(t(ui.language, ui.follow ? 'toastFollowOn' : 'toastFollowOff'), 'info');
        return true;
      case 'demoReset':
        ctx.engine.reset();
        ui.hiddenRunIds.clear();
        ui.hiddenTaskIds.clear();
        ui.toasts = [];
        session.addToast(t(ui.language, 'toastDemoReset'), 'warning');
        return true;
      case 'verbose': {
        const structural = vm.frame?.layout?.layout ?? structuralFor(ctx.terminalWidth(), {
          expanded: ui.expanded, sidebar: session.sidebarEnabled(),
        });
        if (!detailsVerboseAvailable(structural)) {
          session.addToast(t(ui.language, 'toastDetailsWideOnly'), 'warning');
          return true;
        }
        ui.verbose = !ui.verbose;
        session.addToast(t(ui.language, ui.verbose ? 'toastDetailsVerbose' : 'toastDetailsCompact'), 'info');
        return true;
      }
      case 'dutyFocus': {
        const structural = vm.frame?.layout?.layout ?? structuralFor(ctx.terminalWidth(), {
          expanded: ui.expanded, sidebar: session.sidebarEnabled(),
        });
        applyFocus(vm, value.focus, structural, vm.frame?.scroll);
        session.helpFrameDrawn = false;
        return true;
      }
      case 'diagnosis':
        return handleDiagnosisKey(key);
      case 'expand':
        if (!ui.expanded) Object.assign(ui, expandTransition(ui));
        return true;
      case 'switcher':
        session.openSwitcher();
        return true;
      case 'completed':
        ui.completedCollapsed = !ui.completedCollapsed;
        ui.tasksScroll = 0;
        ui.tasksScrollTarget = 0;
        return true;
      case 'taskScope': {
        const structural = structuralFor(ctx.terminalWidth(), {
          expanded: ui.expanded, sidebar: session.sidebarEnabled(),
        });
        if (structural !== 'investigation' || !session.sidebarEnabled() || ui.expanded) {
          session.openSwitcher();
          return true;
        }
        ui.taskScope = ui.taskScope === 'run' ? 'all' : 'run';
        ui.tasksScroll = 0;
        ui.tasksScrollTarget = 0;
        return true;
      }
      case 'cycle':
        session.cycle(value);
        return true;
      case 'switchRun':
        session.switchRun(value);
        return true;
      case 'keyboardScroll':
        return session.dispatchKeyboardScroll(key, pressed);
      case 'detailsSection':
        session.jumpDetailsSection(value);
        return true;
      case 'detailsToggle':
        session.toggleDetailsSection();
        return true;
      case 'fold':
        session.foldSelectedNode();
        return true;
      default:
        return false;
    }
  }

  function handleGlobalKey(key, pressed) {
    const { ui } = session;
    for (const hit of matchingKeys(GLOBAL_KEYMAP, key, pressed, { ui, context: { demoMode: ctx.demoMode } })) {
      if (runGlobalAction(hit, key, pressed) !== false) return;
    }
  }

  function handleKey(text, pressed) {
    const { ui } = session;
    if (state.pagerActive) return;
    const key = keyToken(text, pressed);
    // Dismissal is exempt from the close/pointer debounce: Esc must always
    // close Help or Settings, even while a mouse report is still settling.
    if (isEscapeKey(key, pressed) && (ui.settingsMenu || ui.help)) {
      ui.settingsMenu = false;
      ui.help = false;
      ui.helpScroll = 0;
      session.helpFrameDrawn = false;
      return;
    }
    if (state.closing || Date.now() < state.ignoreKeysUntil || Date.now() < state.mousePendingUntil) return;
    if (dispatchModal(key, pressed)) return;
    handleGlobalKey(key, pressed);
  }

  return { onMouseEvent, onRawInput, selectAt, handleKey };
}

// Each viewer owns its snapshot, watcher, render cache, and UI state. The
// factory accepts injected loaders/output so tests exercise the same handlers
// without touching the operator's config or the process argv.
export async function createViewer(options = {}, deps = {}) {
  const demoMode = Boolean(options.demo);
  const statePath = options.statePath;
  const once = Boolean(options.once);
  const stdout = deps.stdout ?? process.stdout;
  const stdin = deps.stdin ?? process.stdin;
  const interactive = options.interactive ??
    (Boolean(stdout.isTTY && stdin.isTTY) && !once);
  const closePaneId = options.closePaneId;
  const paneMode = Boolean(options.pane);
  const noColor = Boolean(options.noColor) || Boolean(process.env.NO_COLOR);
  const noMotion = Boolean(options.noMotion);
  const fps = options.fps ?? 60;
  const scenario = options.scenario ?? 'integration';
  const startAt = deps.now?.() ?? Date.now();
  const write = deps.write ?? (text => stdout.write(text));
  const loadConfigFn = deps.loadConfig ?? loadConfig;
  const loadOmoThemeFn = deps.loadOmoTheme ?? loadOmoTheme;
  const loadOmoAppearanceFn = deps.loadOmoAppearance ?? loadOmoAppearance;
  const readStateFileFn = deps.readStateFile ?? readStateFile;
  const loadViewStateFn = deps.loadViewState ?? loadViewState;
  const saveViewStateFn = deps.saveViewState ?? saveViewState;
  const watchFn = deps.watch ?? watch;
  const pagerCommandFn = deps.pagerCommand ?? pagerCommand;
  const diagnosisForKeyFn = deps.diagnosisForKey ?? diagnosisForKey;
  const spawnFn = deps.spawn ?? spawn;
  const exitFn = deps.exit ?? (code => process.exit(code));
  const watchRetryBaseMs = deps.watchRetryBaseMs ?? 1_000;
  const pagerTimeoutMs = deps.pagerTimeoutMs ?? PAGER_TIMEOUT_MS;

  let initialLanguage = 'en';
  let initialThemeName;
  let configError;
  try {
    const config = await loadConfigFn();
    initialLanguage = normalizeLanguage(config.language);
    initialThemeName = config.theme;
  } catch (error) {
    configError = error;
  }
  initialThemeName = normalizeThemeName(initialThemeName) ?? await loadOmoThemeFn().catch(() => 'system');
  initialThemeName = normalizeThemeName(initialThemeName) ?? 'system';
  const cliTheme = normalizeThemeName(options.theme);
  if (cliTheme) initialThemeName = cliTheme;
  const appearance = await loadOmoAppearanceFn();
  const Engine = deps.DemoEngine ?? DemoEngine;
  const engine = demoMode ? new Engine({
    now: startAt,
    startOffset: scenario === 'early' ? 0 : scenario === 'late' ? 96_000 : 32_000,
  }) : null;

  let watcher;
  let watchTimer;
  let watchRetryTimer;
  let watchAttempt = 0;
  let frameTimer;
  let pagerChild;
  let pagerActive = false;
  let drawing = false;
  let again = false;
  let closing = false;
  let started = false;
  let fatalHandler;
  let lastDemoAccept = 0;
  // One buffer handle for the viewer's lifetime: the scratch grids survive
  // frames and are repainted per use. Closing the viewer drops them with it.
  const frameBuffers = createFrameBuffers();
  let lastDrawAt = 0;
  let ignoreKeysUntil = 0;
  // stdin is consumed as raw bytes: X10 mouse payloads are single bytes, so a
  // UTF-8 decoded string cannot represent coordinates above 0x7f faithfully.
  let rawInput = Buffer.alloc(0);
  let mousePendingUntil = 0;

  let palette;
  let theme;
  function applyPalette() {
    palette = paletteFor(ui.themeName, { appearance });
    theme.palette = palette;
  }

  // Any visible change outside a draw must repaint now; otherwise an idle view
  // waits up to a second for the 1 fps tick.
  function requestRepaint() {
    if (started && !drawing) requestFrame();
  }

  const session = createViewerSession({
    noMotion, language: initialLanguage, themeName: initialThemeName, fps,
    once, statePath, interactive, paneMode,
    readStateFileFn, loadViewStateFn, saveViewStateFn,
    requestRepaint, requestFrame, draw, close, applyPalette,
    terminalWidth, terminalHeight,
  });
  const ui = session.ui;
  const vm = session.vm;
  ui.installVersion = INSTALL_GENERATION;

  palette = paletteFor(ui.themeName, { appearance });
  theme = createTheme({
    palette,
    color: !noColor,
    truecolor: supportsTruecolor(),
  });

  if (configError) {
    session.addToast(t(initialLanguage, 'toastConfigError', { error: configError.message }), 'failed');
  }

  const inputState = {
    get pagerActive() { return pagerActive; },
    get ignoreKeysUntil() { return ignoreKeysUntil; },
    set ignoreKeysUntil(value) { ignoreKeysUntil = value; },
    get mousePendingUntil() { return mousePendingUntil; },
    set mousePendingUntil(value) { mousePendingUntil = value; },
    get rawInput() { return rawInput; },
    set rawInput(value) { rawInput = value; },
    get closing() { return closing; },
  };
  const input = createViewerInput({
    session,
    state: inputState,
    requestFrame: () => requestFrame(),
    draw: () => draw(),
    close: (...args) => close(...args),
    openRecordInPager,
    setMouseCapture,
    engine,
    interactive,
    demoMode,
    diagnosisForKey: diagnosisForKeyFn,
    terminalWidth,
    terminalHeight,
  });

  // --width/--height describe the --once frame (the help used to promise
  // 120x40 while the flags also widened interactive watch mode). Watch mode
  // always follows the pane; --once defaults to the documented 120x40.
  function terminalWidth() {
    if (once) return options.width === undefined ? 120 : Math.max(20, Math.floor(options.width));
    return Math.max(20, Math.floor(deps.columns ?? process.stdout.columns ?? 120));
  }

  function terminalHeight() {
    if (once) return options.height === undefined ? 40 : Math.max(12, Math.floor(options.height));
    return Math.max(12, Math.floor(deps.rows ?? process.stdout.rows ?? 40));
  }

  function draw() {
    if (closing) return;
    // A modal help overlay is static. Skipping the full-frame repaint here
    // avoids visible tearing/flicker in terminals that repaint partial frames.
    if (ui.help && session.helpFrameDrawn) return;
    if (drawing) { again = true; return; }
    drawing = true;
    try {
      const now = Date.now();
      const elapsed = lastDrawAt ? Math.min(100, now - lastDrawAt) : 0;
      lastDrawAt = now;
      if (demoMode && engine) {
        if (demoSnapshotDue(now, lastDemoAccept)) {
          lastDemoAccept = now;
          session.acceptSnapshot(engine.snapshot(now));
        }
      }
      const width = terminalWidth();
      const height = terminalHeight();
      const structural = structuralFor(width, {
        expanded: ui.expanded, sidebar: session.sidebarEnabled(),
      });
      // N3: duty has no graph/task pane, so a graph/tasks focus inherited from a
      // wide frame lands on the duty body. Explicit runs/cells focus survives.
      applyFocus(vm, ui.focus, structural, vm.frame?.scroll);
      session.ensureSelection();
      if (ui.follow && session.snapshot?.connected) session.follow(now);
      // Follow may repoint the subject; the overlay still owns focus until Esc.
      applyFocus(vm, ui.focus, structural, vm.frame?.scroll);
      const nextDetailsKey = detailsSubjectKey(session.snapshot, ui);
      if (ui.detailsKey !== nextDetailsKey) {
        ui.detailsKey = nextDetailsKey;
        ui.detailsScroll = 0;
        ui.detailsScrollTarget = 0;
        ui.collapsedSections.clear();
      }
      const nextTaskRevealKey = `${ui.selectedTaskId ?? ''}|${ui.focus}`;
      if (ui.taskRevealKey !== nextTaskRevealKey) {
        ui.taskRevealKey = nextTaskRevealKey;
        session.revealTaskSelection();
      }
      const layoutInfo = session.graphLayoutInfo();
      const graphVisible = structural === 'investigation';
      session.scrollSelectedIntoView(layoutInfo);
      if (graphVisible) {
        advanceScroll(ui, 'graph', session.maxGraphScroll(layoutInfo), elapsed, interactive);
      }
      ui.toasts = ui.toasts.filter(toast => now - toast.at < 6500);
      applyPalette();
      ui.fps = framePacingFps(session.snapshot, ui, {
        demoMode, pagerActive, width, preferredFps: fps, now, frameCostMs: ui.frameCostMs,
      });
      const renderStart = Date.now();
      const result = renderApp(vm, {
        width, height, time: now - startAt, now, palette, theme,
        graphLayout: layoutInfo?.layout, sidebar: session.sidebarEnabled(), buffers: frameBuffers,
      });
      ui.frameCostMs = Date.now() - renderStart;
      attachFrame(vm, result);
      settleScroll(vm, result, { elapsed, interactive });
      if (interactive) {
        const frame = result.text.replaceAll('\n', '\x1b[K\r\n');
        write(`\x1b[H${frame}\x1b[K\x1b[J`);
      } else {
        write(result.text + '\n');
      }
      session.helpFrameDrawn = ui.help;
    } finally {
      drawing = false;
      if (again) { again = false; void draw(); }
    }
  }

  function restoreTerminal() {
    if (!(interactive || stdout.isTTY)) return;
    process.stdin.setRawMode?.(false);
    stdout.write(terminalRestoreSequence());
  }

  function enterTerminal() {
    stdout.write(`\x1b[?1049h\x1b[?25l${mouseTrackingSequence(ui.mouseCapture !== false)}`);
    process.stdin.setRawMode?.(true);
  }

  async function close({ closePane = false, code = 0 } = {}) {
    if (closing) return;
    closing = true;
    if (fatalHandler) {
      process.removeListener('uncaughtException', fatalHandler);
      process.removeListener('unhandledRejection', fatalHandler);
      fatalHandler = undefined;
    }
    clearTimeout(frameTimer);
    clearTimeout(watchTimer);
    clearTimeout(watchRetryTimer);
    watcher?.close();
    watcher = undefined;
    if (pagerChild) {
      const child = pagerChild;
      pagerChild = undefined;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      await withDeadline(childExit(child), 100, { timeout: true });
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    await session.flushPendingWrites();
    restoreTerminal();
    if (closePane && closePaneId) {
      try {
        await createHerdr()('close', closePaneId);
      } catch (error) {
        process.stderr.write(`dag-studio: cannot close pane: ${error.message}\n`);
      }
    }
    exitFn(code);
  }

  function setMouseCapture(enabled) {
    if (ui.mouseCapture === enabled) return;
    ui.mouseCapture = enabled;
    if (interactive || process.stdout.isTTY) process.stdout.write(mouseTrackingSequence(enabled));
    session.addToast(t(ui.language, enabled ? 'toastMouseControls' : 'toastMouseSelection'), enabled ? 'info' : 'warning');
    session.helpFrameDrawn = false;
    void draw();
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
        session.helpFrameDrawn = false;
        requestFrame();
      }
    }
  }

  function scheduleWatchRetry() {
    try { watcher?.close(); } catch { /* already closed */ }
    watcher = undefined;
    if (closing) return;
    clearTimeout(watchRetryTimer);
    const attempt = watchAttempt++;
    watchRetryTimer = setTimeout(() => {
      if (closing) return;
      setupFileWatch();
      // Re-read after re-establishing: the file may have changed while the
      // watch was dead. loadState's generation guard drops any stale overlap.
      void session.loadState(true);
    }, watchRetryDelay(attempt, { base: watchRetryBaseMs }));
  }

  function setupFileWatch() {
    if (!statePath || closing) return;
    clearTimeout(watchRetryTimer);
    try {
      watcher = watchFn(dirname(statePath), (_event, name) => {
        if (name && String(name) !== basename(statePath)) return;
        clearTimeout(watchTimer);
        watchTimer = setTimeout(() => { void session.loadState(); }, 50);
      });
      watcher.on('error', error => {
        session.addToast(t(ui.language, 'toastWatchError', { error: error.message }), 'failed');
        scheduleWatchRetry();
      });
      watchAttempt = 0;
    } catch (error) {
      session.addToast(t(ui.language, 'toastWatchUnavailable', { error: error.message }), 'warning');
      scheduleWatchRetry();
    }
  }

  let frameDeadline = 0;

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

  async function main() {
    if (demoMode) {
      session.acceptSnapshot(engine.snapshot(Date.now()), { silent: true });
      session.ensureSelection();
      if (ui.follow) session.follow();
    } else if (statePath) {
      // Watch first: a one-shot producer may replace the snapshot while the
      // initial read or view-state load is still in flight.
      const result = await loadInitialSnapshot({
        statePath, interactive, setupWatch: setupFileWatch, load: () => session.loadState(true),
      });
      if (result.kind === 'unreadable' && once) {
        console.error(`dag-studio: cannot read snapshot: ${statePath}: ${result.error?.message ?? 'unknown error'}`);
        process.exitCode = 1;
        return;
      }
      if (result.kind === 'invalid' && once) {
        console.error(`dag-studio: cannot render snapshot: ${statePath}: ${result.error?.message ?? 'invalid snapshot'}`);
        process.exitCode = 1;
        return;
      }
      if (result.kind !== 'ok') {
        session.showPlaceholder(once ? 'once' : 'watch');
        if (result.kind === 'invalid') session.addToast(t(ui.language, 'toastInvalidSnapshot'), 'failed');
        else session.addToast(t(ui.language, 'toastWaitingSnapshot'), 'warning');
      } else if (session.snapshot.mode === 'saved' && !session.snapshot.runs.length) {
        session.addToast(t(ui.language, 'toastSavedSnapshotEmpty'), 'warning');
      }
    } else {
      console.error('dag-studio: use --demo or --state PATH. See --help.');
      process.exitCode = 1;
      return;
    }
    if (!interactive) {
      draw();
      return;
    }
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
        session.helpFrameDrawn = false;
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
    ui,
    options: { demoMode, statePath, once, interactive, paneMode, closePaneId },
    get snapshot() { return session.snapshot; },
    get fullSnapshot() { return session.fullSnapshot; },
    get lastRender() { return vm.frame; },
    get graphLayoutCacheStats() { return session.graphLayoutCacheStats; },
    acceptSnapshot: session.acceptSnapshot,
    draw,
    handleKey: input.handleKey,
    onMouseEvent: input.onMouseEvent,
    onRawInput: input.onRawInput,
    selectAt: input.selectAt,
    confirmSwitcher: session.confirmSwitcher,
    openSwitcher: session.openSwitcher,
    ensureSelection: session.ensureSelection,
    loadState: session.loadState,
    setupFileWatch,
    flushPendingWrites: session.flushPendingWrites,
    restoreTerminal,
    openRecordInPager,
    start: main,
    close,
  };
}

// CLI-only bootstrap: importing the module is side-effect free, so tests and
// embedders never inherit the runner's argv or read the operator's config.
const invokedDirectly = typeof import.meta.main === 'boolean'
  ? import.meta.main
  : Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  let options;
  try {
    options = parseViewerArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`dag-studio: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 2;
  }
  if (options) {
    if (options.help) {
      console.log(HELP_TEXT);
      process.exit(0);
    }
    let viewer;
    try {
      viewer = await createViewer(options);
      await viewer.start();
    } catch (error) {
      // An unexpected throw must not leave raw mode / the alternate screen on.
      viewer?.restoreTerminal();
      process.stderr.write(`dag-studio: ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    }
  }
}
