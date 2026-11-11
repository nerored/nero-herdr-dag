import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DagPane, dagTitle, isDagViewerPane, MAX_CHECKPOINT_BYTES } from '../src/controller.mjs';
import { DemoEngine } from '../src/demo.mjs';
import { nodeForTask, normalizeSnapshot } from '../src/model.mjs';
import { readJson, writeJson } from '../src/storage.mjs';

const raw = new DemoEngine({ now: 1_000_000, startOffset: 32_000 }).snapshot(1_000_000);
const run = raw.runs[0];

function fixture(herdrImpl) {
  const calls = [];
  const panes = new Map([['parent', { pane_id: 'parent', tab_id: 't1', label: 'OmO' }]]);
  const herdr = herdrImpl ?? (async (...args) => {
    calls.push(args);
    if (args[0] === 'split') {
      const pane = { pane_id: 'viewer', tab_id: 't1', label: dagTitle('session-1') };
      panes.set(pane.pane_id, pane);
      return { pane };
    }
    if (args[0] === 'list') return { panes: [...panes.values()] };
    if (args[0] === 'get') return { pane: panes.get(args[1]) };
    return {};
  });
  return { calls, panes, herdr };
}

async function setup(t, herdr, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dag-studio-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const controller = new DagPane({
    sessionId: 'session-1', parentPane: 'parent', socket: '/tmp/herdr.sock', stateDir,
    cwd: stateDir, node: '/usr/bin/node', viewer: '/tmp/viewer.mjs', herdr,
    ...options,
  });
  t.after(() => controller.stop());
  return { stateDir, controller };
}

test('receiving a run writes a v3 snapshot and creates exactly one viewer pane', async t => {
  const mock = fixture();
  const { stateDir, controller } = await setup(t, mock.herdr);
  const payload = { parent_session_id: 'session-1', runs: [run] };
  await controller.receive(payload);
  const state = await readJson(controller.stateFile);
  assert.equal(state.version, 3);
  assert.equal(state.connected, true);
  assert.equal(state.mode, 'live');
  assert.equal(state.runs[0].id, run.id);
  assert.equal(mock.calls.filter(call => call[0] === 'split').length, 1);
  const split = mock.calls.find(call => call[0] === 'split');
  assert.equal(Number(split[split.indexOf('--ratio') + 1]).toFixed(6), '0.666667');
  assert.ok(split.includes('--no-focus'));
  const launch = mock.calls.find(call => call[0] === 'run');
  assert.ok(launch);
  assert.match(String(launch[2]), /--pane/);
  await controller.receive(payload);
  assert.equal(mock.calls.filter(call => call[0] === 'split').length, 1);
  await controller.stop();
  const stopped = await readJson(controller.stateFile);
  assert.equal(stopped.connected, false);
  assert.equal(stopped.mode, 'saved');
});

test('a failed split is retried by the next event', async t => {
  const calls = [];
  const panes = new Map([['parent', { pane_id: 'parent', tab_id: 't1', label: 'OmO' }]]);
  let splitCalls = 0;
  const herdr = async (...args) => {
    calls.push(args);
    if (args[0] === 'split') {
      splitCalls++;
      if (splitCalls === 1) throw new Error('socket timeout');
      const pane = { pane_id: 'viewer', tab_id: 't1', label: dagTitle('session-1') };
      panes.set(pane.pane_id, pane);
      return { pane };
    }
    if (args[0] === 'list') return { panes: [...panes.values()] };
    if (args[0] === 'get') return { pane: panes.get(args[1]) };
    return {};
  };
  const messages = [];
  const stateDir = await mkdtemp(join(tmpdir(), 'dag-studio-fail-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const controller = new DagPane({
    sessionId: 'session-1', parentPane: 'parent', socket: '/tmp/herdr.sock', stateDir,
    cwd: stateDir, node: '/usr/bin/node', viewer: '/tmp/viewer.mjs', herdr,
    notify: message => messages.push(message),
  });
  t.after(() => controller.stop());
  const payload = { parent_session_id: 'session-1', runs: [run] };
  await assert.rejects(controller.receive(payload), /timeout/);
  assert.equal(splitCalls, 1);
  assert.equal(messages.length, 1);
  assert.deepEqual(await readJson(controller.recordFile), { attempted: true });

  await controller.receive(payload);
  assert.equal(splitCalls, 2);
  const record = await readJson(controller.recordFile);
  assert.equal(record.paneId, 'viewer');
  assert.equal(record.ready, true);
});

test('an unready pane record is not treated as live', async t => {
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr);
  mock.panes.set('stale', { pane_id: 'stale', tab_id: 't1', label: 'OmO' });
  await writeJson(controller.recordFile, { paneId: 'stale', ready: false });
  const paneId = await controller.ensure(false);
  assert.equal(paneId, 'viewer');
  assert.ok(mock.calls.some(call => call[0] === 'get' && call[1] === 'stale'));
  assert.ok(mock.calls.some(call => call[0] === 'close' && call[1] === 'stale'));
  assert.equal(mock.calls.filter(call => call[0] === 'split').length, 1);
});

test('explicit open reuses a live recorded pane and closes duplicate DAG panes', async t => {
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr);
  await controller.receive({ parent_session_id: 'session-1', runs: [run] });
  mock.panes.set('duplicate', { pane_id: 'duplicate', tab_id: 't1', label: 'DAG Studio · duplicate' });
  await controller.open();
  assert.equal(mock.calls.filter(call => call[0] === 'split').length, 1);
  assert.ok(mock.calls.some(call => call[0] === 'close' && call[1] === 'duplicate'));
});

