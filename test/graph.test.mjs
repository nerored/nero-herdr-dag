import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, BOLD, DIM } from '../src/canvas.mjs';
import { DemoEngine } from '../src/demo.mjs';
import {
  assignSlots, computeLayout, drawGraph, MAX_LAYOUT_ROWS, wirePoints, wireShimmerIntensity,
  pathHitsBox, WIRE_GLYPHS,
} from '../src/graph.mjs';
import { normalizeSnapshot } from '../src/model.mjs';
import { paletteAt } from '../src/theme.mjs';

const palette = paletteAt(0);
const cornerGlyphs = new Set(['└', '┘', '┌', '┐']);
const junctionGlyphs = new Set(['├', '┤', '┬', '┴']);
const verticalGlyphs = new Set(['│', '┤', '├', '┼', '┐', '┌', '┘', '└', '┬', '┴']);

function makeSnapshot(run) {
  return normalizeSnapshot({
    version: 2,
    sessionId: 'wire-test',
    runs: [run],
    tasks: [],
  });
}

function renderRun(run, width = 80) {
  const layout = computeLayout(run, width);
  const canvas = new Canvas(layout.width, layout.height, { fg: palette.text, bg: palette.panel });
  drawGraph(canvas, layout, {
    time: 0,
    motion: false,
    palette,
    selectedId: undefined,
    folded: new Set(),
    now: 1_000_000,
    connected: true,
    language: 'en',
  });
  return { layout, canvas };
}

function cellsAlong(points) {
  const cells = [];
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index];
    const b = points[index + 1];
    const stepX = Math.sign(b.x - a.x);
    const stepY = Math.sign(b.y - a.y);
    let x = a.x;
    let y = a.y;
    for (;;) {
      cells.push({ x, y });
      if (x === b.x && y === b.y) break;
      x += stepX;
      y += stepY;
    }
  }
  return cells;
}

test('a turned connector uses corner glyphs instead of four-way crosses', () => {
  const snapshot = makeSnapshot({
    id: 'wire', name: 'wire', status: 'running',
    nodes: [
      { id: 'a', label: 'a', state: 'completed', percent: 100 },
      { id: 'b', label: 'b', state: 'completed', percent: 100 },
      { id: 'c', label: 'c', state: 'completed', percent: 100 },
    ],
    edges: [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }],
  });
  const { layout, canvas } = renderRun(snapshot.runs[0]);
  const edge = layout.edges.find(candidate => candidate.from === 'a' && candidate.to === 'c');
  assert.ok(edge);
  assert.ok(edge.points.length > 2, 'the edge should turn between differently centered boxes');

  for (const bend of edge.points.slice(1, -1)) {
    const ch = canvas.cells[bend.y][bend.x].ch;
    assert.ok(cornerGlyphs.has(ch) || junctionGlyphs.has(ch),
      `bend at ${bend.x},${bend.y} rendered ${JSON.stringify(ch)}`);
  }
  for (let y = 0; y < layout.height; y++) {
    for (let x = 0; x < layout.width; x++) {
      assert.notEqual(canvas.cells[y][x].ch, '┼', `unexpected cross at ${x},${y}`);
    }
  }
});

test('a shared column keeps a parent-child connector straight', () => {
  const snapshot = makeSnapshot({
    id: 'aligned', name: 'aligned', status: 'running',
    nodes: [
      { id: 'a', label: 'a', state: 'running', percent: 50 },
      { id: 'b', label: 'b', state: 'pending', percent: 0 },
      { id: 'c', label: 'c', state: 'pending', percent: 0 },
    ],
    edges: [{ from: 'a', to: 'c' }],
  });
  const { layout } = renderRun(snapshot.runs[0]);
  const source = layout.boxes.get('a');
  const target = layout.boxes.get('c');
  assert.equal(source.centerX, target.centerX);
  const edge = layout.edges.find(candidate => candidate.from === 'a' && candidate.to === 'c');
  assert.equal(edge.points.length, 2);
});

