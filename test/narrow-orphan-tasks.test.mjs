import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot, isVirtualRun } from '../src/model.mjs';
import { orphanNavTasks } from '../src/model.mjs';
import { dutyFocusForKey } from '../src/viewer-keymap.mjs';
import { createTestViewer } from './helpers.mjs';

// A task-only capture with 0 runs and 3 navigation tasks: two running, one
// completed. The narrow duty pane must expose these orphan tasks even though no
// graph node can own them.
const orphanSnapshot = () => normalizeSnapshot({
  version: 3,
  mode: 'live',
  connected: true,
  sessionId: 'orphan-tasks',
  updatedAt: '2026-11-16T12:00:00.000Z',
  provenance: {
    origin: 'controller',
    statePath: '/tmp/herdr-dag/state.json',
    capturedAt: '2026-11-16T12:00:00.000Z',
  },
  runs: [],
  tasks: [
    {
      id: 'st_alpha', description: 'Alpha orphan', status: 'running', percent: 40,
      planPath: '.omo/plans/quality-and-next.md', planRole: 'plan-executor',
    },
    { id: 'st_beta', description: 'Beta orphan', status: 'running' },
    { id: 'st_zeta', description: 'Zeta finished', status: 'completed' },
  ],
});

// A normal live run whose tasks all belong to a node. This is the shape whose
// RUNS/CELLS/DUTY frame and 1/2/3 focus must not gain a TASKS region.
const normalSnapshot = () => normalizeSnapshot({
  version: 3,
  mode: 'live',
  connected: true,
  sessionId: 'normal-run',
  updatedAt: '2026-11-16T12:00:00.000Z',
  runs: [{
    id: 'run_build',
    name: 'build pipeline',
    status: 'running',
    createdAt: '2026-11-16T11:59:00.000Z',
    updatedAt: '2026-11-16T12:00:00.000Z',
    nodes: [
      { id: 'api', label: 'build-api', state: 'running', task_id: 'st_api', percent: 60 },
      { id: 'tests', label: 'test-suite', state: 'pending', task_id: 'st_tests' },
    ],
    edges: [{ from: 'api', to: 'tests' }],
  }],
  tasks: [
    { id: 'st_api', description: 'build the HTTP API', status: 'running', percent: 60 },
    { id: 'st_tests', description: 'run the test suite', status: 'pending' },
  ],
});

const dutyViewer = async ({ columns, rows }) => {
  const { viewer } = await createTestViewer({
    args: { noColor: true, noMotion: true, fps: 10 },
    deps: {
      loadConfig: async () => ({ language: 'en' }),
      loadOmoTheme: async () => 'system',
      loadOmoAppearance: async () => ({}),
      columns,
      rows,
    },
  });
  viewer.ui.follow = false;
  return viewer;
};

const press = (viewer, key, name = key) => viewer.handleKey(key, { sequence: key, name });

test('orphan-only duty paints TASKS and up/down selects each orphan task', async () => {
  for (const [columns, rows] of [[54, 42], [70, 24]]) {
    const viewer = await dutyViewer({ columns, rows });
    viewer.acceptSnapshot(orphanSnapshot(), { silent: true });
    viewer.draw();

    const first = viewer.lastRender;
    assert.match(first.text, /TASKS/, 'the TASKS region is painted');
    assert.ok(first.scroll.tasks.viewportH > 0, 'the task list exposes a scroll viewport');
    assert.equal(first.run?.id, 'orphan:tasks', 'orphans are grouped under the view-only run');
    assert.equal(first.run?.virtual?.kind, 'orphans');
    assert.ok(first.hitboxes.nodes.size > 0, 'the virtual display nodes are painted');
    assert.equal(viewer.ui.selectedRunId, 'orphan:tasks');
    assert.equal(dutyFocusForKey('4'), 'tasks');

    // The visible virtual run seeds a graph subject during reconciliation. This
    // test owns the TASKS row order, so start from the neutral task subject the
    // unlinkable list has always used.
    viewer.ui.selectedTaskId = undefined;
    viewer.ui.selectedNodeId = undefined;
    viewer.ui.selectedTaskUnlinked = false;

    // Focus starts on the duty body; key 4 moves it to the painted TASKS list.
    viewer.ui.focus = 'details';
    press(viewer, '4');
    assert.equal(viewer.ui.focus, 'tasks');

    press(viewer, '\x1b[B', 'down');
    assert.equal(viewer.ui.selectedTaskId, 'st_alpha');
    assert.equal(viewer.ui.selectedTaskUnlinked, true);
    assert.equal(viewer.ui.selectedNodeId, undefined);
    viewer.draw();
    assert.match(viewer.lastRender.text, /Alpha orphan/);
    assert.match(viewer.lastRender.text, /RUNNING/);
    assert.match(viewer.lastRender.text, /40%/);
    assert.match(viewer.lastRender.text, /plan-executor/);
    assert.match(viewer.lastRender.text, /\.omo\/plans\/quality-and-next/);
    assert.match(viewer.lastRender.text, /no node/);

    press(viewer, '\x1b[B', 'down');
    assert.equal(viewer.ui.selectedTaskId, 'st_beta');
    assert.equal(viewer.ui.selectedTaskUnlinked, true);
    viewer.draw();
    assert.match(viewer.lastRender.text, /Beta orphan/);
    assert.match(viewer.lastRender.text, /no node/);
    assert.equal(viewer.lastRender.run?.id, 'orphan:tasks');
    assert.ok(viewer.lastRender.hitboxes.nodes.size > 0);

    press(viewer, '\x1b[B', 'down');
    assert.equal(viewer.ui.selectedTaskId, 'st_zeta', 'completed orphan rows follow running rows');
    viewer.draw();
    assert.match(viewer.lastRender.text, /Zeta finished/);

    press(viewer, '\x1b[A', 'up');
    assert.equal(viewer.ui.selectedTaskId, 'st_beta', 'up moves back through the painted list');
  }
});

