import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeForTask, normalizeSnapshot, standaloneTasks } from '../src/model.mjs';
import { navTasks, renderApp } from '../src/render.mjs';
import { createTheme, paletteAt } from '../src/theme.mjs';
import {
  createViewer, ensureSelectionState, parseViewerArgs, selectRunById, selectRunOverview,
} from '../src/viewer.mjs';

const now = 1_000_000;
const palette = paletteAt(0);
const theme = createTheme({ palette, color: false });
const ui = {
  runIndex: 0, focus: 'tasks', selectedNodeId: undefined, selectedTaskId: 'st_linked',
  follow: false, motion: false, help: false, verbose: false, folded: new Set(),
  graphScroll: 0, graphScrollTarget: 0, manualScroll: false, sidebar: true,
  fps: 12, toasts: [],
};

// Every root task is attached to a DAG node, which is what a real OmO session
// looks like once work is dispatched through runs.
const allLinked = () => normalizeSnapshot({
  version: 2,
  sessionId: 's',
  connected: true,
  runs: [{
    id: 'r', name: 'Run', status: 'running', createdAt: '2026-11-10T00:00:00Z',
    nodes: [{ id: 'n', label: 'Linked node', state: 'running', task_id: 'st_linked' }],
    edges: [],
  }],
  tasks: [
    { id: 'st_linked', description: 'Linked task', status: 'running' },
    { id: 'st_child', description: 'Child task', status: 'pending', parent_task_id: 'st_linked' },
  ],
});

test('navigation tasks include root tasks linked to a DAG node', () => {
  const snapshot = allLinked();
  assert.deepEqual(standaloneTasks(snapshot), []);
  assert.deepEqual(navTasks(snapshot).map(task => task.id), ['st_linked']);
});

test('a task resolves to the run and node that own it', () => {
  const snapshot = normalizeSnapshot({
    sessionId: 's',
    runs: [
      {
        id: 'run_a', name: 'A', status: 'completed',
        nodes: [{ id: 'a', label: 'A', state: 'completed', task_id: 'st_a' }], edges: [],
      },
      {
        id: 'run_b', name: 'B', status: 'running',
        nodes: [{ id: 'b', label: 'B', state: 'running', task_id: 'st_b' }], edges: [],
      },
    ],
    tasks: [
      { id: 'st_a', description: 'A task', status: 'completed' },
      { id: 'st_b', description: 'B task', status: 'running' },
      { id: 'st_free', description: 'Free task', status: 'running' },
    ],
  });
  const linked = nodeForTask(snapshot, 'st_b');
  assert.equal(linked.run.id, 'run_b');
  assert.equal(linked.node.id, 'b');
  assert.equal(nodeForTask(snapshot, 'st_free'), undefined);
  assert.equal(nodeForTask(snapshot, 'missing'), undefined);
});

test('navigation tasks keep running roots first and never include children', () => {
  const snapshot = normalizeSnapshot({
    sessionId: 's',
    runs: [],
    tasks: [
      { id: 'st_b', description: 'Beta', status: 'pending' },
      { id: 'st_a', description: 'Alpha', status: 'running' },
      { id: 'st_child', description: 'Child', status: 'running', parent_task_id: 'st_a' },
    ],
  });
  assert.deepEqual(navTasks(snapshot).map(task => task.id), ['st_a', 'st_b']);
});

test('the navigation panel renders tasks that belong to DAG nodes', () => {
  const snapshot = allLinked();
  const result = renderApp(snapshot, ui, {
    width: 140, height: 42, time: 0, now, palette, theme,
  });
  assert.match(result.text, /Linked task/);
  assert.match(result.text, /TASK · st_linked/);
  assert.ok(result.hitboxes.tasks.has('st_linked'));
  assert.ok(!result.hitboxes.tasks.has('st_child'));
});

