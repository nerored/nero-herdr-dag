// Shared panel painters used by the renderer, the duty layout, and the subject
// body: the progress block and the empty/source-health/source panels. Panels
// own presentation only; freshness and selection come from render-view.mjs and
// this module imports no state, input, or terminal surface.
import { detailLine, detailSection, rich } from './frame-primitives.mjs';
import { t } from './i18n.mjs';
import { PROVENANCE_FIELDS } from './model.mjs';
import { shortPath } from './render-subject.mjs';
import {
  captureAgeLabel, capturedDisplay, modeColor, modeName, provenanceValue,
  snapshotFreshness, snapshotMode,
} from './render-view.mjs';
import { compactDuration, percentBar, width as textWidth } from './text.mjs';
function agoLabel(ms, language) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1500) return t(language, 'now');
  return t(language, 'ago', { time: compactDuration(ms, language) });
}

// Percent unknown is not percent zero. A running subject gets an indeterminate
// sweep: one lit segment travels over the honest empty track. With motion off
// the segment holds a static position, so the track still reads as active
// rather than filled. The caller keeps the explicit unknown-percent label.
export function drawIndeterminateBar(canvas, x, y, width, {
  time = 0, motion = true, palette, color, bg, dim = false,
}) {
  const columns = Math.max(0, Math.floor(width));
  if (!columns) return;
  const segment = Math.max(1, Math.min(3, Math.round(columns / 6)));
  const travel = columns - segment;
  const position = motion
    ? Math.round((Math.sin(time / 650) * 0.5 + 0.5) * travel)
    : Math.floor(travel / 2);
  canvas.put(x, y, '─'.repeat(columns), { fg: palette.border, bg, dim: true });
  canvas.put(x + position, y, '█'.repeat(segment), {
    fg: color ?? palette.accent, bg, bold: !dim, dim,
  });
}

// Shared progress block. A known percent keeps its filled track and numeric
// label. An unknown percent on a running subject gets the indeterminate sweep
// plus the explicit label, inline when it fits and on its own row when not.
export function progressBlock(canvas, x, y, w, progress, {
  time = 0, motion = true, palette, color, bg, bold = false,
}) {
  if (progress.known) {
    const labelW = textWidth(progress.label);
    // A derived-status label can be wider than the narrow details body. Put
    // the bar on its own row instead of truncating the truth away.
    if (labelW + 8 > w) {
      rich(canvas, x, y, w, [
        [percentBar(progress.value, Math.max(6, w), { empty: '─' }), { fg: color, bold }],
      ], palette, bg);
      rich(canvas, x, y + 1, w, [
        [progress.label, { fg: palette.text, bold: true }],
      ], palette, bg);
      return y + 2;
    }
    const barW = Math.max(6, w - labelW - 2);
    rich(canvas, x, y, w, [
      [percentBar(progress.value, barW, { empty: '─' }), { fg: color, bold }],
      [` ${progress.label}`, { fg: palette.text, bold: true }],
    ], palette, bg);
    return y + 1;
  }
  if (!progress.running) {
    rich(canvas, x, y, w, [[progress.label, { fg: palette.faint, dim: true }]], palette, bg);
    return y + 1;
  }
  const labelW = textWidth(progress.label);
  if (w >= labelW + 8) {
    const barW = Math.max(6, w - labelW - 2);
    drawIndeterminateBar(canvas, x, y, barW, { time, motion, palette, color, bg });
    rich(canvas, x + barW + 1, y, w - barW - 1, [
      [progress.label, { fg: palette.text, bold: true }],
    ], palette, bg);
    return y + 1;
  }
  drawIndeterminateBar(canvas, x, y, w, { time, motion, palette, color, bg });
  rich(canvas, x, y + 1, w, [
    [progress.shortLabel ?? progress.label, { fg: palette.text, bold: true }],
  ], palette, bg);
  return y + 2;
}

// One empty-state headline decision shared by every empty body. Freshness is a
// frame fact: a stale capture says STALE instead of claiming a live connection,
// and a capture with no recorded timestamp has no fresh-connection evidence.
function emptyStateLabel(snapshot, language, freshness = snapshotFreshness(snapshot)) {
  const mode = snapshotMode(snapshot);
  if (mode === 'saved') return t(language, 'emptySaved');
  if (mode === 'demo') return t(language, 'emptyDemo');
  if (snapshot?.connected === false) return t(language, 'emptyWaiting');
  if (freshness.capturedAtMs === undefined) return t(language, 'waitingSnapshot');
  if (freshness.stale) return `${t(language, 'modeStale')} · ${t(language, 'noWorkflow')}`;
  return t(language, 'emptyConnected');
}

