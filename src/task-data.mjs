import { constants, watch, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { BoundedCache, BoundedKeySet } from './bounded-cache.mjs';
import { lstat, open, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { clean, graphemeSlice } from './text.mjs';
import { normalizeTask, TERMINAL } from './model.mjs';
import { normalizeRateHistory } from './evidence.mjs';
import { iso } from './normalize.mjs';
import { projectKey } from './omo.mjs';
import { readEnv } from './env.mjs';

const taskId = value => typeof value === 'string' && /^st_[A-Za-z0-9_-]{1,253}$/.test(value);
// Notifications are rendered as-is by the host UI, so strip terminal control
// sequences and cap length before interpolating record names or fs errors.
const notifyText = (value, limit = 240) => graphemeSlice(clean(value), limit);
const ACTIVE = new Set(['pending', 'running']);
const SCAN_BATCH = 8;
// The legacy flat store can hold arbitrarily many sessions. Cap the probe so
// automatic path resolution cannot synchronously parse an unbounded directory.
const LEGACY_PROBE_MAX_FILES = 2048;
// Task stores are repo-controlled, so a record name may be a symlink, FIFO,
// or huge file. Refuse anything above this size before reading a byte.
const MAX_TASK_RECORD_BYTES = 4 * 1024 * 1024;
// A running task can report the same rate continuously. Sample at most once
// per second so the chart has a time axis without turning every duplicate
// merge into a bar.
const RATE_SAMPLE_MS = 1000;

// Session-lifetime caches and their documented caps. The task store itself is
// not a cache (`entries` mirrors the selectable records), but everything kept
// *around* those records is keyed by ids that can disappear or be fabricated:
// - cache/live: restored or live-overlay entries kept between refreshes. The
//   caps match SNAPSHOT_LIMITS.tasks, so a snapshot the viewer accepts cannot
//   lose a record to eviction; only a longer out-of-band payload is trimmed.
// - rate*: one series/seen/source marker per task id, pruned against the
//   visible entries after every refresh; the cap is the backstop for a session
//   that never reaches that prune (watcher-only live overlays) or a store that
//   keeps producing new ids.
// - warnings: one coalescing key per store/record failure. Recency matters
//   (a store that fails every refresh should not re-notify forever), so a key
//   evicted after TASK_DATA_LIMITS.warnings newer failures may notify once
//   more.
// - legacyProbes: module-level root+session scan cache; root/session keys are
//   small but unbounded across a directory tree, so keep the newest probes.
export const TASK_DATA_LIMITS = Object.freeze({
  cacheEntries: 8_192,
  liveEntries: 8_192,
  rateTaskIds: 8_192,
  rateSamples: 32,
  warnings: 256,
  legacyProbes: 64,
});

function pathValue(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const expanded = trimmed === '~' ? homedir() : trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed;
  const cleaned = expanded.replace(/[\\/]+$/, '');
  return cleaned || expanded;
}

// A root that cannot be canonicalized still contributes a descriptor (the
// absolute path is a safe fallback), but the failure is not discarded: the
// descriptor carries a bounded reason and the caller reports it once. ENOENT
// is the normal not-yet-created store, so it stays silent.
function canonicalPath(value) {
  const absolute = resolve(pathValue(value) ?? value);
  try { return { root: realpathSync.native(absolute) }; }
  catch (error) { return { root: absolute, error }; }
}

const ignorableRootError = error => error?.code === 'ENOENT';

function rootDescriptor(root, origin = 'explicit', label = 'explicit store', report) {
  const canonical = canonicalPath(root);
  const id = `${origin}-${createHash('sha256').update(canonical.root).digest('hex').slice(0, 8)}`;
  const failed = canonical.error && !ignorableRootError(canonical.error);
  if (failed) report?.({ id, root: canonical.root, phase: 'canonical-path', error: canonical.error });
  return {
    id,
    label,
    origin,
    root: canonical.root,
    ...(failed ? { error: notifyText(canonical.error.message, 512) } : {}),
  };
}

function dedupeRoots(descriptors) {
  const seen = new Set();
  const roots = [];
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.root)) continue;
    seen.add(descriptor.root);
    roots.push(descriptor);
  }
  return roots;
}

function normalizeDescriptors(list, report) {
  return dedupeRoots(list.map(entry => {
    if (typeof entry === 'string') return rootDescriptor(entry, 'explicit', 'explicit store', report);
    const descriptor = rootDescriptor(entry?.root ?? entry, entry?.origin ?? 'explicit', entry?.label ?? 'explicit store', report);
    return typeof entry?.id === 'string' && entry.id ? { ...descriptor, id: entry.id } : descriptor;
  }));
}

