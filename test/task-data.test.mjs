import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeOmOTask, TaskData } from '../src/task-data.mjs';
import { normalizeSnapshot, normalizeTask } from '../src/model.mjs';
import { writeJson } from '../src/storage.mjs';

const sessionId = 'session-1';

function descriptor(root, origin, label) {
  return { root, origin, label };
}

async function tempStore(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function record(id, overrides = {}) {
  return {
    task_id: id,
    parent_session_id: sessionId,
    description: id,
    status: 'completed',
    updated_at: '2026-11-10T00:00:00.000Z',
    task_seq: 0,
    ...overrides,
  };
}

async function seed(root, records) {
  await mkdir(join(root, 'tasks'), { recursive: true });
  for (const [name, raw] of Object.entries(records)) {
    const path = join(root, 'tasks', name);
    if (typeof raw === 'string') await writeFile(path, raw);
    else await writeJson(path, raw);
  }
}

// Shape emitted by omo-task.js f(): it spreads C3(e, true), which omits
// task_seq from the persisted record, then attaches the live run-stats
// snapshot and live_progress while the task is pending or running.
const liveUpdatedAt = '2026-11-10T08:33:33.772Z';

function liveTaskPayload(id, { updatedAt = liveUpdatedAt, stats = {}, progress = {} } = {}) {
  return {
    parent_session_id: sessionId,
    tasks: [{
      task_id: id,
      status: 'running',
      task_summary: 'live metrics probe',
      name: 'live metrics probe',
      category: 'quick',
      execution_mode: 'in-process',
      model: 'omni',
      run_stats: {
        runtime_ms: 36000, turns: 2, tool_calls: 5,
        input_tokens: 6789, output_tokens: 2345,
        cache_read_tokens: 120000, total_tokens: 129134,
        tokens_per_second: 211, token_status: 'partial', cost_status: 'reported',
        ...stats,
      },
      effective_model: 'omni',
      description: 'live metrics probe',
      agent_type: 'implementer',
      residency_state: 'resident',
      depth: 1,
      created_at: updatedAt,
      updated_at: updatedAt,
      live_progress: {
        activity: 'tool: eval', started_at: updatedAt, current_tool: 'eval',
        last_assistant_line: 'sampling the snapshot', turns: 2, tool_calls: 5,
        total_tokens: 129134, output_tokens: 2345, tokens_per_second: 211,
        ...progress,
      },
    }],
  };
}

async function storeFingerprint(root) {
  const directory = join(root, 'tasks');
  const files = (await readdir(directory)).sort();
  const entries = [];
  for (const file of files) {
    const info = await stat(join(directory, file));
    entries.push([file, info.mtimeMs, await readFile(join(directory, file), 'utf8')]);
  }
  return entries;
}

test('OmO run_stats token usage maps to task input and output tokens', () => {
  const task = normalizeOmOTask({
    task_id: 'st_token_stats',
    status: 'completed',
    run_stats: {
      input_tokens: 45231,
      output_tokens: 19512,
      cache_read_tokens: 1065600,
      total_tokens: 1130343,
      tokens_per_second: 225,
    },
  });
  assert.equal(task.tokensIn, 45231);
  assert.equal(task.tokensOut, 19512);
  assert.deepEqual(task.tokenRate, [225]);
});

test('explicit task token fields take precedence over run_stats', () => {
  const task = normalizeOmOTask({
    task_id: 'st_token_direct',
    tokens_in: 9,
    tokens_out: 4,
    run_stats: { input_tokens: 100, output_tokens: 50 },
  });
  assert.equal(task.tokensIn, 9);
  assert.equal(task.tokensOut, 4);
});

test('zero token-rate samples are preserved', () => {
  assert.deepEqual(normalizeOmOTask({ task_id: 'st_zero_rate', tokenRate: [0] }).tokenRate, [0]);
});

test('agent identity stays separate from a category-only host record', () => {
  const categoryOnly = normalizeOmOTask({
    task_id: 'st_category_only', status: 'running', category: 'quick',
  });
  assert.equal(categoryOnly.agent, undefined);
  assert.equal(categoryOnly.category, 'quick');
  assert.equal('agent' in categoryOnly, false);

  const typed = normalizeOmOTask({
    task_id: 'st_agent_type', status: 'running', agent_type: 'explorer', category: 'quick',
  });
  assert.equal(typed.agent, 'explorer');
  assert.equal(typed.category, 'quick');

  const recorded = normalizeOmOTask({
    task_id: 'st_agent_recorded', status: 'running', agent: 'implementer', category: 'quick',
  });
  assert.equal(recorded.agent, 'implementer');
  assert.equal(recorded.category, 'quick');
});

test('task error text maps from every host field', () => {
  const cases = [
    [{ error: { message: 'error object' } }, 'error object'],
    [{ error: 'error string' }, 'error string'],
    [{ error_message: 'message field' }, 'message field'],
    [{ failure_reason: 'failure field' }, 'failure field'],
    [{ last_error: 'last field' }, 'last field'],
    [{ error: { message: 'first' }, error_message: 'second' }, 'first'],
  ];
  for (const [shape, expected] of cases) {
    const task = normalizeOmOTask({ task_id: 'st_err', status: 'failed', ...shape });
    assert.equal(task.error, expected);
  }
});

test('final_response keeps a 1200-char excerpt with byte and truncation metadata', () => {
  const long = normalizeOmOTask({
    task_id: 'st_reply_long', status: 'completed', final_response: 'x'.repeat(3373),
  });
  assert.equal(long.reply.length, 1200);
  assert.equal(long.replyBytes, 3373);
  assert.equal(long.replyTruncated, true);
  assert.equal(long.replySource, 'final_response');

  const short = normalizeOmOTask({
    task_id: 'st_reply_short', status: 'completed', final_response: 'x'.repeat(900),
  });
  assert.equal(short.reply.length, 900);
  assert.equal(short.replyBytes, 900);
  assert.equal(short.replyTruncated, false);
  assert.equal(short.replySource, 'final_response');
});

test('run_stats.failed_turns maps to retries and failedTurns with provenance', () => {
  const task = normalizeOmOTask({
    task_id: 'st_retries', status: 'completed',
    run_stats: { turns: 108, failed_turns: 4, tool_calls: 144 },
  });
  assert.equal(task.failedTurns, 4);
  assert.equal(task.retries, 4);
  assert.equal(task.retriesSource, 'run_stats.failed_turns');
  assert.equal(task.provenance.retries.kind, 'recorded');
  assert.equal(task.provenance.retries.from, 'run_stats.failed_turns');

  const explicit = normalizeOmOTask({
    task_id: 'st_retries_direct', status: 'completed', retries: 2,
    run_stats: { turns: 10, failed_turns: 4 },
  });
  assert.equal(explicit.failedTurns, 4);
  assert.equal(explicit.retries, 2);
  assert.equal(explicit.retriesSource, 'task.retries');
  assert.equal(explicit.provenance.retries.kind, 'recorded');

  const explicitZero = normalizeOmOTask({ task_id: 'st_retries_explicit_zero', status: 'completed', retries: 0 });
  assert.equal(explicitZero.retries, 0);
  assert.equal(explicitZero.retriesSource, 'task.retries');
  assert.equal(explicitZero.provenance.retries.kind, 'recorded');

  const explicitFailedZero = normalizeOmOTask({ task_id: 'st_failed_zero', status: 'completed', failed_turns: 0 });
  assert.equal(explicitFailedZero.retries, 0);
  assert.equal(explicitFailedZero.retriesSource, 'task.failed_turns');
  assert.equal(explicitFailedZero.provenance.retries.kind, 'recorded');

  const recordedZero = normalizeOmOTask({
    task_id: 'st_stats_zero', status: 'completed', run_stats: { turns: 5, failed_turns: 0 },
  });
  assert.equal(recordedZero.retries, 0);
  assert.equal(recordedZero.retriesSource, 'run_stats.failed_turns');
  assert.equal(recordedZero.provenance.retries.kind, 'recorded');

  const zero = normalizeOmOTask({
    task_id: 'st_retries_zero', status: 'completed', run_stats: { turns: 5, tool_calls: 2 },
  });
  assert.equal(zero.failedTurns, 0);
  assert.equal(zero.retries, 0);
  assert.equal(zero.retriesSource, 'run_stats.turns');
  assert.equal(zero.provenance.retries.kind, 'derived');
  assert.equal(zero.provenance.retries.from, 'run_stats.turns');

  const unknown = normalizeOmOTask({ task_id: 'st_retries_unknown', status: 'completed' });
  assert.equal('failedTurns' in unknown, false);
  assert.equal('retries' in unknown, false);
  assert.equal('retriesSource' in unknown, false);
  assert.equal(unknown.provenance.retries.kind, 'unavailable');

  const partial = normalizeOmOTask({
    task_id: 'st_retries_partial', status: 'completed', run_stats: { tool_calls: 2 },
  });
  assert.equal('failedTurns' in partial, false);
  assert.equal('retries' in partial, false);
  assert.equal(partial.provenance.retries.kind, 'unavailable');
});

test('TaskData keeps inferred retry zeros derived through snapshot normalization', async t => {
  const root = await tempStore(t, 'dag-retry-provenance-');
  await seed(root, {
    'st_inferred.json': record('st_inferred', { run_stats: { turns: 5, tool_calls: 2 } }),
    'st_recorded.json': record('st_recorded', { run_stats: { turns: 5, failed_turns: 2 } }),
  });
  const data = new TaskData({
    sessionId, stateDirs: [descriptor(root, 'in-project', 'repo store')], notify: () => {},
  });
  const tasks = await data.refresh();
  const snapshot = normalizeSnapshot({ version: 3, sessionId, mode: 'live', connected: true, runs: [], tasks });
  const inferred = snapshot.tasks.find(task => task.id === 'st_inferred');
  const recorded = snapshot.tasks.find(task => task.id === 'st_recorded');
  assert.equal(inferred.retries, 0);
  assert.equal(inferred.provenance.retries.kind, 'derived');
  assert.equal(inferred.provenance.retries.from, 'run_stats.turns');
  assert.equal(recorded.retries, 2);
  assert.equal(recorded.provenance.retries.kind, 'recorded');
  assert.equal(recorded.provenance.retries.from, 'run_stats.failed_turns');
});

test('run_stats cache, total, cost, and cache hit rates map exactly', () => {
  const task = normalizeOmOTask({
    task_id: 'st_cache', status: 'completed',
    run_stats: {
      input_tokens: 461012, output_tokens: 86887,
      cache_read_tokens: 22320128, cache_write_tokens: 1024, total_tokens: 22868027,
      cost_usd: 0.188244384, cache_hit_rate_run: 0.9797634358947797,
      cache_hit_rate_last: 0.9983720787227777, cost_status: 'reported',
    },
  });
  assert.equal(task.tokensIn, 461012);
  assert.equal(task.tokensOut, 86887);
  assert.equal(task.cacheReadTokens, 22320128);
  assert.equal(task.cacheWriteTokens, 1024);
  assert.equal(task.totalTokens, 22868027);
  assert.equal(task.costUsd, 0.188244384);
  assert.equal(task.cacheHitRate, 0.9797634358947797);
  assert.equal(task.cacheHitRateLast, 0.9983720787227777);
  assert.equal(task.costStatus, 'reported');

  const direct = normalizeOmOTask({
    task_id: 'st_cache_direct', status: 'completed',
    cache_read_tokens: 5, cache_write_tokens: 6, total_tokens: 7, cost_usd: 0.5,
    cache_hit_rate_run: 0.1,
    run_stats: {
      cache_read_tokens: 100, cache_write_tokens: 200, total_tokens: 300, cost_usd: 0.9,
      cache_hit_rate_run: 0.9,
    },
  });
  assert.equal(direct.cacheReadTokens, 5);
  assert.equal(direct.cacheWriteTokens, 6);
  assert.equal(direct.totalTokens, 7);
  assert.equal(direct.costUsd, 0.5);
  assert.equal(direct.cacheHitRate, 0.1);
});

test('failure_kind and the error source field are preserved', () => {
  const task = normalizeOmOTask({
    task_id: 'st_failure', status: 'failed', error_message: 'upstream failed', failure_kind: 'provider_error',
  });
  assert.equal(task.error, 'upstream failed');
  assert.equal(task.errorSource, 'error_message');
  assert.equal(task.errorKind, 'provider_error');

  const reason = normalizeOmOTask({ task_id: 'st_failure_reason', status: 'failed', failure_reason: 'cancelled by user' });
  assert.equal(reason.errorSource, 'failure_reason');

  const cancelled = normalizeOmOTask({ task_id: 'st_failure_missing', status: 'cancelled' });
  assert.equal('error' in cancelled, false);
  assert.equal('errorKind' in cancelled, false);
});

test('a live task event updates running metrics without waiting for the terminal record', async t => {
  const root = await tempStore(t, 'dag-live-metrics-');
  const id = 'st_live_metrics';
  await seed(root, {
    [`${id}.json`]: record(id, {
      status: 'running', updated_at: liveUpdatedAt, task_seq: 5,
      description: 'disk description', child_session_id: 'child-live',
    }),
  });
  const data = new TaskData({ sessionId, stateDirs: [descriptor(root, 'in-project', 'repo store')], notify: () => {} });
  const before = await data.refresh();
  assert.equal(before[0].tokensIn, undefined);

  assert.equal(data.receive(liveTaskPayload(id)), true);
  let task = data.snapshot().find(candidate => candidate.id === id);
  assert.equal(task.status, 'running');
  assert.equal(task.tokensIn, 6789);
  assert.equal(task.tokensOut, 2345);
  assert.equal(task.totalTokens, 129134);
  assert.equal(task.cacheReadTokens, 120000);
  assert.equal(task.turns, 2);
  assert.equal(task.toolCalls, 5);
  assert.deepEqual(task.tokenRate, [211]);
  assert.equal(task.tokenRateKind, 'instant');
  assert.equal(task.progress, '[eval] sampling the snapshot');
  // The disk identity, source, and raw record stay usable while live wins.
  assert.equal(task.source, data.sources[0].id);
  assert.equal(data.entries.get(id).raw.task_seq, 5);
  assert.equal(data.entries.get(id).raw.description, 'disk description');
  assert.equal(data.entries.get(id).childSessionId, 'child-live');
  assert.equal(data.live.get(id).source, 'live');

  let refreshed = await data.refresh();
  task = refreshed.find(candidate => candidate.id === id);
  assert.equal(task.tokensIn, 6789);
  assert.equal(task.progress, '[eval] sampling the snapshot');
  assert.equal(task.source, data.sources[0].id);

  // A coalesced second event at the same persisted revision must not be pinned
  // to the first snapshot.
  assert.equal(data.receive(liveTaskPayload(id, {
    stats: { turns: 3, tool_calls: 6, input_tokens: 7000, output_tokens: 2500, total_tokens: 132000, tokens_per_second: 220 },
    progress: { turns: 3, tool_calls: 6, total_tokens: 132000, output_tokens: 2500, tokens_per_second: 220, last_assistant_line: 'second coalesced event' },
  })), true);
  task = data.snapshot().find(candidate => candidate.id === id);
  assert.equal(task.tokensIn, 7000);
  assert.equal(task.tokensOut, 2500);
  assert.equal(task.turns, 3);
  assert.equal(task.toolCalls, 6);
  assert.deepEqual(task.tokenRate, [211, 220]);
  assert.equal(task.tokenRateKind, 'history');
  assert.equal(task.tokenRateHistory.length, 2);
  assert.equal(task.tokenRateHistory.at(-1).rate, 220);
  assert.equal(task.progress, '[eval] second coalesced event');

  refreshed = await data.refresh();
  task = refreshed.find(candidate => candidate.id === id);
  assert.equal(task.tokensIn, 7000);
  assert.equal(task.turns, 3);
  assert.equal(task.progress, '[eval] second coalesced event');
  assert.equal(task.source, data.sources[0].id);
});

test('a repeated live rate becomes a bounded time series as revisions advance', async t => {
  const root = await tempStore(t, 'dag-live-rate-series-');
  const id = 'st_rate_series';
  const data = new TaskData({ sessionId, stateDirs: [descriptor(root, 'in-project', 'repo store')], notify: () => {} });
  await data.refresh();

  const firstAt = '2026-11-10T08:33:33.772Z';
  const secondAt = '2026-11-10T08:33:34.772Z';
  assert.equal(data.receive(liveTaskPayload(id, { updatedAt: firstAt })), true);
  assert.equal(data.receive(liveTaskPayload(id, { updatedAt: firstAt })), true);
  assert.equal(data.receive(liveTaskPayload(id, { updatedAt: secondAt })), true);

  const task = data.snapshot().find(candidate => candidate.id === id);
  assert.deepEqual(task.tokenRate, [211, 211]);
  assert.equal(task.tokenRateKind, 'history');
  assert.equal(task.tokenRateHistory.length, 2);
  assert.equal(task.tokenRateHistory[0].at, firstAt);
  assert.equal(task.tokenRateHistory[1].at, secondAt);
  assert.equal(task.tokenRateHistory[1].rate, 211);
});

test('a periodic sampler extends a flat live rate without duplicate ticks', async t => {
  const root = await tempStore(t, 'dag-rate-sampler-');
  const id = 'st_rate_sampler';
  const firstAt = '2026-11-10T08:33:33.772Z';
  const base = Date.now();
  const data = new TaskData({ sessionId, stateDirs: [descriptor(root, 'in-project', 'repo store')], notify: () => {} });
  await data.refresh();
  assert.equal(data.receive(liveTaskPayload(id, { updatedAt: firstAt })), true);
  assert.equal(data.sampleRates(base + 500), false);
  assert.equal(data.sampleRates(base + 1500), true);
  const task = data.snapshot().find(candidate => candidate.id === id);
  assert.deepEqual(task.tokenRate, [211, 211]);
  assert.equal(task.tokenRateKind, 'history');
  assert.equal(task.tokenRateHistory.length, 2);
});

test('a terminal disk record at the same version is not overlaid by a live running record', async t => {
  const root = await tempStore(t, 'dag-live-terminal-');
  const id = 'st_live_terminal';
  await seed(root, {
    [`${id}.json`]: record(id, {
      status: 'completed', updated_at: liveUpdatedAt, task_seq: 5,
      final_response: 'persisted final response',
      run_stats: {
        turns: 9, tool_calls: 12, input_tokens: 111, output_tokens: 222,
        total_tokens: 333, tokens_per_second: 33,
      },
    }),
  });
  const data = new TaskData({ sessionId, stateDirs: [descriptor(root, 'in-project', 'repo store')], notify: () => {} });
  await data.refresh();

  assert.equal(data.receive(liveTaskPayload(id)), true);
  let task = data.snapshot().find(candidate => candidate.id === id);
  assert.equal(task.status, 'completed');
  assert.equal(task.tokensIn, 111);
  assert.equal(task.tokensOut, 222);
  assert.equal(task.totalTokens, 333);
  assert.equal(task.turns, 9);
  assert.equal(task.toolCalls, 12);
  assert.deepEqual(task.tokenRate, [33]);
  assert.equal(task.reply, 'persisted final response');
  assert.equal(task.source, data.sources[0].id);

  const refreshed = await data.refresh();
  task = refreshed.find(candidate => candidate.id === id);
  assert.equal(task.status, 'completed');
  assert.equal(task.tokensIn, 111);
  assert.equal(task.reply, 'persisted final response');
  assert.equal(task.source, data.sources[0].id);
});

test('a paused disk record at the same version is not overlaid by a live running record', async t => {
  const root = await tempStore(t, 'dag-live-paused-');
  const id = 'st_live_paused';
  await seed(root, {
    [`${id}.json`]: record(id, {
      status: 'paused', updated_at: liveUpdatedAt, task_seq: 5,
      run_stats: { turns: 2, tool_calls: 4, input_tokens: 100, output_tokens: 50, tokens_per_second: 10 },
    }),
  });
  const data = new TaskData({ sessionId, stateDirs: [descriptor(root, 'in-project', 'repo store')], notify: () => {} });
  await data.refresh();

  assert.equal(data.receive(liveTaskPayload(id)), true);
  let task = data.snapshot().find(candidate => candidate.id === id);
  assert.equal(task.status, 'paused');
  assert.equal(task.tokensIn, 100);
  assert.equal(task.tokensOut, 50);
  assert.equal(task.turns, 2);
  assert.equal(task.toolCalls, 4);
  assert.deepEqual(task.tokenRate, [10]);

  const refreshed = await data.refresh();
  task = refreshed.find(candidate => candidate.id === id);
  assert.equal(task.status, 'paused');
  assert.equal(task.tokensIn, 100);
});

test('TaskData snapshots expose evidence fields from real-shaped host records', async t => {
  const root = await tempStore(t, 'dag-evidence-');
  const response = 'x'.repeat(2000);
  await seed(root, {
    'st_evidence.json': record('st_evidence', {
      status: 'failed', final_response: response, error_message: 'tool failed', failure_kind: 'tool_error',
      run_stats: {
        runtime_ms: 112188, turns: 22, failed_turns: 2, tool_calls: 26,
        input_tokens: 45231, output_tokens: 19512,
        cache_read_tokens: 1065600, cache_write_tokens: 512, total_tokens: 1130343,
        tokens_per_second: 225, cost_usd: 0.02168865,
        cache_hit_rate_last: 0.9946844873529863, cache_hit_rate_run: 0.959281834950591,
        token_status: 'complete', cost_status: 'reported',
      },
    }),
  });
  const data = new TaskData({
    sessionId, stateDirs: [descriptor(root, 'in-project', 'repo store')], notify: () => {},
  });
  const [task] = await data.refresh();
  assert.equal(task.reply.length, 1200);
  assert.equal(task.replyBytes, 2000);
  assert.equal(task.replyTruncated, true);
  assert.equal(task.replySource, 'final_response');
  assert.equal(task.failedTurns, 2);
  assert.equal(task.retries, 2);
  assert.equal(task.retriesSource, 'run_stats.failed_turns');
  assert.equal(task.cacheReadTokens, 1065600);
  assert.equal(task.cacheWriteTokens, 512);
  assert.equal(task.totalTokens, 1130343);
  assert.equal(task.costUsd, 0.02168865);
  assert.equal(task.cacheHitRate, 0.959281834950591);
  assert.equal(task.cacheHitRateLast, 0.9946844873529863);
  assert.equal(task.costStatus, 'reported');
  assert.deepEqual(task.tokenRate, [225]);
  assert.equal(task.tokenRateKind, 'instant');
  assert.equal(task.error, 'tool failed');
  assert.equal(task.errorSource, 'error_message');
  assert.equal(task.errorKind, 'tool_error');
  assert.equal(task.source, data.sources[0].id);
  assert.ok(!Object.values(task).some(value => typeof value === 'string' && value === response));
});

test('failed and skipped tasks are terminal like model TERMINAL', () => {
  for (const status of ['failed', 'skipped']) {
    const task = normalizeOmOTask({
      task_id: `st_${status}`,
      status,
      live_progress: { current_tool: 'bash', last_assistant_line: 'working' },
      updated_at: '2026-11-10T00:00:00.000Z',
    });
    assert.equal(task.progress, undefined);
    assert.equal(task.completedAt, '2026-11-10T00:00:00.000Z');
  }
});

test('two readable stores aggregate 50 tasks with source ids', async t => {
  const repo = await tempStore(t, 'dag-repo-');
  const host = await tempStore(t, 'dag-host-');
  const repoRecords = Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
    const id = `st_repo${index}`;
    return [`${id}.json`, record(id, { task_seq: index, description: `repo ${index}` })];
  }));
  const hostRecords = Object.fromEntries(Array.from({ length: 38 }, (_, index) => {
    const id = `st_host${index}`;
    return [`${id}.json`, record(id, { task_seq: index, description: `host ${index}` })];
  }));
  await seed(repo, repoRecords);
  await seed(host, hostRecords);
  const data = new TaskData({
    sessionId,
    stateDirs: [descriptor(repo, 'in-project', 'repo store'), descriptor(host, 'agent-project', 'host store')],
    notify: () => {},
  });
  const tasks = await data.refresh();
  assert.equal(tasks.length, 50);
  assert.deepEqual(new Set(tasks.map(task => task.id)), new Set([...Object.keys(repoRecords), ...Object.keys(hostRecords)]
    .map(name => name.replace(/\.json$/, ''))));
  assert.ok(tasks.every(task => typeof task.source === 'string' && task.source));
  const repoSource = data.sources.find(source => source.root === repo);
  const hostSource = data.sources.find(source => source.root === host);
  assert.deepEqual(repoSource.tasks, { files: 12, accepted: 12, foreign: 0, invalid: 0 });
  assert.deepEqual(hostSource.tasks, { files: 38, accepted: 38, foreign: 0, invalid: 0 });
  assert.equal(repoSource.status, 'ok');
  assert.equal(hostSource.status, 'ok');
});

