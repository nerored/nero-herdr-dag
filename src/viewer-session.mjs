import { setTimeout as delay } from 'node:timers/promises';
import { SingleEntryCache } from './bounded-cache.mjs';
import { nextNodeId } from './cockpit.mjs';
import { commandItems, filterCommands } from './commands.mjs';
import { saveConfig, staleAfterMs } from './config.mjs';
import { computeLayout, graphLayoutKey } from './graph.mjs';
import { languageLabel, normalizeLanguage, t } from './i18n.mjs';
import {
  findRunningTarget, isVirtualRun, navTasks, nodeForTask, normalizeSnapshot, orphanNavTasks,
} from './model.mjs';
import { withOrphanRun } from './orphan-run.mjs';
import { switcherView } from './render-overlays.mjs';
import { dashboardLayout } from './render-view.mjs';
import { keyboardScrollTarget } from './scroll.mjs';
import { clamp } from './text.mjs';
import { themeNames } from './theme.mjs';
import {
  collapseTransition, completedItems, expandTransition, foldedFromView, followTargetForRun,
  hiddenSnapshot, holdsPendingRun, loadViewState, moveSwitcher, saveViewState, setExpanded,
  structuralFor, switcherItems, syncFoldedRun,
} from './view-state.mjs';
import { applySwitcherSelection, selectionScrollTarget, setNodeSubject } from './viewer-selection.mjs';
import {
  applyFocus, buildViewModel, reconcile, selectNode, selectRun, selectTask,
  toggleFold as toggleFoldInView,
} from './view-model.mjs';
import { helpScrollMetrics, movementKey } from './viewer-keymap.mjs';
import {
  pruneHiddenSubjects, transitionChanges, viewSessionKey,
} from './viewer-snapshot.mjs';

// Fresh viewer UI state. createViewer() keeps its runtime (snapshot, render,
// watcher) in that instance's closure, so two viewers never share navigation
// state and tests can build isolated viewers instead of the process singleton.
export function createViewerState({
  noMotion = false, language = 'en', themeName, fps = 60,
  staleAfter = staleAfterMs(), ...overrides
} = {}) {
  return {
    runIndex: 0,
    selectedRunId: undefined,
    runPinned: false,
    // The run itself is the details subject (RUN SUMMARY) instead of a node.
    runOverview: false,
    // Triage state: graph filter/focus, task scope, and collapsed sections.
    graphFilter: 'all',
    graphFocus: undefined,
    taskScope: 'run',
    completedCollapsed: true,
    detailsSection: 0,
    collapsedSections: new Set(),
    palette: false,
    paletteFilter: '',
    paletteIndex: 0,
    tour: 0,
    undoClear: null,
    focus: 'graph',
    lastFocus: 'graph',
    mouseCapture: true,
    selectedNodeId: undefined,
    selectedTaskId: undefined,
    // Durable: the task subject is explicit but has no node in the loaded runs.
    // The graph keeps its run context yet paints no node highlight.
    selectedTaskUnlinked: false,
    installVersion: undefined,
    follow: true,
    followTarget: undefined,
    motion: !noMotion,
    help: false,
    helpScroll: 0,
    staleAfterMs: staleAfter,
    language,
    settingsMenu: false,
    settingsIndex: 0,
    verbose: false,
    folded: new Set(),
    foldedRunId: undefined,
    foldedByRun: new Map(),
    graphScroll: 0,
    graphScrollTarget: 0,
    manualScroll: false,
    tasksScroll: 0,
    tasksScrollTarget: 0,
    runsScroll: 0,
    runsScrollTarget: 0,
    cellsScroll: 0,
    cellsScrollTarget: 0,
    detailsScroll: 0,
    detailsScrollTarget: 0,
    detailsKey: undefined,
    taskRevealKey: undefined,
    expanded: false,
    returnFocus: 'graph',
    switcher: null,
    hiddenRunIds: new Set(),
    hiddenTaskIds: new Set(),
    themeName,
    sidebar: true,
    fps,
    toasts: [],
    ...overrides,
  };
}

// The duty body does not paint the tier-3 verbose blocks yet, so `d` is a
// wide/expanded-mode action there. The caller toasts that limitation instead of
// claiming a frame change that did not happen.
export function detailsVerboseAvailable(structural) {
  return structural === 'investigation' || structural === 'expanded';
}

// A scroll key may only move a painted region. Duty lists fall back to the duty
// body when the terminal is too short to paint them; investigation keeps its
// existing graph/tasks/details mapping.
export function scrollRegionForFocus(focus, structural, scrollInfo = {}) {
  if (structural === 'investigation') {
    if (focus === 'details') return 'details';
    if (focus === 'runs') return (scrollInfo.runs?.viewportH ?? 0) > 0 ? 'runs' : 'graph';
    if (focus === 'cells') return (scrollInfo.cells?.viewportH ?? 0) > 0 ? 'cells' : 'graph';
    if (focus === 'tasks') return (scrollInfo.tasks?.viewportH ?? 0) > 0 ? 'tasks' : 'graph';
    return 'graph';
  }
  if (focus === 'runs' || focus === 'cells' || focus === 'tasks') {
    return (scrollInfo[focus]?.viewportH ?? 0) > 0 ? focus : 'details';
  }
  return 'details';
}

