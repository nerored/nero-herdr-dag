import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMouse, isLeftClick, mouseTrackingSequence, parseMouse, wheelDirection, wheelDirectionFromButton } from '../src/mouse.mjs';

const ESC = String.fromCharCode(27);

test('mouse tracking can be released for Herdr native selection', () => {
  assert.equal(mouseTrackingSequence(true), `${ESC}[?1000h${ESC}[?1006h`);
  assert.equal(mouseTrackingSequence(false), `${ESC}[?1000l${ESC}[?1006l`);
});

test('SGR wheel events map to immediate scroll directions', () => {
  assert.equal(wheelDirection(`${ESC}[<64;10;5M`), -1);
  assert.equal(wheelDirection(`${ESC}[<65;10;5M`), 1);
  assert.equal(wheelDirection(`${ESC}[<68;10;5M`), -1);
  assert.equal(wheelDirection(`${ESC}[<69;10;5M`), 1);
  assert.equal(wheelDirection(`${ESC}[<0;10;5M`), 0);
  assert.equal(wheelDirection(`${ESC}[<64;10;5m`), -1);
  assert.equal(wheelDirectionFromButton(64), -1);
  assert.equal(wheelDirectionFromButton(65), 1);
  assert.equal(wheelDirectionFromButton(66), 0);
  assert.equal(wheelDirectionFromButton(67), 0);
  assert.equal(wheelDirectionFromButton(70), 0);
  assert.equal(wheelDirectionFromButton(0), 0);
  assert.deepEqual(
    parseMouse(`${ESC}[<64;10;5M`),
    { button: 64, x: 9, y: 4, release: false },
  );
});

test('mouse clicks carry zero-based cell coordinates and ignore releases', () => {
  const click = parseMouse(`${ESC}[<0;12;7M`);
  assert.deepEqual(click, { button: 0, x: 11, y: 6, release: false });
  assert.equal(isLeftClick(`${ESC}[<0;12;7M`), true);
  assert.equal(isLeftClick(`${ESC}[<0;12;7m`), false);
  assert.equal(isLeftClick(`${ESC}[<64;12;7M`), false);
  assert.equal(isLeftClick(`${ESC}[A`), false);
  const legacy = parseMouse(`${ESC}[M${String.fromCharCode(32, 43, 39)}`);
  assert.deepEqual(legacy, { button: 0, x: 10, y: 6, release: false });
});

test('raw input extracts complete reports and preserves incomplete tails', () => {
  const first = extractMouse(`abc${ESC}[<65;10;5Mdef`);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].button, 65);
  assert.equal(first.rest, 'abcdef');
  const split = extractMouse(`${ESC}[<65;10;`);
  assert.equal(split.events.length, 0);
  assert.equal(split.rest, `${ESC}[<65;10;`);
});

test('legacy X10 wheel events and unrelated keys are handled safely', () => {
  assert.equal(wheelDirection(`${ESC}[M${String.fromCharCode(96, 42, 54)}`), -1);
  assert.equal(wheelDirection(`${ESC}[M${String.fromCharCode(97, 42, 54)}`), 1);
  assert.equal(wheelDirection(`${ESC}[M${String.fromCharCode(32, 42, 54)}`), 0);
  assert.equal(wheelDirection('j'), 0);
  assert.equal(wheelDirection(`${ESC}[A`), 0);
});

test('X10 reports decode coordinate bytes above 0x7f byte-accurately', () => {
  const raw = Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0xc8, 0x27]);
  assert.deepEqual(parseMouse(raw), { button: 0, x: 167, y: 6, release: false });
  const extracted = extractMouse(Buffer.concat([Buffer.from('ab'), raw, Buffer.from('cd')]));
  assert.deepEqual(extracted.events, [{ button: 0, x: 167, y: 6, release: false }]);
  assert.equal(Buffer.isBuffer(extracted.rest), true);
  assert.equal(extracted.rest.toString('latin1'), 'abcd');
});