test('duplicate task ids pick the newer updated_at and keep the loser as a variant', async t => {
  const repo = await tempStore(t, 'dag-repo-');
  const host = await tempStore(t, 'dag-host-');
  await seed(repo, {
    'st_dup.json': record('st_dup', {
      status: 'running', description: 'repo copy', updated_at: '2026-11-10T01:00:00.000Z',
    }),
  });
  await seed(host, {
    'st_dup.json': record('st_dup', {
      status: 'completed', description: 'host copy', updated_at: '2026-11-10T02:00:00.000Z',
    }),
  });
  const data = new TaskData({
    sessionId,
    stateDirs: [descriptor(repo, 'in-project', 'repo store'), descriptor(host, 'agent-project', 'host store')],
    notify: () => {},
  });
  const tasks = await data.refresh();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].description, 'host copy');
  assert.equal(tasks[0].status, 'completed');
  assert.equal(tasks[0].source, data.sources.find(source => source.root === host).id);
  assert.equal(tasks[0].variants.length, 1);
  assert.equal(tasks[0].variants[0].source, data.sources.find(source => source.root === repo).id);
});

test('equal task timestamps break ties on task_seq', async t => {
  const first = await tempStore(t, 'dag-one-');
  const second = await tempStore(t, 'dag-two-');
  await seed(first, {
    'st_seq.json': record('st_seq', { status: 'running', description: 'low seq', task_seq: 1 }),
  });
  await seed(second, {
    'st_seq.json': record('st_seq', { status: 'completed', description: 'high seq', task_seq: 2 }),
  });
  const data = new TaskData({
    sessionId,
    stateDirs: [descriptor(first, 'in-project', 'repo store'), descriptor(second, 'agent-project', 'host store')],
    notify: () => {},
  });
  const tasks = await data.refresh();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].description, 'high seq');
  assert.equal(tasks[0].source, data.sources.find(source => source.root === second).id);
});

