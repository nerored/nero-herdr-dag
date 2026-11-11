import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHerdr, herdrSession, quote, resolveHerdrBin, shellCommand } from '../src/herdr.mjs';
import { readEnv } from '../src/env.mjs';
import { resolveViewerRuntime } from '../src/runtime.mjs';

const probe = (overrides = {}) => JSON.stringify({
  runtime: 'herdr-dag-studio-runtime',
  node: '24.21.0',
  bun: null,
  path: '/usr/bin/node',
  ...overrides,
});

test('resolves Bun before Node and honors an explicit runtime', async () => {
  const calls = [];
  const run = async command => {
    calls.push(command);
    if (command === '/custom/bun') return { stdout: probe({ bun: '1.4.3', path: '/custom/bun' }) };
    if (command === 'bun' || command === '/usr/bin/bun') {
      return { stdout: probe({ bun: '1.4.3', path: '/usr/bin/bun' }) };
    }
    return { stdout: probe() };
  };

  assert.equal(await resolveViewerRuntime({ env: {}, execPath: '/usr/bin/node', run }), '/usr/bin/bun');
  assert.deepEqual(calls.slice(0, 1), ['bun']);

  calls.length = 0;
  assert.equal(await resolveViewerRuntime({
    env: { OMO_HERDR_DAG_STUDIO_RUNTIME: '/custom/bun' }, execPath: '/usr/bin/node', run,
  }), '/custom/bun');
  assert.deepEqual(calls, ['/custom/bun']);
});

test('the shared env reader trims runtime aliases and parses herdr flags', () => {
  const env = readEnv({
    OMO_HERDR_DAG_STUDIO_RUNTIME: '   ',
    OMO_HERDR_DAG_STUDIO_NODE: ' /custom/node ',
    HERDR_BIN_PATH: '  /custom/herdr  ',
    HERDR_ENV: '1',
    HERDR_PANE_ID: '',
    HERDR_SOCKET_PATH: '/tmp/socket',
  });
  assert.equal(env.runtime, '/custom/node');
  assert.equal(env.herdrBinPath, '/custom/herdr');
  assert.equal(env.herdrEnabled, true);
  assert.equal(env.herdrPaneId, '');
  assert.equal(env.herdrSocketPath, '/tmp/socket');
  assert.equal(readEnv({ HERDR_ENV: 'true' }).herdrEnabled, false);
});

test('viewer runtime falls back to the NODE alias when RUNTIME is blank', async () => {
  const calls = [];
  const run = async command => {
    calls.push(command);
    return { stdout: probe({ path: '/custom/node' }) };
  };
  assert.equal(await resolveViewerRuntime({
    env: { OMO_HERDR_DAG_STUDIO_RUNTIME: '  ', OMO_HERDR_DAG_STUDIO_NODE: ' /custom/node ' },
    execPath: '/usr/bin/node',
    run,
  }), '/custom/node');
  assert.deepEqual(calls, ['/custom/node']);
});

test('falls back to Node 24 and rejects older runtimes', async () => {
  const oldRun = async command => {
    if (command === 'bun') throw new Error('missing');
    return { stdout: probe() };
  };
  assert.equal(await resolveViewerRuntime({ env: {}, execPath: '/usr/bin/node', run: oldRun }), '/usr/bin/node');

  const unsupported = async command => ({
    stdout: probe(command === 'bun'
      ? { bun: '1.2.0', path: '/usr/bin/bun' }
      : { node: '20.11.0' }),
  });
  await assert.rejects(
    resolveViewerRuntime({ env: {}, execPath: '/usr/bin/node', run: unsupported }),
    /Bun 1\.4\+ or Node\.js 24\+/,
  );
});

