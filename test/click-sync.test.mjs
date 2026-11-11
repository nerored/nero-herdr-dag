import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, nodeScrollTarget } from '../src/graph.mjs';
import { nodeForTask, normalizeSnapshot } from '../src/model.mjs';
import { navTasks, renderApp, taskAtPoint, taskListLayout } from '../src/render.mjs';
import { createTheme, paletteAt } from '../src/theme.mjs';
import {
  createViewer, ensureSelectionState, selectRunById, selectTaskAtPoint, selectTaskHit, selectionScrollTarget,
} from '../src/viewer.mjs';

const now = 1_000_000;
const palette = paletteAt(0);
const theme = createTheme({ palette, color: false });
const renderOptions = { width: 140, height: 42, time: 0, now, palette, theme };

const node = (id, state, taskId, label = id) => ({
  id, label, state, ...(taskId ? { task_id: taskId } : {}),
});

const chain = (prefix, state, taskId, count = 6) => {
  const nodes = Array.from({ length: count }, (_, index) => node(
    `${prefix}${index}`,
    state,
    index === count - 1 ? taskId : undefined,
    `${prefix} node ${index}`,
  ));
  return { nodes, edges: nodes.slice(1).map((item, index) => ({ from: nodes[index].id, to: item.id })) };
};

// run_a is the active run (ordered first); run_b is a completed run with a
// deeper layout so its linked node has a non-zero recenter target.
const fixture = () => normalizeSnapshot({
  version: 2,
  sessionId: 's',
  connected: true,
  runs: [
    {
      id: 'run_a', name: 'Run A', status: 'running', createdAt: '2026-11-10T00:00:00Z',
      nodes: [node('a0', 'running', 'st_a', 'A node')], edges: [],
    },
    {
      id: 'run_b', name: 'Run B', status: 'completed', createdAt: '2026-11-10T00:05:00Z',
      ...chain('b', 'completed', 'st_b'),
    },
  ],
  tasks: [
    { id: 'st_a', description: 'Alpha task', status: 'running' },
    { id: 'st_b', description: 'Beta task', status: 'completed' },
    { id: 'st_free', description: 'Free task', status: 'running' },
  ],
});

const baseUi = (overrides = {}) => ({
  runIndex: 0,
  selectedRunId: 'run_a',
  runPinned: true,
  focus: 'graph',
  lastFocus: 'graph',
  selectedNodeId: 'a0',
  selectedTaskId: 'st_a',
  selectedTaskUnlinked: false,
  follow: false,
  followTarget: undefined,
  motion: false,
  help: false,
  verbose: false,
  folded: new Set(),
  graphScroll: 0,
  graphScrollTarget: 0,
  manualScroll: false,
  tasksScroll: 0,
  tasksScrollTarget: 0,
  detailsScroll: 0,
  detailsScrollTarget: 0,
  detailsKey: undefined,
  taskRevealKey: undefined,
  sidebar: true,
  fps: 12,
  toasts: [],
  language: 'en',
  ...overrides,
});

test('a linked click in another run switches run, node, and details subject', () => {
  const snapshot = fixture();
  const ui = baseUi();
  const crossRun = snapshot.runs.findIndex(run => run.id === 'run_b');
  assert.ok(crossRun >= 0);

  const clicked = selectTaskHit(ui, snapshot, 'st_b');
  assert.equal(clicked.handled, true);
  assert.equal(clicked.linked.run.id, 'run_b');
  assert.equal(clicked.linked.node.id, 'b5');
  assert.equal(ui.runIndex, crossRun);
  assert.equal(ui.selectedRunId, 'run_b');
  assert.equal(ui.selectedNodeId, 'b5');
  assert.equal(ui.selectedTaskId, 'st_b');
  assert.equal(ui.selectedTaskUnlinked, false);
  assert.equal(ui.focus, 'tasks');
  assert.equal(ui.follow, false);
  assert.equal(ui.followTarget, undefined);
  assert.equal(ui.manualScroll, false);
  assert.equal(ui.runPinned, true);
  assert.equal(ui.graphScroll, 0);
  assert.equal(ui.graphScrollTarget, 0);

  // The next frame keeps the node and re-centers it.
  ensureSelectionState(ui, snapshot);
  assert.equal(ui.selectedNodeId, 'b5');
  const run = snapshot.runs[ui.runIndex];
  const layout = computeLayout(run, 60, { folded: ui.folded });
  const viewportH = 4;
  const expected = nodeScrollTarget(layout, 'b5', viewportH);
  assert.ok(expected > 0, `expected a non-zero recenter target, got ${expected}`);
  assert.equal(selectionScrollTarget(ui, snapshot, layout, viewportH), expected);

  const rendered = renderApp(snapshot, ui, renderOptions);
  assert.equal(rendered.run.id, 'run_b');
  assert.equal(rendered.selectedNode?.id, 'b5');
  assert.equal(rendered.detailsKey, 'task:st_b');
  assert.match(rendered.text, /TASK · st_b/);
});