test('foreign task records are rejected and counted per store', async t => {
  const repo = await tempStore(t, 'dag-repo-');
  const host = await tempStore(t, 'dag-host-');
  await seed(repo, {
    'st_mine.json': record('st_mine'),
    'st_foreign.json': record('st_foreign', { parent_session_id: 'other-session' }),
  });
  await seed(host, { 'st_host.json': record('st_host') });
  const data = new TaskData({
    sessionId,
    stateDirs: [descriptor(repo, 'in-project', 'repo store'), descriptor(host, 'agent-project', 'host store')],
    notify: () => {},
  });
  const tasks = await data.refresh();
  assert.deepEqual(tasks.map(task => task.id).sort(), ['st_host', 'st_mine']);
  assert.equal(data.sources.find(source => source.root === repo).tasks.foreign, 1);
  assert.equal(data.sources.find(source => source.root === host).tasks.foreign, 0);
});

test('the agent-project host store accepts root-session records from a child session', async t => {
  const host = await tempStore(t, 'dag-host-root-');
  await seed(host, {
    'st_root.json': record('st_root', { parent_session_id: 'root-session' }),
    'st_child.json': record('st_child', {
      parent_session_id: 'child-session', parent_task_id: 'st_root',
    }),
  });
  const data = new TaskData({
    sessionId: 'child-session',
    stateDirs: [descriptor(host, 'agent-project', 'host store')],
    notify: () => {},
  });
  const tasks = await data.refresh();
  assert.deepEqual(tasks.map(task => task.id).sort(), ['st_child', 'st_root']);
  assert.deepEqual(data.sources[0].tasks, { files: 2, accepted: 2, foreign: 0, invalid: 0 });
});

