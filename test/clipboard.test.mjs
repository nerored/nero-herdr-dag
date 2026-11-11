import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { osc52, payloadLines } from '../src/clipboard.mjs';
import {
  diagnosisCopyText, diagnosisFor, diagnosisForKey, diagnosisPathsText,
} from '../src/diagnosis.mjs';
import { safeFileWithin } from '../src/safe-path.mjs';
import { modeFor, normalizeSnapshot } from '../src/model.mjs';

const decodeOsc52 = escape =>
  Buffer.from(escape.slice('\x1b]52;c;'.length, -1), 'base64').toString('utf8');

const activity = { phase: 'tool', tool: 'bash', since: 1000, lastAt: 2000 };

const snapshotWith = ({ node, task }) => normalizeSnapshot({
  version: 3, mode: 'live', connected: true,
  runs: [{ id: 'r', status: 'running', nodes: [node], edges: [] }],
  tasks: [task],
});

// The diagnosis bundle is evidence for work that stopped; a failed node must
// not report the linked task's still-live tool call as its last activity.
test('a failed node linked to a running task records no live task activity', () => {
  const snapshot = snapshotWith({
    node: { id: 'done', label: 'done', state: 'failed', task_id: 'st_live', error: 'upload failed' },
    task: { id: 'st_live', description: 'live task', status: 'running', activity },
  });
  const diagnosis = diagnosisFor({
    snapshot, run: snapshot.runs[0], node: snapshot.runs[0].nodes[0], task: snapshot.tasks[0], subject: 'node',
  });
  assert.equal(diagnosis.state, 'failed');
  assert.equal(diagnosis.lastActivity, undefined);
});

// A task subject has no node state; its own activity is its last activity.
test('a task subject reports its own recorded activity', () => {
  const snapshot = snapshotWith({
    node: { id: 'paused', state: 'paused', task_id: 'st_paused' },
    task: { id: 'st_paused', description: 'paused task', status: 'paused', activity },
  });
  const diagnosis = diagnosisFor({
    snapshot, run: snapshot.runs[0], task: snapshot.tasks[0], subject: 'task',
  });
  assert.equal(diagnosis.state, 'paused');
  assert.deepEqual(diagnosis.lastActivity, { kind: 'tool', tool: 'bash', at: 2000 });
});

// A mode that says live is live even when the feed is momentarily disconnected;
// this is the same rule the header badge applies.
test('an explicit live mode wins over connected:false', () => {
  const task = { id: 'st_live', status: 'failed', error: 'boom' };
  const live = diagnosisFor({ snapshot: { mode: 'live', connected: false }, task, subject: 'task' });
  assert.equal(live.mode, 'live');
  assert.equal(live.simulated, false);
  const saved = diagnosisFor({ snapshot: { mode: 'saved', connected: true }, task, subject: 'task' });
  assert.equal(saved.mode, 'saved');
});

