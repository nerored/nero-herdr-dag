import { commandItems, filterCommands } from './commands.mjs';
import { rich } from './frame-primitives.mjs';
import { languageLabel, t } from './i18n.mjs';
import { modeFor } from './model.mjs';
import { pulse, statusColor, statusIcon } from './theme.mjs';
import { clamp, fit, width as textWidth, wrap } from './text.mjs';
import { filterSwitcher, reconcileSwitcher, switcherItems } from './view-state.mjs';
// The frame module owns the hoisted nav/scroll helpers and the two pure
// formatters, and it calls these painters from renderApp. The resulting cycle
// observes no evaluation order: every binding imported here is a hoisted
// function declaration that is initialized during module instantiation.
import { capturedDisplay, modeName, navTasks, scrollOffset } from './render.mjs';

// A modal owns the pointer while it is open: every row hitbox painted under it
// must stop matching. `hints` is the stronger reset the full-screen switcher
// uses, because it also replaces the footer hints and the settings entry.
export function invalidateOverlayHitboxes(hitboxes, { hints = false } = {}) {
  hitboxes.nodes.clear();
  hitboxes.tasks.clear();
  hitboxes.runs.clear();
  hitboxes.regions.clear();
  hitboxes.scrollbars.clear();
  hitboxes.context = {};
  if (!hints) return;
  hitboxes.helpHint = null;
  hitboxes.selectHint = null;
  hitboxes.clearHint = null;
  hitboxes.helpPanel = null;
  hitboxes.settings = null;
  hitboxes.settingsOptions.clear();
}

function renderHelp(canvas, width, height, {
  palette, time, motion, language, snapshot, helpScroll = 0,
}, hitboxes) {
  canvas.fadeRect(0, 0, width, height, 0.58, palette.bg);
  const w = Math.min(68, width - 4);
  // 32 documented rows plus the pinned data line. A 36-row box keeps the full
  // grouped list visible on a 42-row terminal and scrolls on shorter ones.
  const h = Math.min(36, height - 3);
  const x = Math.floor((width - w) / 2);
  const y = Math.floor((height - h) / 2);
  canvas.fill(x, y, w, h, { bg: palette.panelAlt, fg: palette.text });
  canvas.box(x, y, w, h, {
    border: motion ? pulse(palette.accent, time / 700, 0.3) : palette.accent,
    bg: palette.panelAlt,
    title: t(language, 'helpTitle'),
    titleColor: palette.accent,
    double: true,
  });
  hitboxes.helpPanel = { x, y, w, h };
  const lines = [
    [t(language, 'helpGroupMove'), ''],
    ['↑/↓  j/k', t(language, 'helpScroll')],
    ['PgUp / PgDn', t(language, 'helpPage')],
    ['g / G  Home/End', t(language, 'helpJump')],
    ['Tab / Shift-Tab', t(language, 'helpSelect')],
    [t(language, 'helpGroupView'), ''],
    ['Click', t(language, 'helpClick')],
    ['m', t(language, 'helpMouseSelection')],
    ['Mouse wheel', t(language, 'helpWheel')],
    ['← / →', t(language, 'helpRun')],
    ['Space / Enter', t(language, 'helpFold')],
    ['d', t(language, 'helpVerbose')],
    ['e / Esc', t(language, 'helpDetails')],
    ['v / /', t(language, 'helpSwitcher')],
    ['f', t(language, 'helpFollow')],
    ['S', t(language, 'helpSidebar')],
    [t(language, 'helpGroupActions'), ''],
    ['t', t(language, 'helpTaskFocus')],
    ['T', t(language, 'helpCompleted')],
    ['1–5', t(language, 'helpFilters')],
    ['1 / 2 / 3 / 4', t(language, 'helpDutyFocus')],
    ['z', t(language, 'helpFocusNode')],
    ['n / N', t(language, 'helpNodes')],
    ['[ / ]', t(language, 'helpSections')],
    ['c / p / o', t(language, 'helpDiagnosis')],
    ['x / X / u', t(language, 'helpClearCompleted')],
    ['s', t(language, 'helpSettings')],
    ['r', t(language, 'helpDemo')],
    [t(language, 'helpGroupSystem'), ''],
    [':', t(language, 'helpPalette')],
    ['? / Esc', t(language, 'helpClose')],
    ['q', t(language, 'helpQuit')],
  ];
  const visibleRows = Math.max(1, h - 4);
  const total = lines.length;
  const maxScroll = Math.max(0, total - visibleRows);
  const scroll = scrollOffset(helpScroll, maxScroll);
  if (maxScroll > 0) {
    const position = t(language, 'helpPosition', {
      start: scroll + 1,
      end: Math.min(total, scroll + visibleRows),
      total,
    });
    canvas.put(Math.max(x + 2, x + w - 3 - textWidth(position)), y, position, {
      fg: palette.faint, bg: palette.panelAlt, dim: true,
    });
  }
  let row = y + 2;
  for (const [key, description] of lines.slice(scroll, scroll + visibleRows)) {
    if (!description) {
      canvas.put(x + 3, row, key, { fg: palette.accent2, bg: palette.panelAlt, bold: true });
      row++;
      continue;
    }
    // Keep the demo-data footer row intact on short terminals.
    if (row >= y + h - 2) break;
    canvas.put(x + 3, row, fit(key, 18), { fg: palette.accent, bg: palette.panelAlt, bold: true });
    canvas.put(x + 23, row, fit(description, w - 26), { fg: palette.text, bg: palette.panelAlt });
    row++;
  }
  const dataLine = modeFor(snapshot) === 'demo'
    ? t(language, 'demoData')
    : t(language, 'helpDataSource', {
      mode: modeName(modeFor(snapshot), language),
      origin: snapshot?.provenance?.origin ?? t(language, 'provenanceUnavailable'),
      time: capturedDisplay(snapshot?.provenance?.capturedAt) ?? t(language, 'provenanceUnavailable'),
    });
  canvas.put(x + 3, y + h - 2, fit(dataLine, w - 6), {
    fg: palette.faint, bg: palette.panelAlt, dim: true,
  });
  return { scroll, maxScroll, visibleRows, total };
}

