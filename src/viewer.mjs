import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STALE_AFTER_MS, STALE_AFTER_ENV, loadConfig } from './config.mjs';
import { DemoEngine } from './demo.mjs';
import { diagnosisForKey } from './diagnosis.mjs';
import { createFrameBuffers } from './frame-primitives.mjs';
import { normalizeLanguage, t } from './i18n.mjs';
import { loadOmoAppearance, loadOmoTheme } from './omo.mjs';
import {
  detailsSubjectKey, diagnosisForSelection, recordForSelection, renderApp,
} from './render.mjs';
import {
  createTheme, normalizeThemeName, paletteFor, supportsTruecolor, themeNames,
} from './theme.mjs';
import { loadViewState, saveViewState, structuralFor } from './view-state.mjs';
import {
  advanceScroll, applyFocus, attachFrame, settleScroll,
} from './view-model.mjs';
import { createViewerInput } from './viewer-input.mjs';
import { createViewerRuntime, demoSnapshotDue, framePacingFps } from './viewer-runtime.mjs';
import { createViewerSession } from './viewer-session.mjs';
import { createViewerSource, loadInitialSnapshot } from './viewer-source.mjs';

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
  createViewerState, detailsVerboseAvailable, keyboardScrollIntent, scrollRegionForFocus,
} from './viewer-session.mjs';

// Footer chrome dispatch moved with input; re-exporting keeps existing viewer
// imports working.
export { runFooterAction } from './viewer-input.mjs';

// The state-file adapter owns reads and the watch retry. Re-exporting keeps the
// published viewer imports working.
export { loadInitialSnapshot, watchRetryDelay } from './viewer-source.mjs';

// Frame pacing, the terminal adapter, and the pager live in the runtime. Their
// pure helpers stay importable from the viewer for existing tests.
export {
  VIEWER_CLOSE_STEPS, WIDE_IDLE_FPS, closeViewer, demoSnapshotDue, frameIntervalMs,
  framePacingFps, needsAnimationFrame, nextFrameDeadline, sanitizePagerText,
  terminalRestoreSequence,
} from './viewer-runtime.mjs';

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
  const loadViewStateFn = deps.loadViewState ?? loadViewState;
  const saveViewStateFn = deps.saveViewState ?? saveViewState;
  const diagnosisForKeyFn = deps.diagnosisForKey ?? diagnosisForKey;
  const exitFn = deps.exit ?? (code => process.exit(code));
  const watchRetryBaseMs = deps.watchRetryBaseMs ?? 1_000;

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

  // The adapter is assigned after the session/source factories; their callbacks
  // run only after composition completes, so the closure sees the instance.
  let runtime;
  let drawing = false;
  let again = false;
  let lastDemoAccept = 0;
  // One buffer handle for the viewer's lifetime: the scratch grids survive
  // frames and are repainted per use. Closing the viewer drops them with it.
  const frameBuffers = createFrameBuffers();
  let lastDrawAt = 0;
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
    if (runtime?.started && !drawing) runtime.requestFrame();
  }

  const session = createViewerSession({
    noMotion, language: initialLanguage, themeName: initialThemeName, fps,
    once, statePath, interactive, paneMode,
    loadViewStateFn, saveViewStateFn,
    requestRepaint, requestFrame: () => runtime?.requestFrame(), draw,
    close: (...args) => runtime?.close(...args), applyPalette,
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

  const source = createViewerSource({
    session,
    statePath,
    once,
    readStateFileFn: deps.readStateFile ?? undefined,
    watchFn: deps.watch ?? undefined,
    watchRetryBaseMs,
    requestRepaint,
  });

  runtime = createViewerRuntime({
    session,
    source,
    draw: () => draw(),
    stdout,
    interactive,
    demoMode,
    fps,
    closePaneId,
    terminalWidth,
    terminalHeight,
    exitFn,
    pagerCommandFn: deps.pagerCommand ?? undefined,
    spawnFn: deps.spawn ?? undefined,
    pagerTimeoutMs: deps.pagerTimeoutMs ?? undefined,
  });

  if (configError) {
    session.addToast(t(initialLanguage, 'toastConfigError', { error: configError.message }), 'failed');
  }

  const inputState = {
    get pagerActive() { return runtime.pagerActive; },
    get ignoreKeysUntil() { return runtime.ignoreKeysUntil; },
    set ignoreKeysUntil(value) { runtime.ignoreKeysUntil = value; },
    get mousePendingUntil() { return mousePendingUntil; },
    set mousePendingUntil(value) { mousePendingUntil = value; },
    get rawInput() { return rawInput; },
    set rawInput(value) { rawInput = value; },
    get closing() { return runtime.closing; },
  };
  const input = createViewerInput({
    session,
    state: inputState,
    requestFrame: () => runtime.requestFrame(),
    draw: () => draw(),
    close: (...args) => runtime.close(...args),
    openRecordInPager: runtime.openRecordInPager,
    setMouseCapture: runtime.setMouseCapture,
    engine,
    interactive,
    demoMode,
    diagnosisForKey: diagnosisForKeyFn,
    diagnosisForSelection,
    recordForSelection,
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
    if (runtime.closing) return;
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
        demoMode, pagerActive: runtime.pagerActive, width, preferredFps: fps, now, frameCostMs: ui.frameCostMs,
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

  async function main() {
    if (demoMode) {
      session.acceptSnapshot(engine.snapshot(Date.now()), { silent: true });
      session.ensureSelection();
      if (ui.follow) session.follow();
    } else if (statePath) {
      // Watch first: a one-shot producer may replace the snapshot while the
      // initial read or view-state load is still in flight.
      const result = await loadInitialSnapshot({
        statePath, interactive, setupWatch: source.setupFileWatch, load: () => source.loadState(true),
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
        source.showPlaceholder(once ? 'once' : 'watch');
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
    runtime.startInteractive(input);
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
    loadState: source.loadState,
    setupFileWatch: source.setupFileWatch,
    flushPendingWrites: session.flushPendingWrites,
    restoreTerminal: runtime.restoreTerminal,
    openRecordInPager: runtime.openRecordInPager,
    start: main,
    close: runtime.close,
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
