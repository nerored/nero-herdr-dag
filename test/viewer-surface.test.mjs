import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createViewer } from '../src/viewer.mjs';
import { renderApp } from '../src/render.mjs';
import { createTheme, paletteFor, supportsTruecolor } from '../src/theme.mjs';
import { serializeFrame } from './frame-fixtures.mjs';

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

test('a zero-orphan session frame is byte-identical to the raw direct render', async () => {
  const frozen = Date.UTC(2026, 10, 16, 12, 0, 0);
  const dir = await mkdtemp(join(tmpdir(), 'viewer-zero-orphan-'));
  const statePath = join(dir, 'snapshot.json');
  const zeroOrphan = liveSnapshot('zero-orphan-session', 'plain node');
  zeroOrphan.runs[0].nodes[0].task_id = 'surface_task';
  zeroOrphan.tasks = [{ id: 'surface_task', description: 'surface task', status: 'running' }];
  await writeFile(statePath, JSON.stringify(zeroOrphan));
  const viewer = await createViewer(
    { statePath, once: true, width: 120, height: 40, noColor: true, noMotion: true, fps: 10 },
    {
      loadConfig: async () => ({ language: 'en' }),
      loadOmoTheme: async () => 'system',
      loadOmoAppearance: async () => ({}),
      write: () => {},
      exit: () => {},
      columns: 120,
      rows: 40,
      now: () => frozen,
    },
  );

  try {
    assert.equal((await viewer.loadState(true)).kind, 'ok');
    viewer.ui.follow = false;

    // The raw and visible snapshots are the same object when there is nothing
    // to hide and nothing to group: no virtual run is fabricated.
    assert.equal(viewer.snapshot, viewer.fullSnapshot);
    assert.equal(viewer.snapshot.runs.length, 1);
    assert.equal(viewer.snapshot.runs.some(run => run.virtual), false);

    const realNow = Date.now;
    Date.now = () => frozen;
    try {
      viewer.draw();
    } finally {
      Date.now = realNow;
    }

    const appearance = {};
    const palette = paletteFor('system', { appearance });
    const theme = createTheme({ palette, color: false, truecolor: supportsTruecolor() });
    const direct = renderApp(viewer.fullSnapshot, viewer.ui, {
      width: 120, height: 40, time: 0, now: frozen, palette, theme,
    });
    const meta = { surface: 'zero-orphan', language: 'en', width: 120, height: 40 };
    assert.deepEqual(
      serializeFrame(viewer.lastRender, meta),
      serializeFrame(direct, meta),
      'the visible session frame must not differ from the raw direct render',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
