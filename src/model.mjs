import { clean, clock, compactDuration } from './text.mjs';
import { t } from './i18n.mjs';
import { byteLength, defined, integer, iso, number, text } from './normalize.mjs';
import {
  memoLinkedRunTaskIds, memoLinkedTaskIds, memoRunStats,
} from './derived-cache.mjs';
import {
  cacheEvidence, errorEvidence, inferredTokenRate, normalizeRateHistory, replyEvidence,
  retryEvidence, retryFields, turnEvidence,
} from './evidence.mjs';

export const STATUSES = new Set([
  'pending', 'blocked', 'scheduled', 'running', 'paused',
  'completed', 'failed', 'cancelled', 'skipped', 'error', 'interrupted', 'lost',
]);
export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'skipped', 'error', 'interrupted', 'lost']);
// Triage buckets, not raw states: the sidebar, graph filter and run summary
// must agree that an error or lost node is a failure and paused work is
// blocked. `done` stays completed-only progress.
export const FAILED_STATES = new Set(['failed', 'error', 'lost']);
export const UNSUCCESSFUL_STATES = new Set([
  'failed', 'error', 'cancelled', 'lost', 'interrupted', 'blocked',
]);
const BLOCKED_STATES = new Set(['blocked', 'paused']);
export const isFailedState = state => FAILED_STATES.has(state);
export const isUnsuccessfulState = state => UNSUCCESSFUL_STATES.has(state);
export const isBlockedState = state => BLOCKED_STATES.has(state);
export const ACTIVITY_PHASES = new Set(['waiting', 'text', 'thinking', 'toolArgs', 'tool', 'retry']);
export const STALL_TOKEN_MS = 30_000;
export const STALL_WAIT_MS = 90_000;
export const MODES = new Set(['live', 'saved', 'demo']);
export const PROVENANCE_FIELDS = ['state', 'percent', 'agent', 'model', 'thinking', 'reply', 'error', 'retries'];
export const PROVENANCE_KINDS = new Set(['recorded', 'derived', 'simulated', 'unavailable', 'unknown']);
const PROVENANCE_ORIGINS = new Set(['controller', 'demo-engine', 'legacy-snapshot', 'viewer-placeholder']);

const provenanceEntry = (kind, from, truncated) => defined({ kind, from, truncated: truncated === true ? true : undefined });
const unavailable = () => provenanceEntry('unavailable');
const provenanceField = (raw, field) => explicitProvenanceEntry(raw?.provenance?.[field]);

function explicitProvenanceEntry(value) {
  if (!value || typeof value !== 'object' || !PROVENANCE_KINDS.has(value.kind)) return undefined;
  return provenanceEntry(value.kind, text(value.from, 64), value.truncated);
}

// One builder for every entity provenance record. Callers supply the entries
// their source can prove; this function applies the one precedence rule:
// explicit producer provenance, then the computed entry, then the legacy or
// unavailable marker. Demo snapshots are simulated as a whole.
function buildProvenance(raw, computed, { mode = 'live', legacy = false, fields = PROVENANCE_FIELDS, resolve } = {}) {
  if (mode === 'demo') {
    return Object.fromEntries(fields.map(field => [field, provenanceEntry('simulated')]));
  }
  return Object.fromEntries(fields.map(field => {
    const explicit = provenanceField(raw, field);
    const resolved = resolve ? resolve(field, explicit, computed) : explicit;
    return [field, resolved ?? (legacy ? provenanceEntry('unknown') : computed[field] ?? provenanceEntry('unavailable'))];
  }));
}

function inheritedProvenance(entry, fallbackFrom) {
  if (!entry) return provenanceEntry('derived', fallbackFrom);
  if (entry.kind === 'unknown' || entry.kind === 'simulated' || entry.kind === 'unavailable') {
    return provenanceEntry(entry.kind);
  }
  if (entry.kind === 'derived') return provenanceEntry('derived', entry.from ?? fallbackFrom);
  return provenanceEntry('derived', fallbackFrom);
}

// Mode answers what the snapshot is (live feed, saved capture, or synthetic
// demo); provenance answers where each rendered field came from. Process
// `--demo` wins, then an explicit v3 mode, then the legacy demo/connected bits.
export function modeFor(raw, { demoMode = false } = {}) {
  if (demoMode) return 'demo';
  if (raw && MODES.has(raw.mode)) return raw.mode;
  if (raw?.demo && typeof raw.demo === 'object') return 'demo';
  if (raw?.connected === false) return 'saved';
  return 'live';
}

export function snapshotProvenance(raw, mode = modeFor(raw)) {
  const source = raw?.provenance && typeof raw.provenance === 'object' ? raw.provenance : {};
  const demoSource = source.demo ?? raw?.demo;
  const demo = demoSource && typeof demoSource === 'object'
    ? defined({ cycle: integer(demoSource.cycle), phase: number(demoSource.phase), cycleMs: number(demoSource.cycleMs) })
    : undefined;
  return Object.fromEntries(Object.entries(defined({
    origin: PROVENANCE_ORIGINS.has(source.origin)
      ? source.origin
      : mode === 'demo' ? 'demo-engine' : 'legacy-snapshot',
    statePath: text(source.statePath, 1024),
    taskStateDir: text(source.taskStateDir, 1024),
    capturedAt: iso(source.capturedAt),
    view: source.view === 'once' || source.view === 'watch' ? source.view : undefined,
    demo: demo && Object.keys(demo).length ? demo : undefined,
  })).filter(([, value]) => value !== undefined));
}

