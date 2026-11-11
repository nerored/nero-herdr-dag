import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { normalizeThemeName, terminalAppearance } from './theme.mjs';
import { readEnv } from './env.mjs';

export function omoAgentDir(env = process.env) {
  return readEnv(env).agentDir;
}

// The host names its project directory `<basename>-<sha256(realpath)[0..12]>`.
// Mirror that key so the read-only aggregation lands on the store the host
// actually writes for this working directory.
export function projectKey(cwd, { realpath: canonicalize = true } = {}) {
  const absolute = resolve(typeof cwd === 'string' && cwd.trim() ? cwd : process.cwd());
  let canonical = absolute;
  if (canonicalize) {
    try { canonical = realpathSync.native(absolute); }
    catch { canonical = absolute; }
  }
  const safe = basename(canonical).replace(/[^A-Za-z0-9._-]/g, '_') || 'root';
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return `${safe}-${digest}`;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// The dashboard follows OmO's own theme choice until the user picks one in the
// settings popup. Unsupported or missing settings fall back to `system`.
export async function loadOmoTheme({ env = process.env } = {}) {
  // Prefer the documented studio naming family; keep the NERO_ spelling as a
  // backward-compatible alias for existing configurations.
  const { omoSettings, agentDir } = readEnv(env);
  const path = omoSettings ?? join(agentDir, 'settings.json');
  const settings = await readJson(path);
  return normalizeThemeName(settings?.theme) ?? 'system';
}

// OmO caches the terminal's light/dark appearance next to its settings. When
// the cache is missing, fall back to the same COLORFGBG heuristic.
export async function loadOmoAppearance({ env = process.env } = {}) {
  const cache = await readJson(join(readEnv(env).agentDir, 'cache', 'terminal-theme.json'));
  const cached = cache?.terminalTheme;
  if (cached === 'light' || cached === 'dark') return cached;
  return terminalAppearance(env);
}