test('run selection focuses the graph and node details, then task selection returns to task details', () => {
  const snapshot = fixture();
  const ui = baseUi({ focus: 'tasks', selectedTaskId: 'st_b', selectedNodeId: 'b5' });

  assert.equal(selectRunById(ui, snapshot, 'run_b'), true);
  assert.equal(ui.focus, 'graph');
  assert.equal(ui.selectedRunId, 'run_b');
  assert.equal(ui.selectedNodeId, 'b0');

  const nodeFrame = renderApp(snapshot, ui, renderOptions);
  assert.equal(nodeFrame.detailsKey, 'node:run_b:b0');
  assert.match(nodeFrame.text, /NODE · b node 0/);

  const clicked = selectTaskHit(ui, snapshot, 'st_b');
  assert.equal(clicked.handled, true);
  assert.equal(ui.focus, 'tasks');
  assert.equal(ui.runIndex, snapshot.runs.findIndex(run => run.id === 'run_b'));
  assert.equal(ui.selectedNodeId, 'b5');
  assert.equal(ui.selectedTaskId, 'st_b');
  const taskFrame = renderApp(snapshot, ui, renderOptions);
  assert.equal(taskFrame.detailsKey, 'task:st_b');
  assert.match(taskFrame.text, /TASK · st_b/);
});

test('an unlinked task paints a useful task overview in the graph area', () => {
  const snapshot = fixture();
  const ui = baseUi();
  const clicked = selectTaskHit(ui, snapshot, 'st_free');
  assert.equal(clicked.handled, true);
  assert.equal(ui.selectedTaskUnlinked, true);

  const rendered = renderApp(snapshot, ui, renderOptions);
  assert.match(rendered.text, /TASK OVERVIEW/);
  assert.match(rendered.text, /no node/);
  assert.match(rendered.text, /Free task/);
  assert.equal(rendered.graph.layout, null);
  assert.equal(rendered.hitboxes.nodes.size, 0);
});

test('an unlinked click clears the graph subject and keeps task details', () => {
  const snapshot = fixture();
  const ui = baseUi();

  const clicked = selectTaskHit(ui, snapshot, 'st_free');
  assert.equal(clicked.handled, true);
  assert.equal(clicked.linked, undefined);
  assert.equal(ui.selectedTaskId, 'st_free');
  assert.equal(ui.selectedNodeId, undefined);
  assert.equal(ui.selectedTaskUnlinked, true);
  assert.equal(ui.focus, 'tasks');
  assert.equal(ui.manualScroll, false);
  assert.equal(ui.graphScroll, 0);
  assert.equal(ui.graphScrollTarget, 0);
  // The run context stays; only the unrelated node highlight is dropped.
  assert.equal(ui.selectedRunId, 'run_a');
  assert.equal(ui.runIndex, 0);

  // ensureSelection must not immediately re-pick the first/top node.
  ensureSelectionState(ui, snapshot);
  assert.equal(ui.selectedNodeId, undefined);
  assert.equal(ui.selectedTaskUnlinked, true);

  // Leaving and re-entering task focus must not resurrect a graph highlight.
  ui.focus = 'graph';
  ensureSelectionState(ui, snapshot);
  assert.notEqual(ui.selectedNodeId, undefined);
  ui.focus = 'tasks';
  ensureSelectionState(ui, snapshot);
  assert.equal(ui.selectedNodeId, undefined);
  assert.equal(ui.selectedTaskUnlinked, true);

  const run = snapshot.runs[ui.runIndex];
  const layout = computeLayout(run, 60, { folded: ui.folded });
  assert.equal(selectionScrollTarget(ui, snapshot, layout, 4), 0);

  const rendered = renderApp(snapshot, ui, renderOptions);
  assert.equal(rendered.selectedNode, undefined);
  assert.equal(rendered.detailsKey, 'task:st_free');
  assert.match(rendered.text, /TASK · st_free/);
  assert.match(rendered.text, /Free task/);
});

