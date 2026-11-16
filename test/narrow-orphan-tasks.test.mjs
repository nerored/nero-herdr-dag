import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot } from '../src/model.mjs';
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
    assert.equal(first.run, undefined, 'an empty run list never fabricates a run');
    assert.equal(first.hitboxes.nodes.size, 0, 'no synthetic node is painted');
    assert.equal(viewer.ui.selectedRunId, undefined);
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
    assert.equal(viewer.lastRender.run, undefined);
    assert.equal(viewer.lastRender.hitboxes.nodes.size, 0);

    press(viewer, '\x1b[B', 'down');
    assert.equal(viewer.ui.selectedTaskId, 'st_zeta', 'completed orphan rows follow running rows');
    viewer.draw();
    assert.match(viewer.lastRender.text, /Zeta finished/);

    press(viewer, '\x1b[A', 'up');
    assert.equal(viewer.ui.selectedTaskId, 'st_beta', 'up moves back through the painted list');
  }
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