test('child tasks link through parent_task_id and child_session_id but orphans do not', async t => {
  const repo = await tempStore(t, 'dag-repo-');
  await seed(repo, {
    'st_root.json': record('st_root', { child_session_id: 'child-1' }),
    'st_kid.json': record('st_kid', { parent_session_id: 'child-1' }),
    'st_direct.json': record('st_direct', { parent_session_id: 'other-session', parent_task_id: 'st_root' }),
    'st_orphan.json': record('st_orphan', { parent_session_id: 'other-session' }),
  });
  const data = new TaskData({ sessionId, stateDirs: [descriptor(repo, 'in-project', 'repo store')], notify: () => {} });
  const tasks = await data.refresh();
  assert.deepEqual(tasks.map(task => task.id).sort(), ['st_direct', 'st_kid', 'st_root']);
  for (const task of tasks.filter(task => task.id !== 'st_root')) assert.equal(task.parentTaskId, 'st_root');
  assert.equal(data.sources[0].tasks.foreign, 1);
});

test('equal task versions keep the earlier root and record the later one as a variant', async t => {
  const first = await tempStore(t, 'dag-first-');
  const second = await tempStore(t, 'dag-second-');
  await seed(first, { 'st_tie.json': record('st_tie', { description: 'first root' }) });
  await seed(second, { 'st_tie.json': record('st_tie', { description: 'second root' }) });
  const data = new TaskData({
    sessionId,
    stateDirs: [descriptor(first, 'in-project', 'repo store'), descriptor(second, 'agent-project', 'host store')],
    notify: () => {},
  });
  const tasks = await data.refresh();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].description, 'first root');
  assert.equal(tasks[0].source, data.sources.find(source => source.root === first).id);
  assert.deepEqual(tasks[0].variants.map(variant => variant.source),
    [data.sources.find(source => source.root === second).id]);
});