const modelDisplay = value => text(value?.display, 128) ?? text(value?.model_id, 128) ?? text(value, 128);

function ownerFields(owner) {
  if (!owner || typeof owner !== 'object') return {};
  return {
    ownerKind: text(owner.kind, 32),
    ownerRunId: text(owner.runId, 80),
    ownerNodeId: text(owner.nodeId, 80),
    ownerTaskId: text(owner.taskId, 80),
  };
}

// Plan artifacts are referenced inside the task prompt, but the prompt itself
// is never persisted (the snapshot whitelist forbids prompt/transcript data).
// Extract only the plan path, the acting role and the working directory.
function planFields(spawn) {
  const spec = spawn && typeof spawn === 'object' ? spawn : {};
  const prompt = typeof spec.prompt === 'string' ? spec.prompt : '';
  const match = /(?:^|[\s(])(\.omo\/(?:plans|drafts)\/[A-Za-z0-9._\/-]+\.md)/.exec(prompt);
  const role = ['plan-reviewer', 'plan-consultant', 'ulw-execute', 'ulw-plan', 'mass-ulw']
    .find(candidate => prompt.includes(candidate));
  return {
    planPath: match?.[1] ? text(match[1], 512) : undefined,
    planRole: role ? text(role, 64) : undefined,
    workdir: text(spec.cwd, 512),
  };
}

function taskProvenanceValues(raw) {
  const stats = raw?.run_stats ?? raw?.runStats;
  const reply = replyEvidence(raw ?? {}, { live: raw?.live_progress });
  const error = errorEvidence(raw ?? {});
  const retry = retryEvidence(raw ?? {}, stats);
  return {
    state: STATUSES.has(raw?.status) ? provenanceEntry('recorded', 'status') : provenanceEntry('derived', 'status'),
    percent: number(raw?.percent) !== undefined ? provenanceEntry('recorded', 'percent')
      : raw?.status === 'completed' ? provenanceEntry('derived', 'completed status') : unavailable(),
    agent: text(raw?.agent, 128) ? provenanceEntry('recorded', 'agent')
      : text(raw?.agent_type, 128) ? provenanceEntry('derived', 'agent_type')
        : text(raw?.category, 128) ? provenanceEntry('derived', 'category') : unavailable(),
    model: text(raw?.resolved_model?.display ?? raw?.model, 256)
      ? provenanceEntry('recorded', 'model') : unavailable(),
    thinking: text(raw?.thinking ?? raw?.reasoning ?? raw?.reasoning_content ?? raw?.live_progress?.thinking, 1200)
      ? provenanceEntry('recorded', 'thinking') : unavailable(),
    reply: reply.reply !== undefined
      ? provenanceEntry('recorded', reply.replySource ?? 'reply', reply.replyTruncated)
      : unavailable(),
    error: error.error !== undefined ? provenanceEntry('recorded', error.errorSource ?? 'error') : unavailable(),
    retries: retry.retries !== undefined
      ? provenanceEntry(retry.retriesKind ?? 'recorded', retry.retriesSource)
      : unavailable(),
  };
}

function nodeProvenanceValues(source, task) {
  const stats = source?.run_stats ?? source?.runStats;
  const ownReply = replyEvidence(source ?? {});
  const ownError = errorEvidence(source ?? {});
  const ownRetry = retryEvidence(source ?? {}, stats);
  const computed = {
    state: provenanceEntry('recorded', 'state'),
    percent: number(source?.percent) !== undefined ? provenanceEntry('recorded', 'percent')
      : number(task?.percent) !== undefined ? provenanceEntry('derived', 'task.percent')
        : source?.state === 'completed' ? provenanceEntry('derived', 'completed status') : unavailable(),
    agent: text(source?.agent, 64) ? provenanceEntry('recorded', 'agent')
      : task?.agent !== undefined ? inheritedProvenance(task.provenance?.agent, 'task.agent')
        : (text(source?.category, 64) ?? text(source?.route?.category, 64) ?? task?.category)
          ? provenanceEntry('derived', 'category') : unavailable(),
    model: text(source?.model, 96) ? provenanceEntry('recorded', 'model')
      : task?.model !== undefined ? inheritedProvenance(task.provenance?.model, 'task.model') : unavailable(),
    thinking: text(source?.thinking, 1200) ? provenanceEntry('recorded', 'thinking')
      : task?.thinking !== undefined ? inheritedProvenance(task.provenance?.thinking, 'task.thinking') : unavailable(),
    reply: ownReply.reply !== undefined
      ? provenanceEntry('recorded', ownReply.replySource ?? 'reply', ownReply.replyTruncated)
      : task?.reply !== undefined ? inheritedProvenance(task.provenance?.reply, 'task.reply') : unavailable(),
    error: ownError.error !== undefined ? provenanceEntry('recorded', ownError.errorSource ?? 'error')
      : task?.error !== undefined ? inheritedProvenance(task.provenance?.error, 'task.error') : unavailable(),
    retries: ownRetry.retries !== undefined
      ? provenanceEntry(ownRetry.retriesKind ?? 'recorded', ownRetry.retriesSource)
      : task?.retries !== undefined ? inheritedProvenance(task.provenance?.retries, 'task.retries') : unavailable(),
  };
  // Older normalized snapshots can carry an explicit "unavailable" agent
  // even though the linked task now supplies a category. That category is
  // real evidence, so the derived value replaces the stale marker.
  const resolve = (field, explicit) => field === 'agent' && explicit?.kind === 'unavailable'
    && computed.agent.kind === 'derived' && computed.agent.from === 'category'
    ? computed.agent
    : explicit;
  return { computed, resolve };
}

function runProvenanceValues(raw, nodes) {
  // An empty run has no nodes to derive a percentage from. Every node on an
  // empty array would otherwise claim a derived percentage for absent work.
  const known = nodes.length > 0 && nodes.every(node => Number.isFinite(node.percent));
  return {
    state: STATUSES.has(raw?.status) ? provenanceEntry('recorded', 'status') : provenanceEntry('derived', 'nodes'),
    percent: known ? provenanceEntry('derived', 'nodes') : unavailable(),
  };
}

function outputEvidence(raw) {
  const rawOutput = typeof raw.output === 'string' ? raw.output : undefined;
  const explicitBytes = integer(raw.outputBytes ?? raw.output_bytes);
  let lines;
  if (rawOutput !== undefined) {
    lines = rawOutput.split(/\r?\n/).map(line => text(line, 240)).filter(Boolean).slice(-8);
  } else if (Array.isArray(raw.recentEvents)) {
    lines = raw.recentEvents.map(line => text(line, 240)).filter(Boolean).slice(-8);
  }
  const bytes = explicitBytes ?? (rawOutput !== undefined ? byteLength(rawOutput) : undefined);
  const truncated = typeof raw.outputTruncated === 'boolean' ? raw.outputTruncated
    : bytes !== undefined && rawOutput !== undefined ? bytes > byteLength(rawOutput) : undefined;
  return defined({
    recentEvents: lines?.length ? lines : undefined,
    outputBytes: bytes,
    outputTruncated: truncated,
  });
}

function artifactEvidence(raw) {
  const source = raw.resultArtifact ?? raw.result_artifact ?? raw.artifact;
  if (!source || typeof source !== 'object') return {};
  const artifact = defined({
    relativePath: text(source.relativePath ?? source.relative_path, 512),
    bytes: integer(source.bytes),
    sha256: text(source.sha256, 128),
    statsPath: text(source.stats?.relativePath ?? source.stats?.relative_path, 512),
    statsBytes: integer(source.stats?.bytes),
  });
  return Object.keys(artifact).length ? { artifact } : {};
}

function normalizeVariants(raw) {
  if (!Array.isArray(raw)) return undefined;
  const variants = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const source = text(entry.source, 80);
    if (!source) continue;
    const variant = {
      source,
      updatedAt: iso(entry.updatedAt),
      checkpointSeq: integer(entry.checkpointSeq),
      taskSeq: integer(entry.taskSeq),
      status: STATUSES.has(entry.status) ? entry.status : undefined,
      nodeCount: integer(entry.nodeCount),
    };
    variants.push(Object.fromEntries(Object.entries(variant).filter(([, value]) => value !== undefined)));
  }
  return variants.length ? variants : undefined;
}

function normalizeSourceStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = text(raw.id, 80);
  if (!id) return null;
  const counts = value => ({
    files: integer(value?.files) ?? 0,
    accepted: integer(value?.accepted) ?? 0,
    foreign: integer(value?.foreign) ?? 0,
    invalid: integer(value?.invalid) ?? 0,
  });
  return Object.fromEntries(Object.entries({
    id,
    label: text(raw.label, 80),
    origin: text(raw.origin, 40),
    root: text(raw.root, 1024),
    status: ['ok', 'missing', 'empty', 'unreadable'].includes(raw.status) ? raw.status : 'missing',
    tasks: counts(raw.tasks),
    runs: counts(raw.runs),
    scannedAt: iso(raw.scannedAt),
    error: text(raw.error, 512),
  }).filter(([, value]) => value !== undefined));
}

export function normalizeActivity(raw) {
  if (!raw || typeof raw !== 'object' || !ACTIVITY_PHASES.has(raw.phase)) return undefined;
  const activity = { phase: raw.phase };
  const value = text(raw.text, 512);
  const tool = text(raw.tool, 64);
  if (value !== undefined) activity.text = value;
  if (tool !== undefined) activity.tool = tool;
  if (integer(raw.attempt) !== undefined) activity.attempt = raw.attempt;
  if (integer(raw.maxAttempts) !== undefined) activity.maxAttempts = raw.maxAttempts;
  if (number(raw.since) !== undefined) activity.since = raw.since;
  if (number(raw.lastAt) !== undefined) activity.lastAt = raw.lastAt;
  if (number(raw.tokensIn) !== undefined) activity.tokensIn = raw.tokensIn;
  if (number(raw.tokensOut) !== undefined) activity.tokensOut = raw.tokensOut;
  return activity;
}