function explicitRoots(env) {
  const { taskStateDirs, taskStateDir } = readEnv(env);
  if (taskStateDirs.length) return taskStateDirs;
  return taskStateDir ? [taskStateDir] : [];
}

function sessionRoot(sessionFile) {
  const session = pathValue(sessionFile);
  if (!session) return undefined;
  const normalized = session.replace(/\\/g, '/');
  const index = normalized.indexOf('/senpi-task/');
  if (index > 0) return normalized.slice(0, index + '/senpi-task'.length);
  if (normalized.endsWith('/senpi-task')) return normalized;
  return undefined;
}

// Probe results are keyed by store + session and tied to the tasks directory
// mtime: repeated resolutions re-read nothing while the directory is stable,
// and a newly written record invalidates the cached negative result. The scan
// itself is bounded so a large legacy store cannot stall session_start.
const legacyProbes = new BoundedCache(TASK_DATA_LIMITS.legacyProbes, { name: 'legacy-probes' });

export function legacyProbeStats() {
  return legacyProbes.stats();
}

function storeHasSessionTasks(root, sessionId, report) {
  if (!sessionId) return false;
  const directory = join(root, 'tasks');
  let mtimeMs;
  try { mtimeMs = statSync(directory).mtimeMs; }
  catch (error) {
    if (!ignorableRootError(error)) report?.({ root, phase: 'probe', error });
    mtimeMs = undefined;
  }
  const key = `${root}\u0000${sessionId}`;
  const cached = legacyProbes.get(key);
  if (cached && cached.mtimeMs === mtimeMs) return cached.found;
  const probe = { found: false, mtimeMs };
  legacyProbes.set(key, probe);
  if (mtimeMs === undefined) return false;
  let files;
  try { files = readdirSync(directory); }
  catch (error) {
    if (!ignorableRootError(error)) report?.({ root, phase: 'probe', error });
    return false;
  }
  let examined = 0;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    if (examined >= LEGACY_PROBE_MAX_FILES) break;
    examined++;
    try {
      const info = statSync(join(directory, file));
      if (!info.isFile() || info.size > MAX_TASK_RECORD_BYTES) continue;
      const raw = JSON.parse(readFileSync(join(directory, file), 'utf8'));
      if (raw?.parent_session_id === sessionId) {
        probe.found = true;
        break;
      }
    } catch { /* ignore unreadable candidates while probing */ }
  }
  return probe.found;
}

// Read one task record without following symlinks and without trusting the
// directory entry's apparent size. lstat rejects the obvious cases before open
// (a FIFO would otherwise block); O_NOFOLLOW closes the lstat/open race; the
// descriptor re-check and bounded read keep memory independent of file size.
async function readTaskRecord(directory, name) {
  const path = join(directory, name);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error('task record is a symlink');
  if (!info.isFile()) throw new Error('task record is not a regular file');
  if (info.size > MAX_TASK_RECORD_BYTES) throw new Error(`task record exceeds ${MAX_TASK_RECORD_BYTES} bytes`);
  let handle;
  try {
    // O_NONBLOCK keeps a FIFO swapped in after lstat from blocking open; the
    // descriptor check below then rejects it.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error('task record is not a regular file');
    if (opened.size > MAX_TASK_RECORD_BYTES) throw new Error(`task record exceeds ${MAX_TASK_RECORD_BYTES} bytes`);
    const buffer = Buffer.allocUnsafe(Math.min(opened.size, MAX_TASK_RECORD_BYTES) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_TASK_RECORD_BYTES) throw new Error(`task record exceeds ${MAX_TASK_RECORD_BYTES} bytes`);
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
  } finally {
    await handle.close();
  }
}

// Resolve every read-only task/DAG store candidate for this session, in
// precedence order. Explicit roots are exclusive; automatic roots are the
// current session's marked project store, the session-derived store, and the
// host project store. The project store is accepted only when `.omo/senpi-task`
// carries the `.in-project` marker AND already holds a record for this session;
// a cloned repository's arbitrary store still cannot feed DAG Studio data.
function projectLocalRoot(cwd, sessionId, report) {
  if (!sessionId) return undefined;
  const working = pathValue(cwd);
  if (!working) return undefined;
  const root = join(working, '.omo', 'senpi-task');
  try {
    const marker = statSync(join(root, '.in-project'));
    if (!marker.isFile()) return undefined;
  } catch {
    return undefined;
  }
  return storeHasSessionTasks(root, sessionId, report) ? root : undefined;
}

