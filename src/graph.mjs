import { t } from './i18n.mjs';
import { activitySummary, layers, nodeActivity } from './model.mjs';
import { statusColor, statusIcon, pulse, mix } from './theme.mjs';
import { fit, percentBar, width as textWidth } from './text.mjs';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const WIRE_GLYPHS = {
  0: ' ', 1: '│', 2: '│', 3: '│',
  4: '─', 5: '┘', 6: '┐', 7: '┤',
  8: '─', 9: '└', 10: '┌', 11: '├',
  12: '─', 13: '┴', 14: '┬', 15: '┼',
};

// A state file can describe thousands of layers, and layout runs
// synchronously in the render path. Bound the canvas height so the per-frame
// Canvas + wire grid cannot grow without limit; nodes past the cap are simply
// not laid out (the graph is scroll-bounded either way).
const MAX_LAYOUT_ROWS = 4096;

// Port OmO's working-status shimmer verbatim: an 11-cell raised-cosine band
// sweeps a padded path every 2 seconds. The room before and after the path is
// deliberate; it lets the band enter and leave without popping at an endpoint.
const SHIMMER_PADDING = 10;
const SHIMMER_BAND_HALF_WIDTH = 5;
const SHIMMER_SWEEP_MS = 2000;

export function wireShimmerIntensity(distance, total, time) {
  const period = total + SHIMMER_PADDING * 2;
  const sweep = ((Math.max(0, time) % SHIMMER_SWEEP_MS) / SHIMMER_SWEEP_MS) * period;
  const bandDistance = Math.abs(distance + SHIMMER_PADDING - sweep);
  if (bandDistance > SHIMMER_BAND_HALF_WIDTH) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * (bandDistance / SHIMMER_BAND_HALF_WIDTH)));
}

export function spinnerFrame(time) {
  return SPINNER[Math.floor(time / 90) % SPINNER.length];
}

export function nodeIcon(node, time, motion = true) {
  if (node.state === 'running' && motion) return spinnerFrame(time);
  return statusIcon(node.state);
}

// Wire cells live in parallel typed arrays. A per-cell object for every row
// and column dominated both allocation and GC on every frame. Edge ids
// (1-based) record which edge contributed each arm, so a true junction can be
// told apart from two independent wires crossing.
class WireGrid {
  constructor(width, height) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const size = this.width * this.height;
    this.bits = new Uint8Array(size);
    this.arrowFlags = new Uint8Array(size);
    this.flowAmounts = new Float32Array(size);
    this.vFirst = new Uint32Array(size);
    this.hFirst = new Uint32Array(size);
    this.vMulti = new Uint8Array(size);
    this.hMulti = new Uint8Array(size);
  }

  reset() {
    this.bits.fill(0);
    this.arrowFlags.fill(0);
    this.flowAmounts.fill(0);
    this.vFirst.fill(0);
    this.hFirst.fill(0);
    this.vMulti.fill(0);
    this.hMulti.fill(0);
  }

  index(x, y) {
    return y * this.width + x;
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  record(index, first, multi, edge) {
    const existing = first[index];
    if (existing === 0) first[index] = edge;
    else if (existing !== edge) multi[index] = 1;
  }

  add(x, y, bits, edge = 0) {
    if (!this.inBounds(x, y)) return;
    const index = this.index(x, y);
    this.bits[index] |= bits;
    if (!edge) return;
    if (bits & 3) this.record(index, this.vFirst, this.vMulti, edge);
    if (bits & 12) this.record(index, this.hFirst, this.hMulti, edge);
  }

  // Two independent edges meeting at a cell: one owns the vertical arm and a
  // different one the horizontal arm, and neither turns there. A fan-out or
  // merge either has one edge contributing both arms or several edges sharing
  // an orientation, so it stays a junction.
  crossing(index) {
    const vertical = this.vFirst[index];
    const horizontal = this.hFirst[index];
    return vertical !== 0 && horizontal !== 0 &&
      !this.vMulti[index] && !this.hMulti[index] && vertical !== horizontal;
  }

  path(points, edge = 0) {
    for (let index = 0; index < points.length - 1; index++) {
      const a = points[index];
      const b = points[index + 1];
      if (a.x === b.x) {
        if (a.y === b.y) continue;
        const down = b.y > a.y;
        // Endpoints contribute only the direction used by this segment. A
        // corner then has exactly its two incident arms; only genuine
        // junctions (several edges meeting) acquire a third or fourth arm.
        this.add(a.x, a.y, down ? 2 : 1, edge);
        this.add(b.x, b.y, down ? 1 : 2, edge);
        const from = Math.min(a.y, b.y);
        const to = Math.max(a.y, b.y);
        for (let y = from + 1; y < to; y++) this.add(a.x, y, 3, edge);
      } else if (a.y === b.y) {
        const right = b.x > a.x;
        this.add(a.x, a.y, right ? 8 : 4, edge);
        this.add(b.x, b.y, right ? 4 : 8, edge);
        const from = Math.min(a.x, b.x);
        const to = Math.max(a.x, b.x);
        for (let x = from + 1; x < to; x++) this.add(x, a.y, 12, edge);
      }
    }
  }

  arrow(x, y) {
    if (!this.inBounds(x, y)) return;
    this.arrowFlags[this.index(x, y)] = 1;
  }

  flow(x, y, amount) {
    if (!this.inBounds(x, y)) return;
    const index = this.index(x, y);
    if (amount > this.flowAmounts[index]) this.flowAmounts[index] = amount;
  }
}

