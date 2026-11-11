import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoEngine } from '../src/demo.mjs';
import { computeLayout } from '../src/graph.mjs';
import { normalizeSnapshot } from '../src/model.mjs';
import { renderApp } from '../src/render.mjs';
import { keyboardScrollTarget } from '../src/scroll.mjs';
import { createTheme, paletteAt } from '../src/theme.mjs';
import { width as textWidth } from '../src/text.mjs';
import {
  applyFocusRequest, applyHelpScroll, advanceScroll, boundSnapshotInput, chromeActionAt, createViewer,
  detailsVerboseAvailable, dutyFocusForKey, failedReadPlaceholder, focusForStructural,
  footerActionAt, frameIntervalMs, framePacingFps, helpKeyAction, helpScrollForKey, helpScrollMetrics,
  helpViewportRows, keyboardScrollIntent, loadInitialSnapshot, needsAnimationFrame, nextFrameDeadline,
  pruneHiddenSubjects, readFailureEvidence, readStateFile, runFooterAction, sanitizePagerText,
  scrollRegionForFocus, settingsHotkey, SNAPSHOT_LIMITS, terminalRestoreSequence,
  viewSessionKey, ViewerSnapshotError, watchRetryDelay,
} from '../src/viewer.mjs';

const now = 1_000_000;
const palette = paletteAt(0);
const theme = createTheme({ palette, color: false });
const sessionId = 'c0ffee00-1234-5678-9abc-def012345678';
const baseUi = {
  runIndex: 0, focus: 'graph', lastFocus: 'graph',
  selectedNodeId: 'api', selectedTaskId: 'st_api',
  follow: false, motion: false, help: false, verbose: false, folded: new Set(),
  graphScroll: 0, graphScrollTarget: 0, manualScroll: false, sidebar: true,
  language: 'en', fps: 60, toasts: [],
};

function oneNode(state, percent, { error } = {}) {
  return normalizeSnapshot({
    version: 2,
    sessionId,
    connected: true,
    updatedAt: '2026-11-10T00:00:00Z',
    runs: [{
      id: 'run',
      name: 'Run',
      status: state === 'completed' ? 'completed' : 'running',
      createdAt: '2026-11-10T00:00:00Z',
      nodes: [{ id: 'api', label: 'api', state, percent, task_id: 'st_api' }],
      edges: [],
    }],
    tasks: [{ id: 'st_api', description: 'api task', status: state, percent, error }],
  });
}

function demoSnapshot() {
  return normalizeSnapshot(JSON.parse(readFileSync(
    new URL('../demo/snapshot.json', import.meta.url), 'utf8',
  )));
}

async function withTestTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function newViewer({ statePath = '/tmp/dag-viewer-state.json', options = {}, deps = {} } = {}) {
  const exits = [];
  const written = [];
  const viewer = await createViewer({
    statePath,
    once: true,
    interactive: false,
    noColor: true,
    ...options,
  }, {
    loadConfig: async () => ({}),
    loadOmoTheme: async () => 'system',
    loadOmoAppearance: async () => ({}),
    readStateFile: async () => ({ version: 3, mode: 'live', connected: true, runs: [], tasks: [] }),
    loadViewState: async (_path, sessionId) => ({ version: 1, sessionId, expanded: {} }),
    saveViewState: async () => {},
    write: text => written.push(text),
    exit: code => exits.push(code),
    ...deps,
  });
  return { viewer, exits, written };
}

async function stopChild(child) {
  if (typeof child.exitCode === 'number' || typeof child.signalCode === 'number') return;
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  const exited = await withTestTimeout(
    child.exited.then(() => true), 1_000, 'viewer did not exit after SIGTERM',
  ).catch(() => false);
  if (exited) return;
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  const killed = await withTestTimeout(
    child.exited.then(() => true), 1_000, 'viewer did not exit after SIGKILL',
  ).catch(() => false);
  assert.equal(killed, true, 'viewer survived SIGKILL');
}

test('a cached layout binds current nodes without mutating its boxes', () => {
  const before = oneNode('running', 4);
  const after = oneNode('completed', 100);
  const freshA = renderApp(before, baseUi, {
    width: 140, height: 42, time: 1000, now, palette, theme,
  });
  const cachedLayout = freshA.graph.layout;
  assert.equal(cachedLayout.boxes.get('api').node.state, 'running');
  assert.equal(cachedLayout.boxes.get('api').node.percent, 4);

  const cached = renderApp(after, baseUi, {
    width: 140, height: 42, time: 1000, now, palette, theme,
    graphLayout: cachedLayout,
  });
  const fresh = renderApp(after, baseUi, {
    width: 140, height: 42, time: 1000, now, palette, theme,
  });

  assert.equal(cached.graph.layout.boxes.get('api').node.state, 'completed');
  assert.equal(cached.graph.layout.boxes.get('api').node.percent, 100);
  assert.equal(cached.text, fresh.text);
  // The caller's cache keeps the geometry it was built from.
  assert.equal(cachedLayout.boxes.get('api').node.state, 'running');
  assert.equal(cachedLayout.boxes.get('api').node.percent, 4);
});

test('a 54-column header keeps the brand and truncates a UUID session id', () => {
  const empty = normalizeSnapshot({
    version: 2, sessionId, connected: true, updatedAt: '2026-11-10T00:00:00Z',
    runs: [], tasks: [],
  });
  const result = renderApp(empty, baseUi, {
    width: 54, height: 20, time: 1000, now, palette, theme,
  });
  const lines = result.text.split('\n');
  assert.equal(lines.length, 20);
  for (const line of lines) assert.equal(textWidth(line), 54, `line width: ${textWidth(line)}`);
  const header = lines[0];
  assert.match(header, /v0\.1\.0/);
  assert.doesNotMatch(header, new RegExp(sessionId));
  assert.match(header, /…/);
  assert.ok(header.indexOf('v0.1.0') < header.indexOf('● LIVE'));
  // The clock is dropped at this width.
  assert.doesNotMatch(header, /\b\d{2}:\d{2}:\d{2}\b/);
});