test('terminal tasks keep the persisted reply and discard stale stream tails', async t => {
  const mock = fixture();
  const { stateDir, controller } = await setup(t, mock.herdr);
  for (const status of ['completed', 'failed', 'skipped']) {
    controller.outputs.set(`st_${status}`, { reply: 'stream tail', thinking: 'stream thinking' });
    const task = controller.withStreams([{
      id: `st_${status}`, status, reply: 'persisted final response', thinking: 'persisted thinking',
    }], true)[0];
    assert.equal(task.reply, 'persisted final response');
    assert.equal(task.thinking, 'persisted thinking');
    assert.equal(controller.outputs.has(`st_${status}`), false);
  }
  controller.taskData.merge({
    task_id: 'st_done', parent_session_id: 'session-1', status: 'completed',
    final_response: 'persisted final response', thinking: 'persisted thinking',
  });
  controller.outputs.set('st_done', { reply: 'stream tail' });
  await controller.save(false);
  const state = await readJson(join(stateDir, `${controller.key}.json`));
  assert.equal(state.tasks[0].reply, 'persisted final response');
  assert.equal(state.tasks[0].thinking, 'persisted thinking');
});

test('stop saves streamed excerpts before clearing live state', async t => {
  const mock = fixture();
  const { stateDir, controller } = await setup(t, mock.herdr);
  controller.taskData.merge({ task_id: 'st_live', parent_session_id: 'session-1', status: 'running' });
  controller.taskData.merge({
    task_id: 'st_done', parent_session_id: 'session-1', status: 'completed',
    final_response: 'persisted final response',
  });
  await controller.receiveStream({ taskId: 'st_live', active: true, phase: 'text', text: 'live response', now: 1000 });
  controller.outputs.set('st_done', { reply: 'stream tail' });
  await controller.stop();
  const state = await readJson(join(stateDir, `${controller.key}.json`));
  assert.equal(state.connected, false);
  assert.equal(state.tasks.find(task => task.id === 'st_live').reply, 'live response');
  assert.equal(state.tasks.find(task => task.id === 'st_done').reply, 'persisted final response');
  assert.equal(controller.outputs.size, 0);
  assert.equal(controller.streams.size, 0);
});

test('terminal task evidence survives save while stale stream metadata is dropped', async t => {
  const mock = fixture();
  const { stateDir, controller } = await setup(t, mock.herdr);
  controller.taskData.merge({
    task_id: 'st_evidence', parent_session_id: 'session-1', status: 'completed',
    final_response: 'x'.repeat(3373), error_message: 'upstream failed', failure_kind: 'provider_error',
    run_stats: {
      turns: 108, failed_turns: 4, tool_calls: 144,
      input_tokens: 461012, output_tokens: 86887,
      cache_read_tokens: 22320128, cache_write_tokens: 1024, total_tokens: 22868027,
      tokens_per_second: 208, cost_usd: 0.188244384,
      cache_hit_rate_last: 0.9983720787227777, cache_hit_rate_run: 0.9797634358947797,
      cost_status: 'reported',
    },
  });
  controller.outputs.set('st_evidence', { reply: 'stale stream tail' });
  await controller.save(false);
  const state = await readJson(join(stateDir, `${controller.key}.json`));
  assert.equal(state.version, 3);
  const task = state.tasks.find(candidate => candidate.id === 'st_evidence');
  assert.equal(task.reply.length, 1200);
  assert.equal(task.replyBytes, 3373);
  assert.equal(task.replyTruncated, true);
  assert.equal(task.replySource, 'final_response');
  assert.equal(task.failedTurns, 4);
  assert.equal(task.retries, 4);
  assert.equal(task.retriesSource, 'run_stats.failed_turns');
  assert.equal(task.cacheReadTokens, 22320128);
  assert.equal(task.cacheWriteTokens, 1024);
  assert.equal(task.totalTokens, 22868027);
  assert.equal(task.costUsd, 0.188244384);
  assert.equal(task.cacheHitRate, 0.9797634358947797);
  assert.equal(task.cacheHitRateLast, 0.9983720787227777);
  assert.equal(task.costStatus, 'reported');
  assert.deepEqual(task.tokenRate, [208]);
  assert.equal(task.tokenRateKind, 'instant');
  assert.equal(task.error, 'upstream failed');
  assert.equal(task.errorSource, 'error_message');
  assert.equal(task.errorKind, 'provider_error');
});

test('a live stream tail drops stale persisted reply metadata', async t => {
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr);
  const task = {
    id: 'st_running', status: 'running', reply: 'persisted excerpt',
    replyBytes: 3373, replyTruncated: true, replySource: 'final_response',
  };
  controller.outputs.set('st_running', { reply: 'live tail' });
  controller.streams.set('st_running', { phase: 'text', since: 1000, lastAt: 1000 });
  const result = controller.withStreams([task], true)[0];
  assert.equal(result.reply, 'live tail');
  assert.equal('replyBytes' in result, false);
  assert.equal('replyTruncated' in result, false);
  assert.equal(result.replySource, 'live_stream');
});

test('stop persists evidence from a running task before clearing live state', async t => {
  const mock = fixture();
  const { stateDir, controller } = await setup(t, mock.herdr);
  controller.taskData.merge({
    task_id: 'st_evidence_live', parent_session_id: 'session-1', status: 'running',
    final_response: 'x'.repeat(1500),
    run_stats: {
      turns: 5, failed_turns: 2, cache_read_tokens: 10, cache_write_tokens: 11,
      total_tokens: 21, cost_usd: 0.002, cache_hit_rate_run: 0.5, tokens_per_second: 100,
    },
  });
  await controller.stop();
  const state = await readJson(join(stateDir, `${controller.key}.json`));
  assert.equal(state.connected, false);
  const task = state.tasks.find(candidate => candidate.id === 'st_evidence_live');
  assert.equal(task.reply.length, 1200);
  assert.equal(task.replyBytes, 1500);
  assert.equal(task.replyTruncated, true);
  assert.equal(task.failedTurns, 2);
  assert.equal(task.retries, 2);
  assert.equal(task.retriesSource, 'run_stats.failed_turns');
  assert.equal(task.cacheReadTokens, 10);
  assert.equal(task.cacheWriteTokens, 11);
  assert.equal(task.totalTokens, 21);
  assert.equal(task.costUsd, 0.002);
  assert.equal(task.cacheHitRate, 0.5);
  assert.equal(task.tokenRateKind, 'instant');
});

