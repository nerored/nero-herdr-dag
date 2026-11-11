import { segments } from './text.mjs';

// The built-in themes mirror OmO's theme set. Colors are resolved from OmO's
// bundled dark/light/grok-day/grok-night definitions, remapped onto the
// dashboard's palette tokens.
export const palettes = {
  dark: {
    name: 'dark',
    appearance: 'dark',
    bg: '#21252c',
    bgAlt: '#282c34',
    panel: '#282c34',
    panelAlt: '#1c1e1f',
    border: '#5fa8cc',
    borderHot: '#a08ed5',
    text: '#dee0e1',
    dim: '#a6aeb1',
    faint: '#9ca3a8',
    accent: '#a798d7',
    accent2: '#69add0',
    accent3: '#de8d5a',
    running: '#69add0',
    completed: '#68b78d',
    failed: '#ea7f81',
    blocked: '#cd9a22',
    pending: '#cd9a22',
    paused: '#9776e5',
    skipped: '#9ca3a8',
    selection: '#213b49',
    white: '#dee0e1',
    black: '#21252c',
    warn: '#cd9a22',
    good: '#68b78d',
    bad: '#ea7f81',
  },
  'grok-day': {
    name: 'grok-day',
    appearance: 'light',
    bg: '#f8f8f8',
    bgAlt: '#ffffff',
    panel: '#ffffff',
    panelAlt: '#e8e8f0',
    border: '#585858',
    borderHot: '#2f64d2',
    text: '#1f2328',
    dim: '#515151',
    faint: '#585858',
    accent: '#2f64d2',
    accent2: '#547da7',
    accent3: '#a31515',
    running: '#547da7',
    completed: '#0c947c',
    failed: '#cd3048',
    blocked: '#9a7326',
    pending: '#9a7326',
    paused: '#875f87',
    skipped: '#585858',
    selection: '#d0d0e0',
    white: '#1f2328',
    black: '#1f2328',
    warn: '#9a7326',
    good: '#0c947c',
    bad: '#cd3048',
  },
  'grok-night': {
    name: 'grok-night',
    appearance: 'dark',
    bg: '#141414',
    bgAlt: '#111111',
    panel: '#111111',
    panelAlt: '#282832',
    border: '#585858',
    borderHot: '#505058',
    text: '#e1e1e1',
    dim: '#aaaaaa',
    faint: '#a0a0a0',
    accent: '#7aa2f7',
    accent2: '#3a95ab',
    accent3: '#ce9178',
    running: '#3a95ab',
    completed: '#9ece6a',
    failed: '#f7768e',
    blocked: '#e0af68',
    pending: '#e0af68',
    paused: '#b294bb',
    skipped: '#a0a0a0',
    selection: '#363636',
    white: '#e1e1e1',
    black: '#141414',
    warn: '#e0af68',
    good: '#9ece6a',
    bad: '#f7768e',
  },
  light: {
    name: 'light',
    appearance: 'light',
    bg: '#efeeee',
    bgAlt: '#f7f6f6',
    panel: '#f7f6f6',
    panelAlt: '#eaebec',
    border: '#3d8eb3',
    borderHot: '#8a72cb',
    text: '#3b3f41',
    dim: '#575f64',
    faint: '#60676a',
    accent: '#7459b4',
    accent2: '#2f7899',
    accent3: '#a45417',
    running: '#2f7899',
    completed: '#337e58',
    failed: '#c8253d',
    blocked: '#8f6802',
    pending: '#8f6802',
    paused: '#b5a5e8',
    skipped: '#60676a',
    selection: '#dfe7ec',
    white: '#3b3f41',
    black: '#3b3f41',
    warn: '#8f6802',
    good: '#337e58',
    bad: '#c8253d',
  },
};

// OmO lists `system` first, then its built-ins alphabetically.
export const themeNames = ['system', 'dark', 'grok-day', 'grok-night', 'light'];
export const paletteNames = themeNames;

export function normalizeThemeName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return themeNames.includes(name) ? name : undefined;
}

// Mirrors OmO's fallback when the terminal does not report an appearance.
export function terminalAppearance(env = process.env) {
  const last = String(env.COLORFGBG ?? '').split(';').filter(Boolean).pop();
  if (last !== undefined) {
    const index = Number(last);
    if (Number.isFinite(index)) return index >= 7 ? 'light' : 'dark';
  }
  return 'dark';
}

// `system` follows the terminal's light/dark appearance, the way OmO's
// generated system theme does, using OmO's dark and light palettes. Page
// surfaces and body text stay at the terminal defaults (`''`) so the
// terminal's own background, including translucency, shows through.
export function paletteFor(name, { appearance = 'dark' } = {}) {
  const requested = normalizeThemeName(name) ?? 'dark';
  if (requested === 'system') {
    const base = palettes[appearance === 'light' ? 'light' : 'dark'];
    return {
      ...base,
      name: 'system',
      appearance,
      bg: '',
      bgAlt: '',
      panel: '',
      text: '',
      white: '',
    };
  }
  return { ...palettes[requested], name: requested };
}

