import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOwnedSnapshotName, pruneExpiredSnapshots, retentionDaysFromEnv } from '../src/retention.mjs';

const OLD = new Date('2020-01-01T00:00:00Z');
const NOW = Date.parse('2026-11-10T00:00:00Z');
const DAYS = 14;
const uuid = '123e4567-e89b-12d3-a456-426614174000';

const key = number => number.toString(16).padStart(24, '0');

async function stateDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-dag-retention-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function oldFile(dir, name) {
  const path = join(dir, name);
  await writeFile(path, '{}');
  await utimes(path, OLD, OLD);
  return path;
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

test('retention deletes only expired DAG Studio state names', async t => {
  const dir = await stateDir(t);
  const stale = [
    `${key(1)}.json`,
    `${key(2)}.pane.json`,
    `${key(3)}.json.view.json`,
    `${key(4)}.json.${uuid}.tmp`,
    `${key(5)}.pane.json.${uuid}.tmp`,
    `${key(6)}.json.view.json.${uuid}.tmp`,
  ];
  for (const name of stale) await oldFile(dir, name);

  const foreign = [
    'config.json',
    'notes.json',
    'snapshot.json',
    'retention.tmp',
    `${key(7)}.yaml`,
    `${key(8)}.json.bak`,
    'ABC.json',
  ];
  for (const name of foreign) await oldFile(dir, name);

  await mkdir(join(dir, `${key(9)}.json`));
  const victim = join(dir, 'victim.txt');
  await writeFile(victim, 'untouched');
  await symlink(victim, join(dir, `${key(10)}.json`));

  const fresh = await oldFile(dir, `${key(11)}.json`);
  await utimes(fresh, new Date(), new Date());

  const kept = [`${key(12)}.json`, `${key(13)}.pane.json`];
  for (const name of kept) await oldFile(dir, name);

  const notified = [];
  await pruneExpiredSnapshots(dir, {
    now: NOW, days: DAYS, keepFiles: kept, notify: message => notified.push(message),
  });

  for (const name of stale) assert.equal(await exists(join(dir, name)), false, `${name} should be deleted`);
  for (const name of foreign) assert.equal(await exists(join(dir, name)), true, `${name} should survive`);
  for (const name of kept) assert.equal(await exists(join(dir, name)), true, `${name} should be kept`);
  assert.equal(await exists(fresh), true, 'recent snapshot should survive');
  assert.equal(await exists(join(dir, `${key(9)}.json`)), true, 'a directory with an owned name should survive');
  assert.equal(await exists(join(dir, `${key(10)}.json`)), true, 'a symlink with an owned name should survive');
  assert.equal(await exists(victim), true, 'a symlink target should survive');
  assert.deepEqual(notified, []);
});

test('retention is disabled for non-positive day counts', async t => {
  const dir = await stateDir(t);
  const name = `${key(20)}.json`;
  await oldFile(dir, name);
  await pruneExpiredSnapshots(dir, { now: NOW, days: 0 });
  assert.equal(await exists(join(dir, name)), true);
});

test('owned-name detection matches the documented state shapes only', () => {
  assert.equal(isOwnedSnapshotName(`${key(30)}.json`), true);
  assert.equal(isOwnedSnapshotName(`${key(30)}.pane.json`), true);
  assert.equal(isOwnedSnapshotName(`${key(30)}.json.view.json`), true);
  assert.equal(isOwnedSnapshotName(`${key(30)}.json.${uuid}.tmp`), true);
  assert.equal(isOwnedSnapshotName('config.json'), false);
  assert.equal(isOwnedSnapshotName(`${key(30)}.json.bak`), false);
  assert.equal(isOwnedSnapshotName(`${key(30)}.yaml`), false);
  assert.equal(isOwnedSnapshotName(`${key(30).toUpperCase()}.json`), true);
});

test('missing retention directory is a no-op', async t => {
  const dir = await stateDir(t);
  await pruneExpiredSnapshots(join(dir, 'absent'), { now: NOW, days: DAYS });
});

test('retention env parsing keeps the existing defaults', () => {
  assert.equal(retentionDaysFromEnv({}), 14);
  assert.equal(retentionDaysFromEnv({ OMO_HERDR_DAG_STUDIO_RETENTION_DAYS: ' 30 ' }), 30);
  assert.equal(retentionDaysFromEnv({ OMO_HERDR_DAG_STUDIO_RETENTION_DAYS: '0' }), 0);
  assert.equal(retentionDaysFromEnv({ OMO_HERDR_DAG_STUDIO_RETENTION_DAYS: 'nope' }), 0);
});
