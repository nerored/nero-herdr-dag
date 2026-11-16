// The viewer keymap: readline spellings, one movement normalizer, and the
// ordered tables that decide which modal or global action owns a key.
//
// readline reports one physical key twice: as its terminal sequence (\x1b[A)
// and as a name (up); embedders and tests may pass only the text. `keyToken`
// keeps the spelling handleKey has always used and every matcher accepts all
// three, so dispatch never depends on which one survived.
//
// The tables are data because order IS the specification:
//   MODAL_ORDER    switcher, palette, tour, help, settings - first active wins
//   GLOBAL_KEYMAP  the documented keys, in their historical precedence order
// A matcher returns undefined for "not mine"; every other value (including
// false or 0) is an action payload. `matchingKeys` yields each applicable row
// so an action that declines - keyboard scrolling outside a painted region -
// can fall through to the rows below it.
//
// This module is pure: the viewer owns every side effect and maps an action id
// to its handler.

import { clamp } from './text.mjs';

export function keyToken(text, pressed) {
  return pressed?.sequence || pressed?.name || text;
}

export function isEscapeKey(key, pressed) {
  return key === '\x1b' || key === 'escape' || pressed?.name === 'escape';
}

export function isBackspaceKey(key, pressed) {
  return key === '\x7f' || key === '\b' || pressed?.name === 'backspace';
}

export function isEnterKey(key, pressed) {
  return key === '\r' || key === '\n' || pressed?.name === 'return' || pressed?.name === 'enter';
}

export function isPrintableKey(key) {
  return typeof key === 'string' && key.length === 1 && key.charCodeAt(0) >= 32 && key !== '\x7f';
}

export function isQuitKey(key) {
  return key === 'q' || key === '\x03' || key === '\x04';
}

// DECCKM (application cursor) terminals report the arrows as \x1bOA/\x1bOB and
// Home/End as \x1bOH/\x1bOF. readline dispatches the sequence before the name,
// so one normalizer must accept both spellings of all six movement keys plus
// the vim aliases every list has always accepted.
const MOVEMENT_SEQUENCES = new Map([
  ['\x1b[A', 'up'], ['\x1bOA', 'up'], ['k', 'up'],
  ['\x1b[B', 'down'], ['\x1bOB', 'down'], ['j', 'down'],
  ['\x1b[5~', 'pageup'], ['\x1b[6~', 'pagedown'],
  ['\x1b[H', 'home'], ['\x1b[1~', 'home'], ['\x1bOH', 'home'],
  ['\x1b[F', 'end'], ['\x1b[4~', 'end'], ['\x1bOF', 'end'],
]);

const MOVEMENT_NAMES = new Set(['up', 'down', 'pageup', 'pagedown', 'home', 'end']);

export function movementKey(key, pressed) {
  if (typeof key === 'string') {
    const sequence = MOVEMENT_SEQUENCES.get(key);
    if (sequence) return sequence;
    const lower = key.toLowerCase();
    if (MOVEMENT_NAMES.has(lower)) return lower;
  }
  const name = typeof pressed?.name === 'string' ? pressed.name.toLowerCase() : '';
  return MOVEMENT_NAMES.has(name) ? name : null;
}

// ---------------------------------------------------------------------------
// Shared edge vocabulary
// ---------------------------------------------------------------------------

// N3 duty focus contract. 1/2/3 request the RUNS, CELLS, and DUTY regions;
// 4 requests the TASKS list of orphan navigation tasks. The structural class
// decides which focus value is actually meaningful. The renderer paints
// runs/cells/tasks/details focus in duty, while investigation falls back to the
// panes that are painted there (tasks/graph/details).
export const DUTY_FOCUS_KEYS = Object.freeze({
  '1': 'runs', '2': 'cells', '3': 'details', '4': 'tasks',
});

export function dutyFocusForKey(key) {
  return DUTY_FOCUS_KEYS[key];
}

export function settingsHotkey(key) {
  return key === 's';
}

// ---------------------------------------------------------------------------
// Help geometry and scrolling
// ---------------------------------------------------------------------------

// N4 Help geometry mirrors renderHelp exactly: the modal is
// min(26, height - 3) rows tall, its list starts two rows below the title and
// stops before the pinned data line. Keep this in sync with renderHelp's row
// budget. The renderer clamps the painted slice; this viewport bounds End/G so
// the last documented row (q) is reachable and never publishes a scroll offset
// the frame cannot show.

export const HELP_ROWS = 32;

export const HELP_MAX_ROWS = 36;

export function helpViewportRows(height) {
  const h = Math.min(HELP_MAX_ROWS, Math.max(1, Math.floor(Number(height) || 0) - 3));
  return Math.max(1, h - 4);
}

export function helpScrollMetrics(height, { rows = HELP_ROWS } = {}) {
  const viewport = helpViewportRows(height);
  return { rows, viewport, maxScroll: Math.max(0, rows - Math.max(1, viewport)) };
}