export function normalizeChild(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = text(raw.id ?? raw.task_id, 80);
  if (!id) return null;
  return {
    id,
    description: text(raw.description ?? raw.label, 160) ?? id,
    status: STATUSES.has(raw.status) ? raw.status : 'unknown',
    percent: number(raw.percent),
    agent: text(raw.agent, 64),
    model: text(raw.model, 96),
  };
}

// One task normalizer for the snapshot and host-store paths. `host` keeps the
// 2000-unit text budget the task store promises and applies the host-only
// owner/spawn-spec fields; every shared field follows one precedence so the
// same record cannot render one value from TaskData and another from a
// snapshot.
export function normalizeTask(raw, { mode = 'live', legacy = false, host = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = text(host ? raw.task_id : raw.id ?? raw.task_id, 80);
  if (!id) return null;
  const live = raw.live_progress;
  const stats = raw.run_stats ?? raw.runStats;
  // An unrecognized host status is not evidence of a pending task. Keep it
  // explicit so counts, ordering, and the status pill cannot claim a
  // lifecycle state the producer never reported.
  const status = STATUSES.has(raw.status) ? raw.status : 'unknown';
  const percentSource = raw.percent ?? live?.percent;
  const descriptionLimit = host ? 2000 : 240;
  const owner = ownerFields(raw.owner);
  const plan = planFields(raw.spawn_spec);
  const rateHistory = normalizeRateHistory(raw.tokenRateHistory);
  const tool = text(live?.current_tool, 128);
  const liveLine = text(live?.last_assistant_line, 512);
  const progress = text(raw.progress, 512)
    ?? text([tool ? `[${tool}]` : undefined, liveLine].filter(Boolean).join(' '), 512)
    ?? text(live?.activity, 512);
  // Both paths must read the same percent evidence. A live-only percent is
  // recorded percent provenance on the host task and on a snapshot task.
  const provenanceRaw = { ...raw, status, percent: percentSource };
  const task = {
    id,
    description: text(raw.description, descriptionLimit)
      ?? text(raw.task_description, descriptionLimit)
      ?? text(raw.task_summary, descriptionLimit)
      ?? text(raw.name, descriptionLimit)
      ?? (host ? undefined : id),
    summary: text(raw.summary, 240) ?? text(raw.task_summary, 240),
    status,
    parentTaskId: text(raw.parentTaskId ?? raw.parent_task_id, 80),
    agent: text(raw.agent, 128) ?? text(raw.agent_type, 128),
    model: text(raw.resolved_model?.display, 256) ?? text(raw.model, 256),
    modelRequested: text(raw.modelRequested, 128) ?? modelDisplay(raw.requested_model),
    modelEffective: text(raw.modelEffective, 128) ?? modelDisplay(raw.effective_model),
    modelResolved: text(raw.modelResolved, 128) ?? modelDisplay(raw.resolved_model),
    category: text(raw.category, 128),
    ownerKind: text(raw.ownerKind, 32) ?? owner.ownerKind,
    ownerRunId: text(raw.ownerRunId, 80) ?? owner.ownerRunId,
    ownerNodeId: text(raw.ownerNodeId, 80) ?? owner.ownerNodeId,
    ownerTaskId: text(raw.ownerTaskId, 80) ?? owner.ownerTaskId,
    executionMode: text(raw.executionMode ?? raw.execution_mode, 32),
    backgroundMode: text(raw.backgroundMode ?? raw.background_mode, 32),
    depth: number(raw.depth),
    residencyState: text(raw.residencyState ?? raw.residency_state, 32),
    configGeneration: integer(raw.configGeneration ?? raw.config_generation),
    parentSessionId: text(raw.parentSessionId ?? raw.parent_session_id, 80),
    rootSessionId: text(raw.rootSessionId ?? raw.root_session_id, 80),
    childSessionId: text(raw.childSessionId ?? raw.child_session_id, 80),
    runtimeMs: number(raw.runtimeMs ?? raw.runtime_ms ?? stats?.runtime_ms),
    generationMs: number(raw.generationMs ?? raw.generation_ms ?? stats?.generation_ms),
    tokensPerSecond: number(raw.tokensPerSecond ?? raw.tokens_per_second ?? stats?.tokens_per_second),
    planPath: text(raw.planPath, 512) ?? plan.planPath,
    planRole: text(raw.planRole, 64) ?? plan.planRole,
    workdir: text(raw.workdir, 512) ?? plan.workdir,
    progress,
    thinking: text(raw.thinking ?? raw.reasoning ?? raw.reasoning_content ?? live?.thinking, 1200),
    percent: percentFor({ percent: percentSource, state: status }),
    tokensIn: number(raw.tokensIn ?? raw.tokens_in ?? raw.usage?.input_tokens ?? raw.token_usage?.input ?? stats?.input_tokens),
    tokensOut: number(raw.tokensOut ?? raw.tokens_out ?? raw.usage?.output_tokens ?? raw.token_usage?.output ?? stats?.output_tokens),
    ...inferredTokenRate(raw, stats),
    ...(rateHistory ? { tokenRateHistory: rateHistory } : {}),
    ...cacheEvidence(raw, stats),
    ...retryFields(retryEvidence(raw, stats)),
    ...replyEvidence(raw, { live }),
    ...errorEvidence(raw),
    ...turnEvidence(raw, stats),
    startedAt: iso(raw.startedAt ?? raw.started_at ?? live?.started_at ?? raw.created_at),
    completedAt: iso(raw.completedAt ?? raw.completed_at ?? raw.terminal_at)
      ?? (TERMINAL.has(status) ? iso(raw.updatedAt ?? raw.updated_at) : undefined),
    updatedAt: iso(raw.updatedAt ?? raw.updated_at),
    activity: normalizeActivity(raw.activity),
    logs: Array.isArray(raw.logs) ? raw.logs.map(line => text(line, 240)).filter(Boolean).slice(-12) : undefined,
    children: Array.isArray(raw.children) ? raw.children.map(normalizeChild).filter(Boolean) : undefined,
    source: text(raw.source, 80),
    variants: normalizeVariants(raw.variants),
    provenance: buildProvenance(provenanceRaw, taskProvenanceValues(provenanceRaw), { mode, legacy }),
  };
  if (TERMINAL.has(status)) {
    delete task.progress;
    delete task.activity;
  }
  return Object.fromEntries(Object.entries(task).filter(([, value]) => value !== undefined));
}

export function normalizeRun(raw, taskMap = new Map(), { mode = 'live', legacy = false } = {}) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null;
  const id = text(raw.id ?? raw.run_id ?? raw.runId, 96);
  if (!id) return null;
  const seen = new Set();
  const nodes = [];
  const warnings = [];
  for (const source of raw.nodes) {
    if (!source || typeof source !== 'object') {
      warnings.push({ code: 'node-dropped', reason: 'invalid-record' });
      continue;
    }
    const nodeId = text(source.id, 80);
    if (!nodeId) {
      warnings.push({ code: 'node-dropped', reason: 'missing-id' });
      continue;
    }
    if (seen.has(nodeId)) {
      warnings.push({ code: 'node-dropped', nodeId, reason: 'duplicate-id' });
      continue;
    }
    if (!STATUSES.has(source.state)) {
      warnings.push(defined({
        code: 'node-dropped', nodeId, reason: 'unknown-state', state: text(String(source.state ?? ''), 40),
      }));
      continue;
    }
    seen.add(nodeId);
    const taskId = text(source.taskId ?? source.task_id, 80);
    const task = taskId ? taskMap.get(taskId) : undefined;
    const stats = source.runStats ?? source.run_stats;
    const state = source.state;
    const { computed: provenanceValues, resolve } = nodeProvenanceValues(source, task);
    nodes.push({
      id: nodeId,
      label: text(source.label, 80) ?? task?.description ?? nodeId,
      state,
      attempt: integer(source.attempt) ?? 1,
      taskId,
      task,
      percent: percentFor({ percent: source.percent ?? task?.percent, state }),
      category: text(source.category, 64) ?? text(source.route?.category, 64) ?? task?.category,
      agent: text(source.agent, 64) ?? task?.agent,
      model: text(source.model, 96) ?? task?.model,
      progress: text(source.progress, 512) ?? task?.progress,
      thinking: text(source.thinking, 1200) ?? task?.thinking,
      // Live task activity describes a node only while that node is running;
      // a terminal node keeps its own recorded activity (or none) so the graph
      // shows completion/failure evidence instead of a task that is still busy.
      activity: state === 'running'
        ? normalizeActivity(source.activity) ?? task?.activity
        : normalizeActivity(source.activity),
      tokensIn: number(source.tokensIn ?? source.tokens_in ?? stats?.input_tokens) ?? task?.tokensIn,
      tokensOut: number(source.tokensOut ?? source.tokens_out ?? stats?.output_tokens) ?? task?.tokensOut,
      ...turnEvidence(source, stats, task),
      startedAt: iso(source.startedAt ?? source.started_at) ?? task?.startedAt,
      completedAt: iso(source.completedAt ?? source.completed_at) ?? task?.completedAt,
      children: Array.isArray(source.children) ? source.children.map(normalizeChild).filter(Boolean) : task?.children,
      logs: Array.isArray(source.logs) ? source.logs.map(line => text(line, 240)).filter(Boolean).slice(-12) : task?.logs,
      ...inferredTokenRate(source, stats, task),
      ...(normalizeRateHistory(source.tokenRateHistory) ?? (task?.tokenRateHistory
        ? { tokenRateHistory: task.tokenRateHistory } : {})),
      ...cacheEvidence(source, stats, task),
      ...retryFields(retryEvidence(source, stats, task)),
      ...replyEvidence(source, { fallback: task }),
      ...errorEvidence(source, task),
      ...outputEvidence(source),
      ...artifactEvidence(source),
      provenance: buildProvenance(source, provenanceValues, { mode, legacy, resolve }),
    });
  }
  const edges = [];
  const edgeKeys = new Set();
  for (const edge of raw.edges) {
    if (!edge || typeof edge !== 'object' || !seen.has(edge.from) || !seen.has(edge.to)) {
      warnings.push(defined({
        code: 'edge-dropped', from: text(edge?.from, 80), to: text(edge?.to, 80), reason: 'unknown-node',
      }));
      continue;
    }
    if (edge.from === edge.to) {
      warnings.push(defined({
        code: 'edge-dropped', from: text(edge.from, 80), to: text(edge.to, 80), reason: 'self-edge',
      }));
      continue;
    }
    const key = `${edge.from}\u0000${edge.to}`;
    if (!edgeKeys.has(key)) {
      edges.push({ from: edge.from, to: edge.to });
      edgeKeys.add(key);
    }
  }
  const status = STATUSES.has(raw.status) ? raw.status : deriveRunStatus(nodes);
  return {
    id,
    name: text(raw.name ?? raw.run_key ?? raw.runKey, 120) ?? id,
    todoTitle: text(raw.todoTitle, 160),
    status,
    createdAt: iso(raw.createdAt ?? raw.created_at) ?? '',
    updatedAt: iso(raw.updatedAt ?? raw.updated_at) ?? '',
    checkpointSeq: integer(raw.checkpointSeq ?? raw.checkpoint_seq),
    source: text(raw.source, 80),
    variants: normalizeVariants(raw.variants),
    provenance: buildProvenance(raw, runProvenanceValues(raw, nodes), { mode, legacy, fields: ['state', 'percent'] }),
    ...(warnings.length ? { warnings, warningCount: warnings.length } : {}),
    nodes,
    edges,
  };
}

