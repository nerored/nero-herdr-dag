import { smoothScroll } from './scroll.mjs';
import { navTasks, taskAtPoint } from './render.mjs';
import { clamp } from './text.mjs';
import { advanceRunSelection } from './view-state.mjs';
import {
  ensureSelectionState, selectNode as selectNodeInRun, selectRunById, selectRunOverview,
  selectTaskHit,
} from './viewer-selection.mjs';

// The view model is the seam between snapshot/input orchestration and the
// pure frame renderer. It owns the current snapshot, the navigation state
// (`ui`), and the most recently painted frame. Hitboxes live on that frame,
// never on `ui`; only attachFrame may replace it.
export function buildViewModel(snapshot, ui) {
  return { snapshot, ui, frame: null };
}

// Store the frame returned by renderApp. This is the single writer of
// vm.frame: renderApp itself never mutates the model it reads.
export function attachFrame(vm, frame) {
  vm.frame = frame;
  return frame;
}

// Revalidate identity-based selection against `snapshot`. A draw-only call
// repairs dangling run/task/node ids. A snapshot transition also passes the
// previous run ids: follow may move once to a freshly observed run, and that
// run then owns the node/task subject exactly as the pre-boundary viewer did.
export function reconcile(vm, { snapshot = vm.snapshot, previousRunIds, hadRuns = false } = {}) {
  if (!vm || !snapshot) return vm;
  vm.snapshot = snapshot;
  const { ui } = vm;
  ensureSelectionState(ui, snapshot);
  if (previousRunIds !== undefined && ui.follow) {
    const advanced = advanceRunSelection(snapshot.runs, {
      previousRunIds, hadRuns, follow: ui.follow, pinned: ui.runPinned,
      runIndex: ui.runIndex, selectedRunId: ui.selectedRunId,
      followTarget: ui.followTarget,
    });
    if (advanced.fresh) {
      ui.runIndex = advanced.index;
      ui.selectedRunId = advanced.selectedRunId;
      // The fresh run owns the subject now. Move the task subject with the
      // node instead of leaving the previous task's id in the breadcrumb.
      const freshNode = advanced.fresh.nodes.find(node => node.state === 'running') ??
        advanced.fresh.nodes[0];
      ui.selectedNodeId = freshNode?.id;
      ui.selectedTaskId = freshNode?.taskId;
      ui.selectedTaskUnlinked = Boolean(freshNode?.taskId) &&
        !navTasks(snapshot).some(task => task.id === freshNode.taskId);
      ui.graphScroll = 0;
      ui.graphScrollTarget = 0;
      ui.manualScroll = false;
      ui.followTarget = advanced.followTarget;
    }
  }
  return vm;
}

// Selection reducers. The VM passes its own snapshot/ui pair so the reducer
// module stays a pure state transition and every caller shares one contract.
export function selectRun(vm, runId, { overview = false, scrollInfo = vm.frame?.scroll } = {}) {
  if (!vm?.snapshot) return false;
  return overview
    ? selectRunOverview(vm.ui, vm.snapshot, runId, scrollInfo)
    : selectRunById(vm.ui, vm.snapshot, runId, scrollInfo);
}

export function selectTask(vm, taskId) {
  if (!vm?.snapshot) return { handled: false, linked: undefined };
  return selectTaskHit(vm.ui, vm.snapshot, taskId);
}

export function selectNode(vm, direction, {
  absolute = false, scrollInfo = vm.frame?.scroll, structural = vm.frame?.layout?.layout,
} = {}) {
  return selectNodeInRun(vm.ui, vm.snapshot, direction, { absolute, scrollInfo, structural });
}

// Focus normalization stays with the model because it depends on the frame
// that was just painted. The caller supplies the structural class it is about
// to draw; last-frame metrics are the default evidence about painted regions.
function hasPaintedMetrics(scrollInfo) {
  if (!scrollInfo) return false;
  return ['runs', 'cells', 'tasks', 'graph', 'details']
    .some(region => Number.isFinite(scrollInfo?.[region]?.viewportH));
}

