import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import extension, { installLocation } from '../extension.mjs';
import { viewKey } from '../src/controller.mjs';

test('installLocation only names a generation for an installed module', t => {
  if (process.platform === 'win32') return t.skip('POSIX path fixture');
  assert.deepEqual(
    installLocation('file:///agent/herdr-dag-studio/integration/generation-000007/extension.mjs'),
    { generation: 'generation-000007', pointer: '/agent/herdr-dag-studio/current.json' },
  );
  assert.deepEqual(installLocation('file:///repo/extension.mjs'), {
    generation: undefined, pointer: undefined,
  });
});

test('the dag-studio command warns once when the live pane predates the install', async t => {
  if (process.platform === 'win32') return t.skip('POSIX executable fixture');
  const dir = mkdtempSync(join(tmpdir(), 'dag-extension-generation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'herdr');
  writeFileSync(bin, `#!/bin/sh
case "$2" in
  get) printf '%s\\n' '{"result":{"pane":{"pane_id":"viewer-old","tab_id":"t1","label":"DAG Studio · old"}}}' ;;
  list) printf '%s\\n' '{"result":{"panes":[{"pane_id":"parent","tab_id":"t1"},{"pane_id":"viewer-old","tab_id":"t1","label":"DAG Studio · old"}]}}' ;;
  *) printf '%s\\n' '{"result":{}}' ;;
esac
`);
  chmodSync(bin, 0o755);
  const socket = join(dir, 'herdr.sock');
  writeFileSync(socket, '');
  const container = join(dir, 'agent', 'herdr-dag-studio');
  mkdirSync(container, { recursive: true });
  writeFileSync(join(container, 'current.json'), JSON.stringify({ generation: 'generation-000003' }));
  const record = join(container, `${viewKey(socket, 'pane-1', 'session-1')}.pane.json`);
  writeFileSync(record, JSON.stringify({
    paneId: 'viewer-old', ready: true, generation: 'generation-000001',
  }));
  const moduleUrl = pathToFileURL(
    join(container, 'integration', 'generation-000002', 'extension.mjs'),
  ).href;

  const keys = ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_BIN_PATH', 'OMO_HERDR_DAG_STUDIO_STATE_DIR'];
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'pane-1',
    HERDR_SOCKET_PATH: socket,
    HERDR_BIN_PATH: bin,
    OMO_HERDR_DAG_STUDIO_STATE_DIR: container,
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

    const warnings = notices.filter(notice => notice.message.includes('current install'));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, 'warning');
    assert.match(warnings[0].message, /generation-000001/);
    assert.match(warnings[0].message, /generation-000003/);
    assert.equal(existsSync(record), true);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

  const keys = ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_BIN_PATH', 'OMO_HERDR_DAG_STUDIO_STATE_DIR'];
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'pane-1',
    HERDR_SOCKET_PATH: socket,
    HERDR_BIN_PATH: bin,
    OMO_HERDR_DAG_STUDIO_STATE_DIR: stateDir,
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
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
