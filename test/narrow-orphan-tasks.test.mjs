import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVirtualRun, normalizeSnapshot, orphanNavTasks } from '../src/model.mjs';
import { renderApp, taskListLayout } from '../src/render.mjs';
import { withOrphanRun } from '../src/orphan-run.mjs';
import { paletteAt, createTheme } from '../src/theme.mjs';
import { filterSwitcher, switcherItems } from '../src/view-state.mjs';
import { hitTargetAt } from '../src/view-model.mjs';
import { advanceRunSelection, reconcileRunSelection } from '../src/view-state.mjs';
import { dutyFocusForKey } from '../src/viewer-keymap.mjs';
import { createViewerSession } from '../src/viewer-session.mjs';
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
    assert.equal(viewer.ui.selectedTaskId, undefined, 'no TASKS row is synthesized');
    assert.equal(viewer.ui.selectedNodeId, undefined, 'no producer node is auto-selected');
    assert.equal(viewer.ui.selectedTaskUnlinked, false, 'no unlinked task subject is synthesized');
    assert.equal(first.selectedNode, undefined, 'details resolve to the run, never a node');
    assert.equal(dutyFocusForKey('4'), 'tasks');

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

test('virtual graph paints flat member nodes with hitboxes and separate cap counts', async () => {
  const viewer = await sessionViewer({ width: 120, height: 40 });
  const tasks = Array.from({ length: 4098 }, (_, index) => ({
    id: `orphan-${index}`,
    description: `Orphan ${index}`,
    status: index === 0 ? 'unknown' : 'pending',
  }));
  viewer.acceptSnapshot(normalizeSnapshot({
    version: 3, mode: 'live', connected: true, sessionId: 'virtual-cap', runs: [], tasks,
  }), { silent: true });
  viewer.draw();
  const frame = viewer.lastRender;
  const run = frame.run;
  assert.equal(run.virtual.count, 4098);
  assert.equal(run.virtual.memberTaskIds.length, 4098);
  assert.equal(run.virtual.omittedNodes, 2);
  assert.equal(run.edges.length, 0);
  assert.ok(frame.hitboxes.nodes.size > 0);
  assert.ok(frame.hitboxes.nodes.size <= run.nodes.length);
  assert.match(frame.text, /UNATTACHED/);
  assert.equal(frame.graph.layout.hiddenNodes, 3186);
  assert.match(frame.text, /o2/);
  assert.match(frame.text, /h3186/);
  assert.equal(run.nodes[0].state, 'unknown');
  const narrow = await sessionViewer({ width: 70, height: 24 });
  narrow.acceptSnapshot(normalizeSnapshot({
    version: 3, mode: 'live', connected: true, sessionId: 'virtual-cap-narrow', runs: [], tasks,
  }), { silent: true });
  narrow.draw();
  assert.match(narrow.lastRender.text, /o2/);
  assert.match(narrow.lastRender.text, /h4095/);
});

test('wide virtual graph badge prints one hidden and one omitted token', async () => {
  const viewer = await sessionViewer({ width: 160, height: 50 });
  const tasks = Array.from({ length: 5000 }, (_, index) => ({
    id: `orphan-${index}`,
    description: `Orphan ${index}`,
    status: 'pending',
  }));
  viewer.acceptSnapshot(normalizeSnapshot({
    version: 3, mode: 'live', connected: true, sessionId: 'virtual-wide-badge', runs: [], tasks,
  }), { silent: true });
  viewer.draw();
  const frame = viewer.lastRender;
  const badgeLine = frame.text.split('\n').find(line => line.includes('GRAPH') && line.includes('4096/5000'));
  assert.ok(badgeLine, 'the wide badge is painted in full');
  assert.equal((badgeLine.match(/h\d+/g) ?? []).length, 1, `one layout-hidden token in: ${badgeLine}`);
  assert.equal((badgeLine.match(/o\d+/g) ?? []).length, 1, `one omitted token in: ${badgeLine}`);
  assert.match(badgeLine, new RegExp(`h${frame.graph.layout.hiddenNodes}`));
  assert.match(badgeLine, /o904/);
});

