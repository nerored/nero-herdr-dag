import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_LAYOUT_ROWS } from '../src/graph.mjs';
import { normalizeSnapshot } from '../src/model.mjs';
import { renderApp } from '../src/render.mjs';
import {
  SNAPSHOT_LIMITS, ViewerSnapshotError, boundSnapshotInput, readStateFile,
} from '../src/viewer.mjs';
import { baseUi, createTestViewer, themeFor } from './helpers.mjs';

const now = 1_000_000;
const { palette, theme } = themeFor(0);
const iso = value => new Date(value).toISOString();

const regionText = (result, rect) => {
  const rows = [];
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    rows.push(result.canvas.cells[y].slice(rect.x, rect.x + rect.w).map(cell => cell.ch).join(''));
  }
  return rows.join('\n');
};

// A sparse array whose first slot explodes when read proves the limit check
// happens before the normalizer maps the array; a mapped fixture would throw
// the plain Error below instead of a ViewerSnapshotError.
function mappingTrap(length) {
  const array = new Array(length);
  Object.defineProperty(array, 0, {
    get() { throw new Error('mapped an over-limit array'); },
  });
  return array;
}

function rejectsSnapshot(raw, pattern) {
  assert.throws(() => boundSnapshotInput(raw), error =>
    error instanceof ViewerSnapshotError && pattern.test(error.message));
}

// Raising any of these without a committed bench row would make the viewer
// accept more work than the frame budget was measured against. Pin the values
// so a limit change cannot slip in as an unrelated edit.
test('snapshot limits stay at the documented cardinality', () => {
  assert.deepEqual({ ...SNAPSHOT_LIMITS }, {
    runs: 256,
    tasks: 8_192,
    nodesPerRun: 4_096,
    edgesPerRun: 16_384,
    rateSamples: 32,
  });
});

test('a snapshot above the runs limit is rejected before mapping', () => {
  rejectsSnapshot(
    { runs: mappingTrap(SNAPSHOT_LIMITS.runs + 1) },
    new RegExp(`^snapshot has ${SNAPSHOT_LIMITS.runs + 1} runs \\(limit ${SNAPSHOT_LIMITS.runs}\\)$`),
  );
});

test('a snapshot above the tasks limit is rejected before mapping', () => {
  rejectsSnapshot(
    { runs: [], tasks: mappingTrap(SNAPSHOT_LIMITS.tasks + 1) },
    new RegExp(`^snapshot has ${SNAPSHOT_LIMITS.tasks + 1} tasks \\(limit ${SNAPSHOT_LIMITS.tasks}\\)$`),
  );
});

test('a run above the nodes-per-run limit is rejected before mapping', () => {
  rejectsSnapshot(
    {
      runs: [{
        id: 'node-cap',
        nodes: mappingTrap(SNAPSHOT_LIMITS.nodesPerRun + 1),
        edges: [],
      }],
    },
    new RegExp(`^run node-cap has ${SNAPSHOT_LIMITS.nodesPerRun + 1} nodes \\(limit ${SNAPSHOT_LIMITS.nodesPerRun}\\)$`),
  );
});

test('a run above the edges-per-run limit is rejected before mapping', () => {
  rejectsSnapshot(
    {
      runs: [{
        id: 'edge-cap',
        nodes: [],
        edges: mappingTrap(SNAPSHOT_LIMITS.edgesPerRun + 1),
      }],
    },
    new RegExp(`^run edge-cap has ${SNAPSHOT_LIMITS.edgesPerRun + 1} edges \\(limit ${SNAPSHOT_LIMITS.edgesPerRun}\\)$`),
  );
});

test('rate histories above the sample limit keep only the bounded tail', () => {
  const samples = SNAPSHOT_LIMITS.rateSamples + 8;
  const history = Array.from({ length: samples }, (_, index) => ({ rate: index }));
  const bounded = boundSnapshotInput({
    runs: [{
      id: 'rates',
      nodes: [{ id: 'rate-node', state: 'running', tokenRate: history, tokenRateHistory: history }],
      edges: [],
    }],
    tasks: [{ id: 'rate-task', tokenRate: history }],
  });

  const node = bounded.runs[0].nodes[0];
  assert.equal(node.tokenRate.length, SNAPSHOT_LIMITS.rateSamples);
  assert.equal(node.tokenRateHistory.length, SNAPSHOT_LIMITS.rateSamples);
  assert.equal(node.tokenRateHistory[0].rate, samples - SNAPSHOT_LIMITS.rateSamples);
  assert.equal(node.tokenRateHistory.at(-1).rate, samples - 1);
  assert.equal(bounded.tasks[0].tokenRate.length, SNAPSHOT_LIMITS.rateSamples);
  assert.equal(history.length, samples, 'the shared input history is never mutated');
});