function renderSettingsMenu(canvas, width, height, {
  palette, time, motion, language, index, animation, themeName,
}, hitboxes) {
  canvas.fadeRect(0, 0, width, height, 0.58, palette.bg);
  const w = Math.min(48, width - 4);
  const h = Math.min(11, height - 3);
  const x = Math.floor((width - w) / 2);
  const y = Math.floor((height - h) / 2);
  canvas.fill(x, y, w, h, { bg: palette.panelAlt, fg: palette.text });
  canvas.box(x, y, w, h, {
    border: motion ? pulse(palette.accent, time / 700, 0.3) : palette.accent,
    bg: palette.panelAlt,
    title: t(language, 'settings'),
    titleColor: palette.accent,
    double: true,
  });
  const items = [
    { id: 'theme', label: t(language, 'theme'), value: themeName ?? palette.name },
    {
      id: 'animation',
      label: t(language, 'animation'),
      // Motion is not persisted yet, so the row says so instead of implying
      // Theme/Language-style durability.
      value: t(language, 'animationSession', { value: t(language, animation ? 'on' : 'off') }),
    },
    { id: 'language', label: t(language, 'language'), value: languageLabel(language) },
  ];
  items.forEach((item, itemIndex) => {
    const row = y + 3 + itemIndex;
    const selected = itemIndex === index;
    if (selected) canvas.fill(x + 2, row, w - 4, 1, { bg: palette.selection, fg: palette.text });
    const bg = selected ? palette.selection : palette.panelAlt;
    canvas.put(x + 3, row, fit(`${selected ? '▸ ' : '  '}${item.label}: ${item.value}`, w - 8), {
      fg: selected ? palette.white : palette.text,
      bg,
      bold: selected,
    });
    hitboxes.settingsOptions.set(item.id, { x: x + 2, y: row, w: w - 4, h: 1 });
  });
  canvas.put(x + 3, y + h - 2, fit(t(language, 'settingsHint'), w - 6), {
    fg: palette.faint, bg: palette.panelAlt, dim: true,
  });
}

export function switcherView(snapshot, ui) {
  const run = snapshot?.runs?.[clamp(ui?.runIndex ?? 0, 0, Math.max(0, (snapshot?.runs?.length ?? 0) - 1))];
  const all = switcherItems(snapshot, ui?.switcher?.frozenKeys, {
    preferRunId: run?.id,
    tasks: navTasks(snapshot),
  });
  const items = filterSwitcher(all, ui?.switcher?.query);
  return { items, activeKey: reconcileSwitcher(items, ui?.switcher?.activeKey) };
}