test('outgoing detours reuse one shared corridor', () => {
  const now = 1_000_000;
  const snapshot = normalizeSnapshot(new DemoEngine({ now, startOffset: 32_000 }).snapshot(now));
  const run = snapshot.runs.find(candidate => candidate.id === 'run_goldbach');
  const { layout } = renderRun(run, 47);
  const first = layout.edges.find(edge => edge.from === 'gb_sieve' && edge.to === 'gb_coverage');
  const second = layout.edges.find(edge => edge.from === 'gb_sieve' && edge.to === 'gb_pairs');
  assert.ok(first && second);
  const firstCells = new Set(cellsAlong(first.points).map(cell => `${cell.x},${cell.y}`));
  const shared = cellsAlong(second.points).filter(cell => firstCells.has(`${cell.x},${cell.y}`));
  assert.ok(shared.length >= 10, `expected a shared detour, got ${shared.length} shared cells`);
});

test('long connectors route around intermediate node boxes', () => {
  const now = 1_000_000;
  const snapshot = normalizeSnapshot(new DemoEngine({ now, startOffset: 32_000 }).snapshot(now));
  const run = snapshot.runs.find(candidate => candidate.id === 'run_goldbach');
  const { layout } = renderRun(run);
  const boxes = [...layout.boxes.values()];
  const inside = (x, y) => boxes.some(box =>
    x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h);

  for (const edge of layout.edges) {
    const source = layout.boxes.get(edge.from);
    const target = layout.boxes.get(edge.to);
    assert.equal(edge.points[0].x, source.centerX, `${edge.from} starts on center`);
    assert.equal(edge.points.at(-1).x, target.centerX, `${edge.to} ends on center`);
    if (source.centerX === target.centerX) {
      assert.equal(edge.points.length, 2, `${edge.from}->${edge.to} should be a straight column`);
    }
    for (const cell of cellsAlong(edge.points)) {
      assert.ok(!inside(cell.x, cell.y), `${edge.from}->${edge.to} enters a box at ${cell.x},${cell.y}`);
    }
    for (let index = 0; index < edge.points.length - 1; index++) {
      const a = edge.points[index];
      const b = edge.points[index + 1];
      assert.ok(a.x === b.x || a.y === b.y, `${edge.from}->${edge.to} has a diagonal segment`);
    }
  }
});

function tightRun() {
  return makeSnapshot({
    id: 'tight', name: 'tight', status: 'running',
    nodes: [
      { id: 'a', label: 'a', state: 'pending', percent: 0 },
      { id: 'b', label: 'b', state: 'pending', percent: 0 },
      { id: 'c', label: 'c', state: 'pending', percent: 0 },
    ],
    edges: [{ from: 'a', to: 'c' }],
  }).runs[0];
}

function wideRun() {
  return makeSnapshot({
    id: 'wide', name: 'wide', status: 'running',
    nodes: [
      { id: 'a', label: 'a', state: 'pending', percent: 0 },
      { id: 'z0', label: 'z0', state: 'pending', percent: 0 },
      { id: 'z1', label: 'z1', state: 'pending', percent: 0 },
      { id: 'z2', label: 'z2', state: 'pending', percent: 0 },
      { id: 't', label: 't', state: 'pending', percent: 0 },
    ],
    edges: [{ from: 'a', to: 't' }],
  }).runs[0];
}

function renderLayout(layout, { motion = false, time = 0, folded = new Set() } = {}) {
  const canvas = new Canvas(layout.width, layout.height, { fg: palette.text, bg: palette.panel });
  drawGraph(canvas, layout, {
    time, motion, palette, selectedId: undefined, folded,
    now: 1_000_000, connected: true, language: 'en',
  });
  return canvas;
}

test('tight single-column detours leave and enter through vertical stubs', () => {
  const layout = computeLayout(tightRun(), 35);
  const source = layout.boxes.get('a');
  const target = layout.boxes.get('c');
  const edge = layout.edges.find(candidate => candidate.from === 'a' && candidate.to === 'c');
  assert.ok(edge);
  assert.deepEqual(edge.points[0], { x: source.centerX, y: source.y + source.h });
  assert.equal(edge.points[1].x, edge.points[0].x);
  assert.ok(edge.points[1].y > edge.points[0].y, 'the first move is downward');
  const before = edge.points.at(-2);
  const last = edge.points.at(-1);
  assert.equal(last.x, target.centerX);
  assert.equal(last.y, target.y - 1);
  assert.equal(before.x, target.centerX);
  assert.ok(last.y > before.y, 'the last move is downward into the target');
  assert.equal(pathHitsBox(edge.points, [...layout.boxes.values()]), false);
});

