const DEFAULT_TIME_CONSTANT_MS = 90;

const LINE_KEYS = new Map([
  ['j', 1], ['down', 1], ['\x1b[B', 1],
  ['k', -1], ['up', -1], ['\x1b[A', -1],
]);
const PAGE_KEYS = new Map([
  ['pagedown', 1], ['\x1b[6~', 1],
  ['pageup', -1], ['\x1b[5~', -1],
]);
const EDGE_KEYS = new Map([
  ['home', -1], ['\x1b[H', -1], ['\x1b[1~', -1], ['g', -1],
  ['end', 1], ['\x1b[F', 1], ['\x1b[4~', 1], ['G', 1],
]);

// Pure key -> scroll intent mapping. The caller supplies the focus region and
// the current viewport metrics; this function performs no I/O and no clamping.
export function keyboardScrollTarget(key, focus, { pageSize = 1, maxScroll = 0 } = {}) {
  const region = focus === 'details' ? 'details' : focus === 'tasks' ? 'tasks' : 'graph';
  const raw = key ?? '';
  const name = String(raw).toLowerCase();
  const line = LINE_KEYS.get(raw) ?? LINE_KEYS.get(name);
  if (line !== undefined) return { region, delta: line };
  const page = PAGE_KEYS.get(raw) ?? PAGE_KEYS.get(name);
  if (page !== undefined) return { region, delta: page * Math.max(1, Math.round(pageSize)) };
  const edge = EDGE_KEYS.get(raw) ?? EDGE_KEYS.get(name);
  if (edge !== undefined) return { region, delta: edge * Math.max(0, Math.round(maxScroll)) };
  return null;
}
const DEFAULT_SNAP_DISTANCE = 1;

export function smoothScroll(current, target, elapsedMs, {
  timeConstant = DEFAULT_TIME_CONSTANT_MS,
  snapDistance = DEFAULT_SNAP_DISTANCE,
} = {}) {
  const from = Number.isFinite(current) ? current : 0;
  const to = Number.isFinite(target) ? target : from;
  if (from === to) return to;
  if (Math.abs(to - from) <= snapDistance) return to;

  const elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  const constant = Math.max(1, Number.isFinite(timeConstant) ? timeConstant : DEFAULT_TIME_CONSTANT_MS);
  const factor = 1 - Math.exp(-elapsed / constant);
  const next = from + (to - from) * factor;
  return Math.abs(to - next) < 0.01 ? to : next;
}

// Half-open pointer hit test: left/top inclusive, right/bottom exclusive.
// Iteration order is the region registration order; there is deliberately no
// default region, so an unassigned cell never scrolls anything.
export function regionAt(x, y, regions) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !regions) return null;
  for (const [id, rect] of regions) {
    if (!rect) continue;
    if (x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h) return id;
  }
  return null;
}

// Map a region offset to a one-cell-wide scrollbar thumb. The caller supplies
// the track's cell y/height; unitHeight lets the task list express its rows in
// items while the geometry stays in terminal cells.
export function scrollbarGeometry({
  y, trackHeight, viewport, content, offset, unitHeight = 1,
} = {}) {
  if (!(trackHeight > 0) || !(viewport > 0) || !(content > viewport)) return null;
  const maxOffset = content - viewport;
  const requested = Number.isFinite(offset) ? Math.round(offset) : 0;
  const clamped = Math.max(0, Math.min(maxOffset, requested));
  const thumbUnits = Math.max(
    1,
    Math.min(viewport, Math.floor((viewport * viewport) / content)),
  );
  const thumbTopUnits = Math.floor(((viewport - thumbUnits) * clamped) / maxOffset);
  return {
    y,
    h: trackHeight,
    thumbTop: y + thumbTopUnits * unitHeight,
    thumbH: thumbUnits * unitHeight,
    maxOffset,
    offset: clamped,
  };
}