test('the CLI --once frame keeps the 54-column brand and hides the full UUID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-ui-'));
  const statePath = join(dir, 'snapshot.json');
  writeFileSync(statePath, JSON.stringify({
    version: 2, sessionId, connected: true,
    updatedAt: '2026-11-10T00:00:00Z', runs: [], tasks: [],
  }));
  try {
    const run = spawnSync(process.execPath, [
      'src/viewer.mjs', '--state', statePath, '--once',
      '--no-color', '--no-motion', '--width', '54', '--height', '20',
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.split('\n');
    assert.match(lines[0], /v0\.1\.0/);
    assert.doesNotMatch(lines[0], new RegExp(sessionId));
    for (const line of lines.slice(0, 20)) {
      assert.ok(textWidth(line) <= 54, `CLI line width: ${textWidth(line)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a narrow frame truncates a long CJK run title without runaway growth', { timeout: 10_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-cjk-'));
  const statePath = join(dir, 'snapshot.json');
  const title = '中文标题'.repeat(400);
  writeFileSync(statePath, JSON.stringify({
    version: 2, sessionId, connected: true, updatedAt: '2026-11-10T00:00:00Z',
    runs: [{
      id: 'run', name: title, todoTitle: title, status: 'completed',
      createdAt: '2026-11-10T00:00:00Z',
      nodes: [{ id: 'api', label: 'api', state: 'completed', percent: 100 }],
      edges: [],
    }],
    tasks: [],
  }));
  try {
    const run = spawnSync(process.execPath, [
      'src/viewer.mjs', '--state', statePath, '--once',
      '--no-color', '--no-motion', '--width', '54', '--height', '20',
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 5_000 });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    assert.match(run.stdout, /DAG STUDIO/);
    const lines = run.stdout.split('\n');
    for (const line of lines.slice(0, 20)) {
      assert.equal(textWidth(line), 54, `CJK header line width: ${textWidth(line)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watch mode keeps painting a long CJK run at 54 columns', { timeout: 10_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-watch-cjk-'));
  const statePath = join(dir, 'snapshot.json');
  const title = '中文标题'.repeat(400);
  writeFileSync(statePath, JSON.stringify({
    version: 2, sessionId, connected: true, updatedAt: '2026-11-10T00:00:00Z',
    runs: [{
      id: 'run', name: title, todoTitle: title, status: 'completed',
      createdAt: '2026-11-10T00:00:00Z',
      nodes: [{ id: 'api', label: 'api', state: 'completed', percent: 100 }],
      edges: [],
    }],
    tasks: [],
  }));
  let output = '';
  let resolveTwoFrames;
  const twoFrames = new Promise(resolve => { resolveTwoFrames = resolve; });
  const child = Bun.spawn([
    process.execPath, 'src/viewer.mjs', '--state', statePath, '--pane',
    '--no-color', '--fps', '5',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, NERO_HERDR_DAG_CONFIG_DIR: join(dir, 'config') },
    terminal: {
      cols: 54,
      rows: 20,
      data(_terminal, chunk) {
        output += new TextDecoder().decode(chunk);
        if ((output.match(/DAG STUDIO/g) ?? []).length >= 2) resolveTwoFrames();
      },
    },
  });
  t.after(async () => {
    await stopChild(child);
    rmSync(dir, { recursive: true, force: true });
  });
  try {
    const painted = await withTestTimeout(
      twoFrames.then(() => true), 4_000, `watch frame timeout; tail: ${output.slice(-600)}`,
    ).catch(() => false);
    assert.equal(painted, true, `watch frame timeout; tail: ${output.slice(-600)}`);
    assert.match(output, /DAG STUDIO/);
  } finally {
    await stopChild(child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('task details render the error section after activity', () => {
  // L2 owns normalization; this lane renders the field once it is present.
  const snapshot = oneNode('failed', 100);
  snapshot.tasks[0].error = 'boom failure';
  const result = renderApp(snapshot, { ...baseUi, focus: 'tasks' }, {
    width: 140, height: 60, time: 0, now, palette, theme,
  });
  const lines = result.text.split('\n');
  assert.match(result.text, /ERROR/);
  assert.match(result.text, /boom failure/);
  const heading = label => lines.findIndex(line => line.includes(label));
  assert.ok(heading('METRICS') >= 0);
  assert.ok(heading('METRICS') < heading('ERROR'));
});

test('keyboardScrollTarget maps line, page, and edge keys to the focused region', () => {
  assert.deepEqual(keyboardScrollTarget('j', 'graph'), { region: 'graph', delta: 1 });
  assert.deepEqual(keyboardScrollTarget('\x1b[A', 'graph'), { region: 'graph', delta: -1 });
  assert.deepEqual(keyboardScrollTarget('j', 'tasks'), { region: 'tasks', delta: 1 });
  assert.deepEqual(keyboardScrollTarget('k', 'details'), { region: 'details', delta: -1 });
  assert.deepEqual(
    keyboardScrollTarget('\x1b[6~', 'details', { pageSize: 9 }),
    { region: 'details', delta: 9 },
  );
  assert.deepEqual(
    keyboardScrollTarget('PageUp', 'tasks', { pageSize: 4 }),
    { region: 'tasks', delta: -4 },
  );
  assert.deepEqual(
    keyboardScrollTarget('Home', 'details', { maxScroll: 12 }),
    { region: 'details', delta: -12 },
  );
  assert.deepEqual(
    keyboardScrollTarget('End', 'tasks', { maxScroll: 12 }),
    { region: 'tasks', delta: 12 },
  );
  assert.deepEqual(
    keyboardScrollTarget('G', 'details', { maxScroll: 7 }),
    { region: 'details', delta: 7 },
  );
  assert.deepEqual(
    keyboardScrollTarget('g', 'graph', { maxScroll: 7 }),
    { region: 'graph', delta: -7 },
  );
  assert.equal(keyboardScrollTarget('x', 'details'), null);
});

test('details focus keeps its task subject and paints the focused border', () => {
  const snapshot = oneNode('running', 42);
  const unfocused = renderApp(snapshot, { ...baseUi, focus: 'graph' }, {
    width: 140, height: 42, time: 0, now, palette, theme,
  });
  const focused = renderApp(snapshot, {
    ...baseUi, focus: 'details', lastFocus: 'tasks',
  }, {
    width: 140, height: 42, time: 0, now, palette, theme,
  });
  const rect = focused.layout.details;
  assert.equal(focused.canvas.cell(rect.x, rect.y).fg, palette.borderHot);
  assert.equal(unfocused.canvas.cell(rect.x, rect.y).fg, palette.border);
  assert.match(focused.text, /TASK · st_api/);
  assert.match(unfocused.text, /NODE · api/);
});

test('footer fps reflects the effective loop rate, including no-motion 1fps', () => {
  const snapshot = oneNode('running', 42);
  const still = renderApp(snapshot, { ...baseUi, fps: 1 }, {
    width: 140, height: 42, time: 0, now, palette, theme,
  });
  const moving = renderApp(snapshot, { ...baseUi, fps: 60 }, {
    width: 140, height: 42, time: 0, now, palette, theme,
  });
  assert.match(still.text, /1fps/);
  assert.doesNotMatch(still.text, /60fps/);
  assert.match(moving.text, /60fps/);
  // The frame counter was diagnostic noise; only the effective rate belongs here.
  assert.doesNotMatch(moving.text.split('\n').at(-1), /\btick\b/i);
});

test('a layout computed for another width is still a valid render input', () => {
  const snapshot = oneNode('completed', 100);
  const layout = computeLayout(snapshot.runs[0], 40);
  const result = renderApp(snapshot, baseUi, {
    width: 120, height: 40, time: 0, now, palette, theme, graphLayout: layout,
  });
  assert.equal(result.graph.layout.width, 40);
  assert.equal(result.graph.layout.boxes.get('api').node.percent, 100);
});

function detailsRows(result) {
  const { x, y, w, h } = result.layout.details;
  return result.text.split('\n').slice(y, y + h).map(line => line.slice(x, x + w));
}

function progressBarRow(rows, labelPattern) {
  const labelRow = rows.findIndex(line => labelPattern.test(line));
  assert.ok(labelRow >= 0, 'explicit unknown-percent label is visible');
  const barRow = /█/.test(rows[labelRow]) ? labelRow : labelRow - 1;
  assert.ok(barRow >= 0, 'indeterminate bar row exists');
  const interior = rows[barRow].slice(0, -2);
  assert.match(interior, /█/, 'bar has a lit segment');
  assert.match(interior, /░/, 'bar keeps an empty track');
  return barRow;
}

function taskBarCells(result) {
  const rect = result.hitboxes.tasks.get('st_api');
  assert.ok(rect, 'the task row is hitboxed');
  return result.canvas.cells[rect.y + 1].slice(rect.x + 2, rect.x + 11)
    .map(cell => cell.ch).join('');
}

function renderUnknown(state, overrides = {}, options = {}) {
  const { width = 120, height = 40, time = 0 } = options;
  return renderApp(oneNode(state, undefined), { ...baseUi, ...overrides }, {
    width, height, time, now, palette, theme,
  });
}

test('running tasks with an unrecorded percent paint an indeterminate bar at 54 and 120', () => {
  for (const [columns, focus, labelPattern] of [
    [54, 'tasks', /in progress · percent not recorded/],
    [54, 'graph', /in progress · percent not recorded/],
    [120, 'tasks', /percent not recorded/],
    [120, 'graph', /percent not recorded/],
  ]) {
    for (const motion of [true, false]) {
      const options = { width: columns, height: 40, time: 0 };
      const first = renderUnknown('running', { focus, motion }, options);
      assert.doesNotMatch(first.text, /\b0%|\b100%/, `${columns} ${focus} fabricates a percent`);
      const rows = detailsRows(first);
      const barRow = progressBarRow(rows, labelPattern);

      const laterRows = detailsRows(renderUnknown('running', { focus, motion }, {
        ...options, time: 1000,
      }));
      if (motion) {
        assert.notEqual(laterRows[barRow], rows[barRow],
          `${columns} ${focus} bar moves with time`);
      } else {
        assert.equal(laterRows[barRow], rows[barRow],
          `${columns} ${focus} bar is static with motion off`);
      }
    }
  }
});

test('the task list row shows the indeterminate sweep without a numeric percent', () => {
  for (const motion of [true, false]) {
    const first = renderUnknown('running', { motion }, { width: 120, height: 40, time: 0 });
    const firstBar = taskBarCells(first);
    assert.match(firstBar, /█/);
    assert.match(firstBar, /░/);
    assert.doesNotMatch(first.text, /\b0%|\b100%/);
    const laterBar = taskBarCells(renderUnknown('running', { motion }, {
      width: 120, height: 40, time: 1000,
    }));
    if (motion) assert.notEqual(laterBar, firstBar);
    else assert.equal(laterBar, firstBar);
  }
});

test('pending and terminal unknown percents keep their label and gain no bar', () => {
  for (const state of ['pending', 'skipped']) {
    const result = renderUnknown(state, { focus: 'tasks' });
    assert.match(result.text, /percent not recorded/);
    assert.doesNotMatch(result.text, /\b0%|\b100%/);
    const rows = detailsRows(result);
    const labelRow = rows.findIndex(line => /percent not recorded/.test(line));
    assert.ok(labelRow >= 0);
    assert.doesNotMatch(rows[labelRow], /█/);
    assert.doesNotMatch(rows[labelRow - 1] ?? '', /█/);
  }
});

test('the committed demo fixture never labels itself live at 54 columns', () => {
  const run = spawnSync(process.execPath, [
    'src/viewer.mjs', '--state', 'demo/snapshot.json', '--once',
    '--no-color', '--no-motion', '--width', '54', '--height', '20',
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /DEMO|模拟/);
  assert.doesNotMatch(run.stdout, /LIVE|实时/);
  for (const line of run.stdout.split('\n').slice(0, 20)) {
    assert.ok(textWidth(line) <= 54, 'CLI line width: ' + textWidth(line));
  }
});

test('the viewer applies the documented stale env threshold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-stale-'));
  const statePath = join(dir, 'snapshot.json');
  const capturedAt = new Date(Date.now() - 90_000).toISOString();
  writeFileSync(statePath, JSON.stringify({
    version: 2, sessionId, connected: true, updatedAt: capturedAt,
    provenance: { capturedAt, origin: 'test' },
    runs: [], tasks: [],
  }));
  const run = value => spawnSync(process.execPath, [
    'src/viewer.mjs', '--state', statePath, '--once',
    '--no-color', '--no-motion', '--width', '54', '--height', '20',
  ], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
    env: {
      ...process.env,
      OMO_HERDR_DAG_STUDIO_STALE_MS: value,
      // Keep the assertion language-stable regardless of the operator's config.
      NERO_HERDR_DAG_CONFIG_DIR: join(dir, 'config'),
    },
  });
  try {
    const fresh = run('120000');
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.match(fresh.stdout, /● LIVE/);
    assert.doesNotMatch(fresh.stdout, /▲ STALE/);

    const stale = run('30000');
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(stale.stdout, /▲ STALE/);
    assert.doesNotMatch(stale.stdout, /● LIVE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the viewer read lifecycle keeps a failed read and lets a healthy snapshot win', () => {
  const path = '/tmp/herdr-dag/state.json';
  const waiting = failedReadPlaceholder(path, { message: 'ENOENT: no such file' }, { now });
  const first = readFailureEvidence(waiting, { message: 'ENOENT: no such file' });
  assert.equal(first.lastReadError, 'ENOENT: no such file');
  assert.equal(first.placeholder.provenance.statePath, path);
  assert.equal(first.placeholder.readError, 'ENOENT: no such file');

  // A second failure updates the same WAITING placeholder instead of clearing it.
  const second = readFailureEvidence(first.placeholder, new Error('EACCES: permission denied'));
  assert.equal(second.lastReadError, 'EACCES: permission denied');
  assert.equal(second.placeholder.readError, 'EACCES: permission denied');
  assert.equal(second.placeholder.provenance.statePath, path);

  // A valid snapshot is never replaced by a transient read error; success
  // clears the recorded error without fabricating a placeholder.
  const healthy = demoSnapshot();
  const failedWhileHealthy = readFailureEvidence(healthy, new Error('boom'));
  assert.equal(failedWhileHealthy.lastReadError, 'boom');
  assert.equal(failedWhileHealthy.placeholder, undefined);
  assert.equal(readFailureEvidence(healthy, undefined).lastReadError, undefined);
  assert.equal(readFailureEvidence(healthy, undefined).placeholder, undefined);
});

test('a legacy v2 explicit percent renders numerically through the CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-legacy-percent-'));
  const statePath = join(dir, 'snapshot.json');
  writeFileSync(statePath, JSON.stringify({
    version: 2, sessionId, connected: true,
    updatedAt: '2026-11-10T00:00:00Z',
    runs: [{
      id: 'legacy-run', name: 'Legacy run', status: 'completed',
      createdAt: '2026-11-10T00:00:00Z',
      nodes: [{ id: 'legacy-node', label: 'Legacy node', state: 'completed', percent: 87 }],
      edges: [],
    }],
    tasks: [{ id: 'legacy-task', description: 'Legacy task', status: 'completed', percent: 87 }],
  }));
  const run = spawnSync(process.execPath, [
    'src/viewer.mjs', '--state', statePath, '--once',
    '--no-color', '--no-motion', '--width', '54', '--height', '42',
  ], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, NERO_HERDR_DAG_CONFIG_DIR: join(dir, 'config') },
  });
  try {
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /87%/);
    assert.doesNotMatch(run.stdout, /87% \(derived\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('1/2/3 request RUNS, CELLS, and DUTY with a structural fallback', () => {
  assert.equal(dutyFocusForKey('1'), 'runs');
  assert.equal(dutyFocusForKey('2'), 'cells');
  assert.equal(dutyFocusForKey('3'), 'details');
  assert.equal(dutyFocusForKey('4'), undefined);

  assert.equal(focusForStructural('runs', 'duty'), 'runs');
  assert.equal(focusForStructural('cells', 'duty'), 'cells');
  assert.equal(focusForStructural('details', 'duty'), 'details');
  assert.equal(focusForStructural('graph', 'duty'), 'details', 'unpainted graph falls to duty');
  assert.equal(focusForStructural('tasks', 'duty'), 'details', 'unpainted tasks fall to duty');
  assert.equal(focusForStructural('runs', 'investigation'), 'tasks');
  assert.equal(focusForStructural('cells', 'investigation'), 'graph');
  assert.equal(focusForStructural('details', 'investigation'), 'details');

  const ui = { focus: 'graph', lastFocus: 'graph' };
  assert.equal(applyFocusRequest(ui, 'graph', 'duty'), 'details');
  assert.equal(ui.lastFocus, 'graph');
  applyFocusRequest(ui, 'tasks', 'duty');
  assert.equal(ui.focus, 'details');
  assert.equal(ui.lastFocus, 'tasks');
  assert.equal(applyFocusRequest(ui, 'runs', 'duty'), 'runs');
  assert.equal(applyFocusRequest(ui, 'cells', 'duty'), 'cells');
  assert.equal(applyFocusRequest(ui, 'cells', 'investigation'), 'graph');
});

test('duty scroll keys move only the painted focused region', () => {
  const info = {
    details: { viewportH: 10, maxScroll: 8 },
    runs: { viewportH: 4, maxScroll: 6 },
    cells: { viewportH: 4, maxScroll: 3 },
    graph: { viewportH: 5, maxScroll: 20 },
    tasks: { viewportH: 5, maxScroll: 4 },
  };
  assert.equal(scrollRegionForFocus('details', 'duty', info), 'details');
  assert.equal(scrollRegionForFocus('runs', 'duty', info), 'runs');
  assert.equal(scrollRegionForFocus('cells', 'duty', info), 'cells');
  assert.equal(scrollRegionForFocus('graph', 'duty', info), 'details');

  assert.deepEqual(keyboardScrollIntent('j', undefined, 'details', 'duty', info),
    { region: 'details', delta: 1, maxScroll: 8 });
  assert.deepEqual(keyboardScrollIntent('k', undefined, 'runs', 'duty', info),
    { region: 'runs', delta: -1, maxScroll: 6 });
  assert.deepEqual(keyboardScrollIntent('G', undefined, 'runs', 'duty', info),
    { region: 'runs', delta: 6, maxScroll: 6 });
  assert.deepEqual(keyboardScrollIntent('g', undefined, 'runs', 'duty', info),
    { region: 'runs', delta: -6, maxScroll: 6 });
  assert.deepEqual(keyboardScrollIntent('\x1b[6~', undefined, 'cells', 'duty', info),
    { region: 'cells', delta: 2, maxScroll: 3 });
  assert.deepEqual(keyboardScrollIntent('j', { name: 'down' }, 'cells', 'duty', info),
    { region: 'cells', delta: 1, maxScroll: 3 });

  // A short duty frame paints no RUNS/CELLS list; the same key must not scroll
  // a region that is not there.
  const short = { ...info, runs: { viewportH: 0, maxScroll: 6 }, cells: { viewportH: 0, maxScroll: 3 } };
  assert.deepEqual(keyboardScrollIntent('j', undefined, 'runs', 'duty', short),
    { region: 'details', delta: 1, maxScroll: 8 });
  assert.deepEqual(keyboardScrollIntent('j', undefined, 'cells', 'duty', short),
    { region: 'details', delta: 1, maxScroll: 8 });

  // Wide investigation keeps its existing mapping, including the sidebar task
  // fallback when the sidebar is not painted.
  assert.deepEqual(keyboardScrollIntent('j', undefined, 'tasks', 'investigation', info),
    { region: 'tasks', delta: 1, maxScroll: 4 });
  assert.equal(scrollRegionForFocus('tasks', 'investigation', { ...info, tasks: { viewportH: 0 } }), 'graph');
  assert.deepEqual(keyboardScrollIntent('j', undefined, 'graph', 'investigation', info),
    { region: 'graph', delta: 1, maxScroll: 20 });
  assert.deepEqual(keyboardScrollIntent('j', undefined, 'details', 'investigation', info),
    { region: 'details', delta: 1, maxScroll: 8 });
});

test('duty focus paints a different border from a list focus', () => {
  const snapshot = oneNode('running', 42);
  const options = { width: 54, height: 14, time: 0, now, palette, theme };
  const focused = renderApp(snapshot, { ...baseUi, focus: 'details', lastFocus: 'graph' }, options);
  const listFocused = renderApp(snapshot, { ...baseUi, focus: 'runs', lastFocus: 'graph' }, options);
  const rect = focused.layout.details;
  assert.equal(focused.canvas.cell(rect.x, rect.y).fg, palette.borderHot);
  assert.equal(listFocused.canvas.cell(rect.x, rect.y).fg, palette.border);
});

test('duty scroll intents move the painted body and lists', () => {
  const snapshot = demoSnapshot();
  const ui = {
    ...baseUi, runIndex: 0, focus: 'details', lastFocus: 'graph',
    selectedNodeId: 'api', selectedTaskId: 'st_api',
  };
  const options = { width: 54, height: 24, time: 0, now, palette, theme };
  const top = renderApp(snapshot, ui, options);
  assert.equal(top.layout.layout, 'duty');
  const body = top.scroll.details;
  assert.ok(body.maxScroll > 0, 'duty body has scrollable content');

  const line = keyboardScrollIntent('j', undefined, ui.focus, top.layout.layout, top.scroll);
  assert.deepEqual(line, { region: 'details', delta: 1, maxScroll: body.maxScroll });
  const moved = renderApp(snapshot, { ...ui, detailsScroll: line.delta }, options);
  assert.notEqual(moved.text, top.text, 'j moves the painted duty body');

  const end = keyboardScrollIntent('G', undefined, ui.focus, top.layout.layout, top.scroll);
  assert.deepEqual(end, { region: 'details', delta: body.maxScroll, maxScroll: body.maxScroll });
  const bottom = renderApp(snapshot, { ...ui, detailsScroll: end.delta }, options);
  assert.notEqual(bottom.text, moved.text, 'G jumps to the last painted body row');

  const runs = keyboardScrollIntent('j', undefined, 'runs', top.layout.layout, top.scroll);
  assert.equal(runs.region, 'runs');
  assert.equal(runs.maxScroll, top.scroll.runs.maxScroll);
  const cells = keyboardScrollIntent('\x1b[6~', undefined, 'cells', top.layout.layout, top.scroll);
  assert.equal(cells.region, 'cells');
  assert.equal(cells.maxScroll, top.scroll.cells.maxScroll);
});

test('Help scroll keys move ui.helpScroll and clamp to the visible list', () => {
  assert.equal(helpViewportRows(20), 13);
  assert.deepEqual(helpScrollMetrics(20), { rows: 22, viewport: 13, maxScroll: 9 });
  assert.deepEqual(helpScrollMetrics(24), { rows: 22, viewport: 17, maxScroll: 5 });
  assert.deepEqual(helpScrollMetrics(42), { rows: 22, viewport: 22, maxScroll: 0 });
  assert.equal(helpScrollForKey('j'), 1);
  assert.equal(helpScrollForKey('k'), -1);
  assert.equal(helpScrollForKey('PageDown', undefined, { viewport: 13 }), 12);
  assert.equal(helpScrollForKey('PageUp', undefined, { viewport: 13 }), -12);
  assert.equal(helpScrollForKey('g', undefined, { viewport: 13 }), -9);
  assert.equal(helpScrollForKey('G', undefined, { viewport: 13 }), 9);
  assert.equal(helpScrollForKey('nope', undefined, { viewport: 13 }), undefined);

  const ui = { helpScroll: 0 };
  const metrics = helpScrollMetrics(20);
  assert.equal(applyHelpScroll(ui, 'j', undefined, metrics), true);
  assert.equal(ui.helpScroll, 1);
  assert.equal(applyHelpScroll(ui, 'End', undefined, metrics), true);
  assert.equal(ui.helpScroll, 9);
  assert.equal(applyHelpScroll(ui, 'j', undefined, metrics), true);
  assert.equal(ui.helpScroll, 9, 'stays clamped at the last row');
  assert.equal(applyHelpScroll(ui, 'g', undefined, metrics), true);
  assert.equal(ui.helpScroll, 0);
  assert.equal(applyHelpScroll(ui, 'nope', undefined, metrics), false);
  assert.equal(ui.helpScroll, 0, 'unknown keys do not move Help');
});

test('Help viewport metrics agree with the painted modal', () => {
  const snapshot = oneNode('running', 42);
  for (const [width, height] of [[54, 20], [54, 42], [120, 40], [54, 24], [54, 30]]) {
    const painted = renderApp(snapshot, { ...baseUi, help: true, helpScroll: 0 }, {
      width, height, time: 0, now, palette, theme,
    });
    const metrics = helpScrollMetrics(height);
    const label = `${width}x${height}`;
    assert.equal(metrics.viewport, painted.help.visibleRows, `viewport at ${label}`);
    assert.equal(metrics.maxScroll, painted.help.maxScroll, `maxScroll at ${label}`);
    assert.equal(metrics.rows, painted.help.total, `row count at ${label}`);
  }
});

test('Help scroll updates the painted rows at 54x20', () => {
  const snapshot = oneNode('running', 42);
  const options = { width: 54, height: 20, time: 0, now, palette, theme };
  const top = renderApp(snapshot, { ...baseUi, help: true, helpScroll: 0 }, options);
  assert.equal(top.help.maxScroll, 9);

  const ui = { helpScroll: 0 };
  assert.equal(applyHelpScroll(ui, 'j', undefined, helpScrollMetrics(20)), true);
  assert.equal(ui.helpScroll, 1);
  const scrolled = renderApp(snapshot, { ...baseUi, help: true, helpScroll: ui.helpScroll }, options);
  assert.equal(scrolled.help.scroll, 1);
  assert.notEqual(scrolled.text, top.text, 'a Help scroll repaints the list');

  assert.equal(applyHelpScroll(ui, 'G', undefined, helpScrollMetrics(20)), true);
  assert.equal(ui.helpScroll, 9);
  const bottom = renderApp(snapshot, { ...baseUi, help: true, helpScroll: ui.helpScroll }, options);
  assert.equal(bottom.help.scroll, 9);
  assert.match(bottom.text, /quit/);
});

test('Help is modal: only close and scroll keys reach the pane', () => {
  const metrics = helpScrollMetrics(20);
  for (const key of [
    'q', 's', 'm', 'x', 'X', 'S', 'f', 'r', 'd', 'c', 'p', 'o', 'e', 't',
    'Tab', '\t', '\x1b[C', '\x1b[D', '\r', ' ',
  ]) {
    assert.equal(helpKeyAction(key, undefined, metrics), 'blocked', `Help must consume ${JSON.stringify(key)}`);
  }
  for (const key of ['?', '\x1b', 'escape']) {
    assert.equal(helpKeyAction(key, undefined, metrics), 'close', `Help must close on ${JSON.stringify(key)}`);
  }
  for (const key of ['j', 'k', '\x1b[A', '\x1b[B', 'PageUp', 'PageDown', 'Home', 'End', 'g', 'G']) {
    assert.equal(helpKeyAction(key, undefined, metrics), 'scroll', `Help must scroll on ${JSON.stringify(key)}`);
  }
  assert.equal(helpKeyAction('q', { name: 'q' }, metrics), 'blocked');
  assert.equal(helpKeyAction('\x1b', { name: 'escape' }, metrics), 'close');
});

test('footer m/x hitboxes activate mouse and clear actions', () => {
  const hitboxes = {
    selectHint: { x: 10, y: 39, w: 3, h: 1 },
    clearHint: { x: 14, y: 39, w: 3, h: 1 },
    helpHint: { x: 2, y: 39, w: 6, h: 1 },
  };
  assert.equal(footerActionAt(hitboxes, 10, 39), 'mouse');
  assert.equal(footerActionAt(hitboxes, 12, 39), 'mouse');
  assert.equal(footerActionAt(hitboxes, 13, 39), undefined);
  assert.equal(footerActionAt(hitboxes, 14, 39), 'clear');
  assert.equal(footerActionAt(hitboxes, 16, 39), 'clear');
  assert.equal(footerActionAt(hitboxes, 17, 39), undefined);
  assert.equal(footerActionAt(hitboxes, 3, 39), undefined, 'the legend/help area is not an action');
  assert.equal(footerActionAt({ mouseHint: { x: 20, y: 39, w: 2, h: 1 } }, 20, 39), 'mouse');

  const calls = [];
  assert.equal(runFooterAction('mouse', { toggleMouse: () => calls.push('mouse') }), true);
  assert.equal(runFooterAction('clear', { clear: () => calls.push('clear') }), true);
  assert.deepEqual(calls, ['mouse', 'clear']);
  assert.equal(runFooterAction('legend', { toggleMouse: () => calls.push('wrong') }), false);
  assert.deepEqual(calls, ['mouse', 'clear']);
});

test('painted footer m/x hitboxes resolve to mouse and clear actions', () => {
  const snapshot = oneNode('running', 42);
  for (const [width, height] of [[54, 42], [120, 40], [40, 24]]) {
    const result = renderApp(snapshot, baseUi, {
      width, height, time: 0, now, palette, theme,
    });
    const select = result.hitboxes.selectHint;
    const clear = result.hitboxes.clearHint;
    assert.ok(select && clear, `${width}x${height} paints m/x hitboxes`);
    assert.equal(footerActionAt(result.hitboxes, select.x, select.y), 'mouse');
    assert.equal(footerActionAt(result.hitboxes, select.x + select.w - 1, select.y), 'mouse');
    assert.equal(footerActionAt(result.hitboxes, clear.x, clear.y), 'clear');
    assert.equal(footerActionAt(result.hitboxes, clear.x + clear.w - 1, clear.y), 'clear');
    assert.equal(footerActionAt(result.hitboxes, result.hitboxes.helpHint.x, select.y), undefined);
  }
});

test('painted Help and Settings hitboxes resolve to overlay actions', () => {
  const snapshot = oneNode('running', 42);
  for (const [width, height] of [[54, 42], [120, 40], [40, 24]]) {
    const result = renderApp(snapshot, baseUi, {
      width, height, time: 0, now, palette, theme,
    });
    const help = result.hitboxes.helpHint;
    const settings = result.hitboxes.settings;
    assert.ok(help && settings, `${width}x${height} paints Help/Settings hitboxes`);
    assert.equal(chromeActionAt(result.hitboxes, help.x, help.y), 'help');
    assert.equal(chromeActionAt(result.hitboxes, help.x + help.w - 1, help.y), 'help');
    assert.equal(chromeActionAt(result.hitboxes, settings.x, settings.y), 'settings');
    assert.equal(chromeActionAt(result.hitboxes, settings.x + settings.w - 1, settings.y), 'settings');
    assert.equal(footerActionAt(result.hitboxes, settings.x, settings.y), undefined);
  }
});

test('settings s opens and leaves animation explicitly session-only', () => {
  assert.equal(settingsHotkey('s'), true);
  assert.equal(settingsHotkey('S'), false);
  // The render settings row appends "(this session)" in both languages; the
  // viewer therefore toggles motion for this process only and writes no config.
  const snapshot = oneNode('running', 42);
  const options = { width: 54, height: 42, time: 0, now, palette, theme };
  const off = renderApp(snapshot, {
    ...baseUi, settingsMenu: true, settingsIndex: 1, themeName: 'dark', motion: false,
  }, options);
  assert.match(off.text, /Animation: OFF \(this session\)/);
  const on = renderApp(snapshot, {
    ...baseUi, settingsMenu: true, settingsIndex: 1, themeName: 'dark', motion: true,
  }, options);
  assert.match(on.text, /Animation: ON \(this session\)/);
});

test('d is honest in duty and still toggles in wide/expanded details', () => {
  assert.equal(detailsVerboseAvailable('duty'), false);
  assert.equal(detailsVerboseAvailable('investigation'), true);
  assert.equal(detailsVerboseAvailable('expanded'), true);
});


test('state reads and snapshot cardinality are bounded before mapping', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-bounded-'));
  const statePath = join(dir, 'snapshot.json');
  writeFileSync(statePath, JSON.stringify({ version: 3, runs: [] }));
  try {
    await assert.rejects(
      readStateFile(statePath, { maxBytes: 4 }),
      error => error instanceof ViewerSnapshotError && /limit/.test(error.message),
    );
    assert.deepEqual(await readStateFile(statePath, { maxBytes: 4_096 }), { version: 3, runs: [] });

    assert.throws(() => boundSnapshotInput({}), ViewerSnapshotError);
    assert.throws(
      () => boundSnapshotInput({ runs: Array.from({ length: SNAPSHOT_LIMITS.runs + 1 }, () => ({})) }),
      /limit/,
    );
    assert.throws(
      () => boundSnapshotInput({
        runs: [{
          id: 'r',
          nodes: Array.from({ length: SNAPSHOT_LIMITS.nodesPerRun + 1 }, (_, index) => ({ id: `n${index}` })),
          edges: [],
        }],
      }),
      /nodes/,
    );

    const history = Array.from({ length: 100 }, (_, index) => ({ rate: index }));
    const bounded = boundSnapshotInput({
      runs: [{ id: 'r', nodes: [{ id: 'n', tokenRate: history, tokenRateHistory: history }], edges: [] }],
      tasks: [],
    });
    assert.equal(bounded.runs[0].nodes[0].tokenRate.length, SNAPSHOT_LIMITS.rateSamples);
    assert.equal(bounded.runs[0].nodes[0].tokenRateHistory.length, SNAPSHOT_LIMITS.rateSamples);
    assert.equal(bounded.runs[0].nodes[0].tokenRateHistory.at(-1).rate, 99);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadState reports unreadable and invalid snapshots distinctly and rethrows bugs', async () => {
  let mode = 'unreadable';
  const { viewer } = await newViewer({
    deps: {
      readStateFile: async () => {
        if (mode === 'unreadable') {
          const error = new Error('ENOENT: no such file');
          error.code = 'ENOENT';
          throw error;
        }
        if (mode === 'invalid') return { version: 3, runs: 'not-an-array' };
        const raw = {};
        Object.defineProperty(raw, 'runs', {
          get() { throw new TypeError('boom getter'); },
        });
        return raw;
      },
    },
  });
  const unreadable = await viewer.loadState(true);
  assert.equal(unreadable.kind, 'unreadable');
  assert.match(unreadable.error.message, /ENOENT/);

  mode = 'invalid';
  const invalid = await viewer.loadState(true);
  assert.equal(invalid.kind, 'invalid');
  assert.match(invalid.error.message, /runs/);

  mode = 'bug';
  await assert.rejects(
    () => viewer.loadState(true),
    error => error instanceof TypeError && /boom getter/.test(error.message),
  );
  await viewer.close({ code: 0 });
});

test('the --once CLI distinguishes an invalid snapshot from an unreadable file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-invalid-'));
  const invalidPath = join(dir, 'invalid.json');
  const missingPath = join(dir, 'missing.json');
  writeFileSync(invalidPath, JSON.stringify({ version: 3, runs: 'not-an-array' }));
  const env = { ...process.env, NERO_HERDR_DAG_CONFIG_DIR: join(dir, 'config') };
  const run = path => spawnSync(process.execPath, [
    'src/viewer.mjs', '--state', path, '--once',
    '--no-color', '--no-motion', '--width', '54', '--height', '20',
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000, env });
  try {
    const invalid = run(invalidPath);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /cannot render snapshot/);
    assert.doesNotMatch(invalid.stderr, /cannot read snapshot/);

    const missing = run(missingPath);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /cannot read snapshot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overlapping state reads apply the newest snapshot and ignore the stale result', async () => {
  const pending = [];
  const snapshotFor = sessionId => ({
    version: 3, sessionId, mode: 'live', connected: true, runs: [], tasks: [],
  });
  const { viewer } = await newViewer({
    deps: {
      readStateFile: () => new Promise(resolve => pending.push(resolve)),
    },
  });
  const first = viewer.loadState(true);
  const second = viewer.loadState(true);
  assert.equal(pending.length, 2);

  pending[1](snapshotFor('new-session'));
  const secondResult = await second;
  assert.equal(secondResult.kind, 'ok');
  assert.equal(viewer.snapshot.sessionId, 'new-session');

  pending[0](snapshotFor('old-session'));
  const firstResult = await first;
  assert.equal(firstResult.kind, 'stale');
  assert.equal(viewer.snapshot.sessionId, 'new-session');
  await viewer.close({ code: 0 });
});