test('a readable store drops cached tasks it no longer proves', async t => {
  const repo = await tempStore(t, 'dag-repo-');
  await seed(repo, Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
    const id = `st_repo${index}`;
    return [`${id}.json`, record(id)];
  })));
  const data = new TaskData({ sessionId, stateDirs: [descriptor(repo, 'in-project', 'repo store')], notify: () => {} });
  data.restore(Array.from({ length: 50 }, (_, index) => ({
    id: index < 12 ? `st_repo${index}` : `st_cache${index}`,
    description: `cache ${index}`,
    status: 'completed',
  })));
  const tasks = await data.refresh();
  assert.equal(tasks.length, 12);
  assert.equal(data.staleCache, 38);
  assert.ok(tasks.every(task => !task.id.startsWith('st_cache')));
});

test('with no readable root the cached snapshot survives and never looks live', async t => {
  const missing = join(await tempStore(t, 'dag-missing-'), 'not-created');
  const data = new TaskData({ sessionId, stateDirs: [descriptor(missing, 'agent-project', 'host store')], notify: () => {} });
  data.restore(Array.from({ length: 5 }, (_, index) => ({ id: `st_cache${index}`, description: `cache ${index}` })));
  const tasks = await data.refresh();
  assert.equal(tasks.length, 5);
  assert.ok(tasks.every(task => task.source === 'cache'));
  assert.equal(data.sources[0].status, 'missing');
});

