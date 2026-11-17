import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRun, normalizeSnapshot } from '../src/model.mjs';
import {
  ORPHAN_RUN_ID, buildOrphanRun, isVirtualRun, withOrphanRun,
} from '../src/orphan-run.mjs';

const live = (fields = {}) => normalizeSnapshot({
  version: 3,
  mode: 'live',
  connected: true,
  sessionId: 'orphan-run-task-1',
  runs: [],
  tasks: [],
  ...fields,
});

const linkedRun = (id = 'run_real') => ({
  id,
  name: 'Real run',
  status: 'running',
  createdAt: '2026-11-16T11:59:00.000Z',
  nodes: [{ id: 'node_linked', state: 'running', task_id: 'st_linked' }],
  edges: [],
});

const mixed = () => live({
  runs: [linkedRun()],
  tasks: [
    { id: 'st_linked', description: 'linked root', status: 'running' },
    { id: 'st_child', parentTaskId: 'st_linked', description: 'linked child', status: 'running' },
    { id: 'st_orphan_b', description: 'Beta orphan', status: 'pending' },
    {
      id: 'st_orphan_a', description: 'Alpha orphan', status: 'running', percent: 40,
      agent: 'codex', model: 'deepseek-v4', tokens_in: 5, tokens_out: 7,
      turns: 2, tool_calls: 3, retries: 1, reply: 'finished evidence',
    },
  ],
});

test('no visible orphan members returns the input snapshot and builds no run', () => {
  const snapshot = live({
    runs: [linkedRun()],
    tasks: [
      { id: 'st_linked', description: 'linked root', status: 'running' },
      { id: 'st_child', parentTaskId: 'st_linked', description: 'linked child', status: 'running' },
    ],
  });
  assert.equal(buildOrphanRun(snapshot), undefined);
  assert.equal(withOrphanRun(snapshot), snapshot);
  assert.equal(snapshot.runs.length, 1);
  assert.equal(isVirtualRun(snapshot.runs[0]), false);

  const empty = live();
  assert.equal(withOrphanRun(empty), empty);
  assert.equal(buildOrphanRun(empty), undefined);
  assert.equal(isVirtualRun(null), false);
});

test('mixed membership appends one flat virtual run with full member order', () => {
  const snapshot = mixed();
  const projected = withOrphanRun(snapshot);
  assert.notEqual(projected, snapshot);
  assert.equal(projected.runs.length, 2);
  assert.equal(projected.runs[0], snapshot.runs[0], 'real runs keep their identity and order');

  const virtual = projected.runs[1];
  assert.equal(virtual.id, ORPHAN_RUN_ID);
  assert.equal(isVirtualRun(virtual), true);
  assert.equal(virtual.virtual.kind, 'orphans');
  assert.equal(virtual.virtual.count, 2);
  assert.deepEqual(virtual.virtual.memberTaskIds, ['st_orphan_a', 'st_orphan_b']);
  assert.equal(virtual.virtual.members[0], snapshot.tasks.find(task => task.id === 'st_orphan_a'));
  assert.ok(Object.isFrozen(virtual.virtual.members));
  assert.deepEqual(virtual.edges, []);
  assert.equal(virtual.virtual.omittedNodes, 0);
  assert.equal(virtual.virtual.stats.total, 2);
  assert.equal(virtual.virtual.stats.counts.running, 1);
  assert.equal(virtual.virtual.stats.counts.pending, 1);
  assert.equal(virtual.virtual.stats.percentKnown, false);
  assert.equal(virtual.status, 'running');
  assert.equal(virtual.nodes.length, 2);
  assert.deepEqual(virtual.nodes.map(node => node.id), ['st_orphan_a', 'st_orphan_b']);

  const [alpha, beta] = virtual.nodes;
  assert.equal(alpha.label, 'Alpha orphan');
  assert.equal(alpha.state, 'running');
  assert.equal(alpha.taskId, 'st_orphan_a');
  assert.equal(alpha.task.id, 'st_orphan_a');
  assert.equal(alpha.percent, 40);
  assert.equal(alpha.tokensIn, 5);
  assert.equal(alpha.tokensOut, 7);
  assert.equal(alpha.turns, 2);
  assert.equal(alpha.toolCalls, 3);
  assert.equal(alpha.retries, 1);
  assert.equal(alpha.provenance.state.kind, 'derived');
  assert.equal(alpha.provenance.state.from, 'task.status');
  assert.equal(alpha.provenance.percent.kind, 'derived');
  assert.equal(alpha.provenance.percent.from, 'task.percent');
  assert.equal(alpha.provenance.agent.kind, 'derived');
  assert.equal(alpha.provenance.agent.from, 'task.agent');
  assert.equal(alpha.provenance.model.from, 'task.model');
  assert.equal(alpha.provenance.retries.from, 'task.retries');
  assert.equal(alpha.provenance.reply.from, 'task.reply');

  assert.equal(beta.label, 'Beta orphan');
  assert.equal(beta.percent, undefined);
  assert.equal(beta.provenance.state.kind, 'derived');
  assert.equal(beta.provenance.percent.kind, 'unknown');
});

