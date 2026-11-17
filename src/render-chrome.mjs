// Chrome paints the frame-wide context: the header brand, breadcrumb and
// status, and the footer legend, hints and settings entry. The shared
// selection, freshness and compact-age helpers come from the pure render-view
// leaf; chrome never imports the render entry point, so the module graph stays
// acyclic.
import { rich } from './frame-primitives.mjs';
import { statusLabel, t } from './i18n.mjs';
import { isVirtualRun, modeFor, runStats } from './model.mjs';
import {
  captureAgeLabel, displayRunName, entityState, HEADER_H, isActiveSnapshot,
  modeColor, resolveSelection, snapshotFreshness,
} from './render-view.mjs';
import { gradientCells, mix, statusColor } from './theme.mjs';
import { clock, fit, truncateMiddle, width as textWidth } from './text.mjs';

function modeBadge(snapshot, language, freshness = snapshotFreshness(snapshot)) {
  const mode = modeFor(snapshot);
  if (mode === 'demo') return `◆ ${t(language, 'modeDemo')}`;
  if (mode === 'saved') return `○ ${t(language, 'modeSaved')}`;
  if (snapshot?.connected === false) return `○ ${t(language, 'modeWaiting')}`;
  if (freshness.stale) return `▲ ${t(language, 'modeStale')}`;
  return `● ${t(language, 'modeLive')}`;
}