export function resolveTaskStateDirs({
  sessionFile, env = process.env, cwd = process.cwd(), stateDirs, sessionId, onProblem,
} = {}) {
  if (Array.isArray(stateDirs) && stateDirs.length) return normalizeDescriptors(stateDirs, onProblem);
  const explicit = explicitRoots(env);
  if (explicit.length) return normalizeDescriptors(explicit, onProblem);

  const candidates = [];
  const working = pathValue(cwd) ?? process.cwd();
  const inProject = projectLocalRoot(working, sessionId, onProblem);
  if (inProject) candidates.push(rootDescriptor(inProject, 'session', 'project store', onProblem));
  const derived = sessionRoot(sessionFile);
  if (derived) candidates.push(rootDescriptor(derived, 'session', 'session store', onProblem));
  const { agentDir } = readEnv(env);
  candidates.push(rootDescriptor(join(agentDir, 'projects', projectKey(working), 'senpi-task'), 'agent-project', 'host store', onProblem));
  const legacy = join(agentDir, 'senpi-task');
  if (storeHasSessionTasks(legacy, sessionId, onProblem)) {
    candidates.push(rootDescriptor(legacy, 'agent', 'agent store', onProblem));
  }
  // Every candidate was canonicalized once above; dedupe instead of rebuilding
  // descriptors so a root failure is reported only once.
  return dedupeRoots(candidates);
}

// Compatibility wrapper: the first candidate is the store the viewer used
// before multi-store aggregation existed.
export function resolveTaskStateDir(options = {}) {
  const roots = resolveTaskStateDirs(options);
  if (roots[0]) return roots[0].root;
  const working = pathValue(options.cwd) ?? process.cwd();
  const { agentDir } = readEnv(options.env);
  return join(agentDir, 'projects', projectKey(working), 'senpi-task');
}

// The host store and the snapshot path share one task normalizer. The wrapper
// keeps the task-id gate the flat store has always enforced.
export function normalizeOmOTask(raw) {
  if (!raw || !taskId(raw.task_id)) return null;
  return normalizeTask(raw, { host: true });
}

function compareTaskVersions(candidate, current) {
  if (candidate.updatedAt || current.updatedAt) {
    if (!candidate.updatedAt) return -1;
    if (!current.updatedAt) return 1;
    if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt > current.updatedAt ? 1 : -1;
  }
  if (candidate.taskSeq !== undefined || current.taskSeq !== undefined) {
    if (candidate.taskSeq === undefined) return -1;
    if (current.taskSeq === undefined) return 1;
    if (candidate.taskSeq !== current.taskSeq) return candidate.taskSeq > current.taskSeq ? 1 : -1;
  }
  return 0;
}

function variantOfTask(entry) {
  return Object.fromEntries(Object.entries({
    source: entry.source,
    updatedAt: entry.updatedAt,
    taskSeq: entry.taskSeq,
    status: entry.task.status,
  }).filter(([, value]) => value !== undefined));
}

function addVariant(target, variant) {
  if (!variant.source || variant.source === target.source) return;
  const variants = (target.variants ?? []).filter(entry => entry.source !== variant.source);
  target.variants = [...variants, variant];
}

// Merge two entry lists that are already in map order, without duplicates.
// A task can match its parent through both parent_task_id and child_session_id.
function mergeChildMatches(left = [], right = []) {
  if (!left.length) return right;
  if (!right.length) return left;
  const merged = [];
  let l = 0;
  let r = 0;
  while (l < left.length || r < right.length) {
    if (r >= right.length || (l < left.length && left[l].index < right[r].index)) {
      merged.push(left[l++]);
    } else if (l >= left.length || right[r].index < left[l].index) {
      merged.push(right[r++]);
    } else {
      merged.push(left[l++]);
      r++;
    }
  }
  return merged;
}

export class TaskData {
  constructor({ cwd = process.cwd(), sessionId, stateDir, stateDirs, env = process.env,
    notify = message => console.warn(message), onChange = () => {} } = {}) {
    Object.assign(this, { sessionId, notify, onChange });
    // warnOnce() is used while resolving roots, so the dedupe set exists before
    // the first descriptor can fail to canonicalize. It is capped: a long
    // session may see unbounded distinct failure keys, but only the newest
    // TASK_DATA_LIMITS.warnings coalescing keys are retained.
    this.warnings = new BoundedKeySet(TASK_DATA_LIMITS.warnings, { name: 'task-warnings' });
    const report = problem => this.reportStoreProblem(problem);
    this.directories = Array.isArray(stateDirs) && stateDirs.length
      ? normalizeDescriptors(stateDirs, report)
      : stateDir
        ? normalizeDescriptors([stateDir], report)
        : resolveTaskStateDirs({ cwd, sessionId, env, onProblem: report });
    this.entries = new Map();
    // childSessionId -> number of entries in this.entries. receive() checks it
    // per live payload instead of copying and scanning every record.
    this.childSessions = new Map();
    this.indexedEntries = this.entries;
    this.cache = new BoundedCache(TASK_DATA_LIMITS.cacheEntries, { name: 'task-cache' });
    this.live = new BoundedCache(TASK_DATA_LIMITS.liveEntries, { name: 'task-live' });
    this.rateHistory = new BoundedCache(TASK_DATA_LIMITS.rateTaskIds, { name: 'rate-history' });
    this.rateSeen = new BoundedCache(TASK_DATA_LIMITS.rateTaskIds, { name: 'rate-seen' });
    this.rateSources = new BoundedCache(TASK_DATA_LIMITS.rateTaskIds, { name: 'rate-sources' });
    this.sourceStatuses = [];
    this.staleCache = 0;
    this.stopped = false;
    this.watchers = new Map();
    this.watchedDirectories = new Map();
    this.watchRetryTimers = new Map();
    this.watchAttempts = new Map();
  }

