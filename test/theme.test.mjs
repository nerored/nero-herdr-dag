import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contrastRatio, createTheme, mix, palettes, paletteAt, paletteFor, paletteNames,
  normalizeThemeName, parseHex, relativeLuminance, rgbToAnsi256, statusColor,
  terminalAppearance, themeNames,
} from '../src/theme.mjs';

const MIN_CONTRAST = 4.5;

function effectivePanel(palette) {
  if (palette.panel) return palette.panel;
  return palettes[palette.appearance === 'light' ? 'light' : 'dark'].panel;
}

const TOKENS = [
  'bg', 'bgAlt', 'panel', 'panelAlt', 'border', 'borderHot', 'text', 'dim', 'faint',
  'accent', 'accent2', 'accent3', 'running', 'completed', 'failed', 'blocked',
  'pending', 'paused', 'skipped', 'selection', 'white', 'black', 'warn', 'good', 'bad',
];

test('the theme list matches the OmO built-ins with system first', () => {
  assert.deepEqual(themeNames, ['system', 'dark', 'grok-day', 'grok-night', 'light']);
});

test('named themes define a complete hex palette', () => {
  for (const name of themeNames.filter(candidate => candidate !== 'system')) {
    const palette = paletteFor(name);
    assert.equal(palette.name, name);
    for (const token of TOKENS) {
      assert.match(palette[token], /^#[0-9a-f]{6}$/i, `${name}.${token}`);
    }
  }
});

test('system leaves page surfaces and body text to the terminal', () => {
  for (const appearance of ['dark', 'light']) {
    const palette = paletteFor('system', { appearance });
    for (const token of ['bg', 'bgAlt', 'panel', 'text', 'white']) {
      assert.equal(palette[token], '', `system.${appearance}.${token}`);
    }
    // Selection and dialogs still need a concrete surface of their own.
    for (const token of ['selection', 'panelAlt', 'accent', 'completed', 'failed']) {
      assert.match(palette[token], /^#[0-9a-f]{6}$/i, `system.${appearance}.${token}`);
    }
  }
});

test('system follows the terminal appearance using the OmO palettes', () => {
  const dark = paletteFor('system', { appearance: 'dark' });
  const light = paletteFor('system', { appearance: 'light' });
  assert.equal(dark.name, 'system');
  assert.equal(dark.accent, palettes.dark.accent);
  assert.equal(light.accent, palettes.light.accent);
  assert.equal(dark.selection, palettes.dark.selection);
  assert.equal(paletteFor('system').accent, palettes.dark.accent);
});

test('theme names normalize and unknown values are rejected', () => {
  assert.equal(normalizeThemeName(' grok-night '), 'grok-night');
  assert.equal(normalizeThemeName('midnight'), undefined);
  assert.equal(normalizeThemeName(undefined), undefined);
  assert.equal(paletteAt(0).name, 'system');
  assert.equal(paletteAt(-1).name, 'light');
});

test('COLORFGBG decides the appearance fallback', () => {
  assert.equal(terminalAppearance({ COLORFGBG: '15;0' }), 'dark');
  assert.equal(terminalAppearance({ COLORFGBG: '0;15' }), 'light');
  assert.equal(terminalAppearance({}), 'dark');
});

test('essential metadata clears 4.5:1 on panel and selection in all five palettes', () => {
  assert.deepEqual(paletteNames, ['system', 'dark', 'grok-day', 'grok-night', 'light']);
  for (const name of paletteNames) {
    const appearances = name === 'system' ? ['dark', 'light'] : [undefined];
    for (const appearance of appearances) {
      const variant = `${name}${appearance ? ` (${appearance})` : ''}`;
      const palette = paletteFor(name, appearance ? { appearance } : {});
      const surfaces = [
        ['panel', effectivePanel(palette)],
        ['selection', palette.selection],
      ];
      for (const [surface, background] of surfaces) {
        const faint = contrastRatio(palette.faint, background);
        assert.ok(
          faint >= MIN_CONTRAST,
          `${variant} faint/${surface} is ${faint.toFixed(2)}:1; need ${MIN_CONTRAST}:1`,
        );
        // faint stays the subordinate tier: dim must remain at least as legible.
        const dim = contrastRatio(palette.dim, background);
        assert.ok(
          dim >= faint,
          `${variant} dim/${surface} (${dim.toFixed(2)}:1) must stay above faint (${faint.toFixed(2)}:1)`,
        );
      }
    }
  }
});

test('contrastRatio follows WCAG luminance and rejects sub-AA pairs', () => {
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
  // The pre-N6 grok-night faint/selection pair, kept as a failure baseline.
  assert.ok(contrastRatio('#585858', '#363636') < MIN_CONTRAST);
});

const STATUS_VALUES = [
  'pending', 'blocked', 'scheduled', 'running', 'paused', 'completed',
  'failed', 'cancelled', 'skipped', 'error', 'interrupted', 'lost',
];

test('every statusColor token is measured and skipped clears 4.5:1', () => {
  for (const name of paletteNames) {
    const appearances = name === 'system' ? ['dark', 'light'] : [undefined];
    for (const appearance of appearances) {
      const variant = `${name}${appearance ? ` (${appearance})` : ''}`;
      const palette = paletteFor(name, appearance ? { appearance } : {});
      const panel = effectivePanel(palette);
      for (const status of STATUS_VALUES) {
        const color = statusColor(palette, status);
        assert.match(color, /^#[0-9a-f]{6}$/i, `${variant} ${status}`);
        assert.equal(typeof contrastRatio(color, panel), 'number', `${variant} ${status}/panel`);
        assert.equal(typeof contrastRatio(color, palette.selection), 'number', `${variant} ${status}/selection`);
      }
      // skipped is painted as node-label text on both surfaces.
      const skippedPanel = contrastRatio(palette.skipped, panel);
      assert.ok(
        skippedPanel >= MIN_CONTRAST,
        `${variant} skipped/panel is ${skippedPanel.toFixed(2)}:1; need ${MIN_CONTRAST}:1`,
      );
      const skippedSelection = contrastRatio(palette.skipped, palette.selection);
      assert.ok(
        skippedSelection >= MIN_CONTRAST,
        `${variant} skipped/selection is ${skippedSelection.toFixed(2)}:1; need ${MIN_CONTRAST}:1`,
      );
    }
  }
});

test('parseHex distinguishes hex colors from the default-color sentinel', () => {
  assert.deepEqual(parseHex('#112233'), [17, 34, 51]);
  assert.deepEqual(parseHex('112233'), [17, 34, 51]);
  assert.equal(parseHex(''), null);
  assert.equal(parseHex('red'), null);
  assert.equal(parseHex('#fff'), null);
  assert.equal(parseHex(undefined), null);
});

test('color math preserves the default-color sentinel instead of white', () => {
  assert.equal(mix('', '#ffffff', 0.5), '');
  assert.equal(mix('#000000', '', 0.5), '');
  assert.equal(relativeLuminance(''), null);
  assert.equal(contrastRatio('', '#ffffff'), null);
  assert.equal(relativeLuminance('#000000'), 0);
});

test('createTheme resolves system through paletteFor', () => {
  const system = createTheme({ palette: 'system' });
  assert.equal(system.palette.name, 'system');
  assert.equal(system.palette.panel, '');
  assert.equal(system.palette.accent, palettes.dark.accent);

  const light = createTheme({ palette: 'system', appearance: 'light' });
  assert.equal(light.palette.accent, palettes.light.accent);

  assert.equal(createTheme({ palette: 'grok-night' }).palette.name, 'grok-night');
  assert.equal(createTheme({ palette: 'unknown' }).palette.name, 'dark');
});

test('rgbToAnsi256 snaps channels to the xterm cube levels', () => {
  // 100 is nearest the cube level 95, not 135.
  assert.equal(rgbToAnsi256([100, 0, 0]), 16 + 36 * 1);
  assert.equal(rgbToAnsi256([95, 0, 0]), 52);
  assert.equal(rgbToAnsi256([135, 0, 0]), 88);
  assert.equal(rgbToAnsi256([255, 0, 0]), 196);
  assert.equal(rgbToAnsi256([0, 255, 0]), 46);
  assert.equal(rgbToAnsi256([0, 0, 255]), 21);

  const fixed = createTheme({ palette: 'dark', color: true, truecolor: false });
  assert.equal(fixed.ansiFg('#640000'), '\x1b[38;5;52m');
  assert.equal(fixed.ansiFg(''), '\x1b[39m');
  assert.equal(fixed.ansiFg('bogus'), '');
});
