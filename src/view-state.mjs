import { readJson, writeJson } from './storage.mjs';
import { compareNavigationTasks, nodeForTask, runStats, TERMINAL } from './model.mjs';

// Keep terminal work visible for five minutes after it finishes. The x clear
// action hides only finished subjects older than this window, and never hides
// a subject that is still running.
export const CLEAR_RECENT_MS = 5 * 60_000;

// Narrow duty / fullscreen investigation boundary. The sidebar is an escape
// hatch on investigation only; duty and expanded always own the whole body.
const INVESTIGATION_MIN_WIDTH = 112;

function emptyViewState(sessionId) {
  return { version: 1, sessionId: sessionId ?? null, expanded: {} };
}

export async function loadViewState(stateFile, sessionId) {
  const saved = await readJson(`${stateFile}.view.json`);
  if (!saved) return emptyViewState(sessionId);
  if (saved.version !== 1 || !saved.expanded || typeof saved.expanded !== 'object' ||
      Array.isArray(saved.expanded) || Object.values(saved.expanded).some(value => typeof value !== 'boolean')) {
    throw new Error('Invalid DAG view preferences.');
  }
  return saved.sessionId === (sessionId ?? null) ? saved : emptyViewState(sessionId);
}

const key = (runId, nodeId) => JSON.stringify([runId, nodeId]);

// Finished subjects are hidden from the current viewer session, never deleted
// from a snapshot. A terminal subject is eligible only when its finish time is
// outside the recent window; running/pending/blocked subjects never qualify.
const finishedAt = item => {
  const value = Date.parse(item?.completedAt ?? item?.updatedAt ?? item?.startedAt ?? '');
  return Number.isFinite(value) ? value : undefined;
};

export function completedItems(state, { now = Date.now(), recentMs = CLEAR_RECENT_MS } = {}) {
  const cutoff = now - Math.max(0, recentMs);
  const expired = item => {
    if (!TERMINAL.has(item?.status)) return false;
    const at = finishedAt(item);
    return at === undefined || at < cutoff;
  };
  return {
    runs: (state?.runs ?? []).filter(expired),
    tasks: (state?.tasks ?? []).filter(task => !task.parentTaskId && expired(task)),
  };
}

export function hiddenSnapshot(state, { runIds = new Set(), taskIds = new Set() } = {}) {
  if (!state) return state;
  const hiddenRuns = runIds instanceof Set ? runIds : new Set(runIds ?? []);
  const hiddenTasks = taskIds instanceof Set ? taskIds : new Set(taskIds ?? []);
  if (!hiddenRuns.size && !hiddenTasks.size) return state;
  const linked = new Set(hiddenTasks);
  const taskById = new Map((state.tasks ?? []).map(task => [task.id, task]));
  for (const run of state.runs ?? []) {
    if (!hiddenRuns.has(run.id)) continue;
    for (const node of run.nodes ?? []) {
      if (!node.taskId) continue;
      // A cleared run takes its finished tasks with it; a queued/blocked/
      // running task is still live work and must stay visible on its own.
      const task = taskById.get(node.taskId);
      if (task && TERMINAL.has(task.status)) linked.add(task.id);
    }
  }
  const runs = (state.runs ?? []).filter(run => !hiddenRuns.has(run.id));
  const tasks = (state.tasks ?? []).filter(task => !linked.has(task.id));
  if (runs.length === (state.runs ?? []).length && tasks.length === (state.tasks ?? []).length) return state;
  return { ...state, runs, tasks };
}

export function setExpanded(view, runId, nodeId, expanded) {
  view.expanded[key(runId, nodeId)] = expanded;
}

// The saved keys are already per (runId,nodeId). Callers that paint one run
// can pass its id to keep same-id nodes in other runs out of the folded set;
// the viewer still needs to pass the selected run before cross-run leakage is
// gone end to end.
export function foldedFromView(view, runId) {
  const folded = new Set();
  for (const [encoded, expanded] of Object.entries(view?.expanded ?? {})) {
    if (expanded) continue;
    try {
      const [savedRunId, nodeId] = JSON.parse(encoded);
      if (typeof nodeId !== 'string') continue;
      if (runId !== undefined && savedRunId !== runId) continue;
      folded.add(nodeId);
    } catch { /* ignore malformed keys */ }
  }
  return folded;
}