test('a live task event writes running metrics into the state file before terminal', async t => {
  const mock = fixture();
  const stateDir = await mkdtemp(join(tmpdir(), 'dag-live-state-'));
  const repo = await mkdtemp(join(tmpdir(), 'dag-live-store-'));
  t.after(() => Promise.all([
    rm(stateDir, { recursive: true, force: true }),
    rm(repo, { recursive: true, force: true }),
  ]));
  const updatedAt = '2026-11-10T08:33:33.772Z';
  await seedStore(repo, { tasks: { st_live_state: {
    task_id: 'st_live_state', parent_session_id: 'session-1', description: 'disk record',
    status: 'running', updated_at: updatedAt, task_seq: 5,
  } } });
  const controller = new DagPane({
    sessionId: 'session-1', parentPane: 'parent', socket: '/tmp/herdr.sock', stateDir,
    cwd: stateDir, node: '/usr/bin/node', viewer: '/tmp/viewer.mjs', herdr: mock.herdr,
    taskStateDirs: [{ root: repo, origin: 'in-project', label: 'repo store' }],
  });
  t.after(() => controller.stop());

  await controller.receiveTasks(liveTaskPayload('st_live_state', { updatedAt }));
  const state = await readJson(controller.stateFile);
  let task = state.tasks.find(candidate => candidate.id === 'st_live_state');
  assert.equal(task.status, 'running');
  assert.equal(task.tokensIn, 6789);
  assert.equal(task.tokensOut, 2345);
  assert.equal(task.turns, 2);
  assert.equal(task.toolCalls, 5);
  assert.deepEqual(task.tokenRate, [211]);
  assert.equal(task.progress, '[eval] sampling the snapshot');
  assert.equal(task.source, controller.taskStateDirs[0].id);

  await controller.receiveTasks(liveTaskPayload('st_live_state', {
    updatedAt,
    stats: { turns: 3, tool_calls: 6, input_tokens: 7000, output_tokens: 2500, total_tokens: 132000, tokens_per_second: 220 },
    progress: { turns: 3, tool_calls: 6, total_tokens: 132000, output_tokens: 2500, tokens_per_second: 220, last_assistant_line: 'second coalesced event' },
  }));
  task = (await readJson(controller.stateFile)).tasks.find(candidate => candidate.id === 'st_live_state');
  assert.equal(task.tokensIn, 7000);
  assert.equal(task.tokensOut, 2500);
  assert.equal(task.turns, 3);
  assert.equal(task.toolCalls, 6);
  assert.deepEqual(task.tokenRate, [211, 220]);
  assert.equal(task.progress, '[eval] second coalesced event');
  assert.equal(task.source, controller.taskStateDirs[0].id);
});

test('a restored old v2 snapshot saves without inventing evidence values', async t => {
  const mock = fixture();
  const { stateDir, controller } = await setup(t, mock.herdr);
  await writeJson(controller.stateFile, {
    version: 2, sessionId: 'session-1', connected: true, updatedAt: '2026-11-10T00:00:00.000Z',
    sources: [], runs: [],
    tasks: [{ id: 'st_legacy', description: 'legacy', status: 'completed', reply: 'older excerpt' }],
  });
  await controller.start();
  const state = await readJson(join(stateDir, `${controller.key}.json`));
  const task = state.tasks.find(candidate => candidate.id === 'st_legacy');
  assert.equal(task.reply, 'older excerpt');
  assert.equal('replyBytes' in task, false);
  assert.equal('replyTruncated' in task, false);
  assert.equal('failedTurns' in task, false);
  assert.equal('retries' in task, false);
  assert.equal('cacheReadTokens' in task, false);
  assert.equal('tokenRateKind' in task, false);
});

test('checkpoint node evidence survives restore, save, and snapshot normalization', async t => {
  const mock = fixture();
  const { stateDir, controller } = await setup(t, mock.herdr);
  await mkdir(controller.checkpointDir, { recursive: true });
  await writeJson(join(controller.checkpointDir, 'evidence.json'), checkpointRun({
    id: 'evidence-run', status: 'completed',
    nodes: [{
      id: 'n1', label: 'implement', state: 'completed',
      output: 'line 1\nline 2\nline 3', outputBytes: 2000,
      runStats: {
        failed_turns: 2, cache_read_tokens: 50, total_tokens: 60, cost_usd: 0.01,
        cache_hit_rate_run: 0.8, tokens_per_second: 100,
      },
      resultArtifact: {
        relativePath: 'dag/results/evidence-run/implement.txt', sha256: 'abc', bytes: 2000,
        stats: { relativePath: 'dag/results/evidence-run/implement.stats.json', bytes: 10 },
      },
    }],
  }));
  await controller.restoreRuns();
  await controller.save(false);
  const state = await readJson(join(stateDir, `${controller.key}.json`));
  const node = state.runs.find(run => run.id === 'evidence-run').nodes[0];
  assert.equal(node.retries, 2);
  assert.equal(node.retriesSource, 'run_stats.failed_turns');
  assert.equal(node.cacheReadTokens, 50);
  assert.equal(node.totalTokens, 60);
  assert.equal(node.costUsd, 0.01);
  assert.deepEqual(node.recentEvents, ['line 1', 'line 2', 'line 3']);
  assert.equal(node.outputBytes, 2000);
  assert.equal(node.outputTruncated, true);
  assert.equal(node.artifact.relativePath, 'dag/results/evidence-run/implement.txt');
  assert.equal(node.artifact.bytes, 2000);
  assert.equal(node.artifact.statsBytes, 10);

  const snapshot = normalizeSnapshot(state);
  const normalized = snapshot.runs.find(run => run.id === 'evidence-run').nodes[0];
  assert.equal(normalized.retries, 2);
  assert.equal(normalized.cacheReadTokens, 50);
  assert.deepEqual(normalized.recentEvents, ['line 1', 'line 2', 'line 3']);
  assert.equal(normalized.artifact.bytes, 2000);
});

