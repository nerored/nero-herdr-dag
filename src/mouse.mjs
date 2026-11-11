const ESC = String.fromCharCode(27);
const SGR = new RegExp(`^${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])$`);
// X10 payload bytes are printable single bytes (32..255); ESC and other
// control bytes cannot be part of a report, so a stray ESC[M prefix must not
// swallow the beginning of a following SGR report.
const LEGACY_PAYLOAD = '[\\x20-\\xff]{3}';
const LEGACY = new RegExp(`^${ESC}\\[M(${LEGACY_PAYLOAD})$`);
const SGR_SCAN = new RegExp(`${ESC}\\[<\\d+;\\d+;\\d+[Mm]`);
const LEGACY_SCAN = new RegExp(`${ESC}\\[M${LEGACY_PAYLOAD}`);
// Only prefixes that can still become a mouse report count as pending: a lone
// ESC or ESC[ is an ordinary key/escape sequence, and suppressing keys for it
// would break Escape handling. ESC[M is ambiguous with a literal Alt+M but the
// terminal only sends it as the start of a legacy X10 report.
const SGR_PREFIX = new RegExp(`^${ESC}\\[<(?:\\d*(?:;\\d*(?:;\\d*)?)?)?$`);
const LEGACY_PREFIX = new RegExp(`^${ESC}\\[M[\\x20-\\xff]{0,2}$`);

// Legacy X10 reports are byte sequences: one byte per payload cell. A UTF-8
// decoded string cannot represent bytes >= 0x80 faithfully, so callers may pass
// the raw stdin Buffer (or an equivalent latin1-decoded string).
function latin1Text(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('latin1');
  }
  return null;
}

function restoreText(text, original) {
  return typeof original === 'string' ? text : Buffer.from(text, 'latin1');
}

// SGR coordinates are 1-based; legacy X10 bytes are offset by 32.
export function parseMouse(key) {
  const text = latin1Text(key);
  if (text === null) return null;
  const sgr = SGR.exec(text);
  if (sgr) {
    const button = Number(sgr[1]);
    const x = Number(sgr[2]);
    const y = Number(sgr[3]);
    if (!Number.isSafeInteger(button) || button < 0) return null;
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 1 || y < 1) return null;
    return {
      button,
      x: x - 1,
      y: y - 1,
      release: sgr[4] === 'm',
    };
  }
  const legacy = LEGACY.exec(text);
  if (legacy) {
    const [button, x, y] = [...legacy[1]].map(character => character.charCodeAt(0) - 32);
    // X10 encodes button release as code 3; consumers must not see it as a press.
    return { button, x: x - 1, y: y - 1, release: (button & 3) === 3 };
  }
  return null;
}

// Returns -1 for wheel up, 1 for wheel down, and 0 for every other mouse event.
export function wheelDirectionFromButton(button) {
  if (!(button & 64)) return 0;
  const direction = button & 3;
  return direction === 0 ? -1 : direction === 1 ? 1 : 0;
}

export function wheelDirection(key) {
  const mouse = parseMouse(key);
  return mouse ? wheelDirectionFromButton(mouse.button) : 0;
}

export function isLeftClick(key) {
  const mouse = parseMouse(key);
  return Boolean(
    mouse && !mouse.release && !(mouse.button & 64) && !(mouse.button & 32) &&
    (mouse.button & 3) === 0,
  );
}

// Enable/disable terminal mouse tracking. When disabled, Herdr owns the mouse
// and can perform its native drag-selection + copy_on_select.
export function mouseTrackingSequence(enabled) {
  return enabled ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l';
}

// Pull complete mouse reports out of a raw stdin buffer. Incomplete trailing
// sequences stay in the returned remainder so the next chunk can finish them,
// and `pending` names that in-flight prefix. Callers that also receive readline
// keypresses should suppress key dispatch while `pending` is non-empty, because
// readline decodes the same partial bytes as individual keys.
export function extractMouse(buffer) {
  const text = latin1Text(buffer);
  if (text === null) return { events: [], rest: buffer, pending: '' };
  const events = [];
  let rest = text;
  for (;;) {
    const sgr = SGR_SCAN.exec(rest);
    const legacy = LEGACY_SCAN.exec(rest);
    let match;
    if (sgr && legacy) match = sgr.index <= legacy.index ? sgr : legacy;
    else match = sgr ?? legacy;
    if (!match) break;
    const event = parseMouse(match[0]);
    if (event) events.push(event);
    rest = rest.slice(0, match.index) + rest.slice(match.index + match[0].length);
  }
  const pending = pendingMousePrefix(rest);
  return { events, rest: restoreText(rest, buffer), pending };
}

function pendingMousePrefix(text) {
  const index = text.lastIndexOf(ESC);
  if (index === -1) return '';
  const tail = text.slice(index);
  return SGR_PREFIX.test(tail) || LEGACY_PREFIX.test(tail) ? tail : '';
}
