import { existsSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

// Absolute paths that cross a terminal or JSON boundary must not carry
// separators that reflow the screen or split a line-oriented record.
export const SAFE_PATH = /^[^\0\r\n]+$/;

export function absolutePath(value) {
  return typeof value === 'string' && isAbsolute(value) && SAFE_PATH.test(value)
    ? resolve(value)
    : undefined;
}

// Resolve a candidate inside a trusted root. The record must already exist as a
// regular JSON file and its real path must stay below the root. Symlinks that
// escape the store are rejected, and no directory is ever opened.
export function safeFileWithin(root, candidate, { exists = existsSync, realpath = realpathSync, stat = statSync } = {}) {
  if (!root || !candidate || !isAbsolute(root) || !isAbsolute(candidate)) return undefined;
  if (!SAFE_PATH.test(root) || !SAFE_PATH.test(candidate)) return undefined;
  if (!exists(candidate)) return undefined;
  if (extname(candidate).toLowerCase() !== '.json') return undefined;
  let rootReal;
  try { rootReal = realpath(root); } catch { rootReal = resolve(root); }
  let real;
  try { real = realpath(candidate); } catch { return undefined; }
  // The real target, not the link name, decides whether this is a JSON record.
  if (extname(real).toLowerCase() !== '.json') return undefined;
  try {
    if (!stat(real).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const inside = relative(rootReal, real);
  // Only a whole `..` path segment escapes the root; `..notes.json` is a name.
  const head = inside.split(sep)[0];
  if (!inside || head === '..' || isAbsolute(inside)) return undefined;
  return real;
}

// Revalidate a diagnosis record on the action, not just when the frame was
// painted: a record removed or replaced after the card was drawn must not open.
export function safeOpenRecordPath(diagnosis, fs) {
  if (!diagnosis) return undefined;
  for (const record of diagnosis.records) {
    if (record.key !== 'task' && record.key !== 'checkpoint') continue;
    const safe = safeFileWithin(record.root, record.absolute, fs);
    if (safe) return safe;
  }
  return undefined;
}
