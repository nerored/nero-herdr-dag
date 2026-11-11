import { basename, dirname, join, resolve, sep } from 'node:path';
import { normalizeLanguage, statusLabel, t } from './i18n.mjs';
import { modeFor, nodeActivity } from './model.mjs';
import { recordEntry, relativeDisplay } from './records.mjs';
import { absolutePath, safeFileWithin, safeOpenRecordPath } from './safe-path.mjs';
import { clean } from './text.mjs';

// States that stop a subject before its nominal goal. They own a diagnosis
// card and a copyable evidence bundle; they never expose a retry action.
export const DIAGNOSIS_STATES = new Set([
  'failed', 'error', 'cancelled', 'blocked', 'interrupted', 'lost', 'paused',
]);

export const DIAGNOSIS_ACTIONS = Object.freeze(['c', 'p', 'o']);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SAFE_RELATIVE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

const defined = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

function blockedUpstream(run, node) {
  if (!run || !node) return [];
  const byId = new Map(run.nodes.map(entry => [entry.id, entry]));
  return run.edges
    .filter(edge => edge.to === node.id)
    .map(edge => byId.get(edge.from))
    .filter(upstream => upstream && upstream.state !== 'completed' && upstream.state !== 'skipped')
    .map(upstream => defined({
      id: upstream.id,
      label: upstream.label ?? upstream.id,
      state: upstream.state,
    }));
}

function lastActivity(node, task) {
  const activity = nodeActivity(node ?? task);
  if (activity?.tool) {
    return defined({ kind: 'tool', tool: activity.tool, at: activity.lastAt });
  }
  if (activity?.text) {
    return defined({ kind: 'activity', text: activity.text, at: activity.lastAt });
  }
  const logs = node?.logs ?? task?.logs;
  const line = Array.isArray(logs) ? logs.at(-1) : undefined;
  return line ? { kind: 'log', text: line } : undefined;
}

function artifactEntry(root, artifact) {
  if (!artifact || typeof artifact !== 'object') return undefined;
  const raw = typeof artifact.relativePath === 'string' ? artifact.relativePath.replaceAll('\\', '/') : undefined;
  // statsPath crosses the same Windows/POSIX boundary as relativePath, so the
  // separator normalization must happen before the relative-path gate.
  const rawStats = typeof artifact.statsPath === 'string' ? artifact.statsPath.replaceAll('\\', '/') : undefined;
  if (!raw || !SAFE_RELATIVE.test(raw)) {
    return defined({
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      statsBytes: artifact.statsBytes,
    });
  }
  const absolute = root ? resolve(root, raw) : undefined;
  const inside = !absolute || !root ? undefined
    : (absolute === resolve(root) || absolute.startsWith(`${resolve(root)}${sep}`));
  const safeAbsolute = inside ? absolute : undefined;
  return defined({
    relativePath: raw,
    absolute: safeAbsolute,
    display: relativeDisplay(root, safeAbsolute) ?? raw,
    name: basename(raw),
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    statsRelativePath: rawStats || undefined,
    statsAbsolute: root && rawStats && SAFE_RELATIVE.test(rawStats)
      ? resolve(root, rawStats)
      : undefined,
    statsDisplay: rawStats || undefined,
    statsBytes: artifact.statsBytes,
  });
}