test('interactive startup installs the file watch before the first read', async () => {
  const events = [];
  const result = await loadInitialSnapshot({
    statePath: '/tmp/dag-state.json',
    interactive: true,
    setupWatch: () => events.push('watch'),
    load: async () => { events.push('load'); return { kind: 'ok' }; },
  });
  assert.equal(result.kind, 'ok');
  assert.deepEqual(events, ['watch', 'load']);

  events.length = 0;
  await loadInitialSnapshot({
    statePath: '/tmp/dag-state.json',
    interactive: false,
    setupWatch: () => events.push('watch'),
    load: async () => { events.push('load'); return { kind: 'ok' }; },
  });
  assert.deepEqual(events, ['load']);
});

test('hidden completed ids become visible again when the subject is active', async () => {
  const ui = {
    hiddenRunIds: new Set(['run', 'older']),
    hiddenTaskIds: new Set(['st_api', 'gone']),
  };
  pruneHiddenSubjects(ui, {
    runs: [{ id: 'run', status: 'running' }, { id: 'older', status: 'completed' }],
    tasks: [{ id: 'st_api', status: 'pending' }],
  });
  assert.deepEqual([...ui.hiddenRunIds], ['older']);
  assert.deepEqual([...ui.hiddenTaskIds], ['gone']);

  const { viewer } = await newViewer();
  viewer.acceptSnapshot(oneNode('completed', 100), { silent: true });
  viewer.handleKey('x');
  assert.equal(viewer.snapshot.runs.length, 0);
  assert.equal(viewer.snapshot.tasks.length, 0);

  viewer.acceptSnapshot(oneNode('running', 10), { silent: true });
  assert.ok(viewer.snapshot.runs.some(run => run.id === 'run'));
  assert.ok(viewer.snapshot.tasks.some(task => task.id === 'st_api'));
  await viewer.close({ code: 0 });
});

