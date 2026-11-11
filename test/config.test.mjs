import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import {
  DEFAULT_CONFIG, DEFAULT_STALE_AFTER_MS, STALE_AFTER_ENV, configDir, configPath,
  loadConfig, saveConfig, staleAfterMs,
} from '../src/config.mjs';
import { DEFAULT_RETENTION_DAYS, ENV_NAMES, readEnv } from '../src/env.mjs';

async function temporaryEnv(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nero-herdr-dag-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { NERO_HERDR_DAG_CONFIG_DIR: dir };
}

test('config defaults to ~/.config/nero-herdr-dag/config.json', () => {
  assert.equal(configDir({}), join(homedir(), '.config', 'nero-herdr-dag'));
  assert.equal(configPath({}), join(homedir(), '.config', 'nero-herdr-dag', 'config.json'));
});

test('config directory overrides are trimmed, expanded, and resolved', () => {
  const fallback = join(homedir(), '.config', 'nero-herdr-dag');
  assert.equal(configDir({ NERO_HERDR_DAG_CONFIG_DIR: '' }), fallback);
  assert.equal(configDir({ NERO_HERDR_DAG_CONFIG_DIR: '   ' }), fallback);
  assert.equal(configPath({ NERO_HERDR_DAG_CONFIG_DIR: '\t' }), join(fallback, 'config.json'));
  assert.equal(
    configDir({ NERO_HERDR_DAG_CONFIG_DIR: `  ${resolve('relative-config-dir')}  ` }),
    resolve('relative-config-dir'),
  );
  assert.equal(
    configDir({ NERO_HERDR_DAG_CONFIG_DIR: 'relative-config-dir' }),
    resolve('relative-config-dir'),
  );
  assert.equal(
    configDir({ NERO_HERDR_DAG_CONFIG_DIR: '~/dag-config' }),
    join(homedir(), 'dag-config'),
  );
  assert.equal(
    configPath({ NERO_HERDR_DAG_CONFIG_DIR: '~/dag-config' }),
    join(homedir(), 'dag-config', 'config.json'),
  );
});

test('a missing config loads English defaults', async t => {
  const env = await temporaryEnv(t);
  assert.deepEqual(await loadConfig({ env }), DEFAULT_CONFIG);
});

test('saving a language creates the config directory and reloads it', async t => {
  const env = await temporaryEnv(t);
  const saved = await saveConfig({ language: 'zh' }, { env });
  assert.deepEqual(saved, { version: 1, language: 'zh' });
  const raw = JSON.parse(await readFile(configPath(env), 'utf8'));
  assert.deepEqual(raw, saved);
  assert.deepEqual(await loadConfig({ env }), saved);
});

test('concurrent saves serialize so both settings survive', async t => {
  const env = await temporaryEnv(t);
  const [first, second] = await Promise.all([
    saveConfig({ theme: 'grok-day' }, { env }),
    saveConfig({ language: 'zh' }, { env }),
  ]);
  assert.deepEqual(first, { version: 1, language: 'en', theme: 'grok-day' });
  assert.deepEqual(second, { version: 1, language: 'zh', theme: 'grok-day' });
  assert.deepEqual(await loadConfig({ env }), second);
});

test('a malformed config is not silently replaced by defaults', async t => {
  const env = await temporaryEnv(t);
  await mkdir(configDir(env), { recursive: true });
  await writeFile(configPath(env), '{not json');
  await assert.rejects(saveConfig({ theme: 'dark' }, { env }));
  assert.equal(await readFile(configPath(env), 'utf8'), '{not json');
  await assert.rejects(loadConfig({ env }));
});

test('a newer config version is refused instead of downgraded', async t => {
  const env = await temporaryEnv(t);
  await mkdir(configDir(env), { recursive: true });
  const future = JSON.stringify({ version: 2, language: 'zh', theme: 'grok-day' });
  await writeFile(configPath(env), future);
  await assert.rejects(loadConfig({ env }), /Unsupported config version 2/);
  await assert.rejects(saveConfig({ theme: 'dark' }, { env }), /Unsupported config version 2/);
  assert.equal(await readFile(configPath(env), 'utf8'), future);
  await writeFile(configPath(env), JSON.stringify({ version: '2', language: 'zh' }));
  await assert.rejects(loadConfig({ env }), /Unsupported config version "2"/);
});

test('a legacy config without a version migrates to version 1', async t => {
  const env = await temporaryEnv(t);
  await mkdir(configDir(env), { recursive: true });
  await writeFile(configPath(env), JSON.stringify({ language: 'zh-cn', custom: 'kept' }));
  assert.deepEqual(await loadConfig({ env }), {
    version: 1, language: 'zh', custom: 'kept',
  });
  const saved = await saveConfig({ theme: 'grok-day' }, { env });
  assert.deepEqual(saved, {
    version: 1, language: 'zh', custom: 'kept', theme: 'grok-day',
  });
});

test('a saved theme round-trips and unknown values are dropped', async t => {
  const env = await temporaryEnv(t);
  const saved = await saveConfig({ theme: 'grok-day' }, { env });
  assert.deepEqual(saved, { version: 1, language: 'en', theme: 'grok-day' });
  assert.deepEqual(await loadConfig({ env }), saved);
  await writeFile(configPath(env), JSON.stringify({ language: 'en', theme: 'midnight' }));
  assert.deepEqual(await loadConfig({ env }), { version: 1, language: 'en' });
});

