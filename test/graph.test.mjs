import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, BOLD, DIM } from '../src/canvas.mjs';
import { DemoEngine } from '../src/demo.mjs';
import {
  assignSlots, computeLayout, drawGraph, graphLayoutKey, graphLayoutMatches, MAX_LAYOUT_ROWS,
  resetWireRaster, wirePoints, wireRasterStats, wireShimmerBand, wireShimmerIntensity,
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

function drawFrame(layout, { width = layout.width, height = layout.height, time = 0, motion = false, clip } = {}) {
  const canvas = new Canvas(width, height, { fg: palette.text, bg: palette.panel });
  drawGraph(canvas, layout, {
    time, motion, palette, selectedId: undefined, folded: new Set(),
    now: 1_000_000, connected: true, language: 'en', clip,
  });
  return canvas;
}

test('the wire raster is built once per layout and viewport', () => {
  resetWireRaster();
  const layout = computeLayout(tightRun(), 35);
  const first = drawFrame(layout, { motion: true, time: 500 });
  const built = wireRasterStats();
  assert.equal(built.builds, 1, 'the first frame builds the static raster');
  assert.equal(built.hits, 0);
  assert.equal(built.retained, 1, 'exactly one raster is retained');
  assert.equal(built.cells, layout.width * layout.height, 'the raster covers this layout and viewport');

  const second = drawFrame(layout, { motion: true, time: 500 });
  const warm = wireRasterStats();
  assert.equal(warm.builds, 1, 'the same layout and viewport never rebuilds the raster');
  assert.equal(warm.hits, 1);
  assert.deepEqual(second.cells, first.cells, 'the reused raster paints the same frame');

  // The viewer rebinds every box to the refreshed snapshot's node objects via
  // bindGraphLayout, which shallow-copies each box. Fresh box objects with an
  // identical rectangle must still reuse the raster.
  const rebound = {
    ...layout,
    boxes: new Map([...layout.boxes].map(([id, box]) => [id, { ...box, node: box.node }])),
  };
  for (const [id, box] of layout.boxes) {
    assert.notEqual(rebound.boxes.get(id), box, `${id} is a fresh box object`);
  }
  const third = drawFrame(rebound, { motion: true, time: 500 });
  assert.equal(wireRasterStats().builds, 1, 'rebound box objects with identical geometry reuse the raster');
  assert.equal(wireRasterStats().hits, 2);
  assert.deepEqual(third.cells, first.cells, 'rebinding node objects does not repaint a wire');
});

test('a changed viewport or layout rebuilds the raster without retaining a second one', () => {
  resetWireRaster();
  const layout = computeLayout(tightRun(), 35);
  const clip = { top: 0, bottom: 6 };
  drawFrame(layout, { clip });
  drawFrame(layout, { clip });
  assert.equal(wireRasterStats().builds, 1, 'a repeated viewport reuses the raster');

  // The viewport is part of the key: an identically sized layout scrolled to
  // another window must not paint the previous window's cells.
  drawFrame(layout, { clip: { top: 2, bottom: 8 } });
  assert.equal(wireRasterStats().builds, 2, 'a new viewport builds a new raster');
  assert.equal(wireRasterStats().cells, layout.width * 6, 'the raster is bounded to the viewport');

  // Same width, different geometry: the wire geometry, not the object, decides reuse.
  const folded = computeLayout(tightRun(), 35, { folded: new Set(['a', 'b', 'c']) });
  assert.notEqual(folded.height, layout.height);
  drawFrame(folded);
  const rebuilt = wireRasterStats();
  assert.equal(rebuilt.builds, 3, 'a changed layout builds a new raster');
  assert.equal(rebuilt.retained, 1, 'the previous layout is dropped, not kept in a map');
  assert.equal(rebuilt.cells, folded.width * folded.height);

  // A copied layout whose boxes moved must rebuild even though its dimensions
  // and owner objects look the same.
  const shifted = {
    ...folded,
    boxes: new Map([...folded.boxes].map(([id, box]) => [id, { ...box, x: box.x + 1 }])),
  };
  drawFrame(shifted);
  assert.equal(wireRasterStats().builds, 4, 'a moved box rebuilds the raster');

  // Returning to the first layout rebuilds instead of leaking one raster per
  // layout visited.
  drawFrame(layout, { clip });
  assert.equal(wireRasterStats().builds, 5);
  assert.equal(wireRasterStats().retained, 1);
});

test('a moved wire point rebuilds a layout with identical boxes', () => {
  resetWireRaster();
  const layout = computeLayout(tightRun(), 35);
  drawFrame(layout);
  assert.equal(wireRasterStats().builds, 1);

  // Clone the currently cached layout. Boxes keep the exact same values (the
  // clone is shallow-copied at the layout level), so only the point compare in
  // sameWireGeometry can explain a rebuild. These are fresh objects, matching
  // how the renderer consumes a layout: computeLayout returns one and
  // bindGraphLayout copies it; no product path mutates a published layout.
  const moved = {
    ...layout,
    edges: layout.edges.map(edge => ({ ...edge, points: edge.points.map(point => ({ ...point })) })),
  };
  assert.deepEqual(moved.boxes, layout.boxes, 'the clone keeps byte-identical boxes');
  moved.edges[0].points[0].y += 1;
  drawFrame(moved);
  assert.equal(wireRasterStats().builds, 2, 'only the moved wire point can cause this rebuild');
  assert.equal(wireRasterStats().retained, 1);
});

test('a warm wire raster paints byte-identical cells to a cold build', () => {
  const now = 1_000_000;
  const snapshot = normalizeSnapshot(new DemoEngine({ now, startOffset: 32_000 }).snapshot(now));
  const run = snapshot.runs.find(candidate => candidate.id === 'run_integration');
  for (const [name, width, height, motion, time] of [
    ['120x40 animated', 120, 40, true, 750],
    ['120x40 static', 120, 40, false, 0],
    ['140x42 animated', 140, 42, true, 1000],
  ]) {
    const layout = computeLayout(run, width);
    const clip = { top: 0, bottom: height };
    resetWireRaster();
    const cold = drawFrame(layout, { height, motion, time, clip });
    assert.equal(wireRasterStats().builds, 1, `${name}: the cold frame builds once`);

    // Warm the cache at other instants so the per-frame flow array is
    // rewritten before the compared frame.
    drawFrame(layout, { height, motion: true, time: 0, clip });
    drawFrame(layout, { height, motion: true, time: 1250, clip });
    const warm = drawFrame(layout, { height, motion, time, clip });
    assert.equal(wireRasterStats().builds, 1, `${name}: warm frames reuse the static raster`);
    assert.deepEqual(warm.cells, cold.cells, `${name}: cached and cold frames differ`);
  }
});

test('flow cells are cached on the wire raster and reused without reallocation', () => {
  resetWireRaster();
  const layout = computeLayout(tightRun(), 35);
  const cold = drawFrame(layout, { motion: true, time: 750 });
  const built = wireRasterStats();
  assert.equal(built.builds, 1, 'the first animated frame builds the raster');
  assert.ok(built.flow.cachedCells > 0, 'the raster stores one flow-cell list per edge');
  assert.equal(built.flow.allocatedCells, built.flow.cachedCells,
    'the build allocates exactly the cells it caches');
  assert.ok(built.flow.evaluatedCells > 0, 'the band evaluates real cells');
  assert.ok(built.flow.skippedCells > built.flow.evaluatedCells,
    'the band is a small window of the whole wire');
  assert.equal(built.flow.skippedCells + built.flow.evaluatedCells, built.flow.cachedCells,
    'every cached cell is either skipped or evaluated once');

  const warm = drawFrame(layout, { motion: true, time: 750 });
  const reused = wireRasterStats();
  assert.equal(reused.builds, 1, 'the animated frame reuses the raster');
  assert.equal(reused.hits, 1);
  assert.equal(reused.flow.allocatedCells, built.flow.allocatedCells,
    'a raster hit must not allocate flow cells again');
  assert.equal(reused.flow.cachedCells, built.flow.cachedCells);
  assert.deepEqual(warm.cells, cold.cells, 'cached flow cells paint the same pixels');

  // A cold rebuild at the same instant must also repaint the same pixels; only
  // the cached lists made the warm frame cheaper.
  resetWireRaster();
  const rebuilt = drawFrame(layout, { motion: true, time: 750 });
  const rebuiltStats = wireRasterStats();
  assert.deepEqual(rebuilt.cells, cold.cells, 'cold and cached animation pixels match');
  assert.equal(rebuiltStats.flow.allocatedCells, rebuiltStats.flow.cachedCells);
  assert.equal(rebuiltStats.flow.allocatedCells, built.flow.allocatedCells,
    'one allocation per raster build, not per frame');
});

test('the shimmer band covers exactly the cells with nonzero intensity', () => {
  const totals = [2, 3, 10, 44, 99, 100, 101, 120];
  const times = [0, 1, 125, 500, 750, 999, 1000, 1250, 1500, 1999, 2000, 2731];
  for (const total of totals) {
    for (const time of times) {
      const band = wireShimmerBand(total, time);
      assert.ok(band.start >= 0, 'the band starts at an existing cell');
      assert.ok(band.end <= total - 1, 'the band ends at an existing cell');
      for (let distance = 0; distance < total; distance++) {
        const inside = distance >= band.start && distance <= band.end;
        const intensity = wireShimmerIntensity(distance, total, time);
        if (!inside) assert.equal(intensity, 0, 'distance ' + distance + ' outside the band is dark at ' + time + 'ms / ' + total);
        if (intensity > 0) assert.ok(inside, 'distance ' + distance + ' is lit at ' + time + 'ms / ' + total + ' but outside the band');
      }
    }
  }
});

test('a zero-intensity band edge is evaluated but never painted', () => {
  resetWireRaster();
  const layout = computeLayout(tightRun(), 35);
  // tightRun's single wire is 48 cells; at 500ms the padded sweep (68 * 1/4 =
  // 17) puts both closed-window edges on integer distances, where the raised
  // cosine evaluates to exactly 0.
  drawFrame(layout, { motion: true, time: 500 });
  const stats = wireRasterStats().flow;
  assert.ok(stats.zeroCells > 0, 'the band edge hit a zero-intensity cell');
  assert.ok(stats.evaluatedCells < stats.cachedCells, 'only the band is evaluated');
  assert.equal(stats.skippedCells + stats.evaluatedCells, stats.cachedCells,
    'every cached cell is either skipped or evaluated once');
});

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
  assert.equal(layout.fallbackEdges, layout.edges.filter(candidate => candidate.fallback).length);
  assert.ok(layout.fallbackEdges > 0, 'the stub is counted, not silently substituted');
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
  assert.equal(MAX_LAYOUT_ROWS, 4096, 'the layout cap is a measured budget, not a tunable');
  assert.equal(layout.height, MAX_LAYOUT_ROWS);
  assert.equal(layout.capped, true);
  assert.ok(layout.hiddenNodes > 0, 'the cap hides the tail of the workflow');
  assert.equal(layout.boxes.size + layout.hiddenNodes, nodes.length,
    'every node is either laid out or counted as hidden');
  assert.ok(layout.boxes.size < nodes.length, 'nodes past the cap are not laid out');
  assert.ok(layout.edges.length > 0, 'the visible prefix still routes its edges');

  const short = computeLayout(makeSnapshot({
    id: 'short', name: 'short', status: 'running',
    nodes: nodes.slice(0, 3), edges: edges.slice(0, 2),
  }).runs[0], 120);
  assert.equal(short.capped, false);
  assert.equal(short.hiddenNodes, 0);
});