test('one orphan and canonical running/description/id order', () => {
  const single = withOrphanRun(live({ tasks: [{ id: 'st_only', description: 'Only orphan', status: 'pending' }] }));
  assert.equal(single.runs.length, 1);
  assert.equal(single.runs[0].virtual.count, 1);
  assert.deepEqual(single.runs[0].virtual.memberTaskIds, ['st_only']);

  const ordered = withOrphanRun(live({
    tasks: [
      { id: 'st_zulu', description: 'Zulu', status: 'pending' },
      { id: 'st_alpha', description: 'alpha', status: 'pending' },
      { id: 'st_running', description: 'running task', status: 'running' },
    ],
  }));
  assert.deepEqual(ordered.runs[0].virtual.memberTaskIds, ['st_running', 'st_alpha', 'st_zulu']);
  assert.deepEqual(ordered.runs[0].nodes.map(node => node.id), ['st_running', 'st_alpha', 'st_zulu']);
});

test('unknown task status is retained as a virtual node while normalizeRun drops it', () => {
  const snapshot = live({
    tasks: [
      { id: 'st_unknown', description: 'Mystery', status: 'mystery' },
      { id: 'st_pending', description: 'Pending', status: 'pending' },
    ],
  });
  assert.equal(snapshot.tasks[0].status, 'unknown');
  const virtual = withOrphanRun(snapshot).runs[0];
  const unknown = virtual.nodes.find(node => node.id === 'st_unknown');
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.provenance.state.kind, 'derived');
  assert.equal(unknown.provenance.state.from, 'task.status');
  assert.equal(unknown.provenance.percent.kind, 'unknown');
  assert.equal(unknown.percent, undefined);
  assert.equal(virtual.virtual.stats.counts.unknown, 1);
  assert.equal(virtual.virtual.stats.total, 2);
  assert.equal(virtual.status, 'pending');

  const dropped = normalizeRun({
    id: 'run_drop', status: 'running',
    nodes: [{ id: 'node_unknown', state: 'unknown' }], edges: [],
  });
  assert.equal(dropped.nodes.length, 0);
  assert.ok(dropped.warnings.some(warning => warning.reason === 'unknown-state'));
});

test('virtual stats use every member and the same triage buckets as runStats', () => {
  const statuses = [
    'completed', 'failed', 'error', 'paused', 'blocked', 'running',
    'pending', 'skipped', 'cancelled', 'interrupted', 'lost',
  ];
  const virtual = withOrphanRun(live({
    tasks: statuses.map(status => ({ id: `st_${status}`, description: `Task ${status}`, status })),
  })).runs[0];
  const stats = virtual.virtual.stats;
  assert.equal(stats.total, 11);
  assert.equal(stats.done, 1);
  assert.equal(stats.finished, 7);
  assert.equal(stats.counts.failed, 3, 'failed/error/lost are one triage bucket');
  assert.equal(stats.counts.blocked, 2, 'blocked/paused are one triage bucket');
  assert.equal(stats.counts.running, 1);
  assert.equal(stats.percentKnown, false);
  assert.equal(virtual.status, 'failed');
});