test('view preferences never load or save under the pending placeholder session', async () => {
  const loads = [];
  const saves = [];
  let mode = 'pending';
  const { viewer } = await newViewer({
    deps: {
      readStateFile: async () => {
        if (mode === 'pending') {
          const error = new Error('ENOENT: no such file');
          error.code = 'ENOENT';
          throw error;
        }
        return { ...oneNode('running', 20), sessionId: mode };
      },
      loadViewState: async (_path, sessionId) => {
        loads.push(sessionId);
        return { version: 1, sessionId, expanded: {} };
      },
      saveViewState: async (_path, view) => {
        saves.push(view);
        return view;
      },
    },
  });
  assert.equal(viewSessionKey({ sessionId: 'pending' }), undefined);
  assert.equal(viewSessionKey({ sessionId: 'real' }), 'real');

  let result = await viewer.loadState(true);
  assert.equal(result.kind, 'unreadable');
  assert.deepEqual(loads, [], 'pending is never loaded');

  mode = 'session-one';
  result = await viewer.loadState(true);
  assert.equal(result.kind, 'ok');
  assert.deepEqual(loads, ['session-one']);

  viewer.handleKey(' ');
  await viewer.flushPendingWrites();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].sessionId, 'session-one');

  mode = 'session-two';
  result = await viewer.loadState(true);
  assert.equal(result.kind, 'ok');
  assert.deepEqual(loads, ['session-one', 'session-two']);
  await viewer.close({ code: 0 });
});

