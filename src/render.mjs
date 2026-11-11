import { Canvas } from './canvas.mjs';
import { runSummary } from './run-summary.mjs';
import { diagnosisFor, diagnosisPathsText } from './diagnosis.mjs';
import { computeLayout, drawGraph, nodeScrollTarget, spinnerFrame } from './graph.mjs';
import { languageLabel, statusLabel, t } from './i18n.mjs';
import {
  activitySummary, compareNavigationTasks, elapsedLabel, incoming, isActiveRun, modeFor, nodeActivity,
  nodeMap, outgoing, PROVENANCE_FIELDS, PROVENANCE_KINDS, runStats, TERMINAL,
} from './model.mjs';
import { recordTargetFor } from './records.mjs';
import { scrollbarGeometry } from './scroll.mjs';
import {
  contrastRatio, gradientCells, mix, pulse, statusColor, statusIcon,
} from './theme.mjs';
import {
  filterSwitcher, reconcileSwitcher, structuralFor, switcherItems,
} from './view-state.mjs';
import {
  charWidth as textCharWidth, clamp, clean, clock, compactDuration, fit, percentBar, segments as textSegments,
  sparkline, truncateMiddle, width as textWidth, wrap,
} from './text.mjs';
import { DEFAULT_STALE_AFTER_MS } from './config.mjs';

const HEADER_H = 3;
const FOOTER_H = 2;
// A connected capture older than this is no longer evidence of live work. The
// threshold is shared with the viewer so direct render calls and `--help`
// cannot disagree; callers may override it per frame through `ui.staleAfterMs`.
export { DEFAULT_STALE_AFTER_MS };
const displayRunName = run => run?.todoTitle || run?.name || '';
const THINKING_BODY_LINES = 5;
const ACTIVITY_DETAIL_LINES = 4;
const ACTIVITY_BODY_LINES = ACTIVITY_DETAIL_LINES + 1;
// The persisted reply is already bounded (1200 characters). This is only a
// defensive display bound so a pathological context cannot paint forever.
const REPLY_MAX_LINES = 256;

// Tasks shown in the navigation panel. Unlike standaloneTasks(), linked tasks
// are included: in real OmO sessions every root task may belong to a DAG node,
// so filtering linked tasks makes the navigation list permanently empty.
export function navTasks(snapshot) {
  return (snapshot?.tasks ?? [])
    .filter(task => !task.parentTaskId)
    .sort(compareNavigationTasks);
}

// Caller-supplied scroll offsets are untrusted input: NaN, numeric strings,
// and negatives must fall back to the top instead of poisoning slicing,
// blitting, and hitboxes with NaN coordinates.
export function scrollOffset(value, maxScroll) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return clamp(Number.isFinite(numeric) ? Math.round(numeric) : 0, 0, maxScroll);
}

// Run-block geometry shared by the painter and taskListLayout. Both used to
// recompute the heading offset, runHeight formula, two-row step, more-row, and
// bottom clamp independently, so a change to one silently shifted the other.
export function runListLayout(rect, snapshot) {
  const runs = snapshot?.runs ?? [];
  const runHeight = Math.min(
    Math.max(3, Math.floor((rect.h - 4) * 0.46)),
    runs.length * 2 + 2,
  );
  const headingY = rect.y + 1;
  const runsY = rect.y + 2;
  let y = runsY;
  let used = 0;
  for (let index = 0; index < runs.length && y + 1 < rect.y + runHeight; index++) {
    y += 2;
    used++;
  }
  if (used < runs.length) y++;
  const blockBottom = Math.max(y + 1, rect.y + runHeight + 1);
  return { headingY, runsY, runHeight, used, blockBottom, tasksY: blockBottom + 1 };
}

// Pure navigation-task geometry shared by the painter and the pointer handler.
// The task viewport starts below the run block; each row is two lines high and
// a scrollbar reserves the last column. A click resolves the row from the
// current snapshot through this helper instead of trusting a previous frame's
// hitbox id, which goes stale when a status reorder moves the rows.
export function taskListLayout(rect, snapshot, ui) {
  if (!rect) return null;
  const x = rect.x + 1;
  const w = rect.w - 2;
  const bottom = rect.y + rect.h - 1;
  const runGeometry = runListLayout(rect, snapshot);
  if (runGeometry.blockBottom >= bottom - 2) return null;
  const tasksY = runGeometry.tasksY;
  const available = bottom - tasksY;
  const taskRows = Math.max(0, Math.floor(available / 2));
  const tasks = navTasks(snapshot);
  const contentH = tasks.length;
  const maxScroll = Math.max(0, contentH - taskRows);
  const offset = scrollOffset(ui?.tasksScroll, maxScroll);
  const visible = tasks.slice(offset, offset + taskRows);
  const barGeometry = scrollbarGeometry({
    y: tasksY,
    trackHeight: taskRows * 2,
    viewport: taskRows,
    content: contentH,
    offset,
    unitHeight: 2,
  });
  const bar = barGeometry ? { x: rect.x + rect.w - 2, w: 1, ...barGeometry } : null;
  return {
    x,
    w,
    bottom,
    tasksY,
    taskRows,
    tasks,
    contentH,
    maxScroll,
    offset,
    visible,
    bar,
    contentW: bar ? w - 1 : w,
    region: taskRows > 0 ? { x, y: tasksY, w, h: taskRows * 2 } : null,
  };
}

// The navigation task painted at a cell in the current snapshot/frame geometry.
// Returns undefined for the scrollbar column, the run block, or empty space.
export function taskAtPoint(rect, snapshot, ui, x, y) {
  const geometry = taskListLayout(rect, snapshot, ui);
  if (!geometry?.taskRows) return undefined;
  if (x < geometry.x || x >= geometry.x + geometry.contentW) return undefined;
  if (y < geometry.tasksY || y >= geometry.tasksY + geometry.taskRows * 2) return undefined;
  const row = Math.floor((y - geometry.tasksY) / 2);
  return geometry.visible[row];
}

// Details are reset only when their subject changes. The key covers task focus,
// run identity, and node identity, so telemetry on the same subject keeps the
// user's scroll offset.
export function detailsSubjectKey(snapshot, ui) {
  const { kind, run, task, node } = resolveSelection(snapshot, ui, { allowRunFallback: true });
  if (kind === 'task') return `task:${task.id}`;
  if (kind === 'node') return `node:${run?.id ?? ''}:${node.id}`;
  if (kind === 'run') return `run:${run.id}`;
  return 'none';
}

export function dashboardLayout(width, height, { sidebar = true, expanded = false } = {}) {
  // Degenerate frames still return non-negative boxes. The 20x12 minimum in
  // renderApp is painting policy; this exported helper must not emit negative
  // rectangles or a body taller than the space between header and footer.
  const frameWidth = Math.max(0, Math.floor(Number(width) || 0));
  const frameHeight = Math.max(0, Math.floor(Number(height) || 0));
  const structural = structuralFor(frameWidth, { expanded });
  const header = { x: 0, y: 0, w: frameWidth, h: HEADER_H };
  const footer = { x: 0, y: frameHeight - FOOTER_H, w: frameWidth, h: FOOTER_H };
  const body = {
    x: 0, y: HEADER_H, w: frameWidth, h: Math.max(0, frameHeight - HEADER_H - FOOTER_H),
  };
  if (structural === 'expanded') {
    return {
      header,
      footer,
      body,
      sidebar: null,
      graph: null,
      details: { x: 0, y: body.y, w: frameWidth, h: body.h },
      // The overlay always owns the body; its column mode still follows the
      // same investigation breakpoint structuralFor owns.
      mode: structuralFor(frameWidth) === 'investigation' ? 'columns' : 'single',
      layout: structural,
    };
  }
  if (structural === 'investigation') {
    const sidebarW = clamp(Math.round(frameWidth * 0.22), 26, 34);
    const detailsW = clamp(Math.round(frameWidth * 0.30), 34, 44);
    const gap = 1;
    if (!sidebar) {
      const graphW = frameWidth - detailsW - gap;
      return {
        header,
        footer,
        body,
        sidebar: null,
        graph: { x: 0, y: body.y, w: graphW, h: body.h },
        details: { x: graphW + gap, y: body.y, w: detailsW, h: body.h },
        mode: 'columns',
        layout: structural,
      };
    }
    const graphW = frameWidth - sidebarW - detailsW - gap * 2;
    return {
      header,
      footer,
      body,
      sidebar: { x: 0, y: body.y, w: sidebarW, h: body.h },
      graph: { x: sidebarW + gap, y: body.y, w: graphW, h: body.h },
      details: { x: sidebarW + gap + graphW + gap, y: body.y, w: detailsW, h: body.h },
      mode: 'columns',
      layout: structural,
    };
  }
  // Duty: one subject-first panel. Below the investigation breakpoint the
  // graph canvas is omitted instead of squeezed into ten rows; the same
  // details offset and subject key survive a resize across the boundary.
  return {
    header,
    footer,
    body,
    sidebar: null,
    graph: null,
    details: { x: 0, y: body.y, w: frameWidth, h: body.h },
    mode: 'single',
    layout: structural,
  };
}

// A cached layout is reusable only while it describes exactly the current
// run's node set. A changed or emptied run is recomputed instead of keeping
// ghost boxes and clickable hitboxes for nodes that no longer exist.
function graphLayoutMatches(layout, run) {
  const nodes = run?.nodes ?? [];
  if (!layout?.boxes || layout.boxes.size !== nodes.length) return false;
  return nodes.every(node => layout.boxes.has(node.id));
}

// A cached layout keeps its geometry between snapshots, but every box must
// point at the current run's node object. Rebuild the map with shallow-copied
// boxes so the caller's cache is never mutated.
function bindGraphLayout(layout, run) {
  const nodes = new Map((run?.nodes ?? []).map(node => [node.id, node]));
  const boxes = new Map();
  let rebound = false;
  for (const [id, box] of layout.boxes) {
    const node = nodes.get(id);
    if (!node) continue;
    if (node === box.node) {
      boxes.set(id, box);
      continue;
    }
    rebound = true;
    boxes.set(id, { ...box, node });
  }
  return rebound ? { ...layout, boxes } : layout;
}

// drawGraph owns a full-layout canvas. Reuse its cell objects between frames
// of the same dimensions and repaint every cell, instead of allocating a new
// width×height object grid on each frame.
let sharedGraphCanvas;
function graphCanvasFor(width, height, palette) {
  if (!sharedGraphCanvas || sharedGraphCanvas.width !== width || sharedGraphCanvas.height !== height) {
    sharedGraphCanvas = new Canvas(width, height, { fg: palette.text, bg: palette.panel });
  } else {
    sharedGraphCanvas.defaults = { fg: palette.text, bg: palette.panel };
    sharedGraphCanvas.fill(0, 0, width, height, { fg: palette.text, bg: palette.panel });
  }
  return sharedGraphCanvas;
}

// renderDetails/renderDuty measure by painting the whole body on a tall scratch
// canvas, then blit the visible window. Reuse the two cell grids across frames
// of the same dimensions and repaint every cell instead of allocating a new
// width×2048 object grid (and its cell objects) on every frame.
const scratchCanvases = { body: undefined, inner: undefined };
function scratchCanvas(slot, width, height, palette) {
  const current = scratchCanvases[slot];
  if (!current || current.width !== width || current.height !== height) {
    scratchCanvases[slot] = new Canvas(width, height, { fg: palette.text, bg: palette.panel });
    return scratchCanvases[slot];
  }
  current.defaults = { fg: palette.text, bg: palette.panel };
  current.fill(0, 0, width, height, { fg: palette.text, bg: palette.panel });
  return current;
}

function rich(canvas, x, y, width, parts, palette, bg) {
  let cursor = x;
  let left = width;
  for (const item of parts) {
    if (left <= 0) break;
    const part = Array.isArray(item) ? { text: item[0], ...(item[1] ?? {}) } : item;
    const source = String(part.text ?? '');
    const shown = textWidth(source) > left ? fit(source, left) : source;
    canvas.put(cursor, y, shown, {
      fg: part.fg ?? palette.text,
      bg: part.bg ?? bg,
      bold: part.bold,
      dim: part.dim,
      italic: part.italic,
    });
    const used = textWidth(shown);
    cursor += used;
    left -= used;
    if (textWidth(source) > used) break;
  }
}

function panel(canvas, rect, title, { palette, focused = false, badge } = {}) {
  const badgeText = badge ? ` ${fit(badge, Math.max(1, Math.floor(rect.w * 0.45)))} ` : '';
  canvas.fill(rect.x, rect.y, rect.w, rect.h, { bg: palette.panel, fg: palette.text });
  canvas.box(rect.x, rect.y, rect.w, rect.h, {
    border: focused ? palette.borderHot : palette.border,
    bg: palette.panel,
    title: fit(title, Math.max(1, rect.w - 6 - textWidth(badgeText))),
    titleColor: focused ? palette.accent : palette.dim,
  });
  if (badgeText) {
    canvas.put(rect.x + rect.w - 1 - textWidth(badgeText), rect.y, badgeText, {
      fg: palette.dim, bg: palette.panel,
    });
  }
}

// Every status color has one of pure black or pure white above 4.5:1, so the
// pill foreground is chosen per background instead of assuming a dark theme.
// The WCAG math lives in theme.mjs; an unparseable/transparent surface has no
// ratio (theme returns null), and white is the established fallback there.
export function pillForeground(background) {
  const white = contrastRatio('#ffffff', background);
  const black = contrastRatio('#000000', background);
  if (white === null || black === null) return '#ffffff';
  return white >= black ? '#ffffff' : '#000000';
}

// Glyph + word + color stay redundant: the pill owns the word, the glyph is
// repeated beside it, and the background keeps carrying the color signal.
function pill(canvas, x, y, label, color, glyph) {
  const text = ` ${glyph ? `${glyph} ` : ''}${label} `;
  canvas.put(x, y, text, { fg: pillForeground(color), bg: color, bold: true });
  return x + textWidth(text);
}

function drawScrollbar(canvas, bar, palette) {
  if (!bar) return;
  for (let row = 0; row < bar.h; row++) {
    const y = bar.y + row;
    // A wide glyph's continuation cell owns this column; skip the decoration
    // rather than corrupt the frame width.
    if (canvas.cell(bar.x, y)?.cont) continue;
    const thumb = y >= bar.thumbTop && y < bar.thumbTop + bar.thumbH;
    canvas.put(bar.x, y, thumb ? '█' : '░', {
      fg: thumb ? palette.accent2 : palette.border,
      bg: palette.panel,
      dim: !thumb,
      bold: thumb,
    });
  }
}

// THINKING and ACTIVITY are atomic fixed blocks: a heading plus exactly five
// body rows, or nothing. Their headings are located in the measured body so a
// scroll window never exposes a heading with a clipped body.
function fixedSectionRows(body, language) {
  const labels = [t(language, 'thinking'), t(language, 'activity')]
    .map(label => label.toUpperCase());
  const rows = [];
  for (let row = 2; row < body.height; row++) {
    for (const label of labels) {
      const span = textWidth(label);
      let text = '';
      for (let column = 2; column < 2 + span; column++) {
        text += body.cells[row][column]?.ch ?? '';
      }
      if (text === label) {
        rows.push(row);
        break;
      }
    }
  }
  return rows;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  // 999,950 already rounds to 1.0m; the k branch must not print "1000.0k".
  if (magnitude >= 999_950) return `${(value / 1_000_000).toFixed(1)}m`;
  if (magnitude >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

// Rates are telemetry, not counts: a 0.4 tokens/s reading is not zero. Keep
// one decimal from 1 upward and two below it, trimming only trailing zeros.
function formatRate(value) {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return formatNumber(value);
  if (magnitude >= 10) return String(Math.round(value));
  const text = value.toFixed(magnitude >= 1 ? 1 : 2);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

// Unknown telemetry is an em dash, never a fabricated zero.
function metricValue(value) {
  return value === undefined ? '—' : formatNumber(value);
}

function formatCost(value) {
  if (!Number.isFinite(value)) return undefined;
  return value.toFixed(Math.abs(value) < 0.1 ? 4 : 2);
}

function agoLabel(ms, language) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1500) return t(language, 'now');
  return t(language, 'ago', { time: compactDuration(ms, language) });
}

function runColor(run, palette) {
  if (run.status === 'running') return palette.running;
  if (run.status === 'failed') return palette.failed;
  if (run.status === 'completed') return palette.completed;
  return palette.pending;
}

// One mode contract for the header, freshness, record resolution, and the
// diagnosis copy. model.modeFor owns the demo/legacy/saved precedence.
const snapshotMode = modeFor;

function isActiveSnapshot(snapshot) {
  return snapshotMode(snapshot) !== 'saved' && snapshot?.connected !== false;
}

// One freshness contract for the header, footer, elapsed labels, and empty
// states. Saved and demo captures keep their existing rules; only a connected
// live capture can become stale.
export function snapshotFreshness(snapshot, { now = Date.now(), staleAfterMs } = {}) {
  const threshold = Number.isFinite(Number(staleAfterMs)) && Number(staleAfterMs) >= 0
    ? Number(staleAfterMs)
    : DEFAULT_STALE_AFTER_MS;
  const mode = snapshotMode(snapshot);
  const active = mode !== 'saved' && snapshot?.connected !== false;
  const capturedAtMs = Date.parse(snapshot?.provenance?.capturedAt);
  const captured = Number.isFinite(capturedAtMs) ? capturedAtMs : undefined;
  const ageMs = captured === undefined ? undefined : Math.max(0, now - captured);
  const stale = Boolean(active && ageMs !== undefined && ageMs > threshold);
  return {
    mode,
    active,
    capturedAtMs: captured,
    ageMs,
    stale,
    staleAfterMs: threshold,
    frozenNow: stale ? captured : now,
  };
}

function modeName(mode, language) {
  return t(language, mode === 'demo' ? 'modeDemo' : mode === 'saved' ? 'modeSaved' : 'modeLive');
}

function modeBadge(snapshot, language, freshness = snapshotFreshness(snapshot)) {
  const mode = snapshotMode(snapshot);
  if (mode === 'demo') return `◆ ${t(language, 'modeDemo')}`;
  if (mode === 'saved') return `○ ${t(language, 'modeSaved')}`;
  if (snapshot?.connected === false) return `○ ${t(language, 'modeWaiting')}`;
  if (freshness.stale) return `▲ ${t(language, 'modeStale')}`;
  return `● ${t(language, 'modeLive')}`;
}

function modeColor(snapshot, palette, time, motion, freshness = snapshotFreshness(snapshot)) {
  const mode = snapshotMode(snapshot);
  if (mode === 'demo') return palette.accent2;
  if (mode === 'saved') return palette.faint;
  if (snapshot?.connected === false) return palette.warn;
  if (freshness.stale) return palette.warn;
  return motion ? pulse(palette.good, time / 700, 0.4) : palette.good;
}

// The header age must survive 54 columns, so it uses the largest whole unit
// (8h, 5m, 3s) instead of the full h/m/s clock form. The detail surfaces keep
// the exact clock where precision is useful.
function compactAge(ms, language) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const zh = language === 'zh' || language === 'zh-cn';
  if (total >= 3600) return `${Math.floor(total / 3600)}${zh ? '小时' : 'h'}`;
  if (total >= 60) return `${Math.floor(total / 60)}${zh ? '分' : 'm'}`;
  return `${total}${zh ? '秒' : 's'}`;
}

function capturedAgoLabel(snapshot, now, language) {
  const captured = snapshot?.provenance?.capturedAt;
  const at = captured ? Date.parse(captured) : NaN;
  if (!Number.isFinite(at)) return undefined;
  const age = Math.max(0, now - at);
  return age < 1500
    ? t(language, 'capturedAt', { time: t(language, 'now') })
    : t(language, 'capturedAgo', { time: compactAge(age, language) });
}

function capturedDisplay(value) {
  if (!value) return undefined;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return `${new Date(at).toISOString().slice(0, 19)}Z`;
}

function shortPath(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const home = process.env.HOME;
  if (home && value === home) return '~';
  if (home && value.startsWith(`${home}/`)) return `~/${value.slice(home.length + 1)}`;
  return value;
}

function entityState(entity) {
  return entity?.state ?? entity?.status;
}

function isFailureState(state) {
  return ['failed', 'error', 'cancelled', 'lost', 'interrupted', 'blocked'].includes(state);
}

function provenanceValue(entry, language) {
  if (!entry || !PROVENANCE_KINDS.has(entry.kind)) return t(language, 'provenanceUnavailable');
  if (entry.kind === 'recorded') {
    return entry.from
      ? t(language, 'provenanceRecordedFrom', { source: entry.from })
      : t(language, 'provenanceRecorded');
  }
  if (entry.kind === 'derived') {
    return entry.from ? t(language, 'provenanceFrom', { source: entry.from }) : t(language, 'provenanceDerived');
  }
  if (entry.kind === 'simulated') return t(language, 'provenanceSimulated');
  if (entry.kind === 'unknown') return t(language, 'provenanceUnknown');
  return t(language, 'provenanceUnavailable');
}

