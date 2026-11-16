import { Canvas } from './canvas.mjs';
import {
  createFrameBuffers, detailLine, detailSection, drawScrollbar, fixedBodyLines, graphCanvasFor,
  metricValue, panel, pill, rich, scratchCanvas,
} from './frame-primitives.mjs';
import { renderFooter, renderHeader } from './render-chrome.mjs';
import { renderDuty, renderNarrowDuty } from './render-duty.mjs';
import {
  invalidateOverlayHitboxes, renderHelp, renderPalette, renderSettingsMenu, renderSwitcher, renderTour,
} from './render-overlays.mjs';
import {
  runSummarySection, runWarningCount,
} from './render-summary.mjs';
import {
  isFailureState, nodeSubject, renderSubjectBody, shortPath, taskSubject,
} from './render-subject.mjs';
import { runSummary } from './run-summary.mjs';
import { memoNavTasks, memoProgressCounts } from './derived-cache.mjs';
import { criticalNodeIds, filterCounts, focusSubgraph, nodeMatchesFilter } from './cockpit.mjs';
import { diagnosisFor } from './diagnosis.mjs';
import { computeLayout, drawGraph, nodeScrollTarget, spinnerFrame } from './graph.mjs';
import { statusLabel, t } from './i18n.mjs';
import {
  activitySummary, compareNavigationTasks, elapsedLabel, incoming, isActiveRun, linkedTaskIds,
  linkedTaskIdsForRun, modeFor, nodeActivity, nodeForTask, nodeMap, outgoing, percentFor,
  PROVENANCE_FIELDS, PROVENANCE_KINDS, runStats, TERMINAL,
} from './model.mjs';
import { recordTargetFor } from './records.mjs';
import { scrollbarGeometry } from './scroll.mjs';
import {
  contrastRatio, pulse, statusColor, statusIcon,
} from './theme.mjs';
import { structuralFor } from './view-state.mjs';
import {
  clamp, clean, compactDuration, fit, percentBar,
  width as textWidth, wrap,
} from './text.mjs';
import { DEFAULT_STALE_AFTER_MS } from './config.mjs';

const HEADER_H = 3;
const FOOTER_H = 2;

// renderApp's canonical input is the view model built by view-model.mjs. The
// direct (snapshot, ui, options) form stays available for embedders and frame
// fixtures: it wraps the same pair in a bare model, never a second paint path.
const isViewModel = value => Boolean(value && typeof value === 'object' &&
  value.ui && Object.hasOwn(value, 'snapshot') && Object.hasOwn(value, 'frame'));
// A connected capture older than this is no longer evidence of live work. The
// threshold is shared with the viewer so direct render calls and `--help`
// cannot disagree; callers may override it per frame through `ui.staleAfterMs`.
export { DEFAULT_STALE_AFTER_MS, isFailureState };
export const displayRunName = run => run?.todoTitle || run?.name || '';
const THINKING_BODY_LINES = 5;
// The persisted reply is already bounded (1200 characters). This is only a
// defensive display bound so a pathological context cannot paint forever.
const REPLY_MAX_LINES = 256;

// Tasks shown in the navigation panel. Unlike standaloneTasks(), linked tasks
// are included: in real OmO sessions every root task may belong to a DAG node,
// so filtering linked tasks makes the navigation list permanently empty.
export function navTasks(snapshot) {
  return memoNavTasks(snapshot, state => (state?.tasks ?? [])
    .filter(task => !task.parentTaskId)
    .sort(compareNavigationTasks));
}

