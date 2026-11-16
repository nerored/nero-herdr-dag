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
// A* routing is bounded: on a very tall wrapped graph the corridor search can
// visit hundreds of thousands of states per edge. Past this budget the edge
// falls back to the deterministic stub instead of freezing the frame.
const MAX_ROUTE_STATES = 5_000;
// The floor is per edge; small layouts can afford a much larger corridor
// search, so give the whole layout a fixed state budget instead of starving a
// 16-edge demo to keep a 185-edge stress graph bounded.
const ROUTE_STATE_BUDGET = 1_000_000;

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
//
// A raster covers one viewport window of one layout: rows [top, top + rows).
// The static arrays (bits, arrow flags, edge ownership, box coverage) are
// built once per layout and viewport; only flowAmounts is rewritten per frame
// for the shimmer. The window bounds the memory to the rows the pane can
// show, and the canvas cannot paint a cell outside the window either way,
// so clipping the raster is byte-identical to the full-height grid.
class WireRaster {
  constructor(width, height, top, rows) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.top = Math.max(0, Math.min(this.height, Math.floor(top)));
    this.rows = Math.max(0, Math.min(this.height - this.top, Math.floor(rows)));
    const size = this.width * this.rows;
    this.bits = new Uint8Array(size);
    this.arrowFlags = new Uint8Array(size);
    this.flowAmounts = new Float32Array(size);
    this.vFirst = new Uint32Array(size);
    this.hFirst = new Uint32Array(size);
    this.vMulti = new Uint8Array(size);
    this.hMulti = new Uint8Array(size);
    this.covered = new Uint8Array(size);
  }

  resetFlow() {
    this.flowAmounts.fill(0);
  }

  index(x, y) {
    return (y - this.top) * this.width + x;
  }

  inBounds(x, y) {
    return x >= 0 && y >= this.top && x < this.width && y < this.top + this.rows;
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

  // Mark every viewport row a node box occupies. Boxes outside the window
  // need no coverage: the paint loop never visits their cells.
  cover(box) {
    const left = Math.max(0, box.x);
    const right = Math.min(this.width, box.x + box.w);
    const top = Math.max(this.top, box.y);
    const bottom = Math.min(this.top + this.rows, box.y + box.h);
    if (right <= left || bottom <= top) return;
    for (let y = top; y < bottom; y++) {
      const row = (y - this.top) * this.width;
      this.covered.fill(1, row + left, row + right);
    }
  }
}

// Build the static half of the raster. Fallback edges stay unmarked exactly as
// before: an arrow on a stub would promise a route the router refused.
function buildWireRaster(layout, top, bottom) {
  const raster = new WireRaster(layout.width, layout.height, top, bottom - top);
  layout.edges.forEach((edge, index) => {
    raster.path(edge.points, index + 1);
    if (edge.fallback) return;
    const end = edge.points.at(-1);
    raster.arrow(end.x, end.y);
  });
  for (const box of layout.boxes.values()) raster.cover(box);
  return raster;
}

// The raster is a pure function of the wire geometry: the canvas size, every
// node box rectangle, and every edge's polyline plus its fallback flag (edge
// order is the edge id, which decides junction ownership). Node/label/palette
// changes do not repaint a wire. A rebound layout after a snapshot refresh has
// new objects but the same geometry, so identity alone would rebuild every
// frame; comparing geometry keeps the cache useful without ever reusing a
// raster for a moved box, a changed route or a different viewport.
function sameWireGeometry(a, b) {
  if (a.width !== b.width || a.height !== b.height) return false;
  if (a.edges.length !== b.edges.length || a.boxes.size !== b.boxes.size) return false;
  for (let index = 0; index < a.edges.length; index++) {
    const left = a.edges[index];
    const right = b.edges[index];
    if (left.fallback !== right.fallback) return false;
    if (left.points.length !== right.points.length) return false;
    for (let point = 0; point < left.points.length; point++) {
      if (left.points[point].x !== right.points[point].x) return false;
      if (left.points[point].y !== right.points[point].y) return false;
    }
  }
  for (const [id, box] of a.boxes) {
    const other = b.boxes.get(id);
    if (!other) return false;
    if (other.x !== box.x || other.y !== box.y || other.w !== box.w || other.h !== box.h) return false;
  }
  return true;
}

