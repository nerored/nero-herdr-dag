import { open } from 'node:fs/promises';
import { TERMINAL } from './model.mjs';

// A snapshot is data, not a trusted program: cap what the viewer will load and
// map so a hostile or accidental high-cardinality file cannot exhaust memory
// before normalization rejects it.
const MAX_STATE_BYTES = 64 * 1024 * 1024;

export const SNAPSHOT_LIMITS = Object.freeze({
  runs: 256,
  tasks: 8_192,
  nodesPerRun: 4_096,
  edgesPerRun: 16_384,
  rateSamples: 32,
});

export class ViewerSnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ViewerSnapshotError';
  }
}

// Read with a hard byte ceiling. The handle is opened first so the size check
// and the bounded read happen against the same descriptor; a file that grows
// between stat and read is still truncated to the cap and rejected.
export async function readStateFile(path, { maxBytes = MAX_STATE_BYTES, openFn = open } = {}) {
  const handle = await openFn(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ViewerSnapshotError(`${path} is not a regular file`);
    if (info.size > maxBytes) {
      throw new ViewerSnapshotError(`snapshot is ${info.size} bytes (limit ${maxBytes})`);
    }
    const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) {
      throw new ViewerSnapshotError(`snapshot read exceeded ${maxBytes} bytes`);
    }
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}

function boundedRate(value) {
  return Array.isArray(value) && value.length > SNAPSHOT_LIMITS.rateSamples
    ? value.slice(-SNAPSHOT_LIMITS.rateSamples)
    : value;
}

function boundedRateSubject(subject) {
  if (!subject || typeof subject !== 'object') return subject;
  const tokenRate = boundedRate(subject.tokenRate);
  const tokenRateHistory = boundedRate(subject.tokenRateHistory);
  if (tokenRate === subject.tokenRate && tokenRateHistory === subject.tokenRateHistory) return subject;
  return { ...subject, tokenRate, tokenRateHistory };
}

// Bound the array cardinality before normalizeSnapshot maps it. Count caps fail
// closed (a caller sees a distinct invalid-snapshot result); rate histories keep
// only the tail the normalizer actually uses.
export function boundSnapshotInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ViewerSnapshotError('snapshot must be a JSON object');
  }
  if (!Array.isArray(raw.runs)) throw new ViewerSnapshotError('snapshot is missing runs[]');
  if (raw.runs.length > SNAPSHOT_LIMITS.runs) {
    throw new ViewerSnapshotError(`snapshot has ${raw.runs.length} runs (limit ${SNAPSHOT_LIMITS.runs})`);
  }
  if (raw.tasks !== undefined && !Array.isArray(raw.tasks)) {
    throw new ViewerSnapshotError('snapshot tasks must be an array');
  }
  if ((raw.tasks?.length ?? 0) > SNAPSHOT_LIMITS.tasks) {
    throw new ViewerSnapshotError(`snapshot has ${raw.tasks.length} tasks (limit ${SNAPSHOT_LIMITS.tasks})`);
  }
  let changed = false;
  const runs = raw.runs.map(run => {
    if (!run || typeof run !== 'object') return run;
    if (Array.isArray(run.nodes) && run.nodes.length > SNAPSHOT_LIMITS.nodesPerRun) {
      throw new ViewerSnapshotError(`run ${run.id ?? '?'} has ${run.nodes.length} nodes (limit ${SNAPSHOT_LIMITS.nodesPerRun})`);
    }
    if (Array.isArray(run.edges) && run.edges.length > SNAPSHOT_LIMITS.edgesPerRun) {
      throw new ViewerSnapshotError(`run ${run.id ?? '?'} has ${run.edges.length} edges (limit ${SNAPSHOT_LIMITS.edgesPerRun})`);
    }
    let runChanged = false;
    const nodes = Array.isArray(run.nodes)
      ? run.nodes.map(node => {
        const bounded = boundedRateSubject(node);
        if (bounded !== node) runChanged = true;
        return bounded;
      })
      : run.nodes;
    if (!runChanged) return run;
    changed = true;
    return { ...run, nodes };
  });
  let tasks = raw.tasks;
  if (Array.isArray(tasks)) {
    let tasksChanged = false;
    tasks = tasks.map(task => {
      const bounded = boundedRateSubject(task);
      if (bounded !== task) tasksChanged = true;
      return bounded;
    });
    if (tasksChanged) changed = true;
    else tasks = raw.tasks;
  }
  if (!changed) return raw;
  return { ...raw, runs, tasks };
}

