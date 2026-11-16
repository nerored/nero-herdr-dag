import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSnapshot } from '../src/model.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A benchmark must not read the wall clock: one frozen capture instant keeps
// freshness, activity labels, and animation on the same deterministic path.
export const FIXED_NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
export const FRAME = Object.freeze({ width: 120, height: 40 });

export const BENCH_GRAPHS = Object.freeze([
  Object.freeze({ name: '100/185', nodes: 100, edges: 185 }),
  Object.freeze({ name: '300/560', nodes: 300, edges: 560 }),
  Object.freeze({ name: '500/990', nodes: 500, edges: 990 }),
]);

const nodeId = index => `n${String(index).padStart(4, '0')}`;

// Deterministic stress graph: the chain is the shape the layout height and
// route-state budgets were tuned against; skip edges are added in a fixed
// order until the requested edge count is reached. No randomness, clock, or
// Set iteration order feeds the result.
export function syntheticSnapshot({ name, nodes, edges }) {
  if (edges < nodes - 1) {
    throw new Error(`${name}: ${edges} edges cannot connect ${nodes} nodes`);
  }
  const wired = [];
  const seen = new Set();
  const add = (from, to) => {
    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    wired.push({ from, to });
  };
  for (let index = 1; index < nodes; index++) add(nodeId(index - 1), nodeId(index));
  for (let span = 2; wired.length < edges; span++) {
    const before = wired.length;
    for (let from = 0; from + span < nodes && wired.length < edges; from++) {
      add(nodeId(from), nodeId(from + span));
    }
    if (wired.length === before) {
      throw new Error(`${name}: ran out of acyclic edges at ${wired.length}/${edges}`);
    }
  }
  const at = new Date(FIXED_NOW).toISOString();
  const last = nodes - 1;
  return normalizeSnapshot({
    version: 3,
    mode: 'live',
    connected: true,
    sessionId: `bench-${nodes}-${edges}`,
    generatedAt: at,
    provenance: { origin: 'bench', capturedAt: at, view: 'watch' },
    runs: [{
      id: `run_bench_${nodes}`,
      name: `bench ${nodes}/${edges}`,
      status: 'running',
      createdAt: new Date(FIXED_NOW - 60_000).toISOString(),
      updatedAt: at,
      nodes: Array.from({ length: nodes }, (_, index) => ({
        id: nodeId(index),
        label: `task-${String(index + 1).padStart(3, '0')}`,
        state: index === last ? 'running' : 'completed',
        attempt: 1,
        percent: index === last ? 50 : 100,
      })),
      edges: wired,
    }],
    tasks: [],
  });
}

// The demo row replays the committed snapshot instead of synthesising a second
// demo engine, so the benchmark measures the same fixture users see.
export function demoSnapshot() {
  const path = join(root, 'demo', 'snapshot.json');
  const snapshot = normalizeSnapshot(JSON.parse(readFileSync(path, 'utf8')));
  if (!snapshot?.runs.length) throw new Error(`${path}: expected at least one run`);
  return snapshot;
}

export function benchFixtures() {
  return [
    { name: 'demo', snapshot: demoSnapshot() },
    ...BENCH_GRAPHS.map(spec => ({ name: spec.name, snapshot: syntheticSnapshot(spec) })),
  ];
}
