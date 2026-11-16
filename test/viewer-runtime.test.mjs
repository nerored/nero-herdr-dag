import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VIEWER_CLOSE_STEPS, closeViewer, createViewerRuntime,
} from '../src/viewer-runtime.mjs';
import { createTestViewer, withTestTimeout } from './helpers.mjs';

const stateSnapshot = {
  version: 3,
  sessionId: 'close-order-session',
  mode: 'live',
  connected: true,
  runs: [{
    id: 'run',
    name: 'Run',
    status: 'running',
    nodes: [{ id: 'node', label: 'node', state: 'running' }],
    edges: [],
  }],
  tasks: [],
};

test('closeViewer runs the documented teardown steps in order', async () => {
  const calls = [];
  const steps = Object.fromEntries(VIEWER_CLOSE_STEPS.map(name => [
    name,
    async () => { calls.push(name); },
  ]));
  await closeViewer(steps);
  assert.deepEqual(calls, [
    'timers', 'watcher', 'pager', 'pendingWrites', 'terminal', 'closePane', 'exit',
  ]);
});

test('viewer.close tears down watcher and pager, flushes writes, then restores and exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'viewer-runtime-'));
  const statePath = join(dir, 'snapshot.json');
  const recordPath = join(dir, 'record.json');
  writeFileSync(statePath, JSON.stringify(stateSnapshot));
  writeFileSync(recordPath, '{"text":"record"}');
  const events = [];
  const exits = [];
  let spawnedChild;
  let spawnResolve;
  const spawnReady = new Promise(resolve => { spawnResolve = resolve; });
  let resolvePagerKilled;
  const pagerKilled = new Promise(resolve => { resolvePagerKilled = resolve; });

  const watcher = new EventEmitter();
  watcher.close = () => events.push('watcher');

  let releaseSave;
  const savePending = new Promise(resolve => {
    releaseSave = () => {
      events.push('save');
      resolve();
    };
  });
  const spawnFn = (command, args) => {
    const child = new EventEmitter();
    child.kill = signal => {
      if (signal === 'SIGTERM') events.push('pager');
      queueMicrotask(() => child.emit('exit', 0, signal));
      resolvePagerKilled();
    };
    child.command = command;
    child.args = args;
    spawnedChild = child;
    spawnResolve(child);
    return child;
  };

  const stdout = {
    isTTY: true,
    write: text => {
      if (text.includes('\x1b[?1049l')) events.push('terminal');
    },
  };
  const { viewer } = await createTestViewer({
    args: { statePath, interactive: true, once: false, noColor: true, noMotion: true, fps: 60 },
    deps: {
      stdout,
      write: () => {},
      exit: code => { events.push('exit'); exits.push(code); },
      watch: () => watcher,
      readStateFile: async () => stateSnapshot,
      loadViewState: async (_path, sessionId) => ({ version: 1, sessionId, expanded: {} }),
      saveViewState: () => savePending,
      pagerCommand: () => ({ command: 'cat', args: [] }),
      spawn: spawnFn,
    },
  });

  try {
    viewer.setupFileWatch();
    const loaded = await viewer.loadState(true);
    assert.equal(loaded.kind, 'ok');
    assert.equal(viewer.ui.selectedNodeId, 'node', 'the fixture selects a foldable graph node');
    viewer.handleKey(' ');

    const opening = viewer.openRecordInPager(recordPath);
    await withTestTimeout(spawnReady, 1_000, 'pager did not spawn');
    assert.equal(typeof spawnedChild.kill, 'function');
    events.length = 0;

    const closing = viewer.close({ code: 9 });
    await withTestTimeout(pagerKilled, 1_000, 'close did not terminate the pager');
    assert.deepEqual(events.slice(0, 2), ['watcher', 'pager'],
      'watch teardown precedes the pager kill');
    releaseSave();
    await closing;
    assert.deepEqual(events, ['watcher', 'pager', 'save', 'terminal', 'exit'],
      'pending writes flush before terminal restore, and exit is last');
    assert.deepEqual(exits, [9], 'exit receives the requested code');
    await opening;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime close clears a pending frame timer and the watch retry timer', async () => {
  let draws = 0;
  const events = [];
  const source = {
    clearTimers: () => events.push('timers'),
    closeWatcher: () => events.push('watcher'),
  };
  const session = {
    ui: { motion: true, runIndex: 0, language: 'en' },
    snapshot: null,
    helpFrameDrawn: false,
    addToast: () => {},
    flushPendingWrites: async () => { events.push('pendingWrites'); },
  };
  const runtime = createViewerRuntime({
    session,
    source,
    draw: () => { draws++; },
    interactive: false,
    fps: 60,
    terminalWidth: () => 120,
    terminalHeight: () => 40,
    exitFn: () => { events.push('exit'); },
  });

  runtime.requestFrame();
  await runtime.close();
  assert.deepEqual(events, ['timers', 'watcher', 'pendingWrites', 'exit']);

  // The frame timer was scheduled for 0ms; a leaked timer would draw here.
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(draws, 0, 'close cleared the pending frame timer');
});

test('close clears the watch retry timer so a dead watch cannot re-arm', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'viewer-watch-leak-'));
  const statePath = join(dir, 'snapshot.json');
  writeFileSync(statePath, JSON.stringify(stateSnapshot));
  const watchers = [];
  const watchFn = () => {
    const watcher = new EventEmitter();
    watcher.close = () => { watcher.closed = true; };
    watchers.push(watcher);
    return watcher;
  };
  const { viewer } = await createTestViewer({
    args: { statePath, once: true, noColor: true, noMotion: true, fps: 10 },
    deps: {
      watch: watchFn,
      watchRetryBaseMs: 5,
      readStateFile: async () => stateSnapshot,
      loadViewState: async (_path, sessionId) => ({ version: 1, sessionId, expanded: {} }),
    },
  });
  try {
    viewer.setupFileWatch();
    assert.equal(watchers.length, 1);
    watchers[0].emit('error', new Error('ENOSPC: no space left'));
    await viewer.close({ code: 0 });
    assert.equal(watchers[0].closed, true, 'the watcher was closed');
    // The retry delay is 5ms; three intervals prove the timer was cleared.
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(watchers.length, 1, 'no retry watch was installed after close');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