function agentLabel(entity, language) {
  const entry = entity?.provenance?.agent;
  if (!entity?.agent) {
    if (entity?.category && entry?.kind === 'derived') {
      return t(language, 'agentCategory', { value: entity.category });
    }
    return t(language, 'agentNotRecorded');
  }
  if (entry?.kind === 'derived' && entry.from === 'category') {
    return t(language, 'agentCategory', { value: entity.agent });
  }
  if (entry?.kind === 'derived' && entry.from === 'agent_type') {
    return t(language, 'agentType', { value: entity.agent });
  }
  return entity.agent;
}

function modelLabel(entity, language) {
  return entity?.model ?? t(language, 'modelNotRecorded');
}

function percentInfo(entity, language, counts) {
  const entry = entity?.provenance?.percent;
  const state = entityState(entity);
  // Only a model-computed `derived` entry is derived. A legacy v1/v2 snapshot
  // carries `unknown` provenance for an explicit percent, and an explicit
  // `unavailable` entry can still own a finite value; both keep the numeric
  // label instead of claiming a provenance the producer never supplied.
  const derived = entry?.kind === 'derived';
  const completedDerived = derived && state === 'completed';
  const derivedStatusLabel = value => t(language, 'percentDerivedStatus', { value });
  // Completed status is a recorded fact. Without a recorded percent the only
  // honest completion value is a derived 100%; a recorded value always wins.
  if (!Number.isFinite(entity?.percent) && state === 'completed') {
    const value = 100;
    const label = derivedStatusLabel(value);
    return { known: true, derived: true, value, label, compact: label };
  }
  if (Number.isFinite(entity?.percent)) {
    const value = Math.round(Math.max(0, Math.min(100, entity.percent)));
    const label = derived
      ? (completedDerived && value === 100
        ? derivedStatusLabel(value)
        : t(language, 'percentDerived', { value }))
      : `${value}%`;
    return { known: true, derived, value, label, compact: label };
  }
  const running = entityState(entity) === 'running';
  // Done/total is the honest progress signal when the producer supplies no
  // percentage. It appends after the exact "percent not recorded" phrase so
  // both the narrow and wide layouts keep the same claim.
  const suffix = counts && Number.isFinite(counts.done) && Number.isFinite(counts.total)
    ? ` · ${counts.done}/${counts.total}` : '';
  return {
    known: false,
    running,
    label: running
      ? `${t(language, 'percentInProgress')}${suffix}`
      : t(language, 'percentUnavailable'),
    // The full in-progress label is wider than a 36-column details body; the
    // stacked layout keeps the same honest statement without truncation.
    shortLabel: running
      ? `${t(language, 'percentNotRecorded')}${suffix}`
      : t(language, 'percentUnavailable'),
  };
}

// done/total for the progress row: a task uses its child checklist when one is
// recorded, otherwise the run that owns its node supplies the node counts.
function progressCounts(snapshot, task, run) {
  const children = task?.children ?? [];
  if (children.length) {
    return {
      done: children.filter(child => TERMINAL.has(child.status)).length,
      total: children.length,
    };
  }
  if (run) {
    const stats = runStats(run);
    return { done: stats.done, total: stats.total };
  }
  for (const candidate of snapshot?.runs ?? []) {
    if (candidate.nodes.some(node => node.taskId === task?.id)) {
      const stats = runStats(candidate);
      return { done: stats.done, total: stats.total };
    }
  }
  return undefined;
}

// Percent unknown is not percent zero. A running subject gets an indeterminate
// sweep: one lit segment travels over the honest empty track. With motion off
// the segment holds a static position, so the track still reads as active
// rather than filled. The caller keeps the explicit unknown-percent label.
function drawIndeterminateBar(canvas, x, y, width, {
  time = 0, motion = true, palette, color, bg, dim = false,
}) {
  const columns = Math.max(0, Math.floor(width));
  if (!columns) return;
  const segment = Math.max(1, Math.min(3, Math.round(columns / 6)));
  const travel = columns - segment;
  const position = motion
    ? Math.round((Math.sin(time / 650) * 0.5 + 0.5) * travel)
    : Math.floor(travel / 2);
  canvas.put(x, y, '░'.repeat(columns), { fg: palette.border, bg, dim: true });
  canvas.put(x + position, y, '█'.repeat(segment), {
    fg: color ?? palette.accent, bg, bold: !dim, dim,
  });
}

// Shared progress block. A known percent keeps its filled track and numeric
// label. An unknown percent on a running subject gets the indeterminate sweep
// plus the explicit label, inline when it fits and on its own row when not.
function progressBlock(canvas, x, y, w, progress, {
  time = 0, motion = true, palette, color, bg, bold = false,
}) {
  if (progress.known) {
    const labelW = textWidth(progress.label);
    // A derived-status label can be wider than the narrow details body. Put
    // the bar on its own row instead of truncating the truth away.
    if (labelW + 8 > w) {
      rich(canvas, x, y, w, [
        [percentBar(progress.value, Math.max(6, w)), { fg: color, bold }],
      ], palette, bg);
      rich(canvas, x, y + 1, w, [
        [progress.label, { fg: palette.text, bold: true }],
      ], palette, bg);
      return y + 2;
    }
    const barW = Math.max(6, w - labelW - 2);
    rich(canvas, x, y, w, [
      [percentBar(progress.value, barW), { fg: color, bold }],
      [` ${progress.label}`, { fg: palette.text, bold: true }],
    ], palette, bg);
    return y + 1;
  }
  if (!progress.running) {
    rich(canvas, x, y, w, [[progress.label, { fg: palette.faint, dim: true }]], palette, bg);
    return y + 1;
  }
  const labelW = textWidth(progress.label);
  if (w >= labelW + 8) {
    const barW = Math.max(6, w - labelW - 2);
    drawIndeterminateBar(canvas, x, y, barW, { time, motion, palette, color, bg });
    rich(canvas, x + barW + 1, y, w - barW - 1, [
      [progress.label, { fg: palette.text, bold: true }],
    ], palette, bg);
    return y + 1;
  }
  drawIndeterminateBar(canvas, x, y, w, { time, motion, palette, color, bg });
  rich(canvas, x, y + 1, w, [
    [progress.shortLabel ?? progress.label, { fg: palette.text, bold: true }],
  ], palette, bg);
  return y + 2;
}

// One empty-state headline decision shared by every empty body. Freshness is a
// frame fact: a stale capture says STALE instead of claiming a live connection,
// and a capture with no recorded timestamp has no fresh-connection evidence.
function emptyStateLabel(snapshot, language, freshness = snapshotFreshness(snapshot)) {
  const mode = snapshotMode(snapshot);
  if (mode === 'saved') return t(language, 'emptySaved');
  if (mode === 'demo') return t(language, 'emptyDemo');
  if (snapshot?.connected === false) return t(language, 'emptyWaiting');
  if (freshness.capturedAtMs === undefined) return t(language, 'waitingSnapshot');
  if (freshness.stale) return `${t(language, 'modeStale')} · ${t(language, 'noWorkflow')}`;
  return t(language, 'emptyConnected');
}

// The source-health and connected-empty surfaces are shared by the graph,
// details, duty, and overview painters. They are defined once here so every
// branch can name the watched path, capture age, and next action without
// fabricating a subject.
function renderEmptyState(canvas, x, y, w, h, snapshot, {
  palette, language, now, freshness = snapshotFreshness(snapshot, { now }),
}) {
  const mode = snapshotMode(snapshot);
  const path = shortPath(snapshot?.provenance?.statePath) ?? t(language, 'provenanceUnavailable');
  const age = capturedAgoLabel(snapshot, now, language) ?? t(language, 'provenanceUnavailable');
  const headline = emptyStateLabel(snapshot, language, freshness);
  let lines;
  if (mode === 'saved') {
    lines = [
      [headline, { fg: palette.dim }],
      [t(language, 'emptySavedHint', {
        time: capturedDisplay(snapshot?.provenance?.capturedAt) ?? '—', path,
      }), { fg: palette.faint, dim: true }],
    ];
  } else if (mode === 'demo') {
    lines = [[headline, { fg: palette.dim }]];
  } else if (snapshot?.connected !== false) {
    lines = freshness.stale
      ? [
        [headline, { fg: palette.warn, bold: true }],
        [t(language, 'emptyConnectedHint', { path, age }), { fg: palette.faint }],
        // Not "wait for the producer": a stale capture is no longer live, and
        // the next step is to check the path and retry.
        [t(language, 'emptyWaitingNext'), { fg: palette.dim }],
      ]
      : [
        [headline, { fg: palette.accent2, bold: true }],
        [t(language, 'emptyConnectedHint', { path, age }), { fg: palette.faint }],
        [t(language, 'emptyConnectedNext'), { fg: palette.dim }],
      ];
  } else {
    // A failed read keeps its error and watched path in the frame instead of
    // living only in a transient footer toast. The retry line states what the
    // viewer keeps doing while it waits, so WAITING never looks like a dead end.
    const readError = snapshot?.readError?.message ?? snapshot?.readError;
    lines = [
      [headline, { fg: palette.warn, bold: true }],
      [t(language, 'emptyWaitingHint', { path, age }), { fg: palette.faint }],
      ...(readError ? [[t(language, 'emptyWaitingError', { error: readError }), { fg: palette.failed }]] : []),
      [t(language, 'emptyWaitingRetry'), { fg: palette.dim }],
      [t(language, 'emptyWaitingNext'), { fg: palette.dim }],
    ];
  }
  let row = y;
  for (const [text, style] of lines) {
    if (row >= y + h) break;
    row = detailLine(canvas, x, row, w, [[text, style]], palette);
  }
  // Health is part of the empty contract too: a connected producer may still
  // have a broken store, and a never-read viewer must say it has no health
  // evidence rather than implying the store is fine. A heading without room
  // for one source row is omitted rather than painted over the panel border.
  if (mode !== 'saved' && mode !== 'demo' && row < y + h) {
    if (snapshot?.sources?.length) {
      if (row + 1 < y + h) {
        row = sourceHealthSection(canvas, x, row, w, snapshot, {
          palette, language, now, bottom: y + h,
        });
      }
    } else {
      row = detailLine(canvas, x, row, w, [
        [t(language, 'sourceHealthUnavailable'), { fg: palette.faint, dim: true }],
      ], palette);
    }
  }
  return row;
}

// Source health is producer vocabulary, so its status tokens and count words
// are translated instead of leaking the raw store status into the panel.
// Unknown values keep their token: a future producer state must stay visible
// rather than disappear behind a generic label.
const SOURCE_STATUS_KEYS = {
  ok: 'sourceStatusOk',
  missing: 'sourceStatusMissing',
  empty: 'sourceStatusEmpty',
  unreadable: 'sourceStatusUnreadable',
};

function sourceStatusLabel(language, status) {
  if (status === undefined || status === null) return t(language, 'provenanceUnavailable');
  const key = SOURCE_STATUS_KEYS[status];
  return key ? t(language, key) : String(status);
}

function sourceHealthSection(canvas, x, y, w, snapshot, {
  palette, language, now = Date.now(), bottom = Infinity,
}) {
  if (y >= bottom) return y;
  y = detailSection(canvas, x, y, w, t(language, 'sourceHealth'), palette);
  const color = status => (status === 'unreadable' ? palette.failed : status === 'ok' ? palette.completed : palette.warn);
  const write = parts => {
    if (y < bottom) y = detailLine(canvas, x, y, w, parts, palette);
  };
  // The panel words are already translated; lower-casing keeps the English
  // count rows in their established lowercase form while zh gets 任务/运行.
  const tasksLabel = t(language, 'tasks').toLowerCase();
  const runsLabel = t(language, 'runs').toLowerCase();
  for (const source of snapshot?.sources ?? []) {
    if (y >= bottom) return y;
    const label = source.label ?? source.id ?? source.root ?? t(language, 'provenanceUnavailable');
    write([
      [`${label} `, { fg: palette.text, bold: true }],
      [sourceStatusLabel(language, source.status), { fg: color(source.status), bold: true }],
    ]);
    if (source.tasks) {
      const counts = source.tasks;
      const accepted = t(language, 'sourceCountAccepted', { count: counts.accepted });
      const foreign = t(language, 'sourceCountForeign', { count: counts.foreign });
      const invalid = t(language, 'sourceCountInvalid', { count: counts.invalid });
      const full = `${accepted} · ${foreign} · ${invalid}`;
      if (textWidth(`${tasksLabel} ${full}`) <= w) {
        write([
          [`${tasksLabel} `, { fg: palette.faint }], [full, { fg: palette.dim }],
        ]);
      } else {
        write([
          [`${tasksLabel} `, { fg: palette.faint }],
          [`${accepted} · ${foreign}`, { fg: palette.dim }],
        ]);
        write([
          ['  ', { fg: palette.faint }], [invalid, { fg: palette.dim }],
        ]);
      }
    }
    if (source.runs) {
      const counts = source.runs;
      write([
        [`${runsLabel} `, { fg: palette.faint }],
        [`${counts.accepted}/${counts.foreign}/${counts.invalid}`, { fg: palette.dim }],
        [`  ${t(language, 'sourceFields')} ${counts.files}`, { fg: palette.faint }],
      ]);
    }
    const scannedAt = source.scannedAt ? Date.parse(source.scannedAt) : NaN;
    if (Number.isFinite(scannedAt)) {
      write([[t(language, 'sourceScanned', {
        time: agoLabel(Math.max(0, now - scannedAt), language),
      }), { fg: palette.faint }]]);
    }
    if (source.root) {
      write([[shortPath(source.root), { fg: palette.faint, dim: true }]]);
    }
    if (source.error) {
      write([[source.error, { fg: palette.failed }]]);
    }
  }
  return y;
}

function sourceSection(canvas, x, y, w, entity, snapshot, {
  palette, language, verbose = false, now = Date.now(), freshness,
}) {
  y = detailSection(canvas, x, y, w, t(language, 'sourceSection'), palette);
  const provenance = snapshot?.provenance ?? {};
  const mode = snapshotMode(snapshot);
  // Freshness is a frame fact, not a snapshot-mode fact. A stale capture keeps
  // its origin and version rows but never prints the live mode that the
  // header already replaced with STALE.
  const view = freshness ?? snapshotFreshness(snapshot, { now });
  const write = (label, value, style = { fg: palette.dim }) => {
    y = detailLine(canvas, x, y, w, [[`${label}  `, { fg: palette.faint }], [String(value), style]], palette);
  };
  write(t(language, 'sourceMode'), view.stale ? t(language, 'modeStale') : modeName(mode, language), {
    fg: view.stale ? palette.warn : modeColor(snapshot, palette, 0, false, view),
    bold: mode === 'demo' && !view.stale,
  });
  write(t(language, 'sourceOrigin'), provenance.origin ?? t(language, 'provenanceUnavailable'));
  const captured = capturedDisplay(provenance.capturedAt);
  if (captured) write(t(language, 'capturedAt', { time: '' }).trim(), captured);
  const statePath = shortPath(provenance.statePath);
  if (statePath) write(t(language, 'sourceSnapshot'), statePath);
  const roots = new Set();
  const taskDir = shortPath(provenance.taskStateDir);
  if (taskDir) roots.add(taskDir);
  for (const source of snapshot?.sources ?? []) {
    const root = shortPath(source.root);
    if (root) roots.add(root);
  }
  for (const root of roots) write(t(language, 'sourceTaskStore'), root);
  write(t(language, 'sourceVersion'), String(snapshot?.version ?? '—'));
  for (const field of PROVENANCE_FIELDS) {
    const entry = entity?.provenance?.[field];
    if (!entry) continue;
    if (!verbose && (entry.kind === 'recorded' || entry.kind === 'simulated')) continue;
    write(field, provenanceValue(entry, language), {
      fg: entry.kind === 'recorded' || entry.kind === 'simulated' ? palette.text : palette.faint,
      dim: entry.kind === 'unavailable',
    });
  }
  return y;
}

function renderSidebar(canvas, rect, snapshot, ui, { time, now, palette, motion, language }, hitboxes) {
  const x = rect.x + 1;
  const w = rect.w - 2;
  const bottom = rect.y + rect.h - 1;
  let y = rect.y + 1;
  const runs = snapshot.runs;
  const runGeometry = runListLayout(rect, snapshot);
  rich(canvas, x, y, w, [
    [t(language, 'runs'), { fg: palette.accent2, bold: true }],
    [`  ${runs.length}`, { fg: palette.faint }],
  ], palette, palette.panel);
  y = runGeometry.runsY;
  for (let index = 0; index < runs.length && y + 1 < rect.y + runGeometry.runHeight; index++) {
    const run = runs[index];
    const selected = index === ui.runIndex;
    if (selected) canvas.fill(x, y, w, 2, { bg: palette.selection, fg: palette.text });
    const bg = selected ? palette.selection : palette.panel;
    const icon = isActiveRun(run) && motion ? spinnerFrame(time) : statusIcon(run.status === 'failed' ? 'failed' : run.status === 'completed' ? 'completed' : run.status);
    const stats = runStats(run);
    rich(canvas, x, y, w, [
      [`${selected ? '▸' : ' '} `, { fg: selected ? palette.accent : palette.faint, bold: selected }],
      [`${icon} `, { fg: runColor(run, palette), bold: true }],
      [displayRunName(run), { fg: selected ? palette.white : palette.text, bold: selected }],
    ], palette, bg);
    const barWidth = Math.max(4, w - 16);
    const bar = stats.percentKnown ? percentBar(stats.percent, barWidth) : '░'.repeat(barWidth);
    rich(canvas, x + 2, y + 1, w - 2, [
      [bar, { fg: runColor(run, palette), dim: !selected }],
      [stats.percentKnown ? ` ${stats.percent}%` : ' —', { fg: selected ? palette.accent : palette.faint }],
      [` · ${stats.done}/${stats.total}`, { fg: palette.dim }],
    ], palette, bg);
    hitboxes.runs.set(run.id, { x, y, w, h: 2 });
    y += 2;
  }
  if (runGeometry.used < runs.length) {
    rich(canvas, x, y, w, [[t(language, 'more', { count: runs.length - runGeometry.used }), { fg: palette.faint, dim: true }]], palette, palette.panel);
    y++;
  }
  y = runGeometry.blockBottom;
  const taskGeometry = taskListLayout(rect, snapshot, ui);
  if (!taskGeometry) return null;
  const { tasks, tasksY, taskRows, contentH, maxScroll, offset, visible, bar, contentW } = taskGeometry;
  rich(canvas, taskGeometry.x, tasksY - 1, taskGeometry.w, [
    [t(language, 'tasks'), { fg: palette.accent2, bold: true }],
    [`  ${tasks.length}`, { fg: palette.faint }],
  ], palette, palette.panel);
  y = tasksY;
  for (const task of visible) {
    const selected = ui.focus === 'tasks' && task.id === ui.selectedTaskId;
    if (selected) canvas.fill(taskGeometry.x, y, contentW, 2, { bg: palette.selection, fg: palette.text });
    const bg = selected ? palette.selection : palette.panel;
    const icon = task.status === 'running' && motion ? spinnerFrame(time) : statusIcon(task.status);
    rich(canvas, taskGeometry.x, y, contentW, [
      [`${selected ? '▸' : ' '} `, { fg: selected ? palette.accent : palette.faint, bold: selected }],
      [`${icon} `, { fg: statusColor(palette, task.status), bold: true }],
      [task.description, { fg: selected ? palette.white : palette.text }],
    ], palette, bg);
    const counts = progressCounts(snapshot, task);
    const progressInfo = percentInfo(task, language, counts);
    const barX = taskGeometry.x + 2;
    if (progressInfo.known) {
      const percentLabel = progressInfo.compact ?? `${progressInfo.value}%`;
      const progressWidth = Math.max(4, contentW - 2 - textWidth(percentLabel) - 1);
      rich(canvas, barX, y + 1, contentW - 2, [
        [percentBar(progressInfo.value, progressWidth), {
          fg: statusColor(palette, task.status), dim: !selected,
        }],
        [` ${percentLabel}`, { fg: palette.faint }],
      ], palette, bg);
    } else if (progressInfo.running) {
      // Unknown percent on a running task: the list row cannot fit the full
      // label, so the moving segment plus done/total stay honest.
      const progressWidth = Math.max(4, contentW - 14);
      drawIndeterminateBar(canvas, barX, y + 1, progressWidth, {
        time, motion, palette, color: statusColor(palette, task.status), bg, dim: !selected,
      });
      rich(canvas, barX + progressWidth, y + 1, contentW - 2 - progressWidth, [
        [' —', { fg: palette.faint }],
        ...(counts && counts.total > 0 ? [[` ${counts.done}/${counts.total}`, { fg: palette.faint }]] : []),
      ], palette, bg);
    } else {
      const progressWidth = Math.max(4, contentW - 14);
      rich(canvas, barX, y + 1, contentW - 2, [
        ['░'.repeat(progressWidth), { fg: statusColor(palette, task.status), dim: !selected }],
        [' —', { fg: palette.faint }],
        ...(task.agent && w >= 34 ? [[` · ${task.agent}`, { fg: palette.dim }]] : []),
      ], palette, bg);
    }
    hitboxes.tasks.set(task.id, { x: taskGeometry.x, y, w: contentW, h: 2 });
    y += 2;
  }
  drawScrollbar(canvas, bar, palette);
  const below = contentH - offset - visible.length;
  if (below > 0 && y < bottom - 1) {
    rich(canvas, taskGeometry.x, y, contentW, [[t(language, 'more', { count: below }), { fg: palette.faint, dim: true }]], palette, palette.panel);
  }
  return {
    region: taskGeometry.region,
    viewportH: taskRows,
    contentH,
    offset,
    maxScroll,
    bar,
  };
}

