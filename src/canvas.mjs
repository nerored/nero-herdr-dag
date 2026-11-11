import { charWidth, fit, segments } from './text.mjs';
import { parseHex, rgbToHex } from './theme.mjs';

const BOLD = 1;
const DIM = 2;
const ITALIC = 4;
const UNDERLINE = 8;

function normalizeStyle(style = {}, defaults) {
  return {
    fg: style.fg ?? defaults.fg,
    bg: style.bg ?? defaults.bg,
    flags: (style.bold ? BOLD : 0) | (style.dim ? DIM : 0) |
      (style.italic ? ITALIC : 0) | (style.underline ? UNDERLINE : 0),
  };
}

function sameStyle(a, b) {
  return a.fg === b.fg && a.bg === b.bg && a.flags === b.flags;
}

export class Canvas {
  constructor(width, height, { fg = '#ffffff', bg = '#000000' } = {}) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.defaults = { fg, bg };
    this.cells = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => ({
        ch: ' ', fg, bg, flags: 0, cont: false, width: 1,
      })));
  }

  cell(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const column = Math.floor(x);
    const row = Math.floor(y);
    if (column < 0 || row < 0 || column >= this.width || row >= this.height) return null;
    return this.cells[row][column];
  }

  // Wide glyphs own two cells: a head (width 2) and a continuation (cont).
  // Before a mutation lands on either half, clear the other half so a row can
  // never keep a stale continuation or an orphaned head.
  repair(x, y) {
    const cell = this.cell(x, y);
    if (!cell) return null;
    if (cell.cont) {
      const head = this.cell(x - 1, y);
      if (head && head.width === 2) {
        head.ch = ' ';
        head.width = 1;
        head.cont = false;
      }
      cell.ch = ' ';
      cell.width = 1;
      cell.cont = false;
    }
    if (cell.width === 2) {
      const next = this.cell(x + 1, y);
      if (next && next.cont) {
        next.ch = ' ';
        next.width = 1;
        next.cont = false;
      }
    }
    return cell;
  }

  put(x, y, text, style = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return x;
    const resolved = normalizeStyle(style, this.defaults);
    let cursor = x;
    for (const segment of segments(text)) {
      const size = charWidth(segment);
      if (size === 0) continue;
      if (cursor + size > this.width) break;
      if (cursor < 0) { cursor += size; continue; }
      const cell = this.repair(cursor, y);
      if (!cell) break;
      if (size === 2) {
        const next = this.repair(cursor + 1, y);
        if (!next) break;
        cell.ch = segment;
        cell.width = 2;
        cell.cont = false;
        cell.fg = resolved.fg;
        cell.bg = resolved.bg;
        cell.flags = resolved.flags;
        next.ch = '';
        next.width = 0;
        next.cont = true;
        next.fg = resolved.fg;
        next.bg = resolved.bg;
        next.flags = resolved.flags;
      } else {
        cell.ch = segment;
        cell.width = 1;
        cell.cont = false;
        cell.fg = resolved.fg;
        cell.bg = resolved.bg;
        cell.flags = resolved.flags;
      }
      cursor += size;
    }
    return cursor;
  }

  fill(x, y, w, h, style = {}) {
    const resolved = normalizeStyle(style, this.defaults);
    for (let row = 0; row < h; row++) {
      for (let column = 0; column < w; column++) {
        const cell = this.repair(x + column, y + row);
        if (!cell) continue;
        cell.ch = ' ';
        cell.width = 1;
        cell.cont = false;
        cell.fg = resolved.fg;
        cell.bg = resolved.bg;
        cell.flags = resolved.flags;
      }
    }
  }

  hline(x, y, length, style = {}) {
    this.put(x, y, '─'.repeat(Math.max(0, length)), style);
  }

  vline(x, y, length, style = {}) {
    for (let index = 0; index < length; index++) this.put(x, y + index, '│', style);
  }

  frame(x, y, w, h, { border = '#334155', bg, title, titleColor, double = false, dim = false } = {}) {
    if (w < 2 || h < 2) return;
    const style = { fg: border, bg, dim };
    const corners = double
      ? { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' }
      : { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
    this.put(x, y, corners.tl, style);
    this.put(x + w - 1, y, corners.tr, style);
    this.put(x, y + h - 1, corners.bl, style);
    this.put(x + w - 1, y + h - 1, corners.br, style);
    for (let column = 1; column < w - 1; column++) {
      this.put(x + column, y, corners.h, style);
      this.put(x + column, y + h - 1, corners.h, style);
    }
    for (let row = 1; row < h - 1; row++) {
      this.put(x, y + row, corners.v, style);
      this.put(x + w - 1, y + row, corners.v, style);
    }
    if (title) {
      const room = Math.max(0, w - 4);
      this.put(x + 2, y, fit(` ${title} `, room), { fg: titleColor ?? border, bg, bold: true });
    }
  }

  box(x, y, w, h, options = {}) {
    if (w < 2 || h < 2) return;
    this.fill(x, y, w, h, { bg: options.bg, fg: options.border });
    this.frame(x, y, w, h, options);
  }

  blit(source, dx, dy, clip = { x: 0, y: 0, w: this.width, h: this.height }) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const baseX = Math.floor(dx);
    const baseY = Math.floor(dy);
    for (let sy = 0; sy < source.height; sy++) {
      for (let sx = 0; sx < source.width; sx++) {
        const src = source.cells[sy][sx];
        if (src.cont) continue;
        const tx = baseX + sx;
        const ty = baseY + sy;
        if (tx < clip.x || ty < clip.y || tx >= clip.x + clip.w || ty >= clip.y + clip.h) continue;
        if (src.width === 2 && (tx + 1 >= clip.x + clip.w || tx + 1 >= this.width)) continue;
        const dst = this.repair(tx, ty);
        if (!dst) continue;
        const next = src.width === 2 ? this.repair(tx + 1, ty) : null;
        if (src.width === 2 && !next) continue;
        dst.ch = src.ch;
        dst.width = src.width;
        dst.cont = false;
        dst.fg = src.fg;
        dst.bg = src.bg;
        dst.flags = src.flags;
        if (next) {
          next.ch = '';
          next.width = 0;
          next.cont = true;
          next.fg = src.fg;
          next.bg = src.bg;
          next.flags = src.flags;
        }
      }
    }
  }

  fadeRect(x, y, w, h, amount = 0.55, to = '#000000') {
    if (to === '') {
      // Default-colored surfaces cannot be blended without painting an opaque
      // background, so dim the existing cells and keep terminal transparency.
      for (let row = 0; row < h; row++) {
        for (let column = 0; column < w; column++) {
          const cell = this.cell(x + column, y + row);
          if (!cell || cell.cont) continue;
          cell.flags |= DIM;
        }
      }
      return;
    }
    const target = parseHex(to);
    // A malformed target has no defined blend; leave the cells alone instead
    // of inventing a fallback color.
    if (!target) return;
    const [tr, tg, tb] = target;
    for (let row = 0; row < h; row++) {
      for (let column = 0; column < w; column++) {
        const cell = this.cell(x + column, y + row);
        if (!cell || cell.cont) continue;
        // `''` is the terminal-default sentinel: it has no RGB value, so a
        // default-colored channel keeps its sentinel rather than becoming an
        // opaque approximation.
        const fromFg = parseHex(cell.fg);
        const fromBg = parseHex(cell.bg);
        if (fromFg) {
          cell.fg = rgbToHex([
            fromFg[0] + (tr - fromFg[0]) * amount,
            fromFg[1] + (tg - fromFg[1]) * amount,
            fromFg[2] + (tb - fromFg[2]) * amount,
          ]);
        }
        if (fromBg) {
          cell.bg = rgbToHex([
            fromBg[0] + (tr - fromBg[0]) * amount,
            fromBg[1] + (tg - fromBg[1]) * amount,
            fromBg[2] + (tb - fromBg[2]) * amount,
          ]);
        }
      }
    }
  }

  toString(theme) {
    const lines = [];
    for (const row of this.cells) {
      let line = '';
      let current = null;
      let span = '';
      const flush = () => {
        if (!span) return;
        if (!theme.color) { line += span; span = ''; return; }
        line += '\x1b[0m';
        line += theme.ansiFg(current.fg);
        line += theme.ansiBg(current.bg);
        if (current.flags & BOLD) line += '\x1b[1m';
        if (current.flags & DIM) line += '\x1b[2m';
        if (current.flags & ITALIC) line += '\x1b[3m';
        if (current.flags & UNDERLINE) line += '\x1b[4m';
        line += span;
        span = '';
      };
      for (const cell of row) {
        if (cell.cont) continue;
        const style = { fg: cell.fg, bg: cell.bg, flags: cell.flags };
        if (!current || !sameStyle(current, style)) {
          flush();
          current = style;
        }
        span += cell.ch;
      }
      flush();
      if (theme.color) line += '\x1b[0m';
      lines.push(line);
    }
    return lines.join('\n');
  }
}

export { BOLD, DIM, ITALIC, UNDERLINE };