export function paletteAt(index) {
  const names = themeNames;
  return paletteFor(names[((index % names.length) + names.length) % names.length]);
}

// Parses `#rrggbb` (or `rrggbb`) into RGB channels. Returns null for anything
// else, including the `''` default-color sentinel, so callers can distinguish
// "terminal default" from a malformed value instead of treating both as white.
export function parseHex(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value ?? ''));
  if (!match) return null;
  const number = Number.parseInt(match[1], 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

export function rgbToHex([r, g, b]) {
  const part = value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

// WCAG 2.1 relative luminance and contrast ratio. Metadata foregrounds must
// clear 4.5:1 against the surfaces they are drawn on.
export function relativeLuminance(color) {
  const rgb = parseHex(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(channel => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  if (first === null || second === null) return null;
  const [light, dark] = [first, second].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

export function mix(a, b, t) {
  const from = parseHex(a);
  const to = parseHex(b);
  // A default-color or malformed operand has no RGB value to blend; keep the
  // result as the terminal-default sentinel instead of deriving white.
  if (!from || !to) return '';
  const [ar, ag, ab] = from;
  const [br, bg, bb] = to;
  return rgbToHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]);
}

export function lighten(color, amount) {
  return mix(color, '#ffffff', amount);
}

export function darken(color, amount) {
  return mix(color, '#000000', amount);
}

export function pulse(color, t, amount = 0.35) {
  return mix(color, '#ffffff', 0.12 + (Math.sin(t) * 0.5 + 0.5) * amount);
}

export function supportsTruecolor(env = process.env) {
  const colorterm = String(env.COLORTERM ?? '').toLowerCase();
  const term = String(env.TERM ?? '').toLowerCase();
  return colorterm === 'truecolor' || colorterm === '24bit' ||
    term.includes('truecolor') || term.includes('direct') || Boolean(env.WT_SESSION);
}

export function createTheme({ palette = 'dark', color = true, truecolor = supportsTruecolor(), appearance = 'dark' } = {}) {
  // String names go through paletteFor so `system` resolves to the transparent
  // variant instead of silently falling back to the opaque dark palette.
  const selected = typeof palette === 'string' ? paletteFor(palette, { appearance }) : palette;
  return {
    palette: selected,
    color,
    truecolor,
    ansiFg(hex) {
      if (!color) return '';
      if (hex === '') return '\x1b[39m';
      const rgb = parseHex(hex);
      if (!rgb) return '';
      if (truecolor) {
        const [r, g, b] = rgb;
        return `\x1b[38;2;${r};${g};${b}m`;
      }
      return `\x1b[38;5;${rgbToAnsi256(rgb)}m`;
    },
    ansiBg(hex) {
      if (!color) return '';
      if (hex === '') return '\x1b[49m';
      const rgb = parseHex(hex);
      if (!rgb) return '';
      if (truecolor) {
        const [r, g, b] = rgb;
        return `\x1b[48;2;${r};${g};${b}m`;
      }
      return `\x1b[48;5;${rgbToAnsi256(rgb)}m`;
    },
  };
}

// xterm's 6x6x6 cube is not evenly spaced: the levels are 0, 95, 135, 175, 215,
// 255. Snap each channel to the nearest of those levels before composing the
// index so mid-range colors do not quantize a step brighter.
const ANSI_CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function nearestCubeLevel(channel) {
  const value = Number.isFinite(channel) ? Math.max(0, Math.min(255, channel)) : 0;
  let best = 0;
  for (let index = 1; index < ANSI_CUBE_LEVELS.length; index++) {
    if (Math.abs(value - ANSI_CUBE_LEVELS[index]) < Math.abs(value - ANSI_CUBE_LEVELS[best])) best = index;
  }
  return best;
}

export function rgbToAnsi256([r, g, b]) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * nearestCubeLevel(r) + 6 * nearestCubeLevel(g) + nearestCubeLevel(b);
}

export function statusColor(palette, status) {
  if (status === 'error') return palette.failed;
  if (status === 'interrupted' || status === 'lost') return palette.dim;
  return palette[status] ?? palette.dim;
}

export function statusIcon(status) {
  return {
    pending: '○',
    blocked: '◌',
    scheduled: '◷',
    running: '●',
    paused: 'Ⅱ',
    completed: '✓',
    failed: '×',
    cancelled: '−',
    skipped: '·',
    error: '×',
    interrupted: '−',
    lost: '?',
  }[status] ?? '○';
}

export function gradientCells(text, from, to, { shift = 0 } = {}) {
  const parts = segments(text);
  return parts.map((part, index) => {
    const t = parts.length <= 1 ? 0 : index / (parts.length - 1);
    const wave = (Math.sin((index * 0.55) + shift) * 0.5 + 0.5) * 0.18;
    return { text: part, color: mix(from, to, Math.min(1, Math.max(0, t + wave - 0.09))) };
  });
}
