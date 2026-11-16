// Pure view helpers shared by the renderer and its painters. This module is a
// leaf: it owns layout/view geometry, freshness and display labels, selection
// and record resolution, and the navigation re-exports. It must never import
// render.mjs or any render-* painter, and it owns no state, input, or terminal.
import { BoundedCache } from './bounded-cache.mjs';
import { DEFAULT_STALE_AFTER_MS } from './config.mjs';
import { memoNavTasks, memoProgressCounts } from './derived-cache.mjs';
import { diagnosisFor } from './diagnosis.mjs';
import { t } from './i18n.mjs';
import {
  linkedTaskIdsForRun, modeFor, navTasks as pureNavTasks, nodeForTask, orphanNavTasks,
  percentFor, isUnsuccessfulState, PROVENANCE_KINDS, runStats, TERMINAL,
} from './model.mjs';
import { recordTargetFor } from './records.mjs';
import { scrollbarGeometry } from './scroll.mjs';
import { pulse } from './theme.mjs';
import { clamp, clean, width as textWidth } from './text.mjs';
import { structuralFor } from './view-state.mjs';
export const HEADER_H = 3;
export const FOOTER_H = 2;

// A connected capture older than this is no longer evidence of live work. The
// threshold is shared with the viewer so direct render calls and `--help`
// cannot disagree; callers may override it per frame through `ui.staleAfterMs`.
export { DEFAULT_STALE_AFTER_MS };
export const isFailureState = state => isUnsuccessfulState(state);
export const displayRunName = run => run?.todoTitle || run?.name || '';

// Tasks shown in the navigation panel. Unlike standaloneTasks(), linked tasks
// are included: in real OmO sessions every root task may belong to a DAG node,
// so filtering linked tasks makes the navigation list permanently empty.
export function navTasks(snapshot) {
  return memoNavTasks(snapshot, pureNavTasks);
}

// Navigation tasks that no loaded run links to a node. The narrow duty pane
// paints this list because the wide task sidebar is not available there; a
// task-only snapshot is the whole surface, not an empty workflow.
export { orphanNavTasks };

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

// A cached layout keeps its geometry between snapshots, but every box must
// point at the current run's node object. Rebuild the map with shallow-copied
// boxes so the caller's cache is never mutated.
export function bindGraphLayout(layout, run) {
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
export function fixedSectionRows(body, language) {
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

export function runColor(run, palette) {
  if (run.status === 'running') return palette.running;
  if (run.status === 'failed') return palette.failed;
  if (run.status === 'completed') return palette.completed;
  return palette.pending;
}

// One mode contract for the header, freshness, record resolution, and the
// diagnosis copy. model.modeFor owns the demo/legacy/saved precedence.
export const snapshotMode = modeFor;

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

// The header and every details empty state use this one formatter over the
// freshness result, so the threshold that picks "now" and the unit that picks
// s/m/h cannot drift between surfaces.
export function captureAgeLabel(freshness, language, { compact = false } = {}) {
  const age = freshness?.ageMs;
  if (age === undefined) return undefined;
  if (age < 1500) return compact ? t(language, 'now') : t(language, 'capturedAt', { time: t(language, 'now') });
  const time = compactAge(age, language);
  return compact ? time : t(language, 'capturedAgo', { time });
}

// Compatibility export: callers that still pass (snapshot, now) share the one
// parse in snapshotFreshness instead of parsing capturedAt again.
export function capturedAgoLabel(snapshot, now, language) {
  return captureAgeLabel(snapshotFreshness(snapshot, { now }), language);
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

export function provenanceValue(entry, language) {
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
//
// Cap: SUBJECT_RESOLUTION_LIMIT resolved subjects per snapshot. A frame paints
// one details subject, so more than a handful only happens when the operator
// cycles selection quickly; the LRU then drops the least recently painted
// subject rather than retaining every key a snapshot ever saw. The WeakMap key
// is the snapshot itself, so an accepted read releases the whole inner cache
// with the old snapshot.
export const SUBJECT_RESOLUTION_LIMIT = 8;
const subjectResolutionCache = new WeakMap();
const subjectResolutionCounters = {
  snapshots: 0,
  hits: 0,
  misses: 0,
  evictions: 0,
  maxEntries: 0,
};

export function subjectResolutionStats() {
  return { limit: SUBJECT_RESOLUTION_LIMIT, ...subjectResolutionCounters };
}

export function selectionResolution(snapshot, args, key) {
  let entry = subjectResolutionCache.get(snapshot);
  if (!entry) {
    entry = {
      cache: new BoundedCache(SUBJECT_RESOLUTION_LIMIT, { name: 'subject-resolution' }),
      evictionsSeen: 0,
    };
    subjectResolutionCache.set(snapshot, entry);
    subjectResolutionCounters.snapshots++;
  }
  const cached = entry.cache.get(key);
  if (cached !== undefined) {
    subjectResolutionCounters.hits++;
    return cached;
  }
  subjectResolutionCounters.misses++;
  const resolved = {
    record: recordTargetFor(snapshot, args),
    diagnosis: diagnosisFor(args),
  };
  entry.cache.set(key, resolved);
  subjectResolutionCounters.evictions += entry.cache.evictions - entry.evictionsSeen;
  entry.evictionsSeen = entry.cache.evictions;
  if (entry.cache.size > subjectResolutionCounters.maxEntries) {
    subjectResolutionCounters.maxEntries = entry.cache.size;
  }
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