// The source-health and connected-empty surfaces are shared by the graph,
// details, duty, and overview painters. They are defined once here so every
// branch can name the watched path, capture age, and next action without
// fabricating a subject.
export function renderEmptyState(canvas, x, y, w, h, snapshot, {
  palette, language, now, freshness = snapshotFreshness(snapshot, { now }),
}) {
  const mode = snapshotMode(snapshot);
  const path = shortPath(snapshot?.provenance?.statePath) ?? t(language, 'provenanceUnavailable');
  const age = captureAgeLabel(freshness, language) ?? t(language, 'provenanceUnavailable');
  const headline = emptyStateLabel(snapshot, language, freshness);
  let lines;
  if (mode === 'saved') {
    lines = [
      [headline, { fg: palette.dim }],
      [t(language, 'emptySavedHint', {
        time: capturedDisplay(snapshot?.provenance?.capturedAt) ?? '—', path,
      }), { fg: palette.faint, dim: true }],
    ];
  } else if (mode === 'demo') {
    lines = [[headline, { fg: palette.dim }]];
  } else if (snapshot?.connected !== false) {
    lines = freshness.stale
      ? [
        [headline, { fg: palette.warn, bold: true }],
        [t(language, 'emptyConnectedHint', { path, age }), { fg: palette.faint }],
        // Not "wait for the producer": a stale capture is no longer live, and
        // the next step is to check the path and retry.
        [t(language, 'emptyWaitingNext'), { fg: palette.dim }],
      ]
      : [
        [headline, { fg: palette.accent2, bold: true }],
        [t(language, 'emptyConnectedHint', { path, age }), { fg: palette.faint }],
        [t(language, 'emptyConnectedNext'), { fg: palette.dim }],
      ];
  } else {
    // A failed read keeps its error and watched path in the frame instead of
    // living only in a transient footer toast. The retry line states what the
    // viewer keeps doing while it waits, so WAITING never looks like a dead end.
    const readError = snapshot?.readError?.message ?? snapshot?.readError;
    lines = [
      [headline, { fg: palette.warn, bold: true }],
      [t(language, 'emptyWaitingHint', { path, age }), { fg: palette.faint }],
      ...(readError ? [[t(language, 'emptyWaitingError', { error: readError }), { fg: palette.failed }]] : []),
      [t(language, 'emptyWaitingRetry'), { fg: palette.dim }],
      [t(language, 'emptyWaitingNext'), { fg: palette.dim }],
    ];
  }
  let row = y;
  for (const [text, style] of lines) {
    if (row >= y + h) break;
    row = detailLine(canvas, x, row, w, [[text, style]], palette);
  }
  // Health is part of the empty contract too: a connected producer may still
  // have a broken store, and a never-read viewer must say it has no health
  // evidence rather than implying the store is fine. A heading without room
  // for one source row is omitted rather than painted over the panel border.
  if (mode !== 'saved' && mode !== 'demo' && row < y + h) {
    if (snapshot?.sources?.length) {
      if (row + 1 < y + h) {
        row = sourceHealthSection(canvas, x, row, w, snapshot, {
          palette, language, now, bottom: y + h,
        });
      }
    } else {
      row = detailLine(canvas, x, row, w, [
        [t(language, 'sourceHealthUnavailable'), { fg: palette.faint, dim: true }],
      ], palette);
    }
  }
  return row;
}

// Source health is producer vocabulary, so its status tokens and count words
// are translated instead of leaking the raw store status into the panel.
// Unknown values keep their token: a future producer state must stay visible
// rather than disappear behind a generic label.
const SOURCE_STATUS_KEYS = {
  ok: 'sourceStatusOk',
  missing: 'sourceStatusMissing',
  empty: 'sourceStatusEmpty',
  unreadable: 'sourceStatusUnreadable',
};

function sourceStatusLabel(language, status) {
  if (status === undefined || status === null) return t(language, 'provenanceUnavailable');
  const key = SOURCE_STATUS_KEYS[status];
  return key ? t(language, key) : String(status);
}

