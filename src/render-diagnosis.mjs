import { diagnosisPathsText } from './diagnosis.mjs';
import { detailLine, detailSection, rich } from './frame-primitives.mjs';
import { statusLabel, t } from './i18n.mjs';
import { statusIcon } from './theme.mjs';
import {
  charWidth as textCharWidth, compactDuration, fit, segments as textSegments, width as textWidth, wrap,
} from './text.mjs';
// The frame module keeps the shared status predicates and the mode label. The
// render <-> diagnosis cycle is deliberate: every binding imported here is a
// hoisted function declaration, so both load orders initialize before any
// painter runs.
import { entityState, isFailureState, modeName } from './render.mjs';

function errorSourceLine(canvas, x, y, w, entity, palette, language) {
  if (!entity.error || (entity.errorSource === undefined && entity.errorKind === undefined)) return y;
  const source = entity.errorSource !== undefined
    ? t(language, 'errorSource', { value: entity.errorSource }) : undefined;
  const kind = entity.errorKind !== undefined
    ? t(language, 'errorKind', { value: entity.errorKind }) : undefined;
  const combined = [source, kind].filter(Boolean).join(' · ');
  if (!kind || !source || textWidth(combined) <= w) {
    return detailLine(canvas, x, y, w, [[combined, { fg: palette.faint }]], palette);
  }
  y = detailLine(canvas, x, y, w, [[source, { fg: palette.faint }]], palette);
  return detailLine(canvas, x, y, w, [[kind, { fg: palette.faint }]], palette);
}