// The placeholder uses sessionId 'pending'; preferences must never be loaded or
// saved under it, and a real snapshot may arrive with a different session id.
export function viewSessionKey(snapshot) {
  const id = snapshot?.sessionId;
  return typeof id === 'string' && id.length > 0 && id !== 'pending' ? id : undefined;
}

const HIDDEN_TERMINAL_STATUSES = TERMINAL;

// Hidden ids are a per-session convenience, not a permanent tombstone. An id
// that reappears as a non-terminal subject (a demo cycle reusing its ids, or a
// live session restarting a task) must become visible again.
export function pruneHiddenSubjects(ui, state) {
  if (!ui || !state) return;
  const runs = new Map((state.runs ?? []).map(run => [run.id, run]));
  for (const id of [...(ui.hiddenRunIds ?? [])]) {
    const run = runs.get(id);
    if (run && !HIDDEN_TERMINAL_STATUSES.has(run.status)) ui.hiddenRunIds.delete(id);
  }
  const tasks = new Map((state.tasks ?? []).map(task => [task.id, task]));
  for (const id of [...(ui.hiddenTaskIds ?? [])]) {
    const task = tasks.get(id);
    if (task && !HIDDEN_TERMINAL_STATUSES.has(task.status)) ui.hiddenTaskIds.delete(id);
  }
}

// A failed read is durable evidence, not just a toast: the WAITING placeholder
// keeps the watched path and the last read error until a read succeeds.
export function failedReadPlaceholder(path, error, { view = 'watch', now = Date.now() } = {}) {
  const message = typeof error === 'string' ? error : error?.message;
  return {
    version: 3, sessionId: 'pending', mode: 'live', connected: false,
    generatedAt: new Date(now).toISOString(),
    provenance: {
      origin: 'viewer-placeholder',
      view,
      ...(path ? { statePath: path } : {}),
    },
    ...(message ? { readError: message } : {}),
    runs: [], tasks: [], sources: [],
  };
}

// Pure failure branch of loadState. The viewer keeps the last read error and
// refreshes the WAITING placeholder until a later read succeeds; exporting the
// decision keeps that lifecycle covered without a live watcher.
export function readFailureEvidence(snapshot, error) {
  const message = typeof error === 'string' ? error : error?.message;
  return {
    lastReadError: message,
    placeholder: snapshot?.provenance?.origin === 'viewer-placeholder'
      ? { ...snapshot, readError: message }
      : undefined,
  };
}

// A state key absent from the previous signature is a baseline observation,
// not a transition. An imported/historical run, a file replaced by another
// writer, or a run removed and re-added was never observed changing while this
// viewer watched, so it must not emit completion/failure/start toasts.
export function transitionChanges(previous, current) {
  if (!previous) return [];
  const changes = [];
  for (const run of current.runs) {
    for (const node of run.nodes) {
      const key = `${run.id}:${node.id}`;
      const before = previous.get(key);
      if (before === undefined || before === node.state) continue;
      if (node.state === 'completed' || node.state === 'failed' || node.state === 'running') {
        changes.push({ key, kind: 'node', label: node.label, state: node.state });
      }
    }
  }
  for (const task of current.tasks) {
    if (task.parentTaskId) continue;
    const key = `task:${task.id}`;
    const before = previous.get(key);
    if (before === undefined || before === task.status) continue;
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'running') {
      changes.push({ key, kind: 'task', label: task.description, state: task.status });
    }
  }
  return changes;
}
