import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson } from '../src/storage.mjs';

async function temporaryDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dag-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function temporaryLeftovers(dir) {
  return (await readdir(dir)).filter(name => name.endsWith('.tmp'));
}

test('readJson returns null for a missing file or directory', async t => {
  const root = await temporaryDir(t);
  assert.equal(await readJson(join(root, 'missing.json')), null);
  assert.equal(await readJson(join(root, 'missing-dir', 'state.json')), null);
});

test('readJson rethrows malformed JSON instead of hiding it as null', async t => {
  const root = await temporaryDir(t);
  const target = join(root, 'state.json');
  await writeFile(target, '{not json');
  await assert.rejects(readJson(target), error => error instanceof SyntaxError);
  assert.equal(await readFile(target, 'utf8'), '{not json');
  assert.deepEqual(await temporaryLeftovers(root), []);
});

test('writeJson creates a 0700 directory and a 0600 file with no temp residue', async t => {
  const root = await temporaryDir(t);
  const target = join(root, 'nested', 'config.json');
  await writeJson(target, { theme: 'grok-night' });
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { theme: 'grok-night' });
  assert.equal((await stat(join(root, 'nested'))).mode & 0o777, 0o700);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await temporaryLeftovers(join(root, 'nested')), []);
});

test('writeJson overwrites atomically and a failed write keeps the old file', async t => {
  const root = await temporaryDir(t);
  const target = join(root, 'state.json');
  await writeJson(target, { version: 1 });
  const before = await stat(target);

  await writeJson(target, { version: 2 });
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { version: 2 });
  const after = await stat(target);
  assert.equal(after.mode & 0o777, 0o600);
  assert.notEqual(after.ino, before.ino, 'replacement publishes a new inode instead of truncating in place');
  assert.deepEqual(await temporaryLeftovers(root), []);

  // JSON.stringify throws after the temp file is open: the write must rethrow,
  // remove its temp file, and leave the previously published value untouched.
  const circular = {};
  circular.self = circular;
  await assert.rejects(writeJson(target, circular), error => error instanceof TypeError);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { version: 2 });
  assert.equal((await stat(target)).ino, after.ino);
  assert.deepEqual(await temporaryLeftovers(root), []);
});