test('the layout key covers run, width, fold, node order, and edge order', () => {
  const run = {
    id: 'key-run',
    nodes: ['a', 'b', 'c'].map(id => ({ id, label: id, state: 'pending' })),
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  };
  const base = graphLayoutKey(run, 40);
  assert.equal(base, graphLayoutKey(run, 40), 'the key is stable for the same geometry');
  assert.notEqual(base, graphLayoutKey({ ...run, id: 'other-run' }, 40), 'run identity is keyed');
  assert.notEqual(base, graphLayoutKey(run, 41), 'width is keyed');
  assert.notEqual(base, graphLayoutKey(run, 40, { folded: new Set(['b']) }), 'fold is keyed');
  assert.equal(
    graphLayoutKey(run, 40, { folded: new Set(['c', 'a']) }),
    graphLayoutKey(run, 40, { folded: new Set(['a', 'c']) }),
    'fold order is not geometry',
  );
  const reversedNodes = [...run.nodes].reverse();
  assert.notEqual(base, graphLayoutKey({ ...run, nodes: reversedNodes }, 40), 'node order is keyed even for the same set');
  const reversedEdges = [...run.edges].reverse();
  assert.notEqual(base, graphLayoutKey({ ...run, edges: reversedEdges }, 40), 'edge order is keyed even for the same set');
});