export function sourceHealthSection(canvas, x, y, w, snapshot, {
  palette, language, now = Date.now(), bottom = Infinity,
}) {
  if (y >= bottom) return y;
  y = detailSection(canvas, x, y, w, t(language, 'sourceHealth'), palette);
  const color = status => (status === 'unreadable' ? palette.failed : status === 'ok' ? palette.completed : palette.warn);
  const write = parts => {
    if (y < bottom) y = detailLine(canvas, x, y, w, parts, palette);
  };
  // The panel words are already translated; lower-casing keeps the English
  // count rows in their established lowercase form while zh gets 任务/运行.
  const tasksLabel = t(language, 'tasks').toLowerCase();
  const runsLabel = t(language, 'runs').toLowerCase();
  for (const source of snapshot?.sources ?? []) {
    if (y >= bottom) return y;
    const label = source.label ?? source.id ?? source.root ?? t(language, 'provenanceUnavailable');
    write([
      [`${label} `, { fg: palette.text, bold: true }],
      [sourceStatusLabel(language, source.status), { fg: color(source.status), bold: true }],
    ]);
    if (source.tasks) {
      const counts = source.tasks;
      const accepted = t(language, 'sourceCountAccepted', { count: counts.accepted });
      const foreign = t(language, 'sourceCountForeign', { count: counts.foreign });
      const invalid = t(language, 'sourceCountInvalid', { count: counts.invalid });
      const full = `${accepted} · ${foreign} · ${invalid}`;
      if (textWidth(`${tasksLabel} ${full}`) <= w) {
        write([
          [`${tasksLabel} `, { fg: palette.faint }], [full, { fg: palette.dim }],
        ]);
      } else {
        write([
          [`${tasksLabel} `, { fg: palette.faint }],
          [`${accepted} · ${foreign}`, { fg: palette.dim }],
        ]);
        write([
          ['  ', { fg: palette.faint }], [invalid, { fg: palette.dim }],
        ]);
      }
    }
    if (source.runs) {
      const counts = source.runs;
      write([
        [`${runsLabel} `, { fg: palette.faint }],
        [`${counts.accepted}/${counts.foreign}/${counts.invalid}`, { fg: palette.dim }],
        [`  ${t(language, 'sourceFields')} ${counts.files}`, { fg: palette.faint }],
      ]);
    }
    const scannedAt = source.scannedAt ? Date.parse(source.scannedAt) : NaN;
    if (Number.isFinite(scannedAt)) {
      write([[t(language, 'sourceScanned', {
        time: agoLabel(Math.max(0, now - scannedAt), language),
      }), { fg: palette.faint }]]);
    }
    if (source.root) {
      write([[shortPath(source.root), { fg: palette.faint, dim: true }]]);
    }
    if (source.error) {
      write([[source.error, { fg: palette.failed }]]);
    }
  }
  return y;
}

export function sourceSection(canvas, x, y, w, entity, snapshot, {
  palette, language, verbose = false, now = Date.now(), freshness,
}) {
  y = detailSection(canvas, x, y, w, t(language, 'sourceSection'), palette);
  const provenance = snapshot?.provenance ?? {};
  const mode = snapshotMode(snapshot);
  // Freshness is a frame fact, not a snapshot-mode fact. A stale capture keeps
  // its origin and version rows but never prints the live mode that the
  // header already replaced with STALE.
  const view = freshness ?? snapshotFreshness(snapshot, { now });
  const write = (label, value, style = { fg: palette.dim }) => {
    y = detailLine(canvas, x, y, w, [[`${label}  `, { fg: palette.faint }], [String(value), style]], palette);
  };
  write(t(language, 'sourceMode'), view.stale ? t(language, 'modeStale') : modeName(mode, language), {
    fg: view.stale ? palette.warn : modeColor(snapshot, palette, 0, false, view),
    bold: mode === 'demo' && !view.stale,
  });
  write(t(language, 'sourceOrigin'), provenance.origin ?? t(language, 'provenanceUnavailable'));
  const captured = capturedDisplay(provenance.capturedAt);
  if (captured) write(t(language, 'capturedAt', { time: '' }).trim(), captured);
  const statePath = shortPath(provenance.statePath);
  if (statePath) write(t(language, 'sourceSnapshot'), statePath);
  const roots = new Set();
  const taskDir = shortPath(provenance.taskStateDir);
  if (taskDir) roots.add(taskDir);
  for (const source of snapshot?.sources ?? []) {
    const root = shortPath(source.root);
    if (root) roots.add(root);
  }
  for (const root of roots) write(t(language, 'sourceTaskStore'), root);
  write(t(language, 'sourceVersion'), String(snapshot?.version ?? '—'));
  for (const field of PROVENANCE_FIELDS) {
    const entry = entity?.provenance?.[field];
    if (!entry) continue;
    if (!verbose && (entry.kind === 'recorded' || entry.kind === 'simulated')) continue;
    write(field, provenanceValue(entry, language), {
      fg: entry.kind === 'recorded' || entry.kind === 'simulated' ? palette.text : palette.faint,
      dim: entry.kind === 'unavailable',
    });
  }
  return y;
}