test('a selected task survives a snapshot with no runs', () => {
  const snapshot = normalizeSnapshot({
    version: 2,
    sessionId: 's',
    connected: true,
    runs: [],
    tasks: [{ id: 'st_free', description: 'Free task', status: 'running' }],
  });
  // Mirrors the state left by a task click on a task-store-only snapshot.
  const selection = {
    runIndex: 2, selectedRunId: 'gone', runPinned: true, focus: 'tasks',
    lastFocus: 'tasks', selectedNodeId: 'gone', selectedTaskId: 'st_free',
    selectedTaskUnlinked: true, follow: false, followTarget: undefined,
    graphScroll: 0, graphScrollTarget: 0, manualScroll: false, tasksScroll: 0,
    detailsScroll: 0, detailsScrollTarget: 0, taskRevealKey: undefined,
    language: 'en',
  };

  ensureSelectionState(selection, snapshot);

  assert.equal(selection.selectedTaskId, 'st_free');
  assert.equal(selection.selectedTaskUnlinked, true);
  assert.equal(selection.selectedNodeId, undefined);
  assert.equal(selection.selectedRunId, undefined);
  assert.equal(selection.runIndex, 0);
  assert.equal(selection.runPinned, false);

  const rendered = renderApp(snapshot, selection, {
    width: 140, height: 42, time: 0, now, palette, theme,
  });
  assert.equal(rendered.detailsKey, 'task:st_free');
  assert.match(rendered.text, /TASK · st_free/);

  // A task id that is no longer a navigation task is still dropped.
  selection.selectedTaskId = 'st_gone';
  ensureSelectionState(selection, snapshot);
  assert.equal(selection.selectedTaskId, undefined);
  assert.equal(selection.selectedTaskUnlinked, false);
});

// --- phase 3 regressions (ui-viewer-a) -------------------------------------

const linkedNode = (id, state, taskId, label = id) => ({
  id, label, state, ...(taskId ? { task_id: taskId } : {}),
});
const dagRun = (id, nodes, { createdAt = '2026-11-10T00:00:00Z', status = 'running' } = {}) => ({
  id, name: id, status, createdAt, nodes, edges: [],
});
const dagSnapshot = (runs, tasks) => ({
  version: 2, sessionId: 's', connected: true, runs, tasks,
});

const makeViewer = async ({ columns = 140, rows = 42 } = {}) => {
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
  // Follow is exercised by the fresh-run test; the navigation/click tests pin
  // the subject explicitly.
  viewer.ui.follow = false;
  viewer.writes = writes;
  return viewer;
};

test('F-66 a vanished task moves the run and node subject with its replacement', () => {
  const after = normalizeSnapshot(dagSnapshot([
    dagRun('run_a', [linkedNode('a0', 'running', 'st_a')]),
    dagRun('run_b', [linkedNode('b0', 'running', 'st_b')], { createdAt: '2026-11-10T00:01:00Z' }),
  ], [{ id: 'st_b', description: 'B task', status: 'running' }]));
  const selection = {
    runIndex: 0, selectedRunId: 'run_a', selectedNodeId: 'a0',
    selectedTaskId: 'st_a', selectedTaskUnlinked: false,
    focus: 'tasks', lastFocus: 'tasks', runPinned: false,
  };

  ensureSelectionState(selection, after);

  const owner = nodeForTask(after, 'st_b');
  assert.ok(owner);
  assert.equal(selection.selectedTaskId, 'st_b');
  assert.equal(selection.selectedRunId, owner.run.id);
  assert.equal(selection.runIndex, after.runs.findIndex(run => run.id === owner.run.id));
  assert.equal(selection.selectedNodeId, owner.node.id);
  assert.equal(selection.selectedTaskUnlinked, false);
});

test('F-66 an unlinked replacement task never keeps an unrelated node highlight', () => {
  const after = normalizeSnapshot(dagSnapshot([
    dagRun('run_a', [linkedNode('a0', 'running', 'st_a')]),
  ], [{ id: 'st_free', description: 'Free task', status: 'running' }]));
  const selection = {
    runIndex: 0, selectedRunId: 'run_a', selectedNodeId: 'a0',
    selectedTaskId: 'st_gone', selectedTaskUnlinked: false,
    focus: 'tasks', lastFocus: 'tasks',
  };

  ensureSelectionState(selection, after);

  assert.equal(selection.selectedTaskId, 'st_free');
  assert.equal(selection.selectedTaskUnlinked, true);
  assert.equal(selection.selectedNodeId, undefined);
});