test('accepts a runtime version with only a major component', async () => {
  const majorOnly = async command => ({
    stdout: probe(command === 'bun'
      ? { bun: '2', path: '/usr/bin/bun' }
      : { node: '24', path: '/usr/bin/node' }),
  });
  assert.equal(await resolveViewerRuntime({ env: {}, execPath: '/usr/bin/node', run: majorOnly }), '/usr/bin/bun');

  const nodeOnly = async command => {
    if (command === 'bun') throw new Error('missing');
    return { stdout: probe({ node: '24' }) };
  };
  assert.equal(await resolveViewerRuntime({ env: {}, execPath: '/usr/bin/node', run: nodeOnly }), '/usr/bin/node');

  const tooOld = async command => {
    if (command === 'bun') throw new Error('missing');
    return { stdout: probe({ node: '23' }) };
  };
  await assert.rejects(
    resolveViewerRuntime({ env: {}, execPath: '/usr/bin/node', run: tooOld }),
    /Bun 1\.4\+ or Node\.js 24\+/,
  );
});

test('herdr quoting produces exact POSIX and win32 command strings', () => {
  assert.equal(quote("it's"), "'it'\\''s'");
  assert.equal(quote(''), "''");
  assert.equal(quote('/tmp/a b'), "'/tmp/a b'");
  const args = ['/opt/herd er/bin/herdr', 'pane', '--pane', 'p 1', "it's", ''];
  assert.equal(shellCommand(args, 'linux'),
    "'/opt/herd er/bin/herdr' 'pane' '--pane' 'p 1' 'it'\\''s' ''");
  assert.equal(shellCommand(args, 'win32'),
    "& '/opt/herd er/bin/herdr' 'pane' '--pane' 'p 1' 'it''s' ''");
});

test('herdr discovery rejects non-executable files and falls back to PATH', t => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-discovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'herdr');
  writeFileSync(bin, '#!/bin/sh\n');
  if (process.platform !== 'win32') {
    chmodSync(bin, 0o644);
    assert.equal(resolveHerdrBin({ PATH: dir }, 'linux'), null);
  }
  chmodSync(bin, 0o755);
  assert.equal(resolveHerdrBin({ PATH: dir }, 'linux'), bin);
  assert.equal(resolveHerdrBin({ PATH: '/missing', HERDR_BIN_PATH: bin }, 'linux'), bin);
  assert.equal(resolveHerdrBin({ PATH: '/missing', HERDR_BIN_PATH: `  ${bin}  ` }, 'linux'), bin);
  assert.equal(resolveHerdrBin({ PATH: dir, HERDR_BIN_PATH: join(dir, 'stale') }, 'linux'), bin);
});

test('herdrSession falls back to PATH when HERDR_BIN_PATH is stale', t => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-session-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'herdr');
  writeFileSync(bin, '#!/bin/sh\n');
  chmodSync(bin, 0o755);
  const socket = join(dir, 'herdr.sock');
  writeFileSync(socket, '');
  const env = {
    HERDR_ENV: '1', HERDR_PANE_ID: 'pane-1', HERDR_SOCKET_PATH: socket,
    HERDR_BIN_PATH: join(dir, 'stale-herdr'), PATH: dir,
  };
  assert.equal(herdrSession(env, 'linux'), true);
  assert.equal(herdrSession({ ...env, PATH: '/missing' }, 'linux'), false);
  assert.equal(herdrSession({ ...env, HERDR_SOCKET_PATH: join(dir, 'missing.sock') }, 'linux'), false);
  assert.equal(herdrSession({ ...env, HERDR_ENV: 'true' }, 'linux'), false);
  assert.equal(herdrSession({ ...env, HERDR_ENV: '01' }, 'linux'), false);
});

test('createHerdr invokes the resolved binary and parses its reply', async t => {
  if (process.platform === 'win32') return t.skip('POSIX shell fixture');
  const dir = mkdtempSync(join(tmpdir(), 'herdr-create-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'herdr');
  const argsFile = join(dir, 'args.txt');
  writeFileSync(bin, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
    'case "$2" in',
    '  fail) printf \'{"error":{"message":"boom"}}\' ;;',
    '  empty) : ;;',
    '  *) printf \'{"result":{"ok":true}}\' ;;',
    'esac',
  ].join('\n'));
  chmodSync(bin, 0o755);
  const herdr = createHerdr({ PATH: dir });
  assert.deepEqual(await herdr('list'), { ok: true });
  assert.deepEqual(readFileSync(argsFile, 'utf8').trim().split('\n'), ['pane', 'list']);
  await assert.rejects(herdr('fail'), /boom/);
  assert.deepEqual(await herdr('empty'), {});
});
