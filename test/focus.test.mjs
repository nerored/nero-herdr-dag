import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRunningTarget, normalizeSnapshot } from '../src/model.mjs';
import { width as textWidth } from '../src/text.mjs';
import {
  advanceRunSelection, followTargetForRun, holdsPendingRun,
  newlyObservedRun, reconcileRunSelection,
} from '../src/view-state.mjs';
import {
  applyFocusRequest, applyHelpScroll, createViewer, createViewerState,
  focusForStructural, helpKeyAction, helpScrollForKey, transitionChanges,
} from '../src/viewer.mjs';

const at = minute => new Date(Date.UTC(2026, 10, 10, 10, minute)).toISOString();
const run = (id, createdAt, nodes) => ({
  id, name: id, status: 'running', createdAt, nodes, edges: [],
});
const node = (id, state) => ({ id, label: id, state });

const oldRun = run('run_old', at(0), [node('build', 'running')]);
const freshPending = run('run_new', at(5), [node('collect', 'pending')]);
const freshRunning = run('run_new', at(5), [node('collect', 'running')]);

const normalize = runs => normalizeSnapshot({ sessionId: 's', connected: true, runs, tasks: [] });
const idsOf = snapshot => new Set(snapshot.runs.map(item => item.id));

test('a freshly observed pending run is selected and held beside an old running run', () => {
  const previous = normalize([oldRun]);
  const previousIds = idsOf(previous);
  const next = normalize([oldRun, freshPending]);
  const advanced = advanceRunSelection(next.runs, {
    previousRunIds: idsOf(previous),
    hadRuns: true,
    follow: true,
    runIndex: previous.runs.findIndex(item => item.id === 'run_old'),
    selectedRunId: 'run_old',
    followTarget: { kind: 'node', runId: 'run_old', nodeId: 'build' },
  });

  assert.equal(advanced.fresh.id, 'run_new');
  assert.equal(next.runs[advanced.index].id, 'run_new');
  assert.equal(advanced.selectedRunId, 'run_new');
  assert.deepEqual(advanced.followTarget, { kind: 'run', runId: 'run_new' });
  assert.equal(holdsPendingRun(advanced.followTarget, next.runs[advanced.index]), true);
  assert.ok(previousIds.has('run_old'));
});

test('the held run upgrades to its running node once it starts', () => {
  const previous = normalize([oldRun, freshPending]);
  const next = normalize([oldRun, freshRunning]);
  const advanced = advanceRunSelection(next.runs, {
    previousRunIds: idsOf(previous),
    hadRuns: true,
    follow: true,
    runIndex: 0,
    selectedRunId: 'run_new',
    followTarget: { kind: 'run', runId: 'run_new' },
  });

  const current = next.runs[advanced.index];
  assert.equal(current.id, 'run_new');
  assert.equal(advanced.fresh, undefined);
  assert.equal(holdsPendingRun(advanced.followTarget, current), false);
  const upgraded = followTargetForRun(current);
  assert.equal(upgraded.kind, 'node');
  assert.equal(upgraded.nodeId, 'collect');
  const target = findRunningTarget(next, upgraded);
  assert.equal(target.runId, 'run_new');
  assert.equal(target.nodeId, 'collect');
});

test('an explicit pinned selection is preserved when a newer run appears', () => {
  const runA = run('run_a', at(0), [node('a', 'running')]);
  const runB = run('run_b', at(5), [node('b', 'running')]);
  const runC = run('run_c', at(9), [node('c', 'running')]);
  const previous = normalize([runA, runB]);
  const next = normalize([runA, runB, runC]);
  const pinned = advanceRunSelection(next.runs, {
    previousRunIds: idsOf(previous),
    hadRuns: true,
    follow: true,
    pinned: true,
    runIndex: previous.runs.findIndex(item => item.id === 'run_a'),
    selectedRunId: 'run_a',
  });

  assert.equal(pinned.fresh, undefined);
  assert.equal(pinned.selectedRunId, 'run_a');
  assert.equal(next.runs[pinned.index].id, 'run_a');

  const following = advanceRunSelection(next.runs, {
    previousRunIds: idsOf(previous),
    hadRuns: true,
    follow: true,
    runIndex: previous.runs.findIndex(item => item.id === 'run_a'),
    selectedRunId: 'run_a',
  });
  assert.equal(following.selectedRunId, 'run_c');
  assert.equal(following.fresh.id, 'run_c');
});

test('first load does not treat existing runs as fresh', () => {
  const first = normalize([oldRun]);
  const advanced = advanceRunSelection(first.runs, {
    previousRunIds: new Set(),
    hadRuns: false,
    follow: true,
    runIndex: 0,
  });
  assert.equal(advanced.fresh, undefined);
  assert.equal(advanced.index, 0);
  assert.equal(advanced.selectedRunId, 'run_old');
});