test('narrow CELLS cap localizes omitted and hidden tokens in EN and ZH', async () => {
  const render = async (language) => {
    const viewer = await sessionViewer({ width: 70, height: 24 });
    viewer.ui.language = language;
    const tasks = Array.from({ length: 5000 }, (_, index) => ({
      id: `st_${String(index).padStart(5, '0')}`,
      description: `orphan ${index}`,
      status: 'pending',
    }));
    viewer.acceptSnapshot(normalizeSnapshot({
      version: 3, mode: 'live', connected: true, sessionId: `narrow-cap-${language}`, runs: [], tasks,
    }), { silent: true });
    viewer.draw();
    return viewer.lastRender;
  };
  const en = await render('en');
  const zh = await render('zh');
  const enLine = en.text.split('\n').find(line => line.includes('CELLS'));
  const zhLine = zh.text.split('\n').find(line => line.includes('节点 · 未归属任务'));
  assert.ok(enLine && zhLine);
  const enHidden = en.run.nodes.length - en.scroll.cells.viewportH;
  const zhHidden = zh.run.nodes.length - zh.scroll.cells.viewportH;
  assert.match(enLine, new RegExp(`o904 · h${enHidden}`));
  assert.match(zhLine, new RegExp(`省904 · 隐${zhHidden}`));
  assert.doesNotMatch(zhLine, /o904|h\d+/, 'the Chinese cell cap never falls back to Latin tokens');
  assert.doesNotMatch(enLine, /省|隐/);
  assert.equal(en.run.virtual.omittedNodes, 904);
  assert.equal(zh.run.virtual.omittedNodes, 904, 'wide and narrow agree on the omitted count');
});

test('virtual painted surfaces prove labels, scope, hitboxes, switcher, and Chinese context', async () => {
  const raw = normalizeSnapshot({
    version: 3, mode: 'live', connected: true, sessionId: 'painted-surfaces',
    runs: [{ id: 'real', name: 'Real', status: 'running', nodes: [{ id: 'linked-node', state: 'running', task_id: 'linked' }], edges: [] }],
    tasks: [
      { id: 'linked', description: 'Linked', status: 'running' },
      { id: 'orphan-a', description: 'Orphan A', status: 'running', percent: 40 },
      { id: 'orphan-b', description: 'Orphan B', status: 'unknown' },
    ],
  });
  const snapshot = withOrphanRun(raw);
  const virtual = snapshot.runs.at(-1);
  const palette = paletteAt(0);
  const theme = createTheme({ palette, color: false });
  const baseUi = {
    runIndex: 1, selectedRunId: virtual.id, focus: 'graph', selectedNodeId: 'orphan-a',
    selectedTaskId: 'orphan-a', selectedTaskUnlinked: false, taskScope: 'all',
    follow: false, motion: false, help: false, verbose: false, folded: new Set(),
    sidebar: true, fps: 10, toasts: [], completedCollapsed: false,
  };
  for (const [width, height] of [[120, 40], [70, 24]]) {
    const frame = renderApp(snapshot, width < 112 ? { ...baseUi, runsScroll: 1, runIndex: 1 } : baseUi, { width, height, now: 1_000_000, palette, theme });
    assert.match(frame.text, /UNATTACHED TASKS/);
    assert.match(frame.text, /UNATTACHED/);
    assert.match(frame.text, /TASKS/);
    if (width < 112) {
      assert.match(frame.text, /RUNS/);
      assert.match(frame.text, /UNATTACHED TASKS/);
      assert.ok(frame.hitboxes.runs.has('orphan:tasks'));
      const runRect = frame.hitboxes.runs.get('orphan:tasks');
      const runRows = frame.text.split('\n').slice(runRect.y, runRect.y + runRect.h).join('\n');
      assert.match(runRows, /UNATTACHED TASKS/);
      assert.match(frame.text, /CELLS · UNATTACHED TASKS/);
      const rect = frame.hitboxes.nodes.get('orphan-a');
      assert.ok(rect);
      assert.deepEqual(hitTargetAt({ snapshot, ui: baseUi, frame }, rect.x, rect.y), { kind: 'node', id: 'orphan-a' });
    } else {
      assert.match(frame.text, /unattached/);
      const rect = frame.hitboxes.nodes.get('orphan-a');
      assert.ok(rect);
      assert.deepEqual(hitTargetAt({ snapshot, ui: baseUi, frame }, rect.x, rect.y), { kind: 'node', id: 'orphan-a' });
    }
  }
  const switcher = filterSwitcher(switcherItems(snapshot, [], { tasks: snapshot.tasks, language: 'en' }), 'unattached');
  assert.deepEqual(switcher.map(item => item.key), ['run:orphan:tasks']);
  const switcherFrame = renderApp(snapshot, { ...baseUi, switcher: { query: 'unattached', frozenKeys: [], activeKey: 'run:orphan:tasks' } }, { width: 120, height: 40, now: 1_000_000, palette, theme });
  assert.ok(switcherFrame.hitboxes.switcher.has('run:orphan:tasks'));
  assert.match(switcherFrame.text, /UNATTACHED TASKS/);
  const zh = renderApp(snapshot, { ...baseUi, language: 'zh' }, { width: 120, height: 40, now: 1_000_000, palette, theme });
  assert.match(zh.text, /未归属任务/);
  assert.doesNotMatch(zh.text, /UNATTACHED TASKS/);
});