export function focusForStructural(focus, structural, scrollInfo) {
  const painted = region => (scrollInfo?.[region]?.viewportH ?? 0) > 0;
  const measured = hasPaintedMetrics(scrollInfo);
  if (structural === 'duty') {
    const next = focus === 'runs' || focus === 'cells' || focus === 'details' ? focus : 'details';
    return measured && next !== 'details' && !painted(next) ? 'details' : next;
  }
  if (structural === 'investigation') {
    let next = focus;
    if (focus === 'runs') next = 'tasks';
    else if (focus === 'cells') next = 'graph';
    else if (focus !== 'tasks' && focus !== 'graph' && focus !== 'details') next = 'graph';
    if (measured && next === 'tasks' && !painted('tasks')) next = 'graph';
    return next;
  }
  return 'details';
}

// Move focus into a region that exists in the current structural class. When a
// duty graph/task focus is inherited from a wide frame, the saved owner is
// retained so the duty body still shows the task subject instead of silently
// snapping back to a node.
export function applyFocusRequest(ui, focus, structural, scrollInfo) {
  const next = focusForStructural(focus, structural, scrollInfo);
  if (structural === 'duty' && (focus === 'graph' || focus === 'tasks')) ui.lastFocus = focus;
  ui.focus = next;
  return next;
}

export function applyFocus(vm, focus, structural, scrollInfo = vm.frame?.scroll) {
  return applyFocusRequest(vm.ui, focus, structural, scrollInfo);
}

// Fold the selected graph node in the current run. Persistence is the
// caller's policy: the model stays pure state and reports the new value.
export function toggleFold(vm, { persist } = {}) {
  const run = vm?.snapshot?.runs?.[vm.ui.runIndex];
  if (!run || vm.ui.focus !== 'graph') return false;
  const nodeId = vm.ui.selectedNodeId;
  if (!nodeId) return false;
  if (vm.ui.folded.has(nodeId)) vm.ui.folded.delete(nodeId);
  else vm.ui.folded.add(nodeId);
  if (vm.ui.foldedByRun instanceof Map) {
    vm.ui.foldedByRun.set(run.id, new Set(vm.ui.folded));
  }
  vm.ui.follow = false;
  vm.ui.manualScroll = false;
  persist?.(run.id, nodeId, !vm.ui.folded.has(nodeId));
  return true;
}

// Every scrollbar-backed region eases toward its target; wheel/key steps move
// the target and this settles the painted offset from the frame that was just
// produced. Hidden regions keep their last offset.
export function advanceScroll(ui, region, maxScroll, elapsedMs, interactive = true) {
  const key = `${region}Scroll`;
  const targetKey = `${region}ScrollTarget`;
  const max = Math.max(0, maxScroll ?? 0);
  ui[targetKey] = clamp(ui[targetKey] ?? 0, 0, max);
  ui[key] = interactive
    ? clamp(smoothScroll(ui[key] ?? 0, ui[targetKey], elapsedMs), 0, max)
    : ui[targetKey];
  return { key, targetKey, from: ui[key] };
}

export function settleScroll(vm, frame = vm?.frame, { elapsed = 0, interactive = true } = {}) {
  if (!vm || !frame) return vm;
  const { ui } = vm;
  // The graph region only exists in investigation. Its painted limit wins over
  // the target computed before the frame (a resize may have shrunk it).
  if (frame.layout?.graph) {
    ui.graphScrollTarget = clamp(ui.graphScrollTarget, 0, frame.scroll.graph.maxScroll);
    ui.graphScroll = clamp(ui.graphScroll, 0, frame.scroll.graph.maxScroll);
  }
  if (frame.scroll.tasks.viewportH > 0) {
    advanceScroll(ui, 'tasks', frame.scroll.tasks.maxScroll, elapsed, interactive);
  }
  for (const region of ['runs', 'cells']) {
    if (frame.scroll[region].viewportH > 0) {
      advanceScroll(ui, region, frame.scroll[region].maxScroll, elapsed, interactive);
    }
  }
  advanceScroll(ui, 'details', frame.scroll.details.maxScroll, elapsed, interactive);
  return vm;
}

const inside = (rect, x, y) => Boolean(rect) && x >= rect.x && x < rect.x + rect.w &&
  y >= rect.y && y < rect.y + rect.h;

