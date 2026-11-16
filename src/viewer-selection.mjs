import { nodeScrollTarget } from './graph.mjs';
import { nodeForTask } from './model.mjs';
import { navTasks, taskAtPoint } from './render-view.mjs';
import { clamp } from './text.mjs';
import { reconcileRunSelection, syncFoldedRun } from './view-state.mjs';

// Selection reducers live here so a click, a keypress, a switcher row and a
// follow update share one implementation. They mutate the viewer UI object the
// renderer reads; nothing in this module draws or owns the snapshot.

// Align the explicit task subject with the run and node that own it. A
// replacement or externally driven task change must move the graph subject too;
// otherwise the breadcrumb names one task while the graph still highlights an
// unrelated node.
export function alignTaskSelection(ui, state, taskId) {
  ui.selectedTaskId = taskId;
  if (!taskId) {
    ui.selectedTaskUnlinked = false;
    ui.selectedNodeId = undefined;
    return undefined;
  }
  const preferRunId = ui.selectedRunId ?? state.runs[ui.runIndex]?.id;
  const linked = nodeForTask(state, taskId, { preferRunId });
  if (!linked) {
    ui.selectedTaskUnlinked = true;
    ui.selectedNodeId = undefined;
    return undefined;
  }
  const index = state.runs.findIndex(run => run.id === linked.run.id);
  if (index >= 0) {
    ui.runIndex = index;
    ui.selectedRunId = linked.run.id;
  }
  ui.selectedNodeId = linked.node.id;
  ui.selectedTaskUnlinked = false;
  return linked;
}

// Pure reconciliation used before every draw and on snapshot acceptance. It
// keeps run/task identity valid, but an explicit task selection without a
// loaded node owns the graph subject: auto-picking a node there would recreate
// the unrelated highlight the task click just cleared.
export function ensureSelectionState(ui, state) {
  if (!state) return;
  if (!state.runs.length) {
    ui.runIndex = 0;
    ui.selectedRunId = undefined;
    ui.runPinned = false;
    ui.selectedNodeId = undefined;
    // A task-only snapshot (or one whose runs are all hidden) still paints the
    // task list and task details. Clearing the task subject here would undo
    // every task click on the next draw, so validate it against the navigation
    // list and drop only a task that is no longer present.
    const tasks = navTasks(state);
    if (!tasks.some(task => task.id === ui.selectedTaskId)) {
      ui.selectedTaskId = undefined;
      ui.selectedTaskUnlinked = false;
    }
    ui.focus = 'tasks';
    syncFoldedRun(ui, undefined);
    return;
  }
  const selection = reconcileRunSelection(state.runs, {
    runIndex: ui.runIndex,
    selectedRunId: ui.selectedRunId,
  });
  ui.runIndex = selection.index;
  ui.selectedRunId = selection.selectedRunId;
  if (ui.runPinned && !state.runs.some(run => run.id === selection.selectedRunId)) {
    ui.runPinned = false;
  }
  // A run-level subject stays run-level across snapshots until the user picks a
  // node or task; do not fall back to the run's first node on every draw.
  if (ui.runOverview) {
    ui.selectedNodeId = undefined;
    ui.selectedTaskId = undefined;
    ui.selectedTaskUnlinked = false;
    syncFoldedRun(ui, state.runs[ui.runIndex]?.id);
    return;
  }
  const tasks = navTasks(state);
  if (!tasks.some(task => task.id === ui.selectedTaskId)) {
    // A node click can name a task the host store did not accept (the live
    // snapshot often has nodes but zero accepted tasks). Keep the clicked node
    // as the graph/cells subject instead of aligning to another task that
    // would move the highlight back to the run's first node.
    const run = state.runs[ui.runIndex];
    const nodeOwnsSubject = (ui.focus === 'graph' || ui.focus === 'cells')
      && run?.nodes.some(node => node.id === ui.selectedNodeId);
    if (nodeOwnsSubject) {
      ui.selectedTaskId = undefined;
      ui.selectedTaskUnlinked = false;
    } else {
      const replacement = tasks.find(task => task.status === 'running') ?? tasks[0];
      alignTaskSelection(ui, state, replacement?.id);
    }
  }
  // A later snapshot may supply the run for a task that was unlinked when the
  // user selected it. Adopt that node instead of leaving the subject neutral.
  if (ui.selectedTaskUnlinked && ui.selectedTaskId) {
    const linked = nodeForTask(state, ui.selectedTaskId);
    if (linked) {
      const index = state.runs.indexOf(linked.run);
      if (index >= 0) {
        ui.runIndex = index;
        ui.selectedRunId = linked.run.id;
      }
      ui.selectedNodeId = linked.node.id;
      ui.selectedTaskUnlinked = false;
    }
  }
  const run = state.runs[ui.runIndex];
  const unlinkedTaskOwnsSubject = ui.selectedTaskUnlinked &&
    (ui.focus === 'tasks' || (ui.focus === 'details' && ui.lastFocus === 'tasks'));
  if (unlinkedTaskOwnsSubject) {
    ui.selectedNodeId = undefined;
  } else if (!run.nodes.some(node => node.id === ui.selectedNodeId)) {
    ui.selectedNodeId = (run.nodes.find(node => node.state === 'running') ?? run.nodes[0])?.id;
  }
  syncFoldedRun(ui, run.id);
}

