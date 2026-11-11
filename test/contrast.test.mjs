import { test } from 'node:test';
import assert from 'node:assert/strict';
import { palettes } from '../src/theme.mjs';

const hex = value => {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value ?? ''));
  if (!match) return undefined;
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const luminance = rgb => {
  const [r, g, b] = rgb.map(channel => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a, b) => {
  const la = luminance(hex(a));
  const lb = luminance(hex(b));
  if (!la || !lb) return 0;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

test('every theme keeps readable text, metadata, accent, and status contrasts', () => {
  const failures = [];
  for (const [name, palette] of Object.entries(palettes)) {
    const checks = [
      ['text', palette.text, 4.5],
      ['dim', palette.dim, 3],
      ['faint', palette.faint, 3],
      ['accent', palette.accent, 3],
      ['running', palette.running, 3],
      ['completed', palette.completed, 3],
      ['failed', palette.failed, 3],
      ['blocked', palette.blocked, 3],
      ['pending', palette.pending, 3],
      ['paused', palette.paused, 3],
    ];
    for (const [token, color, minimum] of checks) {
      const ratio = contrast(color, palette.bg);
      if (ratio + 1e-9 < minimum) {
        failures.push(`${name}.${token}: ${ratio.toFixed(2)} < ${minimum} (${color} on ${palette.bg})`);
      }
    }
    const selectedText = contrast(palette.white, palette.selection);
    if (selectedText + 1e-9 < 4.5) {
      failures.push(`${name}.selection: ${selectedText.toFixed(2)} < 4.5`);
    }
  }
  assert.deepEqual(failures, []);
});
