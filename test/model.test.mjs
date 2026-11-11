import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activitySummary, compareNavigationTasks, deriveRunStatus, elapsedLabel, elapsedMs, findRunningTarget, layers,
  modeFor, nodeActivity, nodeForTask, normalizeRun, normalizeSnapshot, normalizeTask, orderRuns, runStats,
  standaloneTasks,
} from '../src/model.mjs';
import { DemoEngine } from '../src/demo.mjs';

const at = time => new DemoEngine({ now: 1_000_000, startOffset: 0 }).snapshot(1_000_000 + time);

test('v1 and v2 snapshots normalize to the same viewer model', () => {
  const raw = {
    version: 1, sessionId: 's1', connected: true,
    runs: [{
      id: 'r1', name: 'Run', status: 'running', createdAt: '2026-01-01T00:00:00Z',
      nodes: [
        { id: 'a', label: 'root', state: 'completed', taskId: 'st_a' },
        { id: 'b', label: 'leaf', state: 'running', taskId: 'st_b' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    }],
    tasks: [
      { id: 'st_a', description: 'root task', status: 'completed', progress: 'stale' },
      { id: 'st_b', description: 'leaf task', status: 'running', progress: 'working', turns: 2, toolCalls: 3 },
    ],
  };
  const snapshot = normalizeSnapshot(raw);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0].nodes[1].task.description, 'leaf task');
  assert.equal(normalizeRun(raw.runs[0]).name, 'Run');
  assert.equal(normalizeRun({ ...raw.runs[0], todoTitle: 'adjust metric layout' }).todoTitle, 'adjust metric layout');
  assert.equal(snapshot.runs[0].nodes[1].progress, 'working');
  assert.equal(snapshot.runs[0].nodes[0].progress, undefined);
});

test('DAG node and snapshot task runStats map to token usage', () => {
  const snapshot = normalizeSnapshot({
    sessionId: 's',
    runs: [{
      id: 'r', name: 'Run', status: 'completed',
      nodes: [{ id: 'n', state: 'completed', runStats: { input_tokens: 120, output_tokens: 30, tokens_per_second: 12 } }],
      edges: [],
    }],
    tasks: [{ id: 'st_task_stats', description: 'task', status: 'completed', run_stats: { input_tokens: 7, output_tokens: 3 } }],
  });
  assert.equal(snapshot.runs[0].nodes[0].tokensIn, 120);
  assert.equal(snapshot.runs[0].nodes[0].tokensOut, 30);
  assert.deepEqual(snapshot.runs[0].nodes[0].tokenRate, [12]);
  assert.equal(snapshot.tasks[0].tokensIn, 7);
  assert.equal(snapshot.tasks[0].tokensOut, 3);
});

test('completed tasks without run_stats infer token rate from output and duration', () => {
  const snapshot = normalizeSnapshot({
    sessionId: 's',
    runs: [],
    tasks: [{
      id: 'st_slow', description: 'slow task', status: 'completed',
      startedAt: '2026-11-10T00:00:00.000Z', completedAt: '2026-11-10T00:00:10.000Z',
      tokensOut: 100,
    }],
  });
  assert.deepEqual(snapshot.tasks[0].tokenRate, [10]);
});

test('task-only terminal statuses are preserved for the viewer', () => {
  const snapshot = normalizeSnapshot({
    sessionId: 's', runs: [], tasks: [
      { id: 'st_error', status: 'error', progress: 'stale' },
      { id: 'st_lost', status: 'lost' },
    ],
  });
  assert.equal(snapshot.tasks[0].status, 'error');
  assert.equal(snapshot.tasks[0].progress, undefined);
  assert.equal(snapshot.tasks[1].status, 'lost');
});

test('labels and errors are stripped of terminal control characters', () => {
  const snapshot = normalizeSnapshot({
    sessionId: 's', runs: [{
      id: 'r', status: 'running', nodes: [{ id: 'n', label: '\u001b[31mred\u001b[0m', state: 'failed', error: 'bad\u202e' }],
      edges: [],
    }], tasks: [],
  });
  assert.equal(snapshot.runs[0].nodes[0].label, 'red');
  assert.equal(snapshot.runs[0].nodes[0].error, 'bad');
});

test('topological layers preserve diamond order and reject cycles', () => {
  const run = {
    nodes: ['a', 'b', 'c', 'd'].map(id => ({ id, state: 'pending' })),
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }],
  };
  assert.deepEqual(layers(run).map(row => row.map(node => node.id)), [['a'], ['b', 'c'], ['d']]);
  assert.throws(() => layers({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }), /cycle/i);
});

test('zero token-rate samples survive normalization', () => {
  assert.deepEqual(normalizeTask({ id: 'st_direct_zero', tokenRate: [0] }).tokenRate, [0]);
  const snapshot = normalizeSnapshot({
    sessionId: 's', runs: [], tasks: [
      { id: 'st_zero', status: 'running', tokenRate: [0] },
      { id: 'st_mixed', status: 'running', tokenRate: [0, 5] },
    ],
  });
  assert.deepEqual(snapshot.tasks.find(task => task.id === 'st_zero').tokenRate, [0]);
  assert.deepEqual(snapshot.tasks.find(task => task.id === 'st_mixed').tokenRate, [0, 5]);
});

test('task and run error fields normalize from host shapes', () => {
  const cases = [
    [{ error: { message: 'error object' } }, 'error object'],
    [{ error: 'error string' }, 'error string'],
    [{ error_message: 'message field' }, 'message field'],
    [{ failure_reason: 'failure field' }, 'failure field'],
    [{ last_error: 'last field' }, 'last field'],
  ];
  for (const [shape, expected] of cases) {
    assert.equal(normalizeTask({ id: 'st_err', status: 'failed', ...shape }).error, expected);
  }
  const run = normalizeRun({
    id: 'r', status: 'failed',
    nodes: [
      { id: 'n', state: 'failed', last_error: { message: 'node error object' } },
      { id: 'm', state: 'failed', failure_reason: 'node failure' },
      { id: 'p', state: 'failed', last_error: 'node last error' },
    ],
    edges: [],
  });
  assert.equal(run.nodes[0].error, 'node error object');
  assert.equal(run.nodes[1].error, 'node failure');
  assert.equal(run.nodes[2].error, 'node last error');
});