// Exactly one raster is retained: the previous layout becomes garbage
// instead of staying in a growing map. The cap is therefore 1 (`capacity` in
// wireRasterStats); a new layout or viewport replaces the entry.
const WIRE_RASTER_CACHE_LIMIT = 1;
let sharedWireRaster = null;
let wireRasterBuilds = 0;
let wireRasterHits = 0;

function wireRasterFor(layout, top, bottom) {
  const cached = sharedWireRaster;
  if (cached && cached.top === top && cached.bottom === bottom &&
    (cached.layout === layout || sameWireGeometry(cached.layout, layout))) {
    wireRasterHits++;
    cached.layout = layout;
    cached.raster.resetFlow();
    return cached.raster;
  }
  wireRasterBuilds++;
  const raster = buildWireRaster(layout, top, bottom);
  sharedWireRaster = { layout, top, bottom, raster };
  return raster;
}

// Instrumentation for the raster-cache tests and the memory probe: how many
// static builds this process performed, how often a frame reused one, and how
// much raster memory the single retained cache entry owns.
export function wireRasterStats() {
  const raster = sharedWireRaster?.raster;
  return {
    builds: wireRasterBuilds,
    hits: wireRasterHits,
    retained: sharedWireRaster ? 1 : 0,
    capacity: WIRE_RASTER_CACHE_LIMIT,
    width: raster?.width ?? 0,
    rows: raster?.rows ?? 0,
    top: raster?.top ?? 0,
    cells: raster ? raster.width * raster.rows : 0,
  };
}