test('a stale task hitbox is ignored instead of selecting the old subject', () => {
  const run = {
    id: 'run_a', name: 'Run A', status: 'completed', createdAt: '2026-11-10T00:00:00Z',
    nodes: [node('a0', 'completed', 'st_a', 'A node')], edges: [],
  };
  const withAlpha = normalizeSnapshot({
    version: 2, sessionId: 's', connected: true, runs: [run],
    tasks: [
      { id: 'st_alpha', description: 'Alpha', status: 'completed' },
      { id: 'st_beta', description: 'Beta', status: 'completed' },
      { id: 'st_gamma', description: 'Gamma', status: 'completed' },
    ],
  });
  // The snapshot update removes Alpha; the previously painted row is now Beta.
  const withoutAlpha = normalizeSnapshot({
    version: 2, sessionId: 's', connected: true, runs: [run],
    tasks: [
      { id: 'st_beta', description: 'Beta', status: 'completed' },
      { id: 'st_gamma', description: 'Gamma', status: 'completed' },
    ],
  });
  const ui = baseUi({ selectedTaskId: 'st_beta', selectedNodeId: 'a0' });

  const painted = renderApp(withAlpha, ui, renderOptions);
  const staleRect = painted.hitboxes.tasks.get('st_alpha');
  assert.ok(staleRect, 'the first frame paints the row that is about to disappear');

  const nextFrame = renderApp(withoutAlpha, ui, renderOptions);
  const freshId = [...nextFrame.hitboxes.tasks].find(([, rect]) =>
    staleRect.x >= rect.x && staleRect.x < rect.x + rect.w &&
    staleRect.y >= rect.y && staleRect.y < rect.y + rect.h)?.[0];
  assert.equal(freshId, 'st_beta', 'the stale coordinates now point at a different task');
  assert.equal(nextFrame.hitboxes.tasks.has('st_alpha'), false);

  const stale = selectTaskHit(ui, withoutAlpha, 'st_alpha');
  assert.deepEqual(stale, { handled: false, linked: undefined });
  assert.equal(ui.selectedTaskId, 'st_beta', 'the stale id does not replace the subject');
  assert.equal(ui.selectedNodeId, 'a0');
  assert.equal(ui.selectedTaskUnlinked, false);

  // Clicking the id actually painted at those coordinates still works.
  const fresh = selectTaskHit(ui, withoutAlpha, freshId);
  assert.equal(fresh.handled, true);
  assert.equal(ui.selectedTaskId, 'st_beta');
});

test('a duplicate task id selects the run the user is viewing', () => {
  const snapshot = normalizeSnapshot({
    version: 2,
    sessionId: 's',
    connected: true,
    runs: [
      {
        id: 'run_active', name: 'Active run', status: 'running',
        createdAt: '2026-11-10T00:10:00Z',
        nodes: [node('active_node', 'running', 'st_dup', 'Active node')], edges: [],
      },
      {
        id: 'run_old', name: 'Old run', status: 'completed',
        createdAt: '2026-11-10T00:00:00Z',
        nodes: [node('old_node', 'completed', 'st_dup', 'Old node')], edges: [],
      },
    ],
    tasks: [{ id: 'st_dup', description: 'Duplicate task', status: 'running' }],
  });
  // Display order puts the active run first; the inverse lookup without a
  // preference therefore lands there, which makes the viewed-run case real.
  assert.equal(snapshot.runs[0].id, 'run_active');
  assert.equal(nodeForTask(snapshot, 'st_dup').run.id, 'run_active');
  const oldIndex = snapshot.runs.findIndex(run => run.id === 'run_old');
  assert.ok(oldIndex > 0);

  const ui = baseUi({
    runIndex: oldIndex,
    selectedRunId: 'run_old',
    selectedNodeId: 'old_node',
    selectedTaskId: 'st_dup',
  });
  // Render-level probe: the viewed frame is the old run before the click.
  const before = renderApp(snapshot, ui, renderOptions);
  assert.equal(before.run.id, 'run_old');
  assert.equal(before.selectedNode?.id, 'old_node');

  const clicked = selectTaskHit(ui, snapshot, 'st_dup');
  assert.equal(clicked.handled, true);
  assert.equal(clicked.linked.run.id, 'run_old');
  assert.equal(clicked.linked.node.id, 'old_node');
  assert.equal(ui.runIndex, oldIndex);
  assert.equal(ui.selectedRunId, 'run_old');
  assert.equal(ui.selectedNodeId, 'old_node');
  assert.equal(ui.selectedTaskUnlinked, false);

  const after = renderApp(snapshot, ui, renderOptions);
  assert.equal(after.run.id, 'run_old');
  assert.equal(after.selectedNode?.id, 'old_node');
  assert.equal(after.detailsKey, 'task:st_dup');
});

