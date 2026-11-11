import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modeFor, normalizeSnapshot } from '../src/model.mjs';
import {
  MAX_RECORD_BYTES, recordForKey, recordRoot, recordTargetFor, relativeDisplay,
  safeRecordPath,
} from '../src/records.mjs';
import { recordForSelection } from '../src/render.mjs';

const makeStore = (t, prefix = 'dag-records-') => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tasks'), { recursive: true });
  return root;
};

// A record root is trusted only when it is an absolute, control-free path; the
// derived document then passes the containment, extension, and size gates.
test('record roots and safe record paths enforce absolute, JSON, and size gates', t => {
  const root = makeStore(t);
  assert.equal(recordRoot('relative/store'), undefined);
  assert.equal(recordRoot(`${root}\n`), undefined);
  assert.equal(recordRoot(root), root);

  const record = join(root, 'tasks', 'st_ok.json');
  writeFileSync(record, '{}');
  assert.equal(safeRecordPath(root, record), realpathSync(record));
  assert.equal(safeRecordPath(root, join(root, 'tasks', 'note.txt')), undefined);
  assert.equal(safeRecordPath(root, join(root, 'tasks')), undefined);

  writeFileSync(record, Buffer.alloc(MAX_RECORD_BYTES + 1));
  assert.equal(safeRecordPath(root, record), undefined);
});

// A .json link is only a record when its real target is also a regular JSON
// file inside the root.
test('record paths reject escaping and non-JSON symlink targets', t => {
  const root = makeStore(t);
  const outside = mkdtempSync(join(tmpdir(), 'dag-records-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const outsideRecord = join(outside, 'outside.json');
  writeFileSync(outsideRecord, '{}');

  const escaped = join(root, 'tasks', 'escaped.json');
  symlinkSync(outsideRecord, escaped);
  assert.equal(safeRecordPath(root, escaped), undefined);

  const secret = join(root, 'secret.txt');
  writeFileSync(secret, 'secret');
  const disguised = join(root, 'tasks', 'disguised.json');
  symlinkSync(secret, disguised);
  assert.equal(safeRecordPath(root, disguised), undefined);

  assert.equal(relativeDisplay(root, join(root, 'tasks', 'st_ok.json')), 'tasks/st_ok.json');
});

// A task read from a secondary store resolves its record against that store,
// not the primary provenance root, and the action revalidates on every call.
test('record targets use the source store and revalidate the open action', t => {
  const host = makeStore(t, 'dag-records-host-');
  const repo = makeStore(t, 'dag-records-repo-');
  mkdirSync(join(repo, 'dag', 'runs'), { recursive: true });
  const taskPath = join(host, 'tasks', 'st_shared.json');
  const checkpointPath = join(repo, 'dag', 'runs', 'run_shared.json');
  writeFileSync(taskPath, '{}');
  writeFileSync(checkpointPath, '{}');

  const snapshot = {
    mode: 'live',
    connected: true,
    provenance: { taskStateDir: repo },
    sources: [{ id: 'host', root: host }, { id: 'repo', root: repo }],
  };
  const target = recordTargetFor(snapshot, {
    task: { id: 'st_shared', status: 'failed', source: 'host' },
    run: { id: 'run_shared', status: 'failed', source: 'repo' },
    subject: 'task',
  });

  assert.equal(target.records.find(record => record.key === 'task').root, host);
  assert.equal(target.records.find(record => record.key === 'checkpoint').root, repo);
  assert.equal(target.openKey, 'task');
  assert.equal(target.openPath, realpathSync(taskPath));
  assert.deepEqual(recordForKey('o', target), { kind: 'open', path: realpathSync(taskPath) });

  // Removing the preferred task record falls back to the readable checkpoint.
  rmSync(taskPath);
  assert.deepEqual(recordForKey('o', target), { kind: 'open', path: realpathSync(checkpointPath) });

  // With both records gone, the action is unavailable instead of stale.
  rmSync(checkpointPath);
  assert.deepEqual(recordForKey('o', target), { kind: 'unavailable', reason: 'no-safe-record' });

  // Synthetic live/cache ids have no descriptor; they keep the provenance root.
  const fallback = recordTargetFor(snapshot, {
    task: { id: 'st_live', status: 'failed', source: 'live' },
    run: { id: 'run_cache', status: 'failed', source: 'cache' },
    subject: 'task',
  });
  assert.equal(fallback.records.find(record => record.key === 'task').root, repo);
  assert.equal(fallback.records.find(record => record.key === 'checkpoint').root, repo);
});

// Record mode is not a fourth derivation: demo/legacy/explicit-live snapshots
// take the same answer as model.modeFor, and the render entry point agrees.
test('record mode uses the shared modeFor contract', () => {
  const legacyDemo = recordTargetFor(
    { demo: { cycle: 1 }, provenance: { taskStateDir: '/tmp/dag-store' } },
    { task: { id: 'st_demo', status: 'failed' }, subject: 'task' },
  );
  assert.equal(legacyDemo.mode, 'demo');
  assert.equal(legacyDemo.simulated, true);
  assert.deepEqual(legacyDemo.records, []);

  const live = recordTargetFor(
    { mode: 'live', connected: false },
    { task: { id: 'st_live', status: 'failed' }, subject: 'task' },
  );
  assert.equal(live.mode, 'live');
  assert.equal(live.mode, modeFor({ mode: 'live', connected: false }));

  const snapshot = normalizeSnapshot({
    version: 3,
    mode: 'demo',
    runs: [{ id: 'r', status: 'failed', nodes: [{ id: 'n', label: 'n', state: 'failed', task_id: 'st_x' }], edges: [] }],
    tasks: [{ id: 'st_x', description: 'x', status: 'failed' }],
  });
  const ui = {
    focus: 'tasks', lastFocus: 'tasks', selectedTaskId: 'st_x', runIndex: 0,
  };
  assert.equal(recordForSelection(snapshot, ui).mode, modeFor(snapshot));
});
