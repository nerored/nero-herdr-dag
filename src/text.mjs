import { stripVTControlCharacters } from 'node:util';
import { normalizeLanguage } from './i18n.mjs';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Format characters that occupy no terminal cell. They are dropped rather than
// replaced by a space so text measurement matches what the terminal paints.
function zeroWidthFormat(cp) {
  return cp === 0x00ad || cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    cp === 0xfeff || (cp >= 0xe0000 && cp <= 0xe007f);
}

export function clean(value) {
  const text = stripVTControlCharacters(String(value ?? ''));
  let out = '';
  for (const character of text) {
    const cp = character.codePointAt(0);
    if (zeroWidthFormat(cp)) continue;
    const forbidden = (cp >= 0 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f) ||
      (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
    out += forbidden ? ' ' : character;
  }
  return out;
}

export function segments(text) {
  return [...segmenter.segment(clean(text))].map(part => part.segment);
}

export function charWidth(segment) {
  if (!segment) return 0;
  // Base character of the grapheme; combining marks do not change its width.
  const base = [...segment].find(character => !/\p{Mark}/u.test(character));
  if (!base) return 0;
  // Format characters such as ZWSP and soft hyphen advance the cursor by zero.
  if (/\p{Cf}/u.test(base)) return 0;
  // VS15 forces text presentation (width 1); VS16 forces emoji presentation (width 2).
  if (segment.includes('\uFE0E')) return 1;
  if (segment.includes('\uFE0F')) return 2;
  // Extended_Pictographic also covers text-default symbols such as ⚙, ⚠, and ▶,
  // which terminals render one cell wide. Only default-emoji codepoints are wide.
  if (/\p{Emoji_Presentation}/u.test(base)) return 2;
  const cp = base.codePointAt(0);
  if (cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp >= 0x20000
  )) return 2;
  return 1;
}

export function width(text) {
  let total = 0;
  for (const segment of segments(text)) total += charWidth(segment);
  return total;
}

export function fit(text, columns, pad = false) {
  const source = clean(text);
  if (columns <= 0) return '';
  if (width(source) <= columns) return pad ? source + ' '.repeat(columns - width(source)) : source;
  const limit = columns - 1;
  let out = '';
  let used = 0;
  for (const segment of segments(source)) {
    const size = charWidth(segment);
    if (used + size > limit) break;
    out += segment;
    used += size;
  }
  const result = `${out}…`;
  return pad ? result + ' '.repeat(Math.max(0, columns - width(result))) : result;
}

export function fitTail(text, columns) {
  const source = clean(text);
  if (columns <= 0) return '';
  if (width(source) <= columns) return source;
  const limit = columns - 1;
  const kept = [];
  let used = 0;
  for (const segment of segments(source).reverse()) {
    const size = charWidth(segment);
    if (used + size > limit) break;
    kept.unshift(segment);
    used += size;
  }
  return `…${kept.join('')}`;
}

export function wrap(text, columns) {
  const result = [];
  if (columns <= 0) return [''];
  let line = '';
  let lineWidth = 0;
  for (const segment of segments(text)) {
    const size = charWidth(segment);
    if (line && lineWidth + size > columns) {
      const space = line.lastIndexOf(' ');
      if (space > 0 && segment !== ' ') {
        result.push(line.slice(0, space));
        line = line.slice(space + 1);
        lineWidth = width(line);
      } else {
        result.push(line);
        line = '';
        lineWidth = 0;
      }
      if (line && lineWidth + size > columns) {
        result.push(line);
        line = '';
        lineWidth = 0;
      }
      // The overflowing grapheme was the break space itself: drop it so the
      // continuation line starts flush instead of one cell in.
      if (segment === ' ') continue;
    }
    line += segment;
    lineWidth += size;
  }
  result.push(line);
  return result;
}

export function padEnd(text, columns) {
  return fit(text, columns, true);
}

export function padStart(text, columns) {
  const source = fit(text, columns);
  return ' '.repeat(Math.max(0, columns - width(source))) + source;
}

export function center(text, columns) {
  const source = fit(text, columns);
  const left = Math.max(0, Math.floor((columns - width(source)) / 2));
  return ' '.repeat(left) + source + ' '.repeat(Math.max(0, columns - left - width(source)));
}

export function percentBar(percent, columns, { filled = '█', empty = '░' } = {}) {
  if (columns <= 0) return '';
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const full = Math.round((value / 100) * columns);
  return filled.repeat(full) + empty.repeat(Math.max(0, columns - full));
}

export function sparkline(values, maxWidth = 24) {
  const source = (Array.isArray(values) ? values : [])
    .filter(value => Number.isFinite(value))
    .slice(-maxWidth);
  if (!source.length) return '';
  const min = Math.min(...source);
  const max = Math.max(...source);
  const glyphs = '▁▂▃▄▅▆▇█';
  return source.map(value => {
    if (max === min) return glyphs[Math.floor(glyphs.length / 2)];
    const index = Math.min(glyphs.length - 1, Math.max(0, Math.round(((value - min) / (max - min)) * (glyphs.length - 1))));
    return glyphs[index];
  }).join('');
}

export function clock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function compactDuration(ms, language = 'en') {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  const units = normalizeLanguage(language) === 'zh'
    ? { h: '小时', m: '分', s: '秒' }
    : { h: 'h', m: 'm', s: 's' };
  return [
    hours ? `${hours}${units.h}` : '',
    hours || minutes ? `${minutes}${units.m}` : '',
    `${seconds}${units.s}`,
  ].filter(Boolean).join(' ');
}

export function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1500) return 'now';
  return `${compactDuration(ms)} ago`;
}

export function plural(count, singular, pluralWord = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function truncateMiddle(text, columns) {
  const source = clean(text);
  if (columns <= 0) return '';
  if (width(source) <= columns) return source;
  // Too narrow for a head, a separator, and a tail: one ellipsis is the only
  // honest content that fits.
  if (columns <= 3) return '…';
  const budget = columns - 1;
  const parts = segments(source);
  let head = '';
  let headWidth = 0;
  for (const part of parts) {
    const size = charWidth(part);
    if (headWidth + size > Math.floor(budget / 2)) break;
    head += part;
    headWidth += size;
  }
  const tail = [];
  let tailWidth = 0;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    const size = charWidth(part);
    if (tailWidth + size > budget - headWidth) break;
    tail.unshift(part);
    tailWidth += size;
  }
  return `${head}…${tail.join('')}`;
}

export function relativeTime(iso, now = Date.now()) {
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) return '—';
  return ago(now - value);
}
