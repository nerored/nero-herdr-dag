import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAPH_FILTERS, criticalNodeIds, filterCounts, focusSubgraph, nextNodeId, nodeMatchesFilter, nodeState,
} from '../src/cockpit.mjs';

const node = (id, state, overrides = {}) => ({ id, label: id, state, ...overrides });
const run = {
  id: 'run',
  nodes: [
    node('a', 'completed'),
    node('b', 'failed'),
    node('c', 'blocked'),
    node('d', 'running'),
    node('e', 'pending'),
    node('f', 'completed', { status: 'failed' }),
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'a', to: 'd' },
    { from: 'd', to: 'e' },
  ],
};

test('node state falls back between state and status', () => {
  assert.equal(nodeState({ state: 'running' }), 'running');
  assert.equal(nodeState({ status: 'failed' }), 'failed');
  assert.equal(nodeState(undefined), undefined);
});

test('filters cover failed, blocked, running, and critical nodes', () => {
  const summary = { critical: { nodeIds: ['a', 'b', 'c'] } };
  assert.deepEqual(GRAPH_FILTERS, ['all', 'failed', 'blocked', 'running', 'critical']);
  assert.deepEqual(filterCounts(run.nodes, summary), {
    all: 6, failed: 2, blocked: 1, running: 1, critical: 3,
  });
  assert.equal(nodeMatchesFilter(run.nodes[1], 'failed'), true);
  assert.equal(nodeMatchesFilter(run.nodes[5], 'failed'), true);
  assert.equal(nodeMatchesFilter(run.nodes[2], 'blocked'), true);
  assert.equal(nodeMatchesFilter(run.nodes[3], 'running'), true);
  assert.equal(nodeMatchesFilter(run.nodes[4], 'failed'), false);
  assert.equal(nodeMatchesFilter(run.nodes[0], 'critical', criticalNodeIds(summary)), true);
  assert.equal(nodeMatchesFilter(run.nodes[4], 'critical', criticalNodeIds(summary)), false);
  assert.equal(nodeMatchesFilter(run.nodes[4], 'all'), true);
});

test('critical counts only nodes painted in the run', () => {
  const summary = { critical: { nodeIds: ['a', 'missing', 'ghost'] } };
  assert.deepEqual(filterCounts(run.nodes, summary), {
    all: 6, failed: 2, blocked: 1, running: 1, critical: 1,
  });
  const painted = run.nodes.filter(item => nodeMatchesFilter(item, 'critical', criticalNodeIds(summary))).length;
  assert.equal(filterCounts(run.nodes, summary).critical, painted);
  assert.equal(filterCounts([], summary).critical, 0);
  assert.equal(filterCounts(undefined, summary).critical, 0);
});

test('filters treat error, lost, and paused nodes as failed or blocked', () => {
  const nodes = [
    node('a', 'failed'),
    node('b', 'error'),
    node('c', 'lost'),
    node('d', 'blocked'),
    node('e', 'paused'),
  ];
  assert.deepEqual(filterCounts(nodes), {
    all: 5, failed: 3, blocked: 2, running: 0, critical: 0,
  });
  assert.equal(nodeMatchesFilter(nodes[1], 'failed'), true);
  assert.equal(nodeMatchesFilter(nodes[2], 'failed'), true);
  assert.equal(nodeMatchesFilter(nodes[3], 'blocked'), true);
  assert.equal(nodeMatchesFilter(nodes[4], 'blocked'), true);
});

test('focusSubgraph keeps the selected node and its direct neighbors only', () => {
  const focused = focusSubgraph(run, 'b');
  assert.deepEqual(focused.nodes.map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(focused.edges, [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ]);
  assert.equal(focusSubgraph(run, 'missing'), run);
  assert.equal(focusSubgraph(undefined, 'a'), undefined);
});

test('nextNodeId walks the layout in reading order and wraps', () => {
  const layout = {
    boxes: new Map([
      ['a', { x: 0, y: 0, node: { id: 'a' } }],
      ['b', { x: 10, y: 0, node: { id: 'b' } }],
      ['c', { x: 0, y: 6, node: { id: 'c' } }],
    ]),
  };
  assert.equal(nextNodeId(layout, 'a', 1), 'b');
  assert.equal(nextNodeId(layout, 'b', 1), 'c');
  assert.equal(nextNodeId(layout, 'c', 1), 'a');
  assert.equal(nextNodeId(layout, 'a', -1), 'c');
  assert.equal(nextNodeId(layout, undefined, 1), 'a');
  assert.equal(nextNodeId(undefined, 'a', 1), undefined);
});