function checkpointRun(overrides = {}) {
  return {
    schemaVersion: 1,
    parentSessionId: 'session-1',
    id: 'shared-run',
    name: 'Shared run',
    status: 'running',
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T01:00:00.000Z',
    nodes: [{ id: 'n1', label: 'node', state: 'running' }],
    edges: [],
    ...overrides,
  };
}

test('checkpoint restore keeps the newer checkpoint and a live newer run', async t => {
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr);
  await mkdir(controller.checkpointDir, { recursive: true });
  const live = {
    id: 'shared-run', name: 'Shared run', status: 'completed',
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T10:00:00.000Z',
    nodes: [{ id: 'n1', label: 'node', state: 'completed', percent: 100 }], edges: [],
  };
  controller.runs = [live];
  await writeJson(join(controller.checkpointDir, 'old.json'), checkpointRun());
  await controller.restoreRuns();
  assert.equal(controller.runs[0].status, 'completed');
  assert.equal(controller.runs[0].updatedAt, live.updatedAt);

  await writeJson(join(controller.checkpointDir, 'new.json'), checkpointRun({
    updatedAt: '2026-11-10T11:00:00.000Z',
    status: 'failed',
    nodes: [{ id: 'n1', label: 'node', state: 'failed' }],
  }));
  await controller.restoreRuns();
  assert.equal(controller.runs[0].status, 'failed');
  assert.equal(controller.runs[0].updatedAt, '2026-11-10T11:00:00.000Z');
});

test('checkpoint sequence breaks updatedAt ties', async t => {
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr);
  await mkdir(controller.checkpointDir, { recursive: true });
  const live = {
    id: 'shared-run', name: 'Shared run', status: 'completed', checkpointSeq: 1,
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T10:00:00.000Z',
    nodes: [{ id: 'n1', label: 'node', state: 'completed', percent: 100 }], edges: [],
  };
  controller.runs = [live];
  await writeJson(join(controller.checkpointDir, 'same-time.json'), checkpointRun({
    updatedAt: live.updatedAt,
    checkpointSeq: 2,
    status: 'failed',
    nodes: [{ id: 'n1', label: 'node', state: 'failed' }],
  }));
  await controller.restoreRuns();
  assert.equal(controller.runs[0].status, 'failed');
  assert.equal(controller.runs[0].checkpointSeq, 2);
});

test('checkpoint scanning rejects symlinked and oversized records before reading', async t => {
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr);
  const messages = [];
  controller.notify = message => messages.push(message);
  await mkdir(controller.checkpointDir, { recursive: true });
  const outside = await mkdtemp(join(tmpdir(), 'dag-checkpoint-target-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const target = join(outside, 'target.json');
  await writeJson(target, checkpointRun({ id: 'symlink-run' }));
  await symlink(target, join(controller.checkpointDir, 'linked.json'));
  const oversized = JSON.stringify(checkpointRun({ id: 'oversized-run' })) +
    ' '.repeat(MAX_CHECKPOINT_BYTES + 1);
  await writeFile(join(controller.checkpointDir, 'oversized.json'), oversized);
  await writeJson(join(controller.checkpointDir, 'ok.json'), checkpointRun({ id: 'ok-run' }));

  await controller.restoreRuns();

  assert.deepEqual(controller.runs.map(run => run.id), ['ok-run']);
  const source = controller.taskStateDirs[0].id;
  assert.deepEqual(controller.runSources.get(source).runs, { files: 3, accepted: 1, foreign: 0, invalid: 2 });
  assert.ok(messages.some(message => message.includes('linked.json') && message.includes('symlink')));
  assert.ok(messages.some(message => message.includes('oversized.json') && message.includes('bytes')));
});

test('stream thinking and reply become task excerpts', async t => {
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr);
  await controller.receiveStream({
    taskId: 'st_live', active: true, phase: 'thinking',
    text: `checking the edge case${String.fromCharCode(27)}[31m`, now: 1000,
  });
  await controller.receiveStream({
    taskId: 'st_live', active: true, phase: 'text', text: 'the edge case is covered', now: 1100,
  });
  const task = controller.withStreams([{ id: 'st_live', status: 'running' }], true)[0];
  assert.equal(task.thinking, 'checking the edge case');
  assert.ok(!task.thinking.includes(String.fromCharCode(27)));
  assert.equal(task.reply, 'the edge case is covered');
  assert.equal(task.activity.phase, 'text');
});

test('pane titles and foreign session payloads are isolated', async t => {
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr);
  assert.equal(isDagViewerPane({ label: 'DAG Studio · abc' }), true);
  assert.equal(isDagViewerPane({ terminal_title: 'OmO DAG' }), true);
  assert.equal(isDagViewerPane({ label: 'OmO' }), false);
  await controller.receive({ parent_session_id: 'other', runs: [run] });
  assert.equal(mock.calls.length, 0);
});

function checkpoint(id, taskIds, overrides = {}) {
  return {
    schemaVersion: 1,
    parentSessionId: 'session-1',
    id,
    name: id,
    status: 'completed',
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T01:00:00.000Z',
    checkpointSeq: 1,
    nodes: taskIds.map((taskId, index) => ({ id: `${id}-n${index}`, label: taskId, state: 'completed', taskId })),
    edges: [],
    ...overrides,
  };
}

function taskRecord(id, overrides = {}) {
  return {
    task_id: id,
    parent_session_id: 'session-1',
    description: id,
    status: 'completed',
    updated_at: '2026-11-10T00:00:00.000Z',
    ...overrides,
  };
}