// One node-subject writer for every transition that makes a node current. The
// caller owns focus and scroll-reset policy; this only moves the node/task/run
// identity. `manualScroll` is preserved as a data bit because the next frame
// must not recenter a node the pointer deliberately selected.
export function setNodeSubject(ui, state, nodeId, {
  manualScroll = false, runId, syncTask = true,
} = {}) {
  const runs = state?.runs ?? [];
  const run = runId === undefined
    ? runs.find(candidate => candidate.nodes?.some(node => node.id === nodeId))
    : runs.find(candidate => candidate.id === runId);
  if (!run) return undefined;
  const node = nodeId === undefined ? undefined : run.nodes?.find(candidate => candidate.id === nodeId);
  if (nodeId !== undefined && !node) return undefined;
  const index = runs.indexOf(run);
  if (index >= 0) {
    ui.runIndex = index;
    ui.selectedRunId = run.id;
    ui.runPinned = true;
  }
  ui.selectedNodeId = node?.id;
  ui.runOverview = false;
  if (syncTask) ui.selectedTaskId = node?.taskId;
  ui.selectedTaskUnlinked = false;
  ui.follow = false;
  ui.followTarget = undefined;
  ui.manualScroll = manualScroll;
  return { run, node, index };
}

// Pure task-selection transition. A linked task switches run and node; a task
// without a loaded node becomes an explicit neutral subject: details stay on
// the task, the previous node highlight is dropped, and the graph keeps its
// current run context. ensureSelectionState honors that state until graph
// focus or a linked selection takes the subject back.
export function applyTaskSelection(ui, state, taskId) {
  if (!state || !taskId) return undefined;
  ui.runOverview = false;
  ui.selectedTaskId = taskId;
  ui.focus = 'tasks';
  ui.follow = false;
  ui.followTarget = undefined;
  // A task id may appear in several historical runs. Stay in the run the user
  // is already viewing instead of jumping to the first run in display order.
  const preferRunId = ui.selectedRunId ?? state.runs[ui.runIndex]?.id;
  const linked = nodeForTask(state, taskId, { preferRunId });
  if (!linked) {
    ui.selectedTaskUnlinked = true;
    ui.selectedNodeId = undefined;
    ui.graphScroll = 0;
    ui.graphScrollTarget = 0;
    ui.manualScroll = false;
    return undefined;
  }
  ui.selectedTaskUnlinked = false;
  const index = state.runs.findIndex(run => run.id === linked.run.id);
  if (index >= 0 && index !== ui.runIndex) {
    ui.graphScroll = 0;
    ui.graphScrollTarget = 0;
  }
  setNodeSubject(ui, state, linked.node.id, { runId: linked.run.id });
  // A task selection is an explicit jump: center its node even after a manual
  // graph scroll.
  ui.manualScroll = false;
  return linked;
}