// drawWire runs once per frame on one layout. Reuse the backing arrays when
// the dimensions match instead of allocating a full grid every frame.
let sharedWireGrid;
function wireGridFor(width, height) {
  if (!sharedWireGrid || sharedWireGrid.width !== width || sharedWireGrid.height !== height) {
    sharedWireGrid = new WireGrid(width, height);
  } else {
    sharedWireGrid.reset();
  }
  return sharedWireGrid;
}

function wirePoints(source, target) {
  const sx = source.centerX;
  const tx = target.centerX;
  const startY = source.y + source.h;
  const bottom = target.y - 1;

  if (bottom >= startY) {
    if (sx === tx) {
      return bottom > startY ? [{ x: sx, y: startY }, { x: tx, y: bottom }] : null;
    }
    // Leave the source vertically and enter the target vertically. One shared
    // row cannot provide both stubs, so leave that shape to the router.
    if (bottom - startY < 2) return null;
    const mid = Math.min(bottom - 1, Math.max(startY + 1, Math.floor((startY + bottom) / 2)));
    return [
      { x: sx, y: startY },
      { x: sx, y: mid },
      { x: tx, y: mid },
      { x: tx, y: bottom },
    ];
  }

  // Same row (or a target above the source): exit downward, run below both
  // boxes, and enter the target from below so the source still gets a stub.
  if (sx === tx) return null;
  const runY = Math.max(startY + 1, target.y + target.h + 1);
  return [
    { x: sx, y: startY },
    { x: sx, y: runY },
    { x: tx, y: runY },
    { x: tx, y: target.y + target.h },
  ];
}