test('a reordered row resolves the task under the pointer from the current snapshot', () => {
  const alphaNode = node('a0', 'completed', 'st_alpha', 'Alpha node');
  const betaNode = node('b0', 'running', 'st_beta', 'Beta node');
  const run = {
    id: 'run_a', name: 'Run A', status: 'running', createdAt: '2026-11-10T00:00:00Z',
    nodes: [alphaNode, betaNode], edges: [],
  };
  const snapshotFor = (alphaStatus, betaStatus) => normalizeSnapshot({
    version: 2,
    sessionId: 's',
    connected: true,
    runs: [run],
    tasks: [
      { id: 'st_alpha', description: 'Alpha', status: alphaStatus },
      { id: 'st_beta', description: 'Beta', status: betaStatus },
    ],
  });
  const before = snapshotFor('running', 'completed');
  const afterSwap = snapshotFor('completed', 'running');
  assert.deepEqual(navTasks(before).map(task => task.id), ['st_alpha', 'st_beta']);
  assert.deepEqual(navTasks(afterSwap).map(task => task.id), ['st_beta', 'st_alpha']);

  const ui = baseUi({ selectedTaskId: 'st_alpha', selectedNodeId: 'a0' });
  const painted = renderApp(before, ui, renderOptions);
  const oldAlphaRect = painted.hitboxes.tasks.get('st_alpha');
  assert.ok(oldAlphaRect, 'the first frame paints Alpha at the row about to move');

  // The pure helper agrees with the painted rows.
  const geometry = taskListLayout(painted.layout.sidebar, before, ui);
  assert.deepEqual(geometry.visible.slice(0, 2).map(task => task.id), ['st_alpha', 'st_beta']);
  for (const [id, rect] of painted.hitboxes.tasks) {
    const row = geometry.visible.find(task => task.id === id);
    assert.ok(row, `${id} is a visible row`);
    assert.equal(rect.x, geometry.x);
    assert.equal(rect.w, geometry.contentW);
  }
  assert.equal(oldAlphaRect.y, geometry.tasksY);

  // Both ids survive the reorder; only their rows swap. Resolving the click
  // from the old hitbox id would still select Alpha under Beta's pixels.
  assert.ok(afterSwap.tasks.some(task => task.id === 'st_alpha'));
  const oldIdClick = selectTaskHit(baseUi(), afterSwap, 'st_alpha');
  assert.equal(oldIdClick.handled, true);

  const nextFrame = renderApp(afterSwap, ui, renderOptions);
  const freshId = [...nextFrame.hitboxes.tasks].find(([, rect]) =>
    oldAlphaRect.x >= rect.x && oldAlphaRect.x < rect.x + rect.w &&
    oldAlphaRect.y >= rect.y && oldAlphaRect.y < rect.y + rect.h)?.[0];
  assert.equal(freshId, 'st_beta', 'the current frame paints Beta under the old Alpha rect');

  // The click path uses the current snapshot and current row geometry.
  const resolved = taskAtPoint(painted.layout.sidebar, afterSwap, ui, oldAlphaRect.x, oldAlphaRect.y);
  assert.equal(resolved?.id, 'st_beta');
  const clicked = selectTaskAtPoint(ui, afterSwap, painted.layout.sidebar, oldAlphaRect.x, oldAlphaRect.y);
  assert.equal(clicked.handled, true);
  assert.equal(clicked.linked.run.id, 'run_a');
  assert.equal(clicked.linked.node.id, 'b0');
  assert.equal(ui.selectedTaskId, 'st_beta');
  assert.equal(ui.selectedNodeId, 'b0');
  assert.equal(ui.selectedTaskUnlinked, false);

  const selectedFrame = renderApp(afterSwap, ui, renderOptions);
  assert.equal(selectedFrame.selectedNode?.id, 'b0');
  assert.equal(selectedFrame.detailsKey, 'task:st_beta');
  assert.match(selectedFrame.text, /TASK · st_beta/);

  // The same resolution rejects a row that no longer exists at all.
  const reduced = { ...afterSwap, tasks: afterSwap.tasks.filter(task => task.id !== 'st_beta') };
  assert.equal(taskAtPoint(painted.layout.sidebar, reduced, ui, oldAlphaRect.x, oldAlphaRect.y)?.id, 'st_alpha');
  const staleUi = baseUi();
  const staleClick = selectTaskAtPoint(staleUi, reduced, painted.layout.sidebar, oldAlphaRect.x, oldAlphaRect.y);
  assert.equal(staleClick.handled, true);
  assert.equal(staleUi.selectedTaskId, 'st_alpha');
});

