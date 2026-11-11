import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canvas } from '../src/canvas.mjs';
import { createTheme } from '../src/theme.mjs';
import { width } from '../src/text.mjs';

const plainTheme = createTheme({ color: false });

function assertPairs(canvas) {
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const cell = canvas.cells[y][x];
      if (cell.cont) {
        assert.ok(x > 0, `row ${y}: continuation at column 0`);
        const head = canvas.cells[y][x - 1];
        assert.equal(head.width, 2, `row ${y}, column ${x}: orphaned continuation`);
        assert.equal(head.cont, false);
      } else if (cell.width === 2) {
        assert.ok(x + 1 < canvas.width, `row ${y}, column ${x}: wide head at the border`);
        const next = canvas.cells[y][x + 1];
        assert.equal(next.cont, true, `row ${y}, column ${x}: wide head without continuation`);
        assert.equal(next.width, 0);
      }
    }
  }
}

function assertRenderedWidths(canvas) {
  const rows = canvas.toString(plainTheme).split('\n');
  assert.equal(rows.length, canvas.height);
  for (const row of rows) {
    assert.equal(width(row), canvas.width, `rendered row ${JSON.stringify(row)} is ${width(row)} cells`);
  }
}

test('put over a continuation cell repairs the orphaned head', () => {
  const canvas = new Canvas(10, 2);
  canvas.put(0, 0, '😀cdefghij');
  canvas.put(1, 0, 'X');

  assert.equal(canvas.cell(0, 0).ch, ' ');
  assert.equal(canvas.cell(0, 0).width, 1);
  assert.equal(canvas.cell(0, 0).cont, false);
  assert.equal(canvas.cell(1, 0).ch, 'X');
  assertPairs(canvas);
  assertRenderedWidths(canvas);
});

test('put of a wide glyph repairs a destination pair at its continuation', () => {
  const canvas = new Canvas(6, 1);
  canvas.put(1, 0, '💭');
  canvas.put(0, 0, '😀');

  assert.equal(canvas.cell(0, 0).width, 2);
  assert.equal(canvas.cell(1, 0).cont, true);
  assert.equal(canvas.cell(2, 0).width, 1);
  assert.equal(canvas.cell(2, 0).cont, false);
  assertPairs(canvas);
  assertRenderedWidths(canvas);
});

test('fill clears both halves of a wide glyph pair', () => {
  const overHead = new Canvas(8, 1);
  overHead.put(0, 0, '💭abcd');
  overHead.fill(0, 0, 1, 1);
  assert.equal(overHead.cell(0, 0).ch, ' ');
  assert.equal(overHead.cell(0, 0).width, 1);
  assert.equal(overHead.cell(1, 0).cont, false);
  assert.equal(overHead.cell(1, 0).width, 1);
  assertPairs(overHead);
  assertRenderedWidths(overHead);

  const overContinuation = new Canvas(8, 1);
  overContinuation.put(0, 0, '💭abcd');
  overContinuation.fill(1, 0, 1, 1);
  assert.equal(overContinuation.cell(0, 0).ch, ' ');
  assert.equal(overContinuation.cell(0, 0).width, 1);
  assert.equal(overContinuation.cell(1, 0).width, 1);
  assertPairs(overContinuation);
  assertRenderedWidths(overContinuation);
});

test('blit repairs destination pairs instead of leaving an orphan half', () => {
  const source = new Canvas(2, 1);
  source.put(0, 0, 'XY');

  const destination = new Canvas(6, 1);
  destination.put(1, 0, '💭');
  destination.blit(source, 0, 0);

  assert.equal(destination.cell(1, 0).ch, 'Y');
  assert.equal(destination.cell(2, 0).cont, false);
  assert.equal(destination.cell(2, 0).width, 1);
  assertPairs(destination);
  assertRenderedWidths(destination);

  const wide = new Canvas(2, 1);
  wide.put(0, 0, '😀');
  const wideDestination = new Canvas(6, 1);
  wideDestination.put(1, 0, '💭');
  wideDestination.blit(wide, 0, 0);

  assert.equal(wideDestination.cell(0, 0).width, 2);
  assert.equal(wideDestination.cell(1, 0).cont, true);
  assert.equal(wideDestination.cell(2, 0).cont, false);
  assertPairs(wideDestination);
  assertRenderedWidths(wideDestination);
});

test('frame fits titles by cell width and keeps the right corner', () => {
  const canvas = new Canvas(10, 3);
  canvas.frame(0, 0, 10, 3, { title: '切换 · 运 47 任' });
  const top = canvas.toString(plainTheme).split('\n')[0];

  assert.equal(canvas.cell(9, 0).ch, '╮');
  assert.equal(width(top), 10);
  assert.ok(top.isWellFormed());
  assert.ok(top.includes('切'));
  assertPairs(canvas);

  const emoji = new Canvas(8, 3);
  emoji.frame(0, 0, 8, 3, { title: 'A👨‍👩‍👧‍👦B切换C' });
  const emojiTop = emoji.toString(plainTheme).split('\n')[0];
  assert.equal(emoji.cell(7, 0).ch, '╮');
  assert.equal(width(emojiTop), 8);
  assert.ok(emojiTop.isWellFormed());
});

test('fadeRect keeps default-color sentinels and ignores malformed targets', () => {
  const transparent = new Canvas(2, 1, { fg: '', bg: '' });
  transparent.put(0, 0, 'X', { fg: '', bg: '' });
  transparent.fadeRect(0, 0, 1, 1, 0.5, '#ffffff');
  assert.equal(transparent.cell(0, 0).fg, '');
  assert.equal(transparent.cell(0, 0).bg, '');

  const malformed = new Canvas(1, 1, { fg: '#000000', bg: '#000000' });
  malformed.put(0, 0, 'X', { fg: '#000000', bg: '#000000' });
  malformed.fadeRect(0, 0, 1, 1, 0.5, 'not-a-color');
  assert.equal(malformed.cell(0, 0).fg, '#000000');
  assert.equal(malformed.cell(0, 0).bg, '#000000');

  const blended = new Canvas(1, 1, { fg: '#000000', bg: '#000000' });
  blended.put(0, 0, 'X', { fg: '#000000', bg: '#000000' });
  blended.fadeRect(0, 0, 1, 1, 0.5, '#ffffff');
  assert.equal(blended.cell(0, 0).fg, '#808080');
  assert.equal(blended.cell(0, 0).bg, '#808080');

  blended.fadeRect(0, 0, 1, 1, 0.5, '');
  assert.ok(blended.cell(0, 0).flags & 2);
});