test('normal indexed run never paints an appended virtual run', () => {
  const snapshot = withOrphanRun(normalizeSnapshot({
    ...normalSnapshot(),
    tasks: [
      { id: 'st_api', description: 'build the HTTP API', status: 'running', percent: 60 },
      { id: 'st_tests', description: 'run the test suite', status: 'pending' },
      { id: 'st_orphan', description: 'orphan task', status: 'pending' },
    ],
  }));
  const palette = paletteAt(0);
  const theme = createTheme({ palette, color: false });
  const frame = renderApp(snapshot, {
    runIndex: 0, selectedRunId: 'run_build', focus: 'graph', selectedNodeId: 'api',
    selectedTaskId: 'st_api', selectedTaskUnlinked: false, follow: false, motion: false,
    folded: new Set(), sidebar: true, help: false, verbose: false, toasts: [], language: 'en',
  }, { width: 120, height: 40, now: 1_000_000, palette, theme });
  assert.equal(frame.run.id, 'run_build');
  assert.equal(frame.run.virtual, undefined);
  assert.ok(frame.hitboxes.runs.has('run_build'));
});

test('a virtual-only TASKS scope never leaks back onto a real run', async () => {
  const viewer = await sessionViewer({ width: 120, height: 40 });
  viewer.acceptSnapshot(mixedSessionSnapshot(), { silent: true });
  const realIndex = viewer.snapshot.runs.findIndex(run => run.id === 'run_live');
  const virtual = viewer.snapshot.runs.find(isVirtualRun);
  assert.ok(realIndex >= 0 && virtual);
  viewer.ui.runIndex = viewer.snapshot.runs.indexOf(virtual);
  viewer.ui.selectedRunId = virtual.id;
  viewer.ui.focus = 'tasks';
  viewer.draw();

  // The scope toggle on the virtual group must not store its derived
  // 'unattached' label in the shared run/all state.
  press(viewer, 't');
  viewer.draw();
  assert.equal(viewer.ui.taskScope, 'run', 'the virtual scope stays derived, not stored');
  const virtualGeometry = taskListLayout(viewer.lastRender.layout.sidebar, viewer.snapshot, viewer.ui);
  assert.equal(virtualGeometry.scope, 'unattached');
  assert.deepEqual(virtualGeometry.tasks.map(task => task.id), ['st_orphan_a', 'st_orphan_b']);
  assert.match(viewer.lastRender.text, /TASKS\s+2 · unattached/);

  // Switching back to the real run paints that run's own scope and linked list.
  press(viewer, '\x1b[D', 'left');
  viewer.draw();
  assert.equal(viewer.ui.runIndex, realIndex);
  assert.equal(viewer.ui.selectedRunId, 'run_live');
  assert.equal(viewer.ui.taskScope, 'run');
  const realGeometry = taskListLayout(viewer.lastRender.layout.sidebar, viewer.snapshot, viewer.ui);
  assert.equal(realGeometry.scope, 'run');
  assert.deepEqual(realGeometry.tasks.map(task => task.id), ['st_linked']);
  const realTasksLine = viewer.lastRender.text.split('\n').find(line => /TASKS\s+1\b/.test(line));
  assert.ok(realTasksLine, 'the real run paints its own TASKS header');
  assert.doesNotMatch(realTasksLine, /unattached/i, 'the real run never paints the virtual scope');
  assert.match(realTasksLine, /TASKS\s+1 · run/);
});

