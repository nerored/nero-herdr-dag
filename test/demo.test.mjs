import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoEngine } from '../src/demo.mjs';
import { normalizeSnapshot, standaloneTasks } from '../src/model.mjs';

const origin = 1_000_000;
const engine = new DemoEngine({ now: origin, startOffset: 0 });
const at = time => normalizeSnapshot(engine.snapshot(origin + time));
const run = snapshot => snapshot.runs.find(candidate => candidate.id === 'run_integration');
const node = (snapshot, id) => run(snapshot).nodes.find(candidate => candidate.id === id);

test('demo is deterministic for a fixed time and exposes four runs and detailed tasks', () => {
  const first = engine.snapshot(origin + 20_000);
  const second = new DemoEngine({ now: origin, startOffset: 0 }).snapshot(origin + 20_000);
  assert.deepEqual(first, second);
  const snapshot = normalizeSnapshot(first);
  assert.deepEqual(snapshot.runs.map(candidate => candidate.id), [
    'run_integration', 'run_goldbach', 'run_audit', 'run_docs',
  ]);
  assert.equal(run(snapshot).nodes.length, 9);
  assert.ok(snapshot.tasks.length >= 40);
  assert.ok(snapshot.tasks.every(task => !('spawn_spec' in task) && !('output' in task)));
});

test('the Goldbach campaign is a complex failed proof attempt with many subtasks', () => {
  const snapshot = at(20_000);
  const goldbach = snapshot.runs.find(candidate => candidate.id === 'run_goldbach');
  assert.equal(goldbach.name, 'Goldbach proof attempt');
  assert.equal(goldbach.status, 'failed');
  assert.ok(goldbach.nodes.length >= 15);
  assert.ok(goldbach.edges.length >= 16);
  assert.equal(goldbach.nodes.filter(candidate => candidate.state === 'failed').length, 2);
  assert.ok(goldbach.nodes.some(candidate => candidate.state === 'blocked'));
  assert.ok(goldbach.nodes.some(candidate => candidate.state === 'cancelled'));

  const induction = goldbach.nodes.find(candidate => candidate.id === 'gb_induction');
  assert.match(induction.error, /induction/);
  assert.ok(induction.children.length >= 3);
  assert.ok(induction.children.some(child => child.status === 'failed'));

  const goldbachTasks = snapshot.tasks.filter(task => task.id.startsWith('st_gb_'));
  assert.ok(goldbachTasks.length >= 20);
  assert.ok(goldbachTasks.some(task => task.children?.length >= 3));
  assert.ok(goldbachTasks.every(task => task.thinking && task.reply));
  const visible = standaloneTasks(snapshot).filter(task => task.id.startsWith('st_gb_'));
  assert.ok(visible.length >= 5);
  assert.ok(visible.some(task => task.status === 'running' && task.children?.length >= 2));
});

test('the active workflow advances through dependencies over time', () => {
  assert.equal(node(at(2_000), 'intake').state, 'running');
  assert.equal(node(at(10_000), 'intake').state, 'completed');
  assert.equal(node(at(20_000), 'scaffold').state, 'completed');
  assert.equal(node(at(20_000), 'api').state, 'running');
  assert.equal(node(at(20_000), 'tests').state, 'blocked');
  assert.equal(node(at(72_000), 'api').state, 'completed');
  assert.equal(node(at(72_000), 'tests').state, 'running');
  assert.equal(node(at(72_000), 'docs').state, 'blocked');
  assert.equal(node(at(100_000), 'gate').state, 'running');
  assert.equal(node(at(140_000), 'release').state, 'completed');
  assert.equal(run(at(140_000)).status, 'completed');
});

test('the cycle wraps and demo task metrics grow while running', () => {
  const early = normalizeSnapshot(engine.snapshot(origin + 20_000));
  const later = normalizeSnapshot(engine.snapshot(origin + 40_000));
  const before = early.tasks.find(task => task.id === 'st_api');
  const after = later.tasks.find(task => task.id === 'st_api');
  assert.ok(after.percent > before.percent);
  assert.ok(after.tokensIn > before.tokensIn);
  assert.ok(after.toolCalls >= before.toolCalls);
  const wrapped = normalizeSnapshot(engine.snapshot(origin + 165_000));
  assert.equal(node(wrapped, 'intake').state, 'running');
  assert.equal(node(wrapped, 'release').state, 'blocked');
});

test('blocked nodes report no started work or token totals', () => {
  const now = origin;
  const snapshot = normalizeSnapshot(new DemoEngine({ now, startOffset: 32_000 }).snapshot(now));
  const blocked = run(snapshot).nodes.filter(candidate => candidate.state === 'blocked');
  assert.ok(blocked.length >= 1);
  for (const candidate of blocked) {
    const task = snapshot.tasks.find(item => item.id === candidate.taskId);
    assert.ok(task, `missing task for blocked node ${candidate.id}`);
    assert.equal(task.status, 'pending');
    assert.equal(task.turns, 0);
    assert.equal(task.toolCalls, 0);
    assert.equal(task.startedAt, undefined);
    assert.equal(task.tokensIn, undefined);
    assert.equal(task.tokensOut, undefined);
  }
  const running = snapshot.tasks.find(task => task.id === 'st_api');
  assert.ok(running.turns >= 1);
  assert.ok(running.tokensIn > 0);
  assert.ok(running.startedAt);
});