test('mixed linked and orphan tasks keep viewer 4/down order in canonical parity', async () => {
  const snapshot = normalizeSnapshot({
    version: 3,
    mode: 'live',
    connected: true,
    sessionId: 'mixed-orphan-parity',
    runs: [{
      id: 'run_mixed',
      name: 'mixed',
      status: 'running',
      nodes: [
        { id: 'root-node', state: 'running', task_id: 'linked-root' },
        { id: 'child-node', state: 'pending', task_id: 'linked-child' },
        { id: 'duplicate-node', state: 'running', task_id: 'linked-root' },
      ],
      edges: [{ from: 'root-node', to: 'child-node' }],
    }],
    tasks: [
      { id: 'linked-root', description: 'linked root', status: 'running' },
      { id: 'linked-child', parentTaskId: 'linked-root', description: 'linked child', status: 'running' },
      { id: 'unlinked-root', description: 'unlinked root', status: 'running' },
      { id: 'unlinked-second', description: 'unlinked second', status: 'pending' },
    ],
  });
  const expected = orphanNavTasks(snapshot).map(task => task.id);
  const viewer = await dutyViewer({ columns: 54, rows: 42 });
  viewer.acceptSnapshot(snapshot, { silent: true });
  viewer.draw();
  viewer.ui.focus = 'details';
  press(viewer, '4');
  assert.equal(viewer.ui.focus, 'tasks');
  const selected = [];
  for (let index = 0; index < expected.length; index += 1) {
    press(viewer, '\x1b[B', 'down');
    selected.push(viewer.ui.selectedTaskId);
  }
  assert.deepEqual(selected, expected);
  assert.equal(selected.includes('linked-root'), false);
  assert.equal(selected.includes('linked-child'), false);
  press(viewer, '\x1b[A', 'up');
  assert.equal(viewer.ui.selectedTaskId, expected[expected.length - 2]);
});

test('a normal run keeps RUNS/CELLS/DUTY and 1/2/3 focus without a TASKS region', async () => {
  const viewer = await dutyViewer({ columns: 54, rows: 42 });
  viewer.acceptSnapshot(normalSnapshot(), { silent: true });
  viewer.draw();

  assert.doesNotMatch(viewer.lastRender.text, /TASKS/);
  assert.equal(viewer.lastRender.scroll.tasks.viewportH, 0);
  assert.ok(viewer.lastRender.text.includes('RUNS'));
  assert.ok(viewer.lastRender.text.includes('CELLS'));
  assert.match(viewer.lastRender.text, /CURRENT NODE/);
  assert.ok(viewer.lastRender.run, 'the live run stays the painted run');

  press(viewer, '1');
  assert.equal(viewer.ui.focus, 'runs');
  press(viewer, '2');
  assert.equal(viewer.ui.focus, 'cells');
  press(viewer, '3');
  assert.equal(viewer.ui.focus, 'details');
  press(viewer, '4');
  assert.equal(viewer.ui.focus, 'details', 'an unpainted TASKS region never keeps focus');
});

// The session boundary is the only place the virtual run may enter. These
// fixtures keep a real run so the append-last and hide-first order is visible.
const sessionViewer = async ({ width = 120, height = 40 } = {}) => {
  const { viewer } = await createTestViewer({
    args: { once: true, width, height, noColor: true, noMotion: true, fps: 10 },
    deps: {
      loadConfig: async () => ({ language: 'en' }),
      loadOmoTheme: async () => 'system',
      loadOmoAppearance: async () => ({}),
      columns: width,
      rows: height,
    },
  });
  viewer.ui.follow = false;
  return viewer;
};

