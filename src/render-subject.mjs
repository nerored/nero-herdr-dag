import {
  detailLine, detailSection, fixedBodyLines, labelWidthFor, metricRow, pill, rich,
} from './frame-primitives.mjs';
import { diagnosisErrorSection, diagnosisSection, fullReasonSection } from './render-diagnosis.mjs';
import { metricsSection, runWarningCount, warningsSection } from './render-summary.mjs';
import { statusLabel, t } from './i18n.mjs';
import { statusColor, statusIcon } from './theme.mjs';
import { isUnsuccessfulState } from './model.mjs';
import { compactDuration, truncateMiddle, wrap } from './text.mjs';

const ACTIVITY_DETAIL_LINES = 4;
const ACTIVITY_BODY_LINES = ACTIVITY_DETAIL_LINES + 1;

export function shortPath(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const home = process.env.HOME;
  if (home && value === home) return '~';
  if (home && value.startsWith(`${home}/`)) return `~/${value.slice(home.length + 1)}`;
  return value;
}

export function agentLabel(entity, language) {
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

export function modelLabel(entity, language) {
  return entity?.model ?? t(language, 'modelNotRecorded');
}

// A spawned task record carries host summary and spawn metadata that the
// generic status/metrics block does not show. Plan artifacts are referenced by
// path inside the prompt; show the extracted path and role, never the prompt.
function taskContractRows(task, language, compact) {
  const rows = [];
  if (task.summary && task.summary !== task.description) {
    rows.push({ key: 'summary', label: t(language, 'taskSummary'), value: task.summary });
  }
  const owner = task.ownerKind === 'dag'
    ? [t(language, 'ownerDag'), task.ownerRunId, task.ownerNodeId].filter(Boolean).join(' · ')
    : task.ownerKind === 'task'
      ? [t(language, 'ownerTask'), task.ownerTaskId].filter(Boolean).join(' · ')
      : task.ownerKind;
  if (owner) rows.push({ key: 'owner', label: t(language, 'taskOwner'), value: owner });
  const execution = [
    task.executionMode,
    task.backgroundMode,
    Number.isFinite(task.depth) ? `${t(language, 'depth')} ${task.depth}` : undefined,
  ].filter(Boolean).join(' · ');
  if (execution) rows.push({ key: 'execution', label: t(language, 'taskExecution'), value: execution });
  if (task.planRole) rows.push({ key: 'planRole', label: t(language, 'taskPlan'), value: task.planRole });
  if (task.planPath) rows.push({ key: 'planPath', label: t(language, 'taskPath'), value: task.planPath });
  if (task.workdir) rows.push({ key: 'workdir', label: t(language, 'taskWorkdir'), value: shortPath(task.workdir) });
  if (task.modelRequested && task.modelResolved && task.modelRequested !== task.modelResolved) {
    rows.push({ key: 'models', label: t(language, 'taskModels'), value: `${task.modelRequested} → ${task.modelResolved}` });
  }
  const stats = [
    Number.isFinite(task.runtimeMs) ? `${t(language, 'taskRuntime')} ${compactDuration(task.runtimeMs, language)}` : undefined,
    Number.isFinite(task.tokensPerSecond) ? `${Math.round(task.tokensPerSecond)} tok/s` : undefined,
    Number.isFinite(task.costUsd) ? `$${task.costUsd.toFixed(4)}` : undefined,
    Number.isFinite(task.cacheHitRate) ? `${(task.cacheHitRate * 100).toFixed(1)}% ${t(language, 'taskCacheHit')}` : undefined,
  ].filter(Boolean);
  if (stats.length) rows.push({ key: 'stats', label: t(language, 'taskStats'), value: stats.join(' · ') });
  return compact ? rows.filter(row => ['summary', 'planPath', 'owner'].includes(row.key)).slice(0, 3) : rows;
}

// The two subjects below normalize a DAG node and a spawned task into one body
// contract. Only the intentional differences live here: the node attempt line,
// the run clock versus the capture clock, node-only evidence sections, the
// originating run for warnings, and the different children/logs sources.
export function nodeSubject(node, run, {
  language, elapsed, progress, diagnosis, record, activity, links,
}) {
  return {
    entity: node,
    state: node.state,
    elapsed,
    attempt: node.attempt ?? 1,
    description: node.task?.description ?? node.label,
    id: node.taskId ?? '',
    contract: false,
    progress,
    diagnosis,
    record,
    warningRun: run,
    whyText: node.error ?? node.logs?.at(-1)
      ?? (node.state === 'running' ? t(language, 'waitingFirst') : t(language, 'errorNoneRecorded')),
    links,
    children: node.children ?? node.task?.children ?? [],
    logs: node.logs ?? node.task?.logs ?? [],
    recentEvents: node.recentEvents ?? [],
    artifact: node.artifact,
    outputBytes: node.outputTruncated && node.outputBytes !== undefined ? node.outputBytes : undefined,
    activity,
  };
}

export function taskSubject(task, {
  elapsed, progress, diagnosis, record, activity, warningRun,
}) {
  return {
    entity: task,
    state: task.status,
    elapsed,
    attempt: undefined,
    description: task.description,
    id: task.id,
    contract: true,
    progress,
    diagnosis,
    record,
    warningRun,
    whyText: null,
    links: null,
    children: task.children ?? [],
    logs: task.logs ?? [],
    recentEvents: [],
    artifact: undefined,
    outputBytes: undefined,
    activity,
  };
}

// One section order for nodes and tasks. A subject only supplies the data that
// differs; the body owns the order, the compact breakpoints and the width
// arithmetic so both details panes cannot drift apart. The shared section
// painters come from render-panels (or render.mjs for reply/thinking) and
// arrive through `sections`, the same way runSummarySection receives its clock
// and age callbacks.
export function renderSubjectBody(canvas, rect, subject, {
  now, time, motion = true, palette, language, viewportH, freshness, snapshot, verbose = false, sections,
}) {
  const {
    progressBlock: paintProgress, sourceHealthSection: paintSourceHealth, sourceSection: paintSource,
    replyOutput: paintReply, thinkingOutput: paintThinking,
  } = sections;
  const x = rect.x + 2;
  const w = rect.w - 4;
  const bottom = rect.y + rect.h - 1;
  let y = rect.y + 2;
  const color = statusColor(palette, subject.state);
  const end = pill(canvas, x, y, statusLabel(language, subject.state).toUpperCase(), color, statusIcon(subject.state));
  const header = [[subject.elapsed, { fg: palette.text, bold: true }]];
  if (subject.attempt !== undefined) {
    header.push([`  ${t(language, 'attempt', { count: subject.attempt })}`, { fg: palette.faint }]);
  }
  rich(canvas, end + 2, y, Math.max(0, rect.x + rect.w - 2 - end - 2), header, palette, palette.panel);
  y++;
  for (const line of wrap(subject.description, w)) {
    y = detailLine(canvas, x, y, w, [[line, { fg: palette.text, bold: true }]], palette);
    if (y >= bottom) return;
  }
  const entity = subject.entity;
  y = detailLine(canvas, x, y, w, [
    [agentLabel(entity, language), { fg: entity.agent ? palette.accent : palette.faint, bold: Boolean(entity.agent) }],
    [' · ', { fg: palette.faint }],
    [modelLabel(entity, language), { fg: entity.model ? palette.dim : palette.faint, dim: !entity.model }],
    [`  ${truncateMiddle(subject.id, 28)}`, { fg: palette.faint }],
  ], palette);
  y++;
  const compact = w < 60 || (Number.isFinite(viewportH) && viewportH < 26);
  const contractRows = subject.contract ? taskContractRows(entity, language, compact) : [];
  if (contractRows.length && y < bottom - 2) {
    y = detailSection(canvas, x, y, w, t(language, 'taskContract'), palette);
    const contractWidth = labelWidthFor(contractRows.map(row => row.label));
    for (const row of contractRows) {
      y = metricRow(canvas, x, y, w, row.label, [[row.value, { fg: palette.text }]], palette, contractWidth);
      if (y >= bottom) return;
    }
    y++;
  }
  if (subject.diagnosis) {
    y = diagnosisSection(canvas, x, y, w, subject.diagnosis, {
      palette, language, compact, record: subject.record,
    });
    if (!compact) y++;
  } else {
    y = paintProgress(canvas, x, y, w, subject.progress, {
      time, motion, palette, color, bg: palette.panel, bold: subject.state === 'running',
    });
    y += 1;
  }
  if (subject.warningRun && runWarningCount(subject.warningRun)) {
    y = warningsSection(canvas, x, y, w, subject.warningRun, palette, language, bottom);
    y++;
  }
  if (!subject.diagnosis && subject.whyText !== null
    && (!Number.isFinite(viewportH) || viewportH >= 34)) {
    for (const line of wrap(`${t(language, 'detailsWhy')} ${subject.whyText}`, w)) {
      if (y >= bottom) break;
      y = detailLine(canvas, x, y, w, [[line, {
        fg: subject.state === 'failed' ? palette.failed : subject.state === 'running' ? palette.warn : palette.dim,
      }]], palette);
    }
  }
  y = metricsSection(canvas, x, y, w, entity, palette, language);
  if (snapshot?.sources?.length) {
    y = paintSourceHealth(canvas, x, y, w, snapshot, { palette, language, now, bottom });
  }
  if (subject.links && y < bottom - 2) {
    const { from = [], to = [] } = subject.links;
    y = detailSection(canvas, x, y, w, t(language, 'graphLinks'), palette);
    y = detailLine(canvas, x, y, w, [
      [t(language, 'inLabel'), { fg: palette.faint }],
      [from.length ? from.join(' · ') : t(language, 'start'), { fg: from.length ? palette.dim : palette.faint, dim: !from.length }],
    ], palette);
    y = detailLine(canvas, x, y, w, [
      [t(language, 'outLabel'), { fg: palette.faint }],
      [to.length ? to.join(' · ') : t(language, 'end'), { fg: to.length ? palette.dim : palette.faint, dim: !to.length }],
    ], palette);
  }
  if (verbose) {
    if (y < bottom - 1) {
      y = paintReply(canvas, x, y, w, bottom, entity, palette, language, { record: subject.record, verbose: true });
    }
    if (entity.provenance) {
      y = paintSource(canvas, x, y, w, entity, snapshot, { palette, language, verbose: true, now, freshness });
    }
  }
  y = paintThinking(canvas, x, y, w, bottom, entity, palette, language);
  if (y + 1 + ACTIVITY_BODY_LINES <= bottom) {
    y = detailSection(canvas, x, y, w, t(language, 'activity'), palette);
    y = detailLine(canvas, x, y, w, subject.activity ? [
      [`${subject.activity.mark} `, { fg: subject.activity.stalled ? palette.warn : color, bold: true }],
      [subject.activity.label, { fg: subject.activity.stalled ? palette.warn : palette.text }],
    ] : [[subject.state === 'running' ? t(language, 'waitingFirst') : t(language, 'noLiveActivity'), { fg: palette.faint, dim: true }]], palette);
    y = fixedBodyLines(canvas, x + 2, y, w - 2, ACTIVITY_DETAIL_LINES,
      subject.activity?.text ? wrap(subject.activity.text, w - 2) : [], palette, { fg: palette.dim });
  }
  if (subject.children.length && y < bottom - 2) {
    y = detailSection(canvas, x, y, w, t(language, 'subtasks', { count: subject.children.length }), palette);
    for (const child of subject.children.slice(0, Math.max(0, bottom - y))) {
      const childColor = statusColor(palette, child.status);
      y = detailLine(canvas, x, y, w, [
        [`${statusIcon(child.status)} `, { fg: childColor, bold: true }],
        [child.description, { fg: palette.text }],
        [`  ${statusLabel(language, child.status)}`, { fg: childColor, dim: true }],
      ], palette);
      if (y >= bottom) return;
    }
  }
  if (y < bottom - 1 && (entity.error || isUnsuccessfulState(subject.state) || subject.diagnosis)) {
    y = diagnosisErrorSection(canvas, x, y, w, entity, subject.diagnosis, palette, language);
  }
  if (verbose && subject.diagnosis) {
    y = fullReasonSection(canvas, x, y, w, subject.diagnosis, palette, language);
  }
  const recentEvents = subject.recentEvents.slice(-(verbose ? 8 : 3));
  const artifact = subject.artifact;
  if ((recentEvents.length || (verbose && artifact)) && y < bottom - 1) {
    y = detailSection(canvas, x, y, w, t(language, 'recentEvents'), palette);
    for (const line of recentEvents) {
      y = detailLine(canvas, x, y, w, [[line, { fg: palette.dim }]], palette);
      if (y >= bottom) return;
    }
    if (subject.outputBytes !== undefined) {
      y = detailLine(canvas, x, y, w, [[t(language, 'outputTruncated', { bytes: subject.outputBytes }), {
        fg: palette.faint, dim: true, italic: true,
      }]], palette);
      if (y >= bottom) return;
    }
    if (verbose && artifact) {
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
  const logs = subject.logs.slice(-(verbose ? 8 : 3));
  if (verbose && logs.length && y < bottom - 1) {
    y = detailSection(canvas, x, y, w, t(language, 'recentLog'), palette);
    for (const line of logs) {
      y = detailLine(canvas, x, y, w, [[line, { fg: palette.faint, dim: true }]], palette);
      if (y >= bottom) return;
    }
  }
}
