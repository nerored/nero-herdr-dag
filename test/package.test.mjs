import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'bin', 'dag-studio.mjs');
const hasMake = spawnSync('make', ['--version'], { encoding: 'utf8' }).status === 0;

const readPackage = async () => JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const exists = path => stat(path).then(() => true, () => false);

// A clean checkout contains the tracked inputs only. dist/ is gitignored, so
// it is absent until the pack lifecycle builds it.
async function stageCleanCheckout(stage) {
  const pkg = await readPackage();
  for (const entry of ['package.json', ...(pkg.files ?? [])]) {
    const relative = entry.replace(/\/+$/, '');
    if (relative === 'dist') continue;
    if (!(await exists(join(root, relative)))) continue;
    await cp(join(root, relative), join(stage, relative), { recursive: true });
  }
}

test('a packed clean checkout contains and imports the declared package export', { timeout: 120000 }, async t => {
  const stage = await mkdtemp(join(tmpdir(), 'herdr-dag-pack-src-'));
  const destination = await mkdtemp(join(tmpdir(), 'herdr-dag-pack-out-'));
  const unpacked = await mkdtemp(join(tmpdir(), 'herdr-dag-pack-unpacked-'));
  t.after(() => Promise.all([stage, destination, unpacked]
    .map(directory => rm(directory, { recursive: true, force: true }))));

  await stageCleanCheckout(stage);
  assert.equal(await exists(join(stage, 'dist')), false, 'the staged checkout must not contain a built dist/');

  const packed = spawnSync(process.execPath, ['pm', 'pack', '--destination', destination], {
    cwd: stage,
    encoding: 'utf8',
    env: process.env,
    timeout: 90000,
  });
  assert.equal(packed.status, 0, `bun pm pack failed:\n${packed.stderr || packed.stdout}`);

  const tarballs = (await readdir(destination)).filter(name => name.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, `expected exactly one tarball, found ${tarballs.join(', ') || 'none'}`);

  const pkg = await readPackage();
  const target = pkg.exports?.['.'];
  assert.equal(typeof target, 'string', 'package.json must declare a "." export');
  const exportPath = target.replace(/^\.\//, '');

  const archive = new Bun.Archive(await Bun.file(join(destination, tarballs[0])).arrayBuffer());
  const packedFiles = [...(await archive.files()).keys()];
  const packedExport = `package/${exportPath}`;
  assert.ok(
    packedFiles.includes(packedExport),
    `the packed tarball is missing the declared export ${target}; packed files: ${packedFiles.join(', ')}`,
  );

  // Resolution, not just presence: an installed package must be importable.
  await archive.extract(unpacked);
  const loaded = await import(pathToFileURL(join(unpacked, packedExport)).href);
  assert.equal(typeof loaded.default, 'function', `the packed export ${target} must load a default export`);
});

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30000,
  });
}