const mixedSessionSnapshot = (orphanStatus = 'running') => normalizeSnapshot({
  version: 3,
  mode: 'live',
  connected: true,
  sessionId: 'mixed-session-orphan',
  updatedAt: '2026-11-16T12:00:00.000Z',
  runs: [{
    id: 'run_live',
    name: 'live run',
    status: 'running',
    nodes: [{ id: 'api', state: 'running', task_id: 'st_linked', percent: 60 }],
    edges: [],
  }],
  tasks: [
    { id: 'st_linked', description: 'Linked task', status: 'running', percent: 60 },
    { id: 'st_orphan_a', description: 'Orphan A', status: orphanStatus, percent: 40 },
    { id: 'st_orphan_b', description: 'Orphan B', status: 'pending' },
  ],
});

test('the visible session snapshot appends one virtual run and repeated accepts never duplicate it', async () => {
  const viewer = await sessionViewer();
  const raw = mixedSessionSnapshot();
  assert.equal(viewer.acceptSnapshot(raw, { silent: true }), true);

  assert.equal(viewer.fullSnapshot.runs.length, 1, 'the raw snapshot keeps only the producer run');
  assert.equal(viewer.fullSnapshot.runs.some(isVirtualRun), false);
  assert.notEqual(viewer.snapshot, viewer.fullSnapshot);
  assert.deepEqual(viewer.snapshot.runs.map(run => run.id), ['run_live', 'orphan:tasks']);
  assert.equal(viewer.snapshot.runs.at(-1).virtual.count, 2);
  assert.deepEqual(viewer.snapshot.runs.at(-1).virtual.memberTaskIds, ['st_orphan_a', 'st_orphan_b']);

  // A second accept of the same capture rebuilds the projection exactly once.
  assert.equal(viewer.acceptSnapshot(raw, { silent: true }), true);
  assert.equal(viewer.snapshot.runs.filter(isVirtualRun).length, 1);
  assert.equal(viewer.snapshot.runs.length, 2);

  // The session keeps the same visible object across draws; only an accepted
  // capture or a hidden-set change recomposes it.
  const settledVisible = viewer.snapshot;
  viewer.draw();
  assert.equal(viewer.snapshot, settledVisible);
  assert.equal(viewer.snapshot.runs.filter(isVirtualRun).length, 1);

  // The transition signature stays on the raw snapshot: one task toast, not a
  // second synthetic-node toast for the same completion.
  viewer.ui.toasts = [];
  assert.equal(viewer.acceptSnapshot(mixedSessionSnapshot('completed'), { silent: false }), true);
  assert.equal(viewer.ui.toasts.filter(toast => /completed/.test(toast.text)).length, 1);
  assert.equal(viewer.snapshot.runs.filter(isVirtualRun).length, 1);
});

test('hidden and clear rebuild one virtual run from the remaining visible orphans', async () => {
  const viewer = await sessionViewer();
  const raw = normalizeSnapshot({
    version: 3,
    mode: 'live',
    connected: true,
    sessionId: 'hidden-session-orphan',
    updatedAt: '2026-11-16T12:00:00.000Z',
    runs: [{
      id: 'run_live',
      name: 'live run',
      status: 'running',
      nodes: [{ id: 'api', state: 'running', task_id: 'st_linked' }],
      edges: [],
    }],
    tasks: [
      { id: 'st_linked', description: 'Linked task', status: 'running' },
      {
        id: 'st_done_a', description: 'Done orphan A', status: 'completed',
        completedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
      },
      {
        id: 'st_done_b', description: 'Done orphan B', status: 'completed',
        completedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
      },
    ],
  });
  assert.equal(viewer.acceptSnapshot(raw, { silent: true }), true);
  assert.equal(viewer.snapshot.runs.at(-1).virtual.count, 2);

  viewer.ui.hiddenTaskIds.add('st_done_a');
  viewer.acceptSnapshot(raw, { silent: true });
  assert.equal(viewer.snapshot.runs.filter(isVirtualRun).length, 1);
  assert.deepEqual(viewer.snapshot.runs.at(-1).virtual.memberTaskIds, ['st_done_b']);

  viewer.ui.hiddenTaskIds.add('st_done_b');
  viewer.acceptSnapshot(raw, { silent: true });
  assert.equal(viewer.snapshot.runs.some(isVirtualRun), false, 'no visible orphans means no virtual run');
  assert.deepEqual(viewer.snapshot.runs.map(run => run.id), ['run_live']);

  viewer.ui.hiddenTaskIds.clear();
  viewer.acceptSnapshot(raw, { silent: true });
  assert.equal(viewer.snapshot.runs.filter(isVirtualRun).length, 1);
  assert.equal(viewer.snapshot.runs.at(-1).virtual.count, 2);

  viewer.handleKey('x', { sequence: 'x', name: 'x' });
  assert.equal(viewer.snapshot.runs.filter(isVirtualRun).length, 0);
  assert.deepEqual(viewer.snapshot.runs.map(run => run.id), ['run_live']);

  viewer.handleKey('u', { sequence: 'u', name: 'u' });
  assert.equal(viewer.snapshot.runs.filter(isVirtualRun).length, 1);
  assert.equal(viewer.snapshot.runs.at(-1).virtual.count, 2);
});