function insideBox(box, x, y) {
  return x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
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

function hasDownwardExit(points) {
  return points.length > 1 && points[1].x === points[0].x && points[1].y > points[0].y;
}

function flowCells(points) {
  const cells = [];
  for (const cell of cellsAlong(points)) {
    const last = cells.at(-1);
    if (last && last.x === cell.x && last.y === cell.y) continue;
    cells.push({ x: cell.x, y: cell.y, distance: cells.length });
  }
  return cells;
}

// Last-resort deterministic stub for a zero-gutter layout. It never crosses a
// box: prefer a downward run from the source-adjacent cell, then a short side
// exit when the cell directly below is occupied.
function fallbackWirePoints(source, target, { width, height, boxes }) {
  const blocked = (x, y) => x < 0 || y < 0 || x >= width || y >= height ||
    boxes.some(box => insideBox(box, x, y));
  const startX = source.centerX;
  const startY = source.y + source.h;
  if (!blocked(startX, startY)) {
    const limit = target.y > startY ? Math.min(height - 1, target.y - 1) : height - 1;
    let endY = startY;
    while (endY + 1 <= limit && !blocked(startX, endY + 1)) endY++;
    if (endY > startY) {
      return [{ x: startX, y: startY }, { x: startX, y: endY }];
    }
  }
  const middleY = source.y + Math.floor(source.h / 2);
  for (const side of [
    { x: source.x + source.w, y: middleY, dx: 1 },
    { x: source.x - 1, y: middleY, dx: -1 },
  ]) {
    if (blocked(side.x, side.y) || blocked(side.x + side.dx, side.y)) continue;
    return [{ x: side.x, y: side.y }, { x: side.x + side.dx, y: side.y }];
  }
  return null;
}

function pathHitsBox(points, boxes) {
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index];
    const b = points[index + 1];
    const stepX = Math.sign(b.x - a.x);
    const stepY = Math.sign(b.y - a.y);
    let x = a.x;
    let y = a.y;
    for (;;) {
      if (boxes.some(box => insideBox(box, x, y))) return true;
      if (x === b.x && y === b.y) break;
      x += stepX;
      y += stepY;
    }
  }
  return false;
}

class MinHeap {
  constructor() { this.items = []; }

  get size() { return this.items.length; }

  push(item) {
    const items = this.items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent].f <= item.f) break;
      items[index] = items[parent];
      index = parent;
    }
    items[index] = item;
  }

  pop() {
    const items = this.items;
    if (!items.length) return undefined;
    const root = items[0];
    const last = items.pop();
    if (!items.length) return root;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= items.length) break;
      const child = right < items.length && items[right].f < items[left].f ? right : left;
      if (items[child].f >= last.f) break;
      items[index] = items[child];
      index = child;
    }
    items[index] = last;
    return root;
  }
}

function routeWirePoints(source, target, { width, height, boxes, used = new Set() }) {
  const startX = source.centerX;
  const startY = source.y + source.h;
  const blocked = (x, y) => x < 0 || y < 0 || x >= width || y >= height ||
    boxes.some(box => insideBox(box, x, y));
  if (blocked(startX, startY) || blocked(startX, startY + 1)) return null;

  const entryX = target.centerX;
  const aboveY = target.y - 1;
  const belowY = target.y + target.h;
  let entryY;
  let entryDir;
  if (aboveY >= startY + 1 && !blocked(entryX, aboveY) && !blocked(entryX, aboveY - 1)) {
    entryY = aboveY;
    entryDir = 2;
  } else if (!blocked(entryX, belowY) && !blocked(entryX, belowY + 1)) {
    entryY = belowY;
    entryDir = 4;
  } else {
    return null;
  }

  const moves = [
    { dx: 0, dy: 1, dir: 2 },
    { dx: 0, dy: -1, dir: 4 },
    { dx: -1, dy: 0, dir: 3 },
    { dx: 1, dy: 0, dir: 1 },
  ];
  // Sparse scratch maps: the search only visits a corridor, so allocating and
  // filling width*height*5 entries for every edge dominated tall layouts.
  const distances = new Map();
  const previous = new Map();
  const heap = new MinHeap();
  const startState = (startY * width + startX) * 5;
  distances.set(startState, 0);
  heap.push({ x: startX, y: startY, dir: 0, g: 0, f: Math.abs(startX - entryX) + Math.abs(startY - entryY), state: startState });

  let finalState;
  while (heap.size) {
    const current = heap.pop();
    if (!current) break;
    if (current.g !== distances.get(current.state)) continue;
    if (current.x === entryX && current.y === entryY && current.dir === entryDir) {
      finalState = current.state;
      break;
    }
    for (const move of moves) {
      // The source-adjacent cell must leave the box downward before turning.
      if (current.dir === 0 && move.dir !== 2) continue;
      const x = current.x + move.dx;
      const y = current.y + move.dy;
      if (blocked(x, y)) continue;
      const turn = current.dir !== 0 && current.dir !== move.dir ? 6 : 0;
      const step = used.has(y * width + x) ? 1 : 5;
      const g = current.g + step + turn;
      const state = ((y * width + x) * 5) + move.dir;
      const known = distances.get(state);
      if (known !== undefined && g >= known) continue;
      distances.set(state, g);
      previous.set(state, current.state);
      heap.push({ x, y, dir: move.dir, g, f: g + Math.abs(x - entryX) + Math.abs(y - entryY), state });
    }
  }
  if (finalState === undefined) return null;

  const cells = [];
  for (let state = finalState; state !== undefined;) {
    const position = Math.floor(state / 5);
    const x = position % width;
    const y = Math.floor(position / width);
    cells.push({ x, y });
    state = previous.get(state);
  }
  cells.reverse();
  if (cells.length < 2) return cells;

  const points = [cells[0]];
  for (let index = 1; index < cells.length - 1; index++) {
    const before = cells[index - 1];
    const cell = cells[index];
    const after = cells[index + 1];
    const vertical = cell.x === before.x && cell.x === after.x;
    const horizontal = cell.y === before.y && cell.y === after.y;
    if (!vertical && !horizontal) points.push(cell);
  }
  points.push(cells.at(-1));
  return points;
}

