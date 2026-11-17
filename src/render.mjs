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
  drawIndeterminateBar, progressBlock, renderEmptyState, sourceHealthSection, sourceSection,
} from './render-panels.mjs';
import { runSummarySection, runWarningCount } from './render-summary.mjs';
import { nodeSubject, renderSubjectBody, taskSubject } from './render-subject.mjs';
import {
  FOOTER_H, HEADER_H, bindGraphLayout, dashboardLayout, detailsSubjectKey, displayRunName,
  entityState, fixedSectionRows, isActiveSnapshot, meaningfulReply, navTasks, percentInfo,
  progressCounts, resolveSelection, runColor, runListLayout, scrollOffset, selectionResolution,
  snapshotFreshness, summaryTime, taskListLayout,
} from './render-view.mjs';
import { runSummary } from './run-summary.mjs';
import { criticalNodeIds, filterCounts, focusSubgraph, nodeMatchesFilter } from './cockpit.mjs';
import { computeLayout, drawGraph, graphLayoutMatches, nodeScrollTarget, spinnerFrame } from './graph.mjs';
import { statusLabel, t } from './i18n.mjs';
import {
  activitySummary, elapsedLabel, incoming, isActiveRun, nodeActivity, nodeForTask, nodeMap, outgoing,
  runStats, TERMINAL, isVirtualRun,
} from './model.mjs';
import { scrollbarGeometry } from './scroll.mjs';
import { contrastRatio, statusColor, statusIcon } from './theme.mjs';
import { clamp, fit, percentBar, width as textWidth, wrap } from './text.mjs';

// renderApp's canonical input is the view model built by view-model.mjs. The
// direct (snapshot, ui, options) form stays available for embedders and frame
// fixtures: it wraps the same pair in a bare model, never a second paint path.
const isViewModel = value => Boolean(value && typeof value === 'object' &&
  value.ui && Object.hasOwn(value, 'snapshot') && Object.hasOwn(value, 'frame'));

