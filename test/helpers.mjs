import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeSnapshot } from '../src/model.mjs';
import { createTheme, paletteAt, paletteFor } from '../src/theme.mjs';
import { createViewer, createViewerState } from '../src/viewer.mjs';

const mkdtempSync = prefix => {
  const path = join(tmpdir(), `${prefix}${crypto.randomUUID()}`);
  mkdirSync(path, { recursive: true });
  return path;
};

// Shared fixtures for the node:test suite. Everything here is a plain factory;
// each test still owns its assertions and the suite keeps using node:test.

const uiDefaults = {
  runIndex: 0,
  focus: 'graph',
  lastFocus: 'graph',
  selectedNodeId: undefined,
  selectedTaskId: undefined,
  follow: false,
  motion: false,
  help: false,
  verbose: false,
  graphScroll: 0,
  graphScrollTarget: 0,
  manualScroll: false,
  sidebar: true,
  language: 'en',
  fps: 12,
  toasts: [],
};

// A renderable UI fixture. Sets are created per call so one test cannot leak
// folded nodes or toasts into another through a shared module-level object.
export function baseUi(overrides = {}) {
  const ui = { ...uiDefaults, folded: new Set(), ...overrides };
  ui.folded = overrides.folded ?? new Set();
  ui.toasts = overrides.toasts ?? [];
  return ui;
}

// A complete viewer state for tests that exercise handleKey/selection paths.
export function viewerUi(overrides = {}) {
  return { ...createViewerState({ language: 'en', noMotion: true }), ...overrides };
}

// Palette plus the color-disabled theme most frame tests render with.
export function themeFor(name = 0, { color = false, appearance = 'dark' } = {}) {
  const palette = typeof name === 'string' ? paletteFor(name, { appearance }) : paletteAt(name);
  return { palette, theme: createTheme({ palette, color }) };
}

// Snapshot builders keep the version/session defaults in one place while each
// fixture still supplies its own runs and tasks.
export function makeSnapshot(fields = {}) {
  return normalizeSnapshot({
    version: 2,
    sessionId: 'test-session',
    connected: true,
    tasks: [],
    ...fields,
  });
}

export function snapshotBuilder(defaults = {}) {
  return (overrides = {}) => makeSnapshot({ ...defaults, ...overrides });
}

export function renderWith(renderApp, snapshot, baseUi, palette, theme, now, overrides = {}, {
  width = 120, height = 40, time = 0,
} = {}) {
  return renderApp(snapshot, { ...baseUi, ...overrides }, {
    width, height, time, now, palette, theme,
  });
}

export function makeTaskStore({ prefix = 'dag-test-', tasks = [], runs = [], snapshot = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, 'tasks'), { recursive: true });
  mkdirSync(join(root, 'dag', 'runs'), { recursive: true });
  for (const task of tasks) {
    const id = typeof task === 'string' ? task : task.id;
    const payload = typeof task === 'string' ? '{}' : task.payload ?? JSON.stringify(task.value ?? task, null, 2);
    writeFileSync(join(root, 'tasks', `${id}.json`), payload);
  }
  for (const run of runs) {
    const id = typeof run === 'string' ? run : run.id;
    writeFileSync(join(root, 'dag', 'runs', `${id}.json`), typeof run === 'string' ? '{}' : JSON.stringify(run));
  }
  if (snapshot) writeFileSync(join(root, 'snapshot.json'), '{}');
  return root;
}

// Thin viewer factory: collects writes and exit codes, lets the caller inject
// every dependency the real viewer would otherwise read from the environment.
export async function createTestViewer({ args = {}, deps = {} } = {}) {
  const written = [];
  const exits = [];
  const viewer = await createViewer(args, {
    write: text => written.push(text),
    exit: code => exits.push(code),
    ...deps,
  });
  return { viewer, exits, written };
}

// Race a promise against a bounded deadline and clear the losing timer so a
// passing frame does not leave the timer holding the test process open.
export function within(promise, ms, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export const withTestTimeout = within;

// Wait for an atomic rename to publish a parseable JSON capture. The file
// event is the signal; the timeout only bounds a broken child.
export function waitForJsonFile(path, timeoutMs) {
  return new Promise((resolve, reject) => {
    let watcher;
    let timer;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { watcher?.close(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(value);
    };
    const check = () => {
      try {
        finish(null, JSON.parse(readFileSync(path, 'utf8')));
        return true;
      } catch {
        return false;
      }
    };
    timer = setTimeout(() => finish(new Error(`timed out waiting for ${basename(path)}`)), timeoutMs);
    try {
      watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
        if (!filename || filename === basename(path)) check();
      });
      watcher.on('error', error => finish(error));
    } catch (error) {
      finish(error);
      return;
    }
    check();
  });
}