// Build the diagnostic view of one details subject from the already normalised
// snapshot. No value is invented: absent fields stay undefined and the renderer
// prints an explicit "not recorded" label.
export function diagnosisFor({ snapshot, run, node, task, subject } = {}) {
  const kind = subject === 'task' || (!node && task) ? 'task' : 'node';
  const entity = kind === 'task' ? task : node;
  const state = kind === 'task' ? task?.status : node?.state;
  if (!entity || !DIAGNOSIS_STATES.has(state)) return null;

  const mode = modeFor(snapshot);
  const simulated = mode === 'demo';
  const taskEntity = kind === 'task' ? task : (node?.task ?? task);
  const taskStatus = taskEntity?.status;
  const nodeState = node?.state;
  const taskId = taskEntity?.id ?? node?.taskId;
  const root = simulated ? undefined : absolutePath(snapshot?.provenance?.taskStateDir);
  const reason = entity.error;
  const blockedBy = state === 'blocked' || state === 'paused' ? blockedUpstream(run, node) : [];

  const records = [];
  if (root && taskId && SAFE_ID.test(taskId)) {
    const absolute = join(root, 'tasks', `${taskId}.json`);
    records.push(recordEntry('task', root, absolute));
  }
  if (root && run?.id && SAFE_ID.test(run.id)) {
    const absolute = join(root, 'dag', 'runs', `${run.id}.json`);
    records.push(recordEntry('checkpoint', root, absolute));
  }
  const statePath = simulated ? undefined : absolutePath(snapshot?.provenance?.statePath);
  if (statePath) {
    records.push(recordEntry('snapshot', dirname(statePath), statePath));
  }
  const knownRecords = records.filter(Boolean);
  // `o` is advertised only when a raw task/checkpoint record is readable. The
  // derived path is still shown and copyable, but a stale path never becomes a
  // fake open action.
  const openRecord = knownRecords
    .filter(record => record.key === 'task' || record.key === 'checkpoint')
    .map(record => safeFileWithin(record.root, record.absolute))
    .find(Boolean);

  const terminalAt = kind === 'task' ? taskEntity?.completedAt : node?.completedAt;
  const activity = lastActivity(node ?? taskEntity, taskEntity);
  const terminalMs = terminalAt ? Date.parse(terminalAt) : NaN;
  const beforeStopMs = Number.isFinite(activity?.at) && Number.isFinite(terminalMs) && terminalMs >= activity.at
    ? terminalMs - activity.at
    : undefined;

  return defined({
    kind,
    id: kind === 'task' ? task?.id : node?.id,
    label: kind === 'task' ? task?.description : node?.label,
    taskId,
    state,
    mode,
    simulated,
    statusSources: simulated
      ? [{ token: 'simulated', state }]
      : [
        ...(taskStatus !== undefined ? [{ token: 'task#status', state: taskStatus }] : []),
        ...(nodeState !== undefined ? [{ token: 'node#state', state: nodeState }] : []),
      ],
    mismatch: !simulated && taskStatus !== undefined && nodeState !== undefined && taskStatus !== nodeState,
    reason,
    reasonSource: entity.errorSource,
    reasonKind: entity.errorKind,
    blockedBy,
    terminalAt,
    attempt: Number.isSafeInteger(node?.attempt) && node.attempt > 0 ? node.attempt : undefined,
    failedTurns: node?.failedTurns ?? taskEntity?.failedTurns,
    retries: node?.retries ?? taskEntity?.retries,
    retriesSource: node?.retriesSource ?? taskEntity?.retriesSource,
    lastActivity: activity,
    beforeStopMs,
    artifact: artifactEntry(root, node?.artifact),
    records: knownRecords,
    openPath: openRecord,
    owner: 'OmO',
  });
}

function recordRows(diagnosis) {
  return diagnosis.records.flatMap(record => [[record.key, record.absolute]]);
}