test('run nodes normalize output tail, artifact metadata, and node run_stats', () => {
  const output = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n') + '\u001b[31m';
  const run = normalizeRun({
    id: 'evidence-run', status: 'completed',
    nodes: [{
      id: 'implement', state: 'completed', prompt: 'SECRET PROMPT', output, outputBytes: 4096,
      runStats: {
        turns: 75, failed_turns: 3, cache_read_tokens: 10861312, cache_write_tokens: 2048,
        total_tokens: 11090040, cost_usd: 0.108229236, cache_hit_rate_run: 0.9875552159438714,
        cache_hit_rate_last: 0.9939245188443623, tokens_per_second: 199, cost_status: 'reported',
      },
      resultArtifact: {
        relativePath: 'dag/results/evidence-run/implement.txt',
        sha256: 'cc8f39e9ddf41a6c118f27f986b064cc707289db954f904f413ae5d3cf244230',
        bytes: 4096,
        stats: { relativePath: 'dag/results/evidence-run/implement.stats.json', bytes: 493 },
      },
    }],
    edges: [],
  });
  const node = run.nodes[0];
  assert.equal('prompt' in node, false);
  assert.deepEqual(node.recentEvents, Array.from({ length: 8 }, (_, index) => `line ${index + 5}`));
  assert.equal(node.outputBytes, 4096);
  assert.equal(node.outputTruncated, true);
  assert.deepEqual(node.artifact, {
    relativePath: 'dag/results/evidence-run/implement.txt',
    bytes: 4096,
    sha256: 'cc8f39e9ddf41a6c118f27f986b064cc707289db954f904f413ae5d3cf244230',
    statsPath: 'dag/results/evidence-run/implement.stats.json',
    statsBytes: 493,
  });
  assert.equal(node.failedTurns, 3);
  assert.equal(node.retries, 3);
  assert.equal(node.retriesSource, 'run_stats.failed_turns');
  assert.equal(node.cacheReadTokens, 10861312);
  assert.equal(node.cacheWriteTokens, 2048);
  assert.equal(node.totalTokens, 11090040);
  assert.equal(node.costUsd, 0.108229236);
  assert.equal(node.cacheHitRate, 0.9875552159438714);
  assert.equal(node.cacheHitRateLast, 0.9939245188443623);
  assert.equal(node.costStatus, 'reported');
  assert.deepEqual(node.tokenRate, [199]);
  assert.equal(node.tokenRateKind, 'instant');
});

test('node output tails keep only the last eight sanitized bounded lines', () => {
  const output = ['first', '', `\u001b[31m${'x'.repeat(400)}`].join('\n');
  const node = normalizeRun({
    id: 'r', status: 'completed',
    nodes: [{ id: 'n', state: 'completed', output, outputBytes: 500 }], edges: [],
  }).nodes[0];
  assert.equal(node.recentEvents.length, 2);
  assert.equal(node.recentEvents[0], 'first');
  assert.equal(node.recentEvents[1].length, 240);
  assert.ok(!node.recentEvents[1].includes('\u001b'));
  assert.equal(node.outputTruncated, true);
});

test('token rate kind distinguishes instant, average, and history samples', () => {
  const instant = normalizeTask({ id: 'st_instant', status: 'completed', run_stats: { tokens_per_second: 225 } });
  assert.deepEqual(instant.tokenRate, [225]);
  assert.equal(instant.tokenRateKind, 'instant');

  const average = normalizeTask({
    id: 'st_average', status: 'completed', tokensOut: 100,
    startedAt: '2026-11-10T00:00:00.000Z', completedAt: '2026-11-10T00:00:10.000Z',
  });
  assert.deepEqual(average.tokenRate, [10]);
  assert.equal(average.tokenRateKind, 'average');

  const history = normalizeTask({ id: 'st_history', status: 'running', tokenRate: [2, 4, 8, 16] });
  assert.deepEqual(history.tokenRate, [2, 4, 8, 16]);
  assert.equal(history.tokenRateKind, 'history');

  const single = normalizeTask({ id: 'st_single', status: 'running', tokenRate: [225] });
  assert.deepEqual(single.tokenRate, [225]);
  assert.equal(single.tokenRateKind, undefined);
});

test('snapshot tasks preserve evidence metadata and never invent values', () => {
  const snapshot = normalizeSnapshot({
    sessionId: 's', runs: [], tasks: [
      {
        id: 'st_preserved', status: 'completed', reply: 'x'.repeat(1200),
        replyBytes: 3373, replyTruncated: true, replySource: 'final_response',
        failedTurns: 4, retries: 4, retriesSource: 'run_stats.failed_turns',
        cacheReadTokens: 1065600, cacheWriteTokens: 64, totalTokens: 1130343, costUsd: 0.0217,
        cacheHitRate: 0.959, cacheHitRateLast: 0.994, costStatus: 'reported',
        tokenRate: [225], tokenRateKind: 'instant',
        error: 'upstream failed', errorSource: 'error_message', errorKind: 'provider_error',
      },
      { id: 'st_legacy', status: 'completed', reply: 'older excerpt' },
    ],
  });
  const current = snapshot.tasks[0];
  assert.equal(current.reply.length, 1200);
  assert.equal(current.replyBytes, 3373);
  assert.equal(current.replyTruncated, true);
  assert.equal(current.replySource, 'final_response');
  assert.equal(current.failedTurns, 4);
  assert.equal(current.retries, 4);
  assert.equal(current.retriesSource, 'run_stats.failed_turns');
  assert.equal(current.cacheReadTokens, 1065600);
  assert.equal(current.cacheWriteTokens, 64);
  assert.equal(current.totalTokens, 1130343);
  assert.equal(current.costUsd, 0.0217);
  assert.equal(current.cacheHitRate, 0.959);
  assert.equal(current.cacheHitRateLast, 0.994);
  assert.equal(current.costStatus, 'reported');
  assert.equal(current.tokenRateKind, 'instant');
  assert.equal(current.error, 'upstream failed');
  assert.equal(current.errorSource, 'error_message');
  assert.equal(current.errorKind, 'provider_error');

  const legacy = snapshot.tasks[1];
  assert.equal(legacy.reply, 'older excerpt');
  assert.equal('replyBytes' in legacy, false);
  assert.equal('replyTruncated' in legacy, false);
  assert.equal('failedTurns' in legacy, false);
  assert.equal('retries' in legacy, false);
  assert.equal('cacheReadTokens' in legacy, false);
  assert.equal('tokenRateKind' in legacy, false);
});

test('host-shaped task records derive reply metadata and evidence', () => {
  const task = normalizeTask({
    id: 'st_host', status: 'failed', final_response: 'x'.repeat(2000),
    error_message: 'tool failed', failure_kind: 'tool_error',
    run_stats: {
      failed_turns: 2, cache_read_tokens: 100, cache_write_tokens: 5, total_tokens: 120,
      cost_usd: 0.01, cache_hit_rate_run: 0.9, cache_hit_rate_last: 0.95,
      tokens_per_second: 100, cost_status: 'reported',
    },
  });
  assert.equal(task.reply.length, 1200);
  assert.equal(task.replyBytes, 2000);
  assert.equal(task.replyTruncated, true);
  assert.equal(task.replySource, 'final_response');
  assert.equal(task.failedTurns, 2);
  assert.equal(task.retries, 2);
  assert.equal(task.retriesSource, 'run_stats.failed_turns');
  assert.equal(task.cacheReadTokens, 100);
  assert.equal(task.cacheWriteTokens, 5);
  assert.equal(task.totalTokens, 120);
  assert.equal(task.costUsd, 0.01);
  assert.equal(task.cacheHitRate, 0.9);
  assert.equal(task.cacheHitRateLast, 0.95);
  assert.equal(task.error, 'tool failed');
  assert.equal(task.errorSource, 'error_message');
  assert.equal(task.errorKind, 'tool_error');
});

test('retry provenance separates inferred zero, explicit values, and unknown', () => {
  const inferred = normalizeTask({ id: 'st_inferred', status: 'completed', run_stats: { turns: 5, tool_calls: 2 } });
  assert.equal(inferred.failedTurns, 0);
  assert.equal(inferred.retries, 0);
  assert.equal(inferred.retriesSource, 'run_stats.turns');
  assert.equal(inferred.provenance.retries.kind, 'derived');
  assert.equal(inferred.provenance.retries.from, 'run_stats.turns');

  const explicitZero = normalizeTask({ id: 'st_explicit_zero', status: 'completed', retries: 0 });
  assert.equal(explicitZero.retries, 0);
  assert.equal(explicitZero.retriesSource, 'task.retries');
  assert.equal(explicitZero.provenance.retries.kind, 'recorded');
  assert.equal(explicitZero.provenance.retries.from, 'task.retries');

  const failedZero = normalizeTask({ id: 'st_failed_zero', status: 'completed', failed_turns: 0 });
  assert.equal(failedZero.retries, 0);
  assert.equal(failedZero.retriesSource, 'task.failed_turns');
  assert.equal(failedZero.provenance.retries.kind, 'recorded');

  const recordedZero = normalizeTask({ id: 'st_recorded_zero', status: 'completed', run_stats: { turns: 5, failed_turns: 0 } });
  assert.equal(recordedZero.retries, 0);
  assert.equal(recordedZero.retriesSource, 'run_stats.failed_turns');
  assert.equal(recordedZero.provenance.retries.kind, 'recorded');

  const explicit = normalizeTask({ id: 'st_explicit', status: 'completed', retries: 2, run_stats: { turns: 10, failed_turns: 4 } });
  assert.equal(explicit.retries, 2);
  assert.equal(explicit.retriesSource, 'task.retries');
  assert.equal(explicit.provenance.retries.kind, 'recorded');

  const recorded = normalizeTask({ id: 'st_recorded', status: 'completed', run_stats: { turns: 10, failed_turns: 3 } });
  assert.equal(recorded.retries, 3);
  assert.equal(recorded.retriesSource, 'run_stats.failed_turns');
  assert.equal(recorded.provenance.retries.kind, 'recorded');
  assert.equal(recorded.provenance.retries.from, 'run_stats.failed_turns');

  const unknown = normalizeTask({ id: 'st_unknown', status: 'completed' });
  assert.equal('failedTurns' in unknown, false);
  assert.equal('retries' in unknown, false);
  assert.equal(unknown.provenance.retries.kind, 'unavailable');
});

test('normalized snapshots never label an inferred retry zero as recorded', () => {
  const snapshot = normalizeSnapshot({
    version: 3, mode: 'live', connected: true,
    runs: [{
      id: 'r', status: 'completed',
      nodes: [
        { id: 'n_inferred', state: 'completed', run_stats: { turns: 5 } },
        { id: 'n_recorded', state: 'completed', run_stats: { turns: 5, failed_turns: 2 } },
      ],
      edges: [],
    }],
    tasks: [
      { id: 'st_inferred', status: 'completed', run_stats: { turns: 5 } },
      { id: 'st_recorded', status: 'completed', run_stats: { turns: 5, failed_turns: 2 } },
    ],
  });
  const [inferredTask, recordedTask] = snapshot.tasks;
  assert.equal(inferredTask.retries, 0);
  assert.equal(inferredTask.provenance.retries.kind, 'derived');
  assert.equal(inferredTask.provenance.retries.from, 'run_stats.turns');
  assert.equal(recordedTask.retries, 2);
  assert.equal(recordedTask.provenance.retries.kind, 'recorded');
  assert.equal(recordedTask.provenance.retries.from, 'run_stats.failed_turns');

  const [inferredNode, recordedNode] = snapshot.runs[0].nodes;
  assert.equal(inferredNode.retries, 0);
  assert.equal(inferredNode.provenance.retries.kind, 'derived');
  assert.equal(inferredNode.provenance.retries.from, 'run_stats.turns');
  assert.equal(recordedNode.retries, 2);
  assert.equal(recordedNode.provenance.retries.kind, 'recorded');
  assert.equal(recordedNode.provenance.retries.from, 'run_stats.failed_turns');
});

test('a node inherits a task retry count as derived from task.retries', () => {
  const snapshot = normalizeSnapshot({
    version: 3, mode: 'live', connected: true,
    runs: [{
      id: 'r', status: 'running',
      nodes: [{ id: 'n', state: 'running', task_id: 'st_r' }], edges: [],
    }],
    tasks: [{ id: 'st_r', status: 'running', retries: 3 }],
  });
  const task = snapshot.tasks[0];
  const node = snapshot.runs[0].nodes[0];
  assert.equal(task.retries, 3);
  assert.equal(task.provenance.retries.kind, 'recorded');
  assert.equal(task.provenance.retries.from, 'task.retries');
  assert.equal(node.retries, 3);
  assert.equal(node.provenance.retries.kind, 'derived');
  assert.equal(node.provenance.retries.from, 'task.retries');
});

test('runs preserve checkpoint sequence for restore recency', () => {
  const camel = normalizeRun({ id: 'r1', status: 'running', checkpointSeq: 4, nodes: [{ id: 'n', state: 'running' }], edges: [] });
  const snake = normalizeRun({ id: 'r2', status: 'running', checkpoint_seq: 7, nodes: [{ id: 'n', state: 'running' }], edges: [] });
  assert.equal(camel.checkpointSeq, 4);
  assert.equal(snake.checkpointSeq, 7);
});

test('standalone tasks exclude linked and child tasks, and follow prefers execution identity', () => {
  const snapshot = normalizeSnapshot(at(20_000));
  const standalone = standaloneTasks(snapshot);
  assert.ok(standalone.every(task => !task.parentTaskId));
  assert.ok(standalone.some(task => task.id === 'st_index'));
  assert.ok(!standalone.some(task => task.id === 'st_api'));
  const index = findRunningTarget(snapshot);
  assert.equal(index.taskId, 'st_api');
  const standaloneTarget = findRunningTarget({ ...snapshot, runs: [] }, { kind: 'task', taskId: 'st_index' });
  assert.equal(standaloneTarget.taskId, 'st_index');
});

test('activity summary exposes phases, tails, and stall thresholds', () => {
  const text = activitySummary({ phase: 'text', text: 'TAIL', since: 0, lastAt: 1000 }, { now: 2000 });
  assert.equal(text.text, 'TAIL');
  assert.equal(text.stalled, false);
  const stalled = activitySummary({ phase: 'text', text: 'TAIL', since: 0, lastAt: 0 }, { now: 31_000 });
  assert.equal(stalled.stalled, true);
  const tool = activitySummary({ phase: 'tool', tool: 'bash', since: 0, lastAt: 0 }, { now: 100_000 });
  assert.equal(tool.stalled, false);
  assert.match(tool.label, /bash/);
});

test('terminal nodes do not inherit a live task activity', () => {
  const activity = { phase: 'tool', tool: 'bash', since: 1000, lastAt: 2000 };
  const snapshot = normalizeSnapshot({
    version: 3, mode: 'live', connected: true,
    runs: [{
      id: 'r', status: 'running',
      nodes: [
        { id: 'done', state: 'completed', taskId: 'st_live' },
        { id: 'failed', state: 'failed', taskId: 'st_live', error: 'upload failed' },
        { id: 'live', state: 'running', taskId: 'st_live' },
        { id: 'own', state: 'completed', taskId: 'st_live', activity: { phase: 'text', text: 'own evidence', since: 1, lastAt: 2 } },
      ],
      edges: [],
    }],
    tasks: [{ id: 'st_live', status: 'running', activity }],
  });
  const [done, failed, live, own] = snapshot.runs[0].nodes;
  assert.deepEqual(snapshot.tasks[0].activity, activity);
  assert.equal(done.activity, undefined);
  assert.equal(failed.activity, undefined);
  assert.equal(failed.error, 'upload failed');
  assert.deepEqual(live.activity, activity);
  assert.equal(own.activity.text, 'own evidence');
});

test('nodeActivity borrows a linked task activity only while the node is running', () => {
  const activity = { phase: 'tool', tool: 'bash', since: 1000, lastAt: 2000 };
  const task = { id: 'st_live', status: 'running', activity };
  assert.equal(nodeActivity(undefined), undefined, 'no subject has no activity');
  assert.equal(nodeActivity({ id: 'done', state: 'completed', task }), undefined,
    'a completed node ignores its linked task activity');
  assert.equal(nodeActivity({ id: 'failed', state: 'failed', task }), undefined,
    'a failed node ignores its linked task activity');
  assert.deepEqual(nodeActivity({ id: 'live', state: 'running', task }), activity,
    'a running node borrows the linked task activity');
  assert.deepEqual(nodeActivity(task), activity,
    'a plain task object returns its own activity with no state');
  const own = { phase: 'text', text: 'own evidence', since: 1, lastAt: 2 };
  assert.deepEqual(nodeActivity({ id: 'done', state: 'completed', activity: own, task }), own,
    'a node keeps its own recorded activity when terminal');
});

test('snapshots preserve store provenance, variants, and source status', () => {
  const snapshot = normalizeSnapshot({
    version: 3,
    sessionId: 's',
    sources: [{
      id: 'in-project-1234abcd', label: 'repo store', origin: 'in-project', root: '/repo/.omo/senpi-task',
      status: 'ok', tasks: { files: 12, accepted: 12, foreign: 0, invalid: 0 },
      runs: { files: 4, accepted: 3, foreign: 1, invalid: 0 }, scannedAt: '2026-11-10T06:00:00.000Z',
    }],
    runs: [{
      id: 'r', name: 'Run', status: 'completed', source: 'agent-project-5678ef01',
      nodes: [{ id: 'n', state: 'completed', taskId: 'st_a' }], edges: [],
      variants: [{ source: 'in-project-1234abcd', updatedAt: '2026-11-10T01:00:00.000Z', checkpointSeq: 2, status: 'running', nodeCount: 1 }],
    }],
    tasks: [{ id: 'st_a', status: 'completed', source: 'agent-project-5678ef01', variants: [{ source: 'in-project-1234abcd', status: 'running' }] }],
  });
  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.sources.length, 1);
  assert.equal(snapshot.sources[0].label, 'repo store');
  assert.equal(snapshot.sources[0].runs.foreign, 1);
  assert.equal(snapshot.runs[0].source, 'agent-project-5678ef01');
  assert.equal(snapshot.runs[0].variants[0].source, 'in-project-1234abcd');
  assert.equal(snapshot.runs[0].variants[0].nodeCount, 1);
  assert.equal(snapshot.tasks[0].source, 'agent-project-5678ef01');
  assert.equal(snapshot.tasks[0].variants[0].status, 'running');
});