test('F-66 a freshly followed run updates the task subject with its node', async () => {
  const viewer = await makeViewer();
  viewer.ui.follow = true;
  viewer.acceptSnapshot(dagSnapshot([
    dagRun('run_old', [linkedNode('build', 'running', 'st_old')]),
  ], [{ id: 'st_old', description: 'Old task', status: 'running' }]), { silent: true });

  viewer.acceptSnapshot(dagSnapshot([
    dagRun('run_old', [linkedNode('build', 'running', 'st_old')]),
    dagRun('run_new', [linkedNode('collect', 'running', 'st_new')], {
      createdAt: '2026-11-10T00:05:00Z',
    }),
  ], [
    { id: 'st_old', description: 'Old task', status: 'running' },
    { id: 'st_new', description: 'New task', status: 'running' },
  ]), { silent: true });

  assert.equal(viewer.ui.selectedRunId, 'run_new');
  assert.equal(viewer.ui.selectedNodeId, 'collect');
  assert.equal(viewer.ui.selectedTaskId, 'st_new');
  assert.equal(viewer.ui.selectedTaskUnlinked, false);
});

test('F-67 CLI flags require bounded values and reject unknown tokens', () => {
  const invalid = [
    [['--width'], /needs a value/],
    [['--width', '--once'], /needs a value/],
    [['--height', '9000'], /12\.\.512/],
    [['--width', 'Infinity'], /20\.\.4096/],
    [['--fps', '0'], /2\.\.120/],
    [['--fps', 'Infinity'], /2\.\.120/],
    [['--bogus'], /unknown option/],
    [['--scenario', 'someday'], /early, late, or integration/],
    [['--theme', 'not-a-theme'], /expects/],
  ];
  for (const [argv, pattern] of invalid) {
    assert.throws(
      () => parseViewerArgs(argv),
      error => error.name === 'ViewerUsageError' && error.exitCode === 2 && pattern.test(error.message),
      argv.join(' '),
    );
  }

  const options = parseViewerArgs([
    '--once', '--width', '54', '--height', '20', '--fps', '30', '--demo', '--theme', 'dark',
  ]);
  assert.deepEqual(
    { once: options.once, width: options.width, height: options.height, fps: options.fps, demo: options.demo, theme: options.theme },
    { once: true, width: 54, height: 20, fps: 30, demo: true, theme: 'dark' },
  );
  assert.deepEqual(parseViewerArgs([]), {
    help: false, demo: false, once: false, pane: false,
    noColor: false, noMotion: false, fps: 60, scenario: 'integration',
  });
});