// In-memory fold scope for the viewer. `ui.folded` always describes the run in
// `ui.foldedRunId`; switching runs parks the current set and restores the
// destination's set, so collapsing a same-id node in one run never hides it in
// another. Persisted preferences are still loaded per run through
// foldedFromView(view, runId).
export function syncFoldedRun(ui, runId) {
  if (!ui) return undefined;
  if (!(ui.foldedByRun instanceof Map)) ui.foldedByRun = new Map();
  if (ui.foldedRunId === runId) return ui.folded;
  if (ui.foldedRunId !== undefined && ui.folded instanceof Set) {
    ui.foldedByRun.set(ui.foldedRunId, new Set(ui.folded));
  }
  ui.foldedRunId = runId;
  ui.folded = new Set(runId === undefined ? [] : ui.foldedByRun.get(runId) ?? []);
  return ui.folded;
}

export function reconcileRunSelection(runs, { runIndex = 0, selectedRunId } = {}) {
  const known = selectedRunId ? runs.findIndex(run => run.id === selectedRunId) : -1;
  const index = known >= 0
    ? known
    : Math.min(Math.max(runIndex, 0), Math.max(0, runs.length - 1));
  return { index, selectedRunId: runs[index]?.id };
}

export function newlyObservedRun(runs, previousRunIds) {
  return runs.find(run => !previousRunIds.has(run.id));
}

export function followTargetForRun(run) {
  if (!run) return undefined;
  const running = run.nodes.find(node => node.state === 'running');
  return running
    ? { kind: 'node', runId: run.id, nodeId: running.id, taskId: running.taskId }
    : { kind: 'run', runId: run.id };
}

export function holdsPendingRun(target, run) {
  return Boolean(run) && target?.kind === 'run' && target.runId === run.id &&
    !run.nodes.some(node => node.state === 'running');
}

// Reconcile identity-based run state for a snapshot transition. A run id that
// was not present before (and is not pinned by an explicit choice) becomes the
// selection; a freshly observed pending run is held by a run-kind follow
// target so sticky follow cannot drag the view back to an older running run.
export function advanceRunSelection(runs, {
  previousRunIds = new Set(), hadRuns = false, follow = false, pinned = false,
  runIndex = 0, selectedRunId, followTarget,
} = {}) {
  const reconciled = reconcileRunSelection(runs, { runIndex, selectedRunId });
  if (hadRuns && follow && !pinned) {
    const fresh = newlyObservedRun(runs, previousRunIds);
    if (fresh) {
      return {
        index: runs.indexOf(fresh),
        selectedRunId: fresh.id,
        followTarget: followTargetForRun(fresh),
        fresh,
      };
    }
  }
  return {
    index: reconciled.index,
    selectedRunId: reconciled.selectedRunId,
    followTarget,
    fresh: undefined,
  };
}

export const saveViewState = (stateFile, view) => writeJson(`${stateFile}.view.json`, view);

// Structural class for the current width and overlay state. Duty is the
// primary surface below the investigation breakpoint; expanded overrides the
// width class so resize keeps the overlay until Esc.
export function structuralFor(width, { expanded = false, sidebar = true } = {}) {
  if (expanded) return 'expanded';
  return Math.max(0, Math.floor(Number(width) || 0)) >= INVESTIGATION_MIN_WIDTH
    ? 'investigation'
    : 'duty';
}

// Regions that can receive wheel/keyboard scrolling in a structural class.
// Investigation exposes the sidebar task list only when it is painted.
export function scrollRegionFor(structural, { sidebar = true } = {}) {
  if (structural === 'investigation') return sidebar ? ['tasks', 'graph', 'details'] : ['graph', 'details'];
  if (structural === 'duty') return ['details'];
  return ['details'];
}

// Overlay transitions are pure descriptors: the caller assigns them onto ui.
// Expansion saves the owner of the subject so collapsing restores the region
// that was active before details took the body; repeat expansion is a no-op.
const FOCUS_REGIONS = new Set(['tasks', 'graph', 'details', 'runs', 'cells']);
const validFocus = value => FOCUS_REGIONS.has(value) ? value : undefined;

export function expandTransition(ui = {}) {
  if (ui.expanded) {
    return { expanded: true, focus: 'details', lastFocus: ui.lastFocus, returnFocus: ui.returnFocus };
  }
  const owner = validFocus(ui.focus) ?? 'graph';
  return { expanded: true, focus: 'details', lastFocus: owner, returnFocus: owner, follow: false };
}