test('unknown and regional language values normalize on load', async t => {
  const env = await temporaryEnv(t);
  await mkdir(configDir(env), { recursive: true });
  await writeFile(configPath(env), JSON.stringify({ language: 'zh-cn' }));
  assert.deepEqual(await loadConfig({ env }), { version: 1, language: 'zh' });
  await writeFile(configPath(env), JSON.stringify({ language: 'fr' }));
  assert.deepEqual(await loadConfig({ env }), { version: 1, language: 'en' });
});

test('the stale threshold is a documented positive env override', () => {
  assert.equal(STALE_AFTER_ENV, 'OMO_HERDR_DAG_STUDIO_STALE_MS');
  assert.equal(DEFAULT_STALE_AFTER_MS, 60_000);
  assert.equal(staleAfterMs({}), DEFAULT_STALE_AFTER_MS);
  assert.equal(staleAfterMs({ [STALE_AFTER_ENV]: '1500' }), 1500);
  assert.equal(staleAfterMs({ [STALE_AFTER_ENV]: '2.9' }), 2);
  assert.equal(staleAfterMs({ [STALE_AFTER_ENV]: 'nope' }), DEFAULT_STALE_AFTER_MS);
  assert.equal(staleAfterMs({ [STALE_AFTER_ENV]: '0' }), DEFAULT_STALE_AFTER_MS);
});

test('the shared env reader documents all eighteen variables', () => {
  assert.equal(Object.keys(ENV_NAMES).length, 18);
  assert.equal(new Set(Object.values(ENV_NAMES)).size, 18);
  assert.equal(ENV_NAMES.STALE_AFTER_MS, STALE_AFTER_ENV);
  assert.ok(Object.values(ENV_NAMES).includes('PATH'));
  assert.ok(Object.values(ENV_NAMES).includes('PAGER'));
});

test('the shared env reader preserves defaults and invalid-value policies', () => {
  const env = readEnv({});
  assert.equal(env.staleAfterMs, DEFAULT_STALE_AFTER_MS);
  assert.equal(env.retentionDays, DEFAULT_RETENTION_DAYS);
  assert.equal(env.configDir, join(homedir(), '.config', 'nero-herdr-dag'));
  assert.equal(env.agentDir, join(homedir(), '.omo', 'agent'));
  assert.equal(env.stateDir, join(homedir(), '.omo', 'agent', 'herdr-dag-studio'));
  assert.equal(env.taskStateDir, undefined);
  assert.deepEqual(env.taskStateDirs, []);
  assert.equal(env.runtime, undefined);
  assert.equal(env.omoSettings, undefined);
  assert.equal(env.herdrBinPath, undefined);
  assert.equal(env.herdrEnabled, false);
  assert.equal(env.path, '');
  assert.equal(readEnv({ [ENV_NAMES.OMO_CODING_AGENT_DIR]: '/tmp/agent' }).stateDir,
    join('/tmp/agent', 'herdr-dag-studio'));
});

test('the shared env reader parses paths, aliases, lists, and booleans', () => {
  const env = readEnv({
    [ENV_NAMES.STALE_AFTER_MS]: '2.9',
    [ENV_NAMES.RETENTION_DAYS]: 'nope',
    [ENV_NAMES.CONFIG_DIR]: '~/dag-config',
    [ENV_NAMES.OMO_CODING_AGENT_DIR]: '  /tmp/agent  ',
    [ENV_NAMES.STATE_DIR]: '',
    [ENV_NAMES.TASK_STATE_DIRS]: `/tmp/a${delimiter}  ~/b/  `,
    [ENV_NAMES.TASK_STATE_DIR]: '  ~/custom-store/  ',
    [ENV_NAMES.RUNTIME]: '   ',
    [ENV_NAMES.NODE]: ' /custom/node ',
    [ENV_NAMES.OMO_SETTINGS]: '',
    [ENV_NAMES.NERO_OMO_SETTINGS]: ' /tmp/settings.json ',
    [ENV_NAMES.HERDR_BIN_PATH]: '  /tmp/herdr  ',
    [ENV_NAMES.HERDR_ENV]: 'true',
    [ENV_NAMES.PATH]: '/bin',
    [ENV_NAMES.PAGER]: 'less',
  });
  assert.equal(env.staleAfterMs, 2);
  assert.equal(env.retentionDays, 0);
  assert.equal(env.configDir, join(homedir(), 'dag-config'));
  assert.equal(env.agentDir, '/tmp/agent');
  assert.equal(env.stateDir, '');
  assert.deepEqual(env.taskStateDirs, ['/tmp/a', join(homedir(), 'b')]);
  assert.equal(env.taskStateDir, join(homedir(), 'custom-store'));
  assert.equal(env.runtime, '/custom/node');
  assert.equal(env.omoSettings, '/tmp/settings.json');
  assert.equal(env.herdrBinPath, '/tmp/herdr');
  assert.equal(env.herdrEnabled, false);
  assert.equal(env.path, '/bin');
  assert.equal(env.pager, 'less');
});

test('scoped modules read environment variables only through the shared reader', async () => {
  const modules = [
    '../src/config.mjs', '../src/omo.mjs', '../src/retention.mjs', '../src/task-data.mjs',
    '../src/runtime.mjs', '../src/herdr.mjs', '../src/storage.mjs', '../extension.mjs',
  ];
  const directRead = /process\.env\s*\??\.\s*[A-Za-z_$]|process\.env\s*\[|\{[^}]{0,200}\}\s*=\s*process\.env|\benv\s*\??\.\s*[A-Z][A-Z0-9_]*|\benv\s*\[\s*['"][A-Z]/;
  for (const module of modules) {
    const source = await readFile(new URL(module, import.meta.url), 'utf8');
    assert.doesNotMatch(source, directRead, `${module} bypasses src/env.mjs`);
  }
});