test('invalid and unreadable task files are counted without aborting the store', async t => {
  const repo = await tempStore(t, 'dag-repo-');
  await seed(repo, {
    'st_good.json': record('st_good'),
    'broken.json': '{not json',
    'wrong.json': JSON.stringify({ nope: true }),
  });
  const messages = [];
  const data = new TaskData({
    sessionId, stateDirs: [descriptor(repo, 'in-project', 'repo store')], notify: message => messages.push(message),
  });
  const tasks = await data.refresh();
  assert.deepEqual(tasks.map(task => task.id), ['st_good']);
  assert.deepEqual(data.sources[0].tasks, { files: 3, accepted: 1, foreign: 0, invalid: 2 });
  assert.equal(messages.length, 2);
});

test('refreshing readable stores never writes into them', async t => {
  const repo = await tempStore(t, 'dag-repo-');
  const host = await tempStore(t, 'dag-host-');
  await seed(repo, { 'st_repo.json': record('st_repo') });
  await seed(host, { 'st_host.json': record('st_host') });
  const before = [await storeFingerprint(repo), await storeFingerprint(host)];
  const data = new TaskData({
    sessionId,
    stateDirs: [descriptor(repo, 'in-project', 'repo store'), descriptor(host, 'agent-project', 'host store')],
    notify: () => {},
  });
  await data.refresh();
  assert.deepEqual([await storeFingerprint(repo), await storeFingerprint(host)], before);
});

test('symlinked task records are rejected instead of followed', async t => {
  const repo = await tempStore(t, 'dag-symlink-repo-');
  const outside = await tempStore(t, 'dag-symlink-target-');
  await seed(repo, { 'st_real.json': record('st_real') });
  await writeJson(join(outside, 'target.json'), record('st_target'));
  await symlink(join(outside, 'target.json'), join(repo, 'tasks', 'st_link.json'));

  const messages = [];
  const data = new TaskData({
    sessionId, stateDirs: [descriptor(repo, 'in-project', 'repo store')], notify: message => messages.push(message),
  });
  const tasks = await data.refresh();
  assert.deepEqual(tasks.map(task => task.id), ['st_real']);
  assert.deepEqual(data.sources[0].tasks, { files: 2, accepted: 1, foreign: 0, invalid: 1 });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /st_link\.json/);
  assert.match(messages[0], /symlink/);
});

test('recorded reply and error evidence survives re-normalization', () => {
  const task = normalizeOmOTask({
    task_id: 'st_recorded_evidence', status: 'failed',
    reply: 'x'.repeat(1200), replyBytes: 3373, replyTruncated: true, replySource: 'response',
    error: 'upstream failed', errorSource: 'error_message', errorKind: 'provider_error',
    turns: 7, toolCalls: 9,
    run_stats: { turns: 2, tool_calls: 3 },
  });
  assert.equal(task.replyBytes, 3373);
  assert.equal(task.replyTruncated, true);
  assert.equal(task.replySource, 'response');
  assert.equal(task.errorSource, 'error_message');
  assert.equal(task.errorKind, 'provider_error');
  assert.equal(task.turns, 7);
  assert.equal(task.toolCalls, 9);
});