test('v2 snapshots never invent a live source for unstamped records', () => {
  const snapshot = normalizeSnapshot({
    version: 2, sessionId: 's',
    runs: [{ id: 'r', status: 'running', nodes: [{ id: 'n', state: 'running' }], edges: [] }],
    tasks: [{ id: 'st_a', status: 'running' }],
  });
  assert.deepEqual(snapshot.sources, []);
  assert.equal(snapshot.runs[0].source, undefined);
  assert.equal(snapshot.tasks[0].source, undefined);
});

test('nodeForTask prefers the run the user is already viewing', () => {
  const snapshot = normalizeSnapshot({
    sessionId: 's',
    runs: [
      { id: 'run_a', status: 'completed', createdAt: '2026-11-10T02:00:00Z', nodes: [{ id: 'a', state: 'completed', taskId: 'st_shared' }], edges: [] },
      { id: 'run_b', status: 'completed', createdAt: '2026-11-10T01:00:00Z', nodes: [{ id: 'b', state: 'completed', taskId: 'st_shared' }], edges: [] },
    ],
    tasks: [{ id: 'st_shared', status: 'completed' }],
  });
  assert.equal(nodeForTask(snapshot, 'st_shared').run.id, 'run_a');
  assert.equal(nodeForTask(snapshot, 'st_shared', { preferRunId: 'run_b' }).run.id, 'run_b');
  assert.equal(nodeForTask(snapshot, 'st_missing'), undefined);
});