test('computeLayout publishes the key it was built from and no stale row map', () => {
  const run = tightRun();
  const layout = computeLayout(run, 35);
  assert.equal(layout.key, graphLayoutKey(run, 35));
  assert.equal('rows' in layout, false, 'rows would alias boxes after a rebind; omit it');
});

test('a supplied layout matches only the exact width and geometry key', () => {
  const run = tightRun();
  const layout = computeLayout(run, 35);
  assert.equal(graphLayoutMatches(layout, run, 35, new Set()), true);
  assert.equal(graphLayoutMatches(layout, run, 36, new Set()), false, 'a wider pane rejects the layout');
  // The key is computed for the call width, so only the explicit width guard
  // rejects this layout. Removing that guard makes this assertion fail.
  assert.equal(
    graphLayoutMatches({ ...layout, width: 36 }, run, 35, new Set()),
    false,
    'the layout width itself must equal the content width',
  );
  assert.equal(
    graphLayoutMatches({ ...layout, key: 'stale' }, run, 35, new Set()),
    false,
    'the key must match, not just the node count',
  );
  assert.equal(graphLayoutMatches(layout, run, 35, new Set(['a'])), false, 'a fold change rejects the layout');
});

test('a capped layout is reusable only when its hidden count completes the node list', () => {
  const nodes = Array.from({ length: 500 }, (_, index) => ({ id: `cap-${index}`, label: `cap-${index}`, state: 'pending' }));
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));
  const run = { id: 'capped', nodes, edges };
  const layout = computeLayout(run, 52);
  assert.equal(layout.capped, true);
  assert.equal(layout.boxes.size, 373);
  assert.equal(layout.hiddenNodes, 127);
  assert.equal(graphLayoutMatches(layout, run, 52, new Set()), true, 'the full key makes a capped layout reusable');
  assert.equal(
    graphLayoutMatches({ ...layout, hiddenNodes: layout.hiddenNodes - 1 }, run, 52, new Set()),
    false,
    'boxes plus hidden must account for every node',
  );
  const short = new Map([...layout.boxes].slice(1));
  assert.equal(
    graphLayoutMatches({ ...layout, boxes: short }, run, 52, new Set()),
    false,
    'a missing box cannot be hidden silently',
  );
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