test('an oversized state file is rejected before parsing or mapping', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-limits-'));
  const statePath = join(dir, 'oversized.json');
  const body = JSON.stringify({ version: 3, runs: [] });
  writeFileSync(statePath, `${body}${' '.repeat(128)}`);
  try {
    await assert.rejects(
      readStateFile(statePath, { maxBytes: 16 }),
      error => error instanceof ViewerSnapshotError && /bytes \(limit 16\)/.test(error.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadState turns an over-limit snapshot into an invalid result before mapping', async () => {
  const { viewer } = await createTestViewer({
    args: { statePath: '/tmp/dag-limits-state.json', once: true, interactive: false, noColor: true },
    deps: {
      loadConfig: async () => ({}),
      loadOmoTheme: async () => 'system',
      loadOmoAppearance: async () => ({}),
      readStateFile: async () => ({
        version: 3,
        mode: 'live',
        connected: true,
        runs: mappingTrap(SNAPSHOT_LIMITS.runs + 1),
        tasks: [],
      }),
      loadViewState: async (_path, sessionId) => ({ version: 1, sessionId, expanded: {} }),
      saveViewState: async () => {},
    },
  });
  const result = await viewer.loadState(true);
  assert.equal(result.kind, 'invalid');
  assert.match(
    result.error.message,
    new RegExp(`invalid snapshot: snapshot has ${SNAPSHOT_LIMITS.runs + 1} runs \\(limit ${SNAPSHOT_LIMITS.runs}\\)`),
  );
  await viewer.close({ code: 0 });
});

function longChainSnapshot(count) {
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `cap-${index}`, label: `cap-${index}`, state: 'pending',
  }));
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));
  return normalizeSnapshot({
    version: 3,
    sessionId: 'capped-layout',
    runs: [{ id: 'capped', name: 'capped run', status: 'running', nodes, edges }],
    tasks: [],
  });
}

const frameAt120 = snapshot => renderApp(snapshot, baseUi({ motion: false }), {
  width: 120, height: 40, time: 0, now, palette, theme,
});

test('a capped graph names the hidden node count at 120 columns', () => {
  const snapshot = longChainSnapshot(500);
  const result = frameAt120(snapshot);
  const layout = result.graph.layout;

  assert.equal(layout.height, MAX_LAYOUT_ROWS);
  assert.equal(layout.capped, true);
  assert.ok(layout.hiddenNodes > 0, 'the cap hides part of the workflow');
  assert.equal(layout.boxes.size + layout.hiddenNodes, snapshot.runs[0].nodes.length,
    'every node is either laid out or counted as hidden');

  const graph = regionText(result, result.layout.graph);
  assert.match(graph, new RegExp(`⚠ capped · ${layout.hiddenNodes} hidden`));
  assert.doesNotMatch(graph, /cap-499/, 'a node past the cap is never painted');
});

test('a graph below the row cap carries no capped badge', () => {
  const result = frameAt120(longChainSnapshot(3));
  assert.equal(result.graph.layout.capped, false);
  assert.equal(result.graph.layout.hiddenNodes, 0);
  assert.doesNotMatch(regionText(result, result.layout.graph), /capped/);
});

function fallbackSnapshot() {
  const nodes = [];
  const edges = [];
  let previous = [];
  for (let layer = 0; layer < 4; layer++) {
    const current = [];
    for (let index = 0; index < 8; index++) {
      const id = `fb-${layer}-${index}`;
      current.push(id);
      nodes.push({ id, label: id, state: 'pending' });
    }
    if (layer > 0) {
      for (const from of previous) for (const to of current) edges.push({ from, to });
    }
    previous = current;
  }
  return normalizeSnapshot({
    version: 3,
    sessionId: 'fallback-wires',
    runs: [{ id: 'fallback', name: 'fallback run', status: 'running', nodes, edges }],
    tasks: [],
  });
}

test('route-budget fallback wires are counted and labeled', () => {
  const result = frameAt120(fallbackSnapshot());
  const layout = result.graph.layout;
  assert.ok(layout.fallbackEdges > 0, 'the fixture exhausts the routing budget');
  assert.equal(layout.fallbackEdges, layout.edges.filter(edge => edge.fallback).length);

  const graph = regionText(result, result.layout.graph);
  assert.match(graph, new RegExp(`⚠ ${layout.fallbackEdges} fallback wires`));
});

test('dropped nodes and edges surface an exact warning count without fabricating work', () => {
  const snapshot = normalizeSnapshot({
    version: 3, mode: 'saved', connected: false, sessionId: 'dropped-records',
    generatedAt: iso(now - 10_000), updatedAt: iso(now - 10_000),
    runs: [{
      id: 'run_drop', name: 'dropped run', status: 'running',
      createdAt: iso(now - 20_000), updatedAt: iso(now - 10_000),
      nodes: [
        { id: 'kept', label: 'kept node', state: 'running', task_id: 'st_kept', percent: 40 },
        { id: 'bad', label: 'bad state node', state: 'succeeded' },
      ],
      edges: [{ from: 'kept', to: 'ghost' }, { from: 'kept', to: 'kept' }],
    }],
    tasks: [{ id: 'st_kept', description: 'kept task', status: 'running', percent: 40 }],
  });
  const run = snapshot.runs[0];
  assert.equal(run.warningCount, 3);
  assert.deepEqual(run.nodes.map(node => node.id), ['kept']);
  assert.deepEqual(run.edges, []);

  const droppedUi = baseUi({
    motion: false, selectedNodeId: 'kept', selectedTaskId: 'st_kept',
  });
  const result = renderApp(snapshot, droppedUi, {
    width: 120, height: 40, time: 0, now, palette, theme,
  });

  const graph = regionText(result, result.layout.graph);
  assert.match(graph, /⚠ 3 dropped/, 'the graph badge carries the dropped count');
  assert.doesNotMatch(graph, /bad state node|ghost|self/, 'dropped records are never painted as live work');

  // Duty mode at 70 columns is wide enough for the full warning lines.
  const narrow = renderApp(snapshot, droppedUi, {
    width: 70, height: 24, time: 0, now, palette, theme,
  });
  const details = regionText(narrow, narrow.layout.details);
  assert.match(details, /WARNINGS 3/);
  assert.match(details, /unknown state "succeeded"/);
  assert.match(details, /edge kept → ghost dropped/);
  assert.match(details, /self edge/);
});