test('close waits for the last preference write before exiting', async () => {
  let releaseSave;
  const save = new Promise(resolve => { releaseSave = resolve; });
  const { viewer, exits } = await newViewer({
    deps: { saveViewState: () => save },
  });
  viewer.acceptSnapshot(oneNode('running', 20), { silent: true });
  viewer.handleKey(' ');

  const closing = viewer.close({ code: 7 });
  assert.deepEqual(exits, [], 'exit waits for the pending preference write');
  releaseSave();
  await closing;
  assert.deepEqual(exits, [7]);
});

test('records are sanitized before the pager and the pager never blocks frames', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-pager-'));
  const recordPath = join(dir, 'task.json');
  writeFileSync(recordPath, '{"text":"safe\x1b[31mred\x1b]52;c;evil\x07"}\nnext line');
  const spawnWaiters = [];
  const spawnEvents = [];
  const kills = [];
  const spawnFn = (command, args) => {
    const child = new EventEmitter();
    child.kill = signal => {
      kills.push(signal);
      queueMicrotask(() => child.emit('exit', 0, signal));
    };
    child.command = command;
    child.args = args;
    const waiter = spawnWaiters.shift();
    if (waiter) waiter(child);
    else spawnEvents.push(child);
    return child;
  };
  const nextSpawn = () => new Promise(resolve => {
    if (spawnEvents.length) resolve(spawnEvents.shift());
    else spawnWaiters.push(resolve);
  });
  const { viewer } = await newViewer({
    deps: {
      pagerCommand: () => ({ command: 'cat', args: [] }),
      spawn: spawnFn,
    },
  });
  try {
    const firstSpawn = nextSpawn();
    let settled = false;
    const opening = viewer.openRecordInPager(recordPath).then(() => { settled = true; });
    const child = await withTestTimeout(firstSpawn, 1_000, 'pager was not spawned');
    assert.equal(child.command, 'cat');
    const pagerPath = child.args[0];
    const content = readFileSync(pagerPath, 'utf8');
    assert.match(content, /safe/);
    assert.match(content, /red/);
    assert.match(content, /next line/);
    assert.doesNotMatch(content, /\x1b/);
    assert.doesNotMatch(content, /\x07/);
    assert.equal(settled, false, 'an open pager does not block the caller');

    child.emit('exit', 0, null);
    await opening;
    assert.equal(settled, true);

    const secondSpawn = nextSpawn();
    const secondOpening = viewer.openRecordInPager(recordPath);
    const secondChild = await withTestTimeout(secondSpawn, 1_000, 'second pager was not spawned');
    assert.equal(typeof secondChild.kill, 'function');
    await viewer.close({ code: 3 });
    assert.ok(kills.includes('SIGTERM'), 'close terminates the pager child');
    await secondOpening;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitizing a record preserves line structure while stripping terminal controls', () => {
  const input = 'first\x1b[31mred\x1b]52;c;evil\x07\nsecond line';
  const output = sanitizePagerText(input);
  assert.doesNotMatch(output, /\x1b/);
  assert.doesNotMatch(output, /\x07/);
  assert.equal(output.split('\n').length, 2);
  assert.match(output, /firstred/);
  assert.match(output, /second line/);
});