function graphPanel(canvas, rect, snapshot, run, ui, {
  time, now, viewNow = now, palette, motion, language, graphLayout, freshness,
}) {
  const stats = run ? runStats(run) : null;
  const selectedTask = navTasks(snapshot).find(candidate => candidate.id === ui.selectedTaskId);
  const unlinked = Boolean(ui.selectedTaskUnlinked && selectedTask);
  panel(canvas, rect, t(language, unlinked ? 'taskOverview' : 'graph'), {
    palette,
    focused: ui.focus === 'graph',
    badge: unlinked
      ? t(language, 'noNodeShort')
      : run
        ? (stats.percentKnown
          ? t(language, 'graphBadge', { nodes: stats.total, running: stats.counts.running ?? 0, percent: stats.percent })
          : t(language, 'graphBadgeCounts', {
            nodes: stats.total, running: stats.counts.running ?? 0, done: stats.done, total: stats.total,
          }))
        : t(language, 'noRun'),
  });
  if (unlinked) {
    const color = statusColor(palette, selectedTask.status);
    const lines = [
      [[`${statusIcon(selectedTask.status)} `, { fg: color, bold: true }], [statusLabel(language, selectedTask.status), { fg: color, bold: true }]],
      [[selectedTask.description, { fg: palette.text, bold: true }]],
      [[`${t(language, 'tokens')} `, { fg: palette.faint }], [t(language, 'tokensInOut', {
        in: metricValue(selectedTask.tokensIn), out: metricValue(selectedTask.tokensOut),
      }), { fg: palette.accent }]],
      [[`${t(language, 'turns')} `, { fg: palette.faint }], [metricValue(selectedTask.turns), { fg: palette.text }],
        [' · ', { fg: palette.faint }], [`${t(language, 'tools')} `, { fg: palette.faint }], [metricValue(selectedTask.toolCalls), { fg: palette.text }]],
      [[t(language, 'noNodeShort'), { fg: palette.warn }]],
    ];
    let y = rect.y + 2;
    for (const line of lines) {
      if (y >= rect.y + rect.h - 1) break;
      y = detailLine(canvas, rect.x + 2, y, Math.max(8, rect.w - 4), line, palette);
    }
    return { layout: null, scroll: 0, maxScroll: 0, viewportH: Math.max(1, rect.h - 2), nodeRects: new Map(), contentH: 0, bar: null };
  }
  if (!run) {
    renderEmptyState(canvas, rect.x + 2, rect.y + 2, rect.w - 4, rect.h - 3, snapshot, {
      palette, language, now, freshness,
    });
    return { layout: null, scroll: 0, maxScroll: 0, viewportH: 1, nodeRects: new Map(), contentH: 0, bar: null };
  }
  const innerX = rect.x + 1;
  const innerY = rect.y + 1;
  const innerW = rect.w - 2;
  const innerH = rect.h - 2;
  const contentX = innerX + 1;
  const contentW = Math.max(8, innerW - 2);
  const depsH = 2;
  const viewportH = Math.max(3, innerH - depsH);
  let layout;
  try {
    layout = graphLayout && graphLayoutMatches(graphLayout, run)
      ? bindGraphLayout(graphLayout, run)
      : computeLayout(run, contentW, { folded: ui.folded });
  } catch (error) {
    rich(canvas, innerX + 1, innerY + 1, innerW - 2, [
      [t(language, 'graphError', { error: error.message }), { fg: palette.failed, bold: true }],
    ], palette, palette.panel);
    return { layout: null, scroll: 0, maxScroll: 0, viewportH, nodeRects: new Map(), contentH: 0, bar: null };
  }
  const maxScroll = Math.max(0, layout.height - viewportH);
  const scroll = scrollOffset(ui.graphScroll, maxScroll);
  const offset = layout.height <= viewportH ? Math.floor((viewportH - layout.height) / 2) : -scroll;
  const graphCanvas = graphCanvasFor(layout.width, layout.height, palette);
  drawGraph(graphCanvas, layout, {
    time, motion, palette, selectedId: ui.selectedNodeId, folded: ui.folded,
    now: viewNow, connected: isActiveSnapshot(snapshot), language,
  });
  canvas.blit(graphCanvas, contentX, innerY + offset, {
    x: contentX, y: innerY, w: contentW, h: viewportH,
  });
  const nodeRects = new Map();
  for (const box of layout.boxes.values()) {
    const top = innerY + offset + box.y;
    const bottom = top + box.h;
    const visibleTop = Math.max(innerY, top);
    const visibleBottom = Math.min(innerY + viewportH, bottom);
    if (visibleBottom <= visibleTop) continue;
    nodeRects.set(box.node.id, {
      x: contentX + box.x,
      y: visibleTop,
      w: box.w,
      h: visibleBottom - visibleTop,
    });
  }
  const separatorY = rect.y + rect.h - depsH - 1;
  canvas.hline(rect.x + 1, separatorY, rect.w - 2, { fg: palette.border, bg: palette.panel });
  const selected = run.nodes.find(node => node.id === ui.selectedNodeId);
  const names = id => nodeMap(run).get(id)?.label ?? id;
  let dependencyLine = t(language, 'edgesNodes', { edges: run.edges.length, nodes: stats.total });
  if (selected) {
    const from = incoming(run, selected.id).map(names);
    const to = outgoing(run, selected.id).map(names);
    dependencyLine = t(language, 'depsLine', {
      from: from.length ? from.join(', ') : t(language, 'start'),
      to: to.length ? to.join(', ') : t(language, 'end'),
    });
  }
  rich(canvas, rect.x + 2, separatorY + 1, rect.w - 4, [
    [dependencyLine, { fg: selected ? palette.accent : palette.faint, dim: !selected }],
  ], palette, palette.panel);
  const barGeometry = scrollbarGeometry({
    y: innerY,
    trackHeight: viewportH,
    viewport: viewportH,
    content: layout.height,
    offset: scroll,
  });
  const bar = barGeometry ? { x: rect.x + rect.w - 2, w: 1, ...barGeometry } : null;
  drawScrollbar(canvas, bar, palette);
  return { layout, scroll, maxScroll, viewportH, nodeRects, contentH: layout.height, bar };
}

function detailSection(canvas, x, y, w, label, palette) {
  rich(canvas, x, y, w, [
    [label.toUpperCase(), { fg: palette.accent2, bold: true }],
    [' ', { fg: palette.faint }],
    ['─'.repeat(Math.max(0, w - textWidth(label) - 1)), { fg: palette.border }],
  ], palette, palette.panel);
  return y + 1;
}

function detailLine(canvas, x, y, w, parts, palette) {
  rich(canvas, x, y, w, parts, palette, palette.panel);
  return y + 1;
}

// The axis slot is a time axis: only samples with real timestamps define a
// span, so a timestamp-less series leaves it blank instead of painting a
// sample count where elapsed time belongs.
function rateAxisLabel(history) {
  const times = (Array.isArray(history) ? history : [])
    .map(sample => Date.parse(sample?.at))
    .filter(Number.isFinite);
  if (times.length < 2) return '';
  const seconds = Math.max(1, Math.round((times.at(-1) - times[0]) / 1000));
  return `-${seconds}s`;
}

function rateKindLabel(kind, language) {
  if (kind === 'instant') return t(language, 'instantRate');
  if (kind === 'average') return t(language, 'averageRate');
  return t(language, 'historyRate');
}

function tokenRateLine(canvas, x, y, w, rate, kind, palette, language, history, labelWidth = 0) {
  if (!Array.isArray(rate) || !rate.length) return y;
  const label = t(language, 'tokenRate');
  const valueX = metricValueX(x, w, labelWidth);
  const valueW = metricValueWidth(w, labelWidth);
  const historyValues = Array.isArray(history) && history.length >= 2 ? history.map(sample => sample.rate) : undefined;
  const values = historyValues?.length ? historyValues : rate;
  const single = values.length < 2;
  // A constant series is not a trend. It keeps the same zero-padded width but
  // paints one flat strip, names its sampling (constant, or tick-sampled when
  // it came from repeated live ticks), and suppresses the peak and time axis
  // that would otherwise imply measured variation.
  const constant = !single && values.every(value => value === values[0]);
  // A legacy series without sample timestamps carries no time information, so
  // it is named constant. Only a timestamped-but-irregular producer ring is
  // labelled tick-sampled.
  const samples = Array.isArray(history) && history.length >= 2 ? history : undefined;
  const timed = samples?.some(sample => Number.isFinite(Date.parse(sample.at)));
  const tickSampled = constant && Boolean(samples) && !timed;
  // A bare sample count is not a time axis. Keep the axis only when the series
  // carries real timestamps, and stay flat for a constant series.
  const realHistory = Boolean(samples) && Boolean(timed);
  const axis = constant || !realHistory ? '' : rateAxisLabel(history);
  // One observation is an instant/average reading rather than a distribution,
  // so it keeps its truthful kind label and omits the history peak. Every
  // multi-sample surface keeps a kind label too, including a flat series.
  const kindLabel = single
    ? (kind === 'instant' || kind === 'average' || kind === 'history' ? rateKindLabel(kind, language) : undefined)
    : constant
      ? (tickSampled ? t(language, 'rateTickSampled') : t(language, 'rateConstant'))
      : rateKindLabel(kind, language);
  const reading = single ? `${formatRate(values[0])}/s` : '';
  const peak = single || constant ? '' : t(language, 'peak', { value: formatRate(Math.max(...values)) });
  const kindWidth = kindLabel ? textWidth(` (${kindLabel})`) : 0;
  const fixed = textWidth(reading) + kindWidth + textWidth(axis) + textWidth(peak) + 4;
  // Keep the truthful peak and kind visible even in a narrow details pane. If
  // the kind cannot share the first row, or the peak cannot share the axis,
  // move them to a continuation aligned under the value column.
  const stackKind = Boolean(kindLabel) && textWidth(reading) + kindWidth >= valueW;
  const stacked = Boolean(peak && fixed + 4 > valueW) || stackKind;
  const reserved = stacked
    ? textWidth(reading) + kindWidth + textWidth(axis) + 4
    : fixed;
  // N5 bound: the producer ring caps at 32 samples (task-data). The chart owns
  // the same bounded width for every kind; a constant series paints one flat
  // strip rather than synthesizing variation from unpainted leading slots.
  const chartWidth = Math.max(4, Math.min(18, valueW - reserved));
  const chartValues = values.length >= chartWidth
    ? values.slice(-chartWidth)
    : [...Array(chartWidth - values.length).fill(0), ...values];
  const chart = constant ? '▁'.repeat(chartWidth) : sparkline(chartValues, chartWidth);
  const firstLine = [
    [chart, { fg: palette.accent }],
    ...(reading ? [[` ${reading}`, { fg: palette.accent, bold: true }]] : []),
    ...(kindLabel && !stackKind ? [[` (${kindLabel})`, { fg: palette.faint }]] : []),
    ...(axis ? [[`  ${axis}`, { fg: palette.faint, dim: true }]] : []),
    ...(!stacked && peak ? [[`  ${peak}`, { fg: palette.warn }]] : []),
  ];
  canvas.put(x, y, label, { fg: palette.faint });
  const next = detailLine(canvas, valueX, y, valueW, firstLine, palette);
  if (!stacked) return next;
  const continuation = [
    ...(stackKind ? [[` (${kindLabel})`, { fg: palette.faint }]] : []),
    ...(peak ? [[`  ${peak}`, { fg: palette.warn }]] : []),
  ];
  return detailLine(canvas, valueX, next, valueW, continuation, palette);
}

// Cache reads, their hit rate, and cost share one metric row. The ratio is the
// primary value; cost drops to a continuation line when both cannot fit.
function cacheLine(canvas, x, y, w, entity, palette, language, labelWidth = 0) {
  const valueX = metricValueX(x, w, labelWidth);
  const valueW = metricValueWidth(w, labelWidth);
  const costUnreported = entity.costUsd !== undefined
    && entity.costStatus !== undefined && entity.costStatus !== 'reported';
  const hasCost = entity.costUsd !== undefined || costUnreported;
  const hit = entity.cacheHitRate === undefined
    ? undefined
    : `${(entity.cacheHitRate * 100).toFixed(1)}%`;
  let ratio;
  if (entity.cacheReadTokens !== undefined && entity.totalTokens !== undefined) {
    ratio = `${formatNumber(entity.cacheReadTokens)}/${formatNumber(entity.totalTokens)}`;
  } else if (entity.cacheReadTokens !== undefined) {
    ratio = formatNumber(entity.cacheReadTokens);
  } else if (entity.totalTokens !== undefined) {
    ratio = formatNumber(entity.totalTokens);
  }
  const core = [ratio, hit ? `(${hit})` : undefined].filter(Boolean).join(' ');
  const cost = costUnreported ? '$ -'
    : hasCost ? t(language, 'costValue', { value: formatCost(entity.costUsd) }) : undefined;
  if (!core && !cost) return y;
  const stackCost = Boolean(core && cost && textWidth(core) + 3 + textWidth(cost) > valueW);
  const valueParts = [];
  if (core) valueParts.push([core, { fg: palette.completed }]);
  if (cost && !stackCost) {
    if (valueParts.length) valueParts.push([' · ', { fg: palette.faint }]);
    valueParts.push([cost, { fg: palette.warn }]);
  }
  canvas.put(x, y, t(language, 'cacheReuseShort'), { fg: palette.faint });
  let next = detailLine(canvas, valueX, y, valueW, valueParts, palette);
  if (stackCost) {
    next = metricRow(canvas, x, next, w, t(language, 'cost'), [[cost, { fg: palette.warn }]], palette, labelWidth);
  }
  return next;
}

// Retry counts are evidence, not a default. An inferred zero from
// run_stats.turns is labeled derived, an explicit failed_turns/retries keeps
// its recorded source, and a missing count stays unknown rather than painting
// a recorded-looking zero.
function retrySourceLabel(from) {
  if (from === undefined || from === null || from === '') return undefined;
  const tail = String(from).split('.').at(-1);
  return tail ? tail.replaceAll('_', ' ') : undefined;
}

function retryInfo(entity, language) {
  const value = entity?.retries ?? entity?.failedTurns;
  const entry = entity?.provenance?.retries;
  const kind = entry?.kind;
  const knownKind = kind === 'recorded' || kind === 'derived' || kind === 'simulated';
  if (value === undefined || !knownKind) {
    return { known: false, value: undefined, text: t(language, 'failedTurnsNotRecorded') };
  }
  const source = retrySourceLabel(entry.from);
  let suffix;
  if (kind === 'derived') {
    suffix = source ? t(language, 'retriesDerivedFrom', { source }) : t(language, 'provenanceDerived');
  } else if (kind === 'simulated') {
    suffix = t(language, 'provenanceSimulated');
  } else {
    suffix = source ? t(language, 'retriesRecordedFrom', { source }) : t(language, 'provenanceRecorded');
  }
  return {
    known: true,
    value,
    suffix,
    text: `${t(language, 'retries')} ${value} (${suffix})`,
  };
}

// The metrics block is a small definition list: one shared label column keeps
// every value on the same cell column.
function labelWidthFor(labels) {
  return Math.max(0, ...labels.map(textWidth)) + 1;
}

function metricLabelWidth(language) {
  return labelWidthFor([
    t(language, 'tokens'),
    t(language, 'tokenRate'),
    t(language, 'cacheReuseShort'),
    t(language, 'retries'),
    t(language, 'turns'),
    t(language, 'tools'),
  ]);
}

function metricValueX(x, w, labelWidth) {
  return x + Math.min(labelWidth, Math.max(1, w - 8));
}

function metricValueWidth(w, labelWidth) {
  return Math.max(1, w - Math.min(labelWidth, Math.max(1, w - 8)));
}

function metricRow(canvas, x, y, w, label, parts, palette, labelWidth) {
  const valueX = metricValueX(x, w, labelWidth);
  if (label) canvas.put(x, y, label, { fg: palette.faint });
  return detailLine(canvas, valueX, y, Math.max(1, x + w - valueX), parts, palette);
}

function metricsSection(canvas, x, y, w, entity, palette, language) {
  const subject = entity ?? {};
  const labelWidth = metricLabelWidth(language);
  y = detailSection(canvas, x, y, w, t(language, 'metrics'), palette);
  y = metricRow(canvas, x, y, w, t(language, 'tokens'), [
    [t(language, 'tokensInOut', {
      in: metricValue(subject.tokensIn),
      out: metricValue(subject.tokensOut),
    }), { fg: palette.accent2, bold: true }],
  ], palette, labelWidth);
  y = tokenRateLine(canvas, x, y, w, subject.tokenRate, subject.tokenRateKind, palette, language,
    subject.tokenRateHistory, labelWidth);
  y = cacheLine(canvas, x, y, w, subject, palette, language, labelWidth);
  const retry = retryInfo(subject, language);
  const retryValue = retry.known ? metricValue(retry.value) : retry.text;
  const retryStyle = retry.known
    ? { fg: Number(retry.value) > 0 ? palette.warn : palette.faint, bold: Number(retry.value) > 0 }
    : { fg: palette.faint };
  const retryFull = retry.known ? `${retryValue} (${retry.suffix})` : retryValue;
  const valueW = metricValueWidth(w, labelWidth);
  const retryLines = textWidth(retryFull) <= valueW
    ? [retryFull]
    : retry.known
      ? [retryValue, ...wrap(retry.suffix, valueW)]
      : wrap(retryValue, valueW);
  y = metricRow(canvas, x, y, w, t(language, 'retries'), [
    [retryLines[0], retryStyle],
  ], palette, labelWidth);
  for (const line of retryLines.slice(1)) {
    y = metricRow(canvas, x, y, w, '', [[line, { fg: palette.faint }]], palette, labelWidth);
  }
  y = metricRow(canvas, x, y, w, t(language, 'turns'), [
    [metricValue(subject.turns), { fg: palette.text, bold: true }],
    [' · ', { fg: palette.faint }],
    [`${t(language, 'tools')} `, { fg: palette.faint }],
    [metricValue(subject.toolCalls), { fg: palette.accent3, bold: true }],
  ], palette, labelWidth);
  return y;
}

function errorSourceLine(canvas, x, y, w, entity, palette, language) {
  if (!entity.error || (entity.errorSource === undefined && entity.errorKind === undefined)) return y;
  const source = entity.errorSource !== undefined
    ? t(language, 'errorSource', { value: entity.errorSource }) : undefined;
  const kind = entity.errorKind !== undefined
    ? t(language, 'errorKind', { value: entity.errorKind }) : undefined;
  const combined = [source, kind].filter(Boolean).join(' · ');
  if (!kind || !source || textWidth(combined) <= w) {
    return detailLine(canvas, x, y, w, [[combined, { fg: palette.faint }]], palette);
  }
  y = detailLine(canvas, x, y, w, [[source, { fg: palette.faint }]], palette);
  return detailLine(canvas, x, y, w, [[kind, { fg: palette.faint }]], palette);
}

function fixedBodyLines(canvas, x, y, w, count, lines, palette, style = {}) {
  const shown = (lines ?? []).slice(-count);
  for (let index = 0; index < count; index++) {
    const line = shown[index];
    if (line) {
      canvas.put(x, y, fit(line, w), {
        fg: style.fg ?? palette.text,
        bg: palette.panel,
        dim: style.dim,
      });
    } else {
      canvas.fill(x, y, w, 1, { fg: palette.text, bg: palette.panel });
    }
    y++;
  }
  return y;
}

const REPLY_PLACEHOLDERS = new Set([
  'no reply', 'no reply captured', 'no response', 'no output',
  'none', 'n a', 'na', 'null', 'undefined', 'reply', 'response',
  'ok', 'okay', '暂无回复', '无回复', '没有回复', '无输出',
]);