test('selection remaps by identity and clamps when the id disappears', () => {
  const runs = [
    { id: 'a', nodes: [] },
    { id: 'b', nodes: [] },
    { id: 'c', nodes: [] },
  ];
  assert.deepEqual(reconcileRunSelection(runs, { runIndex: 1, selectedRunId: 'c' }), {
    index: 2, selectedRunId: 'c',
  });
  assert.deepEqual(reconcileRunSelection(runs, { runIndex: 2, selectedRunId: 'gone' }), {
    index: 2, selectedRunId: 'c',
  });
  assert.deepEqual(reconcileRunSelection(runs, { runIndex: 99, selectedRunId: undefined }), {
    index: 2, selectedRunId: 'c',
  });
});

test('fresh-run detection is a set difference and follow targets track run state', () => {
  const snapshot = normalize([oldRun, freshPending]);
  assert.equal(newlyObservedRun(snapshot.runs, new Set(['run_old']))?.id, 'run_new');
  assert.equal(newlyObservedRun(snapshot.runs, new Set(['run_old', 'run_new'])), undefined);

  const pending = snapshot.runs.find(item => item.id === 'run_new');
  assert.deepEqual(followTargetForRun(pending), { kind: 'run', runId: 'run_new' });
  assert.equal(holdsPendingRun(followTargetForRun(pending), pending), true);
  assert.equal(holdsPendingRun({ kind: 'run', runId: 'run_old' }, pending), false);
  assert.deepEqual(followTargetForRun(snapshot.runs.find(item => item.id === 'run_old')), {
    kind: 'node', runId: 'run_old', nodeId: 'build', taskId: undefined,
  });
});

// --- phase 3 regressions (ui-viewer-a) -------------------------------------

const makeFocusViewer = async ({ columns = 140, rows = 42 } = {}) => {
  const writes = [];
  const viewer = await createViewer(
    { noColor: true, noMotion: true, fps: 10 },
    {
      loadConfig: async () => ({ language: 'en' }),
      loadOmoTheme: async () => 'system',
      loadOmoAppearance: async () => ({}),
      columns,
      rows,
      write: text => writes.push(text),
    },
  );
  viewer.ui.follow = false;
  viewer.writes = writes;
  return viewer;
};

const focusSnapshot = () => normalizeSnapshot({
  version: 2, sessionId: 's', connected: true,
  runs: [run('run_a', at(0), [node('n0', 'running'), node('n1', 'pending'), node('n2', 'pending')])],
  tasks: [],
});

test('F-70 first-seen nodes and tasks are a baseline, not transitions', () => {
  const previous = new Map([['run_old:build', 'running'], ['task:st_old', 'running']]);
  const baseline = normalizeSnapshot({
    version: 2, sessionId: 's', connected: true,
    runs: [run('run_new', at(5), [node('collect', 'completed'), node('other', 'failed')])],
    tasks: [{ id: 'st_new', description: 'Imported task', status: 'completed' }],
  });
  assert.deepEqual(transitionChanges(new Map(), baseline), []);
  assert.deepEqual(transitionChanges(previous, baseline), []);

  const changed = normalizeSnapshot({
    version: 2, sessionId: 's', connected: true,
    runs: [run('run_old', at(0), [node('build', 'completed')])],
    tasks: [{ id: 'st_old', description: 'Old task', status: 'failed' }],
  });
  const transitions = transitionChanges(previous, changed);
  assert.deepEqual(transitions.map(change => [change.key, change.state]), [
    ['run_old:build', 'completed'],
    ['task:st_old', 'failed'],
  ]);
});

test('F-68 Help scroll accepts application-cursor sequences and key names', () => {
  const viewport = 5;
  const metrics = { viewport, rows: 22 };
  assert.equal(helpScrollForKey('\x1bOB', { name: 'down' }, metrics), 1);
  assert.equal(helpScrollForKey('\x1bOA', { name: 'up' }, metrics), -1);
  assert.equal(helpScrollForKey('\x1bOH', { name: 'home' }, metrics), -17);
  assert.equal(helpScrollForKey('\x1bOF', { name: 'end' }, metrics), 17);
  assert.equal(helpScrollForKey('x', { name: 'pagedown' }, metrics), 4);
  assert.equal(helpKeyAction('\x1bOB', { name: 'down' }, metrics), 'scroll');
  assert.equal(helpKeyAction('x', { name: 'up' }, metrics), 'scroll');
});

