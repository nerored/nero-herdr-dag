import { join } from 'node:path';
import { readJson, writeJson } from './storage.mjs';
import { normalizeLanguage } from './i18n.mjs';
import { normalizeThemeName } from './theme.mjs';
import { ENV_NAMES, readEnv } from './env.mjs';

export const DEFAULT_CONFIG = { version: 1, language: 'en' };

// N1 freshness contract: a live snapshot older than this is STALE. The
// threshold is operator-configurable so a slow producer does not get flagged
// during normal idle periods. Set OMO_HERDR_DAG_STUDIO_STALE_MS to a positive
// integer number of milliseconds; invalid or missing values use the default.
// Parsing and defaults live in src/env.mjs.
export { DEFAULT_STALE_AFTER_MS } from './env.mjs';
export const STALE_AFTER_ENV = ENV_NAMES.STALE_AFTER_MS;

export function staleAfterMs(env = process.env) {
  return readEnv(env).staleAfterMs;
}

// An empty or whitespace-only override means "unset", not "use the process
// cwd". A leading ~/ expands to the home directory and every configured path
// is resolved, so configPath() never returns a relative config.json. The
// expansion and resolution rules live in src/env.mjs.
export function configDir(env = process.env) {
  return readEnv(env).configDir;
}

export function configPath(env = process.env) {
  return join(configDir(env), 'config.json');
}

// Version 1 is the only format this build understands. Files with no version
// are legacy v1; numeric v0 or older are migrated by rewriting them as v1. A
// newer or malformed version is refused so a future writer's data is never
// silently downgraded and overwritten.
function assertSupportedConfigVersion(raw) {
  if (raw.version === undefined || raw.version === null) return;
  const version = Number(raw.version);
  if (!Number.isInteger(version) || version > DEFAULT_CONFIG.version) {
    throw new Error(`Unsupported config version ${JSON.stringify(raw.version)}; expected ${DEFAULT_CONFIG.version}.`);
  }
}

export async function loadConfig({ env = process.env } = {}) {
  const raw = await readJson(configPath(env));
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG };
  assertSupportedConfigVersion(raw);
  const config = {
    ...DEFAULT_CONFIG,
    ...raw,
    version: 1,
    language: normalizeLanguage(raw.language),
  };
  const theme = normalizeThemeName(raw.theme);
  if (theme) config.theme = theme;
  else delete config.theme;
  return config;
}

// Saves in this process are serialized so overlapping viewer settings changes
// merge instead of both reading the old file and the last rename winning.
let saveQueue = Promise.resolve();

async function saveConfigNow(config, env) {
  // loadConfig errors (malformed JSON, unsupported version) must surface; a
  // broken file is never replaced with defaults plus the one changed key.
  const current = await loadConfig({ env });
  const next = {
    ...current,
    ...config,
    version: 1,
    language: normalizeLanguage(config.language ?? current.language),
  };
  const theme = normalizeThemeName(next.theme);
  if (theme) next.theme = theme;
  else delete next.theme;
  await writeJson(configPath(env), next);
  return next;
}

export function saveConfig(config, { env = process.env } = {}) {
  const pending = saveQueue.then(() => saveConfigNow(config, env));
  // Keep the queue alive after a failed save; the caller still sees the error.
  saveQueue = pending.catch(() => {});
  return pending;
}