// Header row 1 is the context path: run > node > task, then status, counts, and
// a retry marker. Task id and status have priority; the run name is middle
// truncated and the node is end truncated before either is dropped. Every
// painted context segment owns a hitbox so the path is clickable.
function renderBreadcrumb(canvas, width, snapshot, ui, { palette, language }, hitboxes) {
  const { run, task, node, showTask } = resolveSelection(snapshot, ui, { allowRunFallback: true });
  const statusEntity = showTask ? task : node ?? run;
  const status = entityState(statusEntity);
  const stats = run ? runStats(run) : null;
  const retries = statusEntity?.retries ?? statusEntity?.failedTurns;
  const runText = run ? displayRunName(run, language) : t(language, 'noWorkflowShort');
  const nodeText = node?.label
    ?? (showTask ? t(language, 'noNodeShort') : t(language, 'runOverviewShort'));
  const taskText = showTask ? task?.id : node?.taskId;
  const countsText = stats
    ? t(language, 'graphSummary', {
      done: stats.done, total: stats.total, running: stats.counts.running ?? 0,
    })
    : undefined;
  const retryText = Number(retries) > 0 ? `↻ ${retries}` : undefined;
  const available = Math.max(8, width - 4);
  const separator = t(language, 'contextSeparator');

  const build = (runValue, nodeValue, taskValue, counts, retry) => {
    const parts = [];
    const taskId = showTask ? task?.id : node?.taskId;
    if (runValue) parts.push({ kind: 'run', id: run?.id, text: runValue, sep: '', fg: palette.text, bold: true });
    if (run && isVirtualRun(run)) parts.push({ kind: null, text: t(language, 'virtualRunBadge'), sep: ' · ', fg: palette.accent2, bold: true });
    if (nodeValue) parts.push({ kind: 'node', id: node?.id, text: nodeValue, sep: separator, fg: palette.accent2 });
    if (taskValue) parts.push({ kind: 'task', id: taskId, text: taskValue, sep: separator, fg: palette.dim });
    if (status && !(isVirtualRun(run) && statusEntity === run)) {
      parts.push({
        kind: null,
        text: statusLabel(language, status).toUpperCase(),
        sep: ' · ',
        fg: statusColor(palette, status),
        bold: true,
      });
    }
    if (counts) parts.push({ kind: null, text: counts, sep: ' · ', fg: palette.faint });
    if (retry) parts.push({ kind: null, text: retry, sep: ' · ', fg: palette.warn });
    return parts;
  };
  const measure = parts => parts.reduce((sum, part) =>
    sum + textWidth(part.sep) + textWidth(part.text), 0);

  let segments = build(runText, nodeText, taskText, countsText, retryText);
  let guard = 0;
  while (measure(segments) > available && guard++ < 96) {
    const counts = segments.findIndex(part => part.kind === null && part.text === countsText);
    if (counts >= 0) { segments.splice(counts, 1); continue; }
    const retry = segments.findIndex(part => part.kind === null && part.text === retryText);
    if (retry >= 0) { segments.splice(retry, 1); continue; }
    const runPart = segments.find(part => part.kind === 'run');
    if (runPart && textWidth(runPart.text) > 3) {
      runPart.text = truncateMiddle(runPart.text, textWidth(runPart.text) - 1);
      continue;
    }
    const nodePart = segments.find(part => part.kind === 'node');
    if (nodePart && textWidth(nodePart.text) > 3) {
      nodePart.text = fit(nodePart.text, textWidth(nodePart.text) - 1);
      continue;
    }
    if (runPart) { segments = segments.filter(part => part !== runPart); continue; }
    if (nodePart) { segments = segments.filter(part => part !== nodePart); continue; }
    const taskPart = segments.find(part => part.kind === 'task');
    if (taskPart && textWidth(taskPart.text) > 4) {
      taskPart.text = fit(taskPart.text, textWidth(taskPart.text) - 1);
      continue;
    }
    const widths = segments.reduce((sum, part) => sum + textWidth(part.sep), 0);
    const textBudget = Math.max(1, available - widths);
    const totalText = segments.reduce((sum, part) => sum + textWidth(part.text), 0);
    if (totalText > textBudget) {
      const last = segments.at(-1);
      last.text = fit(last.text, Math.max(1, textWidth(last.text) - (totalText - textBudget)));
    }
    break;
  }

  let cursor = 2;
  const maxX = width - 2;
  for (const part of segments) {
    if (cursor >= maxX) break;
    if (part.sep) {
      const shownSep = fit(part.sep, maxX - cursor);
      canvas.put(cursor, 1, shownSep, { fg: palette.faint, bg: palette.bgAlt });
      cursor += textWidth(shownSep);
    }
    if (cursor >= maxX) break;
    const shown = fit(part.text, maxX - cursor);
    if (!shown) continue;
    const used = textWidth(shown);
    canvas.put(cursor, 1, shown, {
      fg: part.fg, bg: palette.bgAlt, bold: part.bold,
    });
    if (part.kind && part.id) {
      hitboxes.context[part.kind] = { x: cursor, y: 1, w: used, h: 1, id: part.id };
    }
    cursor += used;
  }
}