// Shape emitted by omo-task.js f(): C3(e, true) omits task_seq while
// attaching the live run-stats snapshot and live_progress.
function liveTaskPayload(id, { updatedAt, stats = {}, progress = {} }) {
  return {
    parent_session_id: 'session-1',
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

function chunks(items, count) {
  const size = Math.ceil(items.length / count);
  return Array.from({ length: count }, (_, index) => items.slice(index * size, (index + 1) * size)).filter(chunk => chunk.length);
}

async function seedStore(root, { tasks = {}, runs = {} }) {
  for (const [id, raw] of Object.entries(tasks)) await writeJson(join(root, 'tasks', `${id}.json`), raw);
  for (const [name, raw] of Object.entries(runs)) await writeJson(join(root, 'dag', 'runs', name), raw);
}

async function multiStore(t) {
  const base = await mkdtemp(join(tmpdir(), 'dag-multi-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, 'repo-store');
  const host = join(base, 'host-store');
  const stateDir = join(base, 'state');
  const repoTaskIds = Array.from({ length: 12 }, (_, index) => `st_repo${index}`);
  const hostTaskIds = Array.from({ length: 38 }, (_, index) => `st_host${index}`);
  const repoRuns = Object.fromEntries(chunks(repoTaskIds, 3).map((ids, index) =>
    [`repo-${index}.json`, checkpoint(`dag_repo${index}`, ids)]));
  const hostRuns = Object.fromEntries(chunks(hostTaskIds, 10).map((ids, index) =>
    [`host-${index}.json`, checkpoint(`dag_host${index}`, ids)]));
  repoRuns['r1.json'] = checkpoint('dag_foreign', [], { parentSessionId: 'S' });
  await seedStore(repo, {
    tasks: Object.fromEntries(repoTaskIds.map(id => [id, taskRecord(id)])),
    runs: repoRuns,
  });
  await seedStore(host, {
    tasks: Object.fromEntries(hostTaskIds.map(id => [id, taskRecord(id)])),
    runs: hostRuns,
  });
  return { base, repo, host, stateDir, repoTaskIds, hostTaskIds };
}

function multiController({ base, stateDir, repo, host, herdr, notify = () => {} }) {
  return new DagPane({
    sessionId: 'session-1', parentPane: 'parent', socket: '/tmp/herdr.sock', stateDir,
    cwd: base, node: '/usr/bin/node', viewer: '/tmp/viewer.mjs', herdr, notify,
    taskStateDirs: [
      { root: repo, origin: 'in-project', label: 'repo store' },
      { root: host, origin: 'agent-project', label: 'host store' },
    ],
  });
}

async function treeFingerprint(root) {
  let names;
  try { names = await readdir(root, { recursive: true }); }
  catch { return []; }
  const entries = [];
  for (const name of names.sort()) {
    const path = join(root, name);
    const info = await stat(path);
    entries.push([name, info.mtimeMs, info.isFile() ? await readFile(path, 'utf8') : 'dir']);
  }
  return entries;
}

test('the agent-project host store accepts root-session checkpoints', async t => {
  const base = await mkdtemp(join(tmpdir(), 'dag-host-root-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const host = join(base, 'host');
  const repo = join(base, 'repo');
  const stateDir = join(base, 'state');
  await seedStore(host, {
    runs: { 'root.json': checkpoint('dag_host_root', [], { parentSessionId: 'root-session' }) },
  });
  const mock = fixture();
  const controller = multiController({ base, stateDir, repo, host, herdr: mock.herdr });
  t.after(() => controller.stop());
  await controller.restoreRuns();
  assert.ok(controller.runs.some(item => item.id === 'dag_host_root'));
  const source = controller.taskStateDirs.find(item => item.root === host).id;
  assert.deepEqual(controller.runSources.get(source).runs, {
    files: 1, accepted: 1, foreign: 0, invalid: 0,
  });
});

test('both readable stores yield 13 runs and 50 sourced, navigable tasks', async t => {
  const fixtureData = await multiStore(t);
  const mock = fixture();
  const controller = multiController({ ...fixtureData, herdr: mock.herdr });
  t.after(() => controller.stop());
  const repoBefore = await treeFingerprint(fixtureData.repo);
  const hostBefore = await treeFingerprint(fixtureData.host);

  await controller.restoreRuns();
  const tasks = await controller.taskData.refresh();
  assert.equal(controller.runs.length, 13);
  assert.equal(tasks.length, 50);
  assert.ok(!controller.runs.some(run => run.id === 'dag_foreign'));

  const repoSource = controller.taskStateDirs.find(source => source.root === fixtureData.repo).id;
  const hostSource = controller.taskStateDirs.find(source => source.root === fixtureData.host).id;
  assert.ok(controller.runs.every(run => run.source === repoSource || run.source === hostSource));
  assert.ok(tasks.every(task => task.source === repoSource || task.source === hostSource));

  await controller.save(false);
  const state = await readJson(controller.stateFile);
  assert.equal(state.version, 3);
  assert.equal(state.runs.length, 13);
  assert.equal(state.tasks.length, 50);
  const repoStatus = state.sources.find(source => source.id === repoSource);
  const hostStatus = state.sources.find(source => source.id === hostSource);
  assert.deepEqual(repoStatus.tasks, { files: 12, accepted: 12, foreign: 0, invalid: 0 });
  assert.deepEqual(repoStatus.runs, { files: 4, accepted: 3, foreign: 1, invalid: 0 });
  assert.deepEqual(hostStatus.tasks, { files: 38, accepted: 38, foreign: 0, invalid: 0 });
  assert.deepEqual(hostStatus.runs, { files: 10, accepted: 10, foreign: 0, invalid: 0 });

  const snapshot = normalizeSnapshot(state);
  assert.equal(snapshot.runs.length, 13);
  assert.equal(snapshot.tasks.length, 50);
  assert.equal(snapshot.sources.length, 2);
  const historical = nodeForTask(snapshot, 'st_host37');
  assert.ok(historical);
  assert.equal(historical.run.source, hostSource);
  assert.equal(nodeForTask(snapshot, 'st_repo11').run.source, repoSource);

  assert.deepEqual(await treeFingerprint(fixtureData.repo), repoBefore);
  assert.deepEqual(await treeFingerprint(fixtureData.host), hostBefore);
});

test('equal run versions keep the earlier root on startup', async t => {
  const base = await mkdtemp(join(tmpdir(), 'dag-tie-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const host = join(base, 'host');
  const updatedAt = '2026-11-10T01:00:00.000Z';
  await seedStore(repo, { runs: { 'dup.json': checkpoint('dup', [], {
    status: 'running', updatedAt, checkpointSeq: 1,
    nodes: [{ id: 'n1', label: 'n1', state: 'running' }],
  }) } });
  await seedStore(host, { runs: { 'dup.json': checkpoint('dup', [], {
    status: 'failed', updatedAt, checkpointSeq: 1,
    nodes: [{ id: 'n1', label: 'n1', state: 'failed' }],
  }) } });
  const mock = fixture();
  const controller = multiController({ base, stateDir: join(base, 'state'), repo, host, herdr: mock.herdr });
  t.after(() => controller.stop());
  await controller.restoreRuns();
  assert.equal(controller.runs.length, 1);
  assert.equal(controller.runs[0].status, 'running');
  const repoSource = controller.taskStateDirs.find(source => source.root === repo).id;
  const hostSource = controller.taskStateDirs.find(source => source.root === host).id;
  assert.equal(controller.runs[0].source, repoSource);
  assert.deepEqual(controller.runs[0].variants.map(variant => variant.source), [hostSource]);
});

test('duplicate run ids pick the newer updatedAt and keep the loser as a variant', async t => {
  const base = await mkdtemp(join(tmpdir(), 'dag-dedupe-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const host = join(base, 'host');
  await seedStore(repo, { runs: { 'dup.json': checkpoint('dup', [], {
    status: 'running', updatedAt: '2026-11-10T01:00:00.000Z',
    nodes: [{ id: 'n1', label: 'n1', state: 'running' }],
  }) } });
  await seedStore(host, { runs: { 'dup.json': checkpoint('dup', [], {
    status: 'completed', updatedAt: '2026-11-10T02:00:00.000Z',
  }) } });
  const mock = fixture();
  const controller = multiController({ base, stateDir: join(base, 'state'), repo, host, herdr: mock.herdr });
  t.after(() => controller.stop());
  await controller.restoreRuns();
  assert.equal(controller.runs.length, 1);
  assert.equal(controller.runs[0].status, 'completed');
  const repoSource = controller.taskStateDirs.find(source => source.root === repo).id;
  const hostSource = controller.taskStateDirs.find(source => source.root === host).id;
  assert.equal(controller.runs[0].source, hostSource);
  assert.deepEqual(controller.runs[0].variants.map(variant => variant.source), [repoSource]);
});

test('checkpoint sequence breaks run updatedAt ties across stores', async t => {
  const base = await mkdtemp(join(tmpdir(), 'dag-seq-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const host = join(base, 'host');
  const updatedAt = '2026-11-10T01:00:00.000Z';
  await seedStore(repo, { runs: { 'dup.json': checkpoint('dup', [], {
    status: 'running', checkpointSeq: 1, updatedAt,
    nodes: [{ id: 'n1', label: 'n1', state: 'running' }],
  }) } });
  await seedStore(host, { runs: { 'dup.json': checkpoint('dup', [], {
    status: 'completed', checkpointSeq: 2, updatedAt,
  }) } });
  const mock = fixture();
  const controller = multiController({ base, stateDir: join(base, 'state'), repo, host, herdr: mock.herdr });
  t.after(() => controller.stop());
  await controller.restoreRuns();
  assert.equal(controller.runs[0].status, 'completed');
  assert.equal(controller.runs[0].checkpointSeq, 2);
});

test('an older live run never overwrites a newer checkpoint', async t => {
  const base = await mkdtemp(join(tmpdir(), 'dag-live-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const host = join(base, 'host');
  await seedStore(repo, { runs: { 'dup.json': checkpoint('dup', [], {
    updatedAt: '2026-11-10T02:00:00.000Z',
  }) } });
  const mock = fixture();
  const controller = multiController({ base, stateDir: join(base, 'state'), repo, host, herdr: mock.herdr });
  t.after(() => controller.stop());
  await controller.restoreRuns();
  assert.equal(controller.runs[0].status, 'completed');
  await controller.receive({
    parent_session_id: 'session-1',
    runs: [{
      id: 'dup', name: 'dup', status: 'running', updatedAt: '2026-11-10T01:00:00.000Z',
      createdAt: '2026-11-10T00:00:00.000Z',
      nodes: [{ id: 'n1', label: 'n1', state: 'running' }], edges: [],
    }],
  });
  assert.equal(controller.runs.length, 1);
  assert.equal(controller.runs[0].status, 'completed');
  assert.equal(controller.runs[0].updatedAt, '2026-11-10T02:00:00.000Z');
});

test('start drops stale snapshot cache when one store is readable', async t => {
  const base = await mkdtemp(join(tmpdir(), 'dag-cache-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const host = join(base, 'missing-host');
  const repoTaskIds = Array.from({ length: 12 }, (_, index) => `st_repo${index}`);
  const repoRuns = Object.fromEntries(chunks(repoTaskIds, 3).map((ids, index) =>
    [`repo-${index}.json`, checkpoint(`dag_repo${index}`, ids)]));
  await seedStore(repo, {
    tasks: Object.fromEntries(repoTaskIds.map(id => [id, taskRecord(id)])),
    runs: repoRuns,
  });
  const mock = fixture();
  const controller = multiController({ base, stateDir: join(base, 'state'), repo, host, herdr: mock.herdr });
  t.after(() => controller.stop());
  const repoRunIds = Object.values(repoRuns).map(raw => raw.id);
  const cachedRuns = [
    ...repoRunIds.map((id, index) => ({
      id, name: id, status: 'completed',
      createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T01:00:00.000Z',
      nodes: [{ id: `n${index}`, label: 'cached', state: 'completed' }], edges: [], source: 'cache',
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `dag_cache${index}`, name: `cache ${index}`, status: 'completed',
      createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T01:00:00.000Z',
      nodes: [{ id: `c${index}`, label: 'cached', state: 'completed' }], edges: [], source: 'cache',
    })),
  ];
  const cachedTasks = Array.from({ length: 50 }, (_, index) => ({
    id: `st_cache${index}`, description: `cache ${index}`, status: 'completed', source: 'cache',
  }));
  await writeJson(controller.stateFile, {
    version: 3, sessionId: 'session-1', connected: true, updatedAt: '2026-11-10T01:00:00.000Z',
    sources: [], runs: cachedRuns, tasks: cachedTasks,
  });
  await controller.start();
  assert.equal(controller.runs.length, 3);
  assert.equal(controller.tasks.length, 12);
  assert.equal(controller.staleRunCache, 10);
  const state = await readJson(controller.stateFile);
  assert.equal(state.runs.length, 3);
  assert.equal(state.tasks.length, 12);
  assert.equal(state.sources.find(source => source.root === host).status, 'missing');
});

test('with every root missing the cached snapshot survives and is marked cache', async t => {
  const base = await mkdtemp(join(tmpdir(), 'dag-nostore-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, 'gone-repo');
  const host = join(base, 'gone-host');
  const mock = fixture();
  const controller = multiController({ base, stateDir: join(base, 'state'), repo, host, herdr: mock.herdr });
  t.after(() => controller.stop());
  await writeJson(controller.stateFile, {
    version: 3, sessionId: 'session-1', connected: false, updatedAt: '2026-11-10T01:00:00.000Z',
    sources: [],
    runs: [{
      id: 'dag_cache', name: 'cached', status: 'completed',
      createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T01:00:00.000Z',
      nodes: [{ id: 'n', label: 'cached', state: 'completed' }], edges: [],
    }],
    tasks: Array.from({ length: 5 }, (_, index) => ({
      id: `st_cache${index}`, description: `cache ${index}`, status: 'completed', source: 'cache',
    })),
  });
  await controller.start();
  assert.equal(controller.runs.length, 1);
  assert.equal(controller.tasks.length, 5);
  assert.ok(controller.tasks.every(task => task.source === 'cache'));
  const state = await readJson(controller.stateFile);
  assert.equal(state.sources.length, 2);
  assert.ok(state.sources.every(source => source.status === 'missing'));
});

test('a live DAG event merges in memory without rescanning checkpoints', async t => {
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr);
  await mkdir(controller.checkpointDir, { recursive: true });
  await writeJson(join(controller.checkpointDir, 'run.json'), checkpointRun({
    id: 'disk-run', status: 'running',
    nodes: [{ id: 'n1', label: 'node', state: 'running' }],
  }));
  await controller.restoreRuns();
  assert.equal(controller.runs.find(run => run.id === 'disk-run').status, 'running');

  // A newer checkpoint written after the scan must not be read by a live event.
  await writeJson(join(controller.checkpointDir, 'run.json'), checkpointRun({
    id: 'disk-run', status: 'failed', updatedAt: '2026-11-10T09:00:00.000Z',
    nodes: [{ id: 'n1', label: 'node', state: 'failed' }],
  }));
  await controller.receive({
    parent_session_id: 'session-1',
    runs: [{
      id: 'live-run', name: 'Live run', status: 'running',
      createdAt: '2026-11-10T08:00:00.000Z', updatedAt: '2026-11-10T08:30:00.000Z',
      nodes: [{ id: 'n1', label: 'node', state: 'running' }], edges: [],
    }],
  });
  assert.ok(controller.runs.some(run => run.id === 'live-run'));
  assert.equal(controller.runs.find(run => run.id === 'disk-run').status, 'running');
});

test('a live task payload scans the task store exactly once', async t => {
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr);
  let scans = 0;
  const refresh = controller.taskData.refresh.bind(controller.taskData);
  controller.taskData.refresh = async (...args) => {
    scans++;
    return refresh(...args);
  };
  await controller.receiveTasks(liveTaskPayload('st_once', { updatedAt: '2026-11-10T08:00:00.000Z' }));
  assert.equal(scans, 1);
  const state = await readJson(controller.stateFile);
  assert.ok(state.tasks.some(task => task.id === 'st_once'));
});

test('save prunes per-task maps for ids that left the snapshot', async t => {
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr);
  controller.taskData.merge({ task_id: 'st_keep', parent_session_id: 'session-1', status: 'running' });
  controller.outputs.set('st_keep', { reply: 'kept' });
  controller.streams.set('st_keep', { phase: 'text', since: 1, lastAt: 1 });
  controller.taskData.rateHistory.set('st_keep', [{ at: '2026-11-10T08:00:00.000Z', rate: 5 }]);
  controller.taskData.rateSeen.set('st_keep', { at: '2026-11-10T08:00:00.000Z', rate: 5, wall: 1 });
  controller.taskData.rateSources.set('st_keep', 'live');
  controller.outputs.set('st_gone', { reply: 'stale' });
  controller.streams.set('st_gone', { phase: 'text', since: 1, lastAt: 1 });
  controller.taskData.rateHistory.set('st_gone', [{ at: '2026-11-10T07:00:00.000Z', rate: 9 }]);
  controller.taskData.rateSeen.set('st_gone', { at: '2026-11-10T07:00:00.000Z', rate: 9, wall: 1 });
  controller.taskData.rateSources.set('st_gone', 'live');

  await controller.save(true);

  assert.equal(controller.outputs.has('st_gone'), false);
  assert.equal(controller.streams.has('st_gone'), false);
  assert.equal(controller.taskData.rateHistory.has('st_gone'), false);
  assert.equal(controller.taskData.rateSeen.has('st_gone'), false);
  assert.equal(controller.taskData.rateSources.has('st_gone'), false);
  assert.ok(controller.outputs.has('st_keep'));
  assert.ok(controller.streams.has('st_keep'));
  const state = await readJson(controller.stateFile);
  assert.equal(state.tasks.find(task => task.id === 'st_keep').reply, 'kept');
});

test('an all-invalid checkpoint store is unreadable and keeps the cached run', async t => {
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr);
  await mkdir(controller.checkpointDir, { recursive: true });
  await writeJson(join(controller.checkpointDir, 'broken.json'), {
    schemaVersion: 2, parentSessionId: 'session-1', id: 'broken', nodes: [], edges: [],
  });
  controller.runs = [{
    id: 'cached-run', name: 'cached', status: 'completed', source: 'cache',
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T01:00:00.000Z',
    nodes: [{ id: 'n', label: 'cached', state: 'completed' }], edges: [],
  }];
  controller.cacheRunIds = new Set(['cached-run']);
  await controller.restoreRuns();
  const source = controller.taskStateDirs[0].id;
  assert.equal(controller.runSources.get(source).status, 'unreadable');
  assert.deepEqual(controller.runs.map(run => run.id), ['cached-run']);
  assert.equal(controller.staleRunCache, 0);
});

test('checkpoint failures translate at the boundary with cleaned values', async t => {
  const messages = [];
  const translations = [];
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr, {
    notify: message => messages.push(message),
    translate: (key, params) => {
      translations.push({ key, params });
      return `localized:${key}:${params.name}`;
    },
  });
  await mkdir(controller.checkpointDir, { recursive: true });
  const name = `bad${String.fromCharCode(27)}[31m.json`;
  await writeFile(join(controller.checkpointDir, name), '{not json');
  await controller.restoreRuns();
  const read = translations.find(entry => entry.key === 'checkpointRead');
  assert.ok(read);
  assert.equal(read.params.name, 'bad.json');
  assert.doesNotMatch(read.params.name, /[\x00-\x1f\x7f]/);
  assert.ok(messages.includes('localized:checkpointRead:bad.json'));
});

test('a stop during split closes the new pane and aborts the launch', async t => {
  const calls = [];
  let releaseSplit;
  let splitStarted;
  const splitGate = new Promise(resolve => { releaseSplit = resolve; });
  const splitEntered = new Promise(resolve => { splitStarted = resolve; });
  const panes = new Map([['parent', { pane_id: 'parent', tab_id: 't1', label: 'OmO' }]]);
  const herdr = async (...args) => {
    calls.push(args);
    if (args[0] === 'list') return { panes: [...panes.values()] };
    if (args[0] === 'get') return { pane: panes.get(args[1]) };
    if (args[0] === 'split') {
      splitStarted();
      await splitGate;
      const pane = { pane_id: 'viewer', tab_id: 't1', label: dagTitle('session-1') };
      panes.set(pane.pane_id, pane);
      return { pane };
    }
    return {};
  };
  const { controller } = await setup(t, herdr);
  const pending = controller.ensure(false);
  await splitEntered;
  await controller.stop();
  releaseSplit();
  await assert.rejects(pending, /stopped/);
  assert.ok(calls.some(call => call[0] === 'close' && call[1] === 'viewer'));
  assert.equal(calls.some(call => call[0] === 'rename'), false);
  assert.equal(calls.some(call => call[0] === 'run'), false);
  assert.deepEqual(await readJson(controller.recordFile), { attempted: true });
});

test('a failed pane enumeration aborts ensure instead of splitting a duplicate', async t => {
  const calls = [];
  const messages = [];
  const herdr = async (...args) => {
    calls.push(args);
    if (args[0] === 'list') throw new Error('ipc down');
    if (args[0] === 'split') return { pane: { pane_id: 'viewer', tab_id: 't1' } };
    return {};
  };
  const { controller } = await setup(t, herdr, { notify: message => messages.push(message) });
  await assert.rejects(controller.ensure(true), /ipc down/);
  assert.equal(calls.some(call => call[0] === 'split'), false);
  assert.ok(messages.some(message => message.includes('Cannot list panes') && message.includes('ipc down')));
});

test('stop settles a stream flush promise whose timer was cancelled', async t => {
  const mock = fixture();
  const { stateDir, controller } = await setup(t, mock.herdr);
  controller.taskData.merge({ task_id: 'st_live', parent_session_id: 'session-1', status: 'running' });
  const pending = controller.receiveStream({
    taskId: 'st_live', active: true, phase: 'text', text: 'live tail', now: 1000,
  });
  await controller.stop();
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('receiveStream promise did not settle')), 1000);
  });
  try {
    await Promise.race([pending, guard]);
  } finally {
    clearTimeout(timer);
  }
  const state = await readJson(join(stateDir, `${controller.key}.json`));
  assert.equal(state.tasks.find(task => task.id === 'st_live').reply, 'live tail');
});

test('checkpoint notifications strip control sequences from file names', async t => {
  const messages = [];
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr, { notify: message => messages.push(message) });
  await mkdir(controller.checkpointDir, { recursive: true });
  const name = `bad${String.fromCharCode(27)}[31m.json`;
  await writeFile(join(controller.checkpointDir, name), '{not json');
  await controller.restoreRuns();
  const notice = messages.find(message => message.includes('Cannot read checkpoint'));
  assert.ok(notice);
  assert.match(notice, /bad\.json/);
  assert.doesNotMatch(notice, /[\x00-\x08\x0b-\x1f\x7f]/);
});

test('a malformed checkpoint warns once across repeated scans', async t => {
  const messages = [];
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr, { notify: message => messages.push(message) });
  await mkdir(controller.checkpointDir, { recursive: true });
  await writeJson(join(controller.checkpointDir, 'future.json'), {
    schemaVersion: 2, parentSessionId: 'session-1', id: 'future', nodes: [], edges: [],
  });
  await controller.restoreRuns();
  await controller.restoreRuns();
  assert.equal(messages.filter(message => message.includes('future.json')).length, 1);
});

test('a failed final save does not reject stop and clears live state', async t => {
  const messages = [];
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr, { notify: message => messages.push(message) });
  controller.outputs.set('st_tail', { reply: 'tail' });
  controller.save = async () => { throw new Error('disk full'); };
  await controller.stop();
  assert.ok(messages.some(message => message.includes('Cannot save snapshot: disk full')));
  assert.equal(controller.outputs.size, 0);
  assert.equal(controller.streams.size, 0);
});

test('the saved snapshot omits an unused language field', async t => {
  const mock = fixture();
  const { controller } = await setup(t, mock.herdr);
  await controller.receive({ parent_session_id: 'session-1', runs: [run] });
  const state = await readJson(controller.stateFile);
  assert.equal('language' in state, false);
});
