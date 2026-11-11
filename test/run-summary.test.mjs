import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSummary } from '../src/run-summary.mjs';

const T0 = Date.parse('2026-11-11T12:00:00.000Z');
const at = ms => new Date(ms).toISOString();
const node = (id, overrides = {}) => ({
  id,
  label: overrides.label ?? id,
  state: 'completed',
  ...overrides,
});
const run = (nodes, overrides = {}) => ({
  id: 'run',
  createdAt: at(T0),
  updatedAt: at(T0 + 10_000),
  status: 'running',
  nodes,
  edges: [],
  ...overrides,
});

test('an empty run has no fabricated metrics', () => {
  assert.deepEqual(runSummary({ nodes: [] }), { nodes: 0 });
  assert.deepEqual(runSummary({}), { nodes: 0 });
});

test('node evidence sums into run totals', () => {
  const summary = runSummary(run([
    node('a', {
      label: 'build-api',
      startedAt: at(T0 + 1_000),
      completedAt: at(T0 + 3_000),
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.01,
      costStatus: 'reported',
      cacheReadTokens: 100,
      totalTokens: 200,
      retries: 1,
      retriesKind: 'recorded',
      turns: 2,
      toolCalls: 3,
    }),
    node('b', {
      label: 'build-ui',
      startedAt: at(T0 + 2_000),
      completedAt: at(T0 + 5_000),
      tokensIn: 200,
      tokensOut: 100,
      costUsd: 0.02,
      costStatus: 'reported',
      cacheReadTokens: 300,
      totalTokens: 400,
      retries: 3,
      retriesKind: 'recorded',
      turns: 4,
      toolCalls: 5,
    }),
  ], { edges: [{ from: 'a', to: 'b' }] }));

  assert.deepEqual(summary.tokens, { in: 300, out: 150, seen: 2, total: 2 });
  assert.equal(Math.round(summary.cost.usd * 1000) / 1000, 0.03);
  assert.equal(summary.cost.seen, 2);
  assert.equal(summary.cost.lowerBound, false);
  assert.deepEqual(summary.cache, { read: 400, tokens: 600, hitRate: 400 / 600, seen: 2, total: 2 });
  assert.deepEqual(summary.retries, { value: 4, seen: 2, total: 2, derived: false });
  assert.deepEqual(summary.turns, { value: 6, seen: 2, total: 2 });
  assert.deepEqual(summary.tools, { value: 8, seen: 2, total: 2 });

  assert.equal(summary.wallMs, 5_000);
  assert.equal(summary.busyMs, 4_000);
  assert.equal(summary.parallel.max, 2);
  assert.ok(Math.abs(summary.parallel.avg - 5_000 / 5_000) < 1e-9);
  assert.deepEqual(summary.timed, { seen: 2, total: 2 });

  assert.deepEqual(summary.critical.labels, ['build-api', 'build-ui']);
  assert.equal(summary.critical.ms, 5_000);
  assert.equal(summary.critical.partial, false);
});

test('partial evidence is marked instead of silently summed', () => {
  const summary = runSummary(run([
    node('a', {
      startedAt: at(T0 + 1_000),
      completedAt: at(T0 + 2_000),
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.01,
      costStatus: 'reported',
      cacheReadTokens: 100,
      totalTokens: 200,
      retries: 0,
      retriesKind: 'derived',
      turns: 1,
    }),
    node('b', {
      startedAt: at(T0 + 1_500),
      completedAt: at(T0 + 3_000),
      costUsd: 0.02,
      costStatus: 'estimated',
      cacheReadTokens: 300,
      turns: 2,
      toolCalls: 4,
    }),
  ]));

  assert.equal(summary.tokens.seen, 1);
  assert.equal(summary.tokens.total, 2);
  assert.equal(summary.cost.seen, 1);
  assert.equal(summary.cost.lowerBound, true);
  assert.equal(summary.cache.seen, 1);
  assert.equal(summary.retries.derived, true);
  assert.equal(summary.turns.seen, 2);
  assert.equal(summary.tools.seen, 1);
});