export function renderHeader(canvas, width, snapshot, ui, {
  time, now, palette, motion, language, freshness = snapshotFreshness(snapshot, { now, staleAfterMs: ui.staleAfterMs }),
}, hitboxes) {
  canvas.fill(0, 0, width, HEADER_H, { bg: palette.bgAlt, fg: palette.text });
  const gradient = gradientCells('DAG STUDIO', palette.accent, palette.accent2, { shift: motion ? time / 900 : 0 });
  let x = 2;
  for (const part of gradient) {
    canvas.put(x, 0, part.text, { fg: part.color, bg: palette.bgAlt, bold: true });
    x += textWidth(part.text);
  }
  x += 2;
  canvas.put(x, 0, 'v0.1.0', { fg: palette.faint, bg: palette.bgAlt, dim: true });
  const brandEnd = x + textWidth('v0.1.0');
  renderBreadcrumb(canvas, width, snapshot, ui, { palette, language }, hitboxes);
  const badgeText = modeBadge(snapshot, language, freshness);
  const badgeColor = modeColor(snapshot, palette, time, motion, freshness);
  const clockText = clock(new Date(now).getHours() * 3600_000 + new Date(now).getMinutes() * 60_000 + new Date(now).getSeconds() * 1000);
  // The right block may never start under the brand. Mode is the contract and
  // always survives. Capture age is the freshness evidence, so it survives
  // too, at every width. Session and clock give way first.
  const rightStart = brandEnd + 2;
  const available = Math.max(0, width - rightStart - 2);
  // Below 48 columns the full "captured 8h ago" phrase is clipped before its
  // value. Keep the freshness evidence as the compact unit ("8h") there so the
  // age survives at every width the header itself can fit; the shared formatter
  // owns the threshold and the compact unit for both cases.
  const ageText = captureAgeLabel(freshness, language, { compact: width < 48 });
  let showClock = width >= 80;
  const showAge = Boolean(ageText);
  const reserved = () => (showAge ? textWidth(ageText) + 3 : 0) + (showClock ? textWidth(clockText) + 3 : 0);
  let sessionWidth = available - textWidth(badgeText) - 3 - reserved();
  if (sessionWidth < 8 && showClock) {
    showClock = false;
    sessionWidth = available - textWidth(badgeText) - 3 - reserved();
  }
  if (sessionWidth < 6) sessionWidth = 0;
  const session = truncateMiddle(snapshot.sessionId ?? '', Math.max(0, sessionWidth));
  const rightParts = [badgeText];
  if (session) rightParts.push(session);
  if (showAge) rightParts.push(ageText);
  if (showClock) rightParts.push(clockText);
  const right = fit(rightParts.join('   '), available);
  canvas.put(Math.max(rightStart, width - textWidth(right) - 2), 0, right, {
    fg: badgeColor, bg: palette.bgAlt, bold: isActiveSnapshot(snapshot),
  });
  for (let column = 0; column < width; column++) {
    const t = column / Math.max(1, width - 1);
    canvas.put(column, 2, '─', { fg: mix(palette.border, palette.accent, t * 0.35), bg: palette.bg });
  }
}

