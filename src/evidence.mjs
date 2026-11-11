import { clean, segments } from './text.mjs';

// One normalizer for host-record evidence. Both the persisted OmO task path
// (task-data.normalizeOmOTask) and the snapshot path (model.normalizeTask /
// normalizeRun) used to carry byte-identical copies of this logic, which had
// already drifted: reply truncation, derived retries and turn/run_stats
// fallbacks differed depending on which entry point read the same record.
// Keeping the rules here makes one host field mean one value everywhere.

// A code-unit slice can end inside a surrogate pair or an emoji/ZWJ cluster,
// leaving invalid Unicode in persisted excerpts. Keep whole graphemes only.
const graphemeSlice = (value, limit) => {
  if (value.length <= limit) return value;
  let out = '';
  for (const segment of segments(value)) {
    if (out.length + segment.length > limit) break;
    out += segment;
  }
  return out;
};
const text = (value, limit = 4096) => {
  if (typeof value !== 'string') return undefined;
  const valueText = clean(value).trim();
  return valueText ? graphemeSlice(valueText, limit) : undefined;
};
const number = value => Number.isFinite(value) ? value : undefined;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const iso = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};
const byteLength = value => Buffer.byteLength(value, 'utf8');
const defined = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
const RATE_KINDS = new Set(['instant', 'average', 'history']);
const rateKind = value => RATE_KINDS.has(value) ? value : undefined;

// Persist only a bounded, sanitised excerpt. A full host response is measured
// for replyBytes/replyTruncated but never copied into the viewer model.
export function replyEvidence(raw, { live, fallback } = {}) {
  const candidates = [
    ['reply', raw.reply],
    ['response', raw.response],
    ['final_response', raw.final_response],
    ['last_assistant_line', raw.last_assistant_line],
    ['live_progress.last_assistant_line', live?.last_assistant_line],
  ];
  for (const [source, value] of candidates) {
    if (typeof value !== 'string') continue;
    const full = clean(value).trim();
    if (!full) continue;
    const bytes = integer(raw.replyBytes) ?? (source === 'reply' ? undefined : byteLength(full));
    // Truncation is knowable from the excerpt itself even when the legacy
    // reply field omitted replyBytes; never present a sliced tail as complete.
    const truncated = full.length > 1200 ? true
      : bytes !== undefined ? bytes > byteLength(full) : undefined;
    return defined({
      reply: graphemeSlice(full, 1200),
      replyBytes: bytes,
      replyTruncated: typeof raw.replyTruncated === 'boolean' ? raw.replyTruncated : truncated,
      replySource: text(raw.replySource, 64) ?? source,
    });
  }
  if (!fallback) return {};
  return defined({
    reply: fallback.reply,
    replyBytes: fallback.replyBytes,
    replyTruncated: fallback.replyTruncated,
    replySource: fallback.replySource,
  });
}

// Failure provenance: keep the existing reason priority but expose both the
// field it came from and the host failure kind when one is recorded.
export function errorEvidence(raw, fallback) {
  const candidates = [
    ['error', raw.error?.message ?? raw.error],
    ['error_message', raw.error_message],
    ['failure_reason', raw.failure_reason],
    ['last_error', raw.last_error?.message ?? raw.last_error],
  ];
  for (const [source, value] of candidates) {
    const reason = text(value, 512);
    if (reason === undefined) continue;
    return defined({
      error: reason,
      errorSource: text(raw.errorSource, 40) ?? source,
      errorKind: text(raw.errorKind ?? raw.failure_kind ?? raw.error?.kind ?? raw.last_error?.kind, 64),
    });
  }
  if (!fallback) return defined({ errorKind: text(raw.errorKind ?? raw.failure_kind, 64) });
  return defined({
    error: fallback.error,
    errorSource: fallback.errorSource,
    errorKind: text(raw.errorKind ?? raw.failure_kind, 64) ?? fallback.errorKind,
  });
}

// Host run_stats omits failed_turns when it is zero, so a present run_stats
// proves zero failed turns while an absent run_stats leaves retries unknown.
// That inferred zero is derived from run_stats.turns, never recorded; an
// explicit retries/failed_turns value, including zero, keeps its source.
export function retryEvidence(raw, stats, fallback = {}) {
  const hasStats = stats !== null && typeof stats === 'object';
  const statsFailed = integer(stats?.failed_turns ?? stats?.failedTurns);
  const statsKnown = hasStats && integer(stats?.turns) !== undefined;
  const explicitFailed = integer(raw.failedTurns ?? raw.failed_turns);
  const explicitRetries = integer(raw.retries);
  const failedTurns = explicitFailed ?? statsFailed ?? (statsKnown ? 0 : fallback.failedTurns);
  const retries = explicitRetries ?? failedTurns ?? fallback.retries;
  let retriesSource;
  let retriesKind;
  if (retries !== undefined) {
    if (explicitRetries !== undefined) {
      retriesSource = text(raw.retriesSource, 64) ?? 'task.retries';
      retriesKind = 'recorded';
    } else if (explicitFailed !== undefined) {
      retriesSource = text(raw.retriesSource, 64) ?? 'task.failed_turns';
      retriesKind = 'recorded';
    } else if (statsFailed !== undefined) {
      retriesSource = text(raw.retriesSource, 64) ?? 'run_stats.failed_turns';
      retriesKind = 'recorded';
    } else if (statsKnown) {
      retriesSource = 'run_stats.turns';
      retriesKind = 'derived';
    } else {
      retriesSource = fallback.retriesSource;
      retriesKind = fallback.retries !== undefined ? 'derived' : 'unavailable';
    }
  }
  return defined({ failedTurns, retries, retriesSource, retriesKind });
}

