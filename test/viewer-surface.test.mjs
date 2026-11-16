import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createViewer } from '../src/viewer.mjs';

// The viewer is a published contract: embedders and the bundled CLI call these
// names, and the staged session/input/runtime split must not rename, drop, or
// turn one into the other. This is an exact inventory, not a subset check.
const PUBLIC_SURFACE = Object.freeze({
  acceptSnapshot: 'value',
  close: 'value',
  confirmSwitcher: 'value',
  draw: 'value',
  ensureSelection: 'value',
  flushPendingWrites: 'value',
  fullSnapshot: 'getter',
  graphLayoutCacheStats: 'getter',
  handleKey: 'value',
  lastRender: 'getter',
  loadState: 'value',
  onMouseEvent: 'value',
  onRawInput: 'value',
  openRecordInPager: 'value',
  openSwitcher: 'value',
  options: 'value',
  restoreTerminal: 'value',
  selectAt: 'value',
  setupFileWatch: 'value',
  snapshot: 'getter',
  start: 'value',
  ui: 'value',
});

function surfaceOf(viewer) {
  return Object.fromEntries(Reflect.ownKeys(viewer).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(viewer, key);
    return [key, typeof descriptor.get === 'function' ? 'getter' : 'value'];
  }));
}

function liveSnapshot(sessionId, label) {
  return {
    version: 3,
    sessionId,
    mode: 'live',
    connected: true,
    runs: [{
      id: 'run_surface',
      name: 'surface run',
      status: 'running',
      nodes: [{ id: 'surface_node', label, state: 'running' }],
      edges: [],
    }],
    tasks: [],
  };
}

test('the viewer public surface and session lifecycle survive the module split', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viewer-surface-'));
  const statePath = join(dir, 'snapshot.json');
  await writeFile(statePath, JSON.stringify(liveSnapshot('surface-session', 'surface node')));
  const written = [];
  const exits = [];
  const viewer = await createViewer(
    { statePath, once: true, width: 120, height: 40, noColor: true, noMotion: true, fps: 10 },
    {
      loadConfig: async () => ({ language: 'en' }),
      loadOmoTheme: async () => 'system',
      loadOmoAppearance: async () => ({}),
      write: text => written.push(text),
      exit: code => exits.push(code),
      columns: 120,
      rows: 40,
    },
  );

  try {
    assert.deepEqual(surfaceOf(viewer), PUBLIC_SURFACE);

    const loaded = await viewer.loadState(true);
    assert.equal(loaded.kind, 'ok');
    assert.equal(viewer.snapshot?.sessionId, 'surface-session');
    assert.equal(viewer.fullSnapshot?.sessionId, 'surface-session');

    written.length = 0;
    viewer.draw();
    const frame = written.join('');
    assert.match(frame, /surface node/, 'draw paints the accepted snapshot');
    assert.equal(viewer.lastRender?.run?.id, 'run_surface');

    viewer.handleKey('?', { sequence: '?', name: '?' });
    assert.equal(viewer.ui.help, true, 'handleKey opens Help');
    viewer.handleKey('\x1b', { name: 'escape' });
    assert.equal(viewer.ui.help, false, 'handleKey closes Help');

    assert.equal(viewer.acceptSnapshot(liveSnapshot('next-session', 'next node'), { silent: true }), true);
    assert.equal(viewer.snapshot?.sessionId, 'next-session', 'acceptSnapshot updates the session snapshot');
    assert.equal(viewer.fullSnapshot?.sessionId, 'next-session');

    await viewer.close();
    assert.deepEqual(exits, [0], 'close exits once with the requested code');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