// Drop the retained raster. Frame fixtures use this to compare a warm frame
// with the cold build; the viewer never needs it.
export function resetWireRaster() {
  sharedWireRaster = null;
  wireRasterBuilds = 0;
  wireRasterHits = 0;
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
function fallbackWirePoints(source, target, { width, height, mask }) {
  const blocked = (x, y) => x < 0 || y < 0 || x >= width || y >= height || mask[y * width + x] === 1;
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

function pathHitsBox(points, mask, width, height) {
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index];
    const b = points[index + 1];
    const stepX = Math.sign(b.x - a.x);
    const stepY = Math.sign(b.y - a.y);
    let x = a.x;
    let y = a.y;
    for (;;) {
      if (x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x]) return true;
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

function routeWirePoints(source, target, { width, height, mask, used = new Set(), maxStates = MAX_ROUTE_STATES }) {
  const startX = source.centerX;
  const startY = source.y + source.h;
  const blocked = (x, y) => x < 0 || y < 0 || x >= width || y >= height || mask[y * width + x] === 1;
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
    if (distances.size > maxStates) break;
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

// A layout is valid only for the exact geometry inputs: the run identity, the
// content width, the folded ids, and the ordered node/edge lists. The key is a
// stable string so the viewer cache, the renderer's reuse check, and the
// benchmark all share one definition; JSON keeps ids that contain separators
// unambiguous.
//
// Fold order is not geometry, so the folded ids are sorted. Node and edge
// order are geometry: a reordered layer or a reordered wire changes slots and
// routing even when the set is unchanged.
export function graphLayoutKey(run, width, { folded = new Set() } = {}) {
  return JSON.stringify([
    run?.id ?? '',
    width,
    [...folded].sort(),
    (run?.nodes ?? []).map(node => node.id),
    (run?.edges ?? []).map(edge => [edge.from, edge.to]),
  ]);
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
  let y = 2;
  let unlaid = 0;

  const desiredFor = node => {
    const parentPositions = (parents.get(node.id) ?? [])
      .map(id => positions.get(id))
      .filter(Number.isFinite);
    return parentPositions.length
      ? parentPositions.reduce((sum, value) => sum + value, 0) / parentPositions.length
      : centerSlot;
  };

  const chooseSlots = (count, desired) => assignSlots(count, desired, columns);

  for (let layerIndex = 0; layerIndex < logicalRows.length; layerIndex++) {
    const layer = logicalRows[layerIndex];
    if (y > MAX_LAYOUT_ROWS) {
      // Count every node the row cap keeps off the canvas. The renderer labels
      // this count so a capped graph never looks like the whole workflow.
      unlaid = logicalRows.slice(layerIndex).reduce((total, rest) => total + rest.length, 0);
      break;
    }
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
      for (const { node, x, centerX } of placement) {
        const height = folded.has(node.id) ? 3 : 6;
        boxes.set(node.id, { node, x, y, w: boxWidth, h: height, centerX });
      }
      y += rowHeight + (offset + columns < ordered.length ? 3 : 5);
    }
  }
  const height = Math.max(8, Math.min(MAX_LAYOUT_ROWS, y + 1));
  const boxesList = [...boxes.values()];
  // Nodes below the clamped height have no pixels on the canvas even though a
  // box exists; count them with the skipped layers so the loss is exact.
  let hiddenNodes = unlaid;
  for (const box of boxesList) if (box.y >= height) hiddenNodes += 1;
  const capped = hiddenNodes > 0;
  // One occupancy mask per layout replaces the per-cell `boxes.some(...)`
  // scan. The old scan was O(boxes) inside every Dijkstra neighbor and every
  // routed cell; with a fan-in graph that turned one layout into seconds.
  const mask = new Uint8Array(Math.max(1, width) * Math.max(1, height));
  for (const box of boxesList) {
    const left = Math.max(0, box.x);
    const right = Math.min(width, box.x + box.w);
    const top = Math.max(0, box.y);
    const bottom = Math.min(height, box.y + box.h);
    if (right <= left || bottom <= top) continue;
    for (let row = top; row < bottom; row++) mask.fill(1, row * width + left, row * width + right);
  }
  const used = new Set();
  const edges = [];
  const routeStates = Math.max(MAX_ROUTE_STATES, Math.floor(ROUTE_STATE_BUDGET / Math.max(1, run.edges.length)));
  const markPath = points => {
    for (const cell of cellsAlong(points)) used.add(cell.y * width + cell.x);
  };
  for (const edge of run.edges) {
    const source = boxes.get(edge.from);
    const target = boxes.get(edge.to);
    if (!source || !target) continue;
    const invalid = points => !points || pathHitsBox(points, mask, width, height) || !hasDownwardExit(points);
    let points = wirePoints(source, target);
    let fallback = false;
    if (invalid(points)) {
      const routed = routeWirePoints(source, target, {
        width, height, mask, used, maxStates: routeStates,
      });
      if (!invalid(routed)) {
        points = routed;
      } else {
        points = fallbackWirePoints(source, target, { width, height, mask });
        if (!points) continue;
        fallback = true;
      }
    }
    edges.push({ from: edge.from, to: edge.to, points, length: pathLength(points), fallback });
    markPath(points);
  }
  const fallbackEdges = edges.reduce((total, edge) => total + (edge.fallback ? 1 : 0), 0);
  return {
    width,
    height,
    key: graphLayoutKey(run, width, { folded }),
    boxes,
    edges,
    capped,
    hiddenNodes,
    fallbackEdges,
  };
}

// Reuse a supplied layout only when it describes exactly this frame's graph.
// The width check is explicit as well as covered by the key: a layout built
// for another pane is not the same geometry even if a caller forged a key.
// A capped layout legitimately has fewer boxes than nodes, so its hidden
// count must account for every missing box; an uncapped layout must cover the
// whole run. Hidden nodes have no box and therefore no hitbox.
export function graphLayoutMatches(layout, run, width, folded = new Set()) {
  if (!layout?.boxes || layout.width !== width) return false;
  const nodes = run?.nodes ?? [];
  if (layout.capped) {
    if (layout.boxes.size + (layout.hiddenNodes ?? 0) !== nodes.length) return false;
  } else if (layout.boxes.size !== nodes.length) {
    return false;
  }
  return layout.key === graphLayoutKey(run, width, { folded });
}

function drawWire(canvas, layout, { time, motion, palette, top = 0, bottom = layout.height }) {
  const from = Math.max(0, Math.min(layout.height, Math.floor(top)));
  const to = Math.max(from, Math.min(layout.height, Math.ceil(bottom)));
  const raster = wireRasterFor(layout, from, to);

  // Only the shimmer band changes between frames. The flow array is cleared
  // when the raster is reused and refilled with this frame's intensities.
  if (motion) {
    layout.edges.forEach(edge => {
      const cells = flowCells(edge.points);
      const total = cells.length;
      if (total < 2) return;
      for (const cell of cells) {
        const intensity = wireShimmerIntensity(cell.distance, total, time);
        if (!intensity) continue;
        raster.flow(cell.x, cell.y, intensity);
      }
    });
  }

  const base = palette.borderHot;
  const headColor = palette.text;
  for (let y = from; y < to; y++) {
    const row = (y - from) * raster.width;
    for (let x = 0; x < raster.width; x++) {
      const index = row + x;
      if (raster.covered[index]) continue;
      const bits = raster.bits[index];
      const arrow = raster.arrowFlags[index];
      if (!bits && !arrow) continue;
      const flow = raster.flowAmounts[index];
      const lit = motion && flow > 0.02;
      const glow = lit ? 0.9 * flow : 0;
      // A crossing is two independent edges meeting, not a junction. Keep the
      // vertical arm so the glyph cannot imply a dependency.
      const glyphBits = raster.crossing(index) ? bits & 3 : bits;
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
    canvas.put(box.x + 2, box.y + 2, '─'.repeat(inner), {
      fg: palette.border, dim: true, bg,
    });
    return;
  }
  const percent = Math.round(Math.max(0, Math.min(100, node.percent)));
  const bar = percentBar(percent, inner, { empty: '─' });
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
  const color = selected
    ? (motion && node.state === 'running' ? pulse(palette.accent, time / 700, 0.35) : palette.accent)
    : statusColor(palette, node.state);
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
    line = `✓ ${node.agent ?? node.taskId ?? t(language, 'evidenceCaptured')}`;
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
  const { time = 0, motion = true, palette, selectedId, folded = new Set(), now = Date.now(), connected = true, language = 'en', clip } = options;
  const top = Math.max(0, Math.floor(clip?.top ?? 0));
  const bottom = Math.min(layout.height, Math.ceil(clip?.bottom ?? layout.height));
  drawWire(canvas, layout, { time, motion, palette, top, bottom });
  for (const box of layout.boxes.values()) {
    if (box.y + box.h <= top || box.y >= bottom) continue;
    const { node } = box;
    const selected = node.id === selectedId;
    const border = selected
      ? (motion && node.state === 'running' ? pulse(palette.accent, time / 700, 0.35) : palette.accent)
      : statusColor(palette, node.state);
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

export { WIRE_GLYPHS, WireRaster, wirePoints, routeWirePoints, cellsAlong, pathHitsBox, MAX_LAYOUT_ROWS };

export function nodeScrollTarget(layout, nodeId, viewportHeight) {
  const box = layout.boxes.get(nodeId);
  if (!box) return 0;
  const center = box.y + Math.floor(box.h / 2);
  return Math.max(0, Math.min(Math.max(0, layout.height - viewportHeight), center - Math.floor(viewportHeight / 2)));
}
