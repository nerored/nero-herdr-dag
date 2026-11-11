import { constants, watch, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { clean } from './text.mjs';
import { TERMINAL } from './model.mjs';
import {
  cacheEvidence, errorEvidence, inferredTokenRate, normalizeRateHistory, replyEvidence,
  retryEvidence, turnEvidence,
} from './evidence.mjs';
import { projectKey } from './omo.mjs';
import { readEnv } from './env.mjs';

const taskId = value => typeof value === 'string' && /^st_[A-Za-z0-9_-]{1,253}$/.test(value);
const text = (value, limit = 2000) => typeof value === 'string' && value.trim() ? clean(value).slice(0, limit) : undefined;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const numeric = value => Number.isFinite(value) ? value : undefined;
// Notifications are rendered as-is by the host UI, so strip terminal control
// sequences and cap length before interpolating record names or fs errors.
const notifyText = (value, limit = 240) => clean(value).slice(0, limit);
const defined = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
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

function pathValue(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const expanded = trimmed === '~' ? homedir() : trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed;
  const cleaned = expanded.replace(/[\\/]+$/, '');
  return cleaned || expanded;
}

function canonicalPath(value) {
  const absolute = resolve(pathValue(value) ?? value);
  try { return realpathSync.native(absolute); }
  catch { return absolute; }
}

function rootDescriptor(root, origin = 'explicit', label = 'explicit store') {
  const canonical = canonicalPath(root);
  return {
    id: `${origin}-${createHash('sha256').update(canonical).digest('hex').slice(0, 8)}`,
    label,
    origin,
    root: canonical,
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

function normalizeDescriptors(list) {
  return dedupeRoots(list.map(entry => {
    if (typeof entry === 'string') return rootDescriptor(entry, 'explicit', 'explicit store');
    const descriptor = rootDescriptor(entry?.root ?? entry, entry?.origin ?? 'explicit', entry?.label ?? 'explicit store');
    return typeof entry?.id === 'string' && entry.id ? { ...descriptor, id: entry.id } : descriptor;
  }));
}

function explicitRoots(env) {
  const { taskStateDirs, taskStateDir } = readEnv(env);
  if (taskStateDirs.length) {
    return taskStateDirs.map(root => rootDescriptor(root, 'explicit', 'explicit store'));
  }
  return taskStateDir ? [rootDescriptor(taskStateDir, 'explicit', 'explicit store')] : [];
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
const legacyProbes = new Map();

function storeHasSessionTasks(root, sessionId) {
  if (!sessionId) return false;
  const directory = join(root, 'tasks');
  let mtimeMs;
  try { mtimeMs = statSync(directory).mtimeMs; }
  catch { mtimeMs = undefined; }
  const key = `${root}\u0000${sessionId}`;
  const cached = legacyProbes.get(key);
  if (cached && cached.mtimeMs === mtimeMs) return cached.found;
  const probe = { found: false, mtimeMs };
  legacyProbes.set(key, probe);
  if (mtimeMs === undefined) return false;
  let files;
  try { files = readdirSync(directory); }
  catch { return false; }
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
// session-derived store (when the session file reveals one) and the host
// project store. The repository-local store is deliberately not read: a
// cloned repository must not be able to feed DAG Studio task or checkpoint
// data into the host. The legacy flat agent root only joins when it already
// holds records for this session.
export function resolveTaskStateDirs({ sessionFile, env = process.env, cwd = process.cwd(), stateDirs, sessionId } = {}) {
  if (Array.isArray(stateDirs) && stateDirs.length) return normalizeDescriptors(stateDirs);
  const explicit = explicitRoots(env);
  if (explicit.length) return normalizeDescriptors(explicit);

  const candidates = [];
  const derived = sessionRoot(sessionFile);
  if (derived) candidates.push(rootDescriptor(derived, 'session', 'session store'));
  const working = pathValue(cwd) ?? process.cwd();
  const { agentDir } = readEnv(env);
  candidates.push(rootDescriptor(join(agentDir, 'projects', projectKey(working), 'senpi-task'), 'agent-project', 'host store'));
  const legacy = join(agentDir, 'senpi-task');
  if (storeHasSessionTasks(legacy, sessionId)) candidates.push(rootDescriptor(legacy, 'agent', 'agent store'));
  return normalizeDescriptors(candidates);
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

function iso(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function normalizeOmOTask(raw) {
  if (!raw || !taskId(raw.task_id)) return null;
  const live = raw.live_progress;
  const stats = raw.run_stats ?? raw.runStats;
  const retry = retryEvidence(raw, stats);
  const tool = text(live?.current_tool, 128);
  const line = text(live?.last_assistant_line, 512);
  const progress = [tool ? `[${tool}]` : undefined, line].filter(Boolean).join(' ');
  const status = text(raw.status, 64) ?? 'pending';
  const values = {
    id: raw.task_id,
    description: text(raw.description) ?? text(raw.task_summary) ?? text(raw.name),
    agent: text(raw.agent, 128) ?? text(raw.agent_type, 128),
    category: text(raw.category, 128),
    model: text(raw.resolved_model?.display, 256) ?? text(raw.model, 256),
    status,
    percent: numeric(raw.percent ?? live?.percent),
    tokensIn: numeric(raw.tokens_in ?? raw.usage?.input_tokens ?? raw.token_usage?.input ?? stats?.input_tokens),
    tokensOut: numeric(raw.tokens_out ?? raw.usage?.output_tokens ?? raw.token_usage?.output ?? stats?.output_tokens),
    ...inferredTokenRate(raw, stats),
    ...(normalizeRateHistory(raw.tokenRateHistory) ? { tokenRateHistory: normalizeRateHistory(raw.tokenRateHistory) } : {}),
    ...cacheEvidence(raw, stats),
    ...defined({ failedTurns: retry.failedTurns, retries: retry.retries, retriesSource: retry.retriesSource }),
    provenance: {
      retries: retry.retries !== undefined
        ? defined({ kind: retry.retriesKind, from: retry.retriesSource })
        : { kind: 'unavailable' },
    },
    ...replyEvidence(raw, { live }),
    ...errorEvidence(raw),
    startedAt: iso(live?.started_at) ?? iso(raw.created_at),
    completedAt: iso(raw.terminal_at) ?? (TERMINAL.has(status) ? iso(raw.updated_at) : undefined),
    progress: TERMINAL.has(status) ? undefined : text(progress, 512) ?? text(live?.activity, 512),
    thinking: text(raw.thinking ?? raw.reasoning ?? raw.reasoning_content ?? live?.thinking, 1200),
    ...turnEvidence(raw, stats),
    logs: Array.isArray(raw.logs) ? raw.logs.map(value => text(value, 240)).filter(Boolean).slice(-12) : undefined,
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
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
  constructor({ cwd = process.cwd(), sessionId, stateDir, stateDirs,
    notify = message => console.warn(message), onChange = () => {} } = {}) {
    Object.assign(this, { sessionId, notify, onChange });
    this.directories = normalizeDescriptors(
      Array.isArray(stateDirs) && stateDirs.length
        ? stateDirs
        : stateDir
          ? [rootDescriptor(stateDir, 'explicit', 'explicit store')]
          : resolveTaskStateDirs({ cwd, sessionId }),
    );
    this.entries = new Map();
    this.cache = new Map();
    this.live = new Map();
    this.rateHistory = new Map();
    this.rateSeen = new Map();
    this.rateSources = new Map();
    this.sourceStatuses = [];
    this.staleCache = 0;
    this.stopped = false;
    this.watchers = new Map();
    this.watchedDirectories = new Map();
    this.watchRetryTimers = new Map();
    this.watchAttempts = new Map();
    this.warnings = new Set();
  }

  get sources() {
    return this.sourceStatuses;
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
    const ownHistory = normalizeRateHistory(task.tokenRateHistory) ?? [];
    const switchingStore = source !== 'live' && previousSource !== undefined &&
      previousSource !== 'live' && previousSource !== source;
    // Copy before mutating: the stored series is shared with the task that
    // currently wins a merge, and a losing candidate must not extend it.
    const prior = [...(switchingStore ? ownHistory : this.rateHistory.get(task.id) ?? ownHistory)];
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
    prior.push({ at, rate: value });
    const history = prior.slice(-32);
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

  restore(tasks = []) {
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
      map.set(task.id, candidate);
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
      map.set(task.id, entry);
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
    map.set(task.id, entry);
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
    if (session !== this.sessionId && ![...this.entries.values()].some(entry => entry.childSessionId === session)) return false;
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
      combined = new Map(this.cache);
    }
    // A terminal live overlay is only useful while it covers producer lag. Once
    // a readable store proves the task is gone (cleanup or retention removed
    // it), drop the overlay instead of resurrecting it. An unreadable store is
    // no proof, so keep the overlay then, same as the cache policy.
    if (readable) {
      for (const [id, entry] of this.live) {
        if (!scanned.has(id) && TERMINAL.has(entry.task?.status)) this.live.delete(id);
      }
    }
    for (const entry of this.live.values()) {
      const raw = entry.raw ?? {};
      this.mergeEntry(combined, raw, entry.task, entry.source ?? 'live', entry.parentSessionId ?? this.sessionId);
    }
    this.entries = combined;
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
    while (queue.length) {
      const parentId = queue.shift();
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