test('cache hit rate is token-weighted, not an average of rates', () => {
  const summary = runSummary(run([
    node('a', { cacheReadTokens: 100, totalTokens: 200 }),
    node('b', { cacheReadTokens: 300, totalTokens: 400 }),
  ]));
  assert.ok(Math.abs(summary.cache.hitRate - 400 / 600) < 1e-9);
  assert.notEqual(summary.cache.hitRate, (0.5 + 0.75) / 2);
});

test('a running node ends at the supplied clock; saved runs pass the capture time', () => {
  const nodes = [node('a', {
    state: 'running',
    startedAt: at(T0 + 1_000),
    tokensIn: 1,
    tokensOut: 1,
  })];
  const live = runSummary(run(nodes), { now: T0 + 4_000 });
  assert.equal(live.wallMs, 4_000);
  assert.equal(live.busyMs, 3_000);
  assert.equal(live.critical.ms, 3_000);

  const captured = runSummary(run(nodes), { now: T0 + 2_500 });
  assert.equal(captured.wallMs, 2_500);
  assert.equal(captured.busyMs, 1_500);
});

test('a terminal node without an end time contributes no duration', () => {
  const summary = runSummary(run([
    node('a', { state: 'failed', startedAt: at(T0 + 1_000) }),
    node('b', { startedAt: at(T0 + 1_000), completedAt: at(T0 + 2_000) }),
  ], { edges: [{ from: 'a', to: 'b' }] }));
  assert.deepEqual(summary.timed, { seen: 1, total: 2 });
  assert.equal(summary.critical.partial, true);
});

test('parallel overlap ignores intervals that merely touch', () => {
  const summary = runSummary(run([
    node('a', { startedAt: at(T0), completedAt: at(T0 + 1_000) }),
    node('b', { startedAt: at(T0 + 1_000), completedAt: at(T0 + 2_000) }),
  ]));
  assert.equal(summary.parallel.max, 1);
  assert.equal(summary.busyMs, 2_000);
});

test('the critical path follows the DAG and prefers fewer nodes on a tie', () => {
  const chain = runSummary(run([
    node('a', { startedAt: at(T0), completedAt: at(T0 + 1_000) }),
    node('b', { startedAt: at(T0 + 1_000), completedAt: at(T0 + 2_000) }),
    node('c', { startedAt: at(T0), completedAt: at(T0 + 2_000) }),
  ], { edges: [{ from: 'a', to: 'b' }] }));
  assert.equal(chain.critical.ms, 2_000);
  // The isolated node reaches the same total with one node instead of two.
  assert.deepEqual(chain.critical.nodeIds, ['c']);
});

test('a cyclic run reports no critical path instead of inventing one', () => {
  const summary = runSummary(run([
    node('a', { startedAt: at(T0), completedAt: at(T0 + 1_000) }),
    node('b', { startedAt: at(T0), completedAt: at(T0 + 1_000) }),
  ], { edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }));
  assert.equal(summary.critical, undefined);
  assert.equal(summary.criticalCycle, true);
  assert.equal(summary.parallel.max, 2);
});

test('wall time falls back to the run update when nodes carry no timestamps', () => {
  const summary = runSummary(run([node('a'), node('b')], { updatedAt: at(T0 + 5_000) }));
  assert.equal(summary.wallMs, 5_000);
  assert.deepEqual(summary.timed, { seen: 0, total: 2 });
  assert.equal(summary.parallel, undefined);
  assert.equal(summary.critical, undefined);
});

test('cost rows require reported values', () => {
  const summary = runSummary(run([
    node('a', { costUsd: 0.5, costStatus: 'estimated' }),
    node('b', { costUsd: 0.25 }),
  ]));
  assert.equal(summary.cost.usd, 0.25);
  assert.equal(summary.cost.seen, 1);
  assert.equal(summary.cost.lowerBound, true);
});

test('token rows require a complete in/out pair', () => {
  const summary = runSummary(run([
    node('a', { tokensIn: 10 }),
    node('b', { tokensOut: 5 }),
  ]));
  assert.equal(summary.tokens, undefined);
});