// Click path: task hitboxes are painted from the previous frame. If the id is
// no longer a navigation task (a snapshot reorder or removal moved the row),
// ignore the hit instead of selecting a subject that is not under the pointer.
export function selectTaskHit(ui, state, taskId) {
  if (!taskId) return { handled: false, linked: undefined };
  const task = navTasks(state ?? { runs: [], tasks: [] }).find(candidate => candidate.id === taskId);
  if (!task) return { handled: false, linked: undefined };
  return { handled: true, linked: applyTaskSelection(ui, state, task.id) };
}

// Click resolution: map the pointer to the row painted now (current snapshot
// and frame geometry), then apply the same validated task transition used by
// keyboard selection. A removed row resolves to no task instead of a stale id.
export function selectTaskAtPoint(ui, state, rect, x, y) {
  const task = taskAtPoint(rect, state, ui, x, y);
  if (!task) return { handled: false, linked: undefined };
  return { handled: true, ...selectTaskHit(ui, state, task.id) };
}

// Bring an index inside the painted window of a list. A zero/unknown viewport
// still sends the offset back up when the selection is above it.
export function revealScrollOffset(offset, index, viewport, maxScroll = Infinity) {
  let next = clamp(Number(offset) || 0, 0, maxScroll);
  if (index < 0) return next;
  if (index < next) next = index;
  else if (viewport > 0 && index >= next + viewport) next = index - viewport + 1;
  return clamp(next, 0, maxScroll);
}

export function selectRunById(ui, state, runId, scrollInfo = {}) {
  if (!state?.runs?.length) return false;
  const index = state.runs.findIndex(run => run.id === runId);
  if (index < 0) return false;
  const run = state.runs[index];
  ui.graphFilter = 'all';
  ui.graphFocus = undefined;
  const node = run.nodes.find(candidate => candidate.state === 'running') ?? run.nodes[0];
  // Run selection moves the node subject but keeps the task breadcrumb, which
  // matches the shipped run frame.
  setNodeSubject(ui, state, node?.id, { runId: run.id, syncTask: false });
  ui.graphScroll = 0;
  ui.graphScrollTarget = 0;
  ui.cellsScroll = 0;
  ui.cellsScrollTarget = 0;
  const runs = scrollInfo?.runs;
  ui.runsScroll = revealScrollOffset(ui.runsScroll ?? 0, index, runs?.viewportH ?? 0, runs?.maxScroll ?? Infinity);
  ui.runsScrollTarget = ui.runsScroll;
  if (ui.expanded) {
    ui.focus = 'details';
    ui.lastFocus = 'graph';
  } else {
    ui.focus = 'graph';
  }
  return true;
}

// Select the run itself: clear the node/task subject so the details pane paints
// the run summary. Node/task selections clear this flag in turn.
export function selectRunOverview(ui, state, runId, scrollInfo = {}) {
  if (!state?.runs?.length) return false;
  const index = state.runs.findIndex(run => run.id === runId);
  if (index < 0) return false;
  const run = state.runs[index];
  ui.runIndex = index;
  ui.selectedRunId = run.id;
  ui.runPinned = true;
  ui.runOverview = true;
  ui.graphFilter = 'all';
  ui.graphFocus = undefined;
  ui.selectedNodeId = undefined;
  ui.selectedTaskId = undefined;
  ui.selectedTaskUnlinked = false;
  ui.graphScroll = 0;
  ui.graphScrollTarget = 0;
  ui.cellsScroll = 0;
  ui.cellsScrollTarget = 0;
  const runs = scrollInfo?.runs;
  ui.runsScroll = revealScrollOffset(ui.runsScroll ?? 0, index, runs?.viewportH ?? 0, runs?.maxScroll ?? Infinity);
  ui.runsScrollTarget = ui.runsScroll;
  ui.follow = false;
  ui.followTarget = undefined;
  ui.manualScroll = false;
  ui.focus = 'details';
  ui.lastFocus = 'graph';
  return true;
}