export function helpScrollForKey(key, pressed, { viewport = 1, rows = HELP_ROWS } = {}) {
  const maxScroll = Math.max(0, rows - Math.max(1, viewport));
  const page = Math.max(1, viewport - 1);
  switch (movementKey(key, pressed)) {
    case 'up': return -1;
    case 'down': return 1;
    case 'pageup': return -page;
    case 'pagedown': return page;
    case 'home': return -maxScroll;
    case 'end': return maxScroll;
    default: break;
  }
  // Help documents g/G as Home/End; no other list claims those letters.
  if (key === 'g') return -maxScroll;
  if (key === 'G') return maxScroll;
  return undefined;
}

export function applyHelpScroll(ui, key, pressed, metrics = {}) {
  const { viewport = 1, rows = HELP_ROWS } = metrics;
  const delta = helpScrollForKey(key, pressed, { viewport, rows });
  if (delta === undefined) return false;
  const maxScroll = Math.max(0, rows - Math.max(1, viewport));
  ui.helpScroll = clamp((ui.helpScroll ?? 0) + delta, 0, maxScroll);
  return true;
}

export function helpKeyAction(key, pressed, metrics = {}) {
  if (key === '?' || isEscapeKey(key, pressed)) return 'close';
  return helpScrollForKey(key, pressed, metrics) === undefined ? 'blocked' : 'scroll';
}

// ---------------------------------------------------------------------------
// Ordered modal dispatch
// ---------------------------------------------------------------------------

// An open modal owns every key: the first active row wins and its handler
// consumes the key, so a background action never fires underneath an overlay.
// Escape while Help or Settings is open is handled by the caller before the
// close/pointer debounce, because dismissal must not feel laggy.
//
// Settings is the one overlay that has always let the quit keys through: q,
// Ctrl-C and Ctrl-D exit while the menu is open instead of being swallowed.
export const MODAL_ORDER = Object.freeze([
  { id: 'switcher', active: ui => Boolean(ui.switcher) },
  { id: 'palette', active: ui => Boolean(ui.palette) },
  { id: 'tour', active: ui => Boolean(ui.tour) },
  { id: 'help', active: ui => Boolean(ui.help) },
  {
    id: 'settings',
    active: ui => Boolean(ui.settingsMenu),
    preemptedBy: key => isQuitKey(key),
  },
]);

// ---------------------------------------------------------------------------
// Table resolution
// ---------------------------------------------------------------------------

export function *matchingKeys(table, key, pressed, { ui, context } = {}) {
  for (const entry of table) {
    if (entry.when && !entry.when(ui, context)) continue;
    const value = entry.match(key, pressed, ui, context);
    if (value === undefined) continue;
    yield { id: entry.id, value };
  }
}

export function resolveKey(table, key, pressed, options) {
  for (const hit of matchingKeys(table, key, pressed, options)) return hit;
  return null;
}

// ---------------------------------------------------------------------------
// Modal key tables
// ---------------------------------------------------------------------------

const SWITCHER_EDGE = 9999;

export const SWITCHER_KEYMAP = Object.freeze([
  { id: 'quit', match: key => (key === '\x03' ? true : undefined) },
  { id: 'close', match: (key, pressed) => (isEscapeKey(key, pressed) || key === 'v' ? true : undefined) },
  {
    id: 'move',
    match: (key, pressed) => {
      const movement = movementKey(key, pressed);
      if (!movement) return undefined;
      return {
        up: -1, down: 1, pageup: -8, pagedown: 8, home: -SWITCHER_EDGE, end: SWITCHER_EDGE,
      }[movement];
    },
  },
  { id: 'confirm', match: (key, pressed) => (isEnterKey(key, pressed) ? true : undefined) },
  { id: 'backspace', match: (key, pressed) => (isBackspaceKey(key, pressed) ? true : undefined) },
  { id: 'clearQuery', match: key => (key === '\x15' ? true : undefined) },
  { id: 'ignore', match: key => (key === '/' ? true : undefined) },
  { id: 'type', match: key => (isPrintableKey(key) ? key : undefined) },
]);

export const PALETTE_KEYMAP = Object.freeze([
  { id: 'close', match: (key, pressed) => (isEscapeKey(key, pressed) || key === ':' ? true : undefined) },
  {
    id: 'move',
    match: (key, pressed) => {
      const movement = movementKey(key, pressed);
      if (movement === 'up') return -1;
      if (movement === 'down') return 1;
      // The palette has no page/home/end rows: those keys are consumed no-ops.
      return undefined;
    },
  },
  { id: 'confirm', match: (key, pressed) => (isEnterKey(key, pressed) ? true : undefined) },
  { id: 'backspace', match: (key, pressed) => (isBackspaceKey(key, pressed) ? true : undefined) },
  { id: 'type', match: key => (isPrintableKey(key) ? key : undefined) },
]);

