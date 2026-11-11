import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../extension.mjs';

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
