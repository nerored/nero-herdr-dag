import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import extension, { installLocation } from '../extension.mjs';
import { inspectLayout } from '../scripts/install-lib.mjs';
import { viewKey } from '../src/controller.mjs';
import { generationPointer, integrationDirectory } from '../src/layout.mjs';

const fixtureBin = `#!/bin/sh
case "$2" in
  get) printf '%s\\n' '{"result":{"pane":{"pane_id":"viewer-old","tab_id":"t1","label":"DAG Studio · old"}}}' ;;
  list) printf '%s\\n' '{"result":{"panes":[{"pane_id":"parent","tab_id":"t1"},{"pane_id":"viewer-old","tab_id":"t1","label":"DAG Studio · old"}]}}' ;;
  *) printf '%s\\n' '{"result":{}}' ;;
esac
`;

// Build the tree scripts/install.mjs actually publishes: the module runs from
// integration/generation-NNNNNN and current.json sits in the integration
// directory beside it. `pointer: null` reproduces a pointer that was never
// written. Returns the notices raised while /dag-studio is opened twice.
async function runInstalled(t, {
  pointer = { generation: 'generation-000002' },
  paneGeneration = pointer?.generation,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dag-extension-generation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'herdr');
  writeFileSync(bin, fixtureBin);
  chmodSync(bin, 0o755);
  const socket = join(dir, 'herdr.sock');
  writeFileSync(socket, '');
  const agent = join(dir, 'agent');
  const studio = join(agent, 'herdr-dag-studio');
  const container = join(studio, 'integration');
  const generation = 'generation-000002';
  mkdirSync(join(container, generation), { recursive: true });
  if (pointer !== null) writeFileSync(generationPointer(container), JSON.stringify(pointer));
  const record = join(studio, `${viewKey(socket, 'pane-1', 'session-1')}.pane.json`);
  writeFileSync(record, JSON.stringify({
    paneId: 'viewer-old', ready: true, generation: paneGeneration,
  }));
  const moduleUrl = pathToFileURL(join(container, generation, 'extension.mjs')).href;

  const keys = ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_BIN_PATH', 'OMO_CODING_AGENT_DIR'];
  keys.push('OMO_HERDR_DAG_STUDIO_STATE_DIR');
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  delete process.env.OMO_HERDR_DAG_STUDIO_STATE_DIR;
  Object.assign(process.env, {
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'pane-1',
    HERDR_SOCKET_PATH: socket,
    HERDR_BIN_PATH: bin,
    OMO_CODING_AGENT_DIR: agent,
  });

  try {
    const handlers = new Map();
    const commands = new Map();
    const notices = [];
    const pi = {
      on(name, handler) { handlers.set(name, handler); },
      events: { on: () => () => {} },
      registerCommand(name, definition) { commands.set(name, definition); },
      cwd: dir,
    };
    const ctx = {
      mode: 'tui',
      sessionManager: {
        getSessionFile: () => join(dir, 'sessions', 'session.jsonl'),
        getSessionId: () => 'session-1',
      },
      ui: { notify: (message, level) => notices.push({ message, level }) },
    };
    extension(pi, { moduleUrl });
    await handlers.get('session_start')({}, ctx);
    await commands.get('dag-studio').handler([], ctx);
    await commands.get('dag-studio').handler([], ctx);
    await handlers.get('session_shutdown')({}, ctx);
    return { notices, record };
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('installLocation names the pointer the installer publishes', async t => {
  if (process.platform === 'win32') return t.skip('POSIX path fixture');
  const agentDir = '/agent';
  const pointer = generationPointer(integrationDirectory(agentDir));
  assert.equal(pointer, '/agent/herdr-dag-studio/integration/current.json');
  assert.deepEqual(
    installLocation(pathToFileURL(join(integrationDirectory(agentDir), 'generation-000007', 'extension.mjs')).href),
    { generation: 'generation-000007', pointer },
  );
  // The installer derives the pointer from the agent directory while the
  // installed extension derives it from its own generation directory. Both
  // must land on the file install.mjs writes.
  assert.equal((await inspectLayout(agentDir)).pointer, pointer);
  assert.deepEqual(installLocation('file:///repo/extension.mjs'), {
    generation: undefined, pointer: undefined,
  });
});

test('an installed pane from the current generation opens without a warning', async t => {
  if (process.platform === 'win32') return t.skip('POSIX executable fixture');
  const { notices } = await runInstalled(t);
  assert.deepEqual(notices, []);
});

test('the dag-studio command warns once when the live pane predates the install', async t => {
  if (process.platform === 'win32') return t.skip('POSIX executable fixture');
  const { notices, record } = await runInstalled(t, { paneGeneration: 'generation-000001' });
  const warnings = notices.filter(notice => notice.message.includes('current install'));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, 'warning');
  assert.match(warnings[0].message, /generation-000001/);
  assert.match(warnings[0].message, /generation-000002/);
  assert.deepEqual(notices.filter(notice => notice.message.includes('cannot read the install generation')), []);
  assert.equal(existsSync(record), true);
});

test('a missing generation pointer warns distinctly from a stale pane', async t => {
  if (process.platform === 'win32') return t.skip('POSIX executable fixture');
  const { notices } = await runInstalled(t, { pointer: null, paneGeneration: 'generation-000001' });
  const warnings = notices.filter(notice => notice.message.includes('cannot read the install generation'));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, 'warning');
  assert.match(warnings[0].message, /is missing/);
  assert.deepEqual(notices.filter(notice => notice.message.includes('current install')), []);
});

test('session_start skips non-TUI modes before constructing a DagPane', async t => {
  if (process.platform === 'win32') return t.skip('POSIX executable fixture');
  const dir = mkdtempSync(join(tmpdir(), 'dag-extension-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'herdr');
  writeFileSync(bin, '#!/bin/sh\n');
  chmodSync(bin, 0o755);
  const socket = join(dir, 'herdr.sock');
  writeFileSync(socket, '');
  const stateDir = join(dir, 'state');
  const ambientStateDir = mkdtempSync(join(tmpdir(), 'dag-extension-ambient-'));
  t.after(() => rmSync(ambientStateDir, { recursive: true, force: true }));

  const keys = ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_BIN_PATH', 'OMO_HERDR_DAG_STUDIO_STATE_DIR'];
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'pane-1',
    HERDR_SOCKET_PATH: socket,
    HERDR_BIN_PATH: bin,
    OMO_HERDR_DAG_STUDIO_STATE_DIR: ambientStateDir,
  });

  try {
    const handlers = new Map();
    const commands = new Map();
    const pi = {
      on(name, handler) { handlers.set(name, handler); },
      events: { on: () => () => {} },
      registerCommand(name, definition) { commands.set(name, definition); },
      cwd: dir,
    };
    extension(pi);
    assert.ok(handlers.has('session_start'));

    for (const mode of ['print', 'rpc']) {
      const notices = [];
      const ctx = {
        mode,
        sessionManager: {
          getSessionFile: () => join(dir, 'sessions', 'session.jsonl'),
          getSessionId: () => 'session-1',
        },
        ui: { notify: (message, level) => notices.push({ message, level }) },
      };
      await handlers.get('session_start')({}, ctx);
      await commands.get('dag-studio').handler([], ctx);
      assert.deepEqual(notices, [
        { message: 'DAG Studio is unavailable in this session.', level: 'warning' },
      ]);
      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(ambientStateDir), true);
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