export function renderFooter(canvas, width, height, snapshot, ui, {
  palette, time, now, language, freshness = snapshotFreshness(snapshot, { now, staleAfterMs: ui.staleAfterMs }),
}, hitboxes) {
  const y = height - 2;
  canvas.hline(0, y, width, { fg: mix(palette.border, palette.bg, 0.35), bg: palette.bg });
  if (ui.installVersion) {
    const label = fit(` ${ui.installVersion} `, Math.max(0, width - 2));
    if (label) {
      canvas.put(Math.max(0, width - textWidth(label) - 1), y, label, {
        fg: palette.accent2, bg: palette.bg,
      });
    }
  }
  const mode = modeFor(snapshot);
  const active = isActiveSnapshot(snapshot);
  const follow = ui.follow && active;
  const selection = ui.mouseCapture === false ? `${t(language, 'selectionOn')} · ` : '';
  const glyph = freshness.stale ? '▲' : mode === 'demo' ? '◆' : mode === 'live' && snapshot.connected !== false ? '●' : '○';
  const followText = freshness.stale
    ? t(language, 'modeStale')
    : follow ? t(language, 'followOn') : t(language, 'followOff');
  const followShort = freshness.stale
    ? t(language, 'modeStale')
    : follow ? t(language, 'on') : t(language, 'off');
  const baseRight = width >= 110
    ? `${selection}${glyph} ${followText}  ${ui.fps ?? 60}fps`
    : width >= 84
      ? `${selection}${glyph} ${followShort}  ${ui.fps ?? 60}fps`
      : `${selection}${glyph} ${followShort}`;
  const recent = (ui.toasts ?? []).filter(toast => now - toast.at < 5000).at(-1);
  const settingsText = width >= 40 ? `⚙ ${t(language, 'settings')}` : '⚙';
  const settingsWidth = textWidth(settingsText);
  const settingsX = Math.max(1, width - settingsWidth - 1);
  const maxToast = Math.max(8, width - 12 - settingsWidth - 2);
  const right = recent ? fit(`▌ ${recent.text}`, maxToast) : baseRight;
  const rightColor = recent
    ? (recent.kind === 'failed' ? palette.failed : recent.kind === 'completed' ? palette.completed : recent.kind === 'warning' ? palette.warn : palette.accent)
    : (follow ? palette.accent : palette.faint);
  const leftWidth = Math.max(1, width - textWidth(right) - settingsWidth - 5);
  const limit = 1 + leftWidth;
  let cursor = 1;
  const draw = (text, style) => {
    if (cursor >= limit) return false;
    const source = String(text);
    const shown = textWidth(source) > limit - cursor ? fit(source, limit - cursor) : source;
    canvas.put(cursor, height - 1, shown, { bg: palette.bg, ...style });
    cursor += textWidth(shown);
    return shown === source;
  };
  // Word legend from 70 columns; the glyph legend below it keeps room for named
  // actions. The legend itself stays inert.
  const legend = width >= 70
    ? [
      [t(language, 'legendRun'), { fg: palette.running }],
      [t(language, 'legendDone'), { fg: palette.completed }],
      [t(language, 'legendFail'), { fg: palette.failed }],
      [t(language, 'legendWait'), { fg: palette.blocked }],
    ]
    : [
      [t(language, 'legendRunShort'), { fg: palette.running }],
      [t(language, 'legendDoneShort'), { fg: palette.completed }],
      [t(language, 'legendFailShort'), { fg: palette.failed }],
      [t(language, 'legendWaitShort'), { fg: palette.blocked }],
    ];
  for (const [text, style] of legend) draw(text, style);
  const helpLabel = t(language, 'helpLabel');
  const selectLabel = t(language, 'selectMode');
  const clearLabel = t(language, 'clearLabel');
  draw(' ', { fg: palette.dim });
  const helpStart = cursor;
  const helpKey = draw('? ', { fg: palette.accent2, bold: true });
  const helpWord = width >= 40 ? draw(helpLabel, { fg: palette.accent2, bold: true }) : true;
  if (helpKey && helpWord && cursor > helpStart) {
    hitboxes.helpHint = { x: helpStart, y: height - 1, w: cursor - helpStart, h: 1 };
  }
  const drawAction = (key, label, hitboxKey) => {
    draw(' ', { fg: palette.dim });
    const start = cursor;
    const keyDrawn = draw(label ? `${key} ` : key, { fg: palette.accent2, bold: true });
    const labelDrawn = label ? draw(label, { fg: palette.accent2, bold: true }) : true;
    if (keyDrawn && labelDrawn && cursor > start) {
      hitboxes[hitboxKey] = { x: start, y: height - 1, w: cursor - start, h: 1 };
    }
  };
  const named = width >= 54;
  drawAction('m', named ? selectLabel : '', 'selectHint');
  drawAction('x', named ? clearLabel : '', 'clearHint');
  const hint = ui.runOverview
    ? `${t(language, 'filterHint')} · ${t(language, 'footerOverviewHint')}`
    : ui.focus === 'details'
      ? t(language, 'footerDetailsHint')
      : ui.focus === 'tasks'
        ? t(language, 'footerTasksHint')
        : t(language, 'footerGraphHint');
  draw('  ', { fg: palette.faint });
  draw(hint, { fg: palette.faint, dim: true });
  const rightX = Math.max(1, settingsX - textWidth(right) - 2);
  canvas.put(rightX, height - 1, right, {
    fg: rightColor,
    bg: palette.bg,
    dim: !recent && !follow,
    bold: Boolean(recent && recent.kind !== 'info'),
  });
  rich(canvas, settingsX, height - 1, settingsWidth, [
    [settingsText, { fg: ui.settingsMenu ? palette.white : palette.accent2, bold: true }],
  ], palette, ui.settingsMenu ? palette.selection : palette.bg);
  hitboxes.settings = { x: settingsX, y: height - 1, w: settingsWidth, h: 1 };
}
