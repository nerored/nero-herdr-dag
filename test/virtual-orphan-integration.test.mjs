import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot } from '../src/model.mjs';
import { taskListLayout } from '../src/render.mjs';
import { boundSnapshotInput } from '../src/viewer-snapshot.mjs';
import { createTestViewer } from './helpers.mjs';

// Todo 6 integration matrix. The narrower behavior tests live beside the
// modules they cover (orphan-run, narrow-orphan-tasks, viewer-surface); this
// file keeps the cross-surface invariants that need a real viewer session:
// producer indexes, cap arithmetic, the raw cap, and the --once/--pane payload.

const viewerFor = async ({ width = 120, height = 40, extra = {} } = {}) => {
  const { viewer } = await createTestViewer({
    args: { once: true, width, height, noColor: true, noMotion: true, fps: 10, ...extra },
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

const mixedSnapshot = (orphans = 3) => normalizeSnapshot({
  version: 3,
  mode: 'live',
  connected: true,
  sessionId: 't6-mixed',
  updatedAt: '2026-11-16T12:00:00.000Z',
  runs: [
    {
      id: 'run_one', name: 'first real run', status: 'running',
      nodes: [{ id: 'one-node', state: 'running', task_id: 'st_one' }], edges: [],
    },
    {
      id: 'run_two', name: 'second real run', status: 'completed',
      nodes: [{ id: 'two-node', state: 'completed', task_id: 'st_two' }], edges: [],
    },
  ],
  tasks: [
    { id: 'st_one', description: 'First linked', status: 'running' },
    { id: 'st_two', description: 'Second linked', status: 'completed', percent: 100 },
    ...Array.from({ length: orphans }, (_, index) => ({
      id: `st_orphan_${index}`,
      description: `Orphan ${index}`,
      status: index === 0 ? 'unknown' : 'pending',
    })),
  ],
});

const live = ({ sessionId, runs = [], tasks = [] }) => ({
  version: 3, mode: 'live', connected: true, sessionId,
  updatedAt: '2026-11-16T12:00:00.000Z', runs, tasks,
});

test('mixed real+orphan session keeps real run identities/indexes and appends virtual last', async () => {
  const viewer = await viewerFor();
  const raw = mixedSnapshot(3);
  viewer.acceptSnapshot(raw, { silent: true });

  assert.equal(viewer.fullSnapshot.runs.length, 2, 'raw snapshot keeps only producer runs');
  assert.equal(viewer.fullSnapshot.runs.some(run => run.virtual), false);
  assert.equal(viewer.snapshot.runs.length, 3);
  assert.equal(viewer.snapshot.runs[0], viewer.fullSnapshot.runs[0], 'real run objects are reused in place');
  assert.equal(viewer.snapshot.runs[1], viewer.fullSnapshot.runs[1]);
  assert.deepEqual(viewer.snapshot.runs.slice(0, 2).map(run => run.id), ['run_one', 'run_two']);
  const virtual = viewer.snapshot.runs.at(-1);
  assert.equal(virtual.id, 'orphan:tasks');
  assert.equal(virtual.virtual.count, 3);
  assert.equal(viewer.snapshot.runs.filter(run => run.virtual).length, 1);

  // Real indexes stay 0/1; the group is only reachable last.
  viewer.ui.runIndex = 1;
  viewer.ui.selectedRunId = 'run_two';
  viewer.ensureSelection();
  assert.equal(viewer.ui.selectedRunId, 'run_two');
  assert.equal(viewer.snapshot.runs.indexOf(virtual), 2);

  viewer.ui.completedCollapsed = false;
  viewer.draw();
  const realGeometry = taskListLayout(viewer.lastRender.layout.sidebar, viewer.snapshot, viewer.ui);
  assert.equal(realGeometry.scopeCount, 1, 'a real run keeps its own linked scope');
  assert.deepEqual(realGeometry.tasks.map(task => task.id), ['st_two']);

  // The wide TASKS scope of the virtual run is its full membership, and its
  // unknown member survives normalization as a derived display node.
  viewer.ui.runIndex = 2;
  viewer.ui.selectedRunId = virtual.id;
  viewer.ui.focus = 'tasks';
  viewer.ui.taskScope = 'run';
  viewer.draw();
  const geometry = taskListLayout(viewer.lastRender.layout.sidebar, viewer.snapshot, viewer.ui);
  assert.equal(geometry.scope, 'unattached');
  assert.equal(geometry.scopeCount, 3);
  assert.deepEqual(geometry.tasks.map(task => task.id), [
    'st_orphan_0', 'st_orphan_1', 'st_orphan_2',
  ]);
  assert.equal(geometry.tasks.find(task => task.id === 'st_orphan_0').id, virtual.nodes[0].id);
  assert.equal(virtual.nodes[0].state, 'unknown');
  assert.equal(virtual.nodes[0].provenance.state.kind, 'derived');
  assert.equal(virtual.edges.length, 0);
  assert.ok(viewer.lastRender.hitboxes.nodes.size > 0);
  assert.match(viewer.lastRender.text, /UNATTACHED/);
});

test('1200/4096/5000 caps agree across membership, stats, TASKS scope and layout hiding', async () => {
  for (const count of [1200, 4096, 5000]) {
    const viewer = await viewerFor();
    viewer.acceptSnapshot(live({
      sessionId: `t6-cap-${count}`,
      tasks: Array.from({ length: count }, (_, index) => ({
        id: `st_${String(index).padStart(5, '0')}`,
        description: `Cap task ${index}`,
        status: index === 0 ? 'unknown' : 'pending',
      })),
    }), { silent: true });
    viewer.draw();

    const frame = viewer.lastRender;
    const virtual = viewer.snapshot.runs.at(-1);
    const displayed = Math.min(count, 4096);
    const omitted = Math.max(0, count - displayed);
    assert.equal(viewer.fullSnapshot.runs.length, 0, 'the raw snapshot has no group');
    assert.equal(virtual.virtual.count, count);
    assert.equal(virtual.virtual.memberTaskIds.length, count);
    assert.equal(virtual.virtual.members.length, count);
    assert.equal(virtual.virtual.stats.total, count);
    assert.equal(virtual.nodes.length, displayed);
    assert.equal(virtual.virtual.omittedNodes, omitted);
    assert.equal(virtual.edges.length, 0);
    assert.equal(virtual.nodes[0].state, 'unknown');

    const geometry = taskListLayout(frame.layout.sidebar, viewer.snapshot, viewer.ui);
    assert.ok(geometry, `TASKS geometry exists at ${count}`);
    assert.equal(geometry.scope, 'unattached');
    assert.equal(geometry.scopeCount, count, `TASKS scope count is the full membership at ${count}`);
    assert.equal(geometry.tasks.length, count, `TASKS rows keep every member at ${count}`);

    // The two caps describe different sets and must add back to the full
    // membership: layout-hidden display nodes + painted display nodes + nodes
    // omitted by the projection cap = count.
    const hidden = frame.graph.layout.hiddenNodes;
    const paintedDisplayNodes = virtual.nodes.length - hidden;
    assert.ok(paintedDisplayNodes > 0);
    assert.equal(omitted + hidden + paintedDisplayNodes, count,
      `omitted ${omitted} + hidden ${hidden} + painted ${paintedDisplayNodes} = ${count}`);
    if (omitted) assert.match(frame.text, new RegExp(`o${omitted}`));
    assert.match(frame.text, new RegExp(`h${hidden}`));
  }

  // The narrow duty surface reports the same projection cap literally.
  const narrow = await viewerFor({ width: 70, height: 24 });
  narrow.acceptSnapshot(live({
    sessionId: 't6-cap-narrow',
    tasks: Array.from({ length: 5000 }, (_, index) => ({
      id: `st_${String(index).padStart(5, '0')}`,
      description: `Cap task ${index}`,
      status: 'pending',
    })),
  }), { silent: true });
  narrow.draw();
  const narrowVirtual = narrow.snapshot.runs.at(-1);
  assert.equal(narrowVirtual.virtual.count, 5000);
  assert.equal(narrowVirtual.virtual.memberTaskIds.length, 5000);
  assert.equal(narrowVirtual.virtual.stats.total, 5000);
  assert.equal(narrowVirtual.virtual.omittedNodes, 904);
  assert.match(narrow.lastRender.text, /o904/);
  assert.match(narrow.lastRender.text, /TASKS/);
});

test('256 real runs plus orphans stay within the raw snapshot cap and render one group', async () => {
  const runs = Array.from({ length: 256 }, (_, index) => ({
    id: `run_${index}`,
    name: `Run ${index}`,
    status: 'pending',
    nodes: [{ id: `node_${index}`, state: 'pending', task_id: `st_${index}` }],
    edges: [],
  }));
  const tasks = Array.from({ length: 256 }, (_, index) => ({
    id: `st_${index}`, description: `Task ${index}`, status: 'pending',
  }));
  tasks.push(
    { id: 'st_orphan_a', description: 'Orphan A', status: 'running' },
    { id: 'st_orphan_b', description: 'Orphan B', status: 'pending' },
  );

  // The raw cap accepts exactly SNAPSHOT_LIMITS.runs real runs; the view-only
  // group is appended after the bound and never counts against it.
  const bounded = boundSnapshotInput(live({ sessionId: 't6-256-runs', runs, tasks }));
  const viewer = await viewerFor();
  assert.equal(viewer.acceptSnapshot(bounded, { silent: true }), true);
  assert.equal(viewer.fullSnapshot.runs.length, 256);
  assert.equal(viewer.fullSnapshot.runs.some(run => run.virtual), false);
  assert.equal(viewer.snapshot.runs.length, 257);
  const virtual = viewer.snapshot.runs.at(-1);
  assert.equal(virtual.virtual.count, 2);
  assert.deepEqual(virtual.virtual.memberTaskIds, ['st_orphan_a', 'st_orphan_b']);

  viewer.ui.runIndex = viewer.snapshot.runs.length - 1;
  viewer.ui.selectedRunId = virtual.id;
  viewer.draw();
  assert.match(viewer.lastRender.text, /UNATTACHED/);
  assert.match(viewer.lastRender.text, /TASKS/);
  assert.equal(viewer.lastRender.run.id, 'orphan:tasks');
  assert.ok(viewer.lastRender.hitboxes.runs.has('run_0'), 'the first real run is still painted above the group');
});

test('--once and --pane expose the same visible snapshot payload and virtual frame', async () => {
  for (const [width, height] of [[120, 40], [70, 24]]) {
    const plain = await viewerFor({ width, height });
    const pane = await viewerFor({ width, height, extra: { pane: true } });
    for (const viewer of [plain, pane]) {
      viewer.acceptSnapshot(mixedSnapshot(2), { silent: true });
      assert.equal(viewer.options.paneMode, viewer === pane);
      assert.deepEqual(viewer.snapshot.runs.map(run => run.id), [
        'run_one', 'run_two', 'orphan:tasks',
      ]);
      assert.equal(viewer.snapshot.runs.at(-1).virtual.count, 2);
      assert.equal(viewer.fullSnapshot.runs.some(run => run.virtual), false);

      viewer.ui.runIndex = viewer.snapshot.runs.length - 1;
      viewer.ui.selectedRunId = viewer.snapshot.runs.at(-1).id;
      viewer.draw();
      assert.equal(viewer.lastRender.run.id, 'orphan:tasks',
        `the ${viewer === pane ? '--pane' : '--once'} frame paints the visible group at ${width}x${height}`);
      assert.match(viewer.lastRender.text, /UNATTACHED|TASKS/);
    }
    assert.deepEqual(
      plain.snapshot.runs.map(run => run.id),
      pane.snapshot.runs.map(run => run.id),
      '--pane needs no virtual-specific branch',
    );
  }
});