function renderSwitcher(canvas, width, height, snapshot, ui, { palette, time, motion, language }, hitboxes) {
  const { items, activeKey } = switcherView(snapshot, ui);
  const query = String(ui.switcher?.query ?? '');
  canvas.fadeRect(0, 0, width, height, 0.58, palette.bg);
  const w = Math.min(78, width - 4);
  const h = Math.min(Math.max(12, height - 4), 26);
  const x = Math.floor((width - w) / 2);
  const y = Math.floor((height - h) / 2);
  canvas.fill(x, y, w, h, { bg: palette.panelAlt, fg: palette.text });
  canvas.box(x, y, w, h, {
    border: motion ? pulse(palette.accent, time / 700, 0.3) : palette.accent,
    bg: palette.panelAlt,
    title: t(language, 'finderTitle'),
    titleColor: palette.accent,
    double: true,
  });
  const countText = ` ${items.length} `;
  canvas.put(x + w - 1 - textWidth(countText), y, countText, {
    fg: palette.faint, bg: palette.panelAlt,
  });
  const filterLabel = t(language, 'switcherFilter');
  const filterRow = y + 1;
  canvas.fill(x + 1, filterRow, w - 2, 1, { bg: palette.selection, fg: palette.text });
  rich(canvas, x + 2, filterRow, w - 4, [
    [`/ ${filterLabel} `, { fg: palette.faint }],
    [query || ' ', { fg: palette.white, bold: Boolean(query) }],
    [query ? '' : '▏', { fg: palette.accent }],
  ], palette, palette.selection);
  hitboxes.switcherPanel = { x, y, w, h };
  hitboxes.switcherFilter = { x: x + 1, y: filterRow, w: w - 2, h: 1 };
  hitboxes.switcher = new Map();

  const listTop = y + 2;
  const listBottom = y + h - 2;
  const viewport = Math.max(1, listBottom - listTop);
  const rows = [];
  let lastKind;
  for (const item of items) {
    if (item.kind !== lastKind) {
      rows.push({
        header: item.kind === 'run' ? t(language, 'switcherRuns')
          : item.kind === 'node' ? t(language, 'switcherNodes')
            : t(language, 'switcherTasks'),
      });
      lastKind = item.kind;
    }
    rows.push({ item });
  }
  const activeRow = Math.max(0, rows.findIndex(row => row.item?.key === activeKey));
  const maxScroll = Math.max(0, rows.length - viewport);
  const offset = clamp(activeRow - Math.floor(viewport / 2), 0, maxScroll);
  if (!items.length) {
    rich(canvas, x + 3, listTop, w - 6, [
      [t(language, 'switcherEmpty'), { fg: palette.faint, dim: true }],
    ], palette, palette.panelAlt);
  }
  let row = listTop;
  for (const entry of rows.slice(offset, offset + viewport)) {
    if (row >= listBottom) break;
    if (entry.header !== undefined) {
      rich(canvas, x + 2, row, w - 4, [
        [entry.header, { fg: palette.accent2, bold: true }],
        [' ', { fg: palette.faint }],
        ['─'.repeat(Math.max(0, w - textWidth(entry.header) - 5)), { fg: palette.border }],
      ], palette, palette.panelAlt);
      row++;
      continue;
    }
    const { item } = entry;
    const selected = item.key === activeKey;
    if (selected) canvas.fill(x + 1, row, w - 2, 1, { bg: palette.selection, fg: palette.text });
    const bg = selected ? palette.selection : palette.panelAlt;
    const itemColor = statusColor(palette, item.status);
    const detail = item.detail ? fit(item.detail, Math.max(8, Math.floor(w * 0.32))) : '';
    const labelWidth = Math.max(10, w - 10 - (detail ? textWidth(detail) + 2 : 0));
    rich(canvas, x + 2, row, w - 4, [
      [`${selected ? '▸' : ' '} `, { fg: selected ? palette.accent : palette.faint, bold: selected }],
      [`${statusIcon(item.status)} `, { fg: itemColor, bold: true }],
      [fit(item.label, labelWidth), { fg: selected ? palette.white : palette.text, bold: selected }],
      ...(detail ? [[`  ${detail}`, { fg: palette.faint }]] : []),
    ], palette, bg);
    hitboxes.switcher.set(item.key, { x: x + 1, y: row, w: w - 2, h: 1 });
    row++;
  }
  rich(canvas, x + 3, y + h - 2, w - 6, [
    [t(language, 'finderHint'), { fg: palette.faint, dim: true }],
  ], palette, palette.panelAlt);
  return { items, activeKey };
}

