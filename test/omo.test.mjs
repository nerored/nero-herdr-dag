import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadOmoAppearance, loadOmoTheme, omoAgentDir } from '../src/omo.mjs';

async function temporaryAgentDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nero-herdr-dag-omo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the studio follows the theme setting in OmO', async t => {
  const dir = await temporaryAgentDir(t);
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ theme: 'grok-night' }));
  assert.equal(await loadOmoTheme({ env: { OMO_CODING_AGENT_DIR: dir } }), 'grok-night');
});

test('unsupported or missing OmO themes fall back to system', async t => {
  const dir = await temporaryAgentDir(t);
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ theme: 'midnight' }));
  assert.equal(await loadOmoTheme({ env: { OMO_CODING_AGENT_DIR: dir } }), 'system');
  assert.equal(await loadOmoTheme({ env: { OMO_CODING_AGENT_DIR: join(dir, 'missing') } }), 'system');
});

test('empty or whitespace agent directory variables fall back to the OmO home', () => {
  assert.equal(omoAgentDir({ OMO_CODING_AGENT_DIR: '', SENPI_CODING_AGENT_DIR: '' }), join(homedir(), '.omo', 'agent'));
  assert.equal(omoAgentDir({ OMO_CODING_AGENT_DIR: '   ', SENPI_CODING_AGENT_DIR: '\t' }), join(homedir(), '.omo', 'agent'));
  assert.equal(omoAgentDir({ OMO_CODING_AGENT_DIR: '  /tmp/agent  ' }), '/tmp/agent');
  assert.equal(omoAgentDir({ OMO_CODING_AGENT_DIR: ' ', SENPI_CODING_AGENT_DIR: '/tmp/senpi' }), '/tmp/senpi');
});

test('the OmO settings override uses the studio name and keeps the old alias', async t => {
  const dir = await temporaryAgentDir(t);
  const current = join(dir, 'studio-settings.json');
  const legacy = join(dir, 'legacy-settings.json');
  await writeFile(current, JSON.stringify({ theme: 'grok-night' }));
  await writeFile(legacy, JSON.stringify({ theme: 'dark' }));
  assert.equal(await loadOmoTheme({ env: { OMO_HERDR_DAG_STUDIO_OMO_SETTINGS: current } }), 'grok-night');
  assert.equal(await loadOmoTheme({ env: { NERO_HERDR_DAG_OMO_SETTINGS: legacy } }), 'dark');
  assert.equal(await loadOmoTheme({
    env: { OMO_HERDR_DAG_STUDIO_OMO_SETTINGS: current, NERO_HERDR_DAG_OMO_SETTINGS: legacy },
  }), 'grok-night');
});

test("OmO's cached terminal appearance wins, COLORFGBG is the fallback", async t => {
  const dir = await temporaryAgentDir(t);
  await mkdir(join(dir, 'cache'), { recursive: true });
  await writeFile(join(dir, 'cache', 'terminal-theme.json'), JSON.stringify({ terminalTheme: 'light' }));
  assert.equal(await loadOmoAppearance({ env: { OMO_CODING_AGENT_DIR: dir, COLORFGBG: '15;0' } }), 'light');

  const empty = await temporaryAgentDir(t);
  assert.equal(await loadOmoAppearance({ env: { OMO_CODING_AGENT_DIR: empty, COLORFGBG: '15;0' } }), 'dark');
  assert.equal(await loadOmoAppearance({ env: { OMO_CODING_AGENT_DIR: empty, COLORFGBG: '0;15' } }), 'light');
});