// Field labels for the copied evidence bundle. The panel and the bundle share
// one vocabulary, so a non-English session cannot copy an English-only card.
const COPY_MESSAGES = Object.freeze({
  en: Object.freeze({
    title: 'dag-studio diagnosis',
    subject: 'subject',
    task: 'task',
    mode: 'mode',
    status: 'status',
    statusSource: 'status source',
    mismatch: 'status mismatch: true (task record and checkpoint disagree)',
    terminalTime: 'terminal time',
    completedAt: 'completedAt',
    lastActivity: 'last activity',
    attempt: 'attempt',
    checkpoint: 'checkpoint',
    failedTurns: 'failed turns',
    retries: 'retries',
    reason: 'reason',
    reasonSource: 'reason source',
    reasonKind: 'reason kind',
    artifact: 'artifact',
    artifactStats: 'artifact stats',
    record: 'record',
    snapshot: 'snapshot',
    owner: 'owner',
    notRecorded: 'not recorded',
    sizeNotRecorded: 'size not recorded',
    tool: 'tool',
    log: 'log',
    activity: 'activity',
    stream: 'stream',
    derivedIncomingEdges: 'derived (incoming edges)',
    unavailableActions: 'retry/resume/cancel unavailable in DAG Studio',
    retriesSourceFallback: 'retries',
    demo: 'demo',
    bytes: 'bytes',
  }),
  zh: Object.freeze({
    title: 'dag-studio 诊断',
    subject: '对象',
    task: '任务',
    mode: '模式',
    status: '状态',
    statusSource: '状态来源',
    mismatch: '状态不一致：true（任务记录与检查点不一致）',
    terminalTime: '终止时间',
    completedAt: 'completedAt',
    lastActivity: '最后活动',
    attempt: '尝试',
    checkpoint: '检查点',
    failedTurns: '失败轮次',
    retries: '重试',
    reason: '原因',
    reasonSource: '原因来源',
    reasonKind: '原因类型',
    artifact: '产物',
    artifactStats: '产物统计',
    record: '记录',
    snapshot: '快照',
    owner: '归属',
    notRecorded: '未记录',
    sizeNotRecorded: '未记录大小',
    tool: '工具',
    log: '日志',
    activity: '活动',
    stream: '流式',
    derivedIncomingEdges: '推导（入边）',
    unavailableActions: 'DAG Studio 中不可重试/恢复/取消',
    retriesSourceFallback: '重试来源',
    demo: '演示',
    bytes: '字节',
  }),
});

const copyMessages = language => COPY_MESSAGES[normalizeLanguage(language)];

function statusSourceToken(token, language) {
  if (token === 'task#status') return t(language, 'diagnosisTaskStatus');
  if (token === 'node#state') return t(language, 'diagnosisNodeState');
  if (token === 'simulated') return t(language, 'diagnosisSimulated');
  return token;
}

function recordLabel(key, messages) {
  if (key === 'task') return messages.record;
  if (key === 'checkpoint') return messages.checkpoint;
  if (key === 'snapshot') return messages.snapshot;
  return key;
}

function pathLine(messages, label, value) {
  return `${label}: ${value ?? messages.notRecorded}`;
}

function statusText(diagnosis, language, messages) {
  const state = statusLabel(language, diagnosis.state).toUpperCase();
  if (diagnosis.simulated) {
    return `${t(language, 'diagnosisSimulated')} ${state} (${messages.demo})`;
  }
  return diagnosis.statusSources
    .map(source => `${statusSourceToken(source.token, language)} ${statusLabel(language, source.state).toUpperCase()}`)
    .join('; ');
}

function reasonText(diagnosis, language, messages) {
  if (diagnosis.reason) return diagnosis.reason;
  if (diagnosis.blockedBy.length) {
    return t(language, 'diagnosisBlockedBy', {
      nodes: diagnosis.blockedBy.map(upstream => `${upstream.label} (${upstream.state})`).join(', '),
    });
  }
  return messages.notRecorded;
}

function reasonSourceText(diagnosis, language, messages) {
  if (diagnosis.reason) return diagnosis.reasonSource ?? 'error';
  if (diagnosis.blockedBy.length) return messages.derivedIncomingEdges;
  return messages.notRecorded;
}

function lastActivityText(diagnosis, messages) {
  const activity = diagnosis.lastActivity;
  if (!activity) return messages.notRecorded;
  if (activity.kind === 'tool') {
    return Number.isFinite(activity.at)
      ? `${messages.tool} ${activity.tool} @ ${new Date(activity.at).toISOString()} (${messages.stream})`
      : `${messages.tool} ${activity.tool} (${messages.stream})`;
  }
  return `${activity.kind === 'log' ? messages.log : messages.activity} ${activity.text}`;
}