test('same-row adjacent boxes exit downward and enter from below', () => {
  const source = { x: 0, y: 2, w: 12, h: 6, centerX: 6 };
  const target = { x: 12, y: 2, w: 12, h: 6, centerX: 18 };
  const points = wirePoints(source, target);
  assert.ok(points, 'same-row boxes must still connect');
  assert.deepEqual(points[0], { x: 6, y: 8 });
  assert.equal(points[1].x, points[0].x);
  assert.ok(points[1].y > points[0].y, 'the connector leaves downward');
  const before = points.at(-2);
  const last = points.at(-1);
  assert.deepEqual(last, { x: 18, y: 8 });
  assert.equal(before.x, last.x);
  assert.ok(last.y < before.y, 'the connector enters from below');
  assert.equal(pathHitsBox(points, [source, target]), false);
});

test('zero-gutter fallback keeps a deterministic source stub clear of boxes', () => {
  const run = tightRun();
  const layout = computeLayout(run, 34);
  const source = layout.boxes.get('a');
  const edge = layout.edges.find(candidate => candidate.from === 'a' && candidate.to === 'c');
  assert.ok(edge, 'the edge is not silently dropped');
  assert.equal(edge.fallback, true);
  assert.deepEqual(edge.points[0], { x: source.centerX, y: source.y + source.h });
  assert.ok(edge.points.length > 1, 'the fallback is still drawable');
  assert.equal(pathHitsBox(edge.points, [...layout.boxes.values()]), false);
  const again = computeLayout(run, 34).edges.find(candidate => candidate.from === 'a');
  assert.deepEqual(again.points, edge.points, 'the fallback is deterministic');
});

test('every routed edge carries a downward arm on its source-adjacent cell', () => {
  const cases = [
    ['tight', tightRun(), 35, new Set()],
    ['tight folded', tightRun(), 35, new Set(['a', 'b', 'c'])],
    ['wide wrapped', wideRun(), 60, new Set()],
    ['wide folded', wideRun(), 60, new Set(['a', 'z0', 'z1', 'z2', 't'])],
  ];
  for (const [name, run, width, folded] of cases) {
    const layout = computeLayout(run, width, { folded });
    const canvas = renderLayout(layout, { folded });
    assert.ok(layout.edges.length > 0, `${name} layout has edges`);
    for (const edge of layout.edges) {
      const source = layout.boxes.get(edge.from);
      assert.deepEqual(edge.points[0], { x: source.centerX, y: source.y + source.h }, `${name} ${edge.from} starts adjacent`);
      assert.equal(edge.points[1].x, edge.points[0].x, `${name} ${edge.from} first segment is vertical`);
      assert.ok(edge.points[1].y > edge.points[0].y, `${name} ${edge.from} first segment points down`);
      const glyph = canvas.cells[edge.points[0].y][edge.points[0].x].ch;
      assert.ok(verticalGlyphs.has(glyph), `${name} ${edge.from}->${edge.to} adjacent glyph ${JSON.stringify(glyph)}`);
    }
  }
});

test('pending cells use the legend yellow border and text without dim', () => {
  assert.equal(palette.pending, palette.blocked);
  const layout = computeLayout(tightRun(), 35);
  const canvas = renderLayout(layout);
  const box = layout.boxes.get('a');
  const border = canvas.cell(box.x, box.y);
  const title = canvas.cell(box.x + 2, box.y + 1);
  assert.equal(border.fg, palette.pending);
  assert.equal(border.flags & DIM, 0);
  assert.equal(title.fg, palette.pending);
  assert.equal(title.flags & DIM, 0);
});

test('edge shimmer ports OmO padded cosine sweep with 11 band positions', () => {
  assert.equal(wireShimmerIntensity(20, 100, 500), 1);
  assert.equal(wireShimmerIntensity(15, 100, 500), 0);
  assert.equal(wireShimmerIntensity(25, 100, 500), 0);
  assert.equal(wireShimmerIntensity(14, 100, 500), 0);
  assert.equal(wireShimmerIntensity(26, 100, 500), 0);
  assert.equal(wireShimmerIntensity(20, 100, 0), 0);
  assert.equal(wireShimmerIntensity(20, 100, 2000), 0);
  const lit = Array.from({ length: 11 }, (_, index) => index + 15)
    .filter(distance => wireShimmerIntensity(distance, 100, 500) > 0);
  assert.equal(lit.length, 9);
});