function pathLength(points) {
  let length = 0;
  for (let index = 0; index < points.length - 1; index++) {
    length += Math.abs(points[index + 1].x - points[index].x) +
      Math.abs(points[index + 1].y - points[index].y);
  }
  return length;
}

// Assign `count` distinct slots (0..columns-1) to ordered desired positions,
// minimizing total distance. Convex costs make an optimal assignment
// order-preserving, so this slot DP (O(count * columns)) replaces the
// C(columns, count) depth-first enumeration that froze wide fan-out layers.
export function assignSlots(count, desired, columns) {
  const width = Math.max(0, Math.floor(Number(columns) || 0));
  const size = Math.min(Math.max(0, Math.floor(Number(count) || 0)), width);
  if (!size) return [];
  const target = desired.slice(0, size);
  let previous = new Array(width).fill(Infinity);
  const parents = Array.from({ length: size }, () => new Int32Array(width).fill(-1));
  for (let row = 0; row < size; row++) {
    const current = new Array(width).fill(Infinity);
    let bestCost = Infinity;
    let bestSlot = -1;
    for (let slot = 0; slot < width; slot++) {
      if (row === 0) {
        current[slot] = Math.abs(slot - target[row]);
        continue;
      }
      if (slot > 0 && previous[slot - 1] < bestCost) {
        bestCost = previous[slot - 1];
        bestSlot = slot - 1;
      }
      if (bestCost < Infinity) {
        current[slot] = bestCost + Math.abs(slot - target[row]);
        parents[row][slot] = bestSlot;
      }
    }
    previous = current;
  }
  let end = 0;
  for (let slot = 1; slot < width; slot++) {
    if (previous[slot] < previous[end]) end = slot;
  }
  if (!Number.isFinite(previous[end])) {
    return Array.from({ length: size }, (_, index) => Math.min(width - 1, index));
  }
  const slots = new Array(size);
  for (let row = size - 1, slot = end; row >= 0; row--) {
    slots[row] = slot;
    slot = parents[row][slot];
  }
  return slots;
}