const THINKING_BODY_LINES = 5;
// The persisted reply is already bounded (1200 characters). This is only a
// defensive display bound so a pathological context cannot paint forever.
const REPLY_MAX_LINES = 256;

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
      [displayRunName(run, language), { fg: selected ? palette.white : palette.text, bold: selected }],
      ...(isVirtualRun(run) ? [[` · ${t(language, 'virtualRunBadge')}`, { fg: palette.accent2, bold: true }]] : []),
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
    [` · ${taskGeometry.scope === 'unattached' ? t(language, 'taskScopeUnattached') : taskGeometry.scope === 'all' ? t(language, 'taskScopeAll') : t(language, 'taskScopeRun')}`, { fg: palette.faint }],
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
  const warningCount = runWarningCount(run);
  // Degradation is evidence, not noise: a dropped record, a capped layout, or
  // a stub wire must be counted in the panel badge instead of disappearing.
  const graphBadge = (text, layout) => {
    const parts = [];
    if (warningCount) parts.push(t(language, 'warningsBadge', { count: warningCount }));
    if (layout?.capped && !isVirtualRun(run)) parts.push(t(language, 'graphCapped', { count: layout.hiddenNodes }));
    if (layout?.fallbackEdges) parts.push(t(language, 'graphFallbackWires', { count: layout.fallbackEdges }));
    if (isVirtualRun(run)) {
      parts.push(t(language, 'virtualGraphNodes', {
        nodes: run.nodes.length,
        members: run.virtual?.memberTaskIds?.length ?? run.virtual?.count ?? run.nodes.length,
      }));
      if (run.virtual?.omittedNodes) parts.push(t(language, 'virtualGraphOmitted', { count: run.virtual.omittedNodes }));
      if (layout?.hiddenNodes) parts.push(t(language, 'virtualGraphHidden', { count: layout.hiddenNodes }));
    }
    if (isVirtualRun(run) && layout?.hiddenNodes) parts.push(t(language, 'virtualGraphHiddenShort', { count: layout.hiddenNodes }));
    parts.push(text);
    return parts.join(' · ');
  };
  const graphRun = focusSubgraph(run, ui.graphFocus);
  const filter = ui.graphFilter ?? 'all';
  const graphSummary = filter === 'all' ? undefined : runSummary(run, { now: viewNow });
  const criticalIds = filter === 'all' ? undefined : criticalNodeIds(graphSummary);
  const selectedTask = navTasks(snapshot).find(candidate => candidate.id === ui.selectedTaskId);
  const unlinked = Boolean(ui.selectedTaskUnlinked && selectedTask);
  if (unlinked) {
    panel(canvas, rect, t(language, 'taskOverview'), {
      palette,
      focused: ui.focus === 'graph',
      badge: t(language, 'noNodeShort'),
    });
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
    panel(canvas, rect, t(language, 'graph'), {
      palette,
      focused: ui.focus === 'graph',
      badge: t(language, 'noRun'),
    });
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
  const statsBadge = () => (stats.percentKnown
    ? t(language, 'graphBadge', { nodes: stats.total, running: stats.counts.running ?? 0, percent: stats.percent })
    : t(language, 'graphBadgeCounts', {
      nodes: stats.total, running: stats.counts.running ?? 0, done: stats.done, total: stats.total,
    }));
  let layout;
  try {
    layout = !ui.graphFocus && graphLayout && graphLayoutMatches(graphLayout, run, contentW, ui.folded)
      ? bindGraphLayout(graphLayout, run)
      : computeLayout(graphRun, contentW, { folded: ui.folded });
  } catch (error) {
    panel(canvas, rect, t(language, 'graph'), {
      palette,
      focused: ui.focus === 'graph',
      badge: graphBadge(statsBadge()),
    });
    rich(canvas, innerX + 1, innerY + 1, innerW - 2, [
      [t(language, 'graphError', { error: error.message }), { fg: palette.failed, bold: true }],
    ], palette, palette.panel);
    return { layout: null, scroll: 0, maxScroll: 0, viewportH, nodeRects: new Map(), contentH: 0, bar: null };
  }
  panel(canvas, rect, t(language, 'graph'), {
    palette,
    focused: ui.focus === 'graph',
    badge: graphBadge(statsBadge(), layout),
  });
  if (isVirtualRun(run) && (run.virtual?.omittedNodes || layout.hiddenNodes)) {
    rich(canvas, innerX + 1, innerY + 1, innerW - 2, [[
      [t(language, 'virtualGraphCapSummary', {
        omitted: run.virtual?.omittedNodes ?? 0,
        hidden: layout.hiddenNodes ?? 0,
      }), { fg: palette.warn, bold: true }],
    ]], palette, palette.panel);
  }
  const maxScroll = Math.max(0, layout.height - viewportH);
  const scroll = scrollOffset(ui.graphScroll, maxScroll);
  const offset = layout.height <= viewportH ? Math.floor((viewportH - layout.height) / 2) : -scroll;
  // Paint only the rows the blit can show. A tall wrapped graph used to
  // rasterize its whole height (100 nodes = 1103 rows) on every frame even
  // though the pane shows ~35 of them.
  const clipTop = layout.height <= viewportH ? 0 : scroll;
  const clipBottom = layout.height <= viewportH ? layout.height : scroll + viewportH;
  // Clear, paint, and blit all use one window: the rows this frame shows.
  const viewportClip = { top: clipTop, bottom: clipBottom };
  const graphCanvas = graphCanvasFor(buffers, layout.width, layout.height, palette, viewportClip);
  drawGraph(graphCanvas, layout, {
    time, motion, palette, selectedId: ui.selectedNodeId, folded: ui.folded,
    now: viewNow, connected: isActiveSnapshot(snapshot), language,
    clip: viewportClip,
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
  let dependencyLine = isVirtualRun(run)
    ? [
      t(language, 'virtualGraphNodes', {
        nodes: run.nodes.length,
        members: run.virtual?.memberTaskIds?.length ?? run.virtual?.count ?? run.nodes.length,
      }),
      run.virtual?.omittedNodes ? t(language, 'virtualGraphOmitted', { count: run.virtual.omittedNodes }) : null,
      layout?.hiddenNodes ? t(language, 'virtualGraphHiddenShort', { count: layout.hiddenNodes }) : null,
    ].filter(Boolean).join(' · ')
    : t(language, 'edgesNodes', { edges: run.edges.length, nodes: stats.total });
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

// Shared painters come from render-panels; the subject body owns the one section
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
  for (const line of wrap(displayRunName(run, language), w)) {
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
        ? t(language, 'runTitle', { name: displayRunName(run, language) })
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

export {
  DEFAULT_STALE_AFTER_MS, FOOTER_H, HEADER_H, capturedAgoLabel, capturedDisplay, compactAge,
  dashboardLayout, detailsSubjectKey, diagnosisForSelection, displayRunName, entityState, isActiveSnapshot,
  isFailureState, meaningfulReply, modeColor, modeName, navTasks, orphanNavTasks, percentInfo,
  progressCounts, recordForSelection, resolveSelection, runListLayout, scrollOffset, selectionResolution,
  snapshotFreshness, subjectResolutionStats, summaryTime, taskAtPoint, taskListLayout,
  SUBJECT_RESOLUTION_LIMIT,
} from './render-view.mjs';
export { progressBlock, renderEmptyState, sourceHealthSection } from './render-panels.mjs';
export { recordForKey } from './records.mjs';
export { contrastRatio, nodeScrollTarget };
export { switcherView } from './render-overlays.mjs';
export { pillForeground } from './frame-primitives.mjs';