export function deriveRunStatus(nodes) {
  if (!nodes.length) return 'pending';
  if (nodes.some(node => isFailedState(node.state))) return 'failed';
  if (nodes.some(node => node.state === 'running')) return 'running';
  if (nodes.some(node => isBlockedState(node.state))) return 'blocked';
  if (nodes.some(node => node.state === 'interrupted')) return 'interrupted';
  if (nodes.every(node => TERMINAL.has(node.state))) {
    return nodes.every(node => node.state === 'completed' || node.state === 'skipped') ? 'completed' : 'cancelled';
  }
  return 'pending';
}

export function normalizeSnapshot(raw, { demoMode = false } = {}) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.runs)) return null;
  const mode = modeFor(raw, { demoMode });
  const trusted = mode === 'demo' || MODES.has(raw.mode) || (raw.demo && typeof raw.demo === 'object');
  const legacy = mode !== 'demo' && !trusted;
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map(task => normalizeTask(task, { mode, legacy })).filter(Boolean)
    : [];
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const runs = raw.runs.map(run => normalizeRun(run, taskMap, { mode, legacy })).filter(Boolean);
  const ordered = orderRuns(runs);
  const provenance = snapshotProvenance(raw, mode);
  // A saved capture must not borrow the viewer clock: elapsed measures work,
  // not the time the file sat on disk. Only a live feed may default to now.
  const generatedAt = iso(raw.generatedAt ?? raw.updatedAt ?? raw.generated_at)
    ?? provenance.capturedAt
    ?? (mode === 'live' && raw.connected !== false ? new Date().toISOString() : undefined);
  return {
    version: number(raw.version) ?? 1,
    sessionId: text(raw.sessionId ?? raw.parent_session_id, 120) ?? 'local',
    mode,
    connected: mode === 'saved' ? false : raw.connected !== false,
    language: text(raw.language, 16) ?? 'en',
    generatedAt,
    provenance,
    demo: provenance.demo,
    sources: Array.isArray(raw.sources) ? raw.sources.map(normalizeSourceStatus).filter(Boolean) : [],
    runs: ordered,
    tasks,
  };
}