// Pure key intent used by dispatchKeyboardScroll and by the regression tests.
// Focus is translated to the existing keyboardScrollTarget vocabulary, then the
// returned region is restored to runs/cells when those are the painted duty
// lists.
export function keyboardScrollIntent(key, pressed, focus, structural, scrollInfo = {}, { pageSize } = {}) {
  const region = scrollRegionForFocus(focus, structural, scrollInfo);
  if (!region) return null;
  const info = scrollInfo?.[region] ?? {};
  const mappedFocus = region === 'runs' ? 'tasks' : region === 'cells' ? 'graph' : region;
  const size = pageSize ?? Math.max(1, Math.floor((info.viewportH ?? 2) / 2));
  const options = { pageSize: size, maxScroll: Math.max(0, info.maxScroll ?? 0) };
  const target = keyboardScrollTarget(key, mappedFocus, options) ??
    keyboardScrollTarget(pressed?.name, mappedFocus, options);
  return target ? { region, delta: target.delta, maxScroll: options.maxScroll } : null;
}

// The viewer session owns the durable UI/view-model/snapshot state and every
// command that changes the subject. It receives the terminal, repaint, draw,
// close and view-state adapters from the viewer factory so this module never
// reads the terminal, raw input, or the filesystem watch.
export function createViewerSession({
  noMotion = false, language = 'en', themeName, fps = 60, staleAfter = staleAfterMs(),
  once = false, statePath, interactive = false, paneMode = false,
  loadViewStateFn = loadViewState,
  saveViewStateFn = saveViewState,
  requestRepaint = () => {},
  requestFrame = () => {},
  draw = () => {},
  close = async () => {},
  applyPalette = () => {},
  terminalWidth = () => 120,
  terminalHeight = () => 40,
} = {}) {
  let snapshot = null;
  let fullSnapshot = null;
  let previousStates = null;
  let viewState;
  let viewStateSessionId;
  let toastId = 0;
  let lastCycle;
  let helpFrameDrawn = false;
  const pendingWrites = new Set();
  // Exactly one graph layout is retained (cap = 1): changing the run, graph
  // width, folded set or node/edge structure replaces the entry, so a viewer
  // that watches many runs cannot retain their layouts. The wire raster inside
  // computeLayout/drawGraph has its own single-entry cache (task 33).
  const graphLayoutCache = new SingleEntryCache('graph-layout');
  const ui = createViewerState({ noMotion, language, themeName, fps, staleAfter });
  const vm = buildViewModel(null, ui);

  function addToast(text, kind = 'info', at = Date.now()) {
    ui.toasts.push({ id: ++toastId, text, kind, at });
    if (ui.toasts.length > 4) ui.toasts = ui.toasts.slice(-4);
    requestRepaint();
  }

  // Preference writes are fire-and-forget from the UI's perspective, but close()
  // must not exit before the last toggle reaches disk. Tracking keeps quit
  // honest without making every key wait for the filesystem.
  function trackWrite(promise) {
    const tracked = Promise.resolve(promise);
    pendingWrites.add(tracked);
    tracked.finally(() => pendingWrites.delete(tracked)).catch(() => {});
    return tracked;
  }

  async function flushPendingWrites(timeoutMs = 250) {
    if (!pendingWrites.size) return;
    await Promise.race([
      Promise.allSettled([...pendingWrites]),
      delay(timeoutMs),
    ]);
  }

  function runIndexById(id) {
    return snapshot?.runs.findIndex(run => run.id === id) ?? -1;
  }

  function ensureSelection() {
    reconcile(vm, { snapshot });
  }

  // The one visible-snapshot seam: hide first, then append the view-only orphan
  // run. `fullSnapshot` stays producer-faithful, and withOrphanRun memoizes the
  // projection per hidden snapshot so repeated reads never stack groups.
  function visibleSnapshot(full) {
    return withOrphanRun(hiddenSnapshot(full, {
      runIds: ui.hiddenRunIds, taskIds: ui.hiddenTaskIds,
    }));
  }

  function stateSignature(current) {
    const map = new Map();
    for (const run of current.runs) {
      for (const node of run.nodes) map.set(`${run.id}:${node.id}`, node.state);
    }
    for (const task of current.tasks) {
      if (!task.parentTaskId) map.set(`task:${task.id}`, task.status);
    }
    return map;
  }

  function detectTransitions(previous, current, now) {
    const toasts = transitionChanges(previous, current).map(change => {
      if (change.kind === 'node') {
        if (change.state === 'completed') return { text: t(ui.language, 'toastNodeCompleted', { label: change.label }), kind: 'completed' };
        if (change.state === 'failed') return { text: t(ui.language, 'toastNodeFailed', { label: change.label }), kind: 'failed' };
        return { text: t(ui.language, 'toastNodeStarted', { label: change.label }), kind: 'info' };
      }
      if (change.state === 'completed') return { text: t(ui.language, 'toastTaskCompleted', { label: change.label }), kind: 'completed' };
      if (change.state === 'failed') return { text: t(ui.language, 'toastTaskFailed', { label: change.label }), kind: 'failed' };
      return { text: t(ui.language, 'toastTaskStarted', { label: change.label }), kind: 'info' };
    });
    for (const toast of toasts.slice(0, 3)) addToast(toast.text, toast.kind, now);
    if (toasts.length > 3) addToast(t(ui.language, 'toastMoreChanges', { count: toasts.length - 3 }), 'info', now);
  }

  function acceptSnapshot(raw, { silent = false, view = once ? 'once' : 'watch' } = {}) {
    const normalized = normalizeSnapshot(raw);
    if (!normalized) {
      if (!silent) addToast(t(ui.language, 'toastInvalidSnapshot'), 'failed');
      return false;
    }
    normalized.provenance = {
      ...normalized.provenance,
      origin: normalized.mode !== 'demo' && normalized.provenance.origin === 'legacy-snapshot'
        ? 'controller' : normalized.provenance.origin,
      view,
      ...(statePath ? { statePath } : {}),
    };
    const now = Date.now();
    const previousRunIds = new Set(snapshot?.runs.map(run => run.id) ?? []);
    const hadRuns = Boolean(snapshot?.runs?.length);
    const nextStates = stateSignature(normalized);
    if (!silent) detectTransitions(previousStates, normalized, now);
    previousStates = nextStates;
    if (raw?.demo && lastCycle !== raw.demo.cycle) {
      if (lastCycle !== undefined) addToast(t(ui.language, 'toastCycleStarted', { cycle: raw.demo.cycle + 1 }), 'warning', now);
      lastCycle = raw.demo.cycle;
      ui.followTarget = undefined;
    }
    fullSnapshot = normalized;
    pruneHiddenSubjects(ui, normalized);
    snapshot = visibleSnapshot(normalized);
    reconcile(vm, { snapshot, previousRunIds, hadRuns });
    if (ui.follow && snapshot.connected) follow(now);
    requestRepaint();
    return true;
  }

  function follow(now = Date.now()) {
    if (!snapshot?.connected) return;
    const current = snapshot.runs[ui.runIndex];
    // A freshly selected run with no running node yet must stay visible instead
    // of being dragged back to an older running run by the exact-match target.
    if (holdsPendingRun(ui.followTarget, current)) return;
    if (ui.followTarget?.kind === 'run' && ui.followTarget.runId === current?.id) {
      const upgraded = followTargetForRun(current);
      if (upgraded?.kind === 'node') ui.followTarget = upgraded;
    }
    const target = findRunningTarget(snapshot, ui.followTarget);
    if (!target) return;
    ui.followTarget = target;
    const structural = structuralFor(terminalWidth(), {
      expanded: ui.expanded, sidebar: sidebarEnabled(),
    });
    // An explicit RUNS/CELLS focus is a user choice; follow still moves the
    // subject underneath it instead of dragging focus back to a hidden pane.
    const keepDutyList = structural === 'duty' && (ui.focus === 'runs' || ui.focus === 'cells')
      ? ui.focus : undefined;
    if (target.kind === 'node') {
      const index = runIndexById(target.runId);
      if (index >= 0) ui.runIndex = index;
      ui.selectedRunId = target.runId;
      applyFocus(vm, 'graph', structural, vm.frame?.scroll);
      if (keepDutyList) ui.focus = keepDutyList;
      ui.selectedNodeId = target.nodeId;
      ui.selectedTaskUnlinked = false;
    } else {
      applyFocus(vm, 'tasks', structural, vm.frame?.scroll);
      if (keepDutyList) ui.focus = keepDutyList;
      ui.selectedTaskId = target.taskId;
      ui.selectedTaskUnlinked = !nodeForTask(snapshot, target.taskId);
      if (ui.selectedTaskUnlinked) {
        ui.selectedNodeId = undefined;
        ui.graphScroll = 0;
        ui.graphScrollTarget = 0;
      }
    }
    ui.manualScroll = false;
  }

  function selectTaskById(taskId, { announce = false } = {}) {
    const result = selectTask(vm, taskId);
    if (!result.handled) return result;
    if (!result.linked && announce) {
      addToast(t(ui.language, 'toastTaskUnlinked', { id: taskId }), 'warning');
    }
    return result;
  }

  // Expanded mode routes a task selection into the details pane. The caller
  // decides whether a handled selection is required: breadcrumb hits keep the
  // historical focus write even when the stale task no longer resolves.
  function focusTaskDetails() {
    if (!ui.expanded) return;
    ui.focus = 'details';
    ui.lastFocus = 'tasks';
  }

  // Pointer targets are resolved against the painted frame; these commands own
  // the subject writes so the input module never mutates the view model.
  function selectRunFromPointer(runId) {
    selectRun(vm, runId, { overview: true });
  }

  function selectNodeFromContext(nodeId) {
    // The breadcrumb node is painted from the previous frame. Re-resolve the
    // run in the current snapshot and require the node to still belong to it;
    // a stale hit must not retarget a same-id node in another run.
    const paintedRun = vm.frame?.run;
    const clickedNode = paintedRun?.nodes?.find(node => node.id === nodeId);
    if (!paintedRun || !clickedNode) return;
    const index = runIndexById(paintedRun.id);
    if (index >= 0) {
      ui.runIndex = index;
      ui.selectedRunId = paintedRun.id;
      ui.runPinned = true;
    }
    ui.selectedNodeId = nodeId;
    ui.runOverview = false;
    // A virtual breadcrumb node is still only a display subject: the task it
    // mirrors remains unlinked and never becomes producer ownership.
    if (!isVirtualRun(paintedRun)) {
      ui.selectedTaskId = clickedNode.taskId;
      ui.selectedTaskUnlinked = false;
    }
    ui.follow = false;
    ui.followTarget = undefined;
    ui.manualScroll = false;
    if (ui.expanded) {
      ui.focus = 'details';
      ui.lastFocus = 'graph';
    } else {
      ui.focus = vm.frame?.layout?.layout === 'duty' ? 'cells' : 'graph';
    }
  }

  function selectNodeFromPointer(nodeId) {
    const paintedRun = vm.frame?.run;
    const index = paintedRun ? runIndexById(paintedRun.id) : -1;
    const run = index >= 0 ? snapshot.runs[index] : undefined;
    const clickedNode = run?.nodes?.find(node => node.id === nodeId);
    if (!run || !clickedNode) return;
    setNodeSubject(ui, snapshot, nodeId, { runId: run.id, manualScroll: true });
    ui.focus = vm.frame?.layout?.layout === 'duty' ? 'cells' : 'graph';
  }

  function cycleTaskSelection(direction) {
    const tasks = navTasks(snapshot ?? { runs: [], tasks: [] });
    if (!tasks.length) return;
    const current = Math.max(0, tasks.findIndex(task => task.id === ui.selectedTaskId));
    const index = (current + direction + tasks.length) % tasks.length;
    selectTaskById(tasks[index].id);
  }

  // Up/down in the duty TASKS list selects the orphan row under the cursor
  // instead of scrolling an invisible list; the painted list is the source of
  // row order, so a linked task can never become the selection here.
  function stepDutyTask(direction) {
    const tasks = orphanNavTasks(snapshot);
    if (!tasks.length) return false;
    const current = tasks.findIndex(task => task.id === ui.selectedTaskId);
    const index = current < 0
      ? (direction < 0 ? tasks.length - 1 : 0)
      : (current + direction + tasks.length) % tasks.length;
    selectTaskById(tasks[index].id);
    return true;
  }

  function stepGraphNode(direction) {
    const run = snapshot?.runs[ui.runIndex];
    if (!run?.nodes?.length) return;
    const layout = vm.frame?.graph?.layout;
    const next = layout ? nextNodeId(layout, ui.selectedNodeId, direction) : undefined;
    const fallback = run.nodes[
      (Math.max(0, run.nodes.findIndex(node => node.id === ui.selectedNodeId)) + direction + run.nodes.length)
        % run.nodes.length
    ].id;
    const nodeId = next ?? fallback;
    setNodeSubject(ui, snapshot, nodeId, { runId: run.id });
    ui.focus = vm.frame?.layout?.layout === 'duty' ? 'cells' : 'graph';
    if (ui.graphFocus) ui.graphFocus = nodeId;
    scrollSelectedIntoView();
  }

  function jumpDetailsSection(direction) {
    const info = vm.frame?.scroll?.details;
    const headings = info?.headings ?? [];
    if (!headings.length) return;
    const offset = info.offset ?? 0;
    const target = direction > 0
      ? headings.find(item => item.row > offset + 1)
      : [...headings].reverse().find(item => item.row < offset - 1);
    if (!target) return;
    ui.detailsScroll = target.row;
    ui.detailsScrollTarget = target.row;
  }

  function toggleDetailsSection() {
    const info = vm.frame?.scroll?.details;
    const headings = info?.headings ?? [];
    if (!headings.length) return;
    const offset = info.offset ?? 0;
    const heading = [...headings].reverse().find(item => item.row <= offset + 2) ?? headings[0];
    if (!heading) return;
    if (ui.collapsedSections.has(heading.label)) ui.collapsedSections.delete(heading.label);
    else ui.collapsedSections.add(heading.label);
  }

  function switchRun(direction) {
    if (!snapshot?.runs.length) return;
    const index = (ui.runIndex + direction + snapshot.runs.length) % snapshot.runs.length;
    selectRun(vm, snapshot.runs[index].id, { overview: ui.runOverview });
  }

  function openSwitcher() {
    if (ui.switcher || !snapshot) return;
    const run = snapshot.runs[ui.runIndex];
    const node = run?.nodes?.find(candidate => candidate.id === ui.selectedNodeId);
    const taskOwner = ui.focus === 'tasks' || (ui.focus === 'details' && ui.lastFocus === 'tasks');
    const preferredTaskId = taskOwner ? ui.selectedTaskId : node?.taskId;
    const preferredNodeKey = run?.id && ui.selectedNodeId ? `node:${run.id}:${ui.selectedNodeId}` : undefined;
    const items = switcherItems(snapshot, null, {
      preferRunId: run?.id,
      tasks: navTasks(snapshot),
      language: ui.language,
    });
    const active = (preferredNodeKey
      ? items.find(item => item.key === preferredNodeKey)
      : undefined)
      ?? items.find(item => item.kind === 'task' && item.id === preferredTaskId)
      ?? items.find(item => item.kind === 'run' && item.id === run?.id)
      ?? items[0];
    ui.switcher = { query: '', frozenKeys: items.map(item => item.key), activeKey: active?.key };
  }

  function moveSwitcherSelection(delta) {
    if (!ui.switcher) return;
    const view = switcherView(snapshot, ui);
    if (!view.items.length) return;
    ui.switcher = {
      ...ui.switcher,
      activeKey: moveSwitcher(view.items, view.activeKey, delta),
    };
  }

  function confirmSwitcher(key) {
    if (!ui.switcher) return;
    const view = switcherView(snapshot, ui);
    // Pointer hits carry the key painted in the previous frame. Only keyboard
    // Enter (undefined) may fall back to the active row: a key that was removed,
    // reordered, or filtered out is stale and must not select another subject.
    const item = key === undefined
      ? view.items.find(candidate => candidate.key === view.activeKey)
      : view.items.find(candidate => candidate.key === key);
    if (!item) {
      if (key !== undefined) {
        addToast(t(ui.language, 'toastSwitcherStale', {
          id: key.slice(key.indexOf(':') + 1),
        }), 'warning');
        return;
      }
      ui.switcher = null;
      addToast(t(ui.language, 'switcherEmpty'), 'warning');
      return;
    }
    const applied = applySwitcherSelection(ui, snapshot, item, vm.frame?.scroll);
    if (!applied.handled) {
      addToast(t(ui.language, applied.stale ? 'toastSwitcherStale' : 'toastTaskUnlinked', {
        id: item.id,
      }), 'warning');
      return;
    }
    if (item.kind === 'task' && !applied.linked) {
      addToast(t(ui.language, 'toastTaskUnlinked', { id: item.id }), 'warning');
    }
    ui.switcher = null;
  }

  function paletteView() {
    const items = filterCommands(commandItems(ui.language), ui.paletteFilter);
    const index = items.length ? clamp(ui.paletteIndex ?? 0, 0, items.length - 1) : 0;
    return { items, index, active: items[index] };
  }

  function openPalette() {
    ui.palette = true;
    ui.paletteFilter = '';
    ui.paletteIndex = 0;
  }

  function closePalette() {
    ui.palette = false;
    ui.paletteFilter = '';
    ui.paletteIndex = 0;
  }

  function movePalette(delta) {
    const { items, index } = paletteView();
    if (!items.length) return;
    ui.paletteIndex = (index + delta + items.length) % items.length;
  }

  function applyPaletteCommand(id) {
    const run = snapshot?.runs?.[ui.runIndex];
    switch (id) {
      case 'overview':
        if (run) selectRun(vm, run.id, { overview: true });
        break;
      case 'find':
        closePalette();
        openSwitcher();
        return;
      case 'filter-failed':
      case 'filter-blocked':
      case 'filter-running':
      case 'filter-critical':
        ui.graphFilter = id.slice('filter-'.length);
        ui.graphFocus = undefined;
        break;
      case 'filter-clear':
        ui.graphFilter = 'all';
        ui.graphFocus = undefined;
        break;
      case 'focus': {
        if (!run?.nodes?.length) break;
        const nodeId = ui.selectedNodeId ?? run.nodes[0].id;
        ui.selectedNodeId = nodeId;
        ui.runOverview = false;
        if (!isVirtualRun(run)) {
          ui.selectedTaskId = run.nodes.find(node => node.id === nodeId)?.taskId;
          ui.selectedTaskUnlinked = false;
        }
        ui.focus = vm.frame?.layout?.layout === 'duty' ? 'cells' : 'graph';
        ui.graphFocus = nodeId;
        ui.follow = false;
        break;
      }
      case 'scope':
        toggleTaskScope(run);
        break;
      case 'completed':
        ui.completedCollapsed = !ui.completedCollapsed;
        ui.tasksScroll = 0;
        ui.tasksScrollTarget = 0;
        break;
      case 'verbose':
        ui.verbose = !ui.verbose;
        break;
      case 'tour':
        ui.tour = 1;
        break;
      case 'undo':
        undoCleared();
        break;
      case 'help':
        ui.help = true;
        ui.helpScroll = 0;
        helpFrameDrawn = false;
        break;
      case 'settings':
        openSettingsMenu();
        break;
      case 'quit':
        void close({ closePane: true });
        return;
      default:
        break;
    }
    closePalette();
  }

  function foldSelectedNode() {
    toggleFoldInView(vm, {
      persist: (runId, nodeId, expanded) => {
        const sessionKey = viewSessionKey(snapshot);
        if (statePath && viewState && sessionKey && viewState.sessionId === sessionKey) {
          setExpanded(viewState, runId, nodeId, expanded);
          trackWrite(saveViewStateFn(statePath, viewState))
            .catch(error => addToast(t(ui.language, 'toastViewPreferences', { error: error.message }), 'failed'));
        }
      },
    });
  }

  function sidebarEnabled() {
    return ui.sidebar && (!paneMode || terminalWidth() >= 112);
  }

  function graphMetrics() {
    const layout = dashboardLayout(terminalWidth(), terminalHeight(), {
      sidebar: sidebarEnabled(), expanded: ui.expanded,
    });
    if (!layout.graph) return null;
    return { width: Math.max(8, layout.graph.w - 4), height: Math.max(3, layout.graph.h - 4) };
  }

  function graphLayoutInfo() {
    const run = snapshot?.runs[ui.runIndex];
    if (!run) return null;
    syncFoldedRun(ui, run.id);
    const metrics = graphMetrics();
    if (!metrics) return null;
    const key = graphLayoutKey(run, metrics.width, { folded: ui.folded });
    const layout = graphLayoutCache.get(key, () => {
      try {
        return computeLayout(run, metrics.width, { folded: ui.folded });
      } catch {
        // Let renderApp handle and report a cyclic layout.
        return null;
      }
    });
    return { ...metrics, layout };
  }

  function maxGraphScroll(info = graphLayoutInfo()) {
    if (!info?.layout) return 0;
    return Math.max(0, info.layout.height - info.height);
  }

  function pageScrollStep() {
    return Math.max(2, (graphMetrics()?.height ?? 4) - 4);
  }

  function scrollRegionBy(region, delta) {
    if (region === 'graph') {
      ui.follow = false;
      ui.manualScroll = true;
      ui.graphScrollTarget = clamp(
        ui.graphScrollTarget + delta,
        0,
        vm.frame?.scroll?.graph?.maxScroll ?? maxGraphScroll(),
      );
      return;
    }
    if (region === 'tasks') {
      ui.follow = false;
      ui.tasksScrollTarget = clamp(
        (ui.tasksScrollTarget ?? 0) + delta,
        0,
        vm.frame?.scroll?.tasks?.maxScroll ?? 0,
      );
      return;
    }
    if (region === 'runs' || region === 'cells') {
      const targetKey = region === 'runs' ? 'runsScrollTarget' : 'cellsScrollTarget';
      ui[targetKey] = clamp((ui[targetKey] ?? 0) + delta, 0, vm.frame?.scroll?.[region]?.maxScroll ?? 0);
      return;
    }
    if (region === 'details') {
      ui.follow = false;
      ui.detailsScrollTarget = clamp(
        (ui.detailsScrollTarget ?? 0) + delta,
        0,
        vm.frame?.scroll?.details?.maxScroll ?? 0,
      );
    }
  }

  function dispatchKeyboardScroll(key, pressed) {
    const structural = vm.frame?.layout?.layout ?? structuralFor(terminalWidth(), {
      expanded: ui.expanded, sidebar: sidebarEnabled(),
    });
    const scrollInfo = vm.frame?.scroll ?? {};
    // The duty TASKS list is a selection list, not a scroll window. Move the
    // orphan-task subject on up/down before the generic scroll fallback; when
    // the region is not painted, focusForStructural has already sent the key
    // to the duty body.
    const movement = movementKey(key, pressed);
    if (structural === 'duty' && ui.focus === 'tasks' && (movement === 'up' || movement === 'down') &&
      (scrollInfo.tasks?.viewportH ?? 0) > 0) {
      stepDutyTask(movement === 'down' ? 1 : -1);
      return true;
    }
    // Page size only needs the graph's larger step; every other painted region
    // uses half its viewport inside keyboardScrollIntent.
    const pageSize = scrollRegionForFocus(ui.focus, structural, scrollInfo) === 'graph'
      ? pageScrollStep()
      : undefined;
    const intent = keyboardScrollIntent(key, pressed, ui.focus, structural, scrollInfo, { pageSize });
    if (!intent) return false;
    scrollRegionBy(intent.region, intent.delta);
    return true;
  }

  function regionStep(region) {
    const info = vm.frame?.scroll?.[region];
    if (!info) return 1;
    return region === 'graph'
      ? Math.max(2, info.viewportH - 4)
      : Math.max(1, Math.floor(info.viewportH / 2));
  }

  function revealTaskSelection() {
    if (ui.focus !== 'tasks' || !snapshot) return;
    const tasks = vm.frame?.layout?.layout === 'duty'
      ? orphanNavTasks(snapshot)
      : navTasks(snapshot);
    const index = tasks.findIndex(task => task.id === ui.selectedTaskId);
    if (index < 0) return;
    const viewportRows = vm.frame?.scroll?.tasks?.viewportH ?? 0;
    const max = vm.frame?.scroll?.tasks?.maxScroll ?? 0;
    if (!viewportRows) {
      // The task list is not painted (duty or expanded). Keep its last offset so
      // returning to investigation does not rewind the selection into view.
      ui.taskRevealKey = undefined;
      return;
    }
    let offset = clamp(ui.tasksScrollTarget ?? 0, 0, max);
    if (index < offset) offset = index;
    else if (index >= offset + viewportRows) offset = index - viewportRows + 1;
    ui.tasksScrollTarget = clamp(offset, 0, max);
    ui.tasksScroll = ui.tasksScrollTarget;
  }

  // The Help overlay is modal, but its list is taller than a short terminal.
  // A wheel event scrolls one clamped page instead of falling through to the
  // frame underneath.
  function scrollHelpPage(direction) {
    const metrics = helpScrollMetrics(terminalHeight());
    ui.helpScroll = clamp(
      (ui.helpScroll ?? 0) + direction * Math.max(1, metrics.viewport - 1),
      0,
      metrics.maxScroll,
    );
    helpFrameDrawn = false;
    void draw();
  }

  function openSettingsMenu() {
    ui.help = false;
    ui.helpScroll = 0;
    helpFrameDrawn = false;
    ui.settingsMenu = true;
    ui.settingsIndex = 0;
  }

  function applyLanguage(id) {
    const language = normalizeLanguage(id);
    ui.language = language;
    trackWrite(saveConfig({ language })).then(() => {
      addToast(t(language, 'languageChanged', { language: languageLabel(language) }), 'info');
    }).catch(error => {
      addToast(t(language, 'languageSaveError', { error: error.message }), 'failed');
    });
  }

  function applySetting(index) {
    if (index === 0) {
      const current = themeNames.indexOf(ui.themeName);
      ui.themeName = themeNames[(current + 1) % themeNames.length];
      applyPalette();
      addToast(t(ui.language, 'toastTheme', { name: ui.themeName }), 'info');
      trackWrite(saveConfig({ theme: ui.themeName })).catch(error => {
        addToast(t(ui.language, 'themeSaveError', { error: error.message }), 'failed');
      });
      return;
    }
    if (index === 1) {
      // The render settings row says "(this session)" in both languages, so the
      // honest implementation is session-only. It must not write config behind a
      // copy that promises nothing survives relaunch.
      ui.motion = !ui.motion;
      if (interactive) requestFrame();
      addToast(t(ui.language, ui.motion ? 'toastMotionOn' : 'toastMotionOff'), 'info');
      return;
    }
    applyLanguage(ui.language === 'en' ? 'zh' : 'en');
  }

  function scrollSelectedIntoView(info = graphLayoutInfo()) {
    if (!info?.layout) return;
    const target = selectionScrollTarget(ui, snapshot, info.layout, info.height);
    if (target === undefined) return;
    ui.graphScrollTarget = target;
  }

  async function syncViewState(isCurrent = () => true) {
    const sessionKey = viewSessionKey(snapshot);
    if (!statePath || !sessionKey) {
      viewState = undefined;
      viewStateSessionId = undefined;
      return;
    }
    if (viewStateSessionId === sessionKey) return;
    try {
      const loaded = await loadViewStateFn(statePath, sessionKey);
      if (!isCurrent()) return;
      viewState = loaded;
      viewStateSessionId = sessionKey;
      // Saved fold keys are per (run,node). Load a set for every visible
      // producer run so switching runs never borrows another run's same-id
      // folds. A virtual run is never foldable, so a stale sidecar key for its
      // id is ignored instead of resurrecting a derived fold, and the next real
      // preference write persists the sanitized object.
      const runs = snapshot?.runs ?? [];
      const virtualRunIds = new Set(runs.filter(run => isVirtualRun(run)).map(run => run.id));
      if (virtualRunIds.size) {
        for (const encoded of Object.keys(viewState.expanded)) {
          try {
            const [runId] = JSON.parse(encoded);
            if (virtualRunIds.has(runId)) delete viewState.expanded[encoded];
          } catch { /* malformed keys stay inert for foldedFromView */ }
        }
      }
      ui.foldedByRun = new Map(runs
        .filter(run => !isVirtualRun(run))
        .map(run => [run.id, foldedFromView(viewState, run.id)]));
      const runId = runs[ui.runIndex]?.id;
      ui.foldedRunId = runId;
      ui.folded = new Set(runId === undefined ? [] : ui.foldedByRun.get(runId) ?? []);
      requestRepaint();
    } catch (error) {
      if (!isCurrent()) return;
      viewState = undefined;
      viewStateSessionId = undefined;
      addToast(t(ui.language, 'toastViewPreferences', { error: error.message }), 'failed');
    }
  }

  // The source adapter computes failure placeholders; the session remains the
  // only owner of the visible snapshot pair and the view-state binding.
  function installPlaceholder(placeholder) {
    snapshot = fullSnapshot = placeholder;
  }

  function invalidateViewState() {
    viewState = undefined;
    viewStateSessionId = undefined;
  }

  function refreshHiddenSnapshot() {
    snapshot = visibleSnapshot(fullSnapshot);
    ensureSelection();
    helpFrameDrawn = false;
    void draw();
  }

  function clearCompleted() {
    const source = fullSnapshot ?? snapshot;
    const items = completedItems(source, { now: Date.now() });
    // Never write a virtual run id into the hidden-run set; the projection is
    // rebuilt from the member tasks that remain visible.
    const runs = items.runs.filter(run => !isVirtualRun(run) && !ui.hiddenRunIds.has(run.id));
    const tasks = items.tasks.filter(task => !ui.hiddenTaskIds.has(task.id));
    if (!runs.length && !tasks.length) {
      addToast(t(ui.language, 'toastNoCompleted'), 'info');
      return;
    }
    ui.undoClear = {
      runs: runs.map(run => run.id),
      tasks: tasks.map(task => task.id),
    };
    for (const run of runs) ui.hiddenRunIds.add(run.id);
    for (const task of tasks) ui.hiddenTaskIds.add(task.id);
    addToast(`${t(ui.language, 'toastClearedCompleted', { runs: runs.length, tasks: tasks.length })} · ${t(ui.language, 'undoClear')}`, 'info');
    refreshHiddenSnapshot();
  }

  function undoCleared() {
    const last = ui.undoClear;
    if (!last) {
      addToast(t(ui.language, 'toastNoHidden'), 'info');
      return;
    }
    for (const id of last.runs) ui.hiddenRunIds.delete(id);
    for (const id of last.tasks) ui.hiddenTaskIds.delete(id);
    ui.undoClear = null;
    addToast(t(ui.language, 'undoRestored'), 'info');
    refreshHiddenSnapshot();
  }

  function restoreHidden() {
    const runs = ui.hiddenRunIds.size;
    const tasks = ui.hiddenTaskIds.size;
    if (!runs && !tasks) {
      addToast(t(ui.language, 'toastNoHidden'), 'info');
      return;
    }
    ui.hiddenRunIds.clear();
    ui.hiddenTaskIds.clear();
    addToast(t(ui.language, 'toastRestoredCompleted', { runs, tasks }), 'info');
    refreshHiddenSnapshot();
  }

  function cycle(direction) {
    const owner = ui.expanded
      ? (ui.lastFocus === 'tasks' ? 'tasks' : 'graph')
      : (ui.focus === 'tasks' ? 'tasks' : 'graph');
    if (owner === 'tasks') cycleTaskSelection(direction);
    else selectNode(vm, direction);
    // Expansion is an overlay, not a focus destination: cycling keeps details
    // in front and only moves the subject underneath it.
    if (ui.expanded) {
      ui.focus = 'details';
      ui.lastFocus = owner;
    }
  }

  // Global-action commands. The viewer dispatches the key; these own the
  // durable UI writes, transitions, and toasts, matching the session boundary.
  function toggleCompleted() {
    ui.completedCollapsed = !ui.completedCollapsed;
    ui.tasksScroll = 0;
    ui.tasksScrollTarget = 0;
  }

  function toggleHelp() {
    ui.help = !ui.help;
    ui.helpScroll = 0;
    helpFrameDrawn = false;
  }

  function invalidateHelpFrame() {
    helpFrameDrawn = false;
  }

  function escape() {
    if (ui.graphFilter !== 'all' || ui.graphFocus) {
      ui.graphFilter = 'all';
      ui.graphFocus = undefined;
      return;
    }
    const collapsed = collapseTransition(ui);
    if (collapsed) Object.assign(ui, collapsed);
  }

  function setGraphFilter(value) {
    ui.graphFilter = ['all', 'failed', 'blocked', 'running', 'critical'][value];
    ui.graphFocus = undefined;
  }

  function focusGraphNode() {
    const run = snapshot?.runs[ui.runIndex];
    if (!run?.nodes?.length) return;
    if (ui.graphFocus) {
      ui.graphFocus = undefined;
      return;
    }
    const nodeId = ui.selectedNodeId ?? run.nodes[0].id;
    ui.selectedNodeId = nodeId;
    ui.runOverview = false;
    if (!isVirtualRun(run)) {
      ui.selectedTaskId = run.nodes.find(node => node.id === nodeId)?.taskId;
      ui.selectedTaskUnlinked = false;
    }
    ui.focus = vm.frame?.layout?.layout === 'duty' ? 'cells' : 'graph';
    ui.graphFocus = nodeId;
    ui.follow = false;
    ui.followTarget = undefined;
  }

  function showRunOverview() {
    const run = snapshot?.runs?.[ui.runIndex];
    if (!run) return false;
    selectRun(vm, run.id, { overview: true });
    return true;
  }

  function toggleSidebar() {
    if (terminalWidth() >= 112) {
      ui.sidebar = !ui.sidebar;
      addToast(t(ui.language, ui.sidebar ? 'toastSidebarOn' : 'toastSidebarOff'), 'info');
    } else addToast(t(ui.language, 'toastSidebarHidden'), 'warning');
  }

  // Mouse capture is applied by the terminal runtime, but the visible flag and
  // its feedback belong to the session. Returns whether the flag changed so the
  // runtime can emit the matching terminal sequence.
  function applyMouseCapture(enabled) {
    if (ui.mouseCapture === enabled) return false;
    ui.mouseCapture = enabled;
    addToast(t(ui.language, enabled ? 'toastMouseControls' : 'toastMouseSelection'), enabled ? 'info' : 'warning');
    helpFrameDrawn = false;
    return true;
  }

  function toggleFollow() {
    ui.follow = !ui.follow;
    if (ui.follow) {
      ui.runPinned = false;
      follow();
    }
    addToast(t(ui.language, ui.follow ? 'toastFollowOn' : 'toastFollowOff'), 'info');
  }

  function resetDemoView() {
    ui.hiddenRunIds.clear();
    ui.hiddenTaskIds.clear();
    ui.toasts = [];
    addToast(t(ui.language, 'toastDemoReset'), 'warning');
  }

  function toggleVerbose() {
    const structural = vm.frame?.layout?.layout ?? structuralFor(terminalWidth(), {
      expanded: ui.expanded, sidebar: sidebarEnabled(),
    });
    if (!detailsVerboseAvailable(structural)) {
      addToast(t(ui.language, 'toastDetailsWideOnly'), 'warning');
      return;
    }
    ui.verbose = !ui.verbose;
    addToast(t(ui.language, ui.verbose ? 'toastDetailsVerbose' : 'toastDetailsCompact'), 'info');
  }

  function focusDuty(focus) {
    const structural = vm.frame?.layout?.layout ?? structuralFor(terminalWidth(), {
      expanded: ui.expanded, sidebar: sidebarEnabled(),
    });
    applyFocus(vm, focus, structural, vm.frame?.scroll);
    helpFrameDrawn = false;
  }

  function expandDetails() {
    if (!ui.expanded) Object.assign(ui, expandTransition(ui));
  }

  // The virtual group's scope is derived by taskListLayout from its full
  // membership. Writing that derived value into ui.taskScope would let it leak
  // onto the next real run, so the shared run/all toggle leaves it untouched.
  function toggleTaskScope(run) {
    if (!isVirtualRun(run)) ui.taskScope = ui.taskScope === 'run' ? 'all' : 'run';
    ui.tasksScroll = 0;
    ui.tasksScrollTarget = 0;
  }

  function toggleTaskScopeFromKeyboard() {
    const structural = structuralFor(terminalWidth(), {
      expanded: ui.expanded, sidebar: sidebarEnabled(),
    });
    if (structural !== 'investigation' || !sidebarEnabled() || ui.expanded) {
      openSwitcher();
      return;
    }
    toggleTaskScope(snapshot.runs?.[ui.runIndex]);
  }

  // A failed read installs a placeholder snapshot without a draw; the pointer
  // resolver and its commands must read that snapshot, not the last frame's.
  function syncPointerViewModel() {
    vm.snapshot = snapshot;
  }

  return {
    ui,
    vm,
    get snapshot() { return snapshot; },
    get fullSnapshot() { return fullSnapshot; },
    get helpFrameDrawn() { return helpFrameDrawn; },
    set helpFrameDrawn(value) { helpFrameDrawn = value; },
    get graphLayoutCacheStats() { return graphLayoutCache.stats(); },
    addToast,
    trackWrite,
    flushPendingWrites,
    runIndexById,
    ensureSelection,
    acceptSnapshot,
    follow,
    selectTaskById,
    focusTaskDetails,
    selectRunFromPointer,
    selectNodeFromContext,
    selectNodeFromPointer,
    cycleTaskSelection,
    stepDutyTask,
    stepGraphNode,
    jumpDetailsSection,
    toggleDetailsSection,
    switchRun,
    openSwitcher,
    moveSwitcherSelection,
    confirmSwitcher,
    paletteView,
    openPalette,
    closePalette,
    movePalette,
    applyPaletteCommand,
    foldSelectedNode,
    sidebarEnabled,
    graphMetrics,
    graphLayoutInfo,
    maxGraphScroll,
    pageScrollStep,
    scrollRegionBy,
    dispatchKeyboardScroll,
    regionStep,
    revealTaskSelection,
    scrollHelpPage,
    openSettingsMenu,
    applyLanguage,
    applySetting,
    scrollSelectedIntoView,
    syncViewState,
    installPlaceholder,
    invalidateViewState,
    refreshHiddenSnapshot,
    clearCompleted,
    undoCleared,
    restoreHidden,
    cycle,
    toggleCompleted,
    toggleHelp,
    invalidateHelpFrame,
    escape,
    setGraphFilter,
    focusGraphNode,
    showRunOverview,
    toggleSidebar,
    applyMouseCapture,
    toggleFollow,
    resetDemoView,
    toggleVerbose,
    focusDuty,
    expandDetails,
    toggleTaskScope: toggleTaskScopeFromKeyboard,
    syncPointerViewModel,
  };
}