test('an empty or non-numeric tokenRate array falls back to run_stats', () => {
  for (const tokenRate of [[], ['x', null]]) {
    const task = normalizeOmOTask({
      task_id: 'st_empty_rate', status: 'completed', tokenRate,
      run_stats: { tokens_per_second: 42 },
    });
    assert.deepEqual(task.tokenRate, [42]);
    assert.equal(task.tokenRateKind, 'instant');
  }
});

test('a losing store cannot extend the winning task rate history', async t => {
  const winner = await tempStore(t, 'dag-rate-winner-');
  const loser = await tempStore(t, 'dag-rate-loser-');
  await seed(winner, {
    'st_rate_dup.json': record('st_rate_dup', {
      status: 'completed', updated_at: '2026-11-10T02:00:00.000Z', tokenRate: [20],
    }),
  });
  await seed(loser, {
    'st_rate_dup.json': record('st_rate_dup', {
      status: 'running', updated_at: '2026-11-10T01:00:00.000Z', tokenRate: [10],
    }),
  });
  const first = new TaskData({
    sessionId,
    stateDirs: [descriptor(winner, 'in-project', 'repo store'), descriptor(loser, 'agent-project', 'host store')],
    notify: () => {},
  });
  let [task] = await first.refresh();
  assert.deepEqual(task.tokenRateHistory.map(sample => sample.rate), [20]);
  assert.deepEqual(first.rateHistory.get('st_rate_dup').map(sample => sample.rate), [20]);

  // Scan order is not a guarantee: the older store may be merged first and be
  // superseded by the newer one later in the same refresh.
  const second = new TaskData({
    sessionId,
    stateDirs: [descriptor(loser, 'in-project', 'repo store'), descriptor(winner, 'agent-project', 'host store')],
    notify: () => {},
  });
  [task] = await second.refresh();
  assert.deepEqual(task.tokenRateHistory.map(sample => sample.rate), [20]);
  assert.equal(task.description, 'st_rate_dup');
  assert.equal(task.source, second.sources.find(source => source.root === winner).id);
  assert.deepEqual(second.rateHistory.get('st_rate_dup').map(sample => sample.rate), [20]);

  const refreshed = await second.refresh();
  assert.deepEqual(refreshed[0].tokenRateHistory.map(sample => sample.rate), [20]);
});

test('record names with terminal escapes are sanitized in notifications', async t => {
  const repo = await tempStore(t, 'dag-record-escape-');
  const name = 'bad\u001b[31m.json';
  await seed(repo, { [name]: '{not json' });
  const messages = [];
  const data = new TaskData({
    sessionId, stateDirs: [descriptor(repo, 'in-project', 'repo store')], notify: message => messages.push(message),
  });
  await data.refresh();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].includes('\u001b'), false);
  assert.match(messages[0], /bad/);
});

test('a terminal live overlay is dropped when no scanned store proves the task', async t => {
  const root = await tempStore(t, 'dag-live-prune-');
  await mkdir(join(root, 'tasks'), { recursive: true });
  const data = new TaskData({ sessionId, stateDirs: [descriptor(root, 'in-project', 'repo store')], notify: () => {} });
  await data.refresh();
  const done = liveTaskPayload('st_live_done').tasks[0];
  done.status = 'completed';
  const active = liveTaskPayload('st_live_active', { updatedAt: '2026-11-10T09:00:00.000Z' }).tasks[0];
  assert.equal(data.receive({ parent_session_id: sessionId, tasks: [done, active] }), true);
  assert.deepEqual(data.snapshot().map(task => task.id).sort(), ['st_live_active', 'st_live_done']);

  const tasks = await data.refresh();
  assert.deepEqual(tasks.map(task => task.id), ['st_live_active']);
  assert.equal(data.live.has('st_live_done'), false);
  assert.equal(data.live.has('st_live_active'), true);

  // With no readable store there is no proof of deletion, so the overlay stays.
  const missing = new TaskData({
    sessionId, stateDirs: [descriptor(join(root, 'not-created'), 'agent-project', 'host store')], notify: () => {},
  });
  await missing.refresh();
  missing.receive({ parent_session_id: sessionId, tasks: [done] });
  assert.deepEqual((await missing.refresh()).map(task => task.id), ['st_live_done']);
});

test('snapshot indexes children once and keeps root-first order', async t => {
  const root = await tempStore(t, 'dag-snapshot-index-');
  const records = {};
  for (let index = 0; index < 15; index++) {
    const id = `st_index_root${index}`;
    records[`${id}.json`] = record(id);
    records[`st_index_kid${index}.json`] = record(`st_index_kid${index}`, {
      parent_session_id: `child-${index}`, parent_task_id: id,
    });
  }
  await seed(root, records);
  const data = new TaskData({ sessionId, stateDirs: [descriptor(root, 'in-project', 'repo store')], notify: () => {} });
  await data.refresh();

  const entries = data.entries;
  let iterations = 0;
  data.entries = {
    get: id => entries.get(id),
    [Symbol.iterator]: function* () {
      for (const pair of entries) {
        iterations++;
        yield pair;
      }
    },
  };
  const tasks = data.snapshot();
  assert.equal(iterations, entries.size);
  assert.equal(tasks.length, 30);
  assert.ok(tasks.slice(0, 15).every(task => task.id.startsWith('st_index_root')));
  assert.ok(tasks.slice(15).every(task => task.parentTaskId?.startsWith('st_index_root')));
});

test('a deeply missing store cannot break watcher startup', async t => {
  const base = await tempStore(t, 'dag-deep-watch-');
  const root = join(base, 'a', 'b', 'c', 'd', 'e', 'f');
  const messages = [];
  const data = new TaskData({
    sessionId, stateDirs: [descriptor(root, 'explicit', 'explicit store')], notify: message => messages.push(message),
  });
  assert.doesNotThrow(() => data.start());
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Task watcher/);
  assert.doesNotThrow(() => data.start());
  assert.equal(messages.length, 1);
  assert.equal(data.watchRetryTimers.size, 1);
  data.stop();
  assert.equal(data.watchRetryTimers.size, 0);
});

