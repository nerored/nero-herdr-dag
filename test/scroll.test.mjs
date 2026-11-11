import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regionAt, scrollbarGeometry, smoothScroll } from '../src/scroll.mjs';

test('smoothScroll eases without overshoot and snaps short distances', () => {
  const first = smoothScroll(0, 20, 16);
  assert.ok(first > 0 && first < 20);
  assert.ok(smoothScroll(20, 0, 16) > 0);
  assert.equal(smoothScroll(0, 20, 10_000), 20);
  assert.equal(smoothScroll(7, 8, 16), 8);
  assert.equal(smoothScroll(7, 7, 16), 7);
  let current = 0;
  for (let index = 0; index < 60; index++) current = smoothScroll(current, 20, 16);
  assert.equal(current, 20);
  assert.ok(current <= 20);
});

test('regionAt uses half-open rectangles and never falls back', () => {
  const regions = new Map([
    ['graph', { x: 10, y: 2, w: 5, h: 4 }],
    ['tasks', { x: 0, y: 2, w: 4, h: 4 }],
    ['details', { x: 16, y: 2, w: 6, h: 4 }],
  ]);
  assert.equal(regionAt(10, 2, regions), 'graph');
  assert.equal(regionAt(14, 5, regions), 'graph');
  assert.equal(regionAt(15, 5, regions), null);
  assert.equal(regionAt(0, 5, regions), 'tasks');
  assert.equal(regionAt(3, 5, regions), 'tasks');
  assert.equal(regionAt(4, 5, regions), null);
  assert.equal(regionAt(0, 6, regions), null);
  assert.equal(regionAt(5, 3, regions), null);
  assert.equal(regionAt(0, 0, regions), null);
  assert.equal(regionAt(Number.NaN, 0, regions), null);
  assert.equal(regionAt(10, 2, undefined), null);
});

test('scrollbarGeometry maps offsets to a bounded thumb in region units', () => {
  assert.equal(scrollbarGeometry({
    y: 5, trackHeight: 10, viewport: 10, content: 10, offset: 0,
  }), null);

  const top = scrollbarGeometry({
    y: 5, trackHeight: 10, viewport: 10, content: 100, offset: 0,
  });
  assert.deepEqual([top.thumbTop, top.thumbH, top.maxOffset], [5, 1, 90]);

  const bottom = scrollbarGeometry({
    y: 5, trackHeight: 10, viewport: 10, content: 100, offset: 999,
  });
  assert.deepEqual(
    [bottom.thumbTop, bottom.thumbH, bottom.offset],
    [14, 1, 90],
  );

  const task = scrollbarGeometry({
    y: 15, trackHeight: 16, viewport: 8, content: 10, offset: 2, unitHeight: 2,
  });
  assert.deepEqual([task.thumbTop, task.thumbH], [19, 12]);
});

test('scrollbarGeometry keeps the thumb inside the track for every offset', () => {
  for (const content of [2, 3, 7, 43, 100]) {
    for (const viewport of [1, 2, 5, 10, 20]) {
      for (const unitHeight of [1, 2]) {
        for (const offset of [0, 1, content - viewport - 1, content - viewport, 999]) {
          const bar = scrollbarGeometry({
            y: 5,
            trackHeight: viewport * unitHeight,
            viewport,
            content,
            offset,
            unitHeight,
          });
          if (content <= viewport) {
            assert.equal(bar, null);
            continue;
          }
          assert.ok(bar.thumbH >= 1);
          assert.ok(bar.thumbTop >= 5);
          assert.ok(bar.thumbTop + bar.thumbH <= 5 + viewport * unitHeight);
          assert.ok(bar.offset >= 0 && bar.offset <= content - viewport);
        }
      }
    }
  }
});