export function collapseTransition(ui = {}) {
  if (!ui.expanded) return null;
  const returnFocus = validFocus(ui.returnFocus) ?? validFocus(ui.lastFocus) ?? 'graph';
  return { expanded: false, focus: returnFocus };
}

// Clamp offsets only for regions that are currently painted. Hidden regions
// keep their last offset so a resize or a collapse does not rewind the view.
export function preserveScrolls(offsets = {}, { visible = {}, limits = {} } = {}) {
  const next = {};
  for (const [key, raw] of Object.entries(offsets)) {
    const value = Math.max(0, Number(raw) || 0);
    const hidden = visible[key] === false;
    next[key] = hidden ? value : Math.min(value, Math.max(0, Number(limits[key]) || 0));
  }
  return next;
}

// Runs first in snapshot order, then navigation tasks. A frozen key list keeps
// row order stable while a live snapshot changes; values refresh by key and a
// removed subject disappears. Keys not seen when the switcher opened append at
// the end of their group instead of silently becoming unreachable.
function navigationTasks(snapshot) {
  return (snapshot?.tasks ?? [])
    .filter(task => !task.parentTaskId)
    .sort(compareNavigationTasks);
}

export function switcherItems(snapshot, frozenKeys, { preferRunId, tasks } = {}) {
  const runs = snapshot?.runs ?? [];
  const taskList = tasks ?? navigationTasks(snapshot);
  const fresh = [];
  for (const run of runs) {
    const stats = runStats(run);
    fresh.push({
      key: `run:${run.id}`,
      kind: 'run',
      id: run.id,
      label: run.todoTitle || run.name,
      status: run.status,
      detail: stats.percentKnown
        ? `${stats.done}/${stats.total} · ${stats.percent}%`
        : `${stats.done}/${stats.total} · ${stats.counts.running ?? 0} running`,
      search: ['run', run.id, run.name, run.todoTitle, run.status,
        ...(run.nodes ?? []).flatMap(node => [node.id, node.label, node.taskId ?? '']),
      ].filter(Boolean).join(' '),
    });
  }
  for (const task of taskList) {
    const linked = nodeForTask(snapshot, task.id, { preferRunId });
    fresh.push({
      key: `task:${task.id}`,
      kind: 'task',
      id: task.id,
      label: task.description,
      status: task.status,
      detail: [task.id, task.agent, task.model, task.category, task.type].filter(Boolean).join(' · '),
      runId: linked?.run?.id,
      nodeId: linked?.node?.id,
      search: ['task', task.id, task.description, task.status, task.agent, task.model,
        task.category, task.type, linked?.run?.id, linked?.run?.name,
        linked?.node?.id, linked?.node?.label,
      ].filter(Boolean).join(' '),
    });
  }
  if (!Array.isArray(frozenKeys) || !frozenKeys.length) return fresh;
  const byKey = new Map(fresh.map(item => [item.key, item]));
  const ordered = [];
  const seen = new Set();
  for (const key of frozenKeys) {
    const item = byKey.get(key);
    if (!item || seen.has(key)) continue;
    ordered.push(item);
    seen.add(key);
  }
  for (const item of fresh) {
    if (!seen.has(item.key)) ordered.push(item);
  }
  return ordered;
}

// Lowercased AND tokens over the item's search text. CJK has no whitespace
// tokenisation, so a multi-character query is also a straight substring test.
export function filterSwitcher(items, query) {
  const tokens = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items;
  return items.filter(item => {
    const haystack = String(item.search ?? `${item.id} ${item.label ?? ''}`).toLowerCase();
    return tokens.every(token => haystack.includes(token));
  });
}

// Selection movement is over the flat item list; group headers are paint-only
// and can never become active.
export function moveSwitcher(items, activeKey, delta, { wrap = true } = {}) {
  if (!items?.length) return undefined;
  let index = items.findIndex(item => item.key === activeKey);
  if (index < 0) index = delta > 0 ? -1 : 0;
  index += delta;
  if (wrap) index = ((index % items.length) + items.length) % items.length;
  else index = Math.max(0, Math.min(items.length - 1, index));
  return items[index]?.key;
}

// A stale active id is rejected in favor of the first surviving row.
export function reconcileSwitcher(items, activeKey) {
  if (!items?.length) return undefined;
  return items.some(item => item.key === activeKey) ? activeKey : items[0].key;
}