export function computeLayout(run, width, { folded = new Set() } = {}) {
  const logicalRows = layers(run);
  const gap = width < 60 ? 2 : 4;
  const readable = 22;
  const maxBox = 34;
  const maxLayer = Math.max(1, ...logicalRows.map(layer => layer.length));
  const columns = Math.max(1, Math.min(maxLayer, Math.floor((width + gap) / (readable + gap))));
  const boxWidth = Math.max(10, Math.min(maxBox, Math.floor((width - gap * (columns - 1)) / columns)));
  const rowWidth = columns * boxWidth + (columns - 1) * gap;
  const baseX = Math.max(0, Math.floor((width - rowWidth) / 2));
  const slotX = slot => baseX + slot * (boxWidth + gap);
  const slotCenter = slot => slotX(slot) + Math.floor(boxWidth / 2);
  const centerSlot = (columns - 1) / 2;
  const parents = new Map();
  for (const edge of run.edges) {
    if (!parents.has(edge.to)) parents.set(edge.to, []);
    parents.get(edge.to).push(edge.from);
  }
  const positions = new Map();
  const boxes = new Map();
  const rowInfo = [];
  let y = 2;

  const desiredFor = node => {
    const parentPositions = (parents.get(node.id) ?? [])
      .map(id => positions.get(id))
      .filter(Number.isFinite);
    return parentPositions.length
      ? parentPositions.reduce((sum, value) => sum + value, 0) / parentPositions.length
      : centerSlot;
  };

  const chooseSlots = (count, desired) => assignSlots(count, desired, columns);

  for (const layer of logicalRows) {
    if (y > MAX_LAYOUT_ROWS) break;
    const desired = new Map(layer.map(node => [node.id, desiredFor(node)]));
    const ordered = [...layer].sort((a, b) => desired.get(a.id) - desired.get(b.id));
    for (let offset = 0; offset < ordered.length; offset += columns) {
      const group = ordered.slice(offset, offset + columns);
      const rowHeight = Math.max(...group.map(node => folded.has(node.id) ? 3 : 6));
      const placement = [];
      if (group.length === 1) {
        const node = group[0];
        const parentPositions = (parents.get(node.id) ?? [])
          .map(id => positions.get(id))
          .filter(Number.isFinite);
        const wanted = desired.get(node.id);
        const centered = parentPositions.length === 0 || Math.abs(wanted - centerSlot) < 0.3;
        const x = centered
          ? Math.max(0, Math.floor((width - boxWidth) / 2))
          : slotX(Math.max(0, Math.min(columns - 1, Math.round(wanted))));
        const centerX = x + Math.floor(boxWidth / 2);
        positions.set(node.id, (centerX - slotCenter(0)) / Math.max(1, boxWidth + gap));
        placement.push({ node, x, centerX });
      } else {
        const slots = chooseSlots(group.length, group.map(node => desired.get(node.id)));
        group.forEach((node, index) => {
          const slot = slots[index];
          const x = slotX(slot);
          const centerX = slotCenter(slot);
          positions.set(node.id, slot);
          placement.push({ node, x, centerX });
        });
      }
      const info = [];
      for (const { node, x, centerX } of placement) {
        const height = folded.has(node.id) ? 3 : 6;
        const box = { node, x, y, w: boxWidth, h: height, centerX };
        boxes.set(node.id, box);
        info.push(box);
      }
      rowInfo.push(info);
      y += rowHeight + (offset + columns < ordered.length ? 3 : 5);
    }
  }
  const height = Math.max(8, Math.min(MAX_LAYOUT_ROWS, y + 1));
  const boxesList = [...boxes.values()];
  const used = new Set();
  const edges = [];
  const markPath = points => {
    for (const cell of cellsAlong(points)) used.add(cell.y * width + cell.x);
  };
  for (const edge of run.edges) {
    const source = boxes.get(edge.from);
    const target = boxes.get(edge.to);
    if (!source || !target) continue;
    const invalid = points => !points || pathHitsBox(points, boxesList) || !hasDownwardExit(points);
    let points = wirePoints(source, target);
    let fallback = false;
    if (invalid(points)) {
      const routed = routeWirePoints(source, target, {
        width, height, boxes: boxesList, used,
      });
      if (!invalid(routed)) {
        points = routed;
      } else {
        points = fallbackWirePoints(source, target, { width, height, boxes: boxesList });
        if (!points) continue;
        fallback = true;
      }
    }
    edges.push({ from: edge.from, to: edge.to, points, length: pathLength(points), fallback });
    markPath(points);
  }
  return { width, height, rows: rowInfo, boxes, edges };
}