test('switching from a real linked task to the virtual run never carries it into TASKS', async () => {
  for (const [width, height] of [[70, 24], [120, 40]]) {
    const viewer = await sessionViewer({ width, height });
    viewer.acceptSnapshot(mixedSessionRaw(), { silent: true });
    viewer.draw();

    assert.equal(viewer.ui.selectedRunId, 'run_live');
    assert.equal(viewer.ui.selectedTaskId, 'st_linked');
    assert.equal(viewer.ui.selectedTaskUnlinked, false);
    assert.equal(viewer.ui.selectedNodeId, 'api');

    press(viewer, '\x1b[C', 'right');
    viewer.draw();
    const virtual = viewer.snapshot.runs.find(isVirtualRun);
    assert.ok(virtual);
    assert.equal(viewer.ui.selectedRunId, virtual.id);
    assert.equal(viewer.ui.selectedNodeId, 'st_orphan_a', 'the explicit virtual node subject survives');
    assert.equal(viewer.ui.selectedTaskId, undefined, 'the real task breadcrumb leaves with the real run');
    assert.equal(viewer.ui.selectedTaskUnlinked, false, 'no task subject is synthesized');
    assert.doesNotMatch(viewer.lastRender.text, /TASK · st_linked|Linked task/);
    assert.equal(viewer.lastRender.detailsKey, 'node:orphan:tasks:st_orphan_a');

    press(viewer, '4', '4');
    viewer.draw();
    assert.equal(viewer.ui.focus, 'tasks');
    assert.equal(viewer.ui.selectedTaskId, undefined);
    assert.equal(viewer.ui.selectedTaskUnlinked, false);
    assert.ok(viewer.lastRender.scroll.tasks.viewportH > 0, 'the unattached TASKS list is painted');
    assert.match(viewer.lastRender.text, width >= 112 ? /TASKS\s+2 · unattached/ : /TASKS · unattached/);
    assert.doesNotMatch(viewer.lastRender.text, /TASK · st_linked|Linked task/);
    assert.doesNotMatch(viewer.lastRender.detailsKey ?? '', /^task:/);
    if (width >= 112) {
      const geometry = taskListLayout(viewer.lastRender.layout.sidebar, viewer.snapshot, viewer.ui);
      assert.equal(geometry.scope, 'unattached');
      assert.deepEqual(geometry.tasks.map(task => task.id), ['st_orphan_a', 'st_orphan_b']);
    }

    press(viewer, '\x1b[B', 'down');
    viewer.draw();
    if (width < 112) {
      assert.equal(viewer.ui.selectedTaskId, 'st_orphan_a');
      assert.equal(viewer.ui.selectedTaskUnlinked, true);
      assert.equal(viewer.ui.selectedNodeId, undefined);
      assert.equal(viewer.lastRender.detailsKey, 'task:st_orphan_a');
      assert.match(viewer.lastRender.text, /TASKS · unattached/);
    } else {
      // The investigation sidebar scrolls on Down; it must never resurrect the
      // foreign real task while doing so.
      assert.equal(viewer.ui.selectedTaskId, undefined);
      assert.equal(viewer.ui.selectedTaskUnlinked, false);
      assert.equal(viewer.lastRender.detailsKey, 'run:orphan:tasks');
    }
    assert.doesNotMatch(viewer.lastRender.text, /TASK · st_linked|Linked task/);

    press(viewer, '\x1b[D', 'left');
    viewer.draw();
    assert.equal(viewer.ui.selectedRunId, 'run_live');
    assert.equal(viewer.ui.selectedTaskId, 'st_linked', 'the real run restores its linked task subject');
    assert.equal(viewer.ui.selectedTaskUnlinked, false);
    assert.equal(viewer.ui.selectedNodeId, 'api');
    press(viewer, '4', '4');
    viewer.draw();
    assert.equal(viewer.lastRender.detailsKey, 'task:st_linked');
    assert.match(viewer.lastRender.text, /TASK · st_linked/);
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
  assert.equal(viewer.ui.hiddenRunIds.size, 0, 'the virtual id is never written to hidden runs');
  assert.deepEqual([...viewer.ui.hiddenTaskIds].sort(), ['st_done_a', 'st_done_b']);

  viewer.handleKey('u', { sequence: 'u', name: 'u' });
  assert.equal(viewer.snapshot.runs.filter(isVirtualRun).length, 1);
  assert.equal(viewer.snapshot.runs.at(-1).virtual.count, 2);
});

test('orphan-only default focus selects the virtual run and paints the flat graph', async () => {
  const viewer = await sessionViewer();
  viewer.acceptSnapshot(orphanSnapshot(), { silent: true });
  viewer.draw();

  assert.equal(viewer.ui.selectedRunId, 'orphan:tasks');
  assert.equal(viewer.ui.runIndex, 0);
  assert.equal(viewer.ui.focus, 'graph');
  assert.equal(viewer.ui.selectedTaskId, undefined);
  assert.equal(viewer.ui.selectedTaskUnlinked, false);
  assert.equal(viewer.ui.selectedNodeId, undefined);
  assert.equal(viewer.lastRender.selectedNode, undefined);
  assert.ok(viewer.lastRender.graph.layout, 'the flat virtual graph has a layout');
  assert.equal(viewer.lastRender.hitboxes.nodes.size, 3);
  assert.doesNotMatch(viewer.lastRender.detailsKey ?? '', /^node:/, 'details are not node-focused');

  viewer.ui.focus = 'details';
  press(viewer, '4');
  assert.equal(viewer.ui.focus, 'tasks', 'TASKS remains reachable with 4');
  assert.equal(viewer.ui.selectedTaskId, undefined, 'opening TASKS does not synthesize a row');
  assert.equal(viewer.ui.selectedNodeId, undefined);
});

test('a TASKS selection stays unlinked when focus moves to RUNS or CELLS', async () => {
  const viewer = await dutyViewer({ columns: 54, rows: 42 });
  viewer.acceptSnapshot(orphanSnapshot(), { silent: true });
  viewer.draw();
  // Start from the empty task subject so the first down key selects the first
  // painted row instead of stepping past the default subject.
  viewer.ui.selectedTaskId = undefined;
  viewer.ui.selectedNodeId = undefined;
  viewer.ui.selectedTaskUnlinked = false;
  viewer.ui.focus = 'details';
  press(viewer, '4');
  press(viewer, '\x1b[B', 'down');
  assert.equal(viewer.ui.selectedTaskId, 'st_alpha');
  assert.equal(viewer.ui.selectedTaskUnlinked, true);
  assert.equal(viewer.ui.selectedNodeId, undefined);

  for (const key of ['1', '2']) {
    press(viewer, key);
    viewer.ensureSelection();
    assert.equal(viewer.ui.selectedTaskUnlinked, true, key + ' keeps the TASKS row unlinked');
    assert.equal(viewer.ui.selectedNodeId, undefined, key + ' invents no virtual node subject');
    assert.equal(viewer.ui.selectedTaskId, 'st_alpha');
    assert.equal(viewer.ui.selectedRunId, 'orphan:tasks');
  }
});

const mixedSessionRaw = ({ extraOrphan = false, extraRealRun = false } = {}) => normalizeSnapshot({
  version: 3,
  mode: 'live',
  connected: true,
  sessionId: 'mixed-session-orphan',
  updatedAt: '2026-11-16T12:00:00.000Z',
  runs: [
    {
      id: 'run_live', name: 'live run', status: 'running',
      nodes: [{ id: 'api', state: 'running', task_id: 'st_linked', percent: 60 }],
      edges: [],
    },
    ...(extraRealRun ? [{
      id: 'run_new', name: 'new run', status: 'running',
      nodes: [{ id: 'collect', state: 'running', task_id: 'st_new' }],
      edges: [],
    }] : []),
  ],
  tasks: [
    { id: 'st_linked', description: 'Linked task', status: 'running', percent: 60 },
    { id: 'st_orphan_a', description: 'Orphan A', status: 'running', percent: 40 },
    { id: 'st_orphan_b', description: 'Orphan B', status: 'pending' },
    ...(extraOrphan ? [{ id: 'st_orphan_c', description: 'Orphan C', status: 'pending' }] : []),
    ...(extraRealRun ? [{ id: 'st_new', description: 'New task', status: 'running' }] : []),
  ],
});

test('fresh-run auto-selection and follow skip the appended virtual run', async () => {
  const viewer = await sessionViewer();
  viewer.ui.follow = true;
  viewer.acceptSnapshot(mixedSessionRaw(), { silent: true });
  assert.equal(viewer.ui.selectedRunId, 'run_live');

  const advanced = advanceRunSelection(viewer.snapshot.runs, {
    previousRunIds: new Set(viewer.snapshot.runs
      .filter(run => !isVirtualRun(run)).map(run => run.id)),
    hadRuns: true, follow: true, pinned: false,
    runIndex: 0, selectedRunId: 'run_live',
  });
  assert.equal(advanced.fresh, undefined, 'the virtual group is never a fresh producer run');
  assert.equal(advanced.selectedRunId, 'run_live');

  // Adding a member is a virtual-only change; the real selection stays put.
  viewer.acceptSnapshot(mixedSessionRaw({ extraOrphan: true }), { silent: true });
  assert.equal(viewer.ui.selectedRunId, 'run_live');
  assert.equal(viewer.snapshot.runs.at(-1).virtual.count, 3);

  // A genuinely new real run still wins the fresh-selection path.
  viewer.acceptSnapshot(mixedSessionRaw({ extraOrphan: true, extraRealRun: true }), { silent: true });
  assert.equal(viewer.ui.selectedRunId, 'run_new');
  assert.equal(viewer.ui.selectedTaskId, 'st_new');
  assert.equal(viewer.ui.selectedTaskUnlinked, false);
});

test('a vanished real selection falls back to a producer run, not the virtual append', async () => {
  const viewer = await sessionViewer();
  viewer.acceptSnapshot(mixedSessionRaw(), { silent: true });
  const runs = viewer.snapshot.runs;

  const implicit = reconcileRunSelection(runs, { runIndex: 1, selectedRunId: 'run_gone' });
  assert.equal(implicit.selectedRunId, 'run_live');
  assert.equal(implicit.index, 0);

  const explicit = reconcileRunSelection(runs, { runIndex: 0, selectedRunId: 'orphan:tasks' });
  assert.equal(explicit.selectedRunId, 'orphan:tasks');
  assert.equal(explicit.index, 1);
});

test('switchRun reaches the appended virtual run last and wraps to real runs', async () => {
  const viewer = await sessionViewer();
  viewer.acceptSnapshot(mixedSessionRaw(), { silent: true });
  assert.deepEqual(viewer.snapshot.runs.map(run => run.id), ['run_live', 'orphan:tasks']);

  press(viewer, '\x1b[C', 'right');
  assert.equal(viewer.ui.runIndex, 1);
  assert.equal(viewer.ui.selectedRunId, 'orphan:tasks');
  assert.equal(viewer.ui.selectedNodeId, 'st_orphan_a');

  press(viewer, '\x1b[C', 'right');
  assert.equal(viewer.ui.runIndex, 0);
  assert.equal(viewer.ui.selectedRunId, 'run_live');
});

test('hiding a completed run promotes its live task and undo reverses it', async () => {
  const viewer = await sessionViewer();
  const raw = normalizeSnapshot({
    version: 3,
    mode: 'live',
    connected: true,
    sessionId: 'hidden-real-promote',
    updatedAt: '2020-01-01T00:00:00.000Z',
    runs: [{
      id: 'run_done', name: 'Done run', status: 'completed', updatedAt: '2020-01-01T00:00:00.000Z',
      nodes: [
        { id: 'done-node', state: 'completed', task_id: 'st_done_task' },
        { id: 'live-node', state: 'running', task_id: 'st_live_task' },
      ],
      edges: [],
    }],
    tasks: [
      { id: 'st_done_task', description: 'Done task', status: 'completed', completedAt: '2020-01-01T00:00:00.000Z' },
      { id: 'st_live_task', description: 'Live task', status: 'running' },
    ],
  });
  viewer.acceptSnapshot(raw, { silent: true });

  viewer.handleKey('x', { sequence: 'x', name: 'x' });
  assert.deepEqual([...viewer.ui.hiddenRunIds], ['run_done']);
  assert.equal(viewer.snapshot.runs.some(run => run.id === 'run_done'), false);
  const virtual = viewer.snapshot.runs.find(isVirtualRun);
  assert.ok(virtual, 'the live task is promoted into its own group');
  assert.deepEqual(virtual.virtual.memberTaskIds, ['st_live_task']);
  assert.equal(viewer.snapshot.tasks.some(task => task.id === 'st_live_task'), true);
  assert.equal(viewer.snapshot.tasks.some(task => task.id === 'st_done_task'), false);

  viewer.handleKey('u', { sequence: 'u', name: 'u' });
  assert.equal(viewer.ui.hiddenRunIds.size, 0);
  assert.equal(viewer.snapshot.runs.some(run => run.id === 'run_done'), true);
  assert.equal(viewer.snapshot.runs.some(isVirtualRun), false);
  assert.equal(viewer.snapshot.tasks.some(task => task.id === 'st_live_task'), true);
});

test('membership changes drop vanished virtual nodes and adopt a new real link', () => {
  const session = createViewerSession({ requestRepaint: () => {}, draw: () => {} });
  session.ui.follow = false;
  const raw = mixedSessionRaw();
  session.acceptSnapshot(raw, { silent: true });
  let virtual = session.snapshot.runs.find(isVirtualRun);
  assert.ok(virtual);
  session.ui.runIndex = session.snapshot.runs.indexOf(virtual);
  session.ui.selectedRunId = virtual.id;
  session.ui.selectedTaskId = 'st_orphan_b';
  session.ui.selectedTaskUnlinked = true;
  session.ui.selectedNodeId = 'st_orphan_a';
  session.ui.focus = 'graph';
  session.ensureSelection();
  assert.equal(session.ui.selectedNodeId, 'st_orphan_a', 'the explicit virtual node is kept');

  session.ui.hiddenTaskIds.add('st_orphan_a');
  session.refreshHiddenSnapshot();
  virtual = session.snapshot.runs.find(isVirtualRun);
  assert.deepEqual(virtual.virtual.memberTaskIds, ['st_orphan_b']);
  session.ensureSelection();
  assert.equal(session.ui.selectedNodeId, undefined, 'the vanished virtual node leaves no stale subject');
  assert.equal(session.ui.selectedTaskId, 'st_orphan_b');
  assert.equal(session.ui.selectedTaskUnlinked, true);
  assert.equal(session.ui.selectedRunId, virtual.id);

  // The task gains a producer node: the group disappears and the subject moves
  // to the real run/node that now owns it.
  session.ui.hiddenTaskIds.clear();
  session.acceptSnapshot(normalizeSnapshot({
    version: 3,
    mode: 'live',
    connected: true,
    sessionId: 'mixed-session-orphan',
    runs: [{
      id: 'run_live', name: 'live run', status: 'running',
      nodes: [
        { id: 'api', state: 'running', task_id: 'st_linked' },
        { id: 'b-node', state: 'running', task_id: 'st_orphan_b' },
      ],
      edges: [],
    }],
    tasks: [
      { id: 'st_linked', description: 'Linked task', status: 'running' },
      { id: 'st_orphan_b', description: 'Orphan B', status: 'running' },
    ],
  }), { silent: true });
  assert.equal(session.snapshot.runs.some(isVirtualRun), false);
  session.ensureSelection();
  assert.equal(session.ui.selectedTaskUnlinked, false);
  assert.equal(session.ui.selectedRunId, 'run_live');
  assert.equal(session.ui.selectedNodeId, 'b-node');
});

test('v1, v2, and v3 compose the same virtual membership and wide TASKS scope', async () => {
  for (const version of [1, 2, 3]) {
    const viewer = await sessionViewer();
    viewer.acceptSnapshot(normalizeSnapshot({
      version,
      mode: 'live',
      connected: true,
      sessionId: 'virtual-v' + version,
      runs: [{
        id: 'run_live', name: 'live run', status: 'running',
        nodes: [{ id: 'api', state: 'running', task_id: 'st_linked' }], edges: [],
      }],
      tasks: [
        { id: 'st_linked', description: 'Linked task', status: 'running' },
        { id: 'st_orphan_a', description: 'Orphan A', status: 'running' },
        { id: 'st_orphan_b', description: 'Orphan B', status: 'pending' },
      ],
    }), { silent: true });
    const virtual = viewer.snapshot.runs.find(isVirtualRun);
    assert.ok(virtual, 'v' + version + ' composes the group');
    assert.deepEqual(virtual.virtual.memberTaskIds, ['st_orphan_a', 'st_orphan_b'],
      'v' + version + ' membership');
    viewer.ui.runIndex = viewer.snapshot.runs.indexOf(virtual);
    viewer.ui.selectedRunId = virtual.id;
    viewer.ui.taskScope = 'run';
    viewer.draw();
    const geometry = taskListLayout(viewer.lastRender.layout.sidebar, viewer.snapshot, viewer.ui);
    assert.ok(geometry);
    assert.deepEqual(geometry.tasks.map(task => task.id), ['st_orphan_a', 'st_orphan_b'],
      'v' + version + ' wide scope');
    assert.equal(geometry.scopeCount, 2, 'v' + version + ' scope count uses full membership');
  }
});

test('a virtual fold attempt never writes a view-side fold key', async () => {
  const virtualKey = JSON.stringify(['orphan:tasks', 'st_orphan_a']);
  const view = { version: 1, sessionId: 'mixed-session-orphan', expanded: { [virtualKey]: false } };
  const saves = [];
  const session = createViewerSession({
    statePath: '/tmp/virtual-orphan-view-state.json',
    loadViewStateFn: async () => view,
    saveViewStateFn: async (_path, next) => { saves.push(next); return next; },
    requestRepaint: () => {},
    draw: () => {},
  });
  session.acceptSnapshot(mixedSessionRaw(), { silent: true });
  await session.syncViewState();
  assert.equal(session.ui.foldedByRun.has('orphan:tasks'), false, 'the stale virtual key is not loaded');

  const virtualIndex = session.snapshot.runs.findIndex(isVirtualRun);
  assert.ok(virtualIndex >= 0);
  session.ui.runIndex = virtualIndex;
  session.ui.selectedRunId = session.snapshot.runs[virtualIndex].id;
  session.ui.selectedNodeId = 'st_orphan_a';
  session.ui.focus = 'graph';
  session.ensureSelection();
  assert.equal(session.ui.folded.size, 0);

  session.foldSelectedNode();
  assert.deepEqual(saves, [], 'folding a virtual node reports no write');
  assert.deepEqual(view.expanded, {}, 'the stale virtual key is purged in memory');

  // A real fold still writes, and the persisted object carries no virtual key.
  session.ui.runIndex = 0;
  session.ui.selectedRunId = 'run_live';
  session.ui.selectedNodeId = 'api';
  session.ui.focus = 'graph';
  session.foldSelectedNode();
  assert.equal(saves.length, 1);
  assert.deepEqual(Object.keys(saves[0].expanded), [JSON.stringify(['run_live', 'api'])]);
  assert.equal(view.expanded[virtualKey], undefined);
});