export const TOUR_KEYMAP = Object.freeze([
  { id: 'close', match: (key, pressed) => (isEscapeKey(key, pressed) ? true : undefined) },
  { id: 'advance', match: (key, pressed) => (key === ' ' || isEnterKey(key, pressed) ? true : undefined) },
]);

export const SETTINGS_KEYMAP = Object.freeze([
  { id: 'close', match: key => (settingsHotkey(key) ? true : undefined) },
  {
    id: 'cycle',
    match: (key, pressed) => {
      if (key === 'Tab' || pressed?.name === 'tab') return pressed?.shift ? -1 : 1;
      const movement = movementKey(key, pressed);
      if (movement === 'up') return -1;
      if (movement === 'down') return 1;
      if (key === '\x1b[D' || pressed?.name === 'left') return -1;
      if (key === '\x1b[C' || pressed?.name === 'right') return 1;
      return undefined;
    },
  },
  {
    id: 'apply',
    match: (key, pressed) => (key === ' ' || isEnterKey(key, pressed) ? true : undefined),
  },
]);

// ---------------------------------------------------------------------------
// Global key table
// ---------------------------------------------------------------------------

const DIAGNOSIS_KEYS = new Set(['c', 'p', 'o']);

export const GLOBAL_KEYMAP = Object.freeze([
  { id: 'quit', match: key => (isQuitKey(key) ? true : undefined) },
  {
    id: 'escape',
    match: (key, pressed) => (isEscapeKey(key, pressed) ? true : undefined),
  },
  {
    id: 'runOverviewBack',
    when: ui => !ui.runOverview,
    match: (key, pressed) => (isBackspaceKey(key, pressed) ? true : undefined),
  },
  {
    id: 'graphFilter',
    when: ui => Boolean(ui.runOverview),
    match: key => (/^[1-5]$/.test(key) ? Number(key) - 1 : undefined),
  },
  { id: 'focusNode', match: key => (key === 'z' ? true : undefined) },
  {
    id: 'stepNode',
    when: ui => ui.focus === 'graph' || ui.focus === 'cells',
    match: key => (key === 'n' ? 1 : key === 'N' ? -1 : undefined),
  },
  { id: 'undo', match: key => (key === 'u' ? true : undefined) },
  { id: 'palette', match: key => (key === ':' ? true : undefined) },
  { id: 'help', match: key => (key === '?' ? true : undefined) },
  { id: 'settings', match: key => (settingsHotkey(key) ? true : undefined) },
  { id: 'mouseCapture', match: key => (key === 'm' ? true : undefined) },
  { id: 'clearCompleted', match: key => (key === 'x' ? true : undefined) },
  { id: 'restoreHidden', match: key => (key === 'X' ? true : undefined) },
  { id: 'sidebar', match: key => (key === 'S' ? true : undefined) },
  { id: 'follow', match: key => (key === 'f' ? true : undefined) },
  {
    id: 'demoReset',
    when: (_ui, context) => Boolean(context.demoMode),
    match: key => (key === 'r' ? true : undefined),
  },
  { id: 'verbose', match: key => (key === 'd' ? true : undefined) },
  {
    id: 'dutyFocus',
    match: key => {
      const focus = dutyFocusForKey(key);
      return focus ? { focus } : undefined;
    },
  },
  { id: 'diagnosis', match: key => (DIAGNOSIS_KEYS.has(key) ? key : undefined) },
  { id: 'expand', match: key => (key === 'e' ? true : undefined) },
  {
    id: 'switcher',
    when: ui => !ui.help,
    match: key => (key === 'v' || key === '/' ? true : undefined),
  },
  { id: 'completed', match: key => (key === 'T' ? true : undefined) },
  { id: 'taskScope', match: key => (key === 't' ? true : undefined) },
  {
    id: 'cycle',
    match: (key, pressed) => {
      if (key === 'Tab' || pressed?.name === 'tab') return pressed?.shift ? -1 : 1;
      return key === '\x1b[Z' ? -1 : undefined;
    },
  },
  {
    id: 'switchRun',
    match: key => (key === '\x1b[C' ? 1 : key === '\x1b[D' ? -1 : undefined),
  },
  {
    // Movement is the last fallback and reads the focused region, so it must
    // leave the keys owned by the details rows below it alone.
    id: 'keyboardScroll',
    match: (key, pressed) => (
      isEnterKey(key, pressed) || key === ' ' || key === '[' || key === ']' ? undefined : true
    ),
  },
  {
    id: 'detailsSection',
    when: ui => ui.focus === 'details',
    match: key => (key === ']' ? 1 : key === '[' ? -1 : undefined),
  },
  {
    id: 'detailsToggle',
    when: ui => ui.focus === 'details',
    match: (key, pressed) => (isEnterKey(key, pressed) ? true : undefined),
  },
  {
    id: 'fold',
    match: key => (key === ' ' || key === '\r' || key === '\n' ? true : undefined),
  },
]);
