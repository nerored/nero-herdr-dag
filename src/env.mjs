import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

// Single, documented reader for every environment variable DAG Studio
// consumes. Call sites pass an env object (process.env unless a caller is
// testing) and receive parsed values; no module re-implements a parse rule.
//
// name                         type   default                         invalid value / notes
// OMO_HERDR_DAG_STUDIO_STALE_MS int   60000 ms                        <=0, empty or non-numeric -> default
// OMO_HERDR_DAG_STUDIO_RETENTION_DAYS int 14                           <=0 or non-numeric -> 0 (disables pruning)
// NERO_HERDR_DAG_CONFIG_DIR     path  ~/.config/nero-herdr-dag        trimmed, ~/ expanded, resolved
// OMO_HERDR_DAG_STUDIO_STATE_DIR path join(agentDir,herdr-dag-studio) raw value; empty string is preserved
// OMO_HERDR_DAG_STUDIO_TASK_STATE_DIRS list (delimiter-separated) []   each item trimmed, ~/ expanded, trailing / removed
// OMO_HERDR_DAG_STUDIO_TASK_STATE_DIR path (unset)                    trimmed, ~/ expanded, trailing / removed
// OMO_HERDR_DAG_STUDIO_RUNTIME  string (unset)                        trimmed; wins over the NODE alias
// OMO_HERDR_DAG_STUDIO_NODE     string (unset)                        trimmed; compatibility alias for RUNTIME
// OMO_HERDR_DAG_STUDIO_OMO_SETTINGS path (unset)                      trimmed; wins over the NERO_ alias
// NERO_HERDR_DAG_OMO_SETTINGS   path (unset)                          trimmed; compatibility alias
// OMO_CODING_AGENT_DIR          path  ~/.omo/agent                    trimmed; wins over the SENPI_ alias
// SENPI_CODING_AGENT_DIR        path  ~/.omo/agent                    trimmed; compatibility alias
// HERDR_BIN_PATH                path (unset)                          trimmed; invalid paths fall back to PATH
// HERDR_ENV                     bool  false                           true only when exactly "1"
// HERDR_PANE_ID                 string (unset)                        raw value
// HERDR_SOCKET_PATH             string (unset)                        raw value
// PATH                          string ''                              raw value; searched for herdr
// PAGER                         string (unset)                        raw value; read by clipboard.mjs (not yet
//                                                                      migrated: that module is outside this fix)
export const ENV_NAMES = Object.freeze({
  STALE_AFTER_MS: 'OMO_HERDR_DAG_STUDIO_STALE_MS',
  RETENTION_DAYS: 'OMO_HERDR_DAG_STUDIO_RETENTION_DAYS',
  CONFIG_DIR: 'NERO_HERDR_DAG_CONFIG_DIR',
  STATE_DIR: 'OMO_HERDR_DAG_STUDIO_STATE_DIR',
  TASK_STATE_DIRS: 'OMO_HERDR_DAG_STUDIO_TASK_STATE_DIRS',
  TASK_STATE_DIR: 'OMO_HERDR_DAG_STUDIO_TASK_STATE_DIR',
  RUNTIME: 'OMO_HERDR_DAG_STUDIO_RUNTIME',
  NODE: 'OMO_HERDR_DAG_STUDIO_NODE',
  OMO_SETTINGS: 'OMO_HERDR_DAG_STUDIO_OMO_SETTINGS',
  NERO_OMO_SETTINGS: 'NERO_HERDR_DAG_OMO_SETTINGS',
  OMO_CODING_AGENT_DIR: 'OMO_CODING_AGENT_DIR',
  SENPI_CODING_AGENT_DIR: 'SENPI_CODING_AGENT_DIR',
  HERDR_BIN_PATH: 'HERDR_BIN_PATH',
  HERDR_ENV: 'HERDR_ENV',
  HERDR_PANE_ID: 'HERDR_PANE_ID',
  HERDR_SOCKET_PATH: 'HERDR_SOCKET_PATH',
  PATH: 'PATH',
  PAGER: 'PAGER',
});

export const DEFAULT_STALE_AFTER_MS = 60_000;
export const DEFAULT_RETENTION_DAYS = 14;

const text = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

// Path overrides are trimmed, may start with ~/, and lose trailing separators.
// The result is not resolved here: callers that need an absolute path resolve
// it (configDir) while task-store roots keep their relative form until the
// descriptor builder canonicalizes them.
function pathValue(value) {
  const trimmed = text(value);
  if (!trimmed) return undefined;
  const expanded = expandHome(trimmed);
  const cleaned = expanded.replace(/[\\/]+$/, '');
  return cleaned || expanded;
}

function configDirFrom(value) {
  const configured = text(value);
  if (!configured) return join(homedir(), '.config', 'nero-herdr-dag');
  return resolve(expandHome(configured));
}

// A non-positive, empty or malformed threshold is not useful, so it falls
// back to the documented default instead of disabling staleness checks.
function staleAfterMsFrom(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_STALE_AFTER_MS;
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return DEFAULT_STALE_AFTER_MS;
  return Math.max(1, Math.floor(milliseconds));
}

// Retention is deliberately different: any invalid value disables pruning (0)
// rather than guessing a window and deleting the user's snapshots.
function retentionDaysFrom(value) {
  const trimmed = value === undefined || value === null ? '' : String(value).trim();
  if (!trimmed) return DEFAULT_RETENTION_DAYS;
  const days = Number(trimmed);
  if (!Number.isFinite(days) || days <= 0) return 0;
  return days;
}

function taskStateDirsFrom(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(delimiter).map(pathValue).filter(Boolean);
}

export function readEnv(env = process.env) {
  const agentDir = text(env?.OMO_CODING_AGENT_DIR) ??
    text(env?.SENPI_CODING_AGENT_DIR) ??
    join(homedir(), '.omo', 'agent');
  const stateDir = env?.OMO_HERDR_DAG_STUDIO_STATE_DIR;

  return Object.freeze({
    agentDir,
    staleAfterMs: staleAfterMsFrom(env?.OMO_HERDR_DAG_STUDIO_STALE_MS),
    retentionDays: retentionDaysFrom(env?.OMO_HERDR_DAG_STUDIO_RETENTION_DAYS),
    configDir: configDirFrom(env?.NERO_HERDR_DAG_CONFIG_DIR),
    stateDir: stateDir === undefined || stateDir === null ? join(agentDir, 'herdr-dag-studio') : stateDir,
    taskStateDirs: taskStateDirsFrom(env?.OMO_HERDR_DAG_STUDIO_TASK_STATE_DIRS),
    taskStateDir: pathValue(env?.OMO_HERDR_DAG_STUDIO_TASK_STATE_DIR),
    runtime: text(env?.OMO_HERDR_DAG_STUDIO_RUNTIME) || text(env?.OMO_HERDR_DAG_STUDIO_NODE),
    omoSettings: text(env?.OMO_HERDR_DAG_STUDIO_OMO_SETTINGS) ?? text(env?.NERO_HERDR_DAG_OMO_SETTINGS),
    herdrBinPath: text(env?.HERDR_BIN_PATH),
    herdrEnabled: env?.HERDR_ENV === '1',
    herdrPaneId: env?.HERDR_PANE_ID,
    herdrSocketPath: env?.HERDR_SOCKET_PATH,
    path: env?.PATH ?? '',
    pager: typeof env?.PAGER === 'string' ? env.PAGER : undefined,
  });
}