async function fakeViewer(t) {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-dag-cli-noop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const viewer = join(dir, 'viewer.mjs');
  await writeFile(viewer, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.DAG_STUDIO_ARGS, JSON.stringify(process.argv.slice(2)));
`);
  return viewer;
}

async function makeProbe(t) {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-dag-make-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const probe = join(dir, 'probe.sh');
  await writeFile(probe, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$AGENT_DIR_PROBE"\n');
  await chmod(probe, 0o755);
  return { dir, probe, record: join(dir, 'args'), marker: join(dir, 'injected') };
}

function runMake(args, env = {}) {
  return spawnSync('make', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60000,
  });
}

function probeArgs(record) {
  return readFile(record, 'utf8').then(text => text.split('\n').filter(Boolean));
}

test('dag-studio help lists the real demo scenarios and the default start', async () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--scenario early\|late/);
  assert.match(result.stdout, /32 seconds/);
  assert.doesNotMatch(result.stdout, /--scenario integration/);
});

test('dag-studio view rejects a missing or option-like --state value', async t => {
  const viewer = await fakeViewer(t);
  const record = join(dirname(viewer), 'args');
  for (const args of [['view', '--state'], ['view', '--state', '--fps', '12'], ['view', '--fps', '12']]) {
    await t.test(args.join(' '), async () => {
      const result = runCli(args, { DAG_STUDIO_VIEWER: viewer, DAG_STUDIO_ARGS: record });
      assert.equal(result.status, 1, `expected a usage failure for ${args.join(' ')}\n${result.stderr}`);
      assert.match(result.stderr, /view requires --state PATH/);
      await assert.rejects(readFile(record, 'utf8'), { code: 'ENOENT' }, 'the viewer must not be launched');
    });
  }
});

test('dag-studio view forwards a validated --state path to the viewer', async t => {
  const viewer = await fakeViewer(t);
  const record = join(dirname(viewer), 'args');
  const state = join(dirname(viewer), 'state file.json');
  const result = runCli(['view', '--state', state, '--fps', '12'], { DAG_STUDIO_VIEWER: viewer, DAG_STUDIO_ARGS: record });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), ['--state', state, '--fps', '12']);
});

test('make passes AGENT_DIR as data without expanding make functions', { skip: hasMake ? false : 'make is not installed' }, async t => {
  const { probe, record, marker } = await makeProbe(t);
  const value = `$(shell touch ${marker})`;
  const env = { AGENT_DIR_PROBE: record };

  const preview = runMake(['-n', 'uninstall', `AGENT_DIR=${value}`, `BUN='${probe}'`], env);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(await stat(marker).then(() => true, () => false), false, 'make -n must not run the embedded shell function');

  const executed = runMake(['uninstall', `AGENT_DIR=${value}`, `BUN='${probe}'`], env);
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(await stat(marker).then(() => true, () => false), false, 'the installer must receive the value as data, not run it');
  assert.deepEqual(await probeArgs(record), ['scripts/uninstall.mjs', '--agent-dir', value]);

  // The same value arriving through the environment must stay data too.
  await rm(record, { force: true });
  const fromEnvironment = runMake(['uninstall', `BUN='${probe}'`], { ...env, AGENT_DIR: value });
  assert.equal(fromEnvironment.status, 0, fromEnvironment.stderr);
  assert.equal(await stat(marker).then(() => true, () => false), false, 'an environment AGENT_DIR must not run make functions');
  assert.deepEqual(await probeArgs(record), ['scripts/uninstall.mjs', '--agent-dir', value]);
});

test('make keeps a spaced AGENT_DIR as one installer argument', { skip: hasMake ? false : 'make is not installed' }, async t => {
  const { dir, probe, record } = await makeProbe(t);
  const agentDir = join(dir, 'agent dir');
  const result = runMake(['uninstall', `AGENT_DIR=${agentDir}`, `BUN='${probe}'`], { AGENT_DIR_PROBE: record });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await probeArgs(record), ['scripts/uninstall.mjs', '--agent-dir', agentDir]);
});

test('make rejects an AGENT_DIR that would escape the quoted argument', { skip: hasMake ? false : 'make is not installed' }, async t => {
  const { probe, record } = await makeProbe(t);
  for (const value of ['bad"path', 'bad\\path']) {
    const result = runMake(['uninstall', `AGENT_DIR=${value}`, `BUN='${probe}'`], { AGENT_DIR_PROBE: record });
    assert.notEqual(result.status, 0, `make must reject ${JSON.stringify(value)}`);
    assert.match(result.stderr, /AGENT_DIR must not contain double quotes or backslashes/);
    await assert.rejects(readFile(record, 'utf8'), { code: 'ENOENT' }, 'the installer must not run for a rejected value');
  }
});

test('the built dist ships the shared install helper next to the installer', { timeout: 60000 }, async () => {
  const build = spawnSync(process.execPath, ['run', 'build'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 45000,
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  for (const name of ['install.mjs', 'uninstall.mjs', 'install-lib.mjs']) {
    assert.equal(await exists(join(root, 'dist', 'scripts', name)), true, `dist/scripts/${name} must exist after a build`);
  }

  const helper = await import(pathToFileURL(join(root, 'dist', 'scripts', 'install-lib.mjs')).href);
  assert.equal(typeof helper.parseArgs, 'function', 'the dist helper must expose the shared parser');
});