export const retryFields = ({ failedTurns, retries, retriesSource }) =>
  defined({ failedTurns, retries, retriesSource });

export function cacheEvidence(raw, stats, fallback = {}) {
  const cacheHitRateLast = number(raw.cacheHitRateLast ?? raw.cache_hit_rate_last ?? stats?.cache_hit_rate_last) ?? fallback.cacheHitRateLast;
  const cacheHitRate = number(raw.cacheHitRate ?? raw.cache_hit_rate_run ?? raw.cache_hit_rate_last ?? raw.cache_hit_rate ??
    stats?.cache_hit_rate_run ?? stats?.cache_hit_rate_last ?? stats?.cache_hit_rate) ?? cacheHitRateLast ?? fallback.cacheHitRate;
  return defined({
    cacheReadTokens: number(raw.cacheReadTokens ?? raw.cache_read_tokens ?? stats?.cache_read_tokens) ?? fallback.cacheReadTokens,
    cacheWriteTokens: number(raw.cacheWriteTokens ?? raw.cache_write_tokens ?? stats?.cache_write_tokens) ?? fallback.cacheWriteTokens,
    totalTokens: number(raw.totalTokens ?? raw.total_tokens ?? stats?.total_tokens) ?? fallback.totalTokens,
    costUsd: number(raw.costUsd ?? raw.cost_usd ?? stats?.cost_usd) ?? fallback.costUsd,
    costStatus: text(raw.costStatus ?? raw.cost_status ?? stats?.cost_status, 40) ?? fallback.costStatus,
    cacheHitRate,
    cacheHitRateLast,
  });
}

export function normalizeRateHistory(raw) {
  if (!Array.isArray(raw)) return undefined;
  const values = raw.map(sample => {
    const rate = number(sample?.rate ?? sample?.value);
    const at = iso(sample?.at ?? sample?.time ?? sample?.timestamp);
    return rate === undefined ? undefined : { ...(at ? { at } : {}), rate };
  }).filter(Boolean).slice(-32);
  return values.length ? values : undefined;
}

export function inferredTokenRate(raw, stats, fallback) {
  const explicitKind = rateKind(raw.tokenRateKind);
  let values;
  let kind;
  if (Array.isArray(raw.tokenRate)) {
    values = raw.tokenRate.filter(value => number(value) !== undefined).slice(-32);
    if (values.length) kind = explicitKind ?? (values.length > 1 ? 'history' : undefined);
  }
  // An empty or all-non-numeric array is not a rate; fall through to the
  // run_stats sample instead of discarding the record's observed rate.
  if (!values?.length && number(stats?.tokens_per_second) !== undefined) {
    values = [number(stats.tokens_per_second)];
    kind = explicitKind ?? 'instant';
  } else if (!values?.length) {
    const tokensOut = number(raw.tokensOut ?? raw.tokens_out ?? stats?.output_tokens);
    const started = Date.parse(raw.startedAt ?? raw.started_at ?? raw.createdAt ?? raw.created_at);
    const completed = Date.parse(raw.completedAt ?? raw.completed_at ?? raw.updatedAt ?? raw.updated_at);
    if (tokensOut !== undefined && Number.isFinite(started) && Number.isFinite(completed) && completed > started) {
      values = [Math.max(0, Math.round(tokensOut / ((completed - started) / 1000)))];
      kind = explicitKind ?? 'average';
    }
  }
  if (!values?.length) {
    if (!fallback) return {};
    return defined({ tokenRate: fallback.tokenRate, tokenRateKind: fallback.tokenRateKind });
  }
  return defined({ tokenRate: values, tokenRateKind: kind });
}

// Turn/tool counts come from the task record, then the live progress event,
// then the host run_stats summary. Host records frequently omit the top-level
// fields while still carrying useful counts in either nested object.
export function turnEvidence(raw, stats, fallback = {}) {
  const live = raw?.live_progress;
  return defined({
    turns: integer(raw?.turns) ?? integer(live?.turns) ?? integer(stats?.turns) ?? fallback.turns,
    toolCalls: integer(raw?.toolCalls ?? raw?.tool_calls) ?? integer(live?.tool_calls) ??
      integer(stats?.tool_calls) ?? fallback.toolCalls,
  });
}