test('mode derives from explicit mode, demo, connection, then live fallback', () => {
  assert.equal(modeFor({ mode: 'demo', connected: true }), 'demo');
  assert.equal(modeFor({ mode: 'saved', connected: true }), 'saved');
  assert.equal(modeFor({ mode: 'live', connected: false }), 'live');
  assert.equal(modeFor({ mode: 'bogus', connected: true }), 'live');
  assert.equal(modeFor({ demo: { cycle: 1 }, connected: true }), 'demo');
  assert.equal(modeFor({ connected: false }), 'saved');
  assert.equal(modeFor({ connected: true }), 'live');
  assert.equal(modeFor({ connected: true }, { demoMode: true }), 'demo');
});

test('normalized snapshots carry mode, provenance, and a consistent connection bit', () => {
  const demo = normalizeSnapshot(new DemoEngine({ now: 1_000_000, startOffset: 0 }).snapshot(1_000_000));
  assert.equal(demo.mode, 'demo');
  assert.equal(demo.connected, true);
  assert.equal(demo.provenance.origin, 'demo-engine');
  assert.equal(demo.provenance.capturedAt, '1970-01-01T00:16:40.000Z');
  assert.equal(demo.tasks[0].provenance.thinking.kind, 'simulated');
  assert.equal(demo.runs[0].nodes[0].provenance.percent.kind, 'simulated');

  const saved = normalizeSnapshot({ version: 3, mode: 'saved', connected: true, runs: [], tasks: [] });
  assert.equal(saved.mode, 'saved');
  assert.equal(saved.connected, false);
  assert.equal(saved.provenance.origin, 'legacy-snapshot');

  const live = normalizeSnapshot({ version: 3, mode: 'live', connected: true, runs: [], tasks: [] });
  assert.equal(live.mode, 'live');
  assert.equal(live.connected, true);
});