// Footer actions own padded hitboxes; the pointer contract is resolved here so
// the viewer only activates the action it names.
export function footerActionAt(hitboxes, x, y) {
  if (!hitboxes || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const select = hitboxes.selectHint ?? hitboxes.mouseHint;
  if (inside(select, x, y)) return 'mouse';
  if (inside(hitboxes.clearHint, x, y)) return 'clear';
  return undefined;
}

// Resolve every clickable piece of frame chrome in the same order selectAt
// applies it: footer actions first, then the Help hint, then Settings.
export function chromeActionAt(hitboxes, x, y) {
  const footer = footerActionAt(hitboxes, x, y);
  if (footer) return footer;
  if (!hitboxes || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  if (inside(hitboxes.helpHint, x, y)) return 'help';
  if (inside(hitboxes.settings, x, y)) return 'settings';
  return undefined;
}

// Pure pointer resolution over the last painted frame. A missing subject
// resolves to null (or to the modal's backdrop) instead of falling through to a
// different id that happens to occupy the same cells now.
export function hitTargetAt(vm, x, y) {
  const frame = vm?.frame;
  if (!frame || !vm.snapshot || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const { ui } = vm;
  const hitboxes = frame.hitboxes;
  if (ui.palette) {
    for (const [id, rect] of hitboxes.palette ?? []) {
      if (inside(rect, x, y)) return { kind: 'palette', id };
    }
    if (inside(hitboxes.palettePanel, x, y)) return { kind: 'palette-panel' };
    return { kind: 'palette-backdrop' };
  }
  if (ui.switcher) {
    for (const [key, rect] of hitboxes.switcher ?? []) {
      if (inside(rect, x, y)) return { kind: 'switcher', key };
    }
    if (inside(hitboxes.switcherPanel, x, y)) return { kind: 'switcher-panel' };
    return { kind: 'switcher-backdrop' };
  }
  // Settings owns the pointer while open. Its panel paints over the
  // breadcrumb, so this branch must run before the context hitboxes.
  if (ui.settingsMenu) {
    for (const [id, rect] of hitboxes.settingsOptions ?? []) {
      if (inside(rect, x, y)) return { kind: 'settings', id };
    }
    return { kind: 'settings-backdrop' };
  }
  if (inside(hitboxes.tasksToggle, x, y)) return { kind: 'tasks-toggle' };
  const currentRun = id => (vm.snapshot.runs ?? []).find(run => run.id === id);
  const currentTask = id => navTasks(vm.snapshot).some(task => task.id === id);
  const currentNode = (runId, nodeId) => currentRun(runId)?.nodes?.some(node => node.id === nodeId);
  if (hitboxes.context) {
    for (const subject of ['task', 'node', 'run']) {
      const rect = hitboxes.context[subject];
      if (!inside(rect, x, y) || !rect.id) continue;
      // The breadcrumb is painted from the previous frame. A subject that left
      // the current snapshot is not a target: refuse it instead of selecting a
      // same-id subject in another run.
      if (subject === 'run' && !currentRun(rect.id)) return null;
      if (subject === 'task' && !currentTask(rect.id)) return null;
      if (subject === 'node' && !currentNode(frame.run?.id, rect.id)) return null;
      return { kind: 'context', subject, id: rect.id };
    }
  }
  const chrome = chromeActionAt(hitboxes, x, y);
  if (chrome) return { kind: 'chrome', action: chrome };
  for (const [id, rect] of hitboxes.nodes) {
    if (!inside(rect, x, y)) continue;
    if (!currentNode(frame.run?.id, id)) return null;
    return { kind: 'node', id };
  }
  // Resolve the task row from the current snapshot and frame geometry. The
  // painted hitboxes are from the previous frame; after a status reorder the
  // old id can still exist while the row under the pointer now belongs to a
  // different task, so the id is not trusted here.
  const task = taskAtPoint(frame.layout?.sidebar, vm.snapshot, ui, x, y);
  if (task) return { kind: 'task', id: task.id };
  for (const [id, rect] of hitboxes.runs) {
    if (inside(rect, x, y)) return currentRun(id) ? { kind: 'run', id } : null;
  }
  return null;
}