test('static runs show completed and failed evidence and child tasks', () => {
  const snapshot = at(20_000);
  const docs = snapshot.runs.find(candidate => candidate.id === 'run_docs');
  assert.equal(docs.status, 'completed');
  assert.ok(docs.nodes.every(candidate => candidate.state === 'completed'));
  const audit = snapshot.runs.find(candidate => candidate.id === 'run_audit');
  assert.equal(audit.status, 'failed');
  assert.ok(audit.nodes.some(candidate => candidate.state === 'failed' && candidate.error));
  const api = snapshot.tasks.find(task => task.id === 'st_api');
  assert.ok(api.children.length >= 1);
  assert.ok(api.children.some(child => child.id === 'st_api_lint'));
});

test('the active run completes exactly when its last node completes', () => {
  for (const phase of [0, 20_000, 97_999, 98_000, 118_000, 137_999, 138_000, 159_999]) {
    const integration = run(at(phase));
    const allCompleted = integration.nodes.every(candidate => candidate.state === 'completed');
    assert.equal(integration.status, allCompleted ? 'completed' : 'running', `phase ${phase}`);
  }
  assert.equal(run(at(137_999)).status, 'running');
  assert.equal(run(at(138_000)).status, 'completed');
});

test('blocked Goldbach tasks do not carry work they never did', () => {
  const snapshot = at(20_000);
  const blocked = snapshot.tasks.filter(task => task.id.startsWith('st_gb_') && task.status === 'blocked');
  assert.ok(blocked.length >= 3);
  for (const task of blocked) {
    assert.equal(task.percent, 0, `${task.id} percent`);
    assert.equal(task.turns, 0, `${task.id} turns`);
    assert.equal(task.toolCalls, 0, `${task.id} tool calls`);
    assert.equal(task.startedAt, undefined, `${task.id} startedAt`);
    assert.equal(task.tokensIn, undefined, `${task.id} tokensIn`);
    assert.equal(task.tokensOut, undefined, `${task.id} tokensOut`);
    assert.ok(task.logs?.length, `${task.id} keeps its waiting log`);
  }
  const failed = snapshot.tasks.find(task => task.id === 'st_gb_induction');
  assert.ok(failed.tokensIn > 0);
  assert.ok(failed.startedAt);
});

test('static run nodes report a positive attempt count', () => {
  const raw = engine.snapshot(origin + 20_000);
  const staticRuns = raw.runs.filter(candidate => candidate.id !== 'run_integration');
  assert.equal(staticRuns.length, 3);
  for (const candidate of staticRuns) {
    for (const item of candidate.nodes) {
      assert.ok(Number.isInteger(item.attempt) && item.attempt >= 1,
        `${candidate.id}/${item.id} attempt ${item.attempt}`);
    }
  }
  const goldbach = at(20_000).runs.find(candidate => candidate.id === 'run_goldbach');
  assert.equal(goldbach.nodes.find(candidate => candidate.id === 'gb_spec').attempt, 1);
  assert.equal(goldbach.nodes.find(candidate => candidate.id === 'gb_analytic').attempt, 2);
  assert.ok(goldbach.nodes.every(candidate => candidate.attempt >= 1));
});

test('Goldbach task timestamps respect their dependency edges', () => {
  const snapshot = at(20_000);
  const goldbach = snapshot.runs.find(candidate => candidate.id === 'run_goldbach');
  const nodeById = new Map(goldbach.nodes.map(candidate => [candidate.id, candidate]));
  const taskById = new Map(snapshot.tasks.map(task => [task.id, task]));
  const violations = [];
  for (const edge of goldbach.edges) {
    const dependency = taskById.get(nodeById.get(edge.from)?.taskId);
    const dependent = taskById.get(nodeById.get(edge.to)?.taskId);
    const finished = Date.parse(dependency?.completedAt);
    const started = Date.parse(dependent?.startedAt);
    if (Number.isFinite(finished) && Number.isFinite(started) && started < finished) {
      violations.push(`${edge.from}->${edge.to}`);
    }
  }
  assert.deepEqual(violations, []);
  assert.equal(taskById.get('st_gb_sieve').startedAt, taskById.get('st_gb_spec').completedAt);
  assert.equal(taskById.get('st_gb_small').startedAt, taskById.get('st_gb_spec').completedAt);
  assert.ok(Date.parse(taskById.get('st_gb_induction').startedAt) >= Date.parse(taskById.get('st_gb_analytic').completedAt));
  assert.equal(taskById.get('st_gb_induction').startedAt, taskById.get('st_gb_adversary').completedAt);
});
