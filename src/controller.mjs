import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readJson, writeJson } from './storage.mjs';
import { pruneExpiredSnapshots, retentionDaysFromEnv } from './retention.mjs';
import { shellCommand } from './herdr.mjs';
import { clean } from './text.mjs';
import { modeFor, normalizeRun, TERMINAL } from './model.mjs';
import { todoTitleForRun, loadTodoEvents } from './todo-title.mjs';
import { resolveTaskStateDirs, TaskData } from './task-data.mjs';

const SCAN_BATCH = 8;
// Checkpoint directories live in the project store, so a cloned or hostile
// repository controls the names in them. Match the record-open cap in
// render.mjs and never read more than one byte past it.
export const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const emptyCounts = () => ({ files: 0, accepted: 0, foreign: 0, invalid: 0 });

// Read one checkpoint without following symlinks and without trusting the
// directory entry's apparent size. lstat rejects the obvious cases; opening
// with O_NOFOLLOW and re-checking the descriptor's size closes the lstat/open
// race and the bounded read keeps the cost independent of the file's contents.
async function readCheckpoint(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error('checkpoint is a symlink');
  if (!info.isFile()) throw new Error('checkpoint is not a regular file');
  if (info.size > MAX_CHECKPOINT_BYTES) throw new Error(`checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error('checkpoint is not a regular file');
    if (opened.size > MAX_CHECKPOINT_BYTES) throw new Error(`checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
    const buffer = Buffer.allocUnsafe(Math.min(opened.size, MAX_CHECKPOINT_BYTES) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CHECKPOINT_BYTES) throw new Error(`checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}

export function viewKey(socket, pane, session) {
  return createHash('sha256').update(JSON.stringify([socket, pane, session])).digest('hex').slice(0, 24);
}

export function dagTitle(sessionId) {
  return `DAG Studio · ${sessionId.slice(0, 8)}`;
}

export function isDagViewerPane(pane) {
  return [pane?.label, pane?.terminal_title, pane?.terminal_title_stripped]
    .some(name => typeof name === 'string' &&
      (name.startsWith('DAG Studio · ') || name.startsWith('DAG · ') || name === 'OmO DAG'));
}

function missingPane(error) {
  return /pane_not_found|unknown pane|pane .*not found/i.test(`${error.message} ${error.stderr ?? ''}`);
}

function runTime(run) {
  const value = Date.parse(run?.updatedAt ?? '');
  return Number.isFinite(value) ? value : undefined;
}

// A checkpoint is newer only when it carries a strictly later timestamp.
// Ties keep the existing entry on the live path and prefer the checkpoint on
// startup, matching the previous preference while no longer regressing state.
function isNewerRun(candidate, current, preferLive) {
  if (!current) return true;
  const candidateTime = runTime(candidate);
  const currentTime = runTime(current);
  if (candidateTime !== undefined || currentTime !== undefined) {
    if (candidateTime === undefined) return false;
    if (currentTime === undefined) return true;
    if (candidateTime !== currentTime) return candidateTime > currentTime;
  }
  const candidateSeq = Number.isFinite(candidate.checkpointSeq) ? candidate.checkpointSeq : undefined;
  const currentSeq = Number.isFinite(current.checkpointSeq) ? current.checkpointSeq : undefined;
  if (candidateSeq !== undefined && currentSeq !== undefined && candidateSeq !== currentSeq) {
    return candidateSeq > currentSeq;
  }
  if (candidateSeq !== undefined && currentSeq === undefined) return true;
  if (candidateSeq === undefined && currentSeq !== undefined) return false;
  return !preferLive;
}

function runVariant(run) {
  return Object.fromEntries(Object.entries({
    source: run.source,
    updatedAt: run.updatedAt || undefined,
    checkpointSeq: run.checkpointSeq,
    status: run.status,
    nodeCount: Array.isArray(run.nodes) ? run.nodes.length : undefined,
  }).filter(([, value]) => value !== undefined));
}

function mergeVariants(left = [], right = [], loser, winnerSource) {
  const variants = [...left, ...right];
  if (loser?.source && loser.source !== winnerSource) variants.push(runVariant(loser));
  return variants.filter((variant, index) =>
    variant?.source && variant.source !== winnerSource &&
    variants.findIndex(candidate => candidate.source === variant.source) === index);
}

function sameRunVersion(a, b) {
  const left = runTime(a);
  const right = runTime(b);
  if (left !== undefined || right !== undefined) {
    if (left !== right) return false;
  }
  return (a.checkpointSeq ?? undefined) === (b.checkpointSeq ?? undefined);
}

function mergeRun(map, run, preferLive) {
  const current = map.get(run.id);
  if (!current) {
    map.set(run.id, run);
    return run;
  }
  if (isNewerRun(run, current, preferLive)) {
    // Exact version ties outside the live path keep the earlier candidate in
    // resolver order; a live event still wins its own tie.
    if (!preferLive && sameRunVersion(run, current) && current.source &&
        !['cache', 'live'].includes(current.source) && current.source !== run.source) {
      const variants = mergeVariants(current.variants, run.variants, run, current.source);
      if (variants.length) current.variants = variants;
      map.set(run.id, current);
      return current;
    }
    const variants = mergeVariants(current.variants, run.variants, current.source !== run.source ? current : undefined, run.source);
    if (variants.length) run.variants = variants;
    else delete run.variants;
    map.set(run.id, run);
    return run;
  }
  const variants = mergeVariants(current.variants, run.variants, run.source !== current.source ? run : undefined, current.source);
  if (variants.length) current.variants = variants;
  map.set(run.id, current);
  return current;
}

function combineStoreStatus(left, right) {
  for (const status of ['unreadable', 'ok', 'empty']) {
    if (left === status || right === status) return status;
  }
  return 'missing';
}

function sessionRuns(payload, sessionId) {
  if (!payload || payload.parent_session_id !== sessionId || !Array.isArray(payload.runs)) return null;
  const runs = payload.runs.map(raw => normalizeRun(raw)).filter(Boolean);
  if (runs.length !== payload.runs.length) throw new Error('Unsupported OmO DAG snapshot format.');
  for (const run of runs) run.source = 'live';
  return runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export class DagPane {
  constructor({
    sessionId, parentPane, socket, stateDir, cwd, node, viewer, herdr,
    // Herdr's split ratio is the source pane's share; 2/3 leaves the viewer pane at 1/3.
    notify = () => {}, taskStateDir, taskStateDirs, retentionDays, streamDelay = 250, ratio = 2 / 3, sessionFile,
    translate,
  }) {
    Object.assign(this, {
      sessionId, parentPane, stateDir, cwd, node, viewer, herdr, notify, ratio, sessionFile,
      translate: typeof translate === 'function' ? translate : undefined,
    });
    this.key = viewKey(socket, parentPane, sessionId);
    this.stateFile = join(stateDir, `${this.key}.json`);
    this.recordFile = join(stateDir, `${this.key}.pane.json`);
    this.taskStateDirs = resolveTaskStateDirs({
      cwd,
      sessionId,
      stateDirs: Array.isArray(taskStateDirs) && taskStateDirs.length
        ? taskStateDirs
        : taskStateDir ? [taskStateDir] : undefined,
    });
    this.checkpointDir = this.taskStateDirs[0]
      ? join(this.taskStateDirs[0].root, 'dag', 'runs')
      : undefined;
    this.checkpointDirs = this.taskStateDirs.map(source => ({
      source: source.id,
      root: source.root,
      dir: join(source.root, 'dag', 'runs'),
      origin: source.origin,
    }));
    this.retentionDays = retentionDays ?? retentionDaysFromEnv();
    this.streamDelay = streamDelay;
    this.queue = Promise.resolve();
    this.rateTimer = undefined;
    this.runs = [];
    this.tasks = [];
    this.streams = new Map();
    this.outputs = new Map();
    this.runSources = new Map();
    this.scannedRunIds = new Set();
    this.cacheRunIds = new Set();
    this.liveRunIds = new Set();
    this.staleRunCache = 0;
    this.warnings = new Set();
    this.stopped = false;
    this.todoEvents = [];
    this.todoFileKey = undefined;
    this.pendingStreamResolve = undefined;
    this.taskData = new TaskData({
      cwd, sessionId, stateDirs: this.taskStateDirs, notify,
      onChange: () => { if (!this.stopped) this.enqueue(() => this.save(true)); },
    });
  }

  warnOnce(key, message) {
    if (this.warnings.has(key)) return;
    this.warnings.add(key);
    this.notify(message);
  }

  // User-facing failures are formatted here so a host can localize them at the
  // notify boundary by passing translate(key, params). The fallback keeps the
  // historical English text for hosts that do not. File names and parser
  // messages are untrusted, so interpolated values are cleaned first.
  emit(key, params, fallback) {
    const values = Object.fromEntries(Object.entries(params)
      .map(([name, value]) => [name, clean(String(value ?? '')).slice(0, 240)]));
    let translated;
    try {
      translated = this.translate ? this.translate(key, values) : undefined;
    } catch {
      translated = undefined;
    }
    this.notify(typeof translated === 'string' && translated ? translated : fallback(values));
  }

  warnOnceEmit(dedupeKey, key, params, fallback) {
    if (this.warnings.has(dedupeKey)) return;
    this.warnings.add(dedupeKey);
    this.emit(key, params, fallback);
  }

  enqueue(job) {
    const result = this.queue.then(job);
    this.queue = result.catch(error => this.notify(`DAG Studio: ${clean(error?.message ?? error)}`));
    return result;
  }

  receive(payload) {
    const runs = sessionRuns(payload, this.sessionId);
    if (runs === null || this.stopped) return Promise.resolve();
    for (const run of runs) {
      this.liveRunIds.add(run.id);
      this.cacheRunIds.delete(run.id);
    }
    return this.enqueue(async () => {
      // The live event already carries the run payload. Merge it into memory
      // instead of re-reading the session JSONL and every checkpoint; those
      // stores are scanned on start/open and by watcher-driven refreshes.
      const current = new Map(this.runs.map(run => [run.id, run]));
      for (const run of runs) mergeRun(current, { ...run, source: 'live' }, true);
      await this.refreshTodoEvents();
      this.runs = this.finalizeRuns(current);
      await this.save(true, false);
    });
  }

  receiveTasks(payload) {
    if (this.stopped) return Promise.resolve();
    return this.enqueue(async () => {
      // Reuse the refreshed task list and prune against it; a second scan in
      // save() would repeat the whole store read.
      this.tasks = await this.taskData.refresh();
      if (this.taskData.receive(payload)) {
        // snapshot() is in-memory and reflects the live overlay just merged.
        this.tasks = this.taskData.snapshot();
        await this.save(true, false, true);
      }
    });
  }

  receiveStream(update) {
    if (this.stopped) return Promise.resolve();
    const now = update.now ?? Date.now();
    const excerpt = typeof update.text === 'string' ? clean(update.text).trim().slice(-1200) : '';
    if (excerpt && (update.phase === 'thinking' || update.phase === 'text')) {
      const previous = this.outputs.get(update.taskId) ?? {};
      this.outputs.set(update.taskId, {
        ...previous,
        [update.phase === 'thinking' ? 'thinking' : 'reply']: excerpt,
      });
    }
    if (update.active) {
      const previous = this.streams.get(update.taskId);
      const samePhase = previous?.phase === update.phase && previous.tool === update.tool;
      this.streams.set(update.taskId, {
        phase: update.phase,
        ...(update.tool ? { tool: update.tool } : {}),
        ...(update.text ? { text: update.text } : {}),
        ...(update.attempt ? { attempt: update.attempt } : {}),
        ...(update.maxAttempts ? { maxAttempts: update.maxAttempts } : {}),
        since: samePhase ? previous.since : now,
        lastAt: now,
      });
    } else if (!this.streams.delete(update.taskId)) {
      return Promise.resolve();
    }
    if (this.streamTimer) return this.streamFlush;
    this.streamFlush = new Promise(resolve => {
      this.pendingStreamResolve = resolve;
      this.streamTimer = setTimeout(() => {
        this.streamTimer = undefined;
        const settle = this.pendingStreamResolve;
        this.pendingStreamResolve = undefined;
        this.enqueue(() => this.save(true, false)).then(settle, settle);
      }, this.streamDelay);
      this.streamTimer.unref?.();
    });
    return this.streamFlush;
  }

  withStreams(tasks, connected) {
    return tasks.map(task => {
      if (TERMINAL.has(task.status)) {
        // A finished task's persisted reply/thinking is authoritative; a live
        // tail must never overwrite it or be resurrected by a later save.
        this.streams.delete(task.id);
        this.outputs.delete(task.id);
        return task;
      }
      const output = this.outputs.get(task.id);
      const base = output ? { ...task, ...output } : task;
      if (output?.reply !== undefined) {
        // A live tail is not the persisted final response: its full size and
        // truncation state are unknown, so do not carry stale reply metadata.
        delete base.replyBytes;
        delete base.replyTruncated;
        base.replySource = 'live_stream';
      }
      if (!connected || !this.streams.size || task.status !== 'running') {
        this.streams.delete(task.id);
        return base;
      }
      const activity = this.streams.get(task.id);
      return activity ? { ...base, activity } : base;
    });
  }

  // Per-task maps are fed by live streams, including cross-session child ids
  // routed through the global tap. Drop ids that left the snapshot so a
  // long-lived session does not accumulate excerpts and rate series forever.
  pruneLiveState(tasks) {
    const visible = new Set(tasks.map(task => task.id));
    for (const id of this.streams.keys()) if (!visible.has(id)) this.streams.delete(id);
    for (const id of this.outputs.keys()) if (!visible.has(id)) this.outputs.delete(id);
    if (this.taskData.entries instanceof Map) this.taskData.pruneRates(this.taskData.entries.keys());
  }

  // The session JSONL can be tens of megabytes. Cache the parsed todo events
  // against the file mtime/size so only a changed file is parsed again.
  async refreshTodoEvents() {
    if (!this.sessionFile) {
      this.todoEvents = [];
      this.todoFileKey = undefined;
      return this.todoEvents;
    }
    let info;
    try {
      info = await stat(this.sessionFile);
    } catch {
      this.todoEvents = await loadTodoEvents(this.sessionFile);
      this.todoFileKey = undefined;
      return this.todoEvents;
    }
    const key = `${info.mtimeMs}:${info.size}`;
    if (key !== this.todoFileKey) {
      this.todoEvents = await loadTodoEvents(this.sessionFile);
      this.todoFileKey = key;
    }
    return this.todoEvents;
  }

  finalizeRuns(runs) {
    const values = Array.isArray(runs) ? runs : [...runs.values()];
    return values
      .map(run => ({ ...run, todoTitle: todoTitleForRun(run, this.todoEvents) }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async restoreRuns(runs = this.runs, preferLive = false) {
    this.staleRunCache = 0;
    await this.refreshTodoEvents();
    const current = new Map();
    for (const run of Array.isArray(runs) ? runs : []) {
      if (!run || typeof run.id !== 'string') continue;
      const source = typeof run.source === 'string'
        ? run.source
        : preferLive || this.liveRunIds.has(run.id) ? 'live'
          : this.cacheRunIds.has(run.id) ? 'cache' : 'live';
      current.set(run.id, { ...run, source });
    }
    const runSources = new Map();
    const scanned = new Set();
    for (const checkpoint of this.checkpointDirs) {
      const status = { status: 'missing', runs: emptyCounts(), scannedAt: new Date().toISOString() };
      runSources.set(checkpoint.source, status);
      let files;
      try {
        files = await readdir(checkpoint.dir);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        status.status = 'unreadable';
        status.error = error.message;
        this.warnOnceEmit(`runs:${checkpoint.source}`, 'checkpointStore',
          { root: checkpoint.root, error: error.message },
          values => `DAG Studio: Cannot read checkpoint store ${values.root}: ${values.error}`);
        continue;
      }
      const names = files.filter(name => name.endsWith('.json')).sort();
      status.runs.files = names.length;
      status.status = names.length ? 'ok' : 'empty';
      for (let index = 0; index < names.length; index += SCAN_BATCH) {
        await Promise.all(names.slice(index, index + SCAN_BATCH).map(async name => {
          let raw;
          try {
            raw = await readCheckpoint(join(checkpoint.dir, name));
          } catch (error) {
            status.runs.invalid++;
            this.warnOnceEmit(`checkpoint:${checkpoint.source}:${name.slice(0, 200)}`, 'checkpointRead',
              { name, error: error.message },
              values => `DAG Studio: Cannot read checkpoint ${values.name}: ${values.error}`);
            return;
          }
          if (raw === null) return;
          if (typeof raw.parentSessionId !== 'string' || raw.schemaVersion !== 1) {
            status.runs.invalid++;
            this.warnOnceEmit(`checkpoint:${checkpoint.source}:${name.slice(0, 200)}`, 'checkpointHeader',
              { name }, values => `DAG Studio: Cannot read checkpoint ${values.name}: Invalid checkpoint header`);
            return;
          }
          // The agent-project host store is the project's authoritative store.
          // Its DAG can belong to the project root session while this viewer is
          // attached to a child/resumed session. Trust that origin; repository
          // and session-scoped stores stay filtered by their parent session.
          if (checkpoint.origin !== 'agent-project' && raw.parentSessionId !== this.sessionId) {
            status.runs.foreign++;
            return;
          }
          const run = normalizeRun(raw);
          if (!run) {
            status.runs.invalid++;
            this.warnOnceEmit(`checkpoint:${checkpoint.source}:${name.slice(0, 200)}`, 'checkpointRun',
              { name }, values => `DAG Studio: Cannot read checkpoint ${values.name}: Invalid checkpoint run`);
            return;
          }
          status.runs.accepted++;
          scanned.add(run.id);
          mergeRun(current, { ...run, source: checkpoint.source }, preferLive);
        }));
      }
      // A store whose every record is rejected is not healthy: a schema bump or
      // corruption must not look like an empty store and purge the run cache.
      if (names.length && status.runs.accepted === 0 && status.runs.invalid > 0) status.status = 'unreadable';
    }
    const readable = [...runSources.values()].some(status => status.status === 'ok' || status.status === 'empty');
    const acceptedAny = [...runSources.values()].some(status => status.runs.accepted > 0);
    if (readable && acceptedAny) {
      for (const id of this.cacheRunIds) {
        if (scanned.has(id) || this.liveRunIds.has(id)) continue;
        current.delete(id);
        this.staleRunCache++;
      }
    }
    this.runs = this.finalizeRuns(current);
    this.runSources = runSources;
    this.scannedRunIds = scanned;
  }

  sourceSnapshot() {
    const byId = new Map();
    for (const task of this.taskData.sources) {
      const run = this.runSources.get(task.id);
      byId.set(task.id, {
        ...task,
        status: combineStoreStatus(task.status, run?.status),
        runs: run?.runs ?? emptyCounts(),
        ...(run?.error && !task.error ? { error: run.error } : {}),
      });
    }
    for (const [id, run] of this.runSources) {
      if (byId.has(id)) continue;
      const descriptor = this.taskStateDirs.find(entry => entry.id === id) ?? { id };
      byId.set(id, {
        ...descriptor,
        status: run.status,
        tasks: emptyCounts(),
        runs: run.runs,
        scannedAt: run.scannedAt,
        ...(run.error ? { error: run.error } : {}),
      });
    }
    return [...byId.values()];
  }

  async save(connected, refresh = true, prune = refresh) {
    if (refresh) this.tasks = await this.taskData.refresh();
    const tasks = this.withStreams(this.tasks, connected);
    if (prune) this.pruneLiveState(tasks);
    const capturedAt = new Date().toISOString();
    await writeJson(this.stateFile, {
      version: 3,
      sessionId: this.sessionId,
      mode: modeFor({ connected: Boolean(connected) }),
      connected,
      updatedAt: capturedAt,
      provenance: {
        origin: 'controller',
        statePath: this.stateFile,
        taskStateDir: this.taskStateDirs[0]?.root,
        capturedAt,
        view: 'watch',
      },
      sources: this.sourceSnapshot(),
      runs: this.runs,
      tasks,
    });
    if (connected && !this.stopped && (this.runs.length || tasks.length)) await this.ensure(false);
  }

  start() {
    return this.enqueue(async () => {
      await pruneExpiredSnapshots(this.stateDir, {
        keepFiles: [basename(this.stateFile), basename(this.recordFile), `${basename(this.stateFile)}.view.json`],
        days: this.retentionDays,
        notify: message => this.notify(`DAG Studio: ${message}`),
      });
      const state = await readJson(this.stateFile);
      if (state?.sessionId === this.sessionId) {
        this.runs = Array.isArray(state.runs) ? state.runs : [];
        this.cacheRunIds = new Set(this.runs.map(run => run?.id).filter(Boolean));
        this.taskData.restore(state.tasks);
      }
      this.taskData.start();
      if (!this.rateTimer) {
        this.rateTimer = setInterval(() => {
          if (this.stopped || !this.taskData.sampleRates()) return;
          this.enqueue(() => this.save(true));
        }, 1000);
        this.rateTimer.unref?.();
      }
      await this.restoreRuns();
      await this.save(true);
    });
  }

  open() {
    return this.enqueue(async () => {
      if (!this.runs.length) {
        const state = await readJson(this.stateFile);
        if (state?.sessionId === this.sessionId) {
          this.runs = Array.isArray(state.runs) ? state.runs : [];
          this.cacheRunIds = new Set(this.runs.map(run => run?.id).filter(Boolean));
          this.taskData.restore(state.tasks);
        }
      }
      await this.restoreRuns();
      await this.save(true);
      return this.ensure(true);
    });
  }

  async listDagPanes() {
    try {
      const panes = (await this.herdr('list'))?.panes ?? [];
      const tab = panes.find(pane => pane.pane_id === this.parentPane)?.tab_id;
      return panes.filter(isDagViewerPane)
        .filter(pane => pane.pane_id && pane.pane_id !== this.parentPane && (!tab || pane.tab_id === tab))
        .map(pane => pane.pane_id);
    } catch (error) {
      if (error instanceof Error) {
        // "No panes" and "could not ask" are different answers. Keep the
        // failure visible and abort ensure() instead of splitting a duplicate.
        this.emit('paneList', { error: error.message },
          values => `DAG Studio: Cannot list panes: ${values.error}`);
      }
      throw error;
    }
  }

  async closePane(paneId) {
    try { await this.herdr('close', paneId); }
    catch (error) {
      if (!missingPane(error)) this.notify(`DAG Studio: close failed: ${error.message}`);
    }
  }

  async closeDagPanes(keep) {
    for (const paneId of await this.listDagPanes()) {
      if (paneId !== keep) await this.closePane(paneId);
    }
  }

  assertActive() {
    if (this.stopped) throw new Error('DAG Studio controller is stopped.');
  }

  async ensure(force) {
    this.assertActive();
    const record = await readJson(this.recordFile);
    this.assertActive();
    const live = Boolean(record?.paneId) && record.ready !== false;
    if (live && !force) return record.paneId;
    if (record?.paneId) {
      try {
        await this.herdr('get', record.paneId);
        this.assertActive();
        if (record.ready) {
          await this.closeDagPanes(record.paneId);
          this.assertActive();
          return record.paneId;
        }
        await this.closePane(record.paneId);
        this.assertActive();
      } catch (error) {
        if (!missingPane(error)) throw error;
      }
    }
    this.assertActive();
    if (typeof this.node === 'function') this.node = await this.node();
    this.assertActive();
    await writeJson(this.recordFile, { attempted: true });
    this.assertActive();
    await this.closeDagPanes();
    this.assertActive();
    const result = await this.herdr('split', '--pane', this.parentPane, '--direction', 'right',
      '--ratio', String(this.ratio), '--cwd', this.cwd, '--no-focus');
    const paneId = result?.pane?.pane_id;
    if (!paneId) throw new Error('Herdr split response did not include a pane ID.');
    try {
      // Shutdown can land while the split is in flight. Never rename or launch
      // a viewer for a dead session: close the pane just created and abort.
      this.assertActive();
      await writeJson(this.recordFile, { paneId, ready: false });
      this.assertActive();
      await this.herdr('rename', paneId, dagTitle(this.sessionId));
      this.assertActive();
      await this.herdr('run', paneId, shellCommand([this.node, this.viewer, '--state', this.stateFile, '--close-pane', paneId, '--pane']));
      this.assertActive();
      await writeJson(this.recordFile, { paneId, ready: true });
      return paneId;
    } catch (error) {
      if (this.stopped) await this.closePane(paneId);
      throw error;
    }
  }

  stop() {
    this.stopped = true;
    // A receiveStream promise waits on the flush timer; settle it with the
    // final save instead of leaving the caller hanging when the timer is cut.
    const settleStream = this.pendingStreamResolve;
    this.pendingStreamResolve = undefined;
    clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    clearInterval(this.rateTimer);
    this.rateTimer = undefined;
    this.taskData.stop();
    // Save the final snapshot before dropping the live excerpts so a task that
    // had streamed output still carries it into the disconnected state file.
    // A failed final write must not reject shutdown: session_start awaits stop()
    // before constructing the next controller.
    return this.enqueue(async () => {
      try {
        await this.save(false);
      } catch (error) {
        this.emit('saveSnapshot', { error: error?.message ?? String(error) },
          values => `DAG Studio: Cannot save snapshot: ${values.error}`);
      } finally {
        this.streams.clear();
        this.outputs.clear();
        settleStream?.();
      }
    });
  }
}
