import { existsSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';

// Compatibility surface. The diagnosis model/text and path containment moved to
// dedicated modules; these re-exports keep older embedders and tests importing
// from this path working while new code imports the focused modules directly.
export {
  DIAGNOSIS_ACTIONS, DIAGNOSIS_STATES, diagnosisCopyText, diagnosisFor, diagnosisForKey,
  diagnosisPathsText,
} from './diagnosis.mjs';
export { safeFileWithin, safeOpenRecordPath } from './safe-path.mjs';

const SAFE_PAGER_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const SAFE_PAGER_FLAG = /^--?[A-Za-z0-9][A-Za-z0-9-]*$/;
// PAGER is user-controlled. Only known read-only pagers are launched, and
// optional arguments must be flags (never a second file or a command).
const PAGER_NAMES = new Set(['less', 'more', 'most', 'pg', 'lv', 'bat', 'batcat', 'cat']);

export function commandExists(command, env = process.env) {
  if (!command) return false;
  if (command.includes('/')) return existsSync(command);
  return String(env.PATH ?? '').split(delimiter).filter(Boolean)
    .some(directory => existsSync(join(directory, command)));
}

// PAGER is a single executable plus optional safe flags, never a shell string.
export function pagerCommand(env = process.env, { exists = command => commandExists(command, env) } = {}) {
  const configured = typeof env.PAGER === 'string' ? env.PAGER.trim() : '';
  if (configured) {
    const tokens = configured.split(/\s+/).filter(Boolean);
    const name = tokens[0] ? basename(tokens[0]) : '';
    if (tokens.length && tokens.length <= 8 && PAGER_NAMES.has(name) &&
        tokens.every(token => SAFE_PAGER_TOKEN.test(token)) &&
        tokens.slice(1).every(token => SAFE_PAGER_FLAG.test(token)) && exists(tokens[0])) {
      return { command: tokens[0], args: tokens.slice(1) };
    }
  }
  if (exists('less')) return { command: 'less', args: ['-R'] };
  if (exists('more')) return { command: 'more', args: [] };
  return undefined;
}

// OSC 52 is a write-only terminal escape: the app cannot know whether the
// terminal accepted it, so callers must say "sent", not "copied".
const OSC52_CAP = 16_000;
const OSC52_TRUNCATION = '\n… truncated';

// The cap counts UTF-16 code units for compatibility with existing payloads,
// but never ends on a high surrogate: a split pair encodes as U+FFFD.
function osc52Payload(text) {
  const source = String(text ?? '')
    .replace(/\x1b/g, '')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, ' ');
  if (source.length <= OSC52_CAP) return source;
  let end = OSC52_CAP;
  const last = source.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${source.slice(0, end)}${OSC52_TRUNCATION}`;
}

export function osc52(text) {
  return `\x1b]52;c;${Buffer.from(osc52Payload(text), 'utf8').toString('base64')}\x07`;
}

// Count the payload that is actually sent, so a truncated copy never claims
// the source line count.
export function payloadLines(text) {
  if (typeof text !== 'string' || !text) return 0;
  return osc52Payload(text).split('\n').length;
}