// Navigation tasks that no loaded run links to a node. The narrow duty pane
// paints this list because the wide task sidebar is not available there; a
// task-only snapshot is the whole surface, not an empty workflow.
export function orphanNavTasks(snapshot) {
  const linked = linkedTaskIds(snapshot ?? { runs: [] });
  return navTasks(snapshot).filter(task => !linked.has(task.id));
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
  const allTasks = navTasks(snapshot);
  const run = snapshot?.runs?.[ui?.runIndex];
  const linked = run
    ? allTasks.filter(task => linkedTaskIdsForRun(run).has(task.id))
    : [];
  const scoped = ui?.taskScope === 'all' || !run || !linked.length ? allTasks : linked;
  const scope = !run || !linked.length ? 'all' : ui.taskScope;
  const completed = scoped.filter(task => task.status === 'completed');
  const completedCollapsed = ui?.completedCollapsed !== false;
  const tasks = completedCollapsed
    ? scoped.filter(task => task.status !== 'completed' || task.id === ui?.selectedTaskId)
    : scoped;
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
    allTasks,
    scopeCount: scoped.length,
    scope,
    completedCount: completed.length,
    completedCollapsed,
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

export function isActiveSnapshot(snapshot) {
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

export function modeName(mode, language) {
  return t(language, mode === 'demo' ? 'modeDemo' : mode === 'saved' ? 'modeSaved' : 'modeLive');
}

// The header age must survive 54 columns, so it uses the largest whole unit
// (8h, 5m, 3s) instead of the full h/m/s clock form. The detail surfaces keep
// the exact clock where precision is useful.
export function compactAge(ms, language) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const zh = language === 'zh' || language === 'zh-cn';
  if (total >= 3600) return `${Math.floor(total / 3600)}${zh ? '小时' : 'h'}`;
  if (total >= 60) return `${Math.floor(total / 60)}${zh ? '分' : 'm'}`;
  return `${total}${zh ? '秒' : 's'}`;
}

export function modeColor(snapshot, palette, time, motion, freshness = snapshotFreshness(snapshot)) {
  const mode = snapshotMode(snapshot);
  if (mode === 'demo') return palette.accent2;
  if (mode === 'saved') return palette.faint;
  if (snapshot?.connected === false) return palette.warn;
  if (freshness.stale) return palette.warn;
  return motion ? pulse(palette.good, time / 700, 0.4) : palette.good;
}

export function capturedAgoLabel(snapshot, now, language) {
  const captured = snapshot?.provenance?.capturedAt;
  const at = captured ? Date.parse(captured) : NaN;
  if (!Number.isFinite(at)) return undefined;
  const age = Math.max(0, now - at);
  return age < 1500
    ? t(language, 'capturedAt', { time: t(language, 'now') })
    : t(language, 'capturedAgo', { time: compactAge(age, language) });
}

// The run summary follows the wall clock only for a live, fresh capture; saved
// and stale captures freeze at the capture instant. Resolve the clock and the
// localized age once so the painter and its pure row builder never read one.
export function summaryTime(run, snapshot, { now, viewNow, freshness, language }) {
  const live = isActiveSnapshot(snapshot) && !freshness?.stale;
  const capture = Date.parse(snapshot?.generatedAt ?? '') || Date.parse(run.updatedAt ?? '') || now;
  const clock = freshness?.stale ? freshness.frozenNow : live ? now : capture;
  return {
    clock,
    ageLabel: run.createdAt ? compactAge(viewNow - Date.parse(run.createdAt), language) : undefined,
  };
}

export function capturedDisplay(value) {
  if (!value) return undefined;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return `${new Date(at).toISOString().slice(0, 19)}Z`;
}

export function entityState(entity) {
  return entity?.state ?? entity?.status;
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

export function percentInfo(entity, language, counts) {
  const entry = entity?.provenance?.percent;
  const state = entityState(entity);
  // Only a model-computed `derived` entry is derived. A legacy v1/v2 snapshot
  // carries `unknown` provenance for an explicit percent, and an explicit
  // `unavailable` entry can still own a finite value; both keep the numeric
  // label instead of claiming a provenance the producer never supplied.
  // Completed status is a recorded fact. Without a recorded percent the only
  // honest completion value is the derived 100% the model supplies.
  const completedFallback = !Number.isFinite(entity?.percent) && state === 'completed';
  const derived = entry?.kind === 'derived' || completedFallback;
  const completedDerived = derived && state === 'completed';
  const derivedStatusLabel = value => t(language, 'percentDerivedStatus', { value });
  const value = percentFor(entity);
  if (value !== undefined) {
    const rounded = Math.round(value);
    const label = derived
      ? (completedDerived && rounded === 100
        ? derivedStatusLabel(rounded)
        : t(language, 'percentDerived', { value: rounded }))
      : `${rounded}%`;
    return { known: true, derived, value: rounded, label, compact: label };
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
export function progressCounts(snapshot, task, run) {
  return memoProgressCounts(snapshot, task, run, () => {
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
  });
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
  canvas.put(x, y, '─'.repeat(columns), { fg: palette.border, bg, dim: true });
  canvas.put(x + position, y, '█'.repeat(segment), {
    fg: color ?? palette.accent, bg, bold: !dim, dim,
  });
}

// Shared progress block. A known percent keeps its filled track and numeric
// label. An unknown percent on a running subject gets the indeterminate sweep
// plus the explicit label, inline when it fits and on its own row when not.
export function progressBlock(canvas, x, y, w, progress, {
  time = 0, motion = true, palette, color, bg, bold = false,
}) {
  if (progress.known) {
    const labelW = textWidth(progress.label);
    // A derived-status label can be wider than the narrow details body. Put
    // the bar on its own row instead of truncating the truth away.
    if (labelW + 8 > w) {
      rich(canvas, x, y, w, [
        [percentBar(progress.value, Math.max(6, w), { empty: '─' }), { fg: color, bold }],
      ], palette, bg);
      rich(canvas, x, y + 1, w, [
        [progress.label, { fg: palette.text, bold: true }],
      ], palette, bg);
      return y + 2;
    }
    const barW = Math.max(6, w - labelW - 2);
    rich(canvas, x, y, w, [
      [percentBar(progress.value, barW, { empty: '─' }), { fg: color, bold }],
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
export function renderEmptyState(canvas, x, y, w, h, snapshot, {
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

export function sourceHealthSection(canvas, x, y, w, snapshot, {
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
    const bar = stats.percentKnown ? percentBar(stats.percent, barWidth, { empty: '─' }) : '─'.repeat(barWidth);
    const attention = [];
    if (stats.counts.failed) attention.push([` ×${stats.counts.failed}`, { fg: palette.failed, bold: true }]);
    if (stats.counts.blocked) attention.push([` ◌${stats.counts.blocked}`, { fg: palette.blocked, bold: true }]);
    if (!attention.length) attention.push([` · ${stats.done}/${stats.total}`, { fg: palette.dim }]);
    rich(canvas, x + 2, y + 1, w - 2, [
      [bar, { fg: runColor(run, palette), dim: !selected }],
      [stats.percentKnown ? ` ${stats.percent}%` : ' —', { fg: selected ? palette.accent : palette.faint }],
      ...attention,
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
    [`  ${taskGeometry.scopeCount}`, { fg: palette.faint }],
    [` · ${taskGeometry.scope === 'all' ? t(language, 'taskScopeAll') : t(language, 'taskScopeRun')}`, { fg: palette.faint }],
    ...(taskGeometry.completedCollapsed && taskGeometry.completedCount
      ? [[` · ✓${taskGeometry.completedCount}`, { fg: palette.completed }]]
      : []),
  ], palette, palette.panel);
  hitboxes.tasksToggle = { x: taskGeometry.x, y: tasksY - 1, w: taskGeometry.w, h: 1 };
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
        [percentBar(progressInfo.value, progressWidth, { empty: '─' }), {
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
        ['─'.repeat(progressWidth), { fg: statusColor(palette, task.status), dim: !selected }],
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
  time, now, viewNow = now, palette, motion, language, graphLayout, freshness, buffers,
}) {
  const stats = run ? runStats(run) : null;
  const graphSummary = run ? runSummary(run, { now: viewNow }) : undefined;
  const warningCount = runWarningCount(run);
  const graphBadge = text => (warningCount
    ? `${t(language, 'warningsBadge', { count: warningCount })} · ${text}`
    : text);
  const criticalIds = criticalNodeIds(graphSummary);
  const graphRun = focusSubgraph(run, ui.graphFocus);
  const filter = ui.graphFilter ?? 'all';
  const selectedTask = navTasks(snapshot).find(candidate => candidate.id === ui.selectedTaskId);
  const unlinked = Boolean(ui.selectedTaskUnlinked && selectedTask);
  panel(canvas, rect, t(language, unlinked ? 'taskOverview' : 'graph'), {
    palette,
    focused: ui.focus === 'graph',
    badge: unlinked
      ? t(language, 'noNodeShort')
      : run
        ? graphBadge(stats.percentKnown
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
    layout = !ui.graphFocus && graphLayout && graphLayoutMatches(graphLayout, run)
      ? bindGraphLayout(graphLayout, run)
      : computeLayout(graphRun, contentW, { folded: ui.folded });
  } catch (error) {
    rich(canvas, innerX + 1, innerY + 1, innerW - 2, [
      [t(language, 'graphError', { error: error.message }), { fg: palette.failed, bold: true }],
    ], palette, palette.panel);
    return { layout: null, scroll: 0, maxScroll: 0, viewportH, nodeRects: new Map(), contentH: 0, bar: null };
  }
  const maxScroll = Math.max(0, layout.height - viewportH);
  const scroll = scrollOffset(ui.graphScroll, maxScroll);
  const offset = layout.height <= viewportH ? Math.floor((viewportH - layout.height) / 2) : -scroll;
  // Paint only the rows the blit can show. A tall wrapped graph used to
  // rasterize its whole height (100 nodes = 1103 rows) on every frame even
  // though the pane shows ~35 of them.
  const clipTop = layout.height <= viewportH ? 0 : scroll;
  const clipBottom = layout.height <= viewportH ? layout.height : scroll + viewportH;
  const graphCanvas = graphCanvasFor(buffers, layout.width, layout.height, palette);
  drawGraph(graphCanvas, layout, {
    time, motion, palette, selectedId: ui.selectedNodeId, folded: ui.folded,
    now: viewNow, connected: isActiveSnapshot(snapshot), language,
    clip: { top: clipTop, bottom: clipBottom },
  });
  if (filter !== 'all') {
    for (const box of layout.boxes.values()) {
      if (box.y + box.h <= clipTop || box.y >= clipBottom) continue;
      if (nodeMatchesFilter(box.node, filter, criticalIds)) continue;
      graphCanvas.fadeRect(box.x, box.y, box.w, box.h, 0.64, palette.bg);
    }
  }
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
  if (ui.graphFocus && ui.selectedNodeId) {
    const focusNode = run.nodes.find(node => node.id === ui.graphFocus);
    dependencyLine = t(language, 'graphFocusHint', { name: focusNode?.label ?? ui.graphFocus });
  } else if (filter === 'critical' && graphSummary?.critical?.labels?.length) {
    dependencyLine = `${t(language, 'pathShort')}: ${graphSummary.critical.labels.join(' → ')}`;
  } else if (filter !== 'all') {
    const count = filterCounts(run.nodes, graphSummary)[filter] ?? 0;
    const label = filter === 'failed' ? statusLabel(language, 'failed')
      : filter === 'blocked' ? statusLabel(language, 'blocked')
        : statusLabel(language, 'running');
    dependencyLine = `${t(language, 'switcherFilter')}: ${label} ${count}`;
  } else if (selected) {
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
export function selectionResolution(snapshot, args, key) {
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
export function resolveSelection(snapshot, ui, { allowRunFallback = false } = {}) {
  const runs = snapshot?.runs ?? [];
  const tasks = navTasks(snapshot);
  const baseRun = runs[clamp(ui?.runIndex ?? 0, 0, Math.max(0, runs.length - 1))];
  const focusedTask = tasks.find(candidate => candidate.id === ui?.selectedTaskId);
  const taskFocus = ui?.focus === 'tasks' || (ui?.focus === 'details' && ui?.lastFocus === 'tasks');
  const showTask = Boolean(taskFocus && focusedTask);
  const linked = showTask ? nodeForTask(snapshot, focusedTask.id) : undefined;
  const run = linked?.run ?? baseRun;
  const node = showTask
    ? linked?.node
    : baseRun?.nodes?.find(candidate => candidate.id === ui?.selectedNodeId);
  const task = showTask ? focusedTask : node?.task ?? focusedTask;
  const kind = showTask ? 'task' : node ? 'node' : allowRunFallback && run ? 'run' : null;
  const subject = kind === 'task' ? task : kind === 'node' ? node : kind === 'run' ? run : null;
  return { runs, tasks, run, task, node, showTask, kind, subject };
}

// Shared painters stay in this module; the subject body owns the one section
// order. The wrappers below only adapt the selected node or task and its clock.
const SUBJECT_SECTIONS = {
  progressBlock, sourceHealthSection, sourceSection, replyOutput, thinkingOutput,
};

function nodeDetails(canvas, rect, run, node, snapshot, ui, {
  now, time, motion = true, palette, language, viewportH, freshness,
}) {
  const viewNow = freshness?.stale ? freshness.frozenNow : now;
  const { diagnosis, record } = selectionResolution(
    snapshot,
    { snapshot, run, node, task: node.task, subject: 'node' },
    `node:${run?.id ?? ''}:${node.id}`,
  );
  const stats = runStats(run);
  const names = id => nodeMap(run).get(id)?.label ?? id;
  renderSubjectBody(canvas, rect, nodeSubject(node, run, {
    language,
    elapsed: elapsedLabel(node, { now: viewNow, connected: isActiveSnapshot(snapshot), updatedAt: run.updatedAt }),
    progress: percentInfo(node, language, { done: stats.done, total: stats.total }),
    diagnosis,
    record,
    activity: isActiveSnapshot(snapshot) ? activitySummary(nodeActivity(node), { now: viewNow, language }) : null,
    links: { from: incoming(run, node.id).map(names), to: outgoing(run, node.id).map(names) },
  }), {
    now, time, motion, palette, language, viewportH, freshness, snapshot, verbose: ui.verbose,
    sections: SUBJECT_SECTIONS,
  });
}

function taskDetails(canvas, rect, task, snapshot, ui, {
  now, time, motion = true, palette, language, viewportH, freshness,
}) {
  const viewNow = freshness?.stale ? freshness.frozenNow : now;
  const linked = nodeForTask(snapshot, task.id);
  const { diagnosis, record } = selectionResolution(
    snapshot,
    { snapshot, run: linked?.run, node: linked?.node, task, subject: 'task' },
    `task:${task.id}`,
  );
  renderSubjectBody(canvas, rect, taskSubject(task, {
    elapsed: elapsedLabel(task, { now: viewNow, connected: isActiveSnapshot(snapshot), updatedAt: snapshot.generatedAt }),
    progress: percentInfo(task, language, progressCounts(snapshot, task, linked?.run)),
    diagnosis,
    record,
    activity: isActiveSnapshot(snapshot) ? activitySummary(task.activity, { now: viewNow, language }) : null,
    warningRun: linked?.run,
  }), {
    now, time, motion, palette, language, viewportH, freshness, snapshot, verbose: ui.verbose,
    sections: SUBJECT_SECTIONS,
  });
}

function runOverview(canvas, rect, run, snapshot, { now, palette, language, verbose = false, freshness, filter = 'all' }) {
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
      [percentBar(stats.percent, Math.max(6, w - 8), { empty: '─' }), { fg: color }],
      [` ${stats.percent}%`, { fg: palette.text, bold: true }],
    ], palette, palette.panel);
  } else {
    rich(canvas, x, y, w, [[t(language, 'percentUnavailable'), { fg: palette.faint, dim: true }]], palette, palette.panel);
  }
  y += 2;
  y = runSummarySection(canvas, x, y, w, run, stats, {
    ...summaryTime(run, snapshot, { now, viewNow, freshness, language }),
    palette, language, filter,
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
  now, time, motion = true, palette, language, freshness, buffers,
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
  const body = scratchCanvas(buffers, 'body', rect.w, measureH, palette);
  const full = { x: 0, y: 0, w: rect.w, h: measureH };
  if (showTask) taskDetails(body, full, task, snapshot, ui, {
    now, time, motion, palette, language, viewportH: detailsViewportH, freshness,
  });
  else if (node) nodeDetails(body, full, run, node, snapshot, ui, {
    now, time, motion, palette, language, viewportH: detailsViewportH, freshness,
  });
  else runOverview(body, full, run, snapshot, {
    now, palette, language, verbose: ui.verbose, freshness, filter: ui.graphFilter,
  });
  const headings = [];
  for (let row = 2; row < measureH; row++) {
    const cells = body.cells[row];
    const label = [];
    let rule = false;
    for (let col = 1; col < rect.w - 1; col++) {
      const cell = cells[col];
      if (cell.cont) continue;
      if (cell.ch === '─' && cell.fg === palette.border) { rule = true; break; }
      if (cell.ch !== ' ') label.push(cell.ch);
    }
    if (!rule) continue;
    const heading = cells.some(cell => !cell.cont && cell.ch !== ' ' &&
      cell.fg === palette.accent2 && (cell.flags & 1));
    if (!heading) continue;
    headings.push({ row, label: label.join('').trim() });
  }
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    if (!ui.collapsedSections?.has(heading.label)) continue;
    const end = headings[index + 1]?.row ?? measureH;
    body.fill(1, heading.row + 1, rect.w - 2, Math.max(0, end - heading.row - 1), {
      fg: palette.text, bg: palette.panel,
    });
    body.put(rect.w - 3, heading.row, '▸', { fg: palette.accent2, bg: palette.panel, bold: true });
  }
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
  const inner = scratchCanvas(buffers, 'inner', rect.w, rect.h, palette);
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
  return { viewportH: detailsViewportH, contentH, offset, maxScroll, bar, headings: headings.map(item => ({ row: item.row - 2, label: item.label })) };
}

export function renderApp(viewOrSnapshot, uiOrOptions, options = {}) {
  const vm = isViewModel(viewOrSnapshot)
    ? viewOrSnapshot
    : { snapshot: viewOrSnapshot, ui: uiOrOptions, frame: null };
  if (isViewModel(viewOrSnapshot)) options = uiOrOptions ?? {};
  const snapshot = vm.snapshot;
  const ui = vm.ui;
  let { width = 120, height = 40 } = options;
  const {
    time = 0, now = Date.now(), palette, theme, graphLayout,
    sidebar = ui.sidebar !== false, buffers,
  } = options;
  width = Math.max(20, Math.floor(width));
  height = Math.max(12, Math.floor(height));
  // Frame buffers belong to the caller-supplied handle when one is passed in.
  // Otherwise this frame owns them: the grids are dropped when renderApp
  // returns and never survive as module state.
  const frameBuffers = buffers ?? createFrameBuffers();
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
    palette: null, palettePanel: null, paletteFilter: null,
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
      buffers: frameBuffers,
    })
    : { layout: null, scroll: 0, maxScroll: 0, viewportH: 0, nodeRects: new Map(), contentH: 0, bar: null };
  for (const [id, rect] of graph.nodeRects ?? []) hitboxes.nodes.set(id, rect);
  const motion = ui.motion !== false;
  const narrow = layout.layout === 'duty' && layout.details.h >= 12
    ? renderNarrowDuty(canvas, layout.details, snapshot, ui, {
      now, time, motion, palette, language, freshness, buffers: frameBuffers,
    }, hitboxes)
    : null;
  const detailsScroll = narrow
    ? narrow.details
    : layout.layout === 'duty'
      ? renderDuty(canvas, layout.details, snapshot, ui, {
        now, time, motion, palette, language, freshness, buffers: frameBuffers,
      })
      : renderDetails(canvas, layout.details, snapshot, ui, {
        now, time, motion, palette, language, freshness, buffers: frameBuffers,
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
  } else if (ui.palette) {
    renderPalette(canvas, width, height, ui, {
      palette, time, motion: ui.motion !== false, language,
    }, hitboxes);
    invalidateOverlayHitboxes(hitboxes);
  } else if (ui.tour) {
    renderTour(canvas, width, height, ui, { palette, language }, hitboxes);
    invalidateOverlayHitboxes(hitboxes);
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
    invalidateOverlayHitboxes(hitboxes, { hints: true });
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
      if (narrow.tasks?.region) addRegion('tasks', narrow.tasks.region);
      addRegion('details', narrow.detailsRect);
      if (narrow.runs.bar) hitboxes.scrollbars.set('runs', narrow.runs.bar);
      if (narrow.cells.bar) hitboxes.scrollbars.set('cells', narrow.cells.bar);
      if (narrow.tasks?.bar) hitboxes.scrollbars.set('tasks', narrow.tasks.bar);
    } else {
      addRegion('details', layout.details);
    }
    if (graph.bar) hitboxes.scrollbars.set('graph', graph.bar);
    if (taskScroll?.bar) hitboxes.scrollbars.set('tasks', taskScroll.bar);
    if (narrow?.tasks?.bar) hitboxes.scrollbars.set('tasks', narrow.tasks.bar);
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
      tasks: narrow?.tasks ?? taskScroll ?? { viewportH: 0, contentH: 0, offset: 0, maxScroll: 0, bar: null },
      runs: narrow?.runs ?? { viewportH: 0, contentH: 0, offset: 0, maxScroll: 0, bar: null },
      cells: narrow?.cells ?? { viewportH: 0, contentH: 0, offset: 0, maxScroll: 0, bar: null },
      details: detailsScroll,
    },
    detailsKey: detailsSubjectKey(snapshot, ui),
    help: helpInfo,
  };
}

export { contrastRatio, nodeScrollTarget, HEADER_H, FOOTER_H };
export { switcherView } from './render-overlays.mjs';
export { pillForeground } from './frame-primitives.mjs';