test('extractMouse exposes incomplete trailing reports as pending', () => {
  const sgr = extractMouse(`abc${ESC}[<65;10;`);
  assert.equal(sgr.events.length, 0);
  assert.equal(sgr.rest, `abc${ESC}[<65;10;`);
  assert.equal(sgr.pending, `${ESC}[<65;10;`);
  const legacy = extractMouse(`${ESC}[M${String.fromCharCode(32, 43)}`);
  assert.equal(legacy.pending, `${ESC}[M${String.fromCharCode(32, 43)}`);
  assert.equal(extractMouse(`abc${ESC}[<65;10;5M`).pending, '');
  assert.equal(extractMouse(`abc${ESC}[A`).pending, '');
  assert.equal(extractMouse('plain text').pending, '');
  // Escape handling must not be suppressed by an ordinary escape key: only a
  // prefix that can still become a mouse report is pending.
  assert.equal(extractMouse(ESC).pending, '');
  assert.equal(extractMouse(`${ESC}[`).pending, '');
  assert.equal(extractMouse(`${ESC}[M`).pending, `${ESC}[M`);
});

test('malformed SGR coordinates are rejected instead of wrapping', () => {
  assert.equal(parseMouse(`${ESC}[<0;0;0M`), null);
  assert.equal(parseMouse(`${ESC}[<0;0;12M`), null);
  assert.equal(parseMouse(`${ESC}[<0;12;0M`), null);
  const hugeCoordinate = `${ESC}[<0;1;12345678901234567890M`;
  assert.equal(parseMouse(hugeCoordinate), null);
  assert.equal(isLeftClick(hugeCoordinate), false);
  assert.equal(wheelDirection(hugeCoordinate), 0);
  assert.equal(parseMouse(`${ESC}[<12345678901234567890;1;1M`), null);
  assert.equal(isLeftClick(`${ESC}[<0;0;0M`), false);
  assert.deepEqual(parseMouse(`${ESC}[<0;1;1M`), { button: 0, x: 0, y: 0, release: false });
});

test('legacy X10 release and motion reports are classified correctly', () => {
  const release = `${ESC}[M${String.fromCharCode(35, 43, 39)}`;
  assert.deepEqual(parseMouse(release), { button: 3, x: 10, y: 6, release: true });
  assert.equal(isLeftClick(release), false);
  const motion = `${ESC}[M${String.fromCharCode(64, 43, 39)}`;
  assert.deepEqual(parseMouse(motion), { button: 32, x: 10, y: 6, release: false });
  assert.equal(isLeftClick(motion), false);
  const drag = `${ESC}[M${String.fromCharCode(65, 43, 39)}`;
  assert.equal(parseMouse(drag).button, 33);
  assert.equal(isLeftClick(drag), false);
});

test('motion reports never count as left clicks', () => {
  assert.equal(isLeftClick(`${ESC}[<32;12;6M`), false);
  assert.equal(isLeftClick(`${ESC}[<33;12;6M`), false);
  assert.equal(isLeftClick(`${ESC}[<0;12;6M`), true);
});

test('a stray legacy prefix does not consume a following report', () => {
  const mixed = extractMouse(`${ESC}[M${ESC}[<0;1;1M`);
  assert.deepEqual(mixed.events, [{ button: 0, x: 0, y: 0, release: false }]);
  assert.equal(mixed.rest, `${ESC}[M`);
  assert.equal(mixed.events.some(event => event.button < 0), false);
  const withLegacy = extractMouse(`${ESC}[M${ESC}[M${String.fromCharCode(32, 43, 39)}`);
  assert.deepEqual(withLegacy.events, [{ button: 0, x: 10, y: 6, release: false }]);
  assert.equal(withLegacy.rest, `${ESC}[M`);
});

test('coalesced reports keep order and the exact remainder', () => {
  const input = `a${ESC}[<64;1;2Mb${ESC}[<0;3;4Mc${ESC}[<65;5;6Mtail${ESC}[<0;7;`;
  const { events, rest, pending } = extractMouse(input);
  assert.deepEqual(events, [
    { button: 64, x: 0, y: 1, release: false },
    { button: 0, x: 2, y: 3, release: false },
    { button: 65, x: 4, y: 5, release: false },
  ]);
  assert.equal(rest, `abctail${ESC}[<0;7;`);
  assert.equal(pending, `${ESC}[<0;7;`);
});