export function renderPalette(canvas, width, height, ui, { palette, time, motion, language }, hitboxes) {
  const items = filterCommands(commandItems(language), ui.paletteFilter);
  const activeIndex = items.length ? clamp(ui.paletteIndex ?? 0, 0, items.length - 1) : 0;
  canvas.fadeRect(0, 0, width, height, 0.58, palette.bg);
  const w = Math.min(64, width - 4);
  const h = Math.min(22, Math.max(10, height - 4));
  const x = Math.floor((width - w) / 2);
  const y = Math.floor((height - h) / 2);
  canvas.fill(x, y, w, h, { bg: palette.panelAlt, fg: palette.text });
  canvas.box(x, y, w, h, {
    border: motion ? pulse(palette.accent, time / 700, 0.3) : palette.accent,
    bg: palette.panelAlt,
    title: t(language, 'paletteTitle'),
    titleColor: palette.accent,
    double: true,
  });
  const countText = ` ${items.length} `;
  canvas.put(x + w - 1 - textWidth(countText), y, countText, { fg: palette.faint, bg: palette.panelAlt });
  const filterRow = y + 1;
  canvas.fill(x + 1, filterRow, w - 2, 1, { bg: palette.selection, fg: palette.text });
  rich(canvas, x + 2, filterRow, w - 4, [
    [': ', { fg: palette.accent }],
    [ui.paletteFilter || t(language, 'paletteFilter'), {
      fg: ui.paletteFilter ? palette.white : palette.faint,
      bold: Boolean(ui.paletteFilter),
    }],
  ], palette, palette.selection);
  hitboxes.palettePanel = { x, y, w, h };
  hitboxes.paletteFilter = { x: x + 1, y: filterRow, w: w - 2, h: 1 };
  hitboxes.palette = new Map();
  const listTop = y + 2;
  const listBottom = y + h - 2;
  const viewport = Math.max(1, listBottom - listTop);
  if (!items.length) {
    rich(canvas, x + 3, listTop, w - 6, [[t(language, 'paletteEmpty'), { fg: palette.faint, dim: true }]], palette, palette.panelAlt);
  }
  const offset = clamp(activeIndex - Math.floor(viewport / 2), 0, Math.max(0, items.length - viewport));
  let row = listTop;
  for (const item of items.slice(offset, offset + viewport)) {
    if (row >= listBottom) break;
    const selected = item.id === items[activeIndex]?.id;
    if (selected) canvas.fill(x + 1, row, w - 2, 1, { bg: palette.selection, fg: palette.text });
    const bg = selected ? palette.selection : palette.panelAlt;
    rich(canvas, x + 2, row, w - 4, [
      [`${selected ? '▸' : ' '} `, { fg: selected ? palette.accent : palette.faint, bold: selected }],
      [fit(item.label, w - 8), { fg: selected ? palette.white : palette.text, bold: selected }],
    ], palette, bg);
    hitboxes.palette.set(item.id, { x: x + 1, y: row, w: w - 2, h: 1 });
    row++;
  }
  rich(canvas, x + 3, y + h - 2, w - 6, [[t(language, 'paletteHint'), { fg: palette.faint, dim: true }]], palette, palette.panelAlt);
  return { items, activeIndex };
}

function renderTour(canvas, width, height, ui, { palette, language }, hitboxes) {
  const step = clamp(ui.tour ?? 1, 1, 5);
  const steps = [
    t(language, 'tourStep1'),
    t(language, 'tourStep2'),
    t(language, 'tourStep3'),
    t(language, 'tourStep4'),
    t(language, 'tourStep5'),
  ];
  canvas.fadeRect(0, 0, width, height, 0.45, palette.bg);
  const w = Math.min(58, width - 4);
  const h = 8;
  const x = Math.floor((width - w) / 2);
  const y = Math.max(2, height - h - 3);
  canvas.fill(x, y, w, h, { bg: palette.panelAlt, fg: palette.text });
  canvas.box(x, y, w, h, {
    border: palette.accent,
    bg: palette.panelAlt,
    title: t(language, 'tourTitle'),
    titleColor: palette.accent,
    double: true,
  });
  const count = ` ${step}/5 `;
  canvas.put(x + w - 1 - textWidth(count), y, count, { fg: palette.faint, bg: palette.panelAlt });
  let row = y + 2;
  for (const line of wrap(steps[step - 1], w - 6).slice(0, 3)) {
    rich(canvas, x + 3, row, w - 6, [[line, { fg: palette.text }]], palette, palette.panelAlt);
    row++;
  }
  rich(canvas, x + 3, y + h - 2, w - 6, [[t(language, 'tourNext'), { fg: palette.faint, dim: true }]], palette, palette.panelAlt);
  hitboxes.tourPanel = { x, y, w, h };
}

export {
  renderHelp, renderSettingsMenu, renderSwitcher, renderTour,
};