test('field provenance distinguishes recorded, derived, and unavailable values', () => {
  const snapshot = normalizeSnapshot({
    version: 3, mode: 'live', connected: true,
    runs: [{
      id: 'r', status: 'running',
      nodes: [
        { id: 'n1', state: 'running', taskId: 'st_task' },
        { id: 'n2', state: 'completed' },
        { id: 'n3', state: 'failed' },
      ],
      edges: [],
    }],
    tasks: [
      { id: 'st_task', status: 'running', category: 'quick', reply: '  final answer text  ' },
      { id: 'st_done', status: 'completed' },
    ],
  });
  const task = snapshot.tasks[0];
  assert.equal(task.provenance.state.kind, 'recorded');
  assert.equal(task.provenance.percent.kind, 'unavailable');
  assert.equal('percent' in task, false);
  assert.equal(task.provenance.agent.kind, 'derived');
  assert.equal(task.provenance.agent.from, 'category');
  assert.equal(task.provenance.thinking.kind, 'unavailable');
  assert.equal(task.provenance.reply.kind, 'recorded');
  assert.equal(task.provenance.retries.kind, 'unavailable');

  const [running, completed, failed] = snapshot.runs[0].nodes;
  assert.equal(running.percent, undefined);
  assert.equal(running.provenance.percent.kind, 'unavailable');
  assert.equal(completed.percent, 100);
  assert.equal(completed.provenance.percent.kind, 'derived');
  assert.equal(completed.provenance.percent.from, 'completed status');
  assert.equal(failed.percent, undefined);
  assert.equal(failed.provenance.percent.kind, 'unavailable');
  assert.equal(running.provenance.reply.kind, 'derived');
  assert.equal(running.provenance.reply.from, 'task.reply');

  const stats = runStats(snapshot.runs[0]);
  assert.equal(stats.percent, undefined);
  assert.equal(stats.percentKnown, false);
  assert.equal(stats.done, 1);
  assert.equal(stats.total, 3);
});

