import {
  isBlockedState, isFailedState, isVirtualRun, orphanNavTasks, percentFor, TERMINAL,
} from './model.mjs';

// The one virtual run id. A real run may already own this id, so the projection
// adds a deterministic `#2`, `#3`, ... suffix instead of colliding with it.
export const ORPHAN_RUN_ID = 'orphan:tasks';

// The viewer accepts at most SNAPSHOT_LIMITS.nodesPerRun (4096) nodes for a
// real run. The virtual run keeps the same display ceiling while its membership
// and stats stay complete.
const DISPLAY_NODE_LIMIT = 4096;

const EMPTY_EDGES = Object.freeze([]);
const projectionCache = new WeakMap();

// Task evidence that a node normally inherits from its linked task. The state
// and percent entries are derived separately because a virtual node has no
// producer node record to inherit them from.
const NODE_EVIDENCE_FIELDS = Object.freeze([
  'category', 'agent', 'model', 'progress', 'thinking', 'activity',
  'tokensIn', 'tokensOut', 'turns', 'toolCalls',
  'startedAt', 'completedAt', 'children', 'logs',
  'tokenRate', 'tokenRateKind', 'tokenRateHistory',
  'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'costUsd', 'costStatus',
  'cacheHitRate', 'cacheHitRateLast',
  'failedTurns', 'retries', 'retriesSource',
  'reply', 'replyBytes', 'replyTruncated', 'replySource',
  'error', 'errorSource', 'errorKind',
  'output', 'recentEvents', 'outputBytes', 'outputTruncated', 'artifact',
]);

const provenanceEntry = (kind, from) => from === undefined ? { kind } : { kind, from };

// A node normally inherits task evidence as a derived value, while simulated
// and unavailable task provenance keep their meaning. This mirrors model's
// node provenance rule without making the model depend on this projection.
function inheritedProvenance(task, field) {
  const entry = task?.provenance?.[field];
  if (!entry || typeof entry !== 'object') {
    return task?.[field] !== undefined
      ? provenanceEntry('derived', `task.${field}`)
      : provenanceEntry('unknown');
  }
  if (entry.kind === 'unknown' || entry.kind === 'simulated' || entry.kind === 'unavailable') {
    return provenanceEntry(entry.kind);
  }
  if (entry.kind === 'derived') return provenanceEntry('derived', entry.from ?? `task.${field}`);
  return provenanceEntry('derived', `task.${field}`);
}

function nodeStateProvenance(task) {
  // The node state is always derived from the task status, including the
  // retained `unknown` status that normalizeRun would drop.
  if (task?.provenance?.state?.kind === 'simulated') return provenanceEntry('simulated');
  return provenanceEntry('derived', 'task.status');
}

function nodePercentProvenance(task) {
  const entry = task?.provenance?.percent;
  if (entry?.kind === 'simulated') return provenanceEntry('simulated');
  if (Number.isFinite(task?.percent)) {
    return provenanceEntry('derived', entry?.kind === 'derived' && entry.from ? entry.from : 'task.percent');
  }
  if (task?.status === 'completed') return provenanceEntry('derived', 'completed status');
  return provenanceEntry('unknown');
}

// A virtual node is display-only: the task id is the node id, the status is the
// node state, and task evidence is inherited so details and summaries remain
// truthful without pretending a producer checkpoint emitted the node.
function virtualNodeForTask(task) {
  const node = {
    id: task.id,
    label: task.description ?? task.id,
    state: task.status,
    attempt: 1,
    taskId: task.id,
    task,
    percent: percentFor({ percent: task.percent, state: task.status }),
    provenance: {
      state: nodeStateProvenance(task),
      percent: nodePercentProvenance(task),
      agent: inheritedProvenance(task, 'agent'),
      model: inheritedProvenance(task, 'model'),
      thinking: inheritedProvenance(task, 'thinking'),
      reply: inheritedProvenance(task, 'reply'),
      error: inheritedProvenance(task, 'error'),
      retries: inheritedProvenance(task, 'retries'),
    },
  };
  for (const field of NODE_EVIDENCE_FIELDS) {
    if (task[field] !== undefined) node[field] = task[field];
  }
  return node;
}