test('F-160 focus falls back when the requested region is not painted', () => {
  const unpaintedDuty = { runs: { viewportH: 0 }, cells: { viewportH: 0 }, details: { viewportH: 10 } };
  assert.equal(focusForStructural('runs', 'duty', unpaintedDuty), 'details');
  assert.equal(focusForStructural('cells', 'duty', unpaintedDuty), 'details');
  assert.equal(focusForStructural('runs', 'duty'), 'runs');

  const hiddenTasks = { tasks: { viewportH: 0 }, graph: { viewportH: 10 }, details: { viewportH: 10 } };
  assert.equal(focusForStructural('tasks', 'investigation', hiddenTasks), 'graph');
  assert.equal(focusForStructural('tasks', 'investigation', {
    tasks: { viewportH: 3 }, graph: { viewportH: 10 },
  }), 'tasks');

  const ui = createViewerState({ focus: 'runs' });
  applyFocusRequest(ui, 'runs', 'duty', unpaintedDuty);
  assert.equal(ui.focus, 'details');
});

test('F-160 a duty focus key does not stick to an unpainted RUNS pane', async () => {
  const viewer = await makeFocusViewer({ columns: 54, rows: 16 });
  viewer.acceptSnapshot(focusSnapshot(), { silent: true });
  viewer.draw();
  assert.equal(viewer.lastRender.scroll.runs.viewportH, 0);

  viewer.handleKey('1', { sequence: '1', name: '1' });

  assert.equal(viewer.ui.focus, 'details');
});

test('F-161 the wheel scrolls Help while the overlay is open', async () => {
  const viewer = await makeFocusViewer({ columns: 80, rows: 20 });
  viewer.acceptSnapshot(focusSnapshot(), { silent: true });
  viewer.draw();
  viewer.handleKey('?', { sequence: '?', name: '?' });
  viewer.draw();
  assert.equal(viewer.ui.help, true);
  assert.equal(viewer.ui.helpScroll, 0);

  viewer.onMouseEvent({ button: 65, x: 5, y: 5, release: false });

  assert.equal(viewer.ui.help, true, 'wheel never closes Help');
  assert.equal(viewer.ui.helpScroll, 9);
  assert.equal(Object.hasOwn(viewer.ui, 'helpScrollTarget'), false);

  viewer.onMouseEvent({ button: 64, x: 5, y: 5, release: false });
  assert.equal(viewer.ui.helpScroll, 0);
});

test('F-184 help scroll is immediate and has no write-only target', () => {
  const state = createViewerState();
  assert.equal(Object.hasOwn(state, 'helpScrollTarget'), false);
  assert.equal(applyHelpScroll(state, 'j', {}, { viewport: 5, rows: 22 }), true);
  assert.equal(state.helpScroll, 1);
  assert.equal(Object.hasOwn(state, 'helpScrollTarget'), false);
});

test('F-156 --once uses the documented frame while watch mode follows the pane', async () => {
  const frame = async (options, { columns, rows }) => {
    const writes = [];
    const viewer = await createViewer(
      { noColor: true, noMotion: true, ...options },
      {
        loadConfig: async () => ({ language: 'en' }),
        loadOmoTheme: async () => 'system',
        loadOmoAppearance: async () => ({}),
        columns,
        rows,
        write: text => writes.push(text),
      },
    );
    viewer.ui.follow = false;
    viewer.acceptSnapshot(focusSnapshot(), { silent: true });
    viewer.draw();
    return viewer.lastRender.text.split('\n');
  };

  const onceDefault = await frame({ once: true }, { columns: 54, rows: 20 });
  assert.equal(textWidth(onceDefault[0]), 120);
  assert.equal(onceDefault.length, 40);

  const onceSized = await frame({ once: true, width: 54, height: 20 }, { columns: 120, rows: 40 });
  assert.equal(textWidth(onceSized[0]), 54);
  assert.equal(onceSized.length, 20);

  // --width widens only the --once frame; watch mode keeps the pane width.
  const watch = await frame({ width: 40 }, { columns: 100, rows: 30 });
  assert.equal(textWidth(watch[0]), 100);
});

test('F-75 viewer instances never share navigation state', async () => {
  const fresh = createViewerState();
  fresh.selectedNodeId = 'mutated';
  fresh.folded.add('node');
  assert.equal(createViewerState().selectedNodeId, undefined);
  assert.equal(createViewerState().folded.size, 0);

  const first = await makeFocusViewer({ columns: 54, rows: 24 });
  const second = await makeFocusViewer({ columns: 54, rows: 24 });
  first.acceptSnapshot(focusSnapshot(), { silent: true });
  second.acceptSnapshot(normalizeSnapshot({
    version: 2, sessionId: 's', connected: true,
    runs: [run('run_b', at(9), [node('m0', 'running')])], tasks: [],
  }), { silent: true });

  assert.notEqual(first.ui, second.ui);
  assert.notEqual(first.snapshot, second.snapshot);
  first.handleKey('?', { sequence: '?', name: '?' });
  assert.equal(first.ui.help, true);
  assert.equal(second.ui.help, false);
  assert.equal(second.ui.selectedNodeId, 'm0');
});