export function orderRuns(runs) {
  const weight = run => isActiveRun(run) ? 0 : run.status === 'failed' ? 1 : 2;
  return [...runs].sort((a, b) => {
    const order = weight(a) - weight(b);
    if (order !== 0) return order;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
}

export function isActiveRun(run) {
  return run.status === 'running' || run.nodes.some(node => node.state === 'running');
}

// One index pass counts each node's incoming edges and records the reverse
// edges, then each layer releases only the nodes whose last dependency just
// landed. The previous version rescanned every remaining node against every
// edge for every layer (O(L*N*E)), which made a 500-node chain dominate the
// layout. Nodes are grouped by id so a run that repeats an id still emits
// every occurrence in the same row.
export function layers(run) {
  const byId = new Map();
  const position = new Map();
  for (let index = 0; index < run.nodes.length; index++) {
    const node = run.nodes[index];
    const group = byId.get(node.id);
    if (group) group.push(node);
    else {
      byId.set(node.id, [node]);
      position.set(node.id, index);
    }
  }
  const pending = new Map();
  for (const id of byId.keys()) pending.set(id, 0);
  const dependents = new Map();
  for (const edge of run.edges) {
    // An edge into a node this run does not contain cannot gate anything. An
    // edge out of a missing node still counts, so its target stays blocked
    // and the run reports a cycle instead of silently dropping the edge.
    if (!pending.has(edge.to)) continue;
    pending.set(edge.to, pending.get(edge.to) + 1);
    const targets = dependents.get(edge.from);
    if (targets) targets.push(edge.to);
    else dependents.set(edge.from, [edge.to]);
  }
  // Row order is the run's declared node order, not the order edges happened
  // to release a node, so both the first row and every later row use it.
  const byDeclaredOrder = (a, b) => position.get(a) - position.get(b);
  let ready = [...pending.keys()].filter(id => pending.get(id) === 0).sort(byDeclaredOrder);
  const rows = [];
  let released = 0;
  while (ready.length) {
    const row = [];
    for (const id of ready) row.push(...byId.get(id));
    rows.push(row);
    released += ready.length;
    const next = [];
    for (const id of ready) {
      for (const target of dependents.get(id) ?? []) {
        const left = pending.get(target) - 1;
        pending.set(target, left);
        if (left === 0) next.push(target);
      }
    }
    next.sort(byDeclaredOrder);
    ready = next;
  }
  if (released < pending.size) {
    const error = new Error('A dependency cycle was detected.');
    error.code = 'cycle';
    throw error;
  }
  return rows;
}

export function incoming(run, nodeId) {
  return run.edges.filter(edge => edge.to === nodeId).map(edge => edge.from);
}

export function outgoing(run, nodeId) {
  return run.edges.filter(edge => edge.from === nodeId).map(edge => edge.to);
}

export function nodeMap(run) {
  return new Map(run.nodes.map(node => [node.id, node]));
}

function computeRunStats(run) {
  const total = run.nodes.length;
  const counts = {
    running: 0, completed: 0, failed: 0, blocked: 0, paused: 0, pending: 0,
    scheduled: 0, cancelled: 0, skipped: 0, error: 0, interrupted: 0, lost: 0,
  };
  let sum = 0;
  let percentKnown = total > 0;
  let finished = 0;
  let failed = 0;
  let blocked = 0;
  for (const node of run.nodes) {
    counts[node.state] = (counts[node.state] ?? 0) + 1;
    if (TERMINAL.has(node.state)) finished += 1;
    if (isFailedState(node.state)) failed += 1;
    if (isBlockedState(node.state)) blocked += 1;
    if (Number.isFinite(node.percent)) sum += node.percent;
    else percentKnown = false;
  }
  // `failed` and `blocked` are triage buckets, not raw state names: `done`
  // stays completed-only progress; `finished` counts every terminal state.
  counts.failed = failed;
  counts.blocked = blocked;
  return {
    total,
    counts,
    percent: percentKnown ? Math.round(sum / total) : undefined,
    percentKnown,
    done: counts.completed,
    finished,
  };
}

// A virtual run is a viewer projection, never producer ownership. The marker
// is structural so model readers can recognize it without importing the
// projection module that builds it.
export function isVirtualRun(run) {
  return Boolean(run) && typeof run === 'object' && run.virtual?.kind === 'orphans';
}

export function linkedTaskIds(snapshot) {
  return memoLinkedTaskIds(snapshot, state => {
    const ids = new Set();
    for (const run of state.runs ?? []) {
      // A virtual run displays orphan tasks; it never becomes their owner.
      // Counting its nodes here would erase the orphan list that builds it.
      if (isVirtualRun(run)) continue;
      for (const node of run.nodes ?? []) if (node.taskId) ids.add(node.taskId);
    }
    return ids;
  });
}

// A single run's linked task ids. taskListLayout and the orphan list need the
// set for one run, not the whole snapshot; keying it by the run object lets a
// hidden-subject overlay (a new snapshot sharing the same runs) reuse it.
// The virtual run's visible TASKS scope is its full membership, not the
// display-capped node list: an overflow node is hidden from the graph, never
// dropped from the task list.
export function linkedTaskIdsForRun(run) {
  return memoLinkedRunTaskIds(run, target => {
    if (isVirtualRun(target)) return new Set(target.virtual?.memberTaskIds ?? []);
    const ids = new Set();
    for (const node of target.nodes ?? []) if (node.taskId) ids.add(node.taskId);
    return ids;
  });
}

export function runStats(run) {
  return memoRunStats(run, computeRunStats);
}

// Canonical navigation order: running first, then description, then id as the
// stable tiebreak. The sidebar, the switcher and standalone task lists all
// import this comparator so one snapshot cannot render in two different orders.
export function compareNavigationTasks(a, b) {
  const active = Number(b?.status === 'running') - Number(a?.status === 'running');
  if (active) return active;
  const byDescription = String(a?.description ?? a?.id ?? '')
    .localeCompare(String(b?.description ?? b?.id ?? ''));
  return byDescription || String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

// Pure task selectors shared by navigation, rendering, and duty input. The
// memoized render wrapper owns caching; these selectors remain deterministic
// and preserve the canonical running/description/id order.
export function navTasks(snapshot) {
  return Object.freeze((snapshot?.tasks ?? [])
    .filter(task => !task.parentTaskId)
    .sort(compareNavigationTasks));
}

export function orphanNavTasks(snapshot) {
  const linked = linkedTaskIds(snapshot ?? { runs: [] });
  return Object.freeze(navTasks(snapshot).filter(task => !linked.has(task.id)));
}

export function standaloneTasks(snapshot) {
  return orphanNavTasks(snapshot);
}

export function findRunningTarget(snapshot, previous) {
  if (!snapshot?.connected || snapshot.mode === 'saved') return undefined;
  const targets = [];
  for (const run of snapshot.runs) {
    // Follow tracks producer work. A virtual node mirrors a task that the
    // standalone pass below already offers, so following it would move the
    // run subject onto the display-only group.
    if (isVirtualRun(run)) continue;
    for (const node of run.nodes) {
      if (node.state === 'running') {
        targets.push({ kind: 'node', runId: run.id, nodeId: node.id, taskId: node.taskId });
      }
    }
  }
  for (const task of standaloneTasks(snapshot)) {
    if (task.status === 'running') targets.push({ kind: 'task', taskId: task.id });
  }
  if (!targets.length) return undefined;
  if (previous) {
    const exact = targets.find(target => target.kind === previous.kind &&
      target.runId === previous.runId && target.nodeId === previous.nodeId &&
      target.taskId === previous.taskId);
    if (exact) return exact;
    if (previous.taskId) {
      const transferred = targets.find(target => target.taskId === previous.taskId);
      if (transferred) return transferred;
    }
  }
  return targets[0];
}

export function elapsedMs(entity, { now = Date.now(), connected = true, updatedAt } = {}) {
  const start = Date.parse(entity?.startedAt);
  if (!Number.isFinite(start)) return null;
  let end;
  if (entity.completedAt) end = Date.parse(entity.completedAt);
  else if (entity.state === 'running' || entity.status === 'running') end = connected ? now : Date.parse(updatedAt);
  else end = Date.parse(updatedAt);
  if (!Number.isFinite(end) || end < start) return null;
  return end - start;
}

export function elapsedLabel(entity, options) {
  const value = elapsedMs(entity, options);
  return value === null ? '—' : clock(value);
}

// A node owns its activity; a live task's activity describes the node only
// while that node is running. Callers pass either a node or a plain task
// object, and only a running (or unstated) node borrows from its linked task.
export function nodeActivity(node) {
  if (!node) return undefined;
  if (node.activity) return node.activity;
  if (node.state && node.state !== 'running') return undefined;
  return node.task?.activity;
}

export function activitySummary(activity, { now = Date.now(), language = 'en' } = {}) {
  if (!activity || !ACTIVITY_PHASES.has(activity.phase)) return null;
  const marks = { text: '✎', thinking: '💭', toolArgs: '⚙', waiting: '⏳', tool: '▶', retry: '↻' };
  const tokenPhase = ['text', 'thinking', 'toolArgs'].includes(activity.phase);
  const since = Number.isFinite(activity.since) ? activity.since : now;
  const lastAt = Number.isFinite(activity.lastAt) ? activity.lastAt : since;
  const gap = Math.max(0, now - lastAt);
  const span = Math.max(0, now - since);
  const stalled = tokenPhase ? gap >= STALL_TOKEN_MS : activity.phase === 'waiting' && span >= STALL_WAIT_MS;
  let label;
  if (tokenPhase) {
    const tool = activity.phase === 'toolArgs' && activity.tool ? `${clean(activity.tool)} ` : '';
    const age = gap < 2000
      ? t(language, 'now')
      : t(language, 'ago', { time: compactDuration(gap, language) });
    label = `${tool}${age}`;
  } else if (activity.phase === 'waiting') {
    label = t(language, 'waitingModel', { time: compactDuration(span, language) });
  } else if (activity.phase === 'tool') {
    const tool = clean(activity.tool ?? t(language, 'toolFallback'));
    label = t(language, 'toolRunning', { tool, time: compactDuration(span, language) });
  } else {
    label = t(language, 'retry', {
      attempt: activity.attempt ?? '?',
      max: activity.maxAttempts ?? '?',
      time: compactDuration(span, language),
    });
  }
  return {
    mark: marks[activity.phase],
    label,
    text: tokenPhase && activity.text ? activity.text : '',
    stalled,
    phase: activity.phase,
  };
}

// The only entity-percent derivation. A recorded value is clamped to the
// renderable range; a completed entity without one is a derived 100%.
export function percentFor(entity) {
  if (!entity) return undefined;
  if (Number.isFinite(entity.percent)) return Math.max(0, Math.min(100, entity.percent));
  const state = entity.state ?? entity.status;
  return state === 'completed' ? 100 : undefined;
}

// The inverse lookup used by the navigation panel: a task has a place in the
// graph only when a node in a loaded run declares it as its task. Standalone
// tasks and tasks restored from runs without a checkpoint return undefined.
// A virtual run displays orphans but owns nothing, so it never answers this
// producer-ownership lookup by default. Graph/run selection may explicitly
// address the display projection with `includeVirtual`; task selection never
// passes it, so a TASKS row cannot become owned by the display group.
// A task referenced by several historical runs prefers the run the user is
// already looking at, then the first run in the snapshot's display order.
export function nodeForTask(snapshot, taskId, { preferRunId, includeVirtual = false } = {}) {
  if (!snapshot?.runs?.length || !taskId) return undefined;
  const matches = [];
  for (const run of snapshot.runs) {
    if (!includeVirtual && isVirtualRun(run)) continue;
    const node = run.nodes.find(candidate => candidate.taskId === taskId);
    if (node) matches.push({ run, node });
  }
  if (!matches.length) return undefined;
  return matches.find(match => match.run.id === preferRunId) ?? matches[0];
}