test('legacy v1/v2 fields are preserved but marked unknown', () => {
  const snapshot = normalizeSnapshot({
    version: 2, sessionId: 's', connected: true,
    runs: [{ id: 'r', status: 'running', nodes: [{ id: 'n', state: 'running', percent: 0 }], edges: [] }],
    tasks: [{ id: 'st_a', status: 'running', percent: 0, agent: 'quick', thinking: 'legacy reasoning' }],
  });
  assert.equal(snapshot.mode, 'live');
  assert.equal(snapshot.tasks[0].percent, 0);
  assert.equal(snapshot.tasks[0].thinking, 'legacy reasoning');
  assert.equal(snapshot.tasks[0].provenance.percent.kind, 'unknown');
  assert.equal(snapshot.runs[0].nodes[0].provenance.percent.kind, 'unknown');
  assert.equal(snapshot.runs[0].provenance.percent.kind, 'unknown');
});

test('explicit entity provenance survives normalization', () => {
  const snapshot = normalizeSnapshot({
    version: 3, mode: 'live', connected: true,
    runs: [{ id: 'r', status: 'running', nodes: [{
      id: 'n', state: 'running',
      provenance: { percent: { kind: 'recorded', from: 'custom' } },
    }], edges: [] }],
    tasks: [{ id: 'st_a', status: 'running', provenance: { agent: { kind: 'derived', from: 'agent_type' } } }],
  });
  assert.equal(snapshot.runs[0].nodes[0].provenance.percent.kind, 'recorded');
  assert.equal(snapshot.runs[0].nodes[0].provenance.percent.from, 'custom');
  assert.equal(snapshot.tasks[0].provenance.agent.kind, 'derived');
  assert.equal(snapshot.tasks[0].provenance.agent.from, 'agent_type');
});

test('category-only checkpoint nodes expose the category as derived agent provenance', () => {
  const routeRun = normalizeSnapshot({
    version: 3, mode: 'live', connected: true,
    runs: [{ id: 'r', status: 'running', nodes: [
      { id: 'route', state: 'running', route: { kind: 'category', category: 'quick' } },
    ], edges: [] }],
    tasks: [],
  });
  const routed = routeRun.runs[0].nodes[0];
  assert.equal(routed.agent, undefined);
  assert.equal(routed.category, 'quick');
  assert.equal(routed.provenance.agent.kind, 'derived');
  assert.equal(routed.provenance.agent.from, 'category');

  const taskRun = normalizeSnapshot({
    version: 3, mode: 'live', connected: true,
    runs: [{ id: 'r', status: 'running', nodes: [
      { id: 'task', state: 'running', taskId: 'st_category' },
    ], edges: [] }],
    tasks: [{ id: 'st_category', status: 'running', category: 'deep-low' }],
  });
  const linked = taskRun.runs[0].nodes[0];
  assert.equal(linked.category, 'deep-low');
  assert.equal(linked.provenance.agent.kind, 'derived');
  assert.equal(linked.provenance.agent.from, 'category');
});

test('a stale unavailable agent marker yields to a linked task category', () => {
  const normalized = normalizeSnapshot({
    version: 3, mode: 'live', connected: true,
    runs: [{ id: 'r', status: 'running', nodes: [{
      id: 'plan', state: 'completed', taskId: 'st_plan',
      provenance: { agent: { kind: 'unavailable' } },
    }], edges: [] }],
    tasks: [{ id: 'st_plan', status: 'completed', category: 'deep-low' }],
  });
  const reparsed = normalizeSnapshot(normalized);
  for (const snapshot of [normalized, reparsed]) {
    const node = snapshot.runs[0].nodes[0];
    assert.equal(node.category, 'deep-low');
    assert.equal(node.provenance.agent.kind, 'derived');
    assert.equal(node.provenance.agent.from, 'category');
  }

  const bare = normalizeSnapshot({
    version: 3, mode: 'live', connected: true,
    runs: [{ id: 'r', status: 'running', nodes: [{
      id: 'bare', state: 'running',
      provenance: { agent: { kind: 'unavailable' } },
    }], edges: [] }],
    tasks: [],
  });
  assert.equal(bare.runs[0].nodes[0].provenance.agent.kind, 'unavailable');
});

test('agent_type tasks provide the agent their provenance advertises', () => {
  const task = normalizeTask({ id: 'st_agent_type', status: 'running', agent_type: 'quick' });
  assert.equal(task.agent, 'quick');
  assert.equal(task.provenance.agent.kind, 'derived');
  assert.equal(task.provenance.agent.from, 'agent_type');

  const recorded = normalizeTask({ id: 'st_agent', status: 'running', agent: 'main', agent_type: 'quick' });
  assert.equal(recorded.agent, 'main');
  assert.equal(recorded.provenance.agent.kind, 'recorded');

  const snapshot = normalizeSnapshot({
    version: 3, mode: 'live', connected: true,
    runs: [{ id: 'r', status: 'running', nodes: [{ id: 'n', state: 'running', taskId: 'st_agent_type' }], edges: [] }],
    tasks: [{ id: 'st_agent_type', status: 'running', agent_type: 'quick' }],
  });
  const node = snapshot.runs[0].nodes[0];
  assert.equal(node.agent, 'quick');
  assert.equal(node.provenance.agent.kind, 'derived');
  assert.equal(node.provenance.agent.from, 'agent_type');
});