// --- phase 4 regressions (xf-input) ---------------------------------------

const ESC = String.fromCharCode(27);

const makeInputViewer = async ({ columns = 140, rows = 42 } = {}) => {
  const viewer = await createViewer(
    { noColor: true, noMotion: true, fps: 10 },
    {
      loadConfig: async () => ({ language: 'en' }),
      loadOmoTheme: async () => 'system',
      loadOmoAppearance: async () => ({}),
      columns,
      rows,
      write: () => {},
    },
  );
  viewer.ui.follow = false;
  return viewer;
};

test('F-30 raw stdin chunks keep X10 bytes above 0x7f intact', async () => {
  // A short terminal leaves the Help list scrollable, so the wheel has an
  // observable effect.
  const viewer = await makeInputViewer({ rows: 20 });
  viewer.acceptSnapshot(fixture(), { silent: true });
  viewer.draw();
  viewer.handleKey('?');
  assert.equal(viewer.ui.help, true);
  const before = viewer.ui.helpScroll;
  // Wheel down (button byte 0x61) with an x byte of 0xe1: decoding stdin as
  // UTF-8 first would replace that byte with U+FFFD and lose the report.
  viewer.onRawInput(Buffer.from([0x1b, 0x5b, 0x4d, 0x61, 0xe1, 0x27]));
  assert.ok(
    viewer.ui.helpScroll > before,
    `Help should scroll from the byte-accurate report (was ${before}, now ${viewer.ui.helpScroll})`,
  );
});

test('F-31 a split mouse report does not dispatch its digits as keys', async () => {
  const viewer = await makeInputViewer();
  viewer.acceptSnapshot(fixture(), { silent: true });
  viewer.draw();
  // Control: the digits really are duty focus hotkeys in this layout.
  viewer.handleKey('1', { sequence: '1', name: '1' });
  assert.notEqual(viewer.ui.focus, 'details');
  viewer.handleKey('3', { sequence: '3', name: '3' });
  assert.equal(viewer.ui.focus, 'details');

  const target = [...viewer.lastRender.hitboxes.tasks].find(([id, rect]) =>
    id !== viewer.ui.selectedTaskId && /[123]/.test(`${rect.x + 1}${rect.y + 1}`));
  assert.ok(target, 'a sidebar task row carrying a duty digit is painted');
  const [targetId, rect] = target;
  const x = rect.x + 1;
  const y = rect.y + 1;

  const partial = `${ESC}[<0;${x};`;
  viewer.onRawInput(partial);
  // readline emits the fragment as one CSI key plus one key per byte.
  for (const key of ['\x1b[<', ...partial.slice(3)]) viewer.handleKey(key, { sequence: key });
  assert.equal(viewer.ui.focus, 'details', 'fragment digits must not move focus');
  assert.notEqual(viewer.ui.selectedTaskId, targetId, 'the click has not happened yet');

  viewer.onRawInput(`${y}M`);
  assert.equal(viewer.ui.selectedTaskId, targetId, 'the completed report is applied once');
});

test('F-122 motion reports never select or dismiss a modal', async () => {
  const viewer = await makeInputViewer();
  viewer.acceptSnapshot(fixture(), { silent: true });
  viewer.draw();
  viewer.handleKey('?');
  assert.equal(viewer.ui.help, true);
  viewer.onMouseEvent({ button: 32, x: 5, y: 5, release: false });
  assert.equal(viewer.ui.help, true, 'motion is not a click');
  viewer.onMouseEvent({ button: 33, x: 5, y: 5, release: false });
  assert.equal(viewer.ui.help, true, 'drag is not a click');
  viewer.onMouseEvent({ button: 0, x: 5, y: 5, release: false });
  assert.equal(viewer.ui.help, false, 'a real click still dismisses Help');
});