test('1200, 4096 and 5000 members keep full membership while display nodes cap at 4096', () => {
  const snapshotFor = count => live({
    tasks: Array.from({ length: count }, (_, index) => {
      const id = `st_${String(index).padStart(5, '0')}`;
      return { id, description: `Task ${id}`, status: 'pending', percent: 25 };
    }),
  });
  for (const count of [1200, 4096, 5000]) {
    const virtual = withOrphanRun(snapshotFor(count)).runs[0];
    const displayed = Math.min(count, 4096);
    assert.equal(virtual.virtual.count, count);
    assert.equal(virtual.virtual.memberTaskIds.length, count);
    assert.equal(virtual.virtual.members.length, count);
    assert.equal(virtual.nodes.length, displayed);
    assert.equal(virtual.virtual.omittedNodes, Math.max(0, count - displayed));
    assert.equal(virtual.virtual.stats.total, count);
    assert.equal(virtual.virtual.stats.percent, 25);
    assert.equal(virtual.virtual.stats.percentKnown, true);
    assert.equal(virtual.virtual.stats.counts.pending, count);
    assert.equal(virtual.nodes[0].id, 'st_00000');
    assert.equal(virtual.nodes.at(-1).id, `st_${String(displayed - 1).padStart(5, '0')}`);
  }
});

test('a real orphan:tasks id forces a deterministic collision suffix', () => {
  const realRun = id => ({ id, name: `real ${id}`, status: 'pending', nodes: [], edges: [] });
  const task = { id: 'st_orphan', description: 'Orphan', status: 'pending' };

  const one = withOrphanRun(live({ runs: [realRun(ORPHAN_RUN_ID)], tasks: [task] }));
  assert.equal(one.runs.at(-1).id, `${ORPHAN_RUN_ID}#2`);

  const two = withOrphanRun(live({
    runs: [realRun(ORPHAN_RUN_ID), realRun(`${ORPHAN_RUN_ID}#2`)],
    tasks: [task],
  }));
  assert.equal(two.runs.at(-1).id, `${ORPHAN_RUN_ID}#3`);
});

test('the projection is memoized and idempotent, including a prior virtual run', () => {
  const snapshot = mixed();
  const once = withOrphanRun(snapshot);
  assert.equal(withOrphanRun(snapshot), once);
  assert.equal(withOrphanRun(once), once);
  assert.equal(once.runs.filter(isVirtualRun).length, 1);
  assert.equal(once.runs.at(-1), once.runs.find(isVirtualRun));

  const clone = structuredClone(once);
  const rebuilt = withOrphanRun(clone);
  assert.equal(rebuilt.runs.filter(isVirtualRun).length, 1);
  assert.equal(rebuilt.runs.at(-1).virtual.count, 2);
  assert.deepEqual(rebuilt.runs.at(-1).virtual.memberTaskIds, ['st_orphan_a', 'st_orphan_b']);

  const direct = buildOrphanRun(once);
  assert.equal(direct.virtual.count, 2, 'a virtual node is never producer ownership');
  assert.equal(direct.id, ORPHAN_RUN_ID);
});

test('projection does not mutate the input snapshot or its real runs', () => {
  const snapshot = mixed();
  const before = structuredClone(snapshot);
  const projected = withOrphanRun(snapshot);
  assert.deepEqual(snapshot, before);
  assert.equal(snapshot.runs.length, 1);
  assert.equal(projected.runs[0], snapshot.runs[0]);
  assert.notEqual(projected.runs, snapshot.runs);
  assert.equal(snapshot.runs.some(isVirtualRun), false);
});

test('membership is recomputed for a new snapshot instead of reusing stale state', () => {
  const first = live({ tasks: [{ id: 'st_moving', description: 'Moving task', status: 'pending' }] });
  const firstProjection = withOrphanRun(first);
  assert.equal(firstProjection.runs[0].virtual.count, 1);

  const second = live({
    runs: [{
      id: 'run_now_linked', name: 'Now linked', status: 'running',
      nodes: [{ id: 'node_now_linked', state: 'running', task_id: 'st_moving' }], edges: [],
    }],
    tasks: [{ id: 'st_moving', description: 'Moving task', status: 'pending' }],
  });
  assert.equal(withOrphanRun(second), second);
  assert.equal(firstProjection.runs[0].virtual.count, 1, 'the earlier snapshot keeps its own projection');
});