export function applySwitcherSelection(ui, state, item, scrollInfo = {}) {
  if (!state || !item) return { handled: false, stale: true, linked: undefined };
  if (item.kind === 'run') {
    const handled = selectRunOverview(ui, state, item.id, scrollInfo);
    return { handled, stale: !handled, linked: undefined };
  }
  if (item.kind === 'node') {
    const run = state.runs.find(candidate => candidate.id === item.runId);
    const node = run?.nodes?.find(candidate => candidate.id === item.id);
    if (!run || !node) return { handled: false, stale: true, linked: undefined };
    setNodeSubject(ui, state, node.id, { runId: run.id });
    ui.graphFilter = 'all';
    ui.graphFocus = undefined;
    ui.graphScroll = 0;
    ui.graphScrollTarget = 0;
    ui.cellsScroll = 0;
    ui.cellsScrollTarget = 0;
    ui.focus = ui.expanded ? 'details' : 'graph';
    if (ui.expanded) ui.lastFocus = 'graph';
    return { handled: true, stale: false, linked: true };
  }
  if (item.kind !== 'task') return { handled: false, stale: true, linked: undefined };
  if (!navTasks(state).some(task => task.id === item.id)) {
    return { handled: false, stale: true, linked: undefined };
  }
  const result = selectTaskHit(ui, state, item.id);
  if (result.handled && ui.expanded) {
    ui.focus = 'details';
    ui.lastFocus = 'tasks';
  }
  return { handled: result.handled, stale: !result.handled, linked: result.linked };
}

// Pure next-frame scroll decision. Only a selected (or followed) node re-centers;
// an unlinked task subject resolves to the top of the graph.
export function selectionScrollTarget(ui, state, layout, viewportHeight) {
  if (!layout || ui.manualScroll) return undefined;
  const targetId = ui.follow && state?.connected && ui.followTarget?.kind === 'node'
    ? ui.followTarget.nodeId
    : ui.selectedNodeId;
  return nodeScrollTarget(layout, targetId, viewportHeight);
}

// Keep a selected duty list row inside the painted slice. RUNS/CELLS are
// one-row windows on short terminals, so selection changes must move their
// offsets exactly like revealTaskSelection moves the task sidebar.
function revealListSelection(ui, scrollInfo, region, index) {
  const info = scrollInfo?.[region];
  if (!info || !(info.viewportH > 0) || index < 0) return;
  const key = `${region}Scroll`;
  const targetKey = `${region}ScrollTarget`;
  const offset = revealScrollOffset(ui[key] ?? 0, index, info.viewportH, info.maxScroll ?? 0);
  ui[targetKey] = offset;
  ui[key] = offset;
}

// Cycle the graph/cells subject within the current run. `structural` is the
// painted layout class, so duty selects the CELLS row and investigation keeps
// the graph focus.
export function selectNode(ui, state, direction, { absolute = false, scrollInfo = {}, structural } = {}) {
  const run = state?.runs?.[ui.runIndex];
  if (!run?.nodes.length) return;
  const current = Math.max(0, run.nodes.findIndex(node => node.id === ui.selectedNodeId));
  const index = absolute ? direction : (current + direction + run.nodes.length) % run.nodes.length;
  setNodeSubject(ui, state, run.nodes[index].id, { runId: run.id });
  revealListSelection(ui, scrollInfo, 'cells', index);
  ui.focus = structural === 'duty' ? 'cells' : 'graph';
}