function terminalTimeDisplay(value) {
  const at = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) return undefined;
  return `${new Date(at).toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return undefined;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function diagnosisColor(palette, state) {
  if (state === 'failed' || state === 'error') return palette.failed;
  if (state === 'blocked') return palette.blocked;
  if (state === 'paused') return palette.paused;
  return palette.dim;
}

function diagnosisReason(diagnosis, language) {
  if (diagnosis.reason) return { text: diagnosis.reason, missing: false };
  if (diagnosis.blockedBy.length) {
    return {
      text: t(language, 'diagnosisBlockedBy', {
        nodes: diagnosis.blockedBy
          .map(upstream => `${upstream.label} (${statusLabel(language, upstream.state)})`)
          .join(', '),
      }),
      missing: false,
    };
  }
  const key = diagnosis.state === 'failed' || diagnosis.state === 'error'
    ? 'errorNotRecorded' : 'diagnosisReasonMissing';
  return { text: t(language, key), missing: true };
}

function diagnosisLast(diagnosis, language) {
  const activity = diagnosis.lastActivity;
  if (!activity) return { text: t(language, 'diagnosisLastMissingShort'), missing: true };
  if (activity.kind === 'tool') {
    return {
      text: diagnosis.beforeStopMs !== undefined
        ? t(language, 'diagnosisLastTool', {
          tool: activity.tool, time: compactDuration(diagnosis.beforeStopMs, language),
        })
        : t(language, 'diagnosisLastToolRecorded', { tool: activity.tool }),
      missing: false,
    };
  }
  return {
    text: t(language, 'diagnosisLastActivity', { text: activity.text }).replace(/^activity\s+/u, ''),
    missing: false,
  };
}

function diagnosisRetry(diagnosis, language, { compact = false } = {}) {
  const parts = [];
  if (diagnosis.failedTurns === undefined && diagnosis.retries === undefined) {
    parts.push(t(language, 'diagnosisRetriesMissing'));
  }
  if (diagnosis.failedTurns !== undefined) {
    parts.push(t(language, 'diagnosisFailedTurns', { count: diagnosis.failedTurns }));
  }
  if (diagnosis.retries !== undefined && diagnosis.retries !== diagnosis.failedTurns) {
    parts.push(t(language, 'diagnosisRetries', { count: diagnosis.retries }));
  }
  if (diagnosis.attempt !== undefined) parts.push(t(language, 'attempt', { count: diagnosis.attempt }));
  parts.push(t(language, compact ? 'diagnosisOmOShort' : 'diagnosisOmO'));
  return parts.join(' · ');
}

function diagnosisSourceParts(diagnosis, language, palette) {
  const tone = diagnosisColor(palette, diagnosis.state);
  const parts = [];
  for (const source of diagnosis.statusSources) {
    const token = source.token === 'task#status' ? t(language, 'diagnosisTaskStatus')
      : source.token === 'node#state' ? t(language, 'diagnosisNodeState')
        : source.token === 'simulated' ? t(language, 'diagnosisSimulated') : source.token;
    if (parts.length) parts.push([' · ', { fg: palette.faint }]);
    parts.push([`${token} ${statusLabel(language, source.state).toUpperCase()}`, {
      fg: tone, bold: !diagnosis.simulated,
    }]);
  }
  if (diagnosis.mismatch) {
    if (parts.length) parts.push([' · ', { fg: palette.faint }]);
    parts.push([t(language, 'diagnosisStatusMismatch'), { fg: palette.warn, bold: true }]);
  }
  if (parts.length) parts.push([' · ', { fg: palette.faint }]);
  parts.push([modeName(diagnosis.mode, language), { fg: palette.faint, dim: true }]);
  return parts;
}

// The record rows come from the same per-source resolver as the `o` action, so
// a task in a secondary store names its real root instead of the provenance
// root that diagnosisFor would have assumed.
function diagnosisRecordText(diagnosis, language, record) {
  const entries = record?.records ?? diagnosis.records;
  const paths = entries
    .filter(entry => entry.key === 'task' || entry.key === 'checkpoint')
    .map(entry => entry.display ?? entry.absolute)
    .filter(Boolean);
  return paths.length ? paths.join(' · ') : t(language, 'diagnosisRecordMissing');
}

function diagnosisEvidenceText(diagnosis, width, language) {
  const artifact = diagnosis.artifact;
  if (!artifact?.display) {
    // A rejected path keeps its reason in the frame. The reason token is short
    // enough for the narrow evidence row; the copy bundle spells out the full
    // "not recorded (reason)" line.
    return {
      text: artifact?.rejected ?? t(language, 'diagnosisArtifactMissing'),
      missing: true,
    };
  }
  const path = width < 40 ? artifact.name : artifact.display;
  const size = formatBytes(artifact.bytes);
  let text = size ? t(language, 'diagnosisArtifact', { path, size }) : path;
  if (width >= 50 && artifact.sha256) {
    text += ` · ${t(language, 'diagnosisArtifactSha', { sha: artifact.sha256.slice(0, 8) })}`;
  }
  return { text, missing: false };
}

function styledTokens(parts) {
  const tokens = [];
  for (const [value, style] of parts) {
    for (const segment of textSegments(value)) {
      const size = textCharWidth(segment);
      if (size > 0) tokens.push({ text: segment, style: style ?? {}, width: size });
    }
  }
  return tokens;
}

function trimStyledLine(line) {
  let start = 0;
  while (start < line.length && /^\s+$/u.test(line[start].text)) start++;
  return line.slice(start);
}

// Fit a styled line with a trailing ellipsis, keeping each token's own tone.
function ellipsizeStyledLine(line, columns) {
  const limit = columns - 1;
  const kept = [];
  let used = 0;
  for (const token of line) {
    if (used + token.width > limit) break;
    kept.push(token);
    used += token.width;
  }
  const style = kept.at(-1)?.style ?? line[0]?.style ?? {};
  kept.push({ text: '…', style, width: 1 });
  return kept;
}

// Wrap styled parts with the same word-break rules as wrap(), but keep every
// part's color, bold, and dim attributes instead of flattening the row to the
// first style.
function wrapStyled(parts, columns, maxLines) {
  if (columns <= 0) return [];
  const lines = [];
  let line = [];
  let lineWidth = 0;
  for (const token of styledTokens(parts)) {
    const size = token.width;
    if (line.length && lineWidth + size > columns) {
      let space = -1;
      for (let index = line.length - 1; index >= 0; index--) {
        if (line[index].text === ' ') { space = index; break; }
      }
      if (space > 0 && token.text !== ' ') {
        lines.push(line.slice(0, space));
        line = line.slice(space + 1);
        lineWidth = line.reduce((sum, item) => sum + item.width, 0);
      } else {
        lines.push(line);
        line = [];
        lineWidth = 0;
      }
      if (line.length && lineWidth + size > columns) {
        lines.push(line);
        line = [];
        lineWidth = 0;
      }
      if (token.text === ' ') continue;
    }
    line.push(token);
    lineWidth += size;
  }
  lines.push(line);
  const wrapped = lines.map(trimStyledLine);
  const shown = maxLines ? wrapped.slice(0, maxLines) : wrapped;
  if (wrapped.length > shown.length && shown.length) {
    shown[shown.length - 1] = ellipsizeStyledLine(shown[shown.length - 1], columns);
  }
  return shown;
}

function diagnosisRow(canvas, x, y, w, labelWidth, label, parts, palette, { maxLines } = {}) {
  const labelText = `${fit(label, Math.max(1, labelWidth - 1), true)} `;
  const valueWidth = Math.max(8, w - labelWidth);
  const text = parts.map(([value]) => value).join('');
  // A value that cannot fit beside its label gets the whole content width.
  // This keeps a phrase such as "failure reason not recorded" contiguous
  // instead of splitting it at the label column.
  if (textWidth(text) > valueWidth) {
    rich(canvas, x, y, w, [[labelText, { fg: palette.faint }]], palette, palette.panel);
    y++;
    const lineWidth = Math.max(8, w - 2);
    for (const line of wrapStyled(parts, lineWidth, maxLines)) {
      rich(canvas, x + 2, y, lineWidth, line.map(token => [token.text, token.style]), palette, palette.panel);
      y++;
    }
    return y;
  }
  // Parts carry their own tone (the status mismatch is warning-colored), so
  // paint them individually instead of collapsing the row into one style.
  rich(canvas, x, y, w, [[labelText, { fg: palette.faint }], ...parts], palette, palette.panel);
  return y + 1;
}

function diagnosisWideRow(canvas, x, y, w, text, style, palette, { maxLines } = {}) {
  const lines = wrap(text, w).map(line => line.replace(/^\s+/, ''));
  const shown = maxLines ? lines.slice(0, maxLines) : lines;
  if (lines.length > shown.length && shown.length) {
    shown[shown.length - 1] = fit(`${shown[shown.length - 1]}…`, w);
  }
  for (const line of shown) {
    rich(canvas, x, y, w, [[line, style]], palette, palette.panel);
    y++;
  }
  return y;
}

function diagnosisCompactSource(diagnosis, language) {
  if (diagnosis.simulated) {
    return `${t(language, 'diagnosisSimulated')} ${statusLabel(language, diagnosis.state).toUpperCase()}`;
  }
  const task = diagnosis.statusSources.find(source => source.token === 'task#status');
  const node = diagnosis.statusSources.find(source => source.token === 'node#state');
  if (task && node && task.state === node.state) {
    return `${t(language, 'diagnosisTaskStatus')}/${t(language, 'diagnosisNodeState')} ${statusLabel(language, task.state).toUpperCase()}`;
  }
  const parts = diagnosis.statusSources.map(source => {
    const token = source.token === 'task#status' ? t(language, 'diagnosisTaskStatus')
      : source.token === 'node#state' ? t(language, 'diagnosisNodeState') : source.token;
    return `${token} ${statusLabel(language, source.state).toUpperCase()}`;
  });
  if (diagnosis.mismatch) parts.push(t(language, 'diagnosisStatusMismatch'));
  return parts.join(' · ');
}

function diagnosisActionHint(diagnosis, language, record) {
  // The open offer follows the open action, not the copy-path bundle. A task
  // in a secondary store can be openable even when diagnosis has no paths.
  if (record?.openPath) return t(language, 'diagnosisCopyHint');
  const paths = Boolean(diagnosisPathsText(diagnosis));
  if (paths) return t(language, 'diagnosisCopyHintNoOpen');
  return t(language, 'diagnosisCopyHintUnavailable');
}

export function diagnosisCompactSection(canvas, x, y, w, diagnosis, { palette, language, record }) {
  const tone = diagnosisColor(palette, diagnosis.state);
  const reason = diagnosisReason(diagnosis, language);
  const terminal = terminalTimeDisplay(diagnosis.terminalAt);
  const last = diagnosisLast(diagnosis, language);
  const evidence = diagnosisEvidenceText(diagnosis, w, language);

  y = detailSection(canvas, x, y, w, t(language, 'diagnosis'), palette);
  y = diagnosisWideRow(canvas, x, y, w,
    `${statusIcon(diagnosis.state)} ${reason.text}`,
    { fg: reason.missing ? palette.faint : tone, dim: reason.missing }, palette, { maxLines: 3 });
  const compactLast = last.missing
    ? t(language, 'diagnosisLastMissingShort')
    : last.text.replace(/^activity\s+/u, '');
  y = diagnosisWideRow(canvas, x, y, w,
    `${t(language, 'diagnosisSrc')} ${diagnosisCompactSource(diagnosis, language)} · ${terminal ? `${t(language, 'diagnosisAt')} ${terminal}` : t(language, 'diagnosisTimeMissing')} · ${t(language, 'diagnosisLast')} ${compactLast}`,
    {
      fg: palette.text,
    }, palette, {
      maxLines: terminal ? 4 : (diagnosis.state === 'failed' || diagnosis.state === 'error' ? 2 : 3),
    });
  y = diagnosisWideRow(canvas, x, y, w,
    `${t(language, 'diagnosisRec')} ${diagnosisRecordText(diagnosis, language, record)} · ${evidence.text}`,
    { fg: palette.dim }, palette, { maxLines: 3 });
  y = diagnosisWideRow(canvas, x, y, w,
    `${diagnosisActionHint(diagnosis, language, record)} · ${t(language, 'diagnosisRetry')} ${diagnosisRetry(diagnosis, language, { compact: true })}`,
    { fg: tone }, palette, { maxLines: 4 });
  return y;
}

export function diagnosisSection(canvas, x, y, w, diagnosis, { palette, language, compact = false, record }) {
  if (compact) return diagnosisCompactSection(canvas, x, y, w, diagnosis, { palette, language, record });
  y = detailSection(canvas, x, y, w, t(language, 'diagnosis'), palette);
  const micro = w < 40;
  const labelWidth = w >= 60 ? 9 : 6;
  const tone = diagnosisColor(palette, diagnosis.state);
  const reason = diagnosisReason(diagnosis, language);
  const last = diagnosisLast(diagnosis, language);
  const evidence = diagnosisEvidenceText(diagnosis, w, language);

  y = diagnosisRow(canvas, x, y, w, labelWidth, t(language, 'diagnosisWhy'), [[
    reason.text, { fg: reason.missing ? palette.faint : palette.text, dim: reason.missing },
  ]], palette, { maxLines: micro ? 3 : 2 });
  const terminal = terminalTimeDisplay(diagnosis.terminalAt);
  y = diagnosisRow(canvas, x, y, w, labelWidth, t(language, 'diagnosisAt'), [[
    terminal
      ? `${terminal} · ${t(language, 'diagnosisTimeSource')}`
      : t(language, 'diagnosisTimeMissing'),
    { fg: terminal ? palette.text : palette.faint, dim: !terminal },
  ]], palette, { maxLines: 1 });
  y = diagnosisRow(canvas, x, y, w, labelWidth, t(language, 'diagnosisLast'), [[
    last.text, { fg: last.missing ? palette.faint : palette.dim, dim: last.missing },
  ]], palette, { maxLines: micro ? 2 : 1 });
  y = diagnosisRow(canvas, x, y, w, labelWidth, t(language, 'diagnosisSrc'),
    diagnosisSourceParts(diagnosis, language, palette), palette, { maxLines: micro ? 3 : 2 });
  y = diagnosisRow(canvas, x, y, w, labelWidth, t(language, 'diagnosisRec'), [[
    diagnosisRecordText(diagnosis, language, record), { fg: palette.dim },
  ]], palette, { maxLines: 3 });
  y = diagnosisRow(canvas, x, y, w, labelWidth,
    t(language, w >= 60 ? 'diagnosisArtifactLabel' : 'diagnosisEvid'), [[
      evidence.text, { fg: evidence.missing ? palette.faint : palette.accent2, dim: evidence.missing },
    ]], palette, { maxLines: 2 });
  y = diagnosisRow(canvas, x, y, w, labelWidth, t(language, 'diagnosisRetry'), [[
    diagnosisRetry(diagnosis, language), { fg: tone },
  ]], palette, { maxLines: 2 });
  y = diagnosisRow(canvas, x, y, w, labelWidth, t(language, 'diagnosisAct'), [[
    diagnosisActionHint(diagnosis, language, record),
    { fg: record?.openPath ? palette.accent2 : palette.faint, italic: !record?.openPath },
  ]], palette, { maxLines: 1 });
  return y;
}

export function diagnosisErrorSection(canvas, x, y, w, entity, diagnosis, palette, language) {
  if (!diagnosis) {
    const errorText = entity.error ?? (isFailureState(entityState(entity)) ? t(language, 'errorNotRecorded') : undefined);
    if (!errorText) return y;
    y = detailSection(canvas, x, y, w, t(language, 'errorSection'), palette);
    for (const line of wrap(errorText, w - 2)) {
      y = detailLine(canvas, x, y, w, [[`× ${line}`, {
        fg: entity.error ? palette.failed : palette.faint,
        bold: Boolean(entity.error),
        dim: !entity.error,
      }]], palette);
    }
    return errorSourceLine(canvas, x, y, w, entity, palette, language);
  }
  // The card owns the reason. Keep ERROR for recorded failure provenance and
  // for the explicit not-recorded line expected by existing evidence views,
  // but do not paint the same reason twice.
  if (!entity.error) {
    y = detailSection(canvas, x, y, w, t(language, 'errorSection'), palette);
    y = detailLine(canvas, x, y, w, [[t(language, 'errorNotRecorded'), {
      fg: palette.faint, dim: true,
    }]], palette);
    return errorSourceLine(canvas, x, y, w, entity, palette, language);
  }
  if (entity.errorSource === undefined && entity.errorKind === undefined) {
    y = detailSection(canvas, x, y, w, t(language, 'errorSection'), palette);
    return detailLine(canvas, x, y, w, [[entity.error, { fg: palette.failed }]], palette);
  }
  y = detailSection(canvas, x, y, w, t(language, 'errorSection'), palette);
  return errorSourceLine(canvas, x, y, w, entity, palette, language);
}

export function fullReasonSection(canvas, x, y, w, diagnosis, palette, language) {
  if (!diagnosis?.reason) return y;
  y = detailSection(canvas, x, y, w, t(language, 'diagnosisFullReason'), palette);
  for (const line of wrap(diagnosis.reason, w - 2)) {
    y = detailLine(canvas, x, y, w, [[line, {
      fg: diagnosisColor(palette, diagnosis.state), dim: diagnosis.state === 'cancelled',
    }]], palette);
  }
  return y;
}