test('corrupt records are reported once across repeated refreshes', async t => {
  const repo = await tempStore(t, 'dag-record-warn-');
  await seed(repo, {
    'st_good.json': record('st_good'),
    'broken.json': '{not json',
    'wrong.json': JSON.stringify({ nope: true }),
  });
  const messages = [];
  const data = new TaskData({
    sessionId, stateDirs: [descriptor(repo, 'in-project', 'repo store')], notify: message => messages.push(message),
  });
  for (let index = 0; index < 3; index++) await data.refresh();
  assert.equal(messages.length, 2);
});

test('a watcher error clears its registration and schedules a bounded retry', async t => {
  const root = await tempStore(t, 'dag-watch-error-');
  await seed(root, { 'st_watch.json': record('st_watch') });
  const messages = [];
  const data = new TaskData({
    sessionId, stateDirs: [descriptor(root, 'in-project', 'repo store')], notify: message => messages.push(message),
  });
  data.start();
  const id = data.directories[0].id;
  const watcher = data.watchers.get(id);
  assert.ok(watcher);
  watcher.emit('error', Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
  assert.equal(data.watchers.has(id), false);
  assert.equal(data.watchedDirectories.has(id), false);
  assert.equal(data.watchRetryTimers.has(id), true);
  assert.equal(data.watchAttempts.get(id), 1);
  assert.ok(messages.some(message => message.includes('ENOSPC')));
  data.stop();
  assert.equal(data.watchRetryTimers.size, 0);
});

test('writeJson writes a 0600 destination and leaves no temporary file', async t => {
  const root = await tempStore(t, 'dag-write-json-');
  const target = join(root, 'config.json');
  await writeJson(target, { theme: 'grok-night' });
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { theme: 'grok-night' });
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(root), ['config.json']);
});

test('writeJson removes its temporary file and rethrows when rename fails', async t => {
  const root = await tempStore(t, 'dag-write-json-fail-');
  const target = join(root, 'state.json');
  await mkdir(target, { recursive: true });
  await assert.rejects(writeJson(target, { version: 1 }), error => {
    assert.ok(['EISDIR', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code));
    return true;
  });
  assert.deepEqual(await readdir(root), ['state.json']);
});

test('task records above the size cap are rejected without being loaded', async t => {
  const repo = await tempStore(t, 'dag-oversized-repo-');
  await seed(repo, { 'st_small.json': record('st_small') });
  const oversized = JSON.stringify({ ...record('st_huge'), padding: 'x'.repeat(4 * 1024 * 1024 + 1) });
  await writeFile(join(repo, 'tasks', 'st_huge.json'), oversized);

  const messages = [];
  const data = new TaskData({
    sessionId, stateDirs: [descriptor(repo, 'in-project', 'repo store')], notify: message => messages.push(message),
  });
  const tasks = await data.refresh();
  assert.deepEqual(tasks.map(task => task.id), ['st_small']);
  assert.deepEqual(data.sources[0].tasks, { files: 2, accepted: 1, foreign: 0, invalid: 1 });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /st_huge\.json/);
  assert.match(messages[0], /exceeds/);
});

test('F-17 pruneRates keeps visible rate state and drops the rest', () => {
  const data = new TaskData({
    sessionId, stateDirs: [descriptor('/tmp/dag-rate-prune', 'in-project', 'repo store')], notify: () => {},
  });
  for (const id of ['st_keep', 'st_gone']) {
    data.rateHistory.set(id, [{ at: '2026-11-10T08:00:00.000Z', rate: 5 }]);
    data.rateSeen.set(id, { at: '2026-11-10T08:00:00.000Z', rate: 5, wall: 1 });
    data.rateSources.set(id, 'live');
  }

  assert.equal(data.pruneRates(new Set(['st_keep'])), 3);
  for (const map of [data.rateHistory, data.rateSeen, data.rateSources]) {
    assert.equal(map.has('st_keep'), true);
    assert.equal(map.has('st_gone'), false);
  }
  assert.equal(data.pruneRates(['st_keep']), 0);
});

test('F-42 task-data and model share reply, retry, cache, rate, and turn evidence', () => {
  const host = {
    task_id: 'st_shared_evidence', parent_session_id: sessionId, status: 'failed',
    final_response: 'x'.repeat(1300), error_message: 'upstream failed', failure_kind: 'provider_error',
    run_stats: {
      turns: 9, tool_calls: 4, failed_turns: 2, cache_read_tokens: 10, cache_write_tokens: 2,
      total_tokens: 20, cost_usd: 0.5, cache_hit_rate_run: 0.8, tokens_per_second: 50,
    },
    live_progress: { turns: 7, tool_calls: 8 },
  };
  const task = normalizeOmOTask(host);
  const modelTask = normalizeTask({ ...host, id: host.task_id });
  for (const field of [
    'reply', 'replyBytes', 'replyTruncated', 'replySource', 'error', 'errorSource', 'errorKind',
    'failedTurns', 'retries', 'retriesSource', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens',
    'costUsd', 'cacheHitRate', 'cacheHitRateLast', 'tokenRate', 'tokenRateKind', 'turns', 'toolCalls',
  ]) {
    assert.deepEqual(task[field], modelTask[field], field);
  }
  assert.equal(task.turns, 7);
  assert.equal(task.toolCalls, 8);

  // A legacy top-level reply without producer byte metadata still reports the
  // truncation the shared normalizer can prove from the excerpt itself.
  const legacy = normalizeOmOTask({
    task_id: 'st_legacy_reply', status: 'completed', reply: 'x'.repeat(2000),
  });
  assert.equal(legacy.reply.length, 1200);
  assert.equal(legacy.replyTruncated, true);
});