function replyKey(value) {
  return clean(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\[\d{1,3}:\d{2}(?::\d{2})?\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const REPLY_TEMPLATE = /^(?:(?:reply|response|working on|finished|blocked on|waiting on|done|completed|failed|running|pending|回复|响应|正在|已完成|完成|失败|阻塞于|等待)\s*)+/u;

function stripReplyTemplate(value) {
  return value
    .replace(REPLY_TEMPLATE, '')
    .replace(/(?:working on|finished|blocked on|waiting on|reply|response|正在|已完成|完成|失败|阻塞于|等待)/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeVisible(residue, visible) {
  if (!visible) return residue;
  if (residue === visible) return '';
  // Chinese text is not whitespace-delimited; remove it as a substring.
  if (/\p{Script=Han}/u.test(visible)) {
    return residue.split(visible).join(' ').replace(/\s+/g, ' ').trim();
  }
  // Latin text is phrase-delimited so a short label cannot erase "api" in "rapid".
  return (` ${residue} `)
    .split(` ${visible} `).join(' ')
    .replace(/\s+/g, ' ').trim();
}

export function meaningfulReply(reply, {
  thinking, label, description, progress, activityText, error,
  children = [], logs = [], verbose = false,
} = {}) {
  let residue = replyKey(reply);
  if (!residue || REPLY_PLACEHOLDERS.has(residue)) return false;
  if (!/[\p{L}\p{N}]/u.test(residue)) return false;

  // "ok ok ok" and equivalent one-token echoes add no information.
  const words = residue.split(' ');
  if (words.length > 1 && words.every(word => word === words[0])) return false;

  // Remove text that is already painted in this details pane. Logs are only
  // visible in verbose mode, so they only participate in that mode.
  const visible = [
    thinking, label, description, progress, activityText, error,
    ...(children ?? []).map(child => child?.description),
    ...(verbose ? (logs ?? []) : []),
  ]
    .map(replyKey)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const text of visible) residue = removeVisible(residue, text);

  residue = stripReplyTemplate(residue);
  return Boolean(residue) && /[\p{L}\p{N}]/u.test(residue);
}

// REPLY is verbose-only and is painted as its own section after ACTIVITY. It is
// never nested under THINKING: the reasoning block stays self-contained even
// when a terminal task has no reply recorded.
function replyOutput(canvas, x, y, w, bottom, source, palette, language, { verbose = true, record } = {}) {
  const rawThinking = source.thinking ?? source.task?.thinking;
  const rawReply = source.reply ?? source.task?.reply;
  const replyTruncated = source.replyTruncated ?? source.task?.replyTruncated;
  const replyBytes = source.replyBytes ?? source.task?.replyBytes;
  const reply = meaningfulReply(rawReply, {
    thinking: rawThinking,
    label: source.label,
    description: source.description ?? source.task?.description ?? source.label,
    progress: source.progress ?? source.task?.progress,
    activityText: nodeActivity(source)?.text,
    error: source.error ?? source.task?.error,
    children: source.children ?? source.task?.children,
    logs: source.logs ?? source.task?.logs,
    verbose,
  }) ? rawReply : null;
  const terminal = TERMINAL.has(entityState(source));
  if (reply && y < bottom - 1) {
    // The details pane already scrolls; show the whole persisted excerpt
    // instead of its last 4 lines.
    y = detailSection(canvas, x, y, w, t(language, 'reply'), palette);
    const lines = wrap(reply, w - 2);
    for (const line of lines.slice(0, REPLY_MAX_LINES)) {
      if (y >= bottom) return y;
      y = detailLine(canvas, x, y, w, [[line, { fg: palette.text }]], palette);
    }
    if (replyTruncated) {
      if (y >= bottom) return y;
      const marker = replyBytes !== undefined
        ? t(language, 'replyTruncated', { bytes: replyBytes })
        : t(language, 'replyTruncatedUnknown');
      y = detailLine(canvas, x, y, w, [[marker, { fg: palette.faint, dim: true, italic: true }]], palette);
    }
    if (replyTruncated && y < bottom) {
      // The persisted reply is bounded by design. Point at the read-only raw
      // record that carries the whole final_response, and say so explicitly
      // when no safe record is available instead of advertising a fake open.
      // Only the task record carries the whole final_response. A checkpoint
      // fallback is still openable, but it must not be advertised as the
      // source of the full reply.
      const fullReplyRecord = record?.openKey === 'task';
      y = detailLine(canvas, x, y, w, [[
        t(language, fullReplyRecord ? 'replyRecordOpen' : 'replyRecordUnavailable'),
        { fg: fullReplyRecord ? palette.accent2 : palette.faint, dim: !fullReplyRecord, italic: !fullReplyRecord },
      ]], palette);
    }
    if (lines.length > REPLY_MAX_LINES) {
      if (y >= bottom) return y;
      y = detailLine(canvas, x, y, w, [[t(language, 'replyExcerptLimited', { lines: REPLY_MAX_LINES }), {
        fg: palette.faint, dim: true, italic: true,
      }]], palette);
    }
  } else if (terminal && rawReply === undefined && y < bottom - 1) {
    y = detailSection(canvas, x, y, w, t(language, 'reply'), palette);
    y = detailLine(canvas, x, y, w, [[t(language, 'replyNotRecorded'), { fg: palette.faint, dim: true }]], palette);
  }
  return y;
}

function thinkingOutput(canvas, x, y, w, bottom, source, palette, language) {
  const rawThinking = source.thinking ?? source.task?.thinking;
  const terminal = TERMINAL.has(entityState(source));
  if (y + 1 + THINKING_BODY_LINES <= bottom) {
    // Atomic fixed block: heading + exactly 5 body rows, or nothing. A reply
    // is never reused here; absent reasoning says so explicitly.
    y = detailSection(canvas, x, y, w, t(language, 'thinking'), palette);
    const body = rawThinking ? wrap(rawThinking, w - 2)
      : [t(language, terminal ? 'thinkingNotRecorded' : 'thinkingNotYet')];
    y = fixedBodyLines(canvas, x, y, w, THINKING_BODY_LINES, body, palette, {
      fg: rawThinking ? palette.dim : palette.faint,
      dim: !rawThinking,
    });
  }
  return y;
}

function linkedNodeForTask(snapshot, taskId) {
  for (const run of snapshot?.runs ?? []) {
    const node = run.nodes.find(candidate => candidate.taskId === taskId);
    if (node) return { run, node };
  }
  return undefined;
}

function terminalTimeDisplay(value) {
  const at = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) return undefined;
  return `${new Date(at).toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return undefined;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function diagnosisColor(palette, state) {
  if (state === 'failed' || state === 'error') return palette.failed;
  if (state === 'blocked') return palette.blocked;
  if (state === 'paused') return palette.paused;
  return palette.dim;
}

function diagnosisReason(diagnosis, language) {
  if (diagnosis.reason) return { text: diagnosis.reason, missing: false };
  if (diagnosis.blockedBy.length) {
    return {
      text: t(language, 'diagnosisBlockedBy', {
        nodes: diagnosis.blockedBy
          .map(upstream => `${upstream.label} (${statusLabel(language, upstream.state)})`)
          .join(', '),
      }),
      missing: false,
    };
  }
  const key = diagnosis.state === 'failed' || diagnosis.state === 'error'
    ? 'errorNotRecorded' : 'diagnosisReasonMissing';
  return { text: t(language, key), missing: true };
}

function diagnosisLast(diagnosis, language) {
  const activity = diagnosis.lastActivity;
  if (!activity) return { text: t(language, 'diagnosisLastMissingShort'), missing: true };
  if (activity.kind === 'tool') {
    return {
      text: diagnosis.beforeStopMs !== undefined
        ? t(language, 'diagnosisLastTool', {
          tool: activity.tool, time: compactDuration(diagnosis.beforeStopMs, language),
        })
        : t(language, 'diagnosisLastToolRecorded', { tool: activity.tool }),
      missing: false,
    };
  }
  return {
    text: t(language, 'diagnosisLastActivity', { text: activity.text }).replace(/^activity\s+/u, ''),
    missing: false,
  };
}

function diagnosisRetry(diagnosis, language, { compact = false } = {}) {
  const parts = [];
  if (diagnosis.failedTurns === undefined && diagnosis.retries === undefined) {
    parts.push(t(language, 'diagnosisRetriesMissing'));
  }
  if (diagnosis.failedTurns !== undefined) {
    parts.push(t(language, 'diagnosisFailedTurns', { count: diagnosis.failedTurns }));
  }
  if (diagnosis.retries !== undefined && diagnosis.retries !== diagnosis.failedTurns) {
    parts.push(t(language, 'diagnosisRetries', { count: diagnosis.retries }));
  }
  if (diagnosis.attempt !== undefined) parts.push(t(language, 'attempt', { count: diagnosis.attempt }));
  parts.push(t(language, compact ? 'diagnosisOmOShort' : 'diagnosisOmO'));
  return parts.join(' · ');
}

function diagnosisSourceParts(diagnosis, language, palette) {
  const tone = diagnosisColor(palette, diagnosis.state);
  const parts = [];
  for (const source of diagnosis.statusSources) {
    const token = source.token === 'task#status' ? t(language, 'diagnosisTaskStatus')
      : source.token === 'node#state' ? t(language, 'diagnosisNodeState')
        : source.token === 'simulated' ? t(language, 'diagnosisSimulated') : source.token;
    if (parts.length) parts.push([' · ', { fg: palette.faint }]);
    parts.push([`${token} ${statusLabel(language, source.state).toUpperCase()}`, {
      fg: tone, bold: !diagnosis.simulated,
    }]);
  }
  if (diagnosis.mismatch) {
    if (parts.length) parts.push([' · ', { fg: palette.faint }]);
    parts.push([t(language, 'diagnosisStatusMismatch'), { fg: palette.warn, bold: true }]);
  }
  if (parts.length) parts.push([' · ', { fg: palette.faint }]);
  parts.push([modeName(diagnosis.mode, language), { fg: palette.faint, dim: true }]);
  return parts;
}

// The record rows come from the same per-source resolver as the `o` action, so
// a task in a secondary store names its real root instead of the provenance
// root that diagnosisFor would have assumed.
function diagnosisRecordText(diagnosis, language, record) {
  const entries = record?.records ?? diagnosis.records;
  const paths = entries
    .filter(entry => entry.key === 'task' || entry.key === 'checkpoint')
    .map(entry => entry.display ?? entry.absolute)
    .filter(Boolean);
  return paths.length ? paths.join(' · ') : t(language, 'diagnosisRecordMissing');
}

function diagnosisEvidenceText(diagnosis, width, language) {
  const artifact = diagnosis.artifact;
  if (!artifact?.display) return { text: t(language, 'diagnosisArtifactMissing'), missing: true };
  const path = width < 40 ? artifact.name : artifact.display;
  const size = formatBytes(artifact.bytes);
  let text = size ? t(language, 'diagnosisArtifact', { path, size }) : path;
  if (width >= 50 && artifact.sha256) {
    text += ` · ${t(language, 'diagnosisArtifactSha', { sha: artifact.sha256.slice(0, 8) })}`;
  }
  return { text, missing: false };
}

function styledTokens(parts) {
  const tokens = [];
  for (const [value, style] of parts) {
    for (const segment of textSegments(value)) {
      const size = textCharWidth(segment);
      if (size > 0) tokens.push({ text: segment, style: style ?? {}, width: size });
    }
  }
  return tokens;
}

function trimStyledLine(line) {
  let start = 0;
  while (start < line.length && /^\s+$/u.test(line[start].text)) start++;
  return line.slice(start);
}

// Fit a styled line with a trailing ellipsis, keeping each token's own tone.
function ellipsizeStyledLine(line, columns) {
  const limit = columns - 1;
  const kept = [];
  let used = 0;
  for (const token of line) {
    if (used + token.width > limit) break;
    kept.push(token);
    used += token.width;
  }
  const style = kept.at(-1)?.style ?? line[0]?.style ?? {};
  kept.push({ text: '…', style, width: 1 });
  return kept;
}

// Wrap styled parts with the same word-break rules as wrap(), but keep every
// part's color, bold, and dim attributes instead of flattening the row to the
// first style.
function wrapStyled(parts, columns, maxLines) {
  if (columns <= 0) return [];
  const lines = [];
  let line = [];
  let lineWidth = 0;
  for (const token of styledTokens(parts)) {
    const size = token.width;
    if (line.length && lineWidth + size > columns) {
      let space = -1;
      for (let index = line.length - 1; index >= 0; index--) {
        if (line[index].text === ' ') { space = index; break; }
      }
      if (space > 0 && token.text !== ' ') {
        lines.push(line.slice(0, space));
        line = line.slice(space + 1);
        lineWidth = line.reduce((sum, item) => sum + item.width, 0);
      } else {
        lines.push(line);
        line = [];
        lineWidth = 0;
      }
      if (line.length && lineWidth + size > columns) {
        lines.push(line);
        line = [];
        lineWidth = 0;
      }
      if (token.text === ' ') continue;
    }
    line.push(token);
    lineWidth += size;
  }
  lines.push(line);
  const wrapped = lines.map(trimStyledLine);
  const shown = maxLines ? wrapped.slice(0, maxLines) : wrapped;
  if (wrapped.length > shown.length && shown.length) {
    shown[shown.length - 1] = ellipsizeStyledLine(shown[shown.length - 1], columns);
  }
  return shown;
}

function diagnosisRow(canvas, x, y, w, labelWidth, label, parts, palette, { maxLines } = {}) {
  const labelText = `${fit(label, Math.max(1, labelWidth - 1), true)} `;
  const valueWidth = Math.max(8, w - labelWidth);
  const text = parts.map(([value]) => value).join('');
  // A value that cannot fit beside its label gets the whole content width.
  // This keeps a phrase such as "failure reason not recorded" contiguous
  // instead of splitting it at the label column.
  if (textWidth(text) > valueWidth) {
    rich(canvas, x, y, w, [[labelText, { fg: palette.faint }]], palette, palette.panel);
    y++;
    const lineWidth = Math.max(8, w - 2);
    for (const line of wrapStyled(parts, lineWidth, maxLines)) {
      rich(canvas, x + 2, y, lineWidth, line.map(token => [token.text, token.style]), palette, palette.panel);
      y++;
    }
    return y;
  }
  // Parts carry their own tone (the status mismatch is warning-colored), so
  // paint them individually instead of collapsing the row into one style.
  rich(canvas, x, y, w, [[labelText, { fg: palette.faint }], ...parts], palette, palette.panel);
  return y + 1;
}

function diagnosisWideRow(canvas, x, y, w, text, style, palette, { maxLines } = {}) {
  const lines = wrap(text, w).map(line => line.replace(/^\s+/, ''));
  const shown = maxLines ? lines.slice(0, maxLines) : lines;
  if (lines.length > shown.length && shown.length) {
    shown[shown.length - 1] = fit(`${shown[shown.length - 1]}…`, w);
  }
  for (const line of shown) {
    rich(canvas, x, y, w, [[line, style]], palette, palette.panel);
    y++;
  }
  return y;
}

function diagnosisCompactSource(diagnosis, language) {
  if (diagnosis.simulated) {
    return `${t(language, 'diagnosisSimulated')} ${statusLabel(language, diagnosis.state).toUpperCase()}`;
  }
  const task = diagnosis.statusSources.find(source => source.token === 'task#status');
  const node = diagnosis.statusSources.find(source => source.token === 'node#state');
  if (task && node && task.state === node.state) {
    return `${t(language, 'diagnosisTaskStatus')}/${t(language, 'diagnosisNodeState')} ${statusLabel(language, task.state).toUpperCase()}`;
  }
  const parts = diagnosis.statusSources.map(source => {
    const token = source.token === 'task#status' ? t(language, 'diagnosisTaskStatus')
      : source.token === 'node#state' ? t(language, 'diagnosisNodeState') : source.token;
    return `${token} ${statusLabel(language, source.state).toUpperCase()}`;
  });
  if (diagnosis.mismatch) parts.push(t(language, 'diagnosisStatusMismatch'));
  return parts.join(' · ');
}

function diagnosisActionHint(diagnosis, language, record) {
  // The open offer follows the open action, not the copy-path bundle. A task
  // in a secondary store can be openable even when diagnosis has no paths.
  if (record?.openPath) return t(language, 'diagnosisCopyHint');
  const paths = Boolean(diagnosisPathsText(diagnosis));
  if (paths) return t(language, 'diagnosisCopyHintNoOpen');
  return t(language, 'diagnosisCopyHintUnavailable');
}

function diagnosisCompactSection(canvas, x, y, w, diagnosis, { palette, language, record }) {
  const tone = diagnosisColor(palette, diagnosis.state);
  const reason = diagnosisReason(diagnosis, language);
  const terminal = terminalTimeDisplay(diagnosis.terminalAt);
  const last = diagnosisLast(diagnosis, language);
  const evidence = diagnosisEvidenceText(diagnosis, w, language);

  y = detailSection(canvas, x, y, w, t(language, 'diagnosis'), palette);
  y = diagnosisWideRow(canvas, x, y, w,
    `${statusIcon(diagnosis.state)} ${reason.text}`,
    { fg: reason.missing ? palette.faint : tone, dim: reason.missing }, palette, { maxLines: 3 });
  const compactLast = last.missing
    ? t(language, 'diagnosisLastMissingShort')
    : last.text.replace(/^activity\s+/u, '');
  y = diagnosisWideRow(canvas, x, y, w,
    `${t(language, 'diagnosisSrc')} ${diagnosisCompactSource(diagnosis, language)} · ${terminal ? `${t(language, 'diagnosisAt')} ${terminal}` : t(language, 'diagnosisTimeMissing')} · ${t(language, 'diagnosisLast')} ${compactLast}`,
    {
      fg: palette.text,
    }, palette, {
      maxLines: terminal ? 4 : (diagnosis.state === 'failed' || diagnosis.state === 'error' ? 2 : 3),
    });
  y = diagnosisWideRow(canvas, x, y, w,
    `${t(language, 'diagnosisRec')} ${diagnosisRecordText(diagnosis, language, record)} · ${evidence.text}`,
    { fg: palette.dim }, palette, { maxLines: 3 });
  y = diagnosisWideRow(canvas, x, y, w,
    `${diagnosisActionHint(diagnosis, language, record)} · ${t(language, 'diagnosisRetry')} ${diagnosisRetry(diagnosis, language, { compact: true })}`,
    { fg: tone }, palette, { maxLines: 4 });
  return y;
}

function diagnosisSection(canvas, x, y, w, diagnosis, { palette, language, compact = false, record }) {
  if (compact) return diagnosisCompactSection(canvas, x, y, w, diagnosis, { palette, language, record });
  y = detailSection(canvas, x, y, w, t(language, 'diagnosis'), palette);
  const micro = w < 40;
  const labelWidth = w >= 60 ? 9 : 6;
  const tone = diagnosisColor(palette, diagnosis.state);
  const reason = diagnosisReason(diagnosis, language);
  const last = diagnosisLast(diagnosis, language);
  const evidence = diagnosisEvidenceText(diagnosis, w, language);

  y = diagnosisRow(canvas, x, y, w, labelWidth, t(language, 'diagnosisWhy'), [[
    reason.text, { fg: reason.missing ? palette.faint : palette.text, dim: reason.missing },
  ]], palette, { maxLines: micro ? 3 : 2 });
  const terminal = terminalTimeDisplay(diagnosis.terminalAt);
  y = diagnosisRow(canvas, x, y, w, labelWidth, t(language, 'diagnosisAt'), [[
    terminal
      ? `${terminal} · ${t(language, 'diagnosisTimeSource')}`
      : t(language, 'diagnosisTimeMissing'),
    { fg: terminal ? palette.text : palette.faint, dim: !terminal },
  ]], palette, { maxLines: 1 });
  y = diagnosisRow(canvas, x, y, w, labelWidth, t(language, 'diagnosisLast'), [[
    last.text, { fg: last.missing ? palette.faint : palette.dim, dim: last.missing },
  ]], palette, { maxLines: micro ? 2 : 1 });
  y = diagnosisRow(canvas, x, y, w, labelWidth, t(language, 'diagnosisSrc'),
    diagnosisSourceParts(diagnosis, language, palette), palette, { maxLines: micro ? 3 : 2 });
  y = diagnosisRow(canvas, x, y, w, labelWidth, t(language, 'diagnosisRec'), [[
    diagnosisRecordText(diagnosis, language, record), { fg: palette.dim },
  ]], palette, { maxLines: 3 });
  y = diagnosisRow(canvas, x, y, w, labelWidth,
    t(language, w >= 60 ? 'diagnosisArtifactLabel' : 'diagnosisEvid'), [[
      evidence.text, { fg: evidence.missing ? palette.faint : palette.accent2, dim: evidence.missing },
    ]], palette, { maxLines: 2 });
  y = diagnosisRow(canvas, x, y, w, labelWidth, t(language, 'diagnosisRetry'), [[
    diagnosisRetry(diagnosis, language), { fg: tone },
  ]], palette, { maxLines: 2 });
  y = diagnosisRow(canvas, x, y, w, labelWidth, t(language, 'diagnosisAct'), [[
    diagnosisActionHint(diagnosis, language, record),
    { fg: record?.openPath ? palette.accent2 : palette.faint, italic: !record?.openPath },
  ]], palette, { maxLines: 1 });
  return y;
}

function diagnosisErrorSection(canvas, x, y, w, entity, diagnosis, palette, language) {
  if (!diagnosis) {
    const errorText = entity.error ?? (isFailureState(entityState(entity)) ? t(language, 'errorNotRecorded') : undefined);
    if (!errorText) return y;
    y = detailSection(canvas, x, y, w, t(language, 'errorSection'), palette);
    for (const line of wrap(errorText, w - 2)) {
      y = detailLine(canvas, x, y, w, [[`× ${line}`, {
        fg: entity.error ? palette.failed : palette.faint,
        bold: Boolean(entity.error),
        dim: !entity.error,
      }]], palette);
    }
    return errorSourceLine(canvas, x, y, w, entity, palette, language);
  }
  // The card owns the reason. Keep ERROR for recorded failure provenance and
  // for the explicit not-recorded line expected by existing evidence views,
  // but do not paint the same reason twice.
  if (!entity.error) {
    y = detailSection(canvas, x, y, w, t(language, 'errorSection'), palette);
    y = detailLine(canvas, x, y, w, [[t(language, 'errorNotRecorded'), {
      fg: palette.faint, dim: true,
    }]], palette);
    return errorSourceLine(canvas, x, y, w, entity, palette, language);
  }
  if (entity.errorSource === undefined && entity.errorKind === undefined) {
    y = detailSection(canvas, x, y, w, t(language, 'errorSection'), palette);
    return detailLine(canvas, x, y, w, [[entity.error, { fg: palette.failed }]], palette);
  }
  y = detailSection(canvas, x, y, w, t(language, 'errorSection'), palette);
  return errorSourceLine(canvas, x, y, w, entity, palette, language);
}

function fullReasonSection(canvas, x, y, w, diagnosis, palette, language) {
  if (!diagnosis?.reason) return y;
  y = detailSection(canvas, x, y, w, t(language, 'diagnosisFullReason'), palette);
  for (const line of wrap(diagnosis.reason, w - 2)) {
    y = detailLine(canvas, x, y, w, [[line, {
      fg: diagnosisColor(palette, diagnosis.state), dim: diagnosis.state === 'cancelled',
    }]], palette);
  }
  return y;
}

export function diagnosisForSelection(snapshot, ui) {
  const selection = resolveSelection(snapshot, ui);
  return selection.subject ? diagnosisFor({ ...selection, subject: selection.kind }) : null;
}

// The record action is offered for every status: a completed task still has a
// raw record, even though it has no diagnosis card. Selection stays here; the
// record roots and safe-open policy live in records.mjs.
export function recordForSelection(snapshot, ui) {
  const selection = resolveSelection(snapshot, ui);
  return selection.subject
    ? recordTargetFor(snapshot, { ...selection, subject: selection.kind })
    : null;
}

// Compatibility export: the revalidation policy is owned by records.mjs.
export { recordForKey } from './records.mjs';

// Diagnosis and record resolution stat/realpath the store. The 60 fps loop
// repaints the same snapshot many times between accepted reads, so cache one
// resolution per snapshot object and details subject. An accepted read
// replaces the snapshot; mutating it in place is not supported.
const subjectResolutionCache = new WeakMap();
function selectionResolution(snapshot, args, key) {
  let byKey = subjectResolutionCache.get(snapshot);
  if (!byKey) {
    byKey = new Map();
    subjectResolutionCache.set(snapshot, byKey);
  }
  if (byKey.has(key)) return byKey.get(key);
  const resolved = {
    record: recordTargetFor(snapshot, args),
    diagnosis: diagnosisFor(args),
  };
  if (byKey.size >= 8) byKey.clear();
  byKey.set(key, resolved);
  return resolved;
}

// One resolver owns subject selection for the painted pane, the details reset
// key, and the c/p/o actions. `allowRunFallback` is the only intentional
// difference between them: the details pane can paint a run overview, while
// diagnosis and record actions require a task or node.
function resolveSelection(snapshot, ui, { allowRunFallback = false } = {}) {
  const runs = snapshot?.runs ?? [];
  const tasks = navTasks(snapshot);
  const baseRun = runs[clamp(ui?.runIndex ?? 0, 0, Math.max(0, runs.length - 1))];
  const focusedTask = tasks.find(candidate => candidate.id === ui?.selectedTaskId);
  const taskFocus = ui?.focus === 'tasks' || (ui?.focus === 'details' && ui?.lastFocus === 'tasks');
  const showTask = Boolean(taskFocus && focusedTask);
  const linked = showTask ? linkedNodeForTask(snapshot, focusedTask.id) : undefined;
  const run = linked?.run ?? baseRun;
  const node = showTask
    ? linked?.node
    : baseRun?.nodes?.find(candidate => candidate.id === ui?.selectedNodeId);
  const task = showTask ? focusedTask : node?.task ?? focusedTask;
  const kind = showTask ? 'task' : node ? 'node' : allowRunFallback && run ? 'run' : null;
  const subject = kind === 'task' ? task : kind === 'node' ? node : kind === 'run' ? run : null;
  return { runs, tasks, run, task, node, showTask, kind, subject };
}

function nodeDetails(canvas, rect, run, node, snapshot, ui, {
  now, time, motion = true, palette, language, viewportH, freshness,
}) {
  const x = rect.x + 2;
  const w = rect.w - 4;
  const bottom = rect.y + rect.h - 1;
  const viewNow = freshness?.stale ? freshness.frozenNow : now;
  let y = rect.y + 2;
  const color = statusColor(palette, node.state);
  const end = pill(canvas, x, y, statusLabel(language, node.state).toUpperCase(), color, statusIcon(node.state));
  const elapsed = elapsedLabel(node, { now: viewNow, connected: isActiveSnapshot(snapshot), updatedAt: run.updatedAt });
  rich(canvas, end + 2, y, Math.max(0, rect.x + rect.w - 2 - end - 2), [
    [`${elapsed}`, { fg: palette.text, bold: true }],
    [`  ${t(language, 'attempt', { count: node.attempt ?? 1 })}`, { fg: palette.faint }],
  ], palette, palette.panel);
  y++;
  const description = node.task?.description ?? node.label;
  for (const line of wrap(description, w)) {
    y = detailLine(canvas, x, y, w, [[line, { fg: palette.text, bold: true }]], palette);
    if (y >= bottom) return;
  }
  const agent = agentLabel(node, language);
  const model = modelLabel(node, language);
  y = detailLine(canvas, x, y, w, [
    [`${agent}`, { fg: node.agent ? palette.accent : palette.faint, bold: Boolean(node.agent) }],
    [' · ', { fg: palette.faint }],
    [model, { fg: node.model ? palette.dim : palette.faint, dim: !node.model }],
    [`  ${node.taskId ?? ''}`, { fg: palette.faint }],
  ], palette);
  y++;
  const compact = w < 60 || (Number.isFinite(viewportH) && viewportH < 26);
  const { diagnosis, record } = selectionResolution(
    snapshot,
    { snapshot, run, node, task: node.task, subject: 'node' },
    `node:${run?.id ?? ''}:${node.id}`,
  );
  if (diagnosis) {
    y = diagnosisSection(canvas, x, y, w, diagnosis, { palette, language, compact, record });
    if (!compact) y++;
  } else {
    const stats = runStats(run);
    const progress = percentInfo(node, language, { done: stats.done, total: stats.total });
    y = progressBlock(canvas, x, y, w, progress, {
      time, motion, palette, color, bg: palette.panel, bold: node.state === 'running',
    });
    y += 1;
  }
  y = metricsSection(canvas, x, y, w, node, palette, language);
  if (snapshot?.sources?.length) {
    y = sourceHealthSection(canvas, x, y, w, snapshot, { palette, language, now, bottom });
  }
  if (y < bottom - 2) {
    y = detailSection(canvas, x, y, w, t(language, 'graphLinks'), palette);
    const names = id => nodeMap(run).get(id)?.label ?? id;
    const from = incoming(run, node.id).map(names);
    const to = outgoing(run, node.id).map(names);
    y = detailLine(canvas, x, y, w, [
      [t(language, 'inLabel'), { fg: palette.faint }],
      [from.length ? from.join(' · ') : t(language, 'start'), { fg: from.length ? palette.dim : palette.faint, dim: !from.length }],
    ], palette);
    y = detailLine(canvas, x, y, w, [
      [t(language, 'outLabel'), { fg: palette.faint }],
      [to.length ? to.join(' · ') : t(language, 'end'), { fg: to.length ? palette.dim : palette.faint, dim: !to.length }],
    ], palette);
  }
  if (ui.verbose) {
    if (y < bottom - 1) {
      y = replyOutput(canvas, x, y, w, bottom, node, palette, language, { record, verbose: true });
    }
    if (node.provenance) {
      y = sourceSection(canvas, x, y, w, node, snapshot, { palette, language, verbose: true, now, freshness });
    }
  }
  y = thinkingOutput(canvas, x, y, w, bottom, node, palette, language);
  const activity = isActiveSnapshot(snapshot) ? activitySummary(nodeActivity(node), { now: viewNow, language }) : null;
  if (y + 1 + ACTIVITY_BODY_LINES <= bottom) {
    y = detailSection(canvas, x, y, w, t(language, 'activity'), palette);
    y = detailLine(canvas, x, y, w, activity ? [
      [`${activity.mark} `, { fg: activity.stalled ? palette.warn : color, bold: true }],
      [activity.label, { fg: activity.stalled ? palette.warn : palette.text }],
    ] : [[node.state === 'running' ? t(language, 'waitingFirst') : t(language, 'noLiveActivity'), { fg: palette.faint, dim: true }]], palette);
    y = fixedBodyLines(canvas, x + 2, y, w - 2, ACTIVITY_DETAIL_LINES,
      activity?.text ? wrap(activity.text, w - 2) : [], palette, { fg: palette.dim });
  }
  const children = node.children ?? node.task?.children ?? [];
  if (children.length && y < bottom - 2) {
    y = detailSection(canvas, x, y, w, t(language, 'subtasks', { count: children.length }), palette);
    for (const child of children.slice(0, Math.max(0, bottom - y))) {
      const childColor = statusColor(palette, child.status);
      y = detailLine(canvas, x, y, w, [
        [`${statusIcon(child.status)} `, { fg: childColor, bold: true }],
        [child.description, { fg: palette.text }],
        [`  ${statusLabel(language, child.status)}`, { fg: childColor, dim: true }],
      ], palette);
      if (y >= bottom) return;
    }
  }
  if (y < bottom - 1 && (node.error || isFailureState(node.state) || diagnosis)) {
    y = diagnosisErrorSection(canvas, x, y, w, node, diagnosis, palette, language);
  }
  if (ui.verbose && diagnosis) y = fullReasonSection(canvas, x, y, w, diagnosis, palette, language);
  const recentEvents = (node.recentEvents ?? []).slice(-(ui.verbose ? 8 : 3));
  const artifact = node.artifact;
  if ((recentEvents.length || (ui.verbose && artifact)) && y < bottom - 1) {
    y = detailSection(canvas, x, y, w, t(language, 'recentEvents'), palette);
    for (const line of recentEvents) {
      y = detailLine(canvas, x, y, w, [[line, { fg: palette.dim }]], palette);
      if (y >= bottom) return;
    }
    if (node.outputTruncated && node.outputBytes !== undefined) {
      y = detailLine(canvas, x, y, w, [[t(language, 'outputTruncated', { bytes: node.outputBytes }), {
        fg: palette.faint, dim: true, italic: true,
      }]], palette);
      if (y >= bottom) return;
    }
    if (ui.verbose && artifact) {
      const sha = artifact.sha256 ? artifact.sha256.slice(0, 8) : undefined;
      const meta = sha
        ? t(language, 'artifact', { bytes: artifact.bytes ?? '—', sha })
        : t(language, 'artifactBytes', { bytes: artifact.bytes ?? '—' });
      y = detailLine(canvas, x, y, w, [[meta, { fg: palette.accent2 }]], palette);
      if (y >= bottom) return;
      if (artifact.statsBytes !== undefined) {
        y = detailLine(canvas, x, y, w, [[t(language, 'artifactStats', { bytes: artifact.statsBytes }), {
          fg: palette.faint,
        }]], palette);
        if (y >= bottom) return;
      }
      if (artifact.relativePath) {
        y = detailLine(canvas, x, y, w, [[t(language, 'artifactPath', { path: artifact.relativePath }), {
          fg: palette.faint, dim: true,
        }]], palette);
      }
      if (y >= bottom) return;
    }
  }
  const logs = (node.logs ?? node.task?.logs ?? []).slice(-(ui.verbose ? 8 : 3));
  if (ui.verbose && logs.length && y < bottom - 1) {
    y = detailSection(canvas, x, y, w, t(language, 'recentLog'), palette);
    for (const line of logs) {
      y = detailLine(canvas, x, y, w, [[line, { fg: palette.faint, dim: true }]], palette);
      if (y >= bottom) return;
    }
  }
}

function taskDetails(canvas, rect, task, snapshot, ui, {
  now, time, motion = true, palette, language, viewportH, freshness,
}) {
  const x = rect.x + 2;
  const w = rect.w - 4;
  const bottom = rect.y + rect.h - 1;
  const viewNow = freshness?.stale ? freshness.frozenNow : now;
  let y = rect.y + 2;
  const color = statusColor(palette, task.status);
  const end = pill(canvas, x, y, statusLabel(language, task.status).toUpperCase(), color, statusIcon(task.status));
  const elapsed = elapsedLabel(task, { now: viewNow, connected: isActiveSnapshot(snapshot), updatedAt: snapshot.generatedAt });
  rich(canvas, end + 2, y, Math.max(0, rect.x + rect.w - 2 - end - 2), [[elapsed, { fg: palette.text, bold: true }]], palette, palette.panel);
  y++;
  for (const line of wrap(task.description, w)) {
    y = detailLine(canvas, x, y, w, [[line, { fg: palette.text, bold: true }]], palette);
    if (y >= bottom) return;
  }
  y = detailLine(canvas, x, y, w, [
    [agentLabel(task, language), { fg: task.agent ? palette.accent : palette.faint, bold: Boolean(task.agent) }],
    [' · ', { fg: palette.faint }],
    [modelLabel(task, language), { fg: task.model ? palette.dim : palette.faint, dim: !task.model }],
    [`  ${task.id}`, { fg: palette.faint }],
  ], palette);
  y++;
  const linked = linkedNodeForTask(snapshot, task.id);
  const compact = w < 60 || (Number.isFinite(viewportH) && viewportH < 26);
  const { diagnosis, record } = selectionResolution(
    snapshot,
    { snapshot, run: linked?.run, node: linked?.node, task, subject: 'task' },
    `task:${task.id}`,
  );
  if (diagnosis) {
    y = diagnosisSection(canvas, x, y, w, diagnosis, { palette, language, compact, record });
    if (!compact) y++;
  } else {
    const progress = percentInfo(task, language, progressCounts(snapshot, task, linked?.run));
    y = progressBlock(canvas, x, y, w, progress, {
      time, motion, palette, color, bg: palette.panel, bold: task.status === 'running',
    });
    y += 1;
  }
  y = metricsSection(canvas, x, y, w, task, palette, language);
  if (snapshot?.sources?.length) {
    y = sourceHealthSection(canvas, x, y, w, snapshot, { palette, language, now, bottom });
  }
  if (ui.verbose) {
    if (y < bottom - 1) {
      y = replyOutput(canvas, x, y, w, bottom, task, palette, language, { record, verbose: true });
    }
    if (task.provenance) {
      y = sourceSection(canvas, x, y, w, task, snapshot, { palette, language, verbose: true, now, freshness });
    }
  }
  y = thinkingOutput(canvas, x, y, w, bottom, task, palette, language);
  const activity = isActiveSnapshot(snapshot) ? activitySummary(task.activity, { now: viewNow, language }) : null;
  if (y + 1 + ACTIVITY_BODY_LINES <= bottom) {
    y = detailSection(canvas, x, y, w, t(language, 'activity'), palette);
    y = detailLine(canvas, x, y, w, activity ? [
      [`${activity.mark} `, { fg: activity.stalled ? palette.warn : color, bold: true }],
      [activity.label, { fg: activity.stalled ? palette.warn : palette.text }],
    ] : [[task.status === 'running' ? t(language, 'waitingFirst') : t(language, 'noLiveActivity'), { fg: palette.faint, dim: true }]], palette);
    y = fixedBodyLines(canvas, x + 2, y, w - 2, ACTIVITY_DETAIL_LINES,
      activity?.text ? wrap(activity.text, w - 2) : [], palette, { fg: palette.dim });
  }
  if (y < bottom - 1 && (task.error || isFailureState(task.status) || diagnosis)) {
    y = diagnosisErrorSection(canvas, x, y, w, task, diagnosis, palette, language);
  }
  if (task.children?.length && y < bottom - 2) {
    y = detailSection(canvas, x, y, w, t(language, 'subtasks', { count: task.children.length }), palette);
    for (const child of task.children.slice(0, Math.max(0, bottom - y))) {
      const childColor = statusColor(palette, child.status);
      y = detailLine(canvas, x, y, w, [
        [`${statusIcon(child.status)} `, { fg: childColor, bold: true }],
        [child.description, { fg: palette.text }],
        [`  ${statusLabel(language, child.status)}`, { fg: childColor, dim: true }],
      ], palette);
      if (y >= bottom) return;
    }
  }
  if (ui.verbose && diagnosis) y = fullReasonSection(canvas, x, y, w, diagnosis, palette, language);
  const logs = (task.logs ?? []).slice(-(ui.verbose ? 8 : 3));
  if (ui.verbose && logs.length && y < bottom - 1) {
    y = detailSection(canvas, x, y, w, t(language, 'recentLog'), palette);
    for (const line of logs) {
      y = detailLine(canvas, x, y, w, [[line, { fg: palette.faint, dim: true }]], palette);
      if (y >= bottom) return;
    }
  }
}

function runSummaryLabels(language) {
  return [
    t(language, 'status'),
    t(language, 'tokens'),
    t(language, 'cost'),
    t(language, 'cacheReuseShort'),
    t(language, 'retries'),
    t(language, 'wallTime'),
    t(language, 'criticalPath'),
    t(language, 'parallelism'),
    t(language, 'nodesShort'),
  ];
}

// Break a critical path on its arrow boundaries, then elide the middle when it
// still does not fit two lines.
function wrapSummaryPath(labels, suffix, width) {
  if (!labels.length) return ['—'];
  const path = labels.join(' → ');
  const full = `${path}${suffix}`;
  if (textWidth(full) <= width) return [full];
  const lines = [];
  let current = '';
  for (const label of labels) {
    const next = current ? `${current} → ${label}` : label;
    if (current && textWidth(next) > width) {
      lines.push(current);
      current = label;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  if (lines.length > 2) {
    return [fit(`${labels[0]} → … → ${labels.at(-1)}${suffix}`, width)];
  }
  const last = lines[lines.length - 1];
  if (textWidth(`${last}${suffix}`) > width) return [...lines, suffix.trim()];
  lines[lines.length - 1] = `${last}${suffix}`;
  return lines.map(line => fit(line, width));
}

function runSummarySection(canvas, x, y, w, run, snapshot, stats, {
  now, viewNow, palette, language, freshness,
}) {
  // Live runs follow the wall clock; saved and stale captures freeze at the
  // instant the snapshot was taken so a cached duration never keeps growing.
  const live = isActiveSnapshot(snapshot) && !freshness?.stale;
  const capture = Date.parse(snapshot?.generatedAt ?? '') || Date.parse(run.updatedAt ?? '') || now;
  const clock = freshness?.stale ? freshness.frozenNow : live ? now : capture;
  const summary = runSummary(run, { now: clock });
  const labelWidth = labelWidthFor(runSummaryLabels(language));
  const valueW = metricValueWidth(w, labelWidth);
  const faint = { fg: palette.faint };
  const coverage = metric => (metric && metric.seen < metric.total
    ? [[` ${t(language, 'coverage', { seen: metric.seen, total: metric.total })}`, faint]]
    : undefined);
  const append = (parts, extra) => (extra ? [...parts, ...extra] : parts);
  const row = (label, parts) => {
    y = metricRow(canvas, x, y, w, label, parts, palette, labelWidth);
  };
  const withGaps = parts => parts.flatMap((part, index) => (index ? [[' ', faint], part] : [part]));

  y = detailSection(canvas, x, y, w, t(language, 'runSummary'), palette);

  const statusParts = [
    [t(language, 'runningCount', { count: stats.counts.running ?? 0 }), { fg: palette.running }],
    [t(language, 'completedCount', { count: stats.counts.completed ?? 0 }), { fg: palette.completed }],
    [t(language, 'failedCount', { count: stats.counts.failed ?? 0 }), { fg: palette.failed }],
    [t(language, 'blockedCount', { count: stats.counts.blocked ?? 0 }), { fg: palette.blocked }],
  ];
  const statusText = statusParts.map(([text]) => text).join(' ');
  if (textWidth(statusText) <= valueW) {
    row(t(language, 'status'), withGaps(statusParts));
  } else {
    row(t(language, 'status'), withGaps(statusParts.slice(0, 2)));
    row('', withGaps(statusParts.slice(2)));
  }

  if (summary.tokens) {
    const tokenStyle = { fg: palette.accent2, bold: true };
    const tokenText = t(language, 'tokensInOut', {
      in: formatNumber(summary.tokens.in), out: formatNumber(summary.tokens.out),
    });
    if (textWidth(tokenText) <= valueW) {
      row(t(language, 'tokens'), append([[tokenText, tokenStyle]], coverage(summary.tokens)));
    } else {
      row(t(language, 'tokens'), [
        [`${t(language, 'inLabel')}${formatNumber(summary.tokens.in)}`, tokenStyle],
      ]);
      row('', append([
        [`${t(language, 'outLabel')}${formatNumber(summary.tokens.out)}`, tokenStyle],
      ], coverage(summary.tokens)));
    }
  }
  if (summary.cost) {
    row(t(language, 'cost'), append([
      [`${summary.cost.lowerBound ? '≥' : ''}${t(language, 'costValue', {
        value: formatCost(summary.cost.usd),
      })}`, { fg: palette.warn, bold: true }],
    ], coverage(summary.cost)));
  }
  if (summary.cache) {
    row(t(language, 'cacheReuseShort'), append([
      [`${(summary.cache.hitRate * 100).toFixed(1)}% (${formatNumber(summary.cache.read)}/${formatNumber(summary.cache.tokens)})`, {
        fg: palette.completed,
      }],
    ], coverage(summary.cache)));
  }

  const retry = summary.retries;
  const turn = summary.turns;
  const tool = summary.tools;
  const retryText = retry ? `${metricValue(retry.value)}${retry.derived ? '*' : ''}` : undefined;
  const turnText = turn ? `${t(language, 'turns')} ${metricValue(turn.value)}` : undefined;
  const toolText = tool ? `${t(language, 'tools')} ${metricValue(tool.value)}` : undefined;
  const combined = [retryText, turnText, toolText].filter(Boolean).join(' · ');
  const complete = [retry, turn, tool].filter(Boolean).every(metric => metric.seen === metric.total);
  if (combined && complete && textWidth(combined) <= valueW) {
    const parts = [];
    if (retry) {
      parts.push([retryText, {
        fg: Number(retry.value) > 0 ? palette.warn : palette.faint,
        bold: Number(retry.value) > 0,
      }]);
    }
    if (turn) {
      if (parts.length) parts.push([' · ', faint]);
      parts.push([`${t(language, 'turns')} `, faint], [metricValue(turn.value), { fg: palette.text, bold: true }]);
    }
    if (tool) {
      if (parts.length) parts.push([' · ', faint]);
      parts.push([`${t(language, 'tools')} `, faint], [metricValue(tool.value), { fg: palette.accent3, bold: true }]);
    }
    row(t(language, 'retries'), parts);
  } else {
    if (retry) {
      row(t(language, 'retries'), append([
        [retryText, {
          fg: Number(retry.value) > 0 ? palette.warn : palette.faint,
          bold: Number(retry.value) > 0,
        }],
      ], coverage(retry)));
    }
    if (turn) {
      row(t(language, 'turns'), append([
        [metricValue(turn.value), { fg: palette.text, bold: true }],
      ], coverage(turn)));
    }
    if (tool) {
      row(t(language, 'tools'), append([
        [metricValue(tool.value), { fg: palette.accent3, bold: true }],
      ], coverage(tool)));
    }
  }

  if (summary.wallMs !== undefined) {
    const wall = compactDuration(summary.wallMs, language);
    const busy = summary.busyMs !== undefined
      ? `${t(language, 'busyTime')} ${compactDuration(summary.busyMs, language)}`
      : undefined;
    if (!busy || textWidth(`${wall} (${busy})`) <= valueW) {
      row(t(language, 'wallTime'), [
        [wall, { fg: palette.text, bold: true }],
        ...(busy ? [[` (${busy})`, faint]] : []),
      ]);
    } else {
      row(t(language, 'wallTime'), [[wall, { fg: palette.text, bold: true }]]);
      row('', [[busy, faint]]);
    }
  }

  if (summary.critical) {
    const suffix = ` (${summary.critical.partial ? '≥' : ''}${compactDuration(summary.critical.ms, language)})`;
    const lines = wrapSummaryPath(summary.critical.labels, suffix, valueW);
    row(t(language, 'criticalPath'), [[lines[0], { fg: palette.accent }]]);
    for (const extra of lines.slice(1)) row('', [[extra, faint]]);
  } else if (summary.criticalCycle) {
    row(t(language, 'criticalPath'), [['—', faint], [` ${t(language, 'cycle')}`, faint]]);
  }

  if (summary.parallel) {
    const parts = [[`max ${summary.parallel.max} · avg ${summary.parallel.avg.toFixed(1)}`, faint]];
    const cov = summary.timed.seen < summary.timed.total
      ? [[` ${t(language, 'coverage', { seen: summary.timed.seen, total: summary.timed.total })}`, faint]]
      : undefined;
    row(t(language, 'parallelism'), append(parts, cov));
  }

  row(t(language, 'nodesShort'), [
    [t(language, 'nodesEdges', { nodes: run.nodes.length, edges: run.edges.length }), faint],
  ]);
  row('', [[t(language, 'createdAgo', {
    time: run.createdAt
      ? t(language, 'ago', { time: compactAge(viewNow - Date.parse(run.createdAt), language) })
      : '—',
  }), faint]]);
  return y;
}

function runOverview(canvas, rect, run, snapshot, { now, palette, language, verbose = false, freshness }) {
  const x = rect.x + 2;
  const w = rect.w - 4;
  const bottom = rect.y + rect.h - 1;
  const viewNow = freshness?.stale ? freshness.frozenNow : now;
  let y = rect.y + 2;
  if (!run) {
    y = renderEmptyState(canvas, x, y, w, bottom - y, snapshot, {
      palette, language, now, freshness,
    });
    if (verbose) sourceSection(canvas, x, y + 1, w, null, snapshot, { palette, language, verbose, now, freshness });
    return;
  }
  const stats = runStats(run);
  const color = runColor(run, palette);
  const end = pill(canvas, x, y, statusLabel(language, run.status).toUpperCase(), color, statusIcon(run.status));
  const completion = stats.percentKnown
    ? t(language, 'complete', { percent: stats.percent })
    : t(language, 'completeCount', { done: stats.done, total: stats.total });
  rich(canvas, end + 2, y, Math.max(0, rect.x + rect.w - 2 - end - 2), [[completion, { fg: palette.text, bold: true }]], palette, palette.panel);
  y++;
  for (const line of wrap(displayRunName(run), w)) {
    y = detailLine(canvas, x, y, w, [[line, { fg: palette.text, bold: true }]], palette);
  }
  y++;
  if (stats.percentKnown) {
    rich(canvas, x, y, w, [
      [percentBar(stats.percent, Math.max(6, w - 8)), { fg: color }],
      [` ${stats.percent}%`, { fg: palette.text, bold: true }],
    ], palette, palette.panel);
  } else {
    rich(canvas, x, y, w, [[t(language, 'percentUnavailable'), { fg: palette.faint, dim: true }]], palette, palette.panel);
  }
  y += 2;
  y = runSummarySection(canvas, x, y, w, run, snapshot, stats, {
    now, viewNow, palette, language, freshness,
  });
  if (snapshot?.sources?.length) {
    y = sourceHealthSection(canvas, x, y, w, snapshot, { palette, language, now, bottom });
  }
  y++;
  if (verbose && run.provenance && y < bottom - 2) {
    y = sourceSection(canvas, x, y, w, run, snapshot, { palette, language, verbose, now, freshness });
  }
  y = detailSection(canvas, x, y, w, t(language, 'nodesSection'), palette);
  for (const node of run.nodes) {
    if (y >= bottom - 1) {
      rich(canvas, x, y, w, [['…', { fg: palette.faint }]], palette, palette.panel);
      return;
    }
    y = detailLine(canvas, x, y, w, [
      [`${statusIcon(node.state)} `, { fg: statusColor(palette, node.state), bold: true }],
      [node.label, { fg: palette.text }],
      [`  ${percentInfo(node, language)?.label ?? '—'}`, { fg: palette.faint }],
    ], palette);
  }
  y++;
  if (y < bottom) {
    rich(canvas, x, y, w, [[t(language, 'selectHint'), { fg: palette.faint, dim: true }]], palette, palette.panel);
  }
}

function renderDetails(canvas, rect, snapshot, ui, {
  now, time, motion = true, palette, language, freshness,
}) {
  const { run, task, node, showTask } = resolveSelection(snapshot, ui, { allowRunFallback: true });
  const focused = ui.focus === 'details';
  const title = showTask
    ? t(language, 'taskTitle', { id: task.id })
    : node
      ? t(language, 'nodeTitle', { label: node.label })
      : run
        ? t(language, 'runTitle', { name: displayRunName(run) })
        : t(language, 'detailsTitle');
  const badgeStatus = showTask ? task.status : node ? node.state : run?.status;
  const badge = badgeStatus ? statusLabel(language, badgeStatus) : null;
  // Measure and render the body on a tall scratch canvas so scrolling can
  // reveal sections beyond the visible panel, then clip the window into the
  // frame. The first content row is local row 2, matching the old layout.
  const detailsViewportH = Math.max(1, rect.h - 3);
  const measureH = Math.min(2048, Math.max(rect.h + 8, 128));
  const body = scratchCanvas('body', rect.w, measureH, palette);
  const full = { x: 0, y: 0, w: rect.w, h: measureH };
  if (showTask) taskDetails(body, full, task, snapshot, ui, {
    now, time, motion, palette, language, viewportH: detailsViewportH, freshness,
  });
  else if (node) nodeDetails(body, full, run, node, snapshot, ui, {
    now, time, motion, palette, language, viewportH: detailsViewportH, freshness,
  });
  else runOverview(body, full, run, snapshot, {
    now, palette, language, verbose: ui.verbose, freshness,
  });
  let lastUsed = -1;
  for (let row = measureH - 1; row >= 2; row--) {
    if (body.cells[row].some(cell => !cell.cont && cell.ch !== ' ')) {
      lastUsed = row;
      break;
    }
  }
  const contentH = Math.max(0, lastUsed + 1 - 2);
  const maxScroll = Math.max(0, contentH - detailsViewportH);
  const offset = scrollOffset(ui.detailsScroll, maxScroll);
  const viewStart = 2 + offset;
  const viewEnd = viewStart + detailsViewportH - 1;
  for (const headingRow of fixedSectionRows(body, language)) {
    if (headingRow < viewStart || headingRow > viewEnd) continue;
    const blockEnd = headingRow + 5;
    if (blockEnd <= viewEnd) continue;
    body.fill(0, headingRow, rect.w, Math.min(blockEnd, viewEnd) - headingRow + 1, {
      fg: palette.text, bg: palette.panel,
    });
  }
  const inner = scratchCanvas('inner', rect.w, rect.h, palette);
  const local = { x: 0, y: 0, w: rect.w, h: rect.h };
  panel(inner, local, title, { palette, focused, badge });
  inner.blit(body, 0, -offset, { x: 1, y: 2, w: rect.w - 2, h: detailsViewportH });
  const badgeText = badge ? ` ${fit(badge, Math.max(1, Math.floor(rect.w * 0.45)))} ` : '';
  inner.frame(0, 0, rect.w, rect.h, {
    border: focused ? palette.borderHot : palette.border,
    bg: palette.panel,
    title: fit(title, Math.max(1, rect.w - 6 - textWidth(badgeText))),
    titleColor: focused ? palette.accent : palette.dim,
  });
  if (badgeText) {
    inner.put(rect.w - 1 - textWidth(badgeText), 0, badgeText, {
      fg: palette.dim, bg: palette.panel,
    });
  }
  const barGeometry = scrollbarGeometry({
    y: 2,
    trackHeight: detailsViewportH,
    viewport: detailsViewportH,
    content: contentH,
    offset,
  });
  const localBar = barGeometry ? { x: rect.w - 2, w: 1, ...barGeometry } : null;
  drawScrollbar(inner, localBar, palette);
  canvas.blit(inner, rect.x, rect.y, { x: rect.x, y: rect.y, w: rect.w, h: rect.h });
  const bar = localBar
    ? {
      ...localBar,
      x: rect.x + localBar.x,
      y: rect.y + localBar.y,
      thumbTop: rect.y + localBar.thumbTop,
    }
    : null;
  return { viewportH: detailsViewportH, contentH, offset, maxScroll, bar };
}

function dutySelectionResolution(snapshot, selection) {
  const { run, task, node, kind } = selection;
  if (kind === 'task') {
    return selectionResolution(
      snapshot,
      { snapshot, run, node, task, subject: 'task' },
      `task:${task.id}`,
    );
  }
  if (kind === 'node') {
    return selectionResolution(
      snapshot,
      { snapshot, run, node, task: node.task, subject: 'node' },
      `node:${run?.id ?? ''}:${node.id}`,
    );
  }
  return { diagnosis: null, record: null };
}

// Duty is the primary surface below 112 columns. Tier 1 is packed into four
// rows on short terminals; taller panels add the compact tier-2 telemetry and
// the existing compact diagnosis card so failure evidence is never lost.
function dutyBody(canvas, full, snapshot, ui, {
  now, time = 0, motion = true, palette, language, viewportH, freshness,
}) {
  const selection = resolveSelection(snapshot, ui, { allowRunFallback: true });
  const { run, task, node, showTask, subject } = selection;
  const x = 2;
  const w = Math.max(8, full.w - 4);
  const bottom = full.h - 1;
  const viewNow = freshness?.stale ? freshness.frozenNow : now;
  let y = 2;
  // The empty duty body must not fabricate attempt, percent, error, or agent
  // fields for a subject that does not exist. It states the real state and the
  // next step, then stops.
  if (!subject) {
    renderEmptyState(canvas, x, y, w, bottom - y, snapshot, {
      palette, language, now, freshness,
    });
    return y;
  }
  const status = showTask ? task.status : node ? node.state : run?.status;
  const color = status ? statusColor(palette, status) : palette.dim;
  const stats = run ? runStats(run) : null;
  const compact = viewportH <= 5;
  const subjectLabel = showTask ? task.description
    : node ? node.label : run ? displayRunName(run) : t(language, 'noWorkflow');
  const subjectId = showTask ? task.id : node ? node.id : run ? run.id : '—';
  const linkedTaskId = showTask ? task.id : node?.taskId;
  const identity = linkedTaskId && linkedTaskId !== subjectId
    ? `${subjectLabel} · ${subjectId} · ${linkedTaskId}`
    : `${subjectLabel} · ${subjectId}`;
  const unlinked = Boolean(ui.selectedTaskUnlinked || (showTask && !node));
  const elapsed = elapsedLabel(subject, {
    now: viewNow, connected: isActiveSnapshot(snapshot), updatedAt: run?.updatedAt ?? snapshot.generatedAt,
  });
  const attempt = subject?.attempt ?? 1;
  const counts = progressCounts(snapshot, showTask ? task : node?.task, run);
  let progress;
  if (showTask || node) progress = percentInfo(subject, language, counts);
  else if (stats?.percentKnown) progress = { known: true, value: stats.percent, label: `${stats.percent}%` };
  else progress = { known: false, label: t(language, 'percentNotRecorded') };
  const retryText = retryInfo(subject, language).text;
  const { diagnosis, record } = dutySelectionResolution(snapshot, selection);
  const activity = isActiveSnapshot(snapshot)
    ? activitySummary(nodeActivity(subject), { now: viewNow, language })
    : null;
  const activityText = activity
    ? [activity.mark, activity.label, activity.text].filter(Boolean).join(' ')
    : (status === 'running' ? t(language, 'waitingFirst') : t(language, 'noLiveActivity'));
  let errorText = subject?.error ?? diagnosis?.reason;
  let errorMissing = false;
  if (!errorText) {
    errorMissing = true;
    errorText = isFailureState(status) ? t(language, 'errorNotRecorded') : t(language, 'errorNoneRecorded');
  }
  const runningCount = stats?.counts.running ?? 0;

  if (compact) {
    const lines = [
      [[`${statusIcon(status)} ${status ? statusLabel(language, status).toUpperCase() : '—'}  ${elapsed}  ${t(language, 'attempt', { count: attempt })}`, { fg: color, bold: true }]],
      [[`${identity}${unlinked ? ` · ${t(language, 'noNodeShort')}` : ''}`, { fg: palette.text, bold: true }]],
      [[t(language, 'dutyProgress', { done: stats?.done ?? 0, total: stats?.total ?? 0, percent: progress.label }), { fg: palette.text }], [` · ${retryText}`, { fg: palette.faint }]],
      [[fit(errorText, Math.max(8, Math.floor(w * 0.55))), {
        fg: errorMissing ? palette.faint : palette.failed, dim: errorMissing,
      }], [' · ', { fg: palette.faint }], [activityText, {
        fg: activity?.stalled ? palette.warn : palette.dim,
      }]],
    ];
    for (const line of lines) {
      if (y >= bottom) break;
      rich(canvas, x, y, w, line, palette, palette.panel);
      y++;
    }
    return y;
  }

  const end = pill(canvas, x, y, status ? statusLabel(language, status).toUpperCase() : '—', color, status ? statusIcon(status) : undefined);
  rich(canvas, end + 2, y, Math.max(0, x + w - end - 2), [
    [elapsed, { fg: palette.text, bold: true }],
    [`  ${t(language, 'attempt', { count: attempt })}`, { fg: palette.faint }],
  ], palette, palette.panel);
  y++;
  y = detailLine(canvas, x, y, w, [
    [identity, { fg: palette.text, bold: true }],
    ...(unlinked ? [[' · ', { fg: palette.faint }], [t(language, 'noNodeShort'), { fg: palette.warn, bold: true }]] : []),
  ], palette);
  if (run) {
    y = detailLine(canvas, x, y, w, [[t(language, 'dutyRunLine', {
      name: displayRunName(run), done: stats.done, total: stats.total, running: runningCount,
    }), { fg: palette.dim }]], palette);
  }
  y = progressBlock(canvas, x, y, w, progress, {
    time, motion, palette, color, bg: palette.panel, bold: status === 'running',
  });
  y++;
  // Store health is persistent triage evidence, not telemetry. It sits above
  // the diagnosis card so an unreadable source and its error remain inside the
  // first 54-column viewport instead of scrolling below it.
  if (snapshot?.sources?.length) {
    y = sourceHealthSection(canvas, x, y, w, snapshot, { palette, language, now, bottom });
  }
  // The compact diagnosis card owns a recorded reason; keep the standalone
  // tier-1 error line for running/unknown subjects and unrecorded failures.
  if (!diagnosis?.reason) {
    y = detailLine(canvas, x, y, w, [
      [errorText, { fg: errorMissing ? palette.faint : palette.failed, dim: errorMissing, bold: !errorMissing }],
    ], palette);
  }
  if (diagnosis) y = diagnosisCompactSection(canvas, x, y, w, diagnosis, { palette, language, record });
  y = detailLine(canvas, x, y, w, [
    [`${agentLabel(subject, language)} · ${modelLabel(subject, language)}`, { fg: palette.accent }],
  ], palette);
  y = detailLine(canvas, x, y, w, [[t(language, 'dutyHint'), { fg: palette.faint, dim: true }]], palette);
  // A run subject is a run-level review, not a node metric card: paint the same
  // run summary the wide details pane uses instead of empty per-subject metrics.
  if (!showTask && !node && run) {
    y = runSummarySection(canvas, x, y, w, run, snapshot, stats, {
      now, viewNow, palette, language, freshness,
    });
  } else {
    // Retry is rendered inside METRICS immediately before turns/tools.
    y = metricsSection(canvas, x, y, w, subject, palette, language);
  }
  if (!showTask && node && run) {
    y = detailSection(canvas, x, y, w, t(language, 'graphLinks'), palette);
    const names = id => nodeMap(run).get(id)?.label ?? id;
    const from = incoming(run, node.id).map(names);
    const to = outgoing(run, node.id).map(names);
    y = detailLine(canvas, x, y, w, [
      [t(language, 'inLabel'), { fg: palette.faint }],
      [from.length ? from.join(' · ') : t(language, 'start'), { fg: from.length ? palette.dim : palette.faint }],
    ], palette);
    y = detailLine(canvas, x, y, w, [
      [t(language, 'outLabel'), { fg: palette.faint }],
      [to.length ? to.join(' · ') : t(language, 'end'), { fg: to.length ? palette.dim : palette.faint }],
    ], palette);
  }
  // ACTIVITY follows the metrics/token/connections block; tier 3 (REPLY,
  // THINKING, SOURCE) stays out of the narrow duty body.
  y = detailSection(canvas, x, y, w, t(language, 'activity'), palette);
  y = detailLine(canvas, x, y, w, activity ? [
    [`${activity.mark} `, { fg: activity.stalled ? palette.warn : color, bold: true }],
    [activity.label, { fg: activity.stalled ? palette.warn : palette.text }],
  ] : [[status === 'running' ? t(language, 'waitingFirst') : t(language, 'noLiveActivity'), { fg: palette.faint, dim: true }]], palette);
  if (activity?.text) {
    for (const lineText of wrap(activity.text, w - 2).slice(0, 2)) {
      y = detailLine(canvas, x + 2, y, w - 2, [[lineText, { fg: palette.dim }]], palette);
    }
  }
  const children = subject?.children ?? subject?.task?.children ?? [];
  if (children.length) {
    y = detailSection(canvas, x, y, w, t(language, 'subtasks', { count: children.length }), palette);
    for (const child of children.slice(0, Math.max(0, bottom - y - 1))) {
      const childColor = statusColor(palette, child.status);
      y = detailLine(canvas, x, y, w, [
        [`${statusIcon(child.status)} `, { fg: childColor, bold: true }],
        [child.description, { fg: palette.text }],
        [`  ${statusLabel(language, child.status)}`, { fg: childColor, dim: true }],
      ], palette);
    }
  }
  return y;
}

function narrowListFrame(canvas, rect, title, palette, focused) {
  panel(canvas, rect, focused ? `▸ ${title}` : title, { palette, focused });
}

function renderNarrowRunList(canvas, rect, snapshot, ui, { palette, language, focused = false }, hitboxes) {
  const runs = snapshot?.runs ?? [];
  narrowListFrame(canvas, rect, t(language, 'runs'), palette, focused);
  const viewport = Math.max(1, rect.h - 2);
  const maxScroll = Math.max(0, runs.length - viewport);
  const offset = scrollOffset(ui.runsScroll, maxScroll);
  const region = { x: rect.x + 1, y: rect.y + 1, w: Math.max(1, rect.w - 2), h: viewport };
  let row = rect.y + 1;
  for (const run of runs.slice(offset, offset + viewport)) {
    if (row >= rect.y + rect.h - 1) break;
    const selected = run.id === snapshot.runs[ui.runIndex]?.id;
    if (selected) canvas.fill(rect.x + 1, row, rect.w - 2, 1, { bg: palette.selection, fg: palette.text });
    const stats = runStats(run);
    const status = run.status ?? 'pending';
    const suffix = stats?.percentKnown
      ? `${stats.percent}%`
      : t(language, 'runningCount', { count: stats?.counts.running ?? 0 });
    rich(canvas, rect.x + 2, row, Math.max(1, rect.w - 4), [
      [`${selected ? '▸' : ' '} `, { fg: selected ? palette.accent : palette.faint, bold: selected }],
      [`${statusIcon(status)} `, { fg: statusColor(palette, status), bold: true }],
      [fit(displayRunName(run), Math.max(8, rect.w - 22)), { fg: selected ? palette.white : palette.text, bold: selected }],
      [` ${fit(suffix, 12)}`, { fg: palette.faint }],
    ], palette, selected ? palette.selection : palette.panel);
    hitboxes.runs.set(run.id, { x: rect.x + 1, y: row, w: rect.w - 2, h: 1 });
    row++;
  }
  if (!runs.length) {
    rich(canvas, rect.x + 2, rect.y + 1, rect.w - 4, [[t(language, 'noWorkflow'), { fg: palette.faint }]], palette, palette.panel);
  }
  const barGeometry = scrollbarGeometry({ y: rect.y + 1, trackHeight: viewport, viewport, content: runs.length, offset });
  const bar = barGeometry ? { x: rect.x + rect.w - 2, w: 1, ...barGeometry } : null;
  if (bar) drawScrollbar(canvas, bar, palette);
  return { viewportH: viewport, contentH: runs.length, offset, maxScroll, bar, region };
}

function renderNarrowCellList(canvas, rect, snapshot, ui, { palette, language, focused = false }, hitboxes) {
  const run = snapshot?.runs?.[clamp(ui.runIndex ?? 0, 0, Math.max(0, (snapshot?.runs?.length ?? 1) - 1))];
  const nodes = run?.nodes ?? [];
  narrowListFrame(canvas, rect, run ? `${t(language, 'cells')} · ${fit(displayRunName(run), Math.max(6, rect.w - 12))}` : t(language, 'cells'), palette, focused);
  const viewport = Math.max(1, rect.h - 2);
  const maxScroll = Math.max(0, nodes.length - viewport);
  const offset = scrollOffset(ui.cellsScroll, maxScroll);
  const region = { x: rect.x + 1, y: rect.y + 1, w: Math.max(1, rect.w - 2), h: viewport };
  let row = rect.y + 1;
  for (const node of nodes.slice(offset, offset + viewport)) {
    if (row >= rect.y + rect.h - 1) break;
    const selected = node.id === ui.selectedNodeId;
    if (selected) canvas.fill(rect.x + 1, row, rect.w - 2, 1, { bg: palette.selection, fg: palette.text });
    const status = node.state ?? 'pending';
    const suffix = percentInfo(node, language).known ? percentInfo(node, language).label : statusLabel(language, status);
    rich(canvas, rect.x + 2, row, Math.max(1, rect.w - 4), [
      [`${selected ? '▸' : ' '} `, { fg: selected ? palette.accent : palette.faint, bold: selected }],
      [`${statusIcon(status)} `, { fg: statusColor(palette, status), bold: true }],
      [fit(node.label, Math.max(8, rect.w - 20)), { fg: selected ? palette.white : palette.text, bold: selected }],
      [` ${fit(suffix, 9)}`, { fg: palette.faint }],
    ], palette, selected ? palette.selection : palette.panel);
    hitboxes.nodes.set(node.id, { x: rect.x + 1, y: row, w: rect.w - 2, h: 1 });
    row++;
  }
  if (!nodes.length) {
    rich(canvas, rect.x + 2, rect.y + 1, rect.w - 4, [[t(language, 'noCells'), { fg: palette.faint }]], palette, palette.panel);
  }
  const barGeometry = scrollbarGeometry({ y: rect.y + 1, trackHeight: viewport, viewport, content: nodes.length, offset });
  const bar = barGeometry ? { x: rect.x + rect.w - 2, w: 1, ...barGeometry } : null;
  if (bar) drawScrollbar(canvas, bar, palette);
  return { viewportH: viewport, contentH: nodes.length, offset, maxScroll, bar, region };
}

function renderNarrowDuty(canvas, rect, snapshot, ui, opts, hitboxes) {
  const h = Math.max(6, rect.h);
  let runsH = h >= 16 ? clamp(Math.floor(h * 0.19), 3, 7) : 3;
  let cellsH = h >= 16 ? clamp(Math.floor(h * 0.19), 3, 7) : 3;
  if (runsH + cellsH + 3 > h) {
    runsH = 2;
    cellsH = 2;
  }
  const detailsH = Math.max(2, h - runsH - cellsH);
  const runsRect = { ...rect, h: runsH };
  const cellsRect = { ...rect, y: rect.y + runsH, h: cellsH };
  const detailsRect = { ...rect, y: rect.y + runsH + cellsH, h: detailsH };
  const runs = renderNarrowRunList(canvas, runsRect, snapshot, ui, {
    ...opts, focused: ui.focus === 'runs',
  }, hitboxes);
  const cells = renderNarrowCellList(canvas, cellsRect, snapshot, ui, {
    ...opts, focused: ui.focus === 'cells',
  }, hitboxes);
  const details = renderDuty(canvas, detailsRect, snapshot, ui, opts);
  return { runs, cells, details, detailsRect };
}

function renderDuty(canvas, rect, snapshot, ui, { now, time, motion = true, palette, language, freshness }) {
  const selection = resolveSelection(snapshot, ui, { allowRunFallback: true });
  const status = selection.showTask ? selection.task.status
    : selection.node ? selection.node.state : selection.run?.status;
  const label = selection.showTask ? selection.task.description
    : selection.node ? selection.node.label
      : selection.run ? displayRunName(selection.run) : t(language, 'noWorkflow');
  // The narrow panel names what it actually shows: a task, the current node, a
  // run overview, or details. "DUTY" was an internal layout name, not a subject.
  const title = selection.showTask
    ? t(language, 'taskTitle', { id: selection.task.id })
    : selection.node
      ? t(language, 'currentNodeTitle', { label })
      : selection.run
        ? t(language, 'runTitle', { name: label })
        : t(language, 'detailsTitle');
  const badge = status ? statusLabel(language, status) : null;
  // DUTY is the structural name of this narrow region; `details` is the focus
  // value used by the viewer and the 1/2/3 duty key. Accept both spellings so
  // a caller that names the region literally still gets the non-color glyph.
  const focused = ui.focus === 'details' || ui.focus === 'duty';
  // A non-color focus glyph keeps the active surface visible with --no-color,
  // where border and title color collapse to the same attributes.
  const shownTitle = focused ? `▸ ${title}` : title;
  const viewportH = Math.max(1, rect.h - 3);
  const measureH = Math.min(2048, Math.max(rect.h + 8, 128));
  const body = scratchCanvas('body', rect.w, measureH, palette);
  dutyBody(body, { x: 0, y: 0, w: rect.w, h: measureH }, snapshot, ui, {
    now, time, motion, palette, language, viewportH, freshness,
  });
  let lastUsed = -1;
  for (let row = measureH - 1; row >= 2; row--) {
    if (body.cells[row].some(cell => !cell.cont && cell.ch !== ' ')) {
      lastUsed = row;
      break;
    }
  }
  const contentH = Math.max(0, lastUsed + 1 - 2);
  const maxScroll = Math.max(0, contentH - viewportH);
  const offset = scrollOffset(ui.detailsScroll, maxScroll);
  const inner = scratchCanvas('inner', rect.w, rect.h, palette);
  const local = { x: 0, y: 0, w: rect.w, h: rect.h };
  panel(inner, local, shownTitle, { palette, focused, badge });
  inner.blit(body, 0, -offset, { x: 1, y: 2, w: rect.w - 2, h: viewportH });
  const badgeText = badge ? ` ${fit(badge, Math.max(1, Math.floor(rect.w * 0.45)))} ` : '';
  inner.frame(0, 0, rect.w, rect.h, {
    border: focused ? palette.borderHot : palette.border,
    bg: palette.panel,
    title: fit(shownTitle, Math.max(1, rect.w - 6 - textWidth(badgeText))),
    titleColor: focused ? palette.accent : palette.dim,
  });
  if (badgeText) {
    inner.put(rect.w - 1 - textWidth(badgeText), 0, badgeText, {
      fg: palette.dim, bg: palette.panel,
    });
  }
  const barGeometry = scrollbarGeometry({
    y: 2, trackHeight: viewportH, viewport: viewportH, content: contentH, offset,
  });
  const localBar = barGeometry ? { x: rect.w - 2, w: 1, ...barGeometry } : null;
  drawScrollbar(inner, localBar, palette);
  canvas.blit(inner, rect.x, rect.y, { x: rect.x, y: rect.y, w: rect.w, h: rect.h });
  const bar = localBar
    ? {
      ...localBar,
      x: rect.x + localBar.x,
      y: rect.y + localBar.y,
      thumbTop: rect.y + localBar.thumbTop,
    }
    : null;
  return { viewportH, contentH, offset, maxScroll, bar };
}

// Header row 1 is the context path: run > node > task, then status, counts, and
// a retry marker. Task id and status have priority; the run name is middle
// truncated and the node is end truncated before either is dropped. Every
// painted context segment owns a hitbox so the path is clickable.
function renderBreadcrumb(canvas, width, snapshot, ui, { palette, language }, hitboxes) {
  const { run, task, node, showTask } = resolveSelection(snapshot, ui, { allowRunFallback: true });
  const statusEntity = showTask ? task : node ?? run;
  const status = entityState(statusEntity);
  const stats = run ? runStats(run) : null;
  const retries = statusEntity?.retries ?? statusEntity?.failedTurns;
  const runText = run ? displayRunName(run) : t(language, 'noWorkflowShort');
  const nodeText = node?.label
    ?? (showTask ? t(language, 'noNodeShort') : t(language, 'runOverviewShort'));
  const taskText = showTask ? task?.id : node?.taskId;
  const countsText = stats
    ? t(language, 'graphSummary', {
      done: stats.done, total: stats.total, running: stats.counts.running ?? 0,
    })
    : undefined;
  const retryText = Number(retries) > 0 ? `↻ ${retries}` : undefined;
  const available = Math.max(8, width - 4);
  const separator = t(language, 'contextSeparator');

  const build = (runValue, nodeValue, taskValue, counts, retry) => {
    const parts = [];
    const taskId = showTask ? task?.id : node?.taskId;
    if (runValue) parts.push({ kind: 'run', id: run?.id, text: runValue, sep: '', fg: palette.text, bold: true });
    if (nodeValue) parts.push({ kind: 'node', id: node?.id, text: nodeValue, sep: separator, fg: palette.accent2 });
    if (taskValue) parts.push({ kind: 'task', id: taskId, text: taskValue, sep: separator, fg: palette.dim });
    if (status) {
      parts.push({
        kind: null,
        text: statusLabel(language, status).toUpperCase(),
        sep: ' · ',
        fg: statusColor(palette, status),
        bold: true,
      });
    }
    if (counts) parts.push({ kind: null, text: counts, sep: ' · ', fg: palette.faint });
    if (retry) parts.push({ kind: null, text: retry, sep: ' · ', fg: palette.warn });
    return parts;
  };
  const measure = parts => parts.reduce((sum, part) =>
    sum + textWidth(part.sep) + textWidth(part.text), 0);

  let segments = build(runText, nodeText, taskText, countsText, retryText);
  let guard = 0;
  while (measure(segments) > available && guard++ < 96) {
    const counts = segments.findIndex(part => part.kind === null && part.text === countsText);
    if (counts >= 0) { segments.splice(counts, 1); continue; }
    const retry = segments.findIndex(part => part.kind === null && part.text === retryText);
    if (retry >= 0) { segments.splice(retry, 1); continue; }
    const runPart = segments.find(part => part.kind === 'run');
    if (runPart && textWidth(runPart.text) > 3) {
      runPart.text = truncateMiddle(runPart.text, textWidth(runPart.text) - 1);
      continue;
    }
    const nodePart = segments.find(part => part.kind === 'node');
    if (nodePart && textWidth(nodePart.text) > 3) {
      nodePart.text = fit(nodePart.text, textWidth(nodePart.text) - 1);
      continue;
    }
    if (runPart) { segments = segments.filter(part => part !== runPart); continue; }
    if (nodePart) { segments = segments.filter(part => part !== nodePart); continue; }
    const taskPart = segments.find(part => part.kind === 'task');
    if (taskPart && textWidth(taskPart.text) > 4) {
      taskPart.text = fit(taskPart.text, textWidth(taskPart.text) - 1);
      continue;
    }
    const widths = segments.reduce((sum, part) => sum + textWidth(part.sep), 0);
    const textBudget = Math.max(1, available - widths);
    const totalText = segments.reduce((sum, part) => sum + textWidth(part.text), 0);
    if (totalText > textBudget) {
      const last = segments.at(-1);
      last.text = fit(last.text, Math.max(1, textWidth(last.text) - (totalText - textBudget)));
    }
    break;
  }

  let cursor = 2;
  const maxX = width - 2;
  for (const part of segments) {
    if (cursor >= maxX) break;
    if (part.sep) {
      const shownSep = fit(part.sep, maxX - cursor);
      canvas.put(cursor, 1, shownSep, { fg: palette.faint, bg: palette.bgAlt });
      cursor += textWidth(shownSep);
    }
    if (cursor >= maxX) break;
    const shown = fit(part.text, maxX - cursor);
    if (!shown) continue;
    const used = textWidth(shown);
    canvas.put(cursor, 1, shown, {
      fg: part.fg, bg: palette.bgAlt, bold: part.bold,
    });
    if (part.kind && part.id) {
      hitboxes.context[part.kind] = { x: cursor, y: 1, w: used, h: 1, id: part.id };
    }
    cursor += used;
  }
}

function renderHeader(canvas, width, snapshot, ui, {
  time, now, palette, motion, language, freshness = snapshotFreshness(snapshot, { now, staleAfterMs: ui.staleAfterMs }),
}, hitboxes) {
  canvas.fill(0, 0, width, HEADER_H, { bg: palette.bgAlt, fg: palette.text });
  const gradient = gradientCells('DAG STUDIO', palette.accent, palette.accent2, { shift: motion ? time / 900 : 0 });
  let x = 2;
  for (const part of gradient) {
    canvas.put(x, 0, part.text, { fg: part.color, bg: palette.bgAlt, bold: true });
    x += textWidth(part.text);
  }
  x += 2;
  canvas.put(x, 0, 'v0.1.0', { fg: palette.faint, bg: palette.bgAlt, dim: true });
  const brandEnd = x + textWidth('v0.1.0');
  renderBreadcrumb(canvas, width, snapshot, ui, { palette, language }, hitboxes);
  const badgeText = modeBadge(snapshot, language, freshness);
  const badgeColor = modeColor(snapshot, palette, time, motion, freshness);
  const clockText = clock(new Date(now).getHours() * 3600_000 + new Date(now).getMinutes() * 60_000 + new Date(now).getSeconds() * 1000);
  // The right block may never start under the brand. Mode is the contract and
  // always survives. Capture age is the freshness evidence, so it survives
  // too, at every width. Session and clock give way first.
  const rightStart = brandEnd + 2;
  const available = Math.max(0, width - rightStart - 2);
  // Below 48 columns the full "captured 8h ago" phrase is clipped before its
  // value. Keep the freshness evidence as the compact unit ("8h") there so the
  // age survives at every width the header itself can fit.
  const ageText = freshness.ageMs === undefined
    ? undefined
    : width < 48
      ? (freshness.ageMs < 1500 ? t(language, 'now') : compactAge(freshness.ageMs, language))
      : capturedAgoLabel(snapshot, now, language);
  let showClock = width >= 80;
  const showAge = Boolean(ageText);
  const reserved = () => (showAge ? textWidth(ageText) + 3 : 0) + (showClock ? textWidth(clockText) + 3 : 0);
  let sessionWidth = available - textWidth(badgeText) - 3 - reserved();
  if (sessionWidth < 8 && showClock) {
    showClock = false;
    sessionWidth = available - textWidth(badgeText) - 3 - reserved();
  }
  if (sessionWidth < 6) sessionWidth = 0;
  const session = truncateMiddle(snapshot.sessionId ?? '', Math.max(0, sessionWidth));
  const rightParts = [badgeText];
  if (session) rightParts.push(session);
  if (showAge) rightParts.push(ageText);
  if (showClock) rightParts.push(clockText);
  const right = fit(rightParts.join('   '), available);
  canvas.put(Math.max(rightStart, width - textWidth(right) - 2), 0, right, {
    fg: badgeColor, bg: palette.bgAlt, bold: isActiveSnapshot(snapshot),
  });
  for (let column = 0; column < width; column++) {
    const t = column / Math.max(1, width - 1);
    canvas.put(column, 2, '─', { fg: mix(palette.border, palette.accent, t * 0.35), bg: palette.bg });
  }
}

function renderFooter(canvas, width, height, snapshot, ui, {
  palette, time, now, language, freshness = snapshotFreshness(snapshot, { now, staleAfterMs: ui.staleAfterMs }),
}, hitboxes) {
  const y = height - 2;
  canvas.hline(0, y, width, { fg: mix(palette.border, palette.bg, 0.35), bg: palette.bg });
  if (ui.installVersion) {
    const label = fit(` ${ui.installVersion} `, Math.max(0, width - 2));
    if (label) {
      canvas.put(Math.max(0, width - textWidth(label) - 1), y, label, {
        fg: palette.accent2, bg: palette.bg,
      });
    }
  }
  const mode = snapshotMode(snapshot);
  const active = isActiveSnapshot(snapshot);
  const follow = ui.follow && active;
  const selection = ui.mouseCapture === false ? `${t(language, 'selectionOn')} · ` : '';
  const glyph = freshness.stale ? '▲' : mode === 'demo' ? '◆' : mode === 'live' && snapshot.connected !== false ? '●' : '○';
  const followText = freshness.stale
    ? t(language, 'modeStale')
    : follow ? t(language, 'followOn') : t(language, 'followOff');
  const followShort = freshness.stale
    ? t(language, 'modeStale')
    : follow ? t(language, 'on') : t(language, 'off');
  const baseRight = width >= 110
    ? `${selection}${glyph} ${followText}  ${ui.fps ?? 60}fps`
    : width >= 84
      ? `${selection}${glyph} ${followShort}  ${ui.fps ?? 60}fps`
      : `${selection}${glyph} ${followShort}`;
  const recent = (ui.toasts ?? []).filter(toast => now - toast.at < 5000).at(-1);
  const settingsText = width >= 40 ? `⚙ ${t(language, 'settings')}` : '⚙';
  const settingsWidth = textWidth(settingsText);
  const settingsX = Math.max(1, width - settingsWidth - 1);
  const maxToast = Math.max(8, width - 12 - settingsWidth - 2);
  const right = recent ? fit(`▌ ${recent.text}`, maxToast) : baseRight;
  const rightColor = recent
    ? (recent.kind === 'failed' ? palette.failed : recent.kind === 'completed' ? palette.completed : recent.kind === 'warning' ? palette.warn : palette.accent)
    : (follow ? palette.accent : palette.faint);
  const leftWidth = Math.max(1, width - textWidth(right) - settingsWidth - 5);
  const limit = 1 + leftWidth;
  let cursor = 1;
  const draw = (text, style) => {
    if (cursor >= limit) return false;
    const source = String(text);
    const shown = textWidth(source) > limit - cursor ? fit(source, limit - cursor) : source;
    canvas.put(cursor, height - 1, shown, { bg: palette.bg, ...style });
    cursor += textWidth(shown);
    return shown === source;
  };
  // Word legend from 70 columns; the glyph legend below it keeps room for named
  // actions. The legend itself stays inert.
  const legend = width >= 70
    ? [
      [t(language, 'legendRun'), { fg: palette.running }],
      [t(language, 'legendDone'), { fg: palette.completed }],
      [t(language, 'legendFail'), { fg: palette.failed }],
      [t(language, 'legendWait'), { fg: palette.blocked }],
    ]
    : [
      [t(language, 'legendRunShort'), { fg: palette.running }],
      [t(language, 'legendDoneShort'), { fg: palette.completed }],
      [t(language, 'legendFailShort'), { fg: palette.failed }],
      [t(language, 'legendWaitShort'), { fg: palette.blocked }],
    ];
  for (const [text, style] of legend) draw(text, style);
  const helpLabel = t(language, 'helpLabel');
  const selectLabel = t(language, 'selectMode');
  const clearLabel = t(language, 'clearLabel');
  draw(' ', { fg: palette.dim });
  const helpStart = cursor;
  const helpKey = draw('? ', { fg: palette.accent2, bold: true });
  const helpWord = width >= 40 ? draw(helpLabel, { fg: palette.accent2, bold: true }) : true;
  if (helpKey && helpWord && cursor > helpStart) {
    hitboxes.helpHint = { x: helpStart, y: height - 1, w: cursor - helpStart, h: 1 };
  }
  const drawAction = (key, label, hitboxKey) => {
    draw(' ', { fg: palette.dim });
    const start = cursor;
    const keyDrawn = draw(label ? `${key} ` : key, { fg: palette.accent2, bold: true });
    const labelDrawn = label ? draw(label, { fg: palette.accent2, bold: true }) : true;
    if (keyDrawn && labelDrawn && cursor > start) {
      hitboxes[hitboxKey] = { x: start, y: height - 1, w: cursor - start, h: 1 };
    }
  };
  const named = width >= 54;
  drawAction('m', named ? selectLabel : '', 'selectHint');
  drawAction('x', named ? clearLabel : '', 'clearHint');
  const rightX = Math.max(1, settingsX - textWidth(right) - 2);
  canvas.put(rightX, height - 1, right, {
    fg: rightColor,
    bg: palette.bg,
    dim: !recent && !follow,
    bold: Boolean(recent && recent.kind !== 'info'),
  });
  rich(canvas, settingsX, height - 1, settingsWidth, [
    [settingsText, { fg: ui.settingsMenu ? palette.white : palette.accent2, bold: true }],
  ], palette, ui.settingsMenu ? palette.selection : palette.bg);
  hitboxes.settings = { x: settingsX, y: height - 1, w: settingsWidth, h: 1 };
}

function renderHelp(canvas, width, height, {
  palette, time, motion, language, snapshot, helpScroll = 0,
}, hitboxes) {
  canvas.fadeRect(0, 0, width, height, 0.58, palette.bg);
  const w = Math.min(68, width - 4);
  // 22 documented rows plus the pinned data line. A 26-row box still leaves
  // three rows of terminal margin, and keeps the whole list visible at 54x42.
  const h = Math.min(26, height - 3);
  const x = Math.floor((width - w) / 2);
  const y = Math.floor((height - h) / 2);
  canvas.fill(x, y, w, h, { bg: palette.panelAlt, fg: palette.text });
  canvas.box(x, y, w, h, {
    border: motion ? pulse(palette.accent, time / 700, 0.3) : palette.accent,
    bg: palette.panelAlt,
    title: t(language, 'helpTitle'),
    titleColor: palette.accent,
    double: true,
  });
  hitboxes.helpPanel = { x, y, w, h };
  const lines = [
    ['↑/↓  j/k', t(language, 'helpScroll')],
    ['PgUp / PgDn', t(language, 'helpPage')],
    ['g / G  Home/End', t(language, 'helpJump')],
    ['Tab / Shift-Tab', t(language, 'helpSelect')],
    ['t', t(language, 'helpTaskFocus')],
    ['1 / 2 / 3', t(language, 'helpDutyFocus')],
    ['Click', t(language, 'helpClick')],
    ['m', t(language, 'helpMouseSelection')],
    ['x / X', t(language, 'helpClearCompleted')],
    ['Mouse wheel', t(language, 'helpWheel')],
    ['← / →', t(language, 'helpRun')],
    ['Space / Enter', t(language, 'helpFold')],
    ['d', t(language, 'helpVerbose')],
    ['c / p / o', t(language, 'helpDiagnosis')],
    ['e / Esc', t(language, 'helpDetails')],
    ['v / /', t(language, 'helpSwitcher')],
    ['f', t(language, 'helpFollow')],
    ['s', t(language, 'helpSettings')],
    ['S', t(language, 'helpSidebar')],
    ['r', t(language, 'helpDemo')],
    ['? / Esc', t(language, 'helpClose')],
    ['q', t(language, 'helpQuit')],
  ];
  const visibleRows = Math.max(1, h - 4);
  const total = lines.length;
  const maxScroll = Math.max(0, total - visibleRows);
  const scroll = scrollOffset(helpScroll, maxScroll);
  if (maxScroll > 0) {
    const position = t(language, 'helpPosition', {
      start: scroll + 1,
      end: Math.min(total, scroll + visibleRows),
      total,
    });
    canvas.put(Math.max(x + 2, x + w - 3 - textWidth(position)), y, position, {
      fg: palette.faint, bg: palette.panelAlt, dim: true,
    });
  }
  let row = y + 2;
  for (const [key, description] of lines.slice(scroll, scroll + visibleRows)) {
    // Keep the demo-data footer row intact on short terminals.
    if (row >= y + h - 2) break;
    canvas.put(x + 3, row, fit(key, 18), { fg: palette.accent, bg: palette.panelAlt, bold: true });
    canvas.put(x + 23, row, fit(description, w - 26), { fg: palette.text, bg: palette.panelAlt });
    row++;
  }
  const dataLine = snapshotMode(snapshot) === 'demo'
    ? t(language, 'demoData')
    : t(language, 'helpDataSource', {
      mode: modeName(snapshotMode(snapshot), language),
      origin: snapshot?.provenance?.origin ?? t(language, 'provenanceUnavailable'),
      time: capturedDisplay(snapshot?.provenance?.capturedAt) ?? t(language, 'provenanceUnavailable'),
    });
  canvas.put(x + 3, y + h - 2, fit(dataLine, w - 6), {
    fg: palette.faint, bg: palette.panelAlt, dim: true,
  });
  return { scroll, maxScroll, visibleRows, total };
}

function renderSettingsMenu(canvas, width, height, {
  palette, time, motion, language, index, animation, themeName,
}, hitboxes) {
  canvas.fadeRect(0, 0, width, height, 0.58, palette.bg);
  const w = Math.min(48, width - 4);
  const h = Math.min(11, height - 3);
  const x = Math.floor((width - w) / 2);
  const y = Math.floor((height - h) / 2);
  canvas.fill(x, y, w, h, { bg: palette.panelAlt, fg: palette.text });
  canvas.box(x, y, w, h, {
    border: motion ? pulse(palette.accent, time / 700, 0.3) : palette.accent,
    bg: palette.panelAlt,
    title: t(language, 'settings'),
    titleColor: palette.accent,
    double: true,
  });
  const items = [
    { id: 'theme', label: t(language, 'theme'), value: themeName ?? palette.name },
    {
      id: 'animation',
      label: t(language, 'animation'),
      // Motion is not persisted yet, so the row says so instead of implying
      // Theme/Language-style durability.
      value: t(language, 'animationSession', { value: t(language, animation ? 'on' : 'off') }),
    },
    { id: 'language', label: t(language, 'language'), value: languageLabel(language) },
  ];
  items.forEach((item, itemIndex) => {
    const row = y + 3 + itemIndex;
    const selected = itemIndex === index;
    if (selected) canvas.fill(x + 2, row, w - 4, 1, { bg: palette.selection, fg: palette.text });
    const bg = selected ? palette.selection : palette.panelAlt;
    canvas.put(x + 3, row, fit(`${selected ? '▸ ' : '  '}${item.label}: ${item.value}`, w - 8), {
      fg: selected ? palette.white : palette.text,
      bg,
      bold: selected,
    });
    hitboxes.settingsOptions.set(item.id, { x: x + 2, y: row, w: w - 4, h: 1 });
  });
  canvas.put(x + 3, y + h - 2, fit(t(language, 'settingsHint'), w - 6), {
    fg: palette.faint, bg: palette.panelAlt, dim: true,
  });
}

export function switcherView(snapshot, ui) {
  const run = snapshot?.runs?.[clamp(ui?.runIndex ?? 0, 0, Math.max(0, (snapshot?.runs?.length ?? 0) - 1))];
  const all = switcherItems(snapshot, ui?.switcher?.frozenKeys, {
    preferRunId: run?.id,
    tasks: navTasks(snapshot),
  });
  const items = filterSwitcher(all, ui?.switcher?.query);
  return { items, activeKey: reconcileSwitcher(items, ui?.switcher?.activeKey) };
}

function renderSwitcher(canvas, width, height, snapshot, ui, { palette, time, motion, language }, hitboxes) {
  const { items, activeKey } = switcherView(snapshot, ui);
  const query = String(ui.switcher?.query ?? '');
  canvas.fadeRect(0, 0, width, height, 0.58, palette.bg);
  const w = Math.min(78, width - 4);
  const h = Math.min(Math.max(12, height - 4), 26);
  const x = Math.floor((width - w) / 2);
  const y = Math.floor((height - h) / 2);
  canvas.fill(x, y, w, h, { bg: palette.panelAlt, fg: palette.text });
  canvas.box(x, y, w, h, {
    border: motion ? pulse(palette.accent, time / 700, 0.3) : palette.accent,
    bg: palette.panelAlt,
    title: t(language, 'switcherTitle'),
    titleColor: palette.accent,
    double: true,
  });
  const countText = ` ${items.length} `;
  canvas.put(x + w - 1 - textWidth(countText), y, countText, {
    fg: palette.faint, bg: palette.panelAlt,
  });
  const filterLabel = t(language, 'switcherFilter');
  const filterRow = y + 1;
  canvas.fill(x + 1, filterRow, w - 2, 1, { bg: palette.selection, fg: palette.text });
  rich(canvas, x + 2, filterRow, w - 4, [
    [`/ ${filterLabel} `, { fg: palette.faint }],
    [query || ' ', { fg: palette.white, bold: Boolean(query) }],
    [query ? '' : '▏', { fg: palette.accent }],
  ], palette, palette.selection);
  hitboxes.switcherPanel = { x, y, w, h };
  hitboxes.switcherFilter = { x: x + 1, y: filterRow, w: w - 2, h: 1 };
  hitboxes.switcher = new Map();

  const listTop = y + 2;
  const listBottom = y + h - 2;
  const viewport = Math.max(1, listBottom - listTop);
  const rows = [];
  let lastKind;
  for (const item of items) {
    if (item.kind !== lastKind) {
      rows.push({
        header: item.kind === 'run' ? t(language, 'switcherRuns') : t(language, 'switcherTasks'),
      });
      lastKind = item.kind;
    }
    rows.push({ item });
  }
  const activeRow = Math.max(0, rows.findIndex(row => row.item?.key === activeKey));
  const maxScroll = Math.max(0, rows.length - viewport);
  const offset = clamp(activeRow - Math.floor(viewport / 2), 0, maxScroll);
  if (!items.length) {
    rich(canvas, x + 3, listTop, w - 6, [
      [t(language, 'switcherEmpty'), { fg: palette.faint, dim: true }],
    ], palette, palette.panelAlt);
  }
  let row = listTop;
  for (const entry of rows.slice(offset, offset + viewport)) {
    if (row >= listBottom) break;
    if (entry.header !== undefined) {
      rich(canvas, x + 2, row, w - 4, [
        [entry.header, { fg: palette.accent2, bold: true }],
        [' ', { fg: palette.faint }],
        ['─'.repeat(Math.max(0, w - textWidth(entry.header) - 5)), { fg: palette.border }],
      ], palette, palette.panelAlt);
      row++;
      continue;
    }
    const { item } = entry;
    const selected = item.key === activeKey;
    if (selected) canvas.fill(x + 1, row, w - 2, 1, { bg: palette.selection, fg: palette.text });
    const bg = selected ? palette.selection : palette.panelAlt;
    const itemColor = statusColor(palette, item.status);
    const detail = item.detail ? fit(item.detail, Math.max(8, Math.floor(w * 0.32))) : '';
    const labelWidth = Math.max(10, w - 10 - (detail ? textWidth(detail) + 2 : 0));
    rich(canvas, x + 2, row, w - 4, [
      [`${selected ? '▸' : ' '} `, { fg: selected ? palette.accent : palette.faint, bold: selected }],
      [`${statusIcon(item.status)} `, { fg: itemColor, bold: true }],
      [fit(item.label, labelWidth), { fg: selected ? palette.white : palette.text, bold: selected }],
      ...(detail ? [[`  ${detail}`, { fg: palette.faint }]] : []),
    ], palette, bg);
    hitboxes.switcher.set(item.key, { x: x + 1, y: row, w: w - 2, h: 1 });
    row++;
  }
  rich(canvas, x + 3, y + h - 2, w - 6, [
    [t(language, 'switcherHint'), { fg: palette.faint, dim: true }],
  ], palette, palette.panelAlt);
  return { items, activeKey };
}

export function renderApp(snapshot, ui, {
  width = 120, height = 40, time = 0, now = Date.now(), palette, theme, graphLayout,
  sidebar = ui.sidebar !== false,
} = {}) {
  width = Math.max(20, Math.floor(width));
  height = Math.max(12, Math.floor(height));
  const language = ui.language ?? 'en';
  const canvas = new Canvas(width, height, { fg: palette.text, bg: palette.bg });
  canvas.fill(0, 0, width, height, { bg: palette.bg, fg: palette.text });
  const layout = dashboardLayout(width, height, { sidebar, expanded: ui.expanded === true });
  const hitboxes = {
    nodes: new Map(), runs: new Map(), tasks: new Map(),
    settings: null, settingsOptions: new Map(), helpHint: null,
    selectHint: null, clearHint: null, helpPanel: null,
    context: {},
    regions: new Map(), scrollbars: new Map(),
    switcher: null, switcherPanel: null, switcherFilter: null,
  };
  const freshness = snapshotFreshness(snapshot, { now, staleAfterMs: ui.staleAfterMs });
  // A stale capture is no longer evidence of live work. The graph and the
  // navigation sidebar freeze their activity age and spinner/shimmer at the
  // capture instant; the header keeps the wall clock so the age of the capture
  // itself keeps growing, matching the frozen elapsed labels in details.
  const viewNow = freshness.stale ? freshness.frozenNow : now;
  const viewMotion = ui.motion !== false && !freshness.stale;
  renderHeader(canvas, width, snapshot, ui, {
    time, now, palette, motion: ui.motion !== false, language, freshness,
  }, hitboxes);
  let taskScroll = null;
  if (layout.sidebar) {
    panel(canvas, layout.sidebar, t(language, 'navigation'), { palette });
    taskScroll = renderSidebar(canvas, layout.sidebar, snapshot, ui, { time, now, palette, motion: viewMotion, language }, hitboxes);
  }
  const run = snapshot.runs[clamp(ui.runIndex, 0, Math.max(0, snapshot.runs.length - 1))];
  const graph = layout.graph
    ? graphPanel(canvas, layout.graph, snapshot, run, ui, {
      time, now, viewNow, palette, motion: viewMotion, language, graphLayout, freshness,
    })
    : { layout: null, scroll: 0, maxScroll: 0, viewportH: 0, nodeRects: new Map(), contentH: 0, bar: null };
  for (const [id, rect] of graph.nodeRects ?? []) hitboxes.nodes.set(id, rect);
  const motion = ui.motion !== false;
  const narrow = layout.layout === 'duty' && layout.details.h >= 12
    ? renderNarrowDuty(canvas, layout.details, snapshot, ui, {
      now, time, motion, palette, language, freshness,
    }, hitboxes)
    : null;
  const detailsScroll = narrow
    ? narrow.details
    : layout.layout === 'duty'
      ? renderDuty(canvas, layout.details, snapshot, ui, {
        now, time, motion, palette, language, freshness,
      })
      : renderDetails(canvas, layout.details, snapshot, ui, {
        now, time, motion, palette, language, freshness,
      });
  renderFooter(canvas, width, height, snapshot, ui, {
    palette, time, now, language, freshness,
  }, hitboxes);
  let helpInfo = null;
  if (ui.settingsMenu) {
    renderSettingsMenu(canvas, width, height, {
      palette, time, motion: ui.motion !== false, language,
      index: ui.settingsIndex ?? 0, animation: ui.motion !== false,
      themeName: ui.themeName,
    }, hitboxes);
  } else if (ui.help) {
    helpInfo = renderHelp(canvas, width, height, {
      palette, time, motion: ui.motion !== false, language, snapshot,
      helpScroll: ui.helpScroll,
    }, hitboxes);
  } else if (ui.switcher) {
    renderSwitcher(canvas, width, height, snapshot, ui, {
      palette, time, motion: ui.motion !== false, language,
    }, hitboxes);
    // A modal switcher owns the pointer: no stale row underneath can win a
    // click or a wheel event.
    hitboxes.nodes.clear();
    hitboxes.tasks.clear();
    hitboxes.runs.clear();
    hitboxes.regions.clear();
    hitboxes.scrollbars.clear();
    hitboxes.context = {};
    hitboxes.helpHint = null;
    hitboxes.selectHint = null;
    hitboxes.clearHint = null;
    hitboxes.helpPanel = null;
    hitboxes.settings = null;
    hitboxes.settingsOptions.clear();
  }
  const clipToBody = rect => {
    const x = Math.max(0, rect.x);
    const y = Math.max(HEADER_H, rect.y);
    const right = Math.min(width, rect.x + rect.w);
    const bottom = Math.min(height - FOOTER_H, rect.y + rect.h);
    return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
  };
  const addRegion = (id, rect) => {
    const clipped = clipToBody(rect);
    if (clipped.w > 0 && clipped.h > 0) hitboxes.regions.set(id, clipped);
  };
  if (!ui.settingsMenu && !ui.help && !ui.switcher) {
    if (layout.graph) addRegion('graph', layout.graph);
    if (taskScroll?.region) addRegion('tasks', taskScroll.region);
    if (narrow) {
      addRegion('runs', narrow.runs.region);
      addRegion('cells', narrow.cells.region);
      addRegion('details', narrow.detailsRect);
      if (narrow.runs.bar) hitboxes.scrollbars.set('runs', narrow.runs.bar);
      if (narrow.cells.bar) hitboxes.scrollbars.set('cells', narrow.cells.bar);
    } else {
      addRegion('details', layout.details);
    }
    if (graph.bar) hitboxes.scrollbars.set('graph', graph.bar);
    if (taskScroll?.bar) hitboxes.scrollbars.set('tasks', taskScroll.bar);
    if (detailsScroll.bar) hitboxes.scrollbars.set('details', detailsScroll.bar);
  }
  return {
    canvas,
    text: canvas.toString(theme),
    layout,
    graph,
    run,
    selectedNode: run?.nodes.find(node => node.id === ui.selectedNodeId),
    hitboxes,
    scroll: {
      graph: {
        viewportH: graph.viewportH,
        contentH: graph.contentH ?? 0,
        offset: graph.scroll,
        maxScroll: graph.maxScroll,
        bar: graph.bar ?? null,
      },
      tasks: taskScroll ?? { viewportH: 0, contentH: 0, offset: 0, maxScroll: 0, bar: null },
      runs: narrow?.runs ?? { viewportH: 0, contentH: 0, offset: 0, maxScroll: 0, bar: null },
      cells: narrow?.cells ?? { viewportH: 0, contentH: 0, offset: 0, maxScroll: 0, bar: null },
      details: detailsScroll,
    },
    detailsKey: detailsSubjectKey(snapshot, ui),
    help: helpInfo,
  };
}

export { contrastRatio, nodeScrollTarget, HEADER_H, FOOTER_H };