// Plain-text bundle for `c`. LF-separated with no ANSI or control characters.
// The optional language selects the same en/zh vocabulary as the panel.
export function diagnosisCopyText(diagnosis, language = 'en') {
  if (!diagnosis) return undefined;
  const messages = copyMessages(language);
  const artifact = diagnosis.artifact;
  const lines = [
    messages.title,
    `${messages.subject}: ${diagnosis.kind} ${diagnosis.id ?? 'unknown'}${diagnosis.taskId && diagnosis.taskId !== diagnosis.id ? ` / ${messages.task} ${diagnosis.taskId}` : ''}`,
    `${messages.mode}: ${diagnosis.mode}`,
    `${messages.status}: ${statusLabel(language, diagnosis.state).toUpperCase()} (${statusText(diagnosis, language, messages)})`,
    `${messages.statusSource}: ${diagnosis.statusSources.map(source => statusSourceToken(source.token, language)).join('; ') || messages.notRecorded}`,
    ...(diagnosis.mismatch ? [messages.mismatch] : []),
    `${messages.terminalTime}: ${diagnosis.terminalAt ?? messages.notRecorded}${diagnosis.terminalAt ? ` (${messages.completedAt})` : ''}`,
    `${messages.lastActivity}: ${lastActivityText(diagnosis, messages)}`,
    `${messages.attempt}: ${diagnosis.attempt ?? messages.notRecorded}`,
    `${messages.failedTurns}: ${diagnosis.failedTurns ?? messages.notRecorded}`,
    `${messages.retries}: ${diagnosis.retries ?? messages.notRecorded}${diagnosis.retries !== undefined ? ` (${diagnosis.retriesSource ?? messages.retriesSourceFallback})` : ''}`,
    `${messages.reason}: ${reasonText(diagnosis, language, messages)}`,
    `${messages.reasonSource}: ${reasonSourceText(diagnosis, language, messages)}`,
    ...(diagnosis.reasonKind ? [`${messages.reasonKind}: ${diagnosis.reasonKind}`] : []),
    ...(artifact?.absolute
      ? [`${messages.artifact}: ${artifact.absolute} (${artifact.bytes ?? messages.sizeNotRecorded} ${messages.bytes}${artifact.sha256 ? `, sha256 ${artifact.sha256}` : ''})`]
      : [`${messages.artifact}: ${messages.notRecorded}`]),
    ...(artifact?.statsAbsolute ? [`${messages.artifactStats}: ${artifact.statsAbsolute}`] : []),
    ...recordRows(diagnosis).map(([key, absolute]) => pathLine(messages, recordLabel(key, messages), absolute)),
    `${messages.owner}: ${diagnosis.owner} (${messages.unavailableActions})`,
  ];
  return lines.map(line => clean(line).replace(/\s+$/, '')).join('\n');
}

// Paths for `p`. A path is known only when the snapshot supplied an absolute
// store or snapshot root; a cached or demo subject therefore copies nothing.
export function diagnosisPathsText(diagnosis, language = 'en') {
  if (!diagnosis) return undefined;
  const messages = copyMessages(language);
  const rows = recordRows(diagnosis).map(([key, absolute]) => [recordLabel(key, messages), absolute]);
  if (diagnosis.artifact?.absolute) rows.push([messages.artifact, diagnosis.artifact.absolute]);
  if (diagnosis.artifact?.statsAbsolute) rows.push([messages.artifactStats, diagnosis.artifact.statsAbsolute]);
  if (!rows.length) return undefined;
  return rows.map(([label, absolute]) => pathLine(messages, label, absolute)).join('\n');
}

// The key map is deliberately action-only. There is no retry, resume, unblock,
// or cancel entry, and r/R/Enter are left to their existing non-diagnosis roles.
export function diagnosisForKey(key, diagnosis, fs, language = 'en') {
  if (!diagnosis || !DIAGNOSIS_ACTIONS.includes(key)) return null;
  if (key === 'c') {
    return { kind: 'copy-diagnosis', text: diagnosisCopyText(diagnosis, language) };
  }
  if (key === 'p') {
    const text = diagnosisPathsText(diagnosis, language);
    return text ? { kind: 'copy-paths', text } : { kind: 'unavailable', reason: 'no-paths' };
  }
  const path = safeOpenRecordPath(diagnosis, fs);
  return path
    ? { kind: 'open', path }
    : { kind: 'unavailable', reason: 'no-safe-record' };
}
