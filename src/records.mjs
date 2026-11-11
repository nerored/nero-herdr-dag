import { statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { modeFor } from './model.mjs';
import { absolutePath, safeFileWithin } from './safe-path.mjs';

// A raw record is one task/checkpoint JSON document. Keep the read surface
// bounded so a hostile store cannot stream an arbitrary file into the terminal.
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const defined = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

// Record roots come from snapshot provenance or a store descriptor and are
// always absolute, control-free paths. Everything below the root is derived.
export function recordRoot(value) {
  return absolutePath(value);
}

export function relativeDisplay(root, absolute) {
  if (!root || !absolute) return undefined;
  const value = relative(root, absolute);
  if (!value || value.startsWith('..') || isAbsolute(value)) return basename(absolute);
  return value.split(sep).join('/');
}

export function recordEntry(key, root, absolute) {
  if (!root || !absolute) return undefined;
  return defined({
    key,
    absolute,
    root,
    display: relativeDisplay(root, absolute),
    name: basename(absolute),
  });
}

// Apply the containment gate first, then the 4 MiB cap on the resolved target.
// Both the open action and the diagnosis card use this one policy.
export function safeRecordPath(root, candidate, { stat = statSync } = {}) {
  const safe = safeFileWithin(root, candidate);
  if (!safe) return undefined;
  try {
    return stat(safe).size > MAX_RECORD_BYTES ? undefined : safe;
  } catch {
    return undefined;
  }
}

// A task/run carries the id of the store it was read from. Resolve that id
// against snapshot.sources[] instead of assuming the primary provenance root:
// a historical task from the host project store must not be opened through a
// different store root. `live`/`cache` are synthetic ids with no on-disk descriptor,
// so they keep the legacy provenance fallback.
const SYNTHETIC_SOURCE = new Set(['live', 'cache']);

function sourceStoreRoots(snapshot) {
  const roots = new Map();
  for (const source of snapshot?.sources ?? []) {
    if (!source?.id || roots.has(source.id)) continue;
    const root = recordRoot(source.root);
    if (root) roots.set(source.id, root);
  }
  return roots;
}

function sourceStoreRoot(sourceId, roots, fallback) {
  if (!sourceId || SYNTHETIC_SOURCE.has(sourceId)) return fallback;
  return roots.get(sourceId);
}

// Resolve the first readable task/checkpoint record with the same gates the
// `o` action uses: per-source root, 4 MiB cap, regular JSON file. Keeping the
// winning key lets a caller tell the task record (which carries the full
// final_response) from the checkpoint fallback.
export function resolveRecordPath(records) {
  for (const entry of records ?? []) {
    if (entry.key !== 'task' && entry.key !== 'checkpoint') continue;
    const path = safeRecordPath(entry.root, entry.absolute);
    if (path) return { key: entry.key, path };
  }
  return undefined;
}

export function recordTargetFor(snapshot, { run, node, task, subject, kind } = {}) {
  const subjectKind = kind ?? (subject === 'task' || (!node && task) ? 'task' : 'node');
  const entity = subjectKind === 'task' ? task : node;
  if (!entity) return null;
  const taskEntity = subjectKind === 'task' ? task : (node?.task ?? task);
  const taskId = taskEntity?.id ?? node?.taskId;
  const mode = modeFor(snapshot);
  const simulated = mode === 'demo';
  const fallbackRoot = simulated ? undefined : recordRoot(snapshot?.provenance?.taskStateDir);
  const roots = simulated ? new Map() : sourceStoreRoots(snapshot);
  const taskRoot = sourceStoreRoot(taskEntity?.source, roots, fallbackRoot);
  const runRoot = sourceStoreRoot(run?.source, roots, fallbackRoot);
  const records = [];
  if (taskRoot && taskId && SAFE_RECORD_ID.test(taskId)) {
    records.push({
      key: 'task',
      root: taskRoot,
      absolute: join(taskRoot, 'tasks', `${taskId}.json`),
      display: `tasks/${taskId}.json`,
    });
  }
  if (runRoot && run?.id && SAFE_RECORD_ID.test(run.id)) {
    records.push({
      key: 'checkpoint',
      root: runRoot,
      absolute: join(runRoot, 'dag', 'runs', `${run.id}.json`),
      display: `dag/runs/${run.id}.json`,
    });
  }
  const open = resolveRecordPath(records);
  return {
    kind: subjectKind,
    id: subjectKind === 'task' ? task?.id : node?.id,
    taskId,
    state: subjectKind === 'task' ? task?.status : node?.state,
    mode,
    simulated,
    records,
    openPath: open?.path,
    openKey: open?.key,
    owner: 'OmO',
  };
}

// Revalidate on every call so a record removed after the frame was drawn cannot
// become a stale open.
export function recordForKey(key, record) {
  if (key !== 'o' || !record) return null;
  const open = resolveRecordPath(record.records);
  return open
    ? { kind: 'open', path: open.path }
    : { kind: 'unavailable', reason: 'no-safe-record' };
}