// The virtual run's stats come from every member, not from the display-capped
// node list, and use the same counters and triage buckets as model.runStats.
function memberSummary(members) {
  const total = members.length;
  const counts = {
    running: 0, completed: 0, failed: 0, blocked: 0, paused: 0, pending: 0,
    scheduled: 0, cancelled: 0, skipped: 0, error: 0, interrupted: 0, lost: 0,
  };
  let sum = 0;
  let percentKnown = total > 0;
  let finished = 0;
  let failed = 0;
  let blocked = 0;
  let running = false;
  let interrupted = false;
  let terminal = true;
  let completedOrSkipped = true;
  for (const task of members) {
    const state = task.status;
    counts[state] = (counts[state] ?? 0) + 1;
    if (TERMINAL.has(state)) finished += 1;
    if (isFailedState(state)) failed += 1;
    if (isBlockedState(state)) blocked += 1;
    if (state === 'running') running = true;
    if (state === 'interrupted') interrupted = true;
    if (!TERMINAL.has(state)) terminal = false;
    if (state !== 'completed' && state !== 'skipped') completedOrSkipped = false;
    if (Number.isFinite(task.percent)) sum += task.percent;
    else percentKnown = false;
  }
  // `failed` and `blocked` are triage buckets, not raw state names, exactly as
  // runStats reports them. `done` stays completed-only progress.
  counts.failed = failed;
  counts.blocked = blocked;
  const status = failed ? 'failed'
    : running ? 'running'
      : blocked ? 'blocked'
        : interrupted ? 'interrupted'
          : terminal ? (completedOrSkipped ? 'completed' : 'cancelled') : 'pending';
  return {
    status,
    stats: Object.freeze({
      total,
      counts: Object.freeze(counts),
      percent: percentKnown ? Math.round(sum / total) : undefined,
      percentKnown,
      done: counts.completed,
      finished,
    }),
  };
}

function uniqueVirtualRunId(realRuns) {
  const taken = new Set(realRuns.map(run => run?.id));
  if (!taken.has(ORPHAN_RUN_ID)) return ORPHAN_RUN_ID;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${ORPHAN_RUN_ID}#${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Build the virtual run for one snapshot. Membership is the visible root orphan
// task list; a prior virtual run is ignored rather than treated as ownership.
export function buildOrphanRun(snapshot) {
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
  const realRuns = runs.filter(run => !isVirtualRun(run));
  const source = realRuns.length === runs.length ? snapshot : { ...snapshot, runs: realRuns };
  const members = orphanNavTasks(source);
  if (!members.length) return undefined;

  const count = members.length;
  const nodes = Object.freeze(members.slice(0, DISPLAY_NODE_LIMIT).map(virtualNodeForTask));
  const { status, stats } = memberSummary(members);
  const id = uniqueVirtualRunId(realRuns);
  // Members stay as normalized task references so later stats and summaries
  // can read the full set without copying the display nodes.
  const virtual = Object.freeze({
    kind: 'orphans',
    count,
    memberTaskIds: Object.freeze(members.map(task => task.id)),
    members,
    stats,
    omittedNodes: Math.max(0, count - nodes.length),
  });
  return {
    id,
    name: id,
    status,
    createdAt: '',
    updatedAt: '',
    provenance: Object.freeze({
      state: Object.freeze({ kind: 'derived', from: 'task.status' }),
      percent: Object.freeze(stats.percentKnown
        ? { kind: 'derived', from: 'members' }
        : { kind: 'unknown' }),
    }),
    nodes,
    edges: EMPTY_EDGES,
    virtual,
  };
}

// Compose the view-only run after the real producer runs. The projection is
// memoized by snapshot identity and idempotent: a prior virtual run is removed
// before computing, so repeated calls cannot stack groups. With no members the
// input snapshot is returned unchanged.
export function withOrphanRun(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const cached = projectionCache.get(snapshot);
  if (cached) return cached;
  const runs = Array.isArray(snapshot.runs) ? snapshot.runs : [];
  const realRuns = runs.filter(run => !isVirtualRun(run));
  const base = realRuns.length === runs.length ? snapshot : { ...snapshot, runs: realRuns };
  const virtual = buildOrphanRun(base);
  const result = virtual ? { ...base, runs: [...realRuns, virtual] } : base;
  projectionCache.set(snapshot, result);
  // The projected snapshot is itself a memo key: a caller that passes the
  // result back gets the same reference instead of a structurally equal copy.
  projectionCache.set(result, result);
  return result;
}

export { isVirtualRun };