// The clipboard bundle is the artifact a user keeps, so its labels follow the
// selected language instead of staying English-only.
test('diagnosis copy and path bundles follow the selected language', () => {
  const snapshot = {
    mode: 'live',
    provenance: { taskStateDir: '/tmp/dag-store', statePath: '/tmp/dag-store/snapshot.json' },
  };
  const task = {
    id: 'st_fail', status: 'failed', error: 'permission denied',
    completedAt: '2026-11-10T06:04:00.000Z',
  };
  const diagnosis = diagnosisFor({ snapshot, run: { id: 'dag_release_audit', nodes: [], edges: [] }, task, subject: 'task' });

  const zh = diagnosisCopyText(diagnosis, 'zh');
  assert.match(zh, /^dag-studio 诊断/m);
  assert.match(zh, /^状态: 失败 \(任务#status 失败\)$/m);
  assert.match(zh, /^状态来源: 任务#status$/m);
  assert.match(zh, /^原因: permission denied$/m);
  assert.match(zh, /^归属: OmO/m);
  assert.match(zh, /^记录: \/tmp\/dag-store\/tasks\/st_fail\.json$/m);

  const en = diagnosisCopyText(diagnosis);
  assert.match(en, /^dag-studio diagnosis/m);
  assert.match(en, /^status: FAILED \(task#status FAILED\)$/m);
  assert.match(en, /^owner: OmO \(retry\/resume\/cancel unavailable in DAG Studio\)$/m);

  const zhPaths = diagnosisPathsText(diagnosis, 'zh');
  assert.match(zhPaths, /^记录: /m);
  assert.match(zhPaths, /^检查点: /m);
  assert.match(zhPaths, /^快照: /m);
  assert.match(diagnosisForKey('c', diagnosis, undefined, 'zh').text, /^dag-studio 诊断/m);
});

// A .json link is only a record when its resolved target is also JSON.
test('safe open rejects a .json symlink whose real target is not JSON', t => {
  const root = mkdtempSync(join(tmpdir(), 'dag-clipboard-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secret = join(root, 'secret.txt');
  const link = join(root, 'record.json');
  writeFileSync(secret, 'secret');
  symlinkSync(secret, link);
  assert.equal(safeFileWithin(root, link), undefined);

  const good = join(root, 'good.json');
  writeFileSync(good, '{}');
  assert.equal(safeFileWithin(root, good), realpathSync(good));
});

// A record named `..notes.json` is inside the root; only a `..` segment escapes.
test('safe open accepts an in-root record whose name begins with two dots', t => {
  const root = mkdtempSync(join(tmpdir(), 'dag-clipboard-dots-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const record = join(root, '..notes.json');
  writeFileSync(record, '{}');
  assert.equal(safeFileWithin(root, record), realpathSync(record));
});

// Truncating at a fixed UTF-16 offset must not cut an astral character in half.
test('OSC 52 truncation never splits a surrogate pair', () => {
  const text = `${'a'.repeat(15_999)}😀`;
  const payload = decodeOsc52(osc52(text));
  assert.equal(payload, `${'a'.repeat(15_999)}\n… truncated`);
  assert.doesNotMatch(payload, /\uFFFD/);
});

// The toast must describe what was sent, not what was offered to osc52.
test('payload line count matches the emitted truncated payload', () => {
  const text = Array.from({ length: 2_000 }, (_, index) => `line ${index} ${'x'.repeat(80)}`).join('\n');
  const emitted = decodeOsc52(osc52(text));
  assert.match(emitted, /\n… truncated$/);
  assert.equal(payloadLines(text), emitted.split('\n').length);
  assert.ok(payloadLines(text) < 2_000);
  assert.equal(payloadLines('one\ntwo'), 2);
  assert.equal(payloadLines(''), 0);
});

// Windows-origin stats paths go through the same separator normalization as
// the primary artifact path, so they stay copyable and openable on POSIX.
test('artifact stats paths are normalized before the relative-path gate', () => {
  const snapshot = { mode: 'live', provenance: { taskStateDir: '/tmp/dag-store' } };
  const node = {
    id: 'ship', label: 'ship', state: 'failed', error: 'upload failed',
    artifact: {
      relativePath: 'dag/results/ship.txt', bytes: 10,
      statsPath: 'dag\\results\\ship.stats.json', statsBytes: 4,
    },
  };
  const diagnosis = diagnosisFor({ snapshot, node, subject: 'node' });
  assert.equal(diagnosis.artifact.statsRelativePath, 'dag/results/ship.stats.json');
  assert.equal(diagnosis.artifact.statsAbsolute, '/tmp/dag-store/dag/results/ship.stats.json');
  assert.match(diagnosisCopyText(diagnosis), /^artifact stats: \/tmp\/dag-store\/dag\/results\/ship\.stats\.json$/m);
  assert.match(diagnosisPathsText(diagnosis), /^artifact stats: /m);
});

// One retry formatter: the copy keeps the recorded retries line exactly once,
// including when retries equal failedTurns.
test('diagnosis copy keeps one retries line per recorded value', () => {
  const task = {
    id: 'st_retry', status: 'failed', error: 'boom',
    completedAt: '2026-11-10T06:04:00.000Z',
    failedTurns: 4, retries: 4, retriesSource: 'run_stats.failed_turns',
  };
  const diagnosis = diagnosisFor({ snapshot: { mode: 'live' }, task, subject: 'task' });
  const copy = diagnosisCopyText(diagnosis);
  assert.match(copy, /^failed turns: 4$/m);
  assert.deepEqual(copy.split('\n').filter(line => line.startsWith('retries:')), ['retries: 4 (run_stats.failed_turns)']);
});

// The diagnosis badge and the copy line come from model.modeFor, so a demo
// object, an explicit live mode, and a disconnected feed agree everywhere.
test('diagnosis mode uses the shared modeFor contract', () => {
  const task = { id: 'st_mode', status: 'failed', error: 'boom' };
  for (const snapshot of [
    { demo: { cycle: 1 } },
    { mode: 'live', connected: false },
    { mode: 'saved', connected: true },
    { connected: false },
  ]) {
    const diagnosis = diagnosisFor({ snapshot, task, subject: 'task' });
    assert.equal(diagnosis.mode, modeFor(snapshot));
  }
});