test('a cell click keeps its node when tasks are loaded or foreign', async () => {
  const raw = {
    version: 3, mode: 'live', connected: true,
    runs: [{ id: 'r', status: 'completed', nodes: [
      { id: 'a', label: 'A', state: 'completed', taskId: 'st_a' },
      { id: 'b', label: 'B', state: 'completed', taskId: 'st_b' },
    ], edges: [] }],
    tasks: [
      { id: 'st_a', status: 'completed', description: 'A task' },
      { id: 'st_b', status: 'completed', description: 'B task' },
    ],
  };
  const snapshots = [
    ['loaded', normalizeSnapshot(raw), 'st_b'],
    ['foreign', normalizeSnapshot({ ...raw, tasks: [] }), undefined],
  ];
  for (const [kind, snapshot, expectedTask] of snapshots) {
    for (const [width, focus] of [[140, 'graph'], [59, 'cells']]) {
      const viewer = await makeInputViewer({ columns: width, rows: 40 });
      viewer.acceptSnapshot(snapshot, { silent: true });
      viewer.ui.runIndex = 0;
      viewer.ui.selectedRunId = 'r';
      viewer.ui.selectedNodeId = 'a';
      viewer.ui.selectedTaskId = 'st_a';
      viewer.draw();
      const hit = [...viewer.lastRender.hitboxes.nodes].find(([id]) => id === 'b');
      assert.ok(hit, `node b is painted at ${width} columns with ${kind} tasks`);
      viewer.selectAt(hit[1].x + 2, hit[1].y);
      viewer.draw();
      assert.equal(viewer.ui.selectedNodeId, 'b', `clicked node survives the next draw at ${width} with ${kind} tasks`);
      assert.equal(viewer.ui.selectedTaskId, expectedTask, `clicked node task at ${width} with ${kind} tasks`);
      assert.equal(viewer.ui.focus, focus, `clicked node focus at ${width} with ${kind} tasks`);
    }
  }
});

test('the footer separator shows the installed generation', async () => {
  const viewer = await makeInputViewer({ columns: 59, rows: 40 });
  viewer.acceptSnapshot(fixture(), { silent: true });
  viewer.ui.installVersion = 'generation-000042';
  viewer.draw();
  const lines = viewer.lastRender.text.split('\n');
  assert.match(lines.at(-2), / generation-000042 /);
  assert.doesNotMatch(lines.at(-2), /─generation-000042/);
  assert.doesNotMatch(lines.at(-1), /generation-000042/);
});

test('x keeps running and recent terminal subjects and hides expired ones', async () => {
  const now = Date.now();
  const recent = new Date(now - 60_000).toISOString();
  const old = new Date(now - 10 * 60_000).toISOString();
  const snapshot = normalizeSnapshot({
    version: 3, mode: 'live', connected: true,
    runs: [
      { id: 'live', status: 'running', updatedAt: recent, nodes: [], edges: [] },
      { id: 'recent-completed', status: 'completed', updatedAt: recent, nodes: [], edges: [] },
      { id: 'recent-failed', status: 'failed', updatedAt: recent, nodes: [], edges: [] },
      { id: 'recent-cancelled', status: 'cancelled', updatedAt: recent, nodes: [], edges: [] },
      { id: 'old-completed', status: 'completed', updatedAt: old, nodes: [], edges: [] },
      { id: 'old-failed', status: 'failed', updatedAt: old, nodes: [], edges: [] },
      { id: 'old-cancelled', status: 'cancelled', updatedAt: old, nodes: [], edges: [] },
    ],
    tasks: [
      { id: 'live-task', status: 'running', updatedAt: recent },
      { id: 'recent-task', status: 'completed', completedAt: recent },
      { id: 'recent-cancel-task', status: 'cancelled', updatedAt: recent },
      { id: 'old-task', status: 'completed', completedAt: old },
      { id: 'old-cancel-task', status: 'cancelled', updatedAt: old },
    ],
  });
  const viewer = await makeInputViewer({ columns: 140, rows: 42 });
  viewer.acceptSnapshot(snapshot, { silent: true });
  viewer.handleKey('x');
  assert.deepEqual([...viewer.ui.hiddenRunIds].sort(), ['old-cancelled', 'old-completed', 'old-failed']);
  assert.deepEqual([...viewer.ui.hiddenTaskIds].sort(), ['old-cancel-task', 'old-task']);
  assert.ok(viewer.snapshot.runs.some(run => run.id === 'live'));
  assert.ok(viewer.snapshot.runs.some(run => run.id === 'recent-cancelled'));
  assert.ok(!viewer.snapshot.runs.some(run => run.id === 'old-failed'));
  assert.ok(viewer.snapshot.tasks.some(task => task.id === 'recent-cancel-task'));
  assert.ok(!viewer.snapshot.tasks.some(task => task.id === 'old-cancel-task'));
});