  get sources() {
    return this.sourceStatuses;
  }

  // Read-only cache inventory for scripts/bench.mjs and the memory tests.
  // `entries` mirrors the selectable store records (not a cache); everything
  // else reports its documented cap, current size and eviction total.
  memoryStats() {
    return {
      entries: this.entries.size,
      childSessions: this.childSessions.size,
      cache: this.cache.stats(),
      live: this.live.stats(),
      rateHistory: this.rateHistory.stats(),
      rateSeen: this.rateSeen.stats(),
      rateSources: this.rateSources.stats(),
      warnings: this.warnings.stats(),
    };
  }

  // Keep one timestamped rate series per task. A changed rate always extends
  // the series; a repeated rate only extends it when the producer revision
  // advances or a live observation passes the sampling interval. This is what
  // makes a constant rate visible as a time series instead of one character.
  rememberRate(task, raw, source, now = Date.now()) {
    const value = task.tokenRate?.at?.(-1);
    // A series belongs to one winning store. When a different store's record
    // takes over, start from that record's own history so the stale store's
    // last sample cannot linger in (or alternate through) the visible series.
    const previousSource = this.rateSources.get(task.id);
    const switchingStore = source !== 'live' && previousSource !== undefined &&
      previousSource !== 'live' && previousSource !== source;
    // The stored series is shared with the task that currently wins a merge, so
    // it is never mutated: a losing candidate must not extend it. Reusing it as
    // is when no sample is appended keeps the 10Hz sampler allocation free; the
    // copy happens only on the append path below.
    let prior = switchingStore ? undefined : this.rateHistory.get(task.id);
    if (!prior) prior = normalizeRateHistory(task.tokenRateHistory) ?? [];
    if (value === undefined) {
      if (prior.length) task.tokenRateHistory = prior;
      return;
    }
    const observedAt = iso(raw?.updated_at) ?? iso(task.updatedAt) ?? iso(task.completedAt);
    const observedMs = observedAt ? Date.parse(observedAt) : undefined;
    const last = prior.at(-1);
    const lastMs = last?.at ? Date.parse(last.at) : undefined;
    const seen = this.rateSeen.get(task.id);
    const advanced = observedMs !== undefined && lastMs !== undefined && observedMs > lastMs;
    const liveTick = source === 'live' && ACTIVE.has(task.status) &&
      (seen?.wall === undefined || now - seen.wall >= RATE_SAMPLE_MS);
    if (last && last.rate === value && !advanced && !liveTick) {
      task.tokenRateHistory = prior;
      this.rateHistory.set(task.id, prior);
      this.rateSources.set(task.id, source);
      return;
    }
    const at = advanced || !last ? (observedAt ?? new Date(now).toISOString()) : new Date(now).toISOString();
    // One copy for the append, then trim in place: prior may be the shared
    // stored series and the retained history must stay immutable for losers.
    const history = [...prior, { at, rate: value }];
    if (history.length > TASK_DATA_LIMITS.rateSamples) {
      history.splice(0, history.length - TASK_DATA_LIMITS.rateSamples);
    }
    task.tokenRateHistory = history;
    this.rateHistory.set(task.id, history);
    this.rateSeen.set(task.id, { at, rate: value, wall: now });
    this.rateSources.set(task.id, source);
    if (history.length > 1) {
      task.tokenRate = history.map(sample => sample.rate);
      task.tokenRateKind = 'history';
    }
  }

  // Rate histories, sample timestamps and winning-source markers follow the
  // entries a snapshot can still show. Called after every refresh/save so ids
  // that leave the store do not retain series forever. Returns the number of
  // map entries removed across the rate maps.
  pruneRates(keep) {
    const ids = keep instanceof Set ? keep : new Set(keep ?? []);
    let removed = 0;
    for (const map of [this.rateHistory, this.rateSeen, this.rateSources]) {
      for (const id of map.keys()) {
        if (ids.has(id)) continue;
        map.delete(id);
        removed++;
      }
    }
    return removed;
  }