test('legacy reply truncation is explicit without producer byte metadata', () => {
  const task = normalizeTask({ id: 'st_reply_cut', status: 'completed', reply: 'x'.repeat(2000) });
  assert.equal(task.reply.length, 1200);
  assert.equal('replyBytes' in task, false);
  assert.equal(task.replyTruncated, true);
  assert.equal(task.provenance.reply.truncated, true);

  const short = normalizeTask({ id: 'st_reply_short', status: 'completed', reply: 'short reply' });
  assert.equal('replyTruncated' in short, false);

  const excerpt = normalizeTask({ id: 'st_reply_excerpt', status: 'completed', reply: 'excerpt', replyBytes: 5000 });
  assert.equal(excerpt.replyTruncated, true);
});

test('unknown task statuses stay explicit instead of queuing as pending', () => {
  const task = normalizeTask({ id: 'st_status', status: 'succeeded', progress: 'done' });
  assert.equal(task.status, 'unknown');
  assert.equal(task.progress, 'done');
  assert.equal(task.provenance.state.kind, 'derived');

  const parent = normalizeTask({
    id: 'st_parent', status: 'running',
    children: [{ id: 'st_child', status: 'succeeded' }],
  });
  assert.equal(parent.children[0].status, 'unknown');

  const snapshot = normalizeSnapshot({
    version: 3, mode: 'live', connected: true, runs: [],
    tasks: [{ id: 'st_status', status: 'timeout' }, { id: 'st_pending', status: 'pending' }],
  });
  assert.equal(snapshot.tasks[0].status, 'unknown');
  assert.equal(snapshot.tasks[1].status, 'pending');
});

test('a run drops malformed nodes and edges but keeps valid work with warnings', () => {
  const run = normalizeRun({
    id: 'partial', createdAt: '2026-11-10T00:00:00Z',
    nodes: [
      { id: 'ok', state: 'completed' },
      { id: 'bad', state: 'succeeded' },
      { id: 'ok', state: 'running' },
      { state: 'completed' },
      { id: 'self', state: 'pending' },
    ],
    edges: [
      { from: 'ok', to: 'self' },
      { from: 'ok', to: 'bad' },
      { from: 'self', to: 'self' },
    ],
  });
  assert.deepEqual(run.nodes.map(node => node.id), ['ok', 'self']);
  assert.deepEqual(run.edges, [{ from: 'ok', to: 'self' }]);
  assert.equal(run.warningCount, 5);
  assert.deepEqual(run.warnings.map(warning => warning.reason),
    ['unknown-state', 'duplicate-id', 'missing-id', 'unknown-node', 'self-edge']);
  assert.equal(run.warnings[0].state, 'succeeded');
  assert.equal(run.status, 'pending');

  const snapshot = normalizeSnapshot({
    version: 3, mode: 'live', connected: true,
    runs: [{
      id: 'r', status: 'completed',
      nodes: [{ id: 'only', state: 'completed' }, { id: 'bad', state: 'bogus' }], edges: [],
    }],
    tasks: [],
  });
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0].nodes.length, 1);
  assert.equal(snapshot.runs[0].warningCount, 1);
});

test('interrupted work does not derive a completed run status', () => {
  assert.equal(deriveRunStatus([{ state: 'interrupted' }]), 'interrupted');
  assert.equal(deriveRunStatus([{ state: 'interrupted' }, { state: 'completed' }]), 'interrupted');
  assert.equal(deriveRunStatus([{ state: 'completed' }, { state: 'skipped' }]), 'completed');
  assert.equal(deriveRunStatus([{ state: 'cancelled' }, { state: 'skipped' }]), 'cancelled');
  assert.equal(deriveRunStatus([{ state: 'completed' }, { state: 'cancelled' }]), 'cancelled');
  assert.equal(deriveRunStatus([{ state: 'interrupted' }, { state: 'running' }]), 'running');
  assert.equal(deriveRunStatus([]), 'pending');

  const run = normalizeRun({ id: 'r', nodes: [{ id: 'n', state: 'interrupted' }], edges: [] });
  assert.equal(run.status, 'interrupted');
  assert.equal(run.provenance.state.from, 'nodes');
});

test('saved captures do not invent a generatedAt from the viewer clock', () => {
  const saved = normalizeSnapshot({
    version: 3, mode: 'saved', connected: true, runs: [],
    tasks: [{ id: 'st_running', status: 'running', startedAt: '2026-11-01T00:00:00.000Z' }],
  });
  assert.equal(saved.generatedAt, undefined);
  const task = saved.tasks[0];
  const later = Date.parse('2026-11-10T00:00:00.000Z');
  assert.equal(elapsedMs(task, { now: later, connected: saved.connected, updatedAt: saved.generatedAt }), null);
  assert.equal(elapsedLabel(task, { now: later, connected: saved.connected, updatedAt: saved.generatedAt }), '—');

  const captured = normalizeSnapshot({
    version: 3, mode: 'saved', connected: true,
    provenance: { capturedAt: '2026-11-02T00:00:00.000Z' }, runs: [],
    tasks: [{ id: 'st_captured', status: 'running', startedAt: '2026-11-01T00:00:00.000Z' }],
  });
  assert.equal(captured.generatedAt, '2026-11-02T00:00:00.000Z');
  assert.equal(elapsedMs(captured.tasks[0], { connected: false, updatedAt: captured.generatedAt }), 86_400_000);

  const live = normalizeSnapshot({ version: 3, mode: 'live', connected: true, runs: [] });
  assert.ok(Number.isFinite(Date.parse(live.generatedAt)));
});