test('edge animation recolors wire glyphs without dot markers', () => {
  const layout = computeLayout(tightRun(), 35);
  const off = renderLayout(layout, { motion: false, time: 0 });
  const on = renderLayout(layout, { motion: true, time: 750 });
  const wire = new Set(Object.values(WIRE_GLYPHS));
  const inBox = (x, y) => [...layout.boxes.values()].some(box =>
    x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h);
  let live = 0;
  for (let y = 0; y < layout.height; y++) {
    for (let x = 0; x < layout.width; x++) {
      if (inBox(x, y)) continue;
      const before = off.cells[y][x];
      const after = on.cells[y][x];
      assert.notEqual(before.ch, '•', `motion-off dot at ${x},${y}`);
      assert.notEqual(before.ch, '·', `motion-off dot at ${x},${y}`);
      assert.notEqual(after.ch, '•', `motion-on dot at ${x},${y}`);
      assert.notEqual(after.ch, '·', `motion-on dot at ${x},${y}`);
      assert.equal(after.ch, before.ch, `flow must keep the wire glyph at ${x},${y}`);
      if (before.ch === ' ') continue;
      assert.ok(wire.has(before.ch) || before.ch === '▼', `unexpected wire glyph ${JSON.stringify(before.ch)} at ${x},${y}`);
      assert.equal(before.flags & BOLD, 0, `motion-off wire is not bold at ${x},${y}`);
      if (!(after.flags & DIM)) live++;
    }
  }
  assert.ok(live >= 6 && live <= 11, `expected a 6-10 cell head/trail plus the arrow, got ${live} live cells`);
});

// ---- Phase 3 regressions (ui-render-a) ----

// F-22: slot choice is a slot DP, not a C(columns, count) enumeration. The
// 40-of-80 case would not terminate under the old depth-first search.
test('slot assignment is polynomial and always distinct', () => {
  assert.deepEqual(assignSlots(3, [0, 0, 0], 5), [0, 1, 2]);
  assert.deepEqual(assignSlots(4, [0, 0, 2, 2], 6), [0, 1, 2, 3]);

  const targets = Array.from({ length: 40 }, (_, index) => index * 2);
  const slots = assignSlots(40, targets, 80);
  assert.equal(slots.length, 40);
  assert.equal(new Set(slots).size, 40, 'every node owns a distinct slot');
  assert.deepEqual(slots, targets);
  for (let index = 1; index < slots.length; index++) {
    assert.ok(slots[index] > slots[index - 1], 'slots are strictly increasing');
  }
});

// F-112: layout height (and therefore the per-frame canvas/grid) is bounded.
test('a very long workflow is capped at MAX_LAYOUT_ROWS', () => {
  const nodes = Array.from({ length: 500 }, (_, index) => ({
    id: `long-${index}`, label: `long-${index}`, state: 'pending',
  }));
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));
  const layout = computeLayout(makeSnapshot({
    id: 'long', name: 'long', status: 'running', nodes, edges,
  }).runs[0], 120);
  assert.equal(layout.height, MAX_LAYOUT_ROWS);
  assert.ok(layout.boxes.size < nodes.length, 'nodes past the cap are not laid out');
  assert.ok(layout.edges.length > 0, 'the visible prefix still routes its edges');
});

// F-113: two independent edges crossing are not painted as a dependency
// junction; a real fan-in/fan-out junction keeps its cross glyph.
test('a false wire crossing is painted as a pass-under, not a junction', () => {
  const now = 1_000_000;
  const snapshot = normalizeSnapshot(new DemoEngine({ now, startOffset: 32_000 }).snapshot(now));
  const run = snapshot.runs.find(candidate => candidate.id === 'run_integration');
  const { layout, canvas } = renderRun(run, 60);
  assert.equal(layout.height > 42, true, 'the fixture still has the crossing row');

  // This cell carried a horizontal edge and an unrelated vertical edge: the
  // vertical arm survives, so the glyph cannot imply a four-way junction.
  assert.equal(canvas.cells[42][30].ch, '│');
  assert.equal(canvas.cells[42][29].ch, '─');
  assert.equal(canvas.cells[42][31].ch, '─');
  for (const y of [40, 41, 43, 44]) assert.equal(canvas.cells[y][30].ch, '│');

  // Genuine junctions in the same run still use the cross glyph.
  assert.equal(canvas.cells[21][30].ch, '┼');
  assert.equal(canvas.cells[52][30].ch, '┼');
});