function drawWire(canvas, layout, { time, motion, palette }) {
  const grid = wireGridFor(layout.width, layout.height);
  layout.edges.forEach((edge, index) => {
    grid.path(edge.points, index + 1);
    if (edge.fallback) return;
    const end = edge.points.at(-1);
    grid.arrow(end.x, end.y);
  });

  if (motion) {
    layout.edges.forEach(edge => {
      const cells = flowCells(edge.points);
      const total = cells.length;
      if (total < 2) return;
      for (const cell of cells) {
        const intensity = wireShimmerIntensity(cell.distance, total, time);
        if (!intensity) continue;
        grid.flow(cell.x, cell.y, intensity);
      }
    });
  }

  // Cells owned by a node box never paint wire. A per-frame occupancy mask is
  // O(box area); the previous per-cell box scan was O(cells * boxes).
  const covered = new Uint8Array(grid.width * grid.height);
  for (const box of layout.boxes.values()) {
    const left = Math.max(0, box.x);
    const right = Math.min(grid.width, box.x + box.w);
    const top = Math.max(0, box.y);
    const bottom = Math.min(grid.height, box.y + box.h);
    if (right <= left || bottom <= top) continue;
    for (let y = top; y < bottom; y++) {
      covered.fill(1, y * grid.width + left, y * grid.width + right);
    }
  }

  const base = palette.borderHot;
  const headColor = palette.text;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const index = y * grid.width + x;
      if (covered[index]) continue;
      const bits = grid.bits[index];
      const arrow = grid.arrowFlags[index];
      if (!bits && !arrow) continue;
      const flow = grid.flowAmounts[index];
      const lit = motion && flow > 0.02;
      const glow = lit ? 0.9 * flow : 0;
      // A crossing is two independent edges meeting, not a junction. Keep the
      // vertical arm so the glyph cannot imply a dependency.
      const glyphBits = grid.crossing(index) ? bits & 3 : bits;
      canvas.put(x, y, arrow ? '▼' : WIRE_GLYPHS[glyphBits] ?? ' ', {
        fg: arrow
          ? mix(palette.accent, headColor, glow)
          : lit ? mix(base, headColor, glow) : base,
        dim: !arrow && (!lit || flow < 0.2),
        bold: lit && flow >= 0.6,
      });
    }
  }
}

function drawProgress(canvas, box, node, { time, motion, palette, connected, selected }) {
  const inner = box.w - 4;
  if (inner < 3) return;
  const color = statusColor(palette, node.state);
  const bg = selected ? palette.selection : palette.panel;
  if (!Number.isFinite(node.percent)) {
    // No recorded percent: show an empty track, never a fabricated 0% fill.
    canvas.put(box.x + 2, box.y + 2, '░'.repeat(inner), {
      fg: palette.border, dim: true, bg,
    });
    return;
  }
  const percent = Math.round(Math.max(0, Math.min(100, node.percent)));
  const bar = percentBar(percent, inner);
  canvas.put(box.x + 2, box.y + 2, bar, {
    fg: node.state === 'pending' ? palette.pending : node.state === 'blocked' ? palette.faint : color,
    dim: node.state === 'blocked',
    bg,
  });
  if (motion && percent > 0 && percent < 100 && connected) {
    const filled = Math.max(1, Math.round((percent / 100) * inner));
    const position = Math.floor((Math.sin(time / 650) * 0.5 + 0.5) * Math.max(0, filled - 1));
    const length = Math.min(3, filled - position);
    if (length > 0) {
      canvas.put(box.x + 2 + position, box.y + 2, '█'.repeat(length), {
        fg: mix(color, '#ffffff', 0.55),
        bg,
        bold: true,
      });
    }
  }
}

function drawTitle(canvas, box, node, { time, motion, palette, selected, folded }) {
  const inner = box.w - 2;
  const icon = nodeIcon(node, time, motion);
  const color = selected ? (motion ? pulse(palette.accent, time / 700, 0.35) : palette.accent) : statusColor(palette, node.state);
  const percent = Number.isFinite(node.percent) ? `${Math.round(node.percent)}%` : '—';
  const right = `${folded ? '▸' : '▾'} ${percent}`;
  const marker = selected ? '▶' : ' ';
  const room = Math.max(1, inner - textWidth(right) - 3);
  const label = fit(`${marker} ${icon} ${node.label}`, room);
  const bg = selected ? palette.selection : palette.panel;
  canvas.put(box.x + 1, box.y + 1, ' ' + label, {
    fg: color, bg, bold: selected || node.state === 'running',
  });
  canvas.put(box.x + box.w - 1 - textWidth(right), box.y + 1, right, {
    fg: selected ? palette.accent : palette.dim, bg, dim: !selected,
  });
}

