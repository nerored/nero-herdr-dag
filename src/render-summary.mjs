import {
  detailLine, detailSection, formatCost, formatNumber, formatRate, labelWidthFor,
  metricLabelWidth, metricRow, metricValue, metricValueWidth, metricValueX, rich,
} from './frame-primitives.mjs';
import { filterCounts } from './cockpit.mjs';
import { runSummary } from './run-summary.mjs';
import { statusIcon } from './theme.mjs';
import { t } from './i18n.mjs';
import {
  compactDuration, fit, sparkline, width as textWidth, wrap,
} from './text.mjs';

// Shared retry styling for the metric card and the run summary. Retries are
// evidence, not a default: a positive count is worth attention, an explicit
// zero is faint, and both stay bold-only when recordable.
export function retryStyle(palette, value) {
  return {
    fg: Number(value) > 0 ? palette.warn : palette.faint,
    bold: Number(value) > 0,
  };
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

export function retryInfo(entity, language) {
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

export function metricsSection(canvas, x, y, w, entity, palette, language) {
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
  const retryFull = retry.known ? `${retryValue} (${retry.suffix})` : retryValue;
  const valueW = metricValueWidth(w, labelWidth);
  const retryLines = textWidth(retryFull) <= valueW
    ? [retryFull]
    : retry.known
      ? [retryValue, ...wrap(retry.suffix, valueW)]
      : wrap(retryValue, valueW);
  y = metricRow(canvas, x, y, w, t(language, 'retries'), [
    [retryLines[0], retry.known ? retryStyle(palette, retry.value) : { fg: palette.faint }],
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

// Pure run-summary rows. No canvas and no clock read: the caller supplies the
// frozen/live instant, the already-localized age label, and the pane width.
// Every decision that used to be made while painting (coverage marks, the
// two-column fallback, grouped spacing) is made here so the layout is unit
// testable; the painter just walks the rows.
export function summaryRows(run, stats, {
  clock, palette, language, filter = 'all', width, ageLabel,
}) {
  const summary = runSummary(run, { now: clock });
  const labelWidth = labelWidthFor(runSummaryLabels(language));
  const valueW = metricValueWidth(width, labelWidth);
  const faint = { fg: palette.faint };
  const rows = [];
  const coverage = metric => (metric && metric.seen < metric.total
    ? [[` ${t(language, 'coverage', { seen: metric.seen, total: metric.total })}`, faint]]
    : undefined);
  const append = (parts, extra) => (extra ? [...parts, ...extra] : parts);
  const row = (label, parts) => {
    rows.push({ type: 'metric', label, parts });
  };

  const counts = filterCounts(run.nodes, summary);
  rows.push({
    type: 'rich',
    parts: [
      [`${statusIcon('failed')} ${t(language, 'failedCount', { count: counts.failed })}`, { fg: palette.failed, bold: counts.failed > 0 }],
      [' · ', faint],
      [`${statusIcon('blocked')} ${t(language, 'blockedCount', { count: counts.blocked })}`, { fg: palette.blocked, bold: counts.blocked > 0 }],
    ],
  });
  rows.push({
    type: 'rich',
    parts: [
      [`${statusIcon('running')} ${t(language, 'runningCount', { count: counts.running })}`, { fg: palette.running, bold: counts.running > 0 }],
      [' · ', faint],
      [`${statusIcon('completed')} ${t(language, 'completedCount', { count: stats.counts.completed ?? 0 })}`, { fg: palette.completed }],
    ],
  });

  const chip = (key, label) => {
    const active = filter === key;
    return [`${active ? '▸ ' : ''}${label}`, {
      fg: active ? palette.accent : palette.faint,
      bold: active,
    }];
  };
  rows.push({
    type: 'rich',
    parts: [
      chip('all', `1 ${t(language, 'filterAll')}`),
      [' · ', faint],
      chip('failed', `2 ${statusIcon('failed')}${counts.failed}`),
      [' · ', faint],
      chip('blocked', `3 ${statusIcon('blocked')}${counts.blocked}`),
      [' · ', faint],
      chip('running', `4 ${statusIcon('running')}${counts.running}`),
      [' · ', faint],
      chip('critical', `5 ${t(language, 'pathShort')}`),
    ],
  });

  rows.push({ type: 'group', label: t(language, 'runSummaryEfficiency') });

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
      parts.push([retryText, retryStyle(palette, retry.value)]);
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
        [retryText, retryStyle(palette, retry.value)],
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

  rows.push({ type: 'gap' });
  rows.push({ type: 'group', label: t(language, 'runSummaryTime') });
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

  rows.push({ type: 'gap' });
  rows.push({ type: 'group', label: t(language, 'runSummaryScope') });
  row(t(language, 'nodesShort'), [
    [t(language, 'nodesEdges', { nodes: run.nodes.length, edges: run.edges.length }), faint],
  ]);
  row('', [[t(language, 'createdAgo', {
    time: run.createdAt ? t(language, 'ago', { time: ageLabel }) : '—',
  }), faint]]);
  return { rows, labelWidth };
}

// Paint the pure rows. Metric rows share one label column; grouped headings
// and the blank spacer before them keep the summary's three blocks distinct.
export function paintSummaryRows(canvas, x, y, w, rows, labelWidth, palette) {
  for (const row of rows) {
    if (row.type === 'gap') {
      y++;
    } else if (row.type === 'group') {
      canvas.put(x, y, row.label.toUpperCase(), { fg: palette.accent2, bold: true, dim: true });
      y++;
    } else if (row.type === 'rich') {
      rich(canvas, x, y, w, row.parts, palette, palette.panel);
      y++;
    } else {
      y = metricRow(canvas, x, y, w, row.label, row.parts, palette, labelWidth);
    }
  }
  return y;
}

export function runSummarySection(canvas, x, y, w, run, stats, {
  clock, ageLabel, palette, language, filter = 'all',
}) {
  const { rows, labelWidth } = summaryRows(run, stats, {
    clock, palette, language, filter, width: w, ageLabel,
  });
  y = detailSection(canvas, x, y, w, t(language, 'runSummary'), palette);
  if (runWarningCount(run)) {
    y = warningsSection(canvas, x, y, w, run, palette, language);
    y++;
  }
  return paintSummaryRows(canvas, x, y, w, rows, labelWidth, palette);
}

export function runWarningCount(run) {
  return Number.isFinite(run?.warningCount) ? run.warningCount : (run?.warnings?.length ?? 0);
}

const WARNING_REASON_KEYS = {
  'invalid-record': 'warningReasonInvalidRecord',
  'missing-id': 'warningReasonMissingId',
  'duplicate-id': 'warningReasonDuplicateId',
  'unknown-state': 'warningReasonUnknownState',
  'unknown-node': 'warningReasonUnknownNode',
  'self-edge': 'warningReasonSelfEdge',
};

function warningReasonLabel(language, warning) {
  const key = WARNING_REASON_KEYS[warning?.reason] ?? 'warningReasonUnknown';
  return t(language, key, { state: warning?.state ?? '—' });
}

function warningLine(warning, language) {
  const reason = warningReasonLabel(language, warning);
  if (warning?.code === 'edge-dropped') {
    return t(language, 'warningEdgeDropped', {
      from: warning.from ?? '—', to: warning.to ?? '—', reason,
    });
  }
  return warning?.nodeId
    ? t(language, 'warningNodeDropped', { id: warning.nodeId, reason })
    : t(language, 'warningNodeDroppedAnonymous', { reason });
}

// A dropped node or edge is proof that the snapshot is incomplete. Keep the
// heading count exact, bound the painted reasons, and name the remainder so a
// long warning list can never push live evidence off the pane or imply the
// visible rows are the whole loss.
const WARNING_ROWS = 3;
export function warningsSection(canvas, x, y, w, run, palette, language, bottom = Infinity) {
  const warnings = Array.isArray(run?.warnings) ? run.warnings : [];
  const count = runWarningCount(run);
  if (!count || y >= bottom - 1) return y;
  y = detailSection(canvas, x, y, w, `${t(language, 'warnings')} ${count}`, palette);
  const shown = warnings.slice(0, WARNING_ROWS);
  for (const warning of shown) {
    if (y >= bottom) break;
    y = detailLine(canvas, x, y, w, [[warningLine(warning, language), { fg: palette.warn }]], palette);
  }
  if (count > shown.length && y < bottom) {
    y = detailLine(canvas, x, y, w, [[t(language, 'warningsMore', {
      count: count - shown.length,
    }), { fg: palette.faint, dim: true }]], palette);
  }
  return y;
}