test('bounded text and replies never split a grapheme', () => {
  const task = normalizeTask({
    id: 'st_unicode', status: 'completed',
    description: `${'a'.repeat(239)}😀z`,
    thinking: `${'b'.repeat(1199)}😀z`,
    reply: `${'c'.repeat(1199)}😀z`,
  });
  assert.equal(task.description, 'a'.repeat(239));
  assert.equal(task.thinking, 'b'.repeat(1199));
  assert.equal(task.reply, 'c'.repeat(1199));
  assert.equal(task.replyTruncated, true);

  const cluster = normalizeTask({
    id: 'st_cluster', status: 'completed',
    description: `${'x'.repeat(239)}e\u0301z`,
  });
  assert.equal(cluster.description, 'x'.repeat(239));
  for (const value of [task.description, task.thinking, task.reply, cluster.description]) {
    assert.doesNotMatch(value, /\p{Cs}/u);
  }
});

test('nodes without an attempt field report the first attempt', () => {
  const run = normalizeRun({
    id: 'attempts',
    nodes: [
      { id: 'missing', state: 'failed' },
      { id: 'zero', state: 'failed', attempt: 0 },
      { id: 'third', state: 'failed', attempt: 3 },
    ],
    edges: [],
  });
  assert.deepEqual(run.nodes.map(node => node.attempt), [1, 0, 3]);
});

test('a boolean legacy demo flag cannot be trusted as recorded data', () => {
  const legacy = normalizeSnapshot({
    version: 2, connected: true, demo: true, runs: [],
    tasks: [{ id: 'st_legacy_demo', status: 'running', percent: 10 }],
  });
  assert.equal(legacy.mode, 'live');
  assert.equal(legacy.provenance.origin, 'legacy-snapshot');
  assert.equal(legacy.tasks[0].provenance.percent.kind, 'unknown');

  const objectDemo = normalizeSnapshot({
    version: 3, connected: true, demo: { cycle: 1 }, runs: [],
    tasks: [{ id: 'st_demo', status: 'running', percent: 10 }],
  });
  assert.equal(objectDemo.mode, 'demo');
  assert.equal(objectDemo.tasks[0].provenance.percent.kind, 'simulated');

  const live = normalizeSnapshot({
    version: 3, mode: 'live', connected: true, runs: [],
    tasks: [{ id: 'st_live', status: 'running', percent: 10 }],
  });
  assert.equal(live.tasks[0].provenance.percent.kind, 'recorded');
});

test('F-42 task and node turn counts fall back to live progress and run_stats', () => {
  const live = normalizeTask({
    id: 'st_turns_live', status: 'running', live_progress: { turns: 4, tool_calls: 6 },
  });
  assert.equal(live.turns, 4);
  assert.equal(live.toolCalls, 6);

  const stats = normalizeTask({
    id: 'st_turns_stats', status: 'completed', run_stats: { turns: 9, tool_calls: 3 },
  });
  assert.equal(stats.turns, 9);
  assert.equal(stats.toolCalls, 3);

  const explicit = normalizeTask({
    id: 'st_turns_explicit', status: 'running', turns: 7, toolCalls: 8,
    live_progress: { turns: 4, tool_calls: 6 }, run_stats: { turns: 9, tool_calls: 3 },
  });
  assert.equal(explicit.turns, 7);
  assert.equal(explicit.toolCalls, 8);

  const node = normalizeRun({
    id: 'turns-run', status: 'running',
    nodes: [{ id: 'live', state: 'running', live_progress: { turns: 2, tool_calls: 5 } }],
    edges: [],
  }).nodes[0];
  assert.equal(node.turns, 2);
  assert.equal(node.toolCalls, 5);

  const linked = normalizeSnapshot({
    sessionId: 's', runs: [{
      id: 'linked-run', status: 'running',
      nodes: [{ id: 'node', state: 'running', taskId: 'st_task_stats' }], edges: [],
    }],
    tasks: [{ id: 'st_task_stats', status: 'running', run_stats: { turns: 11, tool_calls: 12 } }],
  }).runs[0].nodes[0];
  assert.equal(linked.turns, 11);
  assert.equal(linked.toolCalls, 12);
});

test('F-52 standalone tasks use the canonical navigation comparator', () => {
  const tasks = [
    { id: 'st_b', status: 'pending', description: 'alpha' },
    { id: 'st_a', status: 'pending', description: 'alpha' },
    { id: 'st_r', status: 'running', description: 'zeta' },
    { id: 'st_missing', status: 'pending' },
  ];
  const expected = ['st_r', 'st_a', 'st_b', 'st_missing'];
  assert.deepEqual([...tasks].sort(compareNavigationTasks).map(task => task.id), expected);

  const snapshot = normalizeSnapshot({ sessionId: 's', runs: [], tasks });
  assert.deepEqual(standaloneTasks(snapshot).map(task => task.id), expected);
});

test('run ordering and empty-run statistics are stable', () => {
  const runs = [
    { id: 'completed', status: 'completed', createdAt: '2026-11-10T03:00:00Z', nodes: [] },
    { id: 'failed', status: 'failed', createdAt: '2026-11-10T02:00:00Z', nodes: [] },
    { id: 'active', status: 'running', createdAt: '2026-11-10T01:00:00Z', nodes: [] },
  ];
  assert.deepEqual(orderRuns(runs).map(run => run.id), ['active', 'failed', 'completed']);

  const stats = runStats({ nodes: [] });
  assert.equal(stats.total, 0);
  assert.equal(stats.percent, undefined);
  assert.equal(stats.percentKnown, false);
  assert.equal(stats.done, 0);
  assert.deepEqual(stats.counts, {
    running: 0, completed: 0, failed: 0, blocked: 0, paused: 0, pending: 0, scheduled: 0, cancelled: 0, skipped: 0,
  });
});