function drawActivity(canvas, box, node, { time, motion, palette, now, connected, selected, language }) {
  if (box.h < 6) return;
  const inner = box.w - 4;
  if (inner < 4) return;
  const bg = selected ? palette.selection : palette.panel;
  const activity = connected ? activitySummary(nodeActivity(node), { now, language }) : null;
  let line;
  let color = palette.dim;
  if (activity) {
    line = `${activity.mark} ${activity.label}${activity.text ? ` · ${activity.text}` : ''}`;
    color = activity.stalled ? palette.warn : statusColor(palette, node.state);
  } else if (node.state === 'completed') {
    line = t(language, 'evidenceCaptured');
    color = palette.completed;
  } else if (node.state === 'failed') {
    line = `× ${node.error ?? t(language, 'failed')}`;
    color = palette.failed;
  } else if (node.state === 'blocked') {
    line = t(language, 'waitingDependencies');
    color = palette.blocked;
  } else if (node.state === 'pending') {
    line = t(language, 'queued');
    color = palette.pending;
  } else {
    line = t(language, 'idle');
    color = palette.faint;
  }
  canvas.put(box.x + 2, box.y + 3, fit(line, inner), {
    fg: color, bg, dim: node.state === 'blocked',
  });
}

function drawMeta(canvas, box, node, { palette, selected, language }) {
  if (box.h < 6) return;
  const inner = box.w - 4;
  if (inner < 6) return;
  const bg = selected ? palette.selection : palette.panel;
  const parts = [];
  if (node.model) parts.push(String(node.model).split('/').at(-1));
  if (node.turns !== undefined) parts.push(`${node.turns}t`);
  if (node.toolCalls !== undefined) parts.push(`${node.toolCalls}⚙`);
  if (node.retries) parts.push(`↻${node.retries}`);
  const line = parts.join(' · ') || (node.taskId ?? t(language, 'notLinked'));
  canvas.put(box.x + 2, box.y + 4, fit(line, inner), {
    fg: palette.faint, bg,
  });
}

export function drawGraph(canvas, layout, options) {
  const { time = 0, motion = true, palette, selectedId, folded = new Set(), now = Date.now(), connected = true, language = 'en' } = options;
  drawWire(canvas, layout, { time, motion, palette });
  for (const box of layout.boxes.values()) {
    const { node } = box;
    const selected = node.id === selectedId;
    const border = selected ? (motion ? pulse(palette.accent, time / 700, 0.35) : palette.accent) : statusColor(palette, node.state);
    canvas.box(box.x, box.y, box.w, box.h, {
      border,
      bg: selected ? palette.selection : palette.panel,
      title: undefined,
      double: selected,
    });
    drawTitle(canvas, box, node, { time, motion, palette, selected, folded: folded.has(node.id) });
    if (!folded.has(node.id)) {
      drawProgress(canvas, box, node, { time, motion, palette, connected, selected });
      drawActivity(canvas, box, node, { time, motion, palette, now, connected, selected, language });
      drawMeta(canvas, box, node, { palette, selected, language });
    }
  }
}

export { WIRE_GLYPHS, WireGrid, wirePoints, routeWirePoints, cellsAlong, pathHitsBox, MAX_LAYOUT_ROWS };

export function graphHeight(layout) {
  return layout.height;
}

export function nodeScrollTarget(layout, nodeId, viewportHeight) {
  const box = layout.boxes.get(nodeId);
  if (!box) return 0;
  const center = box.y + Math.floor(box.h / 2);
  return Math.max(0, Math.min(Math.max(0, layout.height - viewportHeight), center - Math.floor(viewportHeight / 2)));
}
