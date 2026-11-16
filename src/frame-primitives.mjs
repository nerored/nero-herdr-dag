import { Canvas } from './canvas.mjs';
import { t } from './i18n.mjs';
import { contrastRatio } from './theme.mjs';
import { fit, width as textWidth } from './text.mjs';

// Reusable cell grids for one frame. The handle replaces the module-level
// `sharedGraphCanvas`/`scratchCanvases` singletons: the owner that creates it
// decides the lifetime, and every painter receives it explicitly. A handle
// created by renderApp lives for that frame; a caller that renders repeatedly
// (the viewer) may keep one handle and call reset() when the palette or the
// terminal geometry class changes.
export function createFrameBuffers() {
  const buffers = { graph: undefined, body: undefined, inner: undefined };
  // Drop every retained grid. Nothing is shared after this call, so a new
  // palette can never inherit a cell painted with the previous one.
  buffers.reset = () => {
    buffers.graph = undefined;
    buffers.body = undefined;
    buffers.inner = undefined;
  };
  return buffers;
}

// drawGraph owns a full-layout canvas. Reuse its cell objects between frames
// of the same dimensions and repaint every cell, instead of allocating a new
// width×height object grid on each frame.
export function graphCanvasFor(buffers, width, height, palette) {
  if (!buffers.graph || buffers.graph.width !== width || buffers.graph.height !== height) {
    buffers.graph = new Canvas(width, height, { fg: palette.text, bg: palette.panel });
  } else {
    buffers.graph.defaults = { fg: palette.text, bg: palette.panel };
    buffers.graph.fill(0, 0, width, height, { fg: palette.text, bg: palette.panel });
  }
  return buffers.graph;
}

// renderDetails/renderDuty measure by painting the whole body on a tall scratch
// canvas, then blit the visible window. Reuse the two cell grids across frames
// of the same dimensions and repaint every cell instead of allocating a new
// width×2048 object grid (and its cell objects) on every frame.
export function scratchCanvas(buffers, slot, width, height, palette) {
  const current = buffers[slot];
  if (!current || current.width !== width || current.height !== height) {
    buffers[slot] = new Canvas(width, height, { fg: palette.text, bg: palette.panel });
    return buffers[slot];
  }
  current.defaults = { fg: palette.text, bg: palette.panel };
  current.fill(0, 0, width, height, { fg: palette.text, bg: palette.panel });
  return current;
}

export function rich(canvas, x, y, width, parts, palette, bg) {
  let cursor = x;
  let left = width;
  for (const item of parts) {
    if (left <= 0) break;
    const part = Array.isArray(item) ? { text: item[0], ...(item[1] ?? {}) } : item;
    const source = String(part.text ?? '');
    const shown = textWidth(source) > left ? fit(source, left) : source;
    canvas.put(cursor, y, shown, {
      fg: part.fg ?? palette.text,
      bg: part.bg ?? bg,
      bold: part.bold,
      dim: part.dim,
      italic: part.italic,
    });
    const used = textWidth(shown);
    cursor += used;
    left -= used;
    if (textWidth(source) > used) break;
  }
}

export function panel(canvas, rect, title, { palette, focused = false, badge } = {}) {
  const badgeText = badge ? ` ${fit(badge, Math.max(1, Math.floor(rect.w * 0.45)))} ` : '';
  canvas.fill(rect.x, rect.y, rect.w, rect.h, { bg: palette.panel, fg: palette.text });
  canvas.box(rect.x, rect.y, rect.w, rect.h, {
    border: focused ? palette.borderHot : palette.border,
    bg: palette.panel,
    title: fit(title, Math.max(1, rect.w - 6 - textWidth(badgeText))),
    titleColor: focused ? palette.accent : palette.dim,
  });
  if (badgeText) {
    canvas.put(rect.x + rect.w - 1 - textWidth(badgeText), rect.y, badgeText, {
      fg: palette.dim, bg: palette.panel,
    });
  }
}

// Every status color has one of pure black or pure white above 4.5:1, so the
// pill foreground is chosen per background instead of assuming a dark theme.
// The WCAG math lives in theme.mjs; an unparseable/transparent surface has no
// ratio (theme returns null), and white is the established fallback there.
export function pillForeground(background) {
  const white = contrastRatio('#ffffff', background);
  const black = contrastRatio('#000000', background);
  if (white === null || black === null) return '#ffffff';
  return white >= black ? '#ffffff' : '#000000';
}