test('terminal restore covers mouse tracking, cursor, and the alternate screen', async () => {
  const sequence = terminalRestoreSequence();
  assert.match(sequence, /\x1b\[\?1000l/);
  assert.match(sequence, /\x1b\[\?25h/);
  assert.match(sequence, /\x1b\[\?1049l/);

  const written = [];
  const stdout = { isTTY: true, write: text => written.push(text) };
  const { viewer } = await newViewer({
    options: { interactive: true, once: false },
    deps: { stdout, write: text => written.push(text) },
  });
  viewer.restoreTerminal();
  assert.equal(written.join(''), sequence);
  await viewer.close({ code: 0 });
});

test('a dead file watch is re-established with capped backoff', async () => {
  const watchers = [];
  let resolveSecond;
  const secondWatch = new Promise(resolve => { resolveSecond = resolve; });
  const watchFn = () => {
    const watcher = new EventEmitter();
    watcher.close = () => { watcher.closed = true; };
    watchers.push(watcher);
    if (watchers.length === 2) resolveSecond();
    return watcher;
  };
  assert.deepEqual(
    [0, 1, 2, 10].map(attempt => watchRetryDelay(attempt, { base: 5, max: 20 })),
    [5, 10, 20, 20],
  );
  const { viewer } = await newViewer({
    deps: { watch: watchFn, watchRetryBaseMs: 5 },
  });
  viewer.setupFileWatch();
  assert.equal(watchers.length, 1);
  watchers[0].emit('error', new Error('ENOSPC: no space left'));
  await withTestTimeout(secondWatch, 1_000, 'watch was not re-established');
  assert.equal(watchers.length, 2);
  assert.equal(watchers[0].closed, true);
  await viewer.close({ code: 0 });
});

test('frame pacing coalesces missed intervals and keeps the requested rate', () => {
  const interval = frameIntervalMs(60);
  assert.equal(interval, 1000 / 60);
  assert.equal(frameIntervalMs(120), 1000 / 120);
  assert.equal(frameIntervalMs(60, false), 1000);
  assert.equal(frameIntervalMs(24), 1000 / 24);
  const now = 1_000_000;
  assert.equal(nextFrameDeadline(now - 60_000, now, interval), now + interval);
  assert.equal(nextFrameDeadline(now + 5, now, interval), now + 5 + interval);
});

test('adaptive pacing idles static views and animates live or scrolling views', () => {
  const idle = oneNode('completed', 100);
  const live = oneNode('running', 20);
  const ui = { ...baseUi, motion: true };
  // The fixture captures at 2026-11-10T00:00:00Z; judge freshness against a
  // fixed instant so the assertion cannot drift with the wall clock.
  const now = Date.parse('2026-11-10T00:00:05Z');
  assert.equal(needsAnimationFrame(idle, ui, { now }), false);
  assert.equal(needsAnimationFrame(live, ui, { now }), true);
  assert.equal(needsAnimationFrame(live, { ...ui, motion: false }, { now }), false);
  assert.equal(needsAnimationFrame(live, { ...ui, help: true }, { now }), false);
  assert.equal(needsAnimationFrame(live, { ...ui, switcher: {} }, { now }), false);
  assert.equal(needsAnimationFrame(live, { ...ui, settingsMenu: true }, { now }), false);
  assert.equal(needsAnimationFrame(live, ui, { now, pagerActive: true }), false);
  assert.equal(needsAnimationFrame(idle, ui, { now, demoMode: true }), true);
  assert.equal(needsAnimationFrame(idle, { ...ui, graphScrollTarget: 10 }, { now }), true);
  assert.equal(needsAnimationFrame(idle, { ...ui, detailsScrollTarget: 5 }, { now }), true);
  assert.equal(needsAnimationFrame({ runs: [], tasks: [{ id: 'st', status: 'running' }] }, ui, { now }), true);
  // A stale capture freezes its activity animations, so only scrolling still
  // justifies full-rate frames.
  const staleLive = {
    ...live,
    provenance: { ...live.provenance, capturedAt: '2026-11-10T00:00:00Z' },
  };
  const staleNow = Date.parse('2026-11-10T00:05:00Z');
  assert.equal(needsAnimationFrame(staleLive, ui, { now: staleNow }), false);
  assert.equal(needsAnimationFrame(staleLive, { ...ui, graphScrollTarget: 3 }, { now: staleNow }), true);
});

test('the wide layout never idles below 24 frames while duty idles at one', () => {
  const idle = oneNode('completed', 100);
  const live = oneNode('running', 20);
  const ui = { ...baseUi, motion: true };
  const now = Date.parse('2026-11-10T00:00:05Z');
  assert.equal(framePacingFps(idle, ui, { now, width: 140 }), 24);
  assert.equal(framePacingFps(idle, ui, { now, width: 111 }), 1);
  assert.equal(framePacingFps(idle, ui, { now, width: 70 }), 1);
  assert.equal(framePacingFps(live, ui, { now, width: 140 }), 60);
  assert.equal(framePacingFps(live, ui, { now, width: 70 }), 60);
  // The floor also outranks an explicit slower preferred rate.
  assert.equal(framePacingFps(live, ui, { now, width: 140, preferredFps: 10 }), 24);
  assert.equal(framePacingFps(live, ui, { now, width: 70, preferredFps: 10 }), 10);
  // Static modals inherit the wide floor; the pager and --no-motion do not.
  assert.equal(framePacingFps(idle, { ...ui, help: true }, { now, width: 140 }), 24);
  assert.equal(framePacingFps(idle, { ...ui, help: true }, { now, width: 70 }), 1);
  assert.equal(framePacingFps(idle, { ...ui, motion: false }, { now, width: 140 }), 1);
  assert.equal(framePacingFps(idle, ui, { now, width: 140, pagerActive: true }), 1);
  assert.equal(frameIntervalMs(framePacingFps(idle, ui, { now, width: 140 })), 1000 / 24);
});

test('every scrollbar region eases toward its target instead of snapping', () => {
  for (const region of ['graph', 'tasks', 'runs', 'cells', 'details']) {
    const ui = { [`${region}Scroll`]: 0, [`${region}ScrollTarget`]: 12 };
    advanceScroll(ui, region, 20, 30);
    assert.ok(ui[`${region}Scroll`] > 0, `${region} started moving`);
    assert.ok(ui[`${region}Scroll`] < 12, `${region} has not snapped`);
    for (let step = 0; step < 200; step++) advanceScroll(ui, region, 20, 30);
    assert.equal(ui[`${region}Scroll`], 12, `${region} converges`);
  }
  // Targets clamp to the region maximum, and --once still jumps directly.
  const off = { tasksScroll: 0, tasksScrollTarget: 99 };
  advanceScroll(off, 'tasks', 10, 30, false);
  assert.deepEqual(off, { tasksScroll: 10, tasksScrollTarget: 10 });
});

test('real key dispatch keeps modal, ignore, switcher, and closing precedence', async () => {
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const { viewer, exits } = await newViewer({
    deps: { exit: code => { exits.push(code); resolveExit(code); } },
  });
  viewer.acceptSnapshot(oneNode('running', 20), { silent: true });

  viewer.handleKey('s');
  assert.equal(viewer.ui.settingsMenu, true);
  viewer.handleKey('\x1b');
  assert.equal(viewer.ui.settingsMenu, false);
  assert.deepEqual(exits, []);

  viewer.handleKey('?');
  assert.equal(viewer.ui.help, true);
  viewer.handleKey('q');
  assert.equal(viewer.ui.help, true, 'Help consumes q');
  assert.deepEqual(exits, []);
  viewer.handleKey('\x1b');
  assert.equal(viewer.ui.help, false);

  viewer.handleKey('m');
  assert.equal(viewer.ui.mouseCapture, false);
  viewer.handleKey('m');
  assert.equal(viewer.ui.mouseCapture, true);
  viewer.onMouseEvent({ button: 65, x: 1, y: 1, release: true });
  viewer.handleKey('m');
  assert.equal(viewer.ui.mouseCapture, true, 'mouse-capture debounce ignores the echoed key');
  await viewer.close({ code: 0 });
  assert.deepEqual(exits, [0]);

  // A fresh viewer: the mouse debounce above deliberately suppresses keys for
  // 80 ms, which must not leak into the remaining precedence assertions.
  let resolveExit2;
  const exited2 = new Promise(resolve => { resolveExit2 = resolve; });
  const secondExits = [];
  const second = await newViewer({
    deps: { exit: code => { secondExits.push(code); resolveExit2(code); } },
  });
  second.viewer.acceptSnapshot(oneNode('running', 20), { silent: true });
  second.viewer.handleKey('v');
  assert.ok(second.viewer.ui.switcher);
  second.viewer.handleKey('q');
  assert.equal(second.viewer.ui.switcher.query, 'q', 'switcher owns printable keys');
  second.viewer.handleKey('\x1b');
  assert.equal(second.viewer.ui.switcher, null);

  second.viewer.handleKey('q');
  assert.equal(await withTestTimeout(exited2, 1_000, 'quit did not exit'), 0);
  second.viewer.handleKey('m');
  assert.equal(second.viewer.ui.mouseCapture, true, 'closing blocks further dispatch');
});

test('the committed demo fixture matches a deterministic regeneration', () => {
  const raw = JSON.parse(readFileSync(
    new URL('../demo/snapshot.json', import.meta.url), 'utf8',
  ));
  const at = Date.parse(raw.generatedAt);
  assert.ok(Number.isSafeInteger(at), 'the fixture records a parseable generatedAt');

  // make-demo writes this exact engine snapshot at the fixture clock. Comparing
  // the serialized forms also covers the undefined-valued keys JSON drops.
  const fresh = new DemoEngine({ now: at, startOffset: 32_000 }).snapshot(at);
  assert.equal(raw.generatedAt, fresh.generatedAt);
  assert.equal(
    JSON.stringify(raw), JSON.stringify(fresh),
    `demo/snapshot.json is stale; run bun scripts/make-demo.mjs --at ${at}`,
  );
  const snapshot = normalizeSnapshot(raw);
  assert.deepEqual(snapshot, normalizeSnapshot(fresh), 'normalized fixture differs from the generator');

  const tasks = new Map(snapshot.tasks.map(task => [task.id, task]));
  for (const run of snapshot.runs) {
    for (const node of run.nodes) {
      if (!node.taskId) continue;
      const task = tasks.get(node.taskId);
      assert.ok(task, `${run.id}/${node.id} links missing task ${node.taskId}`);
      if (node.state !== 'blocked') continue;
      // A blocked node never ran, so its task must not report started work.
      assert.ok(['pending', 'blocked'].includes(task.status), `${task.id} is blocked but reports ${task.status}`);
      assert.equal(task.turns, 0, `${task.id} reports turns`);
      assert.equal(task.toolCalls, 0, `${task.id} reports tool calls`);
      assert.equal(task.startedAt, undefined, `${task.id} reports a start time`);
      assert.equal(task.tokensIn, undefined, `${task.id} reports input tokens`);
      assert.equal(task.tokensOut, undefined, `${task.id} reports output tokens`);
    }
  }
});