test('F-69 importing the viewer never parses argv or exits', { timeout: 20_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-import-'));
  const probe = join(dir, 'probe.mjs');
  const viewerUrl = new URL('../src/viewer.mjs', import.meta.url).href;
  writeFileSync(probe, `import(${JSON.stringify(viewerUrl)}).then(m => console.log('imported', typeof m.createViewer));\n`);
  try {
    const result = spawnSync(process.execPath, [probe, '--help', '-h', '--width'], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, NERO_HERDR_DAG_CONFIG_DIR: join(dir, 'config') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /imported function/);
    // The old module evaluated argv at import and printed this banner + exited.
    assert.doesNotMatch(result.stdout, /herdr-dag-studio viewer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F-72 selecting a run reveals it in the RUNS window', () => {
  const state = normalizeSnapshot(dagSnapshot([
    dagRun('run_a', [linkedNode('a0', 'running', 'st_a')]),
    dagRun('run_b', [linkedNode('b0', 'running', 'st_b')], { createdAt: '2026-11-10T00:01:00Z' }),
  ], []));
  const ui = { runsScroll: 3, runsScrollTarget: 3, cellsScroll: 0, cellsScrollTarget: 0, expanded: false };
  const target = state.runs[1];

  assert.equal(selectRunById(ui, state, target.id, { runs: { viewportH: 1, maxScroll: 5 } }), true);
  assert.equal(ui.runsScroll, 1);
  assert.equal(ui.runsScrollTarget, 1);

  // Above the current offset: reset even when no frame metrics are available.
  ui.runsScroll = 4;
  ui.runsScrollTarget = 4;
  selectRunById(ui, state, state.runs[0].id, {});
  assert.equal(ui.runsScroll, 0);
  assert.equal(ui.runsScrollTarget, 0);
});

test('F-72 the right arrow scrolls the duty RUNS list with the selection', async () => {
  const viewer = await makeViewer({ columns: 54, rows: 24 });
  viewer.acceptSnapshot(dagSnapshot([
    dagRun('run_a', [linkedNode('a0', 'running', 'st_a')]),
    dagRun('run_b', [linkedNode('b0', 'running', 'st_b')], { createdAt: '2026-11-10T00:01:00Z' }),
  ], []), { silent: true });
  viewer.draw();
  assert.equal(viewer.lastRender.scroll.runs.viewportH, 1);

  viewer.handleKey('\x1b[C', { sequence: '\x1b[C', name: 'right' });

  assert.equal(viewer.ui.selectedRunId, viewer.snapshot.runs[1].id);
  assert.equal(viewer.ui.runsScroll, 1);
});

test('F-71 cycling nodes in duty reveals the selected CELLS row', async () => {
  const viewer = await makeViewer({ columns: 54, rows: 24 });
  const nodes = Array.from({ length: 6 }, (_, index) => linkedNode(
    `n${index}`, index === 0 ? 'running' : 'pending', `st_${index}`,
  ));
  viewer.acceptSnapshot(dagSnapshot([
    dagRun('run_a', nodes),
  ], nodes.map((_, index) => ({ id: `st_${index}`, description: `Task ${index}`, status: 'pending' }))), { silent: true });
  viewer.draw();
  assert.equal(viewer.lastRender.scroll.cells.viewportH, 1);

  viewer.handleKey('2', { sequence: '2', name: '2' });
  assert.equal(viewer.ui.focus, 'cells');
  const first = viewer.ui.selectedNodeId;
  viewer.handleKey('Tab', { sequence: 'Tab', name: 'tab' });

  assert.notEqual(viewer.ui.selectedNodeId, first);
  assert.equal(viewer.ui.cellsScroll, 1);
  viewer.draw();
  assert.equal(viewer.lastRender.scroll.cells.offset, 1);
  assert.deepEqual([...viewer.lastRender.hitboxes.nodes.keys()], [viewer.ui.selectedNodeId]);
});

test('F-73 a stale switcher key does not select the active row', async () => {
  const viewer = await makeViewer();
  viewer.acceptSnapshot(dagSnapshot([
    dagRun('run_a', [linkedNode('a0', 'running', 'st_a')]),
    dagRun('run_b', [linkedNode('b0', 'running', 'st_b')], { createdAt: '2026-11-10T00:01:00Z' }),
  ], [
    { id: 'st_a', description: 'A task', status: 'running' },
    { id: 'st_b', description: 'B task', status: 'running' },
  ]), { silent: true });
  viewer.draw();
  viewer.openSwitcher();
  const selection = [viewer.ui.selectedRunId, viewer.ui.selectedNodeId, viewer.ui.selectedTaskId].join('|');

  viewer.confirmSwitcher('task:st_gone');

  assert.notEqual(viewer.ui.switcher, null, 'the switcher stays open for a retry');
  assert.equal([viewer.ui.selectedRunId, viewer.ui.selectedNodeId, viewer.ui.selectedTaskId].join('|'), selection);
  assert.match(viewer.ui.toasts.at(-1).text, /st_gone/);

  // Keyboard Enter still confirms the active row.
  const active = viewer.ui.switcher.activeKey;
  viewer.confirmSwitcher(undefined);
  assert.equal(viewer.ui.switcher, null);
  if (active.startsWith('run:')) assert.equal(viewer.ui.selectedRunId, active.slice(4));
  else assert.equal(viewer.ui.selectedTaskId, active.slice(5));
});

test('F-74 a settings overlay click never falls through to the breadcrumb', async () => {
  const viewer = await makeViewer();
  viewer.acceptSnapshot(dagSnapshot([
    dagRun('run_a', [linkedNode('a0', 'running', 'st_a0'), linkedNode('a1', 'pending', 'st_a1')]),
  ], [
    { id: 'st_a0', description: 'A zero', status: 'running' },
    { id: 'st_a1', description: 'A one', status: 'pending' },
  ]), { silent: true });
  viewer.draw();
  const context = viewer.lastRender.hitboxes.context;
  assert.ok(context.node ?? context.task ?? context.run);
  const rect = context.node ?? context.task ?? context.run;
  const selection = [viewer.ui.selectedRunId, viewer.ui.selectedNodeId, viewer.ui.selectedTaskId].join('|');

  viewer.handleKey('s', { sequence: 's', name: 's' });
  assert.equal(viewer.ui.settingsMenu, true);
  viewer.draw();
  // renderApp does not clear breadcrumb hitboxes for this overlay; the click
  // must be resolved by viewer order, not by absent hitboxes.
  assert.ok(viewer.lastRender.hitboxes.context.node ?? viewer.lastRender.hitboxes.context.task);

  viewer.selectAt(rect.x, rect.y);

  assert.equal(viewer.ui.settingsMenu, false);
  assert.equal([viewer.ui.selectedRunId, viewer.ui.selectedNodeId, viewer.ui.selectedTaskId].join('|'), selection);
});

test('F-155 a stale graph node hit is ignored while a current hit still selects', async () => {
  const viewer = await makeViewer();
  const tasks = [
    { id: 'st0', description: 'Zero', status: 'running' },
    { id: 'st1', description: 'One', status: 'pending' },
    { id: 'st2', description: 'Two', status: 'pending' },
  ];
  viewer.acceptSnapshot(dagSnapshot([
    dagRun('run_a', [linkedNode('n0', 'running', 'st0'), linkedNode('n1', 'pending', 'st1')]),
  ], tasks), { silent: true });
  viewer.draw();
  const stale = viewer.lastRender.hitboxes.nodes.get('n1');
  assert.ok(stale, 'n1 is painted in the first frame');

  viewer.acceptSnapshot(dagSnapshot([
    dagRun('run_a', [linkedNode('n0', 'running', 'st0'), linkedNode('n2', 'pending', 'st2')]),
    dagRun('run_b', [linkedNode('n1', 'pending', 'st1')], { createdAt: '2026-11-10T00:01:00Z' }),
  ], tasks), { silent: true });
  assert.equal(viewer.ui.selectedNodeId, 'n0');
  assert.equal(viewer.ui.selectedRunId, 'run_a');

  viewer.selectAt(stale.x, stale.y);

  assert.equal(viewer.ui.selectedNodeId, 'n0', 'the removed n1 hit is ignored');
  assert.equal(viewer.ui.selectedRunId, 'run_a');

  viewer.draw();
  const current = viewer.lastRender.hitboxes.nodes.get('n2');
  assert.ok(current);
  viewer.selectAt(current.x, current.y);
  assert.equal(viewer.ui.selectedNodeId, 'n2');
  assert.equal(viewer.ui.selectedRunId, 'run_a');
});

test('selecting a run keeps the run summary subject until a node is chosen', async () => {
  const viewer = await makeViewer();
  viewer.acceptSnapshot(dagSnapshot([
    dagRun('run_a', [linkedNode('a0', 'completed', 'st_a'), linkedNode('a1', 'completed', 'st_b')]),
  ], [
    { id: 'st_a', description: 'A task', status: 'completed' },
    { id: 'st_b', description: 'B task', status: 'completed' },
  ]), { silent: true });
  viewer.draw();
  const run = viewer.snapshot.runs[0];
  assert.equal(selectRunOverview(viewer.ui, viewer.snapshot, run.id), true);
  viewer.draw();
  assert.equal(viewer.ui.runOverview, true);
  assert.equal(viewer.ui.selectedNodeId, undefined);
  assert.match(viewer.lastRender.text, /RUN SUMMARY/);

  // A later draw must not fall back to the run's first node.
  ensureSelectionState(viewer.ui, viewer.snapshot);
  assert.equal(viewer.ui.selectedNodeId, undefined);

  // Choosing a node leaves the run-level subject again.
  viewer.handleKey('Tab', { sequence: 'Tab', name: 'tab' });
  assert.equal(viewer.ui.runOverview, false);
  assert.ok(viewer.ui.selectedNodeId);
});
