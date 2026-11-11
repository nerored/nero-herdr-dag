import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { emitKeypressEvents } from 'node:readline';
import { diagnosisForKey } from './diagnosis.mjs';
import { osc52, pagerCommand, payloadLines } from './clipboard.mjs';
import {
  DEFAULT_STALE_AFTER_MS, STALE_AFTER_ENV, loadConfig, saveConfig, staleAfterMs,
} from './config.mjs';
import { DemoEngine } from './demo.mjs';
import { computeLayout, nodeScrollTarget } from './graph.mjs';
import { languageLabel, normalizeLanguage, t } from './i18n.mjs';
import { findRunningTarget, isActiveRun, nodeForTask, normalizeSnapshot, TERMINAL } from './model.mjs';
import {
  detailsSubjectKey, dashboardLayout, diagnosisForSelection, navTasks, recordForSelection,
  renderApp, snapshotFreshness, switcherView, taskAtPoint,
} from './render.mjs';
import { recordForKey } from './records.mjs';
import { paletteFor, createTheme, supportsTruecolor, themeNames, normalizeThemeName } from './theme.mjs';
import { clamp, clean } from './text.mjs';
import { createHerdr } from './herdr.mjs';
import { extractMouse, isLeftClick, mouseTrackingSequence, parseMouse, wheelDirectionFromButton } from './mouse.mjs';
import { keyboardScrollTarget, regionAt, smoothScroll } from './scroll.mjs';
import {
  advanceRunSelection, collapseTransition, completedItems, expandTransition, foldedFromView,
  followTargetForRun, hiddenSnapshot, holdsPendingRun, loadViewState, moveSwitcher,
  reconcileRunSelection, saveViewState, setExpanded, structuralFor, switcherItems, syncFoldedRun,
} from './view-state.mjs';
import { loadOmoAppearance, loadOmoTheme } from './omo.mjs';

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

// A snapshot is data, not a trusted program: cap what the viewer will load and
// map so a hostile or accidental high-cardinality file cannot exhaust memory
// before normalization rejects it.
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const PAGER_TIMEOUT_MS = 10 * 60_000;

export const SNAPSHOT_LIMITS = Object.freeze({
  runs: 256,
  tasks: 8_192,
  nodesPerRun: 4_096,
  edgesPerRun: 16_384,
  rateSamples: 32,
});

export class ViewerSnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ViewerSnapshotError';
  }
}

// Read with a hard byte ceiling. The handle is opened first so the size check
// and the bounded read happen against the same descriptor; a file that grows
// between stat and read is still truncated to the cap and rejected.
export async function readStateFile(path, { maxBytes = MAX_STATE_BYTES, openFn = open } = {}) {
  const handle = await openFn(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ViewerSnapshotError(`${path} is not a regular file`);
    if (info.size > maxBytes) {
      throw new ViewerSnapshotError(`snapshot is ${info.size} bytes (limit ${maxBytes})`);
    }
    const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) {
      throw new ViewerSnapshotError(`snapshot read exceeded ${maxBytes} bytes`);
    }
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}

function boundedRate(value) {
  return Array.isArray(value) && value.length > SNAPSHOT_LIMITS.rateSamples
    ? value.slice(-SNAPSHOT_LIMITS.rateSamples)
    : value;
}

function boundedRateSubject(subject) {
  if (!subject || typeof subject !== 'object') return subject;
  const tokenRate = boundedRate(subject.tokenRate);
  const tokenRateHistory = boundedRate(subject.tokenRateHistory);
  if (tokenRate === subject.tokenRate && tokenRateHistory === subject.tokenRateHistory) return subject;
  return { ...subject, tokenRate, tokenRateHistory };
}

// Bound the array cardinality before normalizeSnapshot maps it. Count caps fail
// closed (a caller sees a distinct invalid-snapshot result); rate histories keep
// only the tail the normalizer actually uses.
export function boundSnapshotInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ViewerSnapshotError('snapshot must be a JSON object');
  }
  if (!Array.isArray(raw.runs)) throw new ViewerSnapshotError('snapshot is missing runs[]');
  if (raw.runs.length > SNAPSHOT_LIMITS.runs) {
    throw new ViewerSnapshotError(`snapshot has ${raw.runs.length} runs (limit ${SNAPSHOT_LIMITS.runs})`);
  }
  if (raw.tasks !== undefined && !Array.isArray(raw.tasks)) {
    throw new ViewerSnapshotError('snapshot tasks must be an array');
  }
  if ((raw.tasks?.length ?? 0) > SNAPSHOT_LIMITS.tasks) {
    throw new ViewerSnapshotError(`snapshot has ${raw.tasks.length} tasks (limit ${SNAPSHOT_LIMITS.tasks})`);
  }
  let changed = false;
  const runs = raw.runs.map(run => {
    if (!run || typeof run !== 'object') return run;
    if (Array.isArray(run.nodes) && run.nodes.length > SNAPSHOT_LIMITS.nodesPerRun) {
      throw new ViewerSnapshotError(`run ${run.id ?? '?'} has ${run.nodes.length} nodes (limit ${SNAPSHOT_LIMITS.nodesPerRun})`);
    }
    if (Array.isArray(run.edges) && run.edges.length > SNAPSHOT_LIMITS.edgesPerRun) {
      throw new ViewerSnapshotError(`run ${run.id ?? '?'} has ${run.edges.length} edges (limit ${SNAPSHOT_LIMITS.edgesPerRun})`);
    }
    let runChanged = false;
    const nodes = Array.isArray(run.nodes)
      ? run.nodes.map(node => {
        const bounded = boundedRateSubject(node);
        if (bounded !== node) runChanged = true;
        return bounded;
      })
      : run.nodes;
    if (!runChanged) return run;
    changed = true;
    return { ...run, nodes };
  });
  let tasks = raw.tasks;
  if (Array.isArray(tasks)) {
    let tasksChanged = false;
    tasks = tasks.map(task => {
      const bounded = boundedRateSubject(task);
      if (bounded !== task) tasksChanged = true;
      return bounded;
    });
    if (tasksChanged) changed = true;
    else tasks = raw.tasks;
  }
  if (!changed) return raw;
  return { ...raw, runs, tasks };
}

// The placeholder uses sessionId 'pending'; preferences must never be loaded or
// saved under it, and a real snapshot may arrive with a different session id.
export function viewSessionKey(snapshot) {
  const id = snapshot?.sessionId;
  return typeof id === 'string' && id.length > 0 && id !== 'pending' ? id : undefined;
}

const HIDDEN_TERMINAL_STATUSES = TERMINAL;

// Hidden ids are a per-session convenience, not a permanent tombstone. An id
// that reappears as a non-terminal subject (a demo cycle reusing its ids, or a
// live session restarting a task) must become visible again.
export function pruneHiddenSubjects(ui, state) {
  if (!ui || !state) return;
  const runs = new Map((state.runs ?? []).map(run => [run.id, run]));
  for (const id of [...(ui.hiddenRunIds ?? [])]) {
    const run = runs.get(id);
    if (run && !HIDDEN_TERMINAL_STATUSES.has(run.status)) ui.hiddenRunIds.delete(id);
  }
  const tasks = new Map((state.tasks ?? []).map(task => [task.id, task]));
  for (const id of [...(ui.hiddenTaskIds ?? [])]) {
    const task = tasks.get(id);
    if (task && !HIDDEN_TERMINAL_STATUSES.has(task.status)) ui.hiddenTaskIds.delete(id);
  }
}

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
  demoMode = false, pagerActive = false, now = Date.now(), width = 120, preferredFps = 60,
} = {}) {
  const animated = needsAnimationFrame(snapshot, ui, { demoMode, pagerActive, now });
  // The pager owns the screen while it runs, and --no-motion asks for static
  // frames, so neither may inherit the wide floor.
  const floor = ui?.motion && !pagerActive && structuralFor(width) === 'investigation'
    ? WIDE_IDLE_FPS : 1;
  return Math.max(animated ? preferredFps : floor, floor);
}

// The effective interval is unquantized so the footer's requested fps and the
// timer cadence agree (flooring 1000/60 produced 62.5 Hz).
export function frameIntervalMs(fps, motion = true) {
  return motion ? Math.max(8, 1000 / fps) : 1000;
}

