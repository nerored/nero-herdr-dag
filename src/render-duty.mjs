// Duty paints the primary surface below 112 columns: the RUNS and CELLS
// lists, the compact subject body, and the run overview. The shared selection,
// progress, source-health and empty-state helpers stay in render.mjs and
// arrive through the same module cycle the other extracted painters use
// (render-diagnosis, render-overlays); the frame buffers and the subject
// adapter are the ones the wide details pane already uses.
import {
  detailLine, detailSection, drawScrollbar, panel, pill, rich, scratchCanvas,
} from './frame-primitives.mjs';
import { diagnosisCompactSection } from './render-diagnosis.mjs';
import {
  metricsSection, retryInfo, runSummarySection, runWarningCount, warningsSection,
} from './render-summary.mjs';
import { agentLabel, modelLabel } from './render-subject.mjs';
import { statusLabel, t } from './i18n.mjs';
import {
  activitySummary, elapsedLabel, incoming, isUnsuccessfulState, nodeActivity, nodeMap, outgoing, runStats,
} from './model.mjs';
import {
  displayRunName, isActiveSnapshot, orphanNavTasks, percentInfo, progressBlock, progressCounts,
  renderEmptyState, resolveSelection, scrollOffset, selectionResolution, sourceHealthSection,
  summaryTime,
} from './render.mjs';
import { scrollbarGeometry } from './scroll.mjs';
import { statusColor, statusIcon } from './theme.mjs';
import { clamp, fit, width as textWidth, wrap } from './text.mjs';

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
  const planText = showTask ? [task.planRole, task.planPath].filter(Boolean).join(' · ') : undefined;
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
    errorText = isUnsuccessfulState(status) ? t(language, 'errorNotRecorded') : t(language, 'errorNoneRecorded');
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
    if (planText && y < bottom) {
      rich(canvas, x, y, w, [
        [`${t(language, 'taskPlan')} `, { fg: palette.faint }],
        [fit(planText, Math.max(8, w - textWidth(t(language, 'taskPlan')) - 1)), { fg: palette.text }],
      ], palette, palette.panel);
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
  // Plan identity belongs above progress and source health: on a short duty
  // pane the rows below the health block are already clipped, and a plan task
  // is unusable without its plan path.
  if (planText) {
    y = detailLine(canvas, x, y, w, [
      [`${t(language, 'taskPlan')} `, { fg: palette.faint }],
      [planText, { fg: palette.text }],
    ], palette);
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
  if (node && run && runWarningCount(run)) {
    y = warningsSection(canvas, x, y, w, run, palette, language, bottom);
    y++;
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
    y = runSummarySection(canvas, x, y, w, run, stats, {
      ...summaryTime(run, snapshot, { now, viewNow, freshness, language }),
      palette, language, filter: ui.graphFilter,
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

function renderNarrowTaskList(canvas, rect, snapshot, ui, { palette, language, focused = false }) {
  const tasks = orphanNavTasks(snapshot);
  narrowListFrame(canvas, rect, t(language, 'tasks'), palette, focused);
  const viewport = Math.max(1, rect.h - 2);
  const maxScroll = Math.max(0, tasks.length - viewport);
  const offset = scrollOffset(ui.tasksScroll, maxScroll);
  const region = { x: rect.x + 1, y: rect.y + 1, w: Math.max(1, rect.w - 2), h: viewport };
  let row = rect.y + 1;
  for (const task of tasks.slice(offset, offset + viewport)) {
    if (row >= rect.y + rect.h - 1) break;
    const selected = task.id === ui.selectedTaskId;
    if (selected) canvas.fill(rect.x + 1, row, rect.w - 2, 1, { bg: palette.selection, fg: palette.text });
    const status = task.status ?? 'pending';
    const progress = percentInfo(task, language);
    const suffix = progress.known ? progress.label : statusLabel(language, status);
    rich(canvas, rect.x + 2, row, Math.max(1, rect.w - 4), [
      [`${selected ? '▸' : ' '} `, { fg: selected ? palette.accent : palette.faint, bold: selected }],
      [`${statusIcon(status)} `, { fg: statusColor(palette, status), bold: true }],
      [fit(task.description, Math.max(8, rect.w - 22)), { fg: selected ? palette.white : palette.text, bold: selected }],
      [` ${fit(suffix, 11)}`, { fg: palette.faint }],
    ], palette, selected ? palette.selection : palette.panel);
    row++;
  }
  if (!tasks.length) {
    rich(canvas, rect.x + 2, rect.y + 1, rect.w - 4, [[t(language, 'noWorkflow'), { fg: palette.faint }]], palette, palette.panel);
  }
  const barGeometry = scrollbarGeometry({ y: rect.y + 1, trackHeight: viewport, viewport, content: tasks.length, offset });
  const bar = barGeometry ? { x: rect.x + rect.w - 2, w: 1, ...barGeometry } : null;
  if (bar) drawScrollbar(canvas, bar, palette);
  return { viewportH: viewport, contentH: tasks.length, offset, maxScroll, bar, region };
}

export function renderNarrowDuty(canvas, rect, snapshot, ui, opts, hitboxes) {
  const h = Math.max(6, rect.h);
  // Orphan tasks are invisible in the wide sidebar-free duty layout. Paint
  // them beside RUNS/CELLS whenever they exist; a task-only capture has no run
  // row to anchor the eyebrow, so an empty TASKS frame is still painted.
  const hasOrphans = orphanNavTasks(snapshot).length > 0;
  const paintTasks = hasOrphans || (snapshot?.runs?.length ?? 0) === 0;
  let runsH = h >= 16 ? clamp(Math.floor(h * 0.19), 3, 7) : 3;
  let cellsH = h >= 16 ? clamp(Math.floor(h * 0.19), 3, 7) : 3;
  let tasksH = paintTasks ? (h >= 16 ? clamp(Math.floor(h * 0.16), 3, 6) : 3) : 0;
  if (!paintTasks && runsH + cellsH + 3 > h) {
    runsH = 2;
    cellsH = 2;
  }
  // Keep the duty body readable on short terminals: shrink the TASKS list
  // first, then RUNS/CELLS, but never below the existing two-row floor.
  while (paintTasks && runsH + cellsH + tasksH + 4 > h && tasksH > 2) tasksH--;
  while (paintTasks && runsH + cellsH + tasksH + 4 > h && runsH > 2) runsH--;
  while (paintTasks && runsH + cellsH + tasksH + 4 > h && cellsH > 2) cellsH--;
  const tasksPainted = tasksH > 0;
  const detailsH = Math.max(2, h - runsH - cellsH - tasksH);
  const runsRect = { ...rect, h: runsH };
  const cellsRect = { ...rect, y: rect.y + runsH, h: cellsH };
  const tasksRect = tasksPainted
    ? { ...rect, y: rect.y + runsH + cellsH, h: tasksH }
    : null;
  const detailsRect = { ...rect, y: rect.y + runsH + cellsH + tasksH, h: detailsH };
  const runs = renderNarrowRunList(canvas, runsRect, snapshot, ui, {
    ...opts, focused: ui.focus === 'runs',
  }, hitboxes);
  const cells = renderNarrowCellList(canvas, cellsRect, snapshot, ui, {
    ...opts, focused: ui.focus === 'cells',
  }, hitboxes);
  const tasks = tasksRect
    ? renderNarrowTaskList(canvas, tasksRect, snapshot, ui, {
      ...opts, focused: ui.focus === 'tasks',
    })
    : null;
  const details = renderDuty(canvas, detailsRect, snapshot, ui, opts);
  return { runs, cells, tasks, details, detailsRect };
}

export function renderDuty(canvas, rect, snapshot, ui, { now, time, motion = true, palette, language, freshness, buffers }) {
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
  const body = scratchCanvas(buffers, 'body', rect.w, measureH, palette);
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
  const inner = scratchCanvas(buffers, 'inner', rect.w, rect.h, palette);
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