  // Periodic fallback for a task whose producer keeps emitting the same rate
  // or stops writing between events. Returns true when any series grew.
  sampleRates(now = Date.now()) {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (!ACTIVE.has(entry.task?.status) || entry.task.tokenRate === undefined) continue;
      const before = entry.task.tokenRateHistory?.length ?? 0;
      this.rememberRate(entry.task, entry.raw ?? {}, 'live', now);
      if ((entry.task.tokenRateHistory?.length ?? 0) > before) changed = true;
    }
    return changed;
  }

  warnOnce(key, message) {
    if (this.warnings.has(key)) return;
    this.warnings.add(key);
    this.notify(message);
  }

  // Root resolution happens before the first refresh, so a probe or realpath
  // failure needs the same one-warning channel. The key matches refresh()'s
  // store key when an id exists, so a root that fails both steps warns once.
  reportStoreProblem({ id, root, phase, error }) {
    const message = `DAG Studio: Cannot inspect task store ${notifyText(root, 1024)}: ${notifyText(error?.message ?? error, 512)}`;
    this.warnOnce(id ? `tasks:${id}` : `store:${notifyText(root, 1024)}:${phase ?? 'inspect'}`, message);
  }

  restore(tasks = []) {
    // The restored cache mirrors a saved snapshot, which the viewer bounds to
    // SNAPSHOT_LIMITS.tasks. The LRU cap is the backstop for a hand-built or
    // corrupt state file; the oldest restored ids are dropped first.
    for (const raw of Array.isArray(tasks) ? tasks : []) {
      if (!raw || !taskId(raw.id)) continue;
      const isChild = taskId(raw.parentTaskId);
      this.cache.set(raw.id, {
        task: { ...raw, id: raw.id },
        parentSessionId: isChild ? undefined : this.sessionId,
        ...(isChild ? { parentTaskId: raw.parentTaskId } : {}),
        ...(typeof raw.childSessionId === 'string' ? { childSessionId: raw.childSessionId } : {}),
        ...(iso(raw.updatedAt ?? raw.completedAt) ? { updatedAt: iso(raw.updatedAt ?? raw.completedAt) } : {}),
        ...(Number.isSafeInteger(raw.taskSeq) ? { taskSeq: raw.taskSeq } : {}),
        source: 'cache',
        ...(Array.isArray(raw.variants) ? { variants: raw.variants } : {}),
      });
    }
  }

  // Keep the child-session index in step with this.entries. Every write to the
  // entry map goes through here so refresh/merge cannot desynchronize it; a map
  // swapped in from outside is re-indexed on first use.
  storeEntry(map, id, entry) {
    if (map === this.entries) {
      const previous = map.get(id);
      this.ensureChildSessionIndex();
      // Every entry tallies exactly one under its childSessionId, undefined
      // included, so the check matches a full scan of the entries.
      if (previous !== undefined) this.adjustChildSession(previous?.childSessionId, -1);
      this.adjustChildSession(entry?.childSessionId, 1);
    }
    map.set(id, entry);
  }

  adjustChildSession(session, delta) {
    const next = (this.childSessions.get(session) ?? 0) + delta;
    if (next > 0) this.childSessions.set(session, next);
    else this.childSessions.delete(session);
  }

  ensureChildSessionIndex() {
    if (this.indexedEntries === this.entries) return;
    this.childSessions = new Map();
    this.indexedEntries = this.entries;
    for (const [, entry] of this.entries) this.adjustChildSession(entry?.childSessionId, 1);
  }

  // Exact equivalent of scanning entries for a matching childSessionId,
  // including the legacy undefined-session membership, without the copy.
  acceptsSession(session) {
    if (session === this.sessionId) return true;
    this.ensureChildSessionIndex();
    return (this.childSessions.get(session) ?? 0) > 0;
  }

  // Merge one record into a map, selecting a whole record per task id. Fields
  // are only merged when the record comes from the same source; across stores
  // the winner stays intact and the loser becomes variant metadata.
  mergeEntry(map, raw, task, source, parentSessionId = raw?.parent_session_id ?? this.sessionId) {
    const candidate = {
      task,
      parentSessionId,
      ...(iso(raw?.updated_at) ?? iso(task.completedAt) ?? iso(raw?.terminal_at)
        ? { updatedAt: iso(raw?.updated_at) ?? iso(task.completedAt) ?? iso(raw?.terminal_at) }
        : {}),
      ...(Number.isSafeInteger(raw?.task_seq) ? { taskSeq: raw.task_seq } : {}),
      ...(typeof raw?.child_session_id === 'string' ? { childSessionId: raw.child_session_id } : {}),
      ...(taskId(raw?.parent_task_id) ? { parentTaskId: raw.parent_task_id } : {}),
      source,
      ...(raw ? { raw } : {}),
    };
    const previous = map.get(task.id);
    if (!previous) {
      this.rememberRate(candidate.task, raw, source);
      this.storeEntry(map, task.id, candidate);
      return candidate;
    }
    const order = compareTaskVersions(candidate, previous);
    // The live producer omits task_seq (omo-task.js C3), so a live snapshot at
    // the same persisted revision compares as older. Treat that as a same-version
    // overlay while both records are active; a defined newer/lower task_seq is
    // still ordered normally.
    const liveSameVersion = source === 'live' && order <= 0 &&
      (candidate.taskSeq === undefined || candidate.taskSeq === previous.taskSeq) &&
      candidate.updatedAt !== undefined && candidate.updatedAt === previous.updatedAt &&
      ACTIVE.has(previous.task.status) && ACTIVE.has(task.status);
    if (order < 0 && !liveSameVersion) {
      addVariant(previous, variantOfTask(candidate));
      return previous;
    }
    if (liveSameVersion) {
      const entry = {
        ...candidate,
        ...(candidate.taskSeq === undefined && previous.taskSeq !== undefined ? { taskSeq: previous.taskSeq } : {}),
        ...(previous.childSessionId && !candidate.childSessionId ? { childSessionId: previous.childSessionId } : {}),
        ...(previous.parentTaskId && !candidate.parentTaskId ? { parentTaskId: previous.parentTaskId } : {}),
        // Keep the on-disk identity and raw record so the visible task still
        // resolves to its persisted store; only the metrics come from live.
        source: previous.source,
        ...(previous.source !== 'live' && previous.raw ? { raw: previous.raw } : {}),
        task: { ...previous.task, ...task },
      };
      this.rememberRate(entry.task, raw, source);
      if (previous.variants?.length) entry.variants = [...previous.variants];
      this.storeEntry(map, task.id, entry);
      return entry;
    }
    if (order === 0 && previous.source !== source) {
      // Exact version ties keep the earlier root in resolver order.
      addVariant(previous, variantOfTask(candidate));
      return previous;
    }
    const sameSource = previous.source === source;
    const merged = { ...task };
    if (sameSource) {
      Object.assign(merged, { ...previous.task, ...task });
      if (TERMINAL.has(merged.status)) {
        delete merged.progress;
        if (!iso(raw?.terminal_at) && previous.task.completedAt) merged.completedAt = previous.task.completedAt;
      } else if (task.status) {
        delete merged.completedAt;
      }
    }
    const entry = {
      ...candidate,
      task: merged,
      ...(sameSource && previous.childSessionId && !candidate.childSessionId ? { childSessionId: previous.childSessionId } : {}),
    };
    const variants = [...(previous.variants ?? [])];
    if (!sameSource) {
      const variant = variantOfTask(previous);
      if (variant.source) variants.push(variant);
    }
    if (variants.length) entry.variants = variants.filter((variant, index) =>
      variant?.source && variants.findIndex(candidateVariant => candidateVariant.source === variant.source) === index);
    this.rememberRate(entry.task, raw, source);
    this.storeEntry(map, task.id, entry);
    return entry;
  }

  merge(raw, parentSessionId = raw?.parent_session_id, source = 'live') {
    if (this.stopped || !raw) return false;
    const task = normalizeOmOTask(raw);
    if (!task || typeof parentSessionId !== 'string') return false;
    const previous = this.entries.get(task.id);
    if (previous?.parentSessionId && previous.parentSessionId !== parentSessionId) return false;
    const entry = this.mergeEntry(this.entries, raw, task, source, parentSessionId);
    if (source === 'live') {
      // A live overlay keeps the disk source on the visible entry, so the
      // stored live record is marked live explicitly and refresh() reapplies it.
      const stored = entry !== previous && entry.source !== 'live' ? { ...entry, source: 'live' } : entry;
      this.live.set(task.id, { ...stored, task: { ...stored.task }, raw });
    }
    return true;
  }

  receive(payload) {
    if (this.stopped || !payload || !Array.isArray(payload.tasks)) return false;
    const session = payload.parent_session_id;
    if (!this.acceptsSession(session)) return false;
    for (const raw of payload.tasks) {
      if (raw && (raw.parent_session_id === undefined || raw.parent_session_id === session)) this.merge(raw, session, 'live');
    }
    return true;
  }

  async refresh() {
    const scannedAt = new Date().toISOString();
    this.staleCache = 0;
    const statuses = [];
    const records = [];
    for (const descriptor of this.directories) {
      const status = {
        ...descriptor,
        status: 'missing',
        tasks: { files: 0, accepted: 0, foreign: 0, invalid: 0 },
        scannedAt,
      };
      statuses.push(status);
      const directory = join(descriptor.root, 'tasks');
      let files;
      try {
        files = await readdir(directory);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        status.status = 'unreadable';
        status.error = error.message;
        this.warnOnce(`tasks:${descriptor.id}`,
          `DAG Studio: Cannot read task store ${notifyText(descriptor.root, 1024)}: ${notifyText(error.message)}`);
        continue;
      }
      const names = files.filter(name => name.endsWith('.json')).sort();
      status.tasks.files = names.length;
      status.status = names.length ? 'ok' : 'empty';
      for (let index = 0; index < names.length; index += SCAN_BATCH) {
        await Promise.all(names.slice(index, index + SCAN_BATCH).map(async name => {
          let raw;
          try {
            raw = await readTaskRecord(directory, name);
          } catch (error) {
            status.tasks.invalid++;
            this.warnOnce(`record:${descriptor.id}:${name.slice(0, 200)}`,
              `DAG Studio: Cannot read task record ${notifyText(name)}: ${notifyText(error.message)}`);
            return;
          }
          if (raw === null) return;
          const task = normalizeOmOTask(raw);
          if (!task) {
            status.tasks.invalid++;
            this.warnOnce(`record:${descriptor.id}:${name.slice(0, 200)}`,
              `DAG Studio: Invalid task record ${notifyText(name)}`);
            return;
          }
          records.push({ raw, task, source: descriptor.id, status });
        }));
      }
    }

    // The agent-project host store is the project's authoritative store. Its
    // task records can belong to the project root session while this viewer is
    // attached to a child/resumed session. Trust that origin; repository and
    // session-scoped stores remain restricted to their own session tree.
    const trusted = record => record.status.origin === 'agent-project';
    const rootIds = new Set(records
      .filter(record => trusted(record) || record.raw.parent_session_id === this.sessionId)
      .map(record => record.task.id));
    const childSessions = new Set(records
      .filter(record => rootIds.has(record.task.id) && typeof record.raw.child_session_id === 'string')
      .map(record => record.raw.child_session_id));

    const scanned = new Map();
    for (const record of records) {
      const accepted = trusted(record) ||
        record.raw.parent_session_id === this.sessionId ||
        (typeof record.raw.parent_task_id === 'string' && rootIds.has(record.raw.parent_task_id)) ||
        (typeof record.raw.parent_session_id === 'string' && childSessions.has(record.raw.parent_session_id));
      if (!accepted) {
        record.status.tasks.foreign++;
        continue;
      }
      record.status.tasks.accepted++;
      this.mergeEntry(scanned, record.raw, record.task, record.source, record.raw.parent_session_id ?? this.sessionId);
    }

    const readable = statuses.some(status => status.status === 'ok' || status.status === 'empty');
    let combined;
    if (readable) {
      combined = new Map(scanned);
      for (const id of this.cache.keys()) {
        if (!scanned.has(id) && !this.live.has(id)) this.staleCache++;
      }
      this.cache.clear();
    } else {
      combined = new Map([...this.cache.keys()].map(id => [id, this.cache.peek(id)]));
    }
    // A terminal live overlay is only useful while it covers producer lag. Once
    // a readable store proves the task is gone (cleanup or retention removed
    // it), drop the overlay instead of resurrecting it. An unreadable store is
    // no proof, so keep the overlay then, same as the cache policy.
    if (readable) {
      for (const id of this.live.keys()) {
        const entry = this.live.peek(id);
        if (!scanned.has(id) && TERMINAL.has(entry.task?.status)) this.live.delete(id);
      }
    }
    for (const id of this.live.keys()) {
      const entry = this.live.peek(id);
      const raw = entry.raw ?? {};
      this.mergeEntry(combined, raw, entry.task, entry.source ?? 'live', entry.parentSessionId ?? this.sessionId);
    }
    this.entries = combined;
    // One pass for the whole new entry map; the index cannot be updated entry
    // by entry here because refresh never writes through this.entries.
    this.ensureChildSessionIndex();
    this.sourceStatuses = statuses;
    return this.snapshot();
  }

  taskOutput(entry) {
    return {
      ...entry.task,
      ...(entry.source ? { source: entry.source } : {}),
      ...(entry.variants?.length ? { variants: entry.variants } : {}),
    };
  }

  snapshot() {
    // Index children once instead of rescanning every entry for every root;
    // the queues preserve the previous depth-first attachment order.
    const trustedSources = new Set(this.directories
      .filter(directory => directory.origin === 'agent-project')
      .map(directory => directory.id));
    const byParent = new Map();
    const bySession = new Map();
    const selected = new Map();
    const order = [];
    const queue = [];
    let index = 0;
    for (const [id, entry] of this.entries) {
      if (entry.parentTaskId) {
        const list = byParent.get(entry.parentTaskId) ?? [];
        list.push({ index, id, entry });
        byParent.set(entry.parentTaskId, list);
      }
      if (entry.parentSessionId) {
        const list = bySession.get(entry.parentSessionId) ?? [];
        list.push({ index, id, entry });
        bySession.set(entry.parentSessionId, list);
      }
      if (!entry.parentTaskId && (entry.parentSessionId === this.sessionId || trustedSources.has(entry.source))) {
        selected.set(id, this.taskOutput(entry));
        order.push(id);
        queue.push(id);
      }
      index++;
    }
    // FIFO cursor instead of Array#shift: each root's payload is appended to the
    // queue just like before, but shifting a 5000-id array no longer moves every
    // remaining id.
    let head = 0;
    while (head < queue.length) {
      const parentId = queue[head++];
      const parent = this.entries.get(parentId);
      const matches = mergeChildMatches(
        byParent.get(parentId),
        parent?.childSessionId ? bySession.get(parent.childSessionId) : undefined,
      );
      for (const { id, entry } of matches) {
        if (selected.has(id)) continue;
        selected.set(id, { ...this.taskOutput(entry), parentTaskId: parentId });
        order.push(id);
        queue.push(id);
      }
    }
    return order.map(id => selected.get(id));
  }

  start() {
    for (const descriptor of this.directories) this.armWatcher(descriptor);
  }

  armWatcher(descriptor) {
    if (this.stopped) return;
    const tasksDir = join(descriptor.root, 'tasks');
    let directory = tasksDir;
    for (let depth = 0; !existsSync(directory) && dirname(directory) !== directory && depth < 4; depth++) {
      directory = dirname(directory);
    }
    if (dirname(directory) === directory) return;
    if (this.watchedDirectories.get(descriptor.id) === directory) return;
    this.watchers.get(descriptor.id)?.close();
    this.watchers.delete(descriptor.id);
    this.watchedDirectories.delete(descriptor.id);
    const next = relative(directory, tasksDir).split(/[\\/]/)[0];
    let watcher;
    try {
      watcher = watch(directory, { persistent: false }, (_event, filename) => {
        if (this.stopped || (next && filename && String(filename) !== next)) return;
        try {
          this.armWatcher(descriptor);
          this.onChange();
        } catch (error) {
          this.notify(`DAG Studio: Task watcher: ${notifyText(error?.message ?? error)}`);
        }
      });
    } catch (error) {
      // A store deeper than the ancestor search cannot be watched yet. Keep
      // start() from failing; refresh still reads it, and a bounded retry arms
      // the watcher once the path exists.
      this.warnOnce(`watch:${descriptor.id}`, `DAG Studio: Task watcher: ${notifyText(error?.message ?? error)}`);
      this.scheduleWatcherRetry(descriptor);
      return;
    }
    watcher.on('error', error => this.handleWatcherError(descriptor, watcher, error));
    this.watchers.set(descriptor.id, watcher);
    this.watchedDirectories.set(descriptor.id, directory);
    this.watchAttempts.delete(descriptor.id);
    this.armWatcher(descriptor);
  }

  handleWatcherError(descriptor, watcher, error) {
    try { watcher.close(); } catch { /* already closed */ }
    if (this.watchers.get(descriptor.id) !== watcher) return;
    this.watchers.delete(descriptor.id);
    this.watchedDirectories.delete(descriptor.id);
    if (this.stopped) return;
    this.warnOnce(`watch:${descriptor.id}`, `DAG Studio: Task watcher: ${notifyText(error?.message ?? error)}`);
    this.scheduleWatcherRetry(descriptor);
  }

  scheduleWatcherRetry(descriptor) {
    if (this.stopped || this.watchRetryTimers.has(descriptor.id)) return;
    const attempt = (this.watchAttempts.get(descriptor.id) ?? 0) + 1;
    this.watchAttempts.set(descriptor.id, attempt);
    const timer = setTimeout(() => {
      this.watchRetryTimers.delete(descriptor.id);
      if (!this.stopped) this.armWatcher(descriptor);
    }, Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6)));
    timer.unref?.();
    this.watchRetryTimers.set(descriptor.id, timer);
  }

  stop() {
    this.stopped = true;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.watchedDirectories.clear();
    for (const timer of this.watchRetryTimers.values()) clearTimeout(timer);
    this.watchRetryTimers.clear();
    this.watchAttempts.clear();
  }
}