// Every scrollbar-backed region eases toward its target; wheel/key steps move
// the target and the draw loop advances the painted offset with this helper.
export function advanceScroll(ui, region, maxScroll, elapsedMs, interactive = true) {
  const key = `${region}Scroll`;
  const targetKey = `${region}ScrollTarget`;
  const max = Math.max(0, maxScroll ?? 0);
  ui[targetKey] = clamp(ui[targetKey] ?? 0, 0, max);
  ui[key] = interactive
    ? clamp(smoothScroll(ui[key] ?? 0, ui[targetKey], elapsedMs), 0, max)
    : ui[targetKey];
  return { key, targetKey, from: ui[key] };
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
export function createViewerState({
  noMotion = false, language = 'en', themeName, fps = 60,
  staleAfter = staleAfterMs(), ...overrides
} = {}) {
  return {
    runIndex: 0,
    selectedRunId: undefined,
    runPinned: false,
    // The run itself is the details subject (RUN SUMMARY) instead of a node.
    runOverview: false,
    focus: 'graph',
    lastFocus: 'graph',
    mouseCapture: true,
    selectedNodeId: undefined,
    selectedTaskId: undefined,
    // Durable: the task subject is explicit but has no node in the loaded runs.
    // The graph keeps its run context yet paints no node highlight.
    selectedTaskUnlinked: false,
    installVersion: undefined,
    follow: true,
    followTarget: undefined,
    motion: !noMotion,
    help: false,
    helpScroll: 0,
    staleAfterMs: staleAfter,
    language,
    settingsMenu: false,
    settingsIndex: 0,
    verbose: false,
    folded: new Set(),
    foldedRunId: undefined,
    foldedByRun: new Map(),
    graphScroll: 0,
    graphScrollTarget: 0,
    manualScroll: false,
    tasksScroll: 0,
    tasksScrollTarget: 0,
    runsScroll: 0,
    runsScrollTarget: 0,
    cellsScroll: 0,
    cellsScrollTarget: 0,
    detailsScroll: 0,
    detailsScrollTarget: 0,
    detailsKey: undefined,
    taskRevealKey: undefined,
    expanded: false,
    returnFocus: 'graph',
    switcher: null,
    hiddenRunIds: new Set(),
    hiddenTaskIds: new Set(),
    themeName,
    sidebar: true,
    fps,
    toasts: [],
    ...overrides,
  };
}

// Align the explicit task subject with the run and node that own it. A
// replacement or externally driven task change must move the graph subject too;
// otherwise the breadcrumb names one task while the graph still highlights an
// unrelated node.
export function alignTaskSelection(ui, state, taskId) {
  ui.selectedTaskId = taskId;
  if (!taskId) {
    ui.selectedTaskUnlinked = false;
    ui.selectedNodeId = undefined;
    return undefined;
  }
  const preferRunId = ui.selectedRunId ?? state.runs[ui.runIndex]?.id;
  const linked = nodeForTask(state, taskId, { preferRunId });
  if (!linked) {
    ui.selectedTaskUnlinked = true;
    ui.selectedNodeId = undefined;
    return undefined;
  }
  const index = state.runs.findIndex(run => run.id === linked.run.id);
  if (index >= 0) {
    ui.runIndex = index;
    ui.selectedRunId = linked.run.id;
  }
  ui.selectedNodeId = linked.node.id;
  ui.selectedTaskUnlinked = false;
  return linked;
}

// Pure reconciliation used before every draw and on snapshot acceptance. It
// keeps run/task identity valid, but an explicit task selection without a
// loaded node owns the graph subject: auto-picking a node there would recreate
// the unrelated highlight the task click just cleared.
export function ensureSelectionState(ui, state) {
  if (!state) return;
  if (!state.runs.length) {
    ui.runIndex = 0;
    ui.selectedRunId = undefined;
    ui.runPinned = false;
    ui.selectedNodeId = undefined;
    // A task-only snapshot (or one whose runs are all hidden) still paints the
    // task list and task details. Clearing the task subject here would undo
    // every task click on the next draw, so validate it against the navigation
    // list and drop only a task that is no longer present.
    const tasks = navTasks(state);
    if (!tasks.some(task => task.id === ui.selectedTaskId)) {
      ui.selectedTaskId = undefined;
      ui.selectedTaskUnlinked = false;
    }
    ui.focus = 'tasks';
    syncFoldedRun(ui, undefined);
    return;
  }
  const selection = reconcileRunSelection(state.runs, {
    runIndex: ui.runIndex,
    selectedRunId: ui.selectedRunId,
  });
  ui.runIndex = selection.index;
  ui.selectedRunId = selection.selectedRunId;
  if (ui.runPinned && !state.runs.some(run => run.id === selection.selectedRunId)) {
    ui.runPinned = false;
  }
  // A run-level subject stays run-level across snapshots until the user picks a
  // node or task; do not fall back to the run's first node on every draw.
  if (ui.runOverview) {
    ui.selectedNodeId = undefined;
    ui.selectedTaskId = undefined;
    ui.selectedTaskUnlinked = false;
    syncFoldedRun(ui, state.runs[ui.runIndex]?.id);
    return;
  }
  const tasks = navTasks(state);
  if (!tasks.some(task => task.id === ui.selectedTaskId)) {
    // A node click can name a task the host store did not accept (the live
    // snapshot often has nodes but zero accepted tasks). Keep the clicked node
    // as the graph/cells subject instead of aligning to another task that
    // would move the highlight back to the run's first node.
    const run = state.runs[ui.runIndex];
    const nodeOwnsSubject = (ui.focus === 'graph' || ui.focus === 'cells')
      && run?.nodes.some(node => node.id === ui.selectedNodeId);
    if (nodeOwnsSubject) {
      ui.selectedTaskId = undefined;
      ui.selectedTaskUnlinked = false;
    } else {
      const replacement = tasks.find(task => task.status === 'running') ?? tasks[0];
      alignTaskSelection(ui, state, replacement?.id);
    }
  }
  // A later snapshot may supply the run for a task that was unlinked when the
  // user selected it. Adopt that node instead of leaving the subject neutral.
  if (ui.selectedTaskUnlinked && ui.selectedTaskId) {
    const linked = nodeForTask(state, ui.selectedTaskId);
    if (linked) {
      const index = state.runs.indexOf(linked.run);
      if (index >= 0) {
        ui.runIndex = index;
        ui.selectedRunId = linked.run.id;
      }
      ui.selectedNodeId = linked.node.id;
      ui.selectedTaskUnlinked = false;
    }
  }
  const run = state.runs[ui.runIndex];
  const unlinkedTaskOwnsSubject = ui.selectedTaskUnlinked &&
    (ui.focus === 'tasks' || (ui.focus === 'details' && ui.lastFocus === 'tasks'));
  if (unlinkedTaskOwnsSubject) {
    ui.selectedNodeId = undefined;
  } else if (!run.nodes.some(node => node.id === ui.selectedNodeId)) {
    ui.selectedNodeId = (run.nodes.find(node => node.state === 'running') ?? run.nodes[0])?.id;
  }
  syncFoldedRun(ui, run.id);
}

// N3 duty focus contract. 1/2/3 request the RUNS, CELLS, and DUTY regions; the
// structural class decides which focus value is actually meaningful. The
// renderer paints runs/cells/details focus in duty, while investigation falls
// back to the panes that are painted there (tasks/graph/details).

export const DUTY_FOCUS_KEYS = Object.freeze({ '1': 'runs', '2': 'cells', '3': 'details' });

export function dutyFocusForKey(key) {
  return DUTY_FOCUS_KEYS[key];
}

// Frame metrics exist before focus can be trusted: a region with viewportH 0
// is not painted. When the caller supplies last-frame scroll info, focus is
// normalized onto a painted region so a hidden RUNS/CELLS/tasks pane cannot
// keep the keyboard focus (and scroll keys) on nothing visible.
function hasPaintedMetrics(scrollInfo) {
  if (!scrollInfo) return false;
  return ['runs', 'cells', 'tasks', 'graph', 'details']
    .some(region => Number.isFinite(scrollInfo?.[region]?.viewportH));
}

export function focusForStructural(focus, structural, scrollInfo) {
  const painted = region => (scrollInfo?.[region]?.viewportH ?? 0) > 0;
  const measured = hasPaintedMetrics(scrollInfo);
  if (structural === 'duty') {
    const next = focus === 'runs' || focus === 'cells' || focus === 'details' ? focus : 'details';
    return measured && next !== 'details' && !painted(next) ? 'details' : next;
  }
  if (structural === 'investigation') {
    let next = focus;
    if (focus === 'runs') next = 'tasks';
    else if (focus === 'cells') next = 'graph';
    else if (focus !== 'tasks' && focus !== 'graph' && focus !== 'details') next = 'graph';
    if (measured && next === 'tasks' && !painted('tasks')) next = 'graph';
    return next;
  }
  return 'details';
}

// Move focus into a region that exists in the current structural class. When a
// duty graph/task focus is inherited from a wide frame, the saved owner is
// retained so the duty body still shows the task subject instead of silently
// snapping back to a node.
export function applyFocusRequest(ui, focus, structural, scrollInfo) {
  const next = focusForStructural(focus, structural, scrollInfo);
  if (structural === 'duty' && (focus === 'graph' || focus === 'tasks')) ui.lastFocus = focus;
  ui.focus = next;
  return next;
}

// A scroll key may only move a painted region. Duty lists fall back to the duty
// body when the terminal is too short to paint them; investigation keeps its
// existing graph/tasks/details mapping.
export function scrollRegionForFocus(focus, structural, scrollInfo = {}) {
  if (structural === 'investigation') {
    if (focus === 'details') return 'details';
    if (focus === 'tasks') return (scrollInfo.tasks?.viewportH ?? 0) > 0 ? 'tasks' : 'graph';
    return 'graph';
  }
  if (focus === 'runs' || focus === 'cells') {
    return (scrollInfo[focus]?.viewportH ?? 0) > 0 ? focus : 'details';
  }
  return 'details';
}

// Pure key intent used by dispatchKeyboardScroll and by the regression tests.
// Focus is translated to the existing keyboardScrollTarget vocabulary, then the
// returned region is restored to runs/cells when those are the painted duty
// lists.
export function keyboardScrollIntent(key, pressed, focus, structural, scrollInfo = {}, { pageSize } = {}) {
  const region = scrollRegionForFocus(focus, structural, scrollInfo);
  if (!region) return null;
  const info = scrollInfo?.[region] ?? {};
  const mappedFocus = region === 'runs' ? 'tasks' : region === 'cells' ? 'graph' : region;
  const size = pageSize ?? Math.max(1, Math.floor((info.viewportH ?? 2) / 2));
  const options = { pageSize: size, maxScroll: Math.max(0, info.maxScroll ?? 0) };
  const target = keyboardScrollTarget(key, mappedFocus, options) ??
    keyboardScrollTarget(pressed?.name, mappedFocus, options);
  return target ? { region, delta: target.delta, maxScroll: options.maxScroll } : null;
}

// The duty body does not paint the tier-3 verbose blocks yet, so `d` is a
// wide/expanded-mode action there. The caller toasts that limitation instead of
// claiming a frame change that did not happen.
export function detailsVerboseAvailable(structural) {
  return structural === 'investigation' || structural === 'expanded';
}

// N4 Help geometry mirrors renderHelp exactly: the modal is
// min(26, height - 3) rows tall, its list starts two rows below the title and
// stops before the pinned data line. Keep this in sync with renderHelp's row
// budget. The renderer clamps the painted slice; this viewport bounds End/G so
// the last documented row (q) is reachable and never publishes a scroll offset
// the frame cannot show.

export const HELP_ROWS = 22;

export const HELP_MAX_ROWS = 26;

export function helpViewportRows(height) {
  const h = Math.min(HELP_MAX_ROWS, Math.max(1, Math.floor(Number(height) || 0) - 3));
  return Math.max(1, h - 4);
}

export function helpScrollMetrics(height, { rows = HELP_ROWS } = {}) {
  const viewport = helpViewportRows(height);
  return { rows, viewport, maxScroll: Math.max(0, rows - Math.max(1, viewport)) };
}

export function helpScrollForKey(key, pressed, { viewport = 1, rows = HELP_ROWS } = {}) {
  const maxScroll = Math.max(0, rows - Math.max(1, viewport));
  const page = Math.max(1, viewport - 1);
  const lower = String(key ?? '').toLowerCase();
  // readline names DECCKM/application-cursor reports down/up/home/end while
  // their sequence is \x1bOB/\x1bOA/\x1bOH/\x1bOF. handleKey dispatches the
  // sequence first, so Help must accept both spellings of every key it claims.
  const name = typeof pressed?.name === 'string' ? pressed.name.toLowerCase() : '';
  if (key === 'j' || key === '\x1b[B' || key === '\x1bOB' || lower === 'down' || name === 'down') return 1;
  if (key === 'k' || key === '\x1b[A' || key === '\x1bOA' || lower === 'up' || name === 'up') return -1;
  if (key === '\x1b[6~' || lower === 'pagedown' || name === 'pagedown') return page;
  if (key === '\x1b[5~' || lower === 'pageup' || name === 'pageup') return -page;
  if (key === 'G' || key === '\x1b[F' || key === '\x1bOF' || key === '\x1b[4~' || lower === 'end' || name === 'end') return maxScroll;
  if (key === 'g' || key === '\x1b[H' || key === '\x1bOH' || key === '\x1b[1~' || lower === 'home' || name === 'home') return -maxScroll;
  return undefined;
}

export function applyHelpScroll(ui, key, pressed, metrics = {}) {
  const { viewport = 1, rows = HELP_ROWS } = metrics;
  const delta = helpScrollForKey(key, pressed, { viewport, rows });
  if (delta === undefined) return false;
  const maxScroll = Math.max(0, rows - Math.max(1, viewport));
  ui.helpScroll = clamp((ui.helpScroll ?? 0) + delta, 0, maxScroll);
  return true;
}

export function helpKeyAction(key, pressed, metrics = {}) {
  if (key === '?' || key === '\x1b' || key === 'escape' || pressed?.name === 'escape') return 'close';
  return helpScrollForKey(key, pressed, metrics) === undefined ? 'blocked' : 'scroll';
}

// N4 footer actions. The render lane owns the padded hitboxes; the viewer only
// activates the actions when a pointer lands inside one of them.
export function footerActionAt(hitboxes, x, y) {
  if (!hitboxes || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const inside = rect => Boolean(rect) && x >= rect.x && x < rect.x + rect.w &&
    y >= rect.y && y < rect.y + rect.h;
  const select = hitboxes.selectHint ?? hitboxes.mouseHint;
  if (inside(select)) return 'mouse';
  if (inside(hitboxes.clearHint)) return 'clear';
  return undefined;
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

// Resolve every clickable piece of frame chrome in the same order selectAt
// applies it: footer actions first, then the Help hint, then Settings. Keeping
// the hit test pure makes the pointer contract testable without a live viewer.
export function chromeActionAt(hitboxes, x, y) {
  const footer = footerActionAt(hitboxes, x, y);
  if (footer) return footer;
  if (!hitboxes || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const inside = rect => Boolean(rect) && x >= rect.x && x < rect.x + rect.w &&
    y >= rect.y && y < rect.y + rect.h;
  if (inside(hitboxes.helpHint)) return 'help';
  if (inside(hitboxes.settings)) return 'settings';
  return undefined;
}

export function settingsHotkey(key) {
  return key === 's';
}

// Pure task-selection transition. A linked task switches run and node; a task
// without a loaded node becomes an explicit neutral subject: details stay on
// the task, the previous node highlight is dropped, and the graph keeps its
// current run context. ensureSelectionState honors that state until graph
// focus or a linked selection takes the subject back.
export function applyTaskSelection(ui, state, taskId) {
  if (!state || !taskId) return undefined;
  ui.runOverview = false;
  ui.selectedTaskId = taskId;
  ui.focus = 'tasks';
  ui.follow = false;
  ui.followTarget = undefined;
  // A task id may appear in several historical runs. Stay in the run the user
  // is already viewing instead of jumping to the first run in display order.
  const preferRunId = ui.selectedRunId ?? state.runs[ui.runIndex]?.id;
  const linked = nodeForTask(state, taskId, { preferRunId });
  if (!linked) {
    ui.selectedTaskUnlinked = true;
    ui.selectedNodeId = undefined;
    ui.graphScroll = 0;
    ui.graphScrollTarget = 0;
    ui.manualScroll = false;
    return undefined;
  }
  ui.selectedTaskUnlinked = false;
  const index = state.runs.findIndex(run => run.id === linked.run.id);
  if (index >= 0 && index !== ui.runIndex) {
    ui.runIndex = index;
    ui.graphScroll = 0;
    ui.graphScrollTarget = 0;
  }
  ui.selectedRunId = linked.run.id;
  ui.runPinned = true;
  ui.selectedNodeId = linked.node.id;
  // A task selection is an explicit jump: center its node even after a manual
  // graph scroll.
  ui.manualScroll = false;
  return linked;
}

// Click path: task hitboxes are painted from the previous frame. If the id is
// no longer a navigation task (a snapshot reorder or removal moved the row),
// ignore the hit instead of selecting a subject that is not under the pointer.
export function selectTaskHit(ui, state, taskId) {
  if (!taskId) return { handled: false, linked: undefined };
  const task = navTasks(state ?? { runs: [], tasks: [] }).find(candidate => candidate.id === taskId);
  if (!task) return { handled: false, linked: undefined };
  return { handled: true, linked: applyTaskSelection(ui, state, task.id) };
}

// Click resolution: map the pointer to the row painted now (current snapshot
// and frame geometry), then apply the same validated task transition used by
// keyboard selection. A removed row resolves to no task instead of a stale id.
export function selectTaskAtPoint(ui, state, rect, x, y) {
  const task = taskAtPoint(rect, state, ui, x, y);
  if (!task) return { handled: false, linked: undefined };
  return { handled: true, ...selectTaskHit(ui, state, task.id) };
}

// Bring an index inside the painted window of a list. A zero/unknown viewport
// still sends the offset back up when the selection is above it.
export function revealScrollOffset(offset, index, viewport, maxScroll = Infinity) {
  let next = clamp(Number(offset) || 0, 0, maxScroll);
  if (index < 0) return next;
  if (index < next) next = index;
  else if (viewport > 0 && index >= next + viewport) next = index - viewport + 1;
  return clamp(next, 0, maxScroll);
}

export function selectRunById(ui, state, runId, scrollInfo = {}) {
  if (!state?.runs?.length) return false;
  const index = state.runs.findIndex(run => run.id === runId);
  if (index < 0) return false;
  const run = state.runs[index];
  ui.runOverview = false;
  ui.runIndex = index;
  ui.selectedRunId = run.id;
  ui.runPinned = true;
  ui.selectedNodeId = (run.nodes.find(node => node.state === 'running') ?? run.nodes[0])?.id;
  ui.selectedTaskUnlinked = false;
  ui.graphScroll = 0;
  ui.graphScrollTarget = 0;
  ui.cellsScroll = 0;
  ui.cellsScrollTarget = 0;
  const runs = scrollInfo?.runs;
  ui.runsScroll = revealScrollOffset(ui.runsScroll ?? 0, index, runs?.viewportH ?? 0, runs?.maxScroll ?? Infinity);
  ui.runsScrollTarget = ui.runsScroll;
  ui.follow = false;
  ui.followTarget = undefined;
  ui.manualScroll = false;
  if (ui.expanded) {
    ui.focus = 'details';
    ui.lastFocus = 'graph';
  } else {
    ui.focus = 'graph';
  }
  return true;
}

// Select the run itself: clear the node/task subject so the details pane paints
// the run summary. Node/task selections clear this flag in turn.
export function selectRunOverview(ui, state, runId, scrollInfo = {}) {
  if (!state?.runs?.length) return false;
  const index = state.runs.findIndex(run => run.id === runId);
  if (index < 0) return false;
  const run = state.runs[index];
  ui.runIndex = index;
  ui.selectedRunId = run.id;
  ui.runPinned = true;
  ui.runOverview = true;
  ui.selectedNodeId = undefined;
  ui.selectedTaskId = undefined;
  ui.selectedTaskUnlinked = false;
  ui.graphScroll = 0;
  ui.graphScrollTarget = 0;
  ui.cellsScroll = 0;
  ui.cellsScrollTarget = 0;
  const runs = scrollInfo?.runs;
  ui.runsScroll = revealScrollOffset(ui.runsScroll ?? 0, index, runs?.viewportH ?? 0, runs?.maxScroll ?? Infinity);
  ui.runsScrollTarget = ui.runsScroll;
  ui.follow = false;
  ui.followTarget = undefined;
  ui.manualScroll = false;
  ui.focus = 'details';
  ui.lastFocus = 'graph';
  return true;
}
export function applySwitcherSelection(ui, state, item, scrollInfo = {}) {
  if (!state || !item) return { handled: false, stale: true, linked: undefined };
  if (item.kind === 'run') {
    const handled = selectRunOverview(ui, state, item.id, scrollInfo);
    return { handled, stale: !handled, linked: undefined };
  }
  if (item.kind !== 'task') return { handled: false, stale: true, linked: undefined };
  if (!navTasks(state).some(task => task.id === item.id)) {
    return { handled: false, stale: true, linked: undefined };
  }
  const result = selectTaskHit(ui, state, item.id);
  if (result.handled && ui.expanded) {
    ui.focus = 'details';
    ui.lastFocus = 'tasks';
  }
  return { handled: result.handled, stale: !result.handled, linked: result.linked };
}

// Pure next-frame scroll decision. Only a selected (or followed) node re-centers;
// an unlinked task subject resolves to the top of the graph.
export function selectionScrollTarget(ui, state, layout, viewportHeight) {
  if (!layout || ui.manualScroll) return undefined;
  const targetId = ui.follow && state?.connected && ui.followTarget?.kind === 'node'
    ? ui.followTarget.nodeId
    : ui.selectedNodeId;
  return nodeScrollTarget(layout, targetId, viewportHeight);
}

// A failed read is durable evidence, not just a toast: the WAITING placeholder
// keeps the watched path and the last read error until a read succeeds.
export function failedReadPlaceholder(path, error, { view = 'watch', now = Date.now() } = {}) {
  const message = typeof error === 'string' ? error : error?.message;
  return {
    version: 3, sessionId: 'pending', mode: 'live', connected: false,
    generatedAt: new Date(now).toISOString(),
    provenance: {
      origin: 'viewer-placeholder',
      view,
      ...(path ? { statePath: path } : {}),
    },
    ...(message ? { readError: message } : {}),
    runs: [], tasks: [], sources: [],
  };
}

// Pure failure branch of loadState. The viewer keeps the last read error and
// refreshes the WAITING placeholder until a later read succeeds; exporting the
// decision keeps that lifecycle covered without a live watcher.
export function readFailureEvidence(snapshot, error) {
  const message = typeof error === 'string' ? error : error?.message;
  return {
    lastReadError: message,
    placeholder: snapshot?.provenance?.origin === 'viewer-placeholder'
      ? { ...snapshot, readError: message }
      : undefined,
  };
}

// A state key absent from the previous signature is a baseline observation,
// not a transition. An imported/historical run, a file replaced by another
// writer, or a run removed and re-added was never observed changing while this
// viewer watched, so it must not emit completion/failure/start toasts.
export function transitionChanges(previous, current) {
  if (!previous) return [];
  const changes = [];
  for (const run of current.runs) {
    for (const node of run.nodes) {
      const key = `${run.id}:${node.id}`;
      const before = previous.get(key);
      if (before === undefined || before === node.state) continue;
      if (node.state === 'completed' || node.state === 'failed' || node.state === 'running') {
        changes.push({ key, kind: 'node', label: node.label, state: node.state });
      }
    }
  }
  for (const task of current.tasks) {
    if (task.parentTaskId) continue;
    const key = `task:${task.id}`;
    const before = previous.get(key);
    if (before === undefined || before === task.status) continue;
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'running') {
      changes.push({ key, kind: 'task', label: task.description, state: task.status });
    }
  }
  return changes;
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

  let snapshot = null;
  let fullSnapshot = null;
  let previousStates = null;
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
  let toastId = 0;
  let lastCycle;
  let lastRender;
  let helpFrameDrawn = false;
  let graphLayoutCache = { key: '', layout: null };
  let lastDrawAt = 0;
  let ignoreKeysUntil = 0;
  // stdin is consumed as raw bytes: X10 mouse payloads are single bytes, so a
  // UTF-8 decoded string cannot represent coordinates above 0x7f faithfully.
  let rawInput = Buffer.alloc(0);
  let mousePendingUntil = 0;
  // readline decodes a partial mouse report as stand-alone keys in the same
  // tick as the data event; this window only has to cover that dispatch burst
  // (and readline's 30ms escape timeout), not the lifetime of a stale prefix.
  const MOUSE_PENDING_KEY_MS = 80;
  let viewState;
  let viewStateSessionId;
  let lastReadError;
  let loadGeneration = 0;
  const pendingWrites = new Set();

  const ui = createViewerState({
    noMotion, language: initialLanguage, themeName: initialThemeName, fps,
  });
  ui.installVersion = INSTALL_GENERATION;

  const initialPalette = paletteFor(ui.themeName, { appearance });
  let palette = initialPalette;
  const theme = createTheme({
    palette,
    color: !noColor,
    truecolor: supportsTruecolor(),
  });

  function applyPalette() {
    palette = paletteFor(ui.themeName, { appearance });
    theme.palette = palette;
  }

  // Any visible change outside a draw must repaint now; otherwise an idle view
  // waits up to a second for the 1 fps tick.
  function requestRepaint() {
    if (started && !drawing) requestFrame();
  }

  function addToast(text, kind = 'info', at = Date.now()) {
    ui.toasts.push({ id: ++toastId, text, kind, at });
    if (ui.toasts.length > 4) ui.toasts = ui.toasts.slice(-4);
    requestRepaint();
  }

  // Preference writes are fire-and-forget from the UI's perspective, but close()
  // must not exit before the last toggle reaches disk. Tracking keeps quit
  // honest without making every key wait for the filesystem.
  function trackWrite(promise) {
    const tracked = Promise.resolve(promise);
    pendingWrites.add(tracked);
    tracked.finally(() => pendingWrites.delete(tracked)).catch(() => {});
    return tracked;
  }

  async function flushPendingWrites(timeoutMs = 250) {
    if (!pendingWrites.size) return;
    await Promise.race([
      Promise.allSettled([...pendingWrites]),
      delay(timeoutMs),
    ]);
  }

  if (configError) {
    addToast(t(initialLanguage, 'toastConfigError', { error: configError.message }), 'failed');
  }

  function runIndexById(id) {
    return snapshot?.runs.findIndex(run => run.id === id) ?? -1;
  }

  function ensureSelection() {
    ensureSelectionState(ui, snapshot);
  }

  function stateSignature(current) {
    const map = new Map();
    for (const run of current.runs) {
      for (const node of run.nodes) map.set(`${run.id}:${node.id}`, node.state);
    }
    for (const task of current.tasks) {
      if (!task.parentTaskId) map.set(`task:${task.id}`, task.status);
    }
    return map;
  }

  function detectTransitions(previous, current, now) {
    const toasts = transitionChanges(previous, current).map(change => {
      if (change.kind === 'node') {
        if (change.state === 'completed') return { text: t(ui.language, 'toastNodeCompleted', { label: change.label }), kind: 'completed' };
        if (change.state === 'failed') return { text: t(ui.language, 'toastNodeFailed', { label: change.label }), kind: 'failed' };
        return { text: t(ui.language, 'toastNodeStarted', { label: change.label }), kind: 'info' };
      }
      if (change.state === 'completed') return { text: t(ui.language, 'toastTaskCompleted', { label: change.label }), kind: 'completed' };
      if (change.state === 'failed') return { text: t(ui.language, 'toastTaskFailed', { label: change.label }), kind: 'failed' };
      return { text: t(ui.language, 'toastTaskStarted', { label: change.label }), kind: 'info' };
    });
    for (const toast of toasts.slice(0, 3)) addToast(toast.text, toast.kind, now);
    if (toasts.length > 3) addToast(t(ui.language, 'toastMoreChanges', { count: toasts.length - 3 }), 'info', now);
  }

  function acceptSnapshot(raw, { silent = false, view = once ? 'once' : 'watch' } = {}) {
    const normalized = normalizeSnapshot(raw);
    if (!normalized) {
      if (!silent) addToast(t(ui.language, 'toastInvalidSnapshot'), 'failed');
      return false;
    }
    normalized.provenance = {
      ...normalized.provenance,
      origin: normalized.mode !== 'demo' && normalized.provenance.origin === 'legacy-snapshot'
        ? 'controller' : normalized.provenance.origin,
      view,
      ...(statePath ? { statePath } : {}),
    };
    const now = Date.now();
    const previousRunIds = new Set(snapshot?.runs.map(run => run.id) ?? []);
    const hadRuns = Boolean(snapshot?.runs?.length);
    const nextStates = stateSignature(normalized);
    if (!silent) detectTransitions(previousStates, normalized, now);
    previousStates = nextStates;
    if (raw?.demo && lastCycle !== raw.demo.cycle) {
      if (lastCycle !== undefined) addToast(t(ui.language, 'toastCycleStarted', { cycle: raw.demo.cycle + 1 }), 'warning', now);
      lastCycle = raw.demo.cycle;
      ui.followTarget = undefined;
    }
    fullSnapshot = normalized;
    pruneHiddenSubjects(ui, normalized);
    snapshot = hiddenSnapshot(normalized, {
      runIds: ui.hiddenRunIds, taskIds: ui.hiddenTaskIds,
    });
    ensureSelection();
    if (ui.follow) {
      const advanced = advanceRunSelection(snapshot.runs, {
        previousRunIds, hadRuns, follow: ui.follow, pinned: ui.runPinned,
        runIndex: ui.runIndex, selectedRunId: ui.selectedRunId,
        followTarget: ui.followTarget,
      });
      if (advanced.fresh) {
        ui.runIndex = advanced.index;
        ui.selectedRunId = advanced.selectedRunId;
        // The fresh run owns the subject now. Move the task subject with the
        // node instead of leaving the previous task's id in the breadcrumb.
        const freshNode = advanced.fresh.nodes.find(node => node.state === 'running') ??
          advanced.fresh.nodes[0];
        ui.selectedNodeId = freshNode?.id;
        ui.selectedTaskId = freshNode?.taskId;
        ui.selectedTaskUnlinked = Boolean(freshNode?.taskId) &&
          !navTasks(snapshot).some(task => task.id === freshNode.taskId);
        ui.graphScroll = 0;
        ui.graphScrollTarget = 0;
        ui.manualScroll = false;
        ui.followTarget = advanced.followTarget;
      }
    }
    if (ui.follow && snapshot.connected) follow(now);
    requestRepaint();
    return true;
  }

  function follow(now = Date.now()) {
    if (!snapshot?.connected) return;
    const current = snapshot.runs[ui.runIndex];
    // A freshly selected run with no running node yet must stay visible instead
    // of being dragged back to an older running run by the exact-match target.
    if (holdsPendingRun(ui.followTarget, current)) return;
    if (ui.followTarget?.kind === 'run' && ui.followTarget.runId === current?.id) {
      const upgraded = followTargetForRun(current);
      if (upgraded?.kind === 'node') ui.followTarget = upgraded;
    }
    const target = findRunningTarget(snapshot, ui.followTarget);
    if (!target) return;
    ui.followTarget = target;
    const structural = structuralFor(terminalWidth(), {
      expanded: ui.expanded, sidebar: sidebarEnabled(),
    });
    // An explicit RUNS/CELLS focus is a user choice; follow still moves the
    // subject underneath it instead of dragging focus back to a hidden pane.
    const keepDutyList = structural === 'duty' && (ui.focus === 'runs' || ui.focus === 'cells')
      ? ui.focus : undefined;
    if (target.kind === 'node') {
      const index = runIndexById(target.runId);
      if (index >= 0) ui.runIndex = index;
      ui.selectedRunId = target.runId;
      applyFocusRequest(ui, 'graph', structural, lastRender?.scroll);
      if (keepDutyList) ui.focus = keepDutyList;
      ui.selectedNodeId = target.nodeId;
      ui.selectedTaskUnlinked = false;
    } else {
      applyFocusRequest(ui, 'tasks', structural, lastRender?.scroll);
      if (keepDutyList) ui.focus = keepDutyList;
      ui.selectedTaskId = target.taskId;
      ui.selectedTaskUnlinked = !nodeForTask(snapshot, target.taskId);
      if (ui.selectedTaskUnlinked) {
        ui.selectedNodeId = undefined;
        ui.graphScroll = 0;
        ui.graphScrollTarget = 0;
      }
    }
    ui.manualScroll = false;
  }

  // Keep a selected duty list row inside the painted slice. RUNS/CELLS are
  // one-row windows on short terminals, so selection changes must move their
  // offsets exactly like revealTaskSelection moves the task sidebar.
  function revealListSelection(region, index) {
    const info = lastRender?.scroll?.[region];
    if (!info || !(info.viewportH > 0) || index < 0) return;
    const key = `${region}Scroll`;
    const targetKey = `${region}ScrollTarget`;
    const offset = revealScrollOffset(ui[key] ?? 0, index, info.viewportH, info.maxScroll ?? 0);
    ui[targetKey] = offset;
    ui[key] = offset;
  }

  function selectNode(direction, { absolute = false } = {}) {
    const run = snapshot?.runs[ui.runIndex];
    if (!run?.nodes.length) return;
    const current = Math.max(0, run.nodes.findIndex(node => node.id === ui.selectedNodeId));
    const index = absolute ? direction : (current + direction + run.nodes.length) % run.nodes.length;
    ui.selectedNodeId = run.nodes[index].id;
    ui.runOverview = false;
    revealListSelection('cells', index);
    ui.selectedRunId = run.id;
    ui.runPinned = true;
    ui.focus = lastRender?.layout?.layout === 'duty' ? 'cells' : 'graph';
    ui.selectedTaskId = run.nodes[index].taskId;
    ui.selectedTaskUnlinked = false;
    ui.follow = false;
    ui.followTarget = undefined;
    ui.manualScroll = false;
  }

  function selectTaskById(taskId, { announce = false } = {}) {
    const { handled, linked } = selectTaskHit(ui, snapshot, taskId);
    if (!handled) return;
    if (!linked && announce) {
      addToast(t(ui.language, 'toastTaskUnlinked', { id: taskId }), 'warning');
    }
  }

  function selectTask(direction) {
    const tasks = navTasks(snapshot ?? { runs: [], tasks: [] });
    if (!tasks.length) return;
    const current = Math.max(0, tasks.findIndex(task => task.id === ui.selectedTaskId));
    const index = (current + direction + tasks.length) % tasks.length;
    selectTaskById(tasks[index].id);
  }

  function switchRun(direction) {
    if (!snapshot?.runs.length) return;
    const index = (ui.runIndex + direction + snapshot.runs.length) % snapshot.runs.length;
    if (ui.runOverview) {
      selectRunOverview(ui, snapshot, snapshot.runs[index].id, lastRender?.scroll);
    } else {
      selectRunById(ui, snapshot, snapshot.runs[index].id, lastRender?.scroll);
    }
  }

  function openSwitcher() {
    if (ui.switcher || !snapshot) return;
    const run = snapshot.runs[ui.runIndex];
    const node = run?.nodes?.find(candidate => candidate.id === ui.selectedNodeId);
    const taskOwner = ui.focus === 'tasks' || (ui.focus === 'details' && ui.lastFocus === 'tasks');
    const preferredTaskId = taskOwner ? ui.selectedTaskId : node?.taskId;
    const items = switcherItems(snapshot, null, {
      preferRunId: run?.id,
      tasks: navTasks(snapshot),
    });
    const active = items.find(item => item.kind === 'task' && item.id === preferredTaskId)
      ?? items.find(item => item.kind === 'run' && item.id === run?.id)
      ?? items[0];
    ui.switcher = { query: '', frozenKeys: items.map(item => item.key), activeKey: active?.key };
  }

  function moveSwitcherSelection(delta) {
    if (!ui.switcher) return;
    const view = switcherView(snapshot, ui);
    if (!view.items.length) return;
    ui.switcher = {
      ...ui.switcher,
      activeKey: moveSwitcher(view.items, view.activeKey, delta),
    };
  }

  function confirmSwitcher(key) {
    if (!ui.switcher) return;
    const view = switcherView(snapshot, ui);
    // Pointer hits carry the key painted in the previous frame. Only keyboard
    // Enter (undefined) may fall back to the active row: a key that was removed,
    // reordered, or filtered out is stale and must not select another subject.
    const item = key === undefined
      ? view.items.find(candidate => candidate.key === view.activeKey)
      : view.items.find(candidate => candidate.key === key);
    if (!item) {
      if (key !== undefined) {
        addToast(t(ui.language, 'toastSwitcherStale', {
          id: key.slice(key.indexOf(':') + 1),
        }), 'warning');
        return;
      }
      ui.switcher = null;
      addToast(t(ui.language, 'switcherEmpty'), 'warning');
      return;
    }
    const applied = applySwitcherSelection(ui, snapshot, item, lastRender?.scroll);
    if (!applied.handled) {
      addToast(t(ui.language, applied.stale ? 'toastSwitcherStale' : 'toastTaskUnlinked', {
        id: item.id,
      }), 'warning');
      return;
    }
    if (item.kind === 'task' && !applied.linked) {
      addToast(t(ui.language, 'toastTaskUnlinked', { id: item.id }), 'warning');
    }
    ui.switcher = null;
  }

  function toggleFold() {
    const run = snapshot?.runs[ui.runIndex];
    if (!run || ui.focus !== 'graph') return;
    const nodeId = ui.selectedNodeId;
    if (!nodeId) return;
    if (ui.folded.has(nodeId)) ui.folded.delete(nodeId);
    else ui.folded.add(nodeId);
    if (ui.foldedByRun instanceof Map) ui.foldedByRun.set(run.id, new Set(ui.folded));
    ui.follow = false;
    ui.manualScroll = false;
    const sessionKey = viewSessionKey(snapshot);
    if (statePath && viewState && sessionKey && viewState.sessionId === sessionKey) {
      setExpanded(viewState, run.id, nodeId, !ui.folded.has(nodeId));
      trackWrite(saveViewStateFn(statePath, viewState))
        .catch(error => addToast(t(ui.language, 'toastViewPreferences', { error: error.message }), 'failed'));
    }
  }

  function sidebarEnabled() {
    return ui.sidebar && (!paneMode || terminalWidth() >= 112);
  }

  function graphMetrics() {
    const layout = dashboardLayout(terminalWidth(), terminalHeight(), {
      sidebar: sidebarEnabled(), expanded: ui.expanded,
    });
    if (!layout.graph) return null;
    return { width: Math.max(8, layout.graph.w - 4), height: Math.max(3, layout.graph.h - 4) };
  }

  function graphLayoutInfo() {
    const run = snapshot?.runs[ui.runIndex];
    if (!run) return null;
    syncFoldedRun(ui, run.id);
    const metrics = graphMetrics();
    if (!metrics) return null;
    const foldedKey = [...ui.folded].sort().join(',');
    const structure = run.nodes.map(node => node.id).join(',') + '|' +
      run.edges.map(edge => `${edge.from}>${edge.to}`).join(',');
    const key = `${run.id}|${metrics.width}|${foldedKey}|${structure}`;
    if (graphLayoutCache.key !== key) {
      let layout = null;
      try {
        layout = computeLayout(run, metrics.width, { folded: ui.folded });
      } catch {
        // Let renderApp handle and report a cyclic layout.
      }
      graphLayoutCache = { key, layout };
    }
    return { ...metrics, layout: graphLayoutCache.layout };
  }

  function maxGraphScroll(info = graphLayoutInfo()) {
    if (!info?.layout) return 0;
    return Math.max(0, info.layout.height - info.height);
  }

  function pageScrollStep() {
    return Math.max(2, (graphMetrics()?.height ?? 4) - 4);
  }

  function scrollRegionBy(region, delta) {
    if (region === 'graph') {
      ui.follow = false;
      ui.manualScroll = true;
      ui.graphScrollTarget = clamp(
        ui.graphScrollTarget + delta,
        0,
        lastRender?.scroll?.graph?.maxScroll ?? maxGraphScroll(),
      );
      return;
    }
    if (region === 'tasks') {
      ui.follow = false;
      ui.tasksScrollTarget = clamp(
        (ui.tasksScrollTarget ?? 0) + delta,
        0,
        lastRender?.scroll?.tasks?.maxScroll ?? 0,
      );
      return;
    }
    if (region === 'runs' || region === 'cells') {
      const targetKey = region === 'runs' ? 'runsScrollTarget' : 'cellsScrollTarget';
      ui[targetKey] = clamp((ui[targetKey] ?? 0) + delta, 0, lastRender?.scroll?.[region]?.maxScroll ?? 0);
      return;
    }
    if (region === 'details') {
      ui.follow = false;
      ui.detailsScrollTarget = clamp(
        (ui.detailsScrollTarget ?? 0) + delta,
        0,
        lastRender?.scroll?.details?.maxScroll ?? 0,
      );
    }
  }

  function dispatchKeyboardScroll(key, pressed) {
    const structural = lastRender?.layout?.layout ?? structuralFor(terminalWidth(), {
      expanded: ui.expanded, sidebar: sidebarEnabled(),
    });
    const scrollInfo = lastRender?.scroll ?? {};
    // Page size only needs the graph's larger step; every other painted region
    // uses half its viewport inside keyboardScrollIntent.
    const pageSize = scrollRegionForFocus(ui.focus, structural, scrollInfo) === 'graph'
      ? pageScrollStep()
      : undefined;
    const intent = keyboardScrollIntent(key, pressed, ui.focus, structural, scrollInfo, { pageSize });
    if (!intent) return false;
    scrollRegionBy(intent.region, intent.delta);
    return true;
  }

  function regionStep(region) {
    const info = lastRender?.scroll?.[region];
    if (!info) return 1;
    return region === 'graph'
      ? Math.max(2, info.viewportH - 4)
      : Math.max(1, Math.floor(info.viewportH / 2));
  }

  function applyWheel(mouse) {
    const direction = wheelDirectionFromButton(mouse.button);
    if (!direction) return;
    // Wheel stays in the modal switcher; it never scrolls the frame underneath.
    if (ui.switcher) {
      moveSwitcherSelection(direction);
      return;
    }
    if (!lastRender) return;
    const region = regionAt(mouse.x, mouse.y, lastRender.hitboxes?.regions);
    if (!region) return;
    scrollRegionBy(region, direction * regionStep(region));
  }

  function revealTaskSelection() {
    if (ui.focus !== 'tasks' || !snapshot) return;
    const tasks = navTasks(snapshot);
    const index = tasks.findIndex(task => task.id === ui.selectedTaskId);
    if (index < 0) return;
    const viewportRows = lastRender?.scroll?.tasks?.viewportH ?? 0;
    const max = lastRender?.scroll?.tasks?.maxScroll ?? 0;
    if (!viewportRows) {
      // The task list is not painted (duty or expanded). Keep its last offset so
      // returning to investigation does not rewind the selection into view.
      ui.taskRevealKey = undefined;
      return;
    }
    let offset = clamp(ui.tasksScrollTarget ?? 0, 0, max);
    if (index < offset) offset = index;
    else if (index >= offset + viewportRows) offset = index - viewportRows + 1;
    ui.tasksScrollTarget = clamp(offset, 0, max);
    ui.tasksScroll = ui.tasksScrollTarget;
  }

  // The Help overlay is modal, but its list is taller than a short terminal.
  // A wheel event scrolls one clamped page instead of falling through to the
  // frame underneath.
  function scrollHelpPage(direction) {
    const metrics = helpScrollMetrics(terminalHeight());
    ui.helpScroll = clamp(
      (ui.helpScroll ?? 0) + direction * Math.max(1, metrics.viewport - 1),
      0,
      metrics.maxScroll,
    );
    helpFrameDrawn = false;
    void draw();
  }

  function onMouseEvent(mouse) {
    // Readline may also emit a keypress for the same bytes; ignore that copy.
    ignoreKeysUntil = Date.now() + 80;
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
        if (direction) scrollHelpPage(direction);
        return;
      }
      if (!mouse.release && (mouse.button & 3) === 0) {
        ui.help = false;
        ui.helpScroll = 0;
        helpFrameDrawn = false;
        void draw();
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
    if (pagerActive) return;
    rawInput = Buffer.concat([rawInput, inputBytes(chunk)]);
    if (rawInput.length > 8192) rawInput = rawInput.subarray(rawInput.length - 8192);
    const { events, rest, pending } = extractMouse(rawInput);
    const remainder = Buffer.isBuffer(rest) ? rest : Buffer.from(String(rest), 'latin1');
    rawInput = remainder.subarray(Math.max(0, remainder.length - 64));
    // readline also emits the partial report bytes as individual keys (its
    // digits are duty focus hotkeys), so key dispatch waits for the report to
    // finish instead of acting on a fragment.
    mousePendingUntil = pending ? Date.now() + MOUSE_PENDING_KEY_MS : 0;
    for (const event of events) onMouseEvent(event);
    if (events.length) requestFrame();
  }

  function openSettingsMenu() {
    ui.help = false;
    ui.helpScroll = 0;
    helpFrameDrawn = false;
    ui.settingsMenu = true;
    ui.settingsIndex = 0;
  }

  function applyLanguage(id) {
    const language = normalizeLanguage(id);
    ui.language = language;
    trackWrite(saveConfig({ language })).then(() => {
      addToast(t(language, 'languageChanged', { language: languageLabel(language) }), 'info');
    }).catch(error => {
      addToast(t(language, 'languageSaveError', { error: error.message }), 'failed');
    });
  }

  function applySetting(index) {
    if (index === 0) {
      const current = themeNames.indexOf(ui.themeName);
      ui.themeName = themeNames[(current + 1) % themeNames.length];
      applyPalette();
      addToast(t(ui.language, 'toastTheme', { name: ui.themeName }), 'info');
      trackWrite(saveConfig({ theme: ui.themeName })).catch(error => {
        addToast(t(ui.language, 'themeSaveError', { error: error.message }), 'failed');
      });
      return;
    }
    if (index === 1) {
      // The render settings row says "(this session)" in both languages, so the
      // honest implementation is session-only. It must not write config behind a
      // copy that promises nothing survives relaunch.
      ui.motion = !ui.motion;
      if (interactive) requestFrame();
      addToast(t(ui.language, ui.motion ? 'toastMotionOn' : 'toastMotionOff'), 'info');
      return;
    }
    applyLanguage(ui.language === 'en' ? 'zh' : 'en');
  }

  function selectAt(x, y) {
    if (!lastRender || !snapshot) return;
    const inside = rect => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
    if (ui.switcher) {
      for (const [key, rect] of lastRender.hitboxes.switcher ?? []) {
        if (!inside(rect)) continue;
        confirmSwitcher(key);
        return;
      }
      if (lastRender.hitboxes.switcherPanel && inside(lastRender.hitboxes.switcherPanel)) return;
      ui.switcher = null;
      return;
    }
    // Settings owns the pointer while open. Its panel paints over the
    // breadcrumb, so this branch must run before the context hitboxes (which
    // renderApp does not clear for this overlay).
    if (ui.settingsMenu) {
      const order = ['theme', 'animation', 'language'];
      for (const [id, rect] of lastRender.hitboxes.settingsOptions ?? []) {
        if (!inside(rect)) continue;
        const index = order.indexOf(id);
        if (index >= 0) applySetting(index);
        return;
      }
      ui.settingsMenu = false;
      return;
    }
    if (lastRender.hitboxes.context) {
      for (const kind of ['task', 'node', 'run']) {
        const rect = lastRender.hitboxes.context[kind];
        if (!rect || !inside(rect) || !rect.id) continue;
        if (kind === 'run') {
          selectRunOverview(ui, snapshot, rect.id, lastRender?.scroll);
          return;
        }
        if (kind === 'task') {
          selectTaskById(rect.id, { announce: true });
          if (ui.expanded) {
            ui.focus = 'details';
            ui.lastFocus = 'tasks';
          }
          return;
        }
        const run = lastRender.run;
        const clickedNode = run?.nodes?.find(node => node.id === rect.id);
        if (!run || !clickedNode) return;
        const index = runIndexById(run.id);
        if (index >= 0) {
          ui.runIndex = index;
          ui.selectedRunId = run.id;
          ui.runPinned = true;
        }
        ui.selectedNodeId = rect.id;
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
          ui.focus = lastRender.layout?.layout === 'duty' ? 'cells' : 'graph';
        }
        return;
      }
    }
    const chrome = chromeActionAt(lastRender.hitboxes, x, y);
    if (chrome === 'mouse' || chrome === 'clear') {
      runFooterAction(chrome, {
        toggleMouse: () => setMouseCapture(!ui.mouseCapture),
        clear: clearCompleted,
      });
      return;
    }
    if (chrome === 'help') {
      ui.help = !ui.help;
      ui.helpScroll = 0;
      helpFrameDrawn = false;
      return;
    }
    if (chrome === 'settings') {
      openSettingsMenu();
      return;
    }
    for (const [id, rect] of lastRender.hitboxes.nodes) {
      if (!inside(rect)) continue;
      // The painted hitbox and run are from the previous frame. Re-resolve the
      // run in the current snapshot and require the node to still belong to it;
      // a stale hit must not retarget a same-id node in another run.
      const paintedRunId = lastRender.run?.id;
      const index = paintedRunId ? runIndexById(paintedRunId) : -1;
      const run = index >= 0 ? snapshot.runs[index] : undefined;
      const clickedNode = run?.nodes?.find(node => node.id === id);
      if (!run || !clickedNode) continue;
      ui.runIndex = index;
      ui.selectedRunId = run.id;
      ui.runPinned = true;
      ui.selectedNodeId = id;
      ui.runOverview = false;
      ui.selectedTaskId = clickedNode.taskId;
      ui.selectedTaskUnlinked = false;
      ui.focus = lastRender.layout?.layout === 'duty' ? 'cells' : 'graph';
      ui.follow = false;
      ui.followTarget = undefined;
      ui.manualScroll = true;
      return;
    }
    // Resolve the task row from the current snapshot and frame geometry. The
    // painted hitboxes are from the previous frame; after a status reorder the
    // old id can still exist while the row under the pointer now belongs to a
    // different task, so the id is not trusted here.
    const rowTask = selectTaskAtPoint(ui, snapshot, lastRender.layout?.sidebar, x, y);
    if (rowTask.handled) {
      if (!rowTask.linked) {
        addToast(t(ui.language, 'toastTaskUnlinked', { id: ui.selectedTaskId }), 'warning');
      }
      if (ui.expanded) {
        ui.focus = 'details';
        ui.lastFocus = 'tasks';
      }
      return;
    }
    for (const [id, rect] of lastRender.hitboxes.runs) {
      if (!inside(rect)) continue;
      // A run row selects the run subject so the details pane paints RUN SUMMARY.
      if (selectRunOverview(ui, snapshot, id, lastRender?.scroll)) return;
    }
  }

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

  function scrollSelectedIntoView(info = graphLayoutInfo()) {
    if (!info?.layout) return;
    const target = selectionScrollTarget(ui, snapshot, info.layout, info.height);
    if (target === undefined) return;
    ui.graphScrollTarget = target;
  }

  function draw() {
    if (closing) return;
    // A modal help overlay is static. Skipping the full-frame repaint here
    // avoids visible tearing/flicker in terminals that repaint partial frames.
    if (ui.help && helpFrameDrawn) return;
    if (drawing) { again = true; return; }
    drawing = true;
    try {
      const now = Date.now();
      const elapsed = lastDrawAt ? Math.min(100, now - lastDrawAt) : 0;
      lastDrawAt = now;
      if (demoMode && engine) {
        const raw = engine.snapshot(now);
        acceptSnapshot(raw);
      }
      const width = terminalWidth();
      const height = terminalHeight();
      const structural = structuralFor(width, {
        expanded: ui.expanded, sidebar: sidebarEnabled(),
      });
      // N3: duty has no graph/task pane, so a graph/tasks focus inherited from a
      // wide frame lands on the duty body. Explicit runs/cells focus survives.
      applyFocusRequest(ui, ui.focus, structural, lastRender?.scroll);
      ensureSelection();
      if (ui.follow && snapshot?.connected) follow(now);
      // Follow may repoint the subject; the overlay still owns focus until Esc.
      applyFocusRequest(ui, ui.focus, structural, lastRender?.scroll);
      const nextDetailsKey = detailsSubjectKey(snapshot, ui);
      if (ui.detailsKey !== nextDetailsKey) {
        ui.detailsKey = nextDetailsKey;
        ui.detailsScroll = 0;
        ui.detailsScrollTarget = 0;
      }
      const nextTaskRevealKey = `${ui.selectedTaskId ?? ''}|${ui.focus}`;
      if (ui.taskRevealKey !== nextTaskRevealKey) {
        ui.taskRevealKey = nextTaskRevealKey;
        revealTaskSelection();
      }
      const layoutInfo = graphLayoutInfo();
      const graphVisible = structural === 'investigation';
      scrollSelectedIntoView(layoutInfo);
      if (graphVisible) {
        advanceScroll(ui, 'graph', maxGraphScroll(layoutInfo), elapsed, interactive);
      }
      ui.toasts = ui.toasts.filter(toast => now - toast.at < 6500);
      applyPalette();
      ui.fps = framePacingFps(snapshot, ui, {
        demoMode, pagerActive, width, preferredFps: fps, now,
      });
      const result = renderApp(snapshot, ui, {
        width, height, time: now - startAt, now, palette, theme,
        graphLayout: layoutInfo?.layout, sidebar: sidebarEnabled(),
      });
      lastRender = result;
      if (result.layout.graph) {
        ui.graphScrollTarget = clamp(ui.graphScrollTarget, 0, result.scroll.graph.maxScroll);
        ui.graphScroll = clamp(ui.graphScroll, 0, result.scroll.graph.maxScroll);
      }
      if (result.scroll.tasks.viewportH > 0) {
        advanceScroll(ui, 'tasks', result.scroll.tasks.maxScroll, elapsed, interactive);
      }
      for (const region of ['runs', 'cells']) {
        if (result.scroll[region].viewportH > 0) {
          advanceScroll(ui, region, result.scroll[region].maxScroll, elapsed, interactive);
        }
      }
      advanceScroll(ui, 'details', result.scroll.details.maxScroll, elapsed, interactive);
      if (interactive) {
        const frame = result.text.replaceAll('\n', '\x1b[K\r\n');
        write(`\x1b[H${frame}\x1b[K\x1b[J`);
      } else {
        write(result.text + '\n');
      }
      helpFrameDrawn = ui.help;
    } finally {
      drawing = false;
      if (again) { again = false; void draw(); }
    }
  }

  async function syncViewState(generation) {
    const sessionKey = viewSessionKey(snapshot);
    if (!statePath || !sessionKey) {
      viewState = undefined;
      viewStateSessionId = undefined;
      return;
    }
    if (viewStateSessionId === sessionKey) return;
    try {
      const loaded = await loadViewStateFn(statePath, sessionKey);
      if (generation !== undefined && generation !== loadGeneration) return;
      viewState = loaded;
      viewStateSessionId = sessionKey;
      // Saved fold keys are per (run,node). Load a set for every visible run so
      // switching runs never borrows another run's same-id folds.
      const runs = snapshot?.runs ?? [];
      ui.foldedByRun = new Map(runs.map(run => [run.id, foldedFromView(viewState, run.id)]));
      const runId = runs[ui.runIndex]?.id;
      ui.foldedRunId = runId;
      ui.folded = new Set(runId === undefined ? [] : ui.foldedByRun.get(runId) ?? []);
      requestRepaint();
    } catch (error) {
      if (generation !== undefined && generation !== loadGeneration) return;
      viewState = undefined;
      viewStateSessionId = undefined;
      addToast(t(ui.language, 'toastViewPreferences', { error: error.message }), 'failed');
    }
  }

  async function loadState(silent = false) {
    const generation = ++loadGeneration;
    let raw;
    try {
      raw = await readStateFileFn(statePath);
    } catch (error) {
      if (generation !== loadGeneration) return { kind: 'stale', loaded: false };
      const failure = readFailureEvidence(snapshot, error);
      lastReadError = failure.lastReadError;
      if (failure.placeholder) snapshot = fullSnapshot = failure.placeholder;
      viewState = undefined;
      viewStateSessionId = undefined;
      if (!silent) addToast(t(ui.language, 'toastSnapshotError', { error: error.message }), 'failed');
      requestRepaint();
      return { kind: 'unreadable', loaded: false, error };
    }
    if (generation !== loadGeneration) return { kind: 'stale', loaded: false };

    let bounded;
    try {
      bounded = boundSnapshotInput(raw);
    } catch (error) {
      if (!(error instanceof ViewerSnapshotError)) throw error;
      if (generation !== loadGeneration) return { kind: 'stale', loaded: false };
      const invalid = new ViewerSnapshotError(`invalid snapshot: ${error.message}`);
      const failure = readFailureEvidence(snapshot, invalid);
      lastReadError = failure.lastReadError;
      if (failure.placeholder) snapshot = fullSnapshot = failure.placeholder;
      viewState = undefined;
      viewStateSessionId = undefined;
      if (!silent) addToast(t(ui.language, 'toastInvalidSnapshot'), 'failed');
      requestRepaint();
      return { kind: 'invalid', loaded: false, error: invalid };
    }
    if (generation !== loadGeneration) return { kind: 'stale', loaded: false };

    // Programming errors from normalization are not read failures; they reach
    // the fatal handlers instead of being disguised as an unreadable file.
    const loaded = acceptSnapshot(bounded, { silent, view: once ? 'once' : 'watch' });
    if (generation !== loadGeneration) return { kind: 'stale', loaded: false };
    if (!loaded) {
      const invalid = new ViewerSnapshotError('snapshot failed schema validation');
      const failure = readFailureEvidence(snapshot, invalid);
      lastReadError = failure.lastReadError;
      if (failure.placeholder) snapshot = fullSnapshot = failure.placeholder;
      viewState = undefined;
      viewStateSessionId = undefined;
      requestRepaint();
      return { kind: 'invalid', loaded: false, error: invalid };
    }
    lastReadError = undefined;
    await syncViewState(generation);
    if (generation !== loadGeneration) return { kind: 'stale', loaded: false };
    return { kind: 'ok', loaded: true };
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
    await flushPendingWrites();
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
    addToast(t(ui.language, enabled ? 'toastMouseControls' : 'toastMouseSelection'), enabled ? 'info' : 'warning');
    helpFrameDrawn = false;
    void draw();
  }

  function refreshHiddenSnapshot() {
    snapshot = hiddenSnapshot(fullSnapshot, {
      runIds: ui.hiddenRunIds, taskIds: ui.hiddenTaskIds,
    });
    ensureSelection();
    helpFrameDrawn = false;
    void draw();
  }

  function clearCompleted() {
    const source = fullSnapshot ?? snapshot;
    const items = completedItems(source, { now: Date.now() });
    const runs = items.runs.filter(run => !ui.hiddenRunIds.has(run.id));
    const tasks = items.tasks.filter(task => !ui.hiddenTaskIds.has(task.id));
    if (!runs.length && !tasks.length) {
      addToast(t(ui.language, 'toastNoCompleted'), 'info');
      return;
    }
    for (const run of runs) ui.hiddenRunIds.add(run.id);
    for (const task of tasks) ui.hiddenTaskIds.add(task.id);
    addToast(t(ui.language, 'toastClearedCompleted', { runs: runs.length, tasks: tasks.length }), 'info');
    refreshHiddenSnapshot();
  }

  function restoreHidden() {
    const runs = ui.hiddenRunIds.size;
    const tasks = ui.hiddenTaskIds.size;
    if (!runs && !tasks) {
      addToast(t(ui.language, 'toastNoHidden'), 'info');
      return;
    }
    ui.hiddenRunIds.clear();
    ui.hiddenTaskIds.clear();
    addToast(t(ui.language, 'toastRestoredCompleted', { runs, tasks }), 'info');
    refreshHiddenSnapshot();
  }

  function cycle(direction) {
    const owner = ui.expanded
      ? (ui.lastFocus === 'tasks' ? 'tasks' : 'graph')
      : (ui.focus === 'tasks' ? 'tasks' : 'graph');
    if (owner === 'tasks') selectTask(direction);
    else selectNode(direction);
    // Expansion is an overlay, not a focus destination: cycling keeps details
    // in front and only moves the subject underneath it.
    if (ui.expanded) {
      ui.focus = 'details';
      ui.lastFocus = owner;
    }
  }

  function isEscapeKey(key, pressed) {
    return key === '\x1b' || key === 'escape' || pressed?.name === 'escape';
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
      addToast(t(ui.language, 'diagnosisNoPager'), 'warning');
      return;
    }
    let prepared;
    pagerActive = true;
    clearTimeout(frameTimer);
    try {
      prepared = await preparePagerRecord(path);
      if (!prepared) {
        addToast(t(ui.language, 'diagnosisOpenUnavailable'), 'warning');
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
        addToast(t(ui.language, 'diagnosisOpenFailed'), 'warning');
      } else if (result.error || result.status !== 0) {
        addToast(t(ui.language, 'diagnosisOpenFailed'), 'warning');
      }
    } catch {
      addToast(t(ui.language, 'diagnosisOpenFailed'), 'warning');
    } finally {
      pagerChild = undefined;
      if (prepared) await rm(prepared.dir, { recursive: true, force: true }).catch(() => {});
      pagerActive = false;
      if (!closing && interactive) {
        enterTerminal();
        ignoreKeysUntil = Date.now() + 300;
        helpFrameDrawn = false;
        requestFrame();
      }
    }
  }

  function handleDiagnosisKey(key) {
    if (!['c', 'p', 'o'].includes(key)) return false;
    if (key === 'o') {
      // Opening a raw record is status-independent: a completed task has no
      // diagnosis card, but its record is still the only place the full
      // final_response survives. The same safe-file gates apply to every status.
      const record = recordForSelection(snapshot, ui);
      if (!record) {
        addToast(t(ui.language, 'diagnosisNothing'), 'warning');
        return true;
      }
      const action = recordForKey('o', record);
      if (action.kind === 'open') void openRecordInPager(action.path);
      else addToast(t(ui.language, 'diagnosisOpenUnavailable'), 'warning');
      return true;
    }
    const diagnosis = diagnosisForSelection(snapshot, ui);
    if (!diagnosis) {
      addToast(t(ui.language, 'diagnosisNothing'), 'warning');
      return true;
    }
    // The copied bundle is the artifact the user keeps, so it must use the
    // same UI language as the diagnosis panel.
    const action = diagnosisForKeyFn(key, diagnosis, undefined, ui.language);
    if (!action) return false;
    if (action.kind === 'copy-diagnosis' || action.kind === 'copy-paths') {
      if (!interactive || !process.stdout.isTTY) {
        addToast(t(ui.language, 'diagnosisCopyUnavailable'), 'warning');
        return true;
      }
      process.stdout.write(osc52(action.text));
      addToast(t(ui.language, 'diagnosisCopied', { lines: payloadLines(action.text) }), 'info');
    } else {
      addToast(t(ui.language, action.reason === 'no-paths' ? 'diagnosisNoPaths' : 'diagnosisOpenUnavailable'), 'warning');
    }
    return true;
  }

  function handleKey(text, pressed) {
    if (pagerActive) return;
    const key = pressed?.sequence || pressed?.name || text;
    if (isEscapeKey(key, pressed) && (ui.settingsMenu || ui.help)) {
      ui.settingsMenu = false;
      ui.help = false;
      ui.helpScroll = 0;
      helpFrameDrawn = false;
      return;
    }
    if (closing || Date.now() < ignoreKeysUntil || Date.now() < mousePendingUntil) return;
    if (ui.switcher) {
      if (key === '\x03') { void close({ closePane: true }); return; }
      if (isEscapeKey(key, pressed) || key === 'v') {
        ui.switcher = null;
        return;
      }
      const up = key === '\x1b[A' || key === 'k' || pressed?.name === 'up';
      const down = key === '\x1b[B' || key === 'j' || pressed?.name === 'down';
      if (up || down) {
        moveSwitcherSelection(up ? -1 : 1);
        return;
      }
      if (key === '\x1b[5~' || pressed?.name === 'pageup') {
        moveSwitcherSelection(-8);
        return;
      }
      if (key === '\x1b[6~' || pressed?.name === 'pagedown') {
        moveSwitcherSelection(8);
        return;
      }
      if (key === '\x1b[H' || pressed?.name === 'home') {
        moveSwitcherSelection(-9999);
        return;
      }
      if (key === '\x1b[F' || pressed?.name === 'end') {
        moveSwitcherSelection(9999);
        return;
      }
      if (key === '\r' || key === '\n' || pressed?.name === 'return' || pressed?.name === 'enter') {
        confirmSwitcher(undefined);
        return;
      }
      if (key === '\x7f' || key === '\b' || pressed?.name === 'backspace') {
        const query = ui.switcher.query.slice(0, -1);
        ui.switcher = { ...ui.switcher, query };
        return;
      }
      if (key === '\x15') {
        ui.switcher = { ...ui.switcher, query: '' };
        return;
      }
      if (key === '/') return;
      if (typeof key === 'string' && key.length === 1 && key.charCodeAt(0) >= 32 && key !== '\x7f') {
        ui.switcher = { ...ui.switcher, query: `${ui.switcher.query}${key}` };
        return;
      }
      return;
    }
    if (isEscapeKey(key, pressed)) {
      const collapsed = collapseTransition(ui);
      if (collapsed) Object.assign(ui, collapsed);
      return;
    }
    const mouse = parseMouse(key);
    if (mouse) {
      if (ui.settingsMenu) {
        if (isLeftClick(key)) selectAt(mouse.x, mouse.y);
        return;
      }
      if (ui.help) {
        if (mouse.button & 64) {
          const direction = wheelDirectionFromButton(mouse.button);
          if (direction) scrollHelpPage(direction);
        } else if (isLeftClick(key)) {
          ui.help = false;
          ui.helpScroll = 0;
          helpFrameDrawn = false;
          void draw();
        }
        return;
      }
      if (mouse.button & 64) {
        applyWheel(mouse);
      } else if (isLeftClick(key)) {
        selectAt(mouse.x, mouse.y);
      }
      return;
    }
    // N4: Help is a real modal. Only close keys and Help scroll keys reach the
    // pane; every background action is consumed while the overlay is open.
    if (ui.help) {
      const metrics = helpScrollMetrics(terminalHeight());
      const action = helpKeyAction(key, pressed, metrics);
      if (action === 'close') {
        ui.help = false;
        ui.helpScroll = 0;
        helpFrameDrawn = false;
        void draw();
      } else if (action === 'scroll' && applyHelpScroll(ui, key, pressed, metrics)) {
        helpFrameDrawn = false;
        void draw();
      }
      return;
    }
    if (key === 'q' || key === '\x03' || key === '\x04') { void close({ closePane: true }); return; }
    if (ui.settingsMenu) {
      if (settingsHotkey(key)) { ui.settingsMenu = false; return; }
      const up = key === '\x1b[A' || key === 'k' || pressed?.name === 'up'
        || (pressed?.name === 'tab' && pressed.shift);
      const down = key === '\x1b[B' || key === 'j' || key === 'Tab' || pressed?.name === 'down'
        || (pressed?.name === 'tab' && !pressed.shift);
      const left = key === '\x1b[D' || pressed?.name === 'left';
      const right = key === '\x1b[C' || pressed?.name === 'right';
      if (up || down || left || right) {
        const delta = up || left ? -1 : 1;
        ui.settingsIndex = (ui.settingsIndex + delta + 3) % 3;
        return;
      }
      if (key === '\r' || key === '\n' || key === ' ' || pressed?.name === 'return' || pressed?.name === 'enter') {
        applySetting(ui.settingsIndex);
        return;
      }
      return;
    }
    if (key === '?') {
      ui.help = !ui.help;
      ui.helpScroll = 0;
      helpFrameDrawn = false;
      return;
    }
    if (settingsHotkey(key)) { openSettingsMenu(); return; }
    if (key === 'm') { setMouseCapture(!ui.mouseCapture); return; }
    if (key === 'x') { clearCompleted(); return; }
    if (key === 'X') { restoreHidden(); return; }
    if (key === 'S') {
      if (terminalWidth() >= 112) {
        ui.sidebar = !ui.sidebar;
        addToast(t(ui.language, ui.sidebar ? 'toastSidebarOn' : 'toastSidebarOff'), 'info');
      } else addToast(t(ui.language, 'toastSidebarHidden'), 'warning');
      return;
    }
    if (key === 'f') {
      ui.follow = !ui.follow;
      if (ui.follow) {
        ui.runPinned = false;
        follow();
      }
      addToast(t(ui.language, ui.follow ? 'toastFollowOn' : 'toastFollowOff'), 'info');
      return;
    }
    if (key === 'r' && demoMode) {
      engine.reset();
      ui.hiddenRunIds.clear();
      ui.hiddenTaskIds.clear();
      ui.toasts = [];
      addToast(t(ui.language, 'toastDemoReset'), 'warning');
      return;
    }
    if (key === 'd') {
      const structural = lastRender?.layout?.layout ?? structuralFor(terminalWidth(), {
        expanded: ui.expanded, sidebar: sidebarEnabled(),
      });
      if (!detailsVerboseAvailable(structural)) {
        addToast(t(ui.language, 'toastDetailsWideOnly'), 'warning');
        return;
      }
      ui.verbose = !ui.verbose;
      addToast(t(ui.language, ui.verbose ? 'toastDetailsVerbose' : 'toastDetailsCompact'), 'info');
      return;
    }
    const requestedFocus = dutyFocusForKey(key);
    if (requestedFocus) {
      const structural = lastRender?.layout?.layout ?? structuralFor(terminalWidth(), {
        expanded: ui.expanded, sidebar: sidebarEnabled(),
      });
      applyFocusRequest(ui, requestedFocus, structural, lastRender?.scroll);
      helpFrameDrawn = false;
      return;
    }
    if (handleDiagnosisKey(key)) return;
    if (key === 'e') {
      if (ui.expanded) return;
      Object.assign(ui, expandTransition(ui));
      return;
    }
    if (!ui.help && (key === 'v' || key === '/')) {
      openSwitcher();
      return;
    }
    if (key === 't') {
      const structural = structuralFor(terminalWidth(), {
        expanded: ui.expanded, sidebar: sidebarEnabled(),
      });
      if (structural !== 'investigation' || !sidebarEnabled() || ui.expanded) {
        openSwitcher();
        return;
      }
      const tasks = navTasks(snapshot ?? { runs: [], tasks: [] });
      if (!tasks.length) { addToast(t(ui.language, 'toastNoTasks'), 'warning'); return; }
      ui.focus = ui.focus === 'tasks' ? 'graph' : 'tasks';
      ui.follow = false;
      return;
    }
    if (key === 'Tab' || pressed?.name === 'tab') { cycle(pressed?.shift ? -1 : 1); return; }
    if (key === '\x1b[Z') { cycle(-1); return; }
    if (key === '\x1b[C') { switchRun(1); return; }
    if (key === '\x1b[D') { switchRun(-1); return; }
    if (dispatchKeyboardScroll(key, pressed)) return;
    if (key === ' ' || key === '\r' || key === '\n') { toggleFold(); return; }
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
      void loadState(true);
    }, watchRetryDelay(attempt, { base: watchRetryBaseMs }));
  }

  function setupFileWatch() {
    if (!statePath || closing) return;
    clearTimeout(watchRetryTimer);
    try {
      watcher = watchFn(dirname(statePath), (_event, name) => {
        if (name && String(name) !== basename(statePath)) return;
        clearTimeout(watchTimer);
        watchTimer = setTimeout(() => { void loadState(); }, 50);
      });
      watcher.on('error', error => {
        addToast(t(ui.language, 'toastWatchError', { error: error.message }), 'failed');
        scheduleWatchRetry();
      });
      watchAttempt = 0;
    } catch (error) {
      addToast(t(ui.language, 'toastWatchUnavailable', { error: error.message }), 'warning');
      scheduleWatchRetry();
    }
  }

  let frameDeadline = 0;

  function frameDelay() {
    return frameIntervalMs(framePacingFps(snapshot, ui, {
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
      acceptSnapshot(engine.snapshot(Date.now()), { silent: true });
      ensureSelection();
      if (ui.follow) follow();
    } else if (statePath) {
      // Watch first: a one-shot producer may replace the snapshot while the
      // initial read or view-state load is still in flight.
      const result = await loadInitialSnapshot({
        statePath, interactive, setupWatch: setupFileWatch, load: () => loadState(true),
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
        snapshot = fullSnapshot = failedReadPlaceholder(statePath, lastReadError, {
          view: once ? 'once' : 'watch',
        });
        ensureSelection();
        if (result.kind === 'invalid') addToast(t(ui.language, 'toastInvalidSnapshot'), 'failed');
        else addToast(t(ui.language, 'toastWaitingSnapshot'), 'warning');
      } else if (snapshot.mode === 'saved' && !snapshot.runs.length) {
        addToast(t(ui.language, 'toastSavedSnapshotEmpty'), 'warning');
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
      process.stdin.on('data', onRawInput);
      // readline otherwise waits 500ms for a possible escape sequence before
      // emitting a lone Esc, which makes modal dismissal feel unresponsive.
      emitKeypressEvents(process.stdin, { escapeCodeTimeout: 30 });
      process.stdin.on('keypress', (text, pressed) => {
        handleKey(text, pressed);
        requestFrame();
      });
      process.stdout.on('resize', () => {
        helpFrameDrawn = false;
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
    get snapshot() { return snapshot; },
    get fullSnapshot() { return fullSnapshot; },
    get lastRender() { return lastRender; },
    acceptSnapshot,
    draw,
    handleKey,
    onMouseEvent,
    onRawInput,
    selectAt,
    confirmSwitcher,
    openSwitcher,
    ensureSelection,
    loadState,
    setupFileWatch,
    flushPendingWrites,
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
