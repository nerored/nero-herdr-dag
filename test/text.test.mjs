import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charWidth, clean, compactDuration, fit, truncateMiddle, width, wrap } from '../src/text.mjs';

test('text-default symbols are one cell, default emoji are two', () => {
  assert.equal(width('⚙'), 1);
  assert.equal(width('⚠'), 1);
  assert.equal(width('▶'), 1);
  assert.equal(width('✎'), 1);
  assert.equal(width('✓'), 1);
  assert.equal(width('⏳'), 2);
  assert.equal(width('💭'), 2);
  assert.equal(width('⚙\uFE0F'), 2);
  assert.equal(width('⏳\uFE0E'), 1);
});

test('combining marks extend a base without changing its width', () => {
  assert.equal(width('e\u0301'), 1);
  assert.equal(width('\u0301'), 0);
  assert.equal(width('한글'), 4);
  assert.equal(width('A⚙B'), 3);
});

test('fit and fitTail use terminal cell widths consistently', () => {
  assert.equal(width('⚙⚙⚙'), 3);
  assert.equal(fit('⚙⚙⚙', 2), '⚙…');
  assert.equal(width(fit('⚙⚙⚙', 2)), 2);
});

test('zero-width formatting characters are dropped and measure zero', () => {
  assert.equal(clean('a\u200bb'), 'ab');
  assert.equal(clean('\u00ad\u180e\u200b\u200f\u2060\ufeff\u{e0001}'), '');
  // C0 controls still take a cell so surrounding layout does not shift.
  assert.equal(clean('a\tb'), 'a b');
  assert.equal(width('a\u200bb'), 2);
  assert.equal(charWidth('\u200b'), 0);
  assert.equal(charWidth('\u00ad'), 0);
  assert.equal(fit('a\u200bb', 3, true), 'ab ');
});

test('truncateMiddle emits one ellipsis within the cell budget', () => {
  assert.equal(truncateMiddle('session_0123456789abcdef', 12), 'sessi…abcdef');
  assert.equal((truncateMiddle('abcdefghijklmno', 9).match(/…/g) ?? []).length, 1);
  assert.doesNotMatch(truncateMiddle('abcdefghijklmno', 9), /……/);

  const cjk = truncateMiddle('这是一个很长的会话标识符', 10);
  assert.ok(width(cjk) <= 10, `expected <= 10 columns, got ${width(cjk)}`);
  assert.equal((cjk.match(/…/g) ?? []).length, 1);
  assert.ok(cjk.isWellFormed());

  const flags = truncateMiddle('🇯🇵🇰🇷🇺🇸', 4);
  assert.ok(width(flags) <= 4);
  assert.ok(flags.isWellFormed());
  assert.ok(!flags.includes('\uFFFD'));

  // Three columns cannot hold a head, a separator, and a tail.
  assert.equal(truncateMiddle('👨\u200d👩\u200d👧\u200d👦'.repeat(3), 3), '…');
  assert.equal(truncateMiddle('abcdef', 2), '…');
  assert.equal(truncateMiddle('abcdef', 0), '');
});

test('wrap breaks on a space without indenting the continuation', () => {
  assert.deepEqual(wrap('ab cd', 2), ['ab', 'cd']);
  assert.deepEqual(wrap('abc def', 3), ['abc', 'def']);
  assert.deepEqual(wrap('ab cdef', 4), ['ab', 'cdef']);
});

test('wrap keeps graphemes and column bounds for long persisted text', () => {
  const source = 'alpha beta gamma '.repeat(70).trim();
  const lines = wrap(source, 32);
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(width(line) <= 32, `line ${JSON.stringify(line)} is ${width(line)} columns`);
    assert.equal(line, line.trimStart());
  }
  assert.equal(
    lines.join(' ').replace(/\s+/g, ' '),
    source.replace(/\s+/g, ' '),
  );
});

test('compactDuration normalizes language tags before choosing units', () => {
  assert.equal(compactDuration(65_000, 'zh-CN'), '1分 5秒');
  assert.equal(compactDuration(65_000, 'zh_CN'), '1分 5秒');
  assert.equal(compactDuration(3_600_000, 'ZH-cn'), '1小时 0分 0秒');
  assert.equal(compactDuration(65_000), '1m 5s');
});