// Glyph + word + color stay redundant: the pill owns the word, the glyph is
// repeated beside it, and the background keeps carrying the color signal.
export function pill(canvas, x, y, label, color, glyph) {
  const text = ` ${glyph ? `${glyph} ` : ''}${label} `;
  canvas.put(x, y, text, { fg: pillForeground(color), bg: color, bold: true });
  return x + textWidth(text);
}

export function drawScrollbar(canvas, bar, palette) {
  if (!bar) return;
  for (let row = 0; row < bar.h; row++) {
    const y = bar.y + row;
    // A wide glyph's continuation cell owns this column; skip the decoration
    // rather than corrupt the frame width.
    if (canvas.cell(bar.x, y)?.cont) continue;
    const thumb = y >= bar.thumbTop && y < bar.thumbTop + bar.thumbH;
    canvas.put(bar.x, y, thumb ? '█' : '░', {
      fg: thumb ? palette.accent2 : palette.border,
      bg: palette.panel,
      dim: !thumb,
      bold: thumb,
    });
  }
}

export function formatNumber(value) {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  // 999,950 already rounds to 1.0m; the k branch must not print "1000.0k".
  if (magnitude >= 999_950) return `${(value / 1_000_000).toFixed(1)}m`;
  if (magnitude >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

// Rates are telemetry, not counts: a 0.4 tokens/s reading is not zero. Keep
// one decimal from 1 upward and two below it, trimming only trailing zeros.
export function formatRate(value) {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return formatNumber(value);
  if (magnitude >= 10) return String(Math.round(value));
  const text = value.toFixed(magnitude >= 1 ? 1 : 2);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

// Unknown telemetry is an em dash, never a fabricated zero.
export function metricValue(value) {
  return value === undefined ? '—' : formatNumber(value);
}

export function formatCost(value) {
  if (!Number.isFinite(value)) return undefined;
  return value.toFixed(Math.abs(value) < 0.1 ? 4 : 2);
}

export function detailSection(canvas, x, y, w, label, palette) {
  rich(canvas, x, y, w, [
    [label.toUpperCase(), { fg: palette.accent2, bold: true }],
    [' ', { fg: palette.faint }],
    ['─'.repeat(Math.max(0, w - textWidth(label) - 1)), { fg: palette.border }],
  ], palette, palette.panel);
  return y + 1;
}

export function detailLine(canvas, x, y, w, parts, palette) {
  rich(canvas, x, y, w, parts, palette, palette.panel);
  return y + 1;
}

// The metrics block is a small definition list: one shared label column keeps
// every value on the same cell column.
export function labelWidthFor(labels) {
  return Math.max(0, ...labels.map(textWidth)) + 1;
}

export function metricLabelWidth(language) {
  return labelWidthFor([
    t(language, 'tokens'),
    t(language, 'tokenRate'),
    t(language, 'cacheReuseShort'),
    t(language, 'retries'),
    t(language, 'turns'),
    t(language, 'tools'),
  ]);
}

export function metricValueX(x, w, labelWidth) {
  return x + Math.min(labelWidth, Math.max(1, w - 8));
}

export function metricValueWidth(w, labelWidth) {
  return Math.max(1, w - Math.min(labelWidth, Math.max(1, w - 8)));
}

export function metricRow(canvas, x, y, w, label, parts, palette, labelWidth) {
  const valueX = metricValueX(x, w, labelWidth);
  if (label) canvas.put(x, y, label, { fg: palette.faint });
  return detailLine(canvas, valueX, y, Math.max(1, x + w - valueX), parts, palette);
}

export function fixedBodyLines(canvas, x, y, w, count, lines, palette, style = {}) {
  const shown = (lines ?? []).slice(-count);
  for (let index = 0; index < count; index++) {
    const line = shown[index];
    if (line) {
      canvas.put(x, y, fit(line, w), {
        fg: style.fg ?? palette.text,
        bg: palette.panel,
        dim: style.dim,
      });
    } else {
      canvas.fill(x, y, w, 1, { fg: palette.text, bg: palette.panel });
    }
    y++;
  }
  return y;
}
