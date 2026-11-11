import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoEngine } from '../src/demo.mjs';
import { DagPane } from '../src/controller.mjs';
import { messages, t } from '../src/i18n.mjs';
import { normalizeSnapshot } from '../src/model.mjs';
import { renderApp } from '../src/render.mjs';
import { normalizeOmOTask } from '../src/task-data.mjs';
import { readJson } from '../src/storage.mjs';
import { createTheme, paletteAt } from '../src/theme.mjs';
import { width as textWidth } from '../src/text.mjs';

const now = 1_000_000;
const palette = paletteAt(0);
const theme = createTheme({ palette, color: false });
const sessionId = '01a1bf8a-b241-7c95-8e04-d36830a6755a';

const baseUi = {
  runIndex: 0, focus: 'graph', lastFocus: 'graph',
  selectedNodeId: 'api', selectedTaskId: 'st_running',
  follow: false, motion: false, help: false, verbose: false, folded: new Set(),
  graphScroll: 0, graphScrollTarget: 0, manualScroll: false, sidebar: true,
  language: 'en', fps: 60, toasts: [],
};

function demoSnapshot() {
  return normalizeSnapshot(new DemoEngine({ now, startOffset: 32_000 }).snapshot(now));
}

function stateFixture(mode) {
  return normalizeSnapshot({
    version: 3,
    sessionId,
    mode,
    connected: mode !== 'saved',
    updatedAt: '2026-11-10T00:00:00Z',
    provenance: {
      origin: 'controller',
      statePath: '/tmp/dag-state.json',
      taskStateDir: '/tmp/senpi-task',
      capturedAt: new Date(now - 3000).toISOString(),
      view: 'once',
    },
    sources: [{
      id: 'store-a', label: 'repo store', origin: 'in-project', root: '/tmp/senpi-task',
      status: 'ok', tasks: { files: 2, accepted: 2, foreign: 0, invalid: 0 },
      runs: { files: 1, accepted: 1, foreign: 0, invalid: 0 },
    }],
    runs: [{
      id: 'run', name: 'Live run', status: 'running',
      createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:10Z',
      nodes: [
        { id: 'api', label: 'api', state: 'running', taskId: 'st_running' },
        { id: 'done', label: 'done', state: 'completed', taskId: 'st_done' },
      ],
      edges: [{ from: 'api', to: 'done' }],
    }],
    tasks: [
      {
        id: 'st_running', description: 'Implement the API', status: 'running',
        category: 'quick', reply: 'Bounded parsing implemented without a fallback.',
      },
      { id: 'st_done', description: 'Finished task', status: 'completed' },
    ],
  });
}

function render(snapshot, overrides = {}, { width = 120, height = 40 } = {}) {
  return renderApp(snapshot, { ...baseUi, ...overrides }, {
    width, height, time: 0, now, palette, theme,
  });
}

function detailsLines(result) {
  const { x, y, w, h } = result.layout.details;
  return result.text.split('\n').slice(y, y + h).map(line => line.slice(x, x + w));
}

test('demo, live, and saved frames render the truthful mode badge at 54/72/120', () => {
  const fixtures = [
    ['demo', demoSnapshot(), { badge: /DEMO/, forbidden: /LIVE/ }],
    ['live', stateFixture('live'), { badge: /LIVE/, forbidden: /SAVED|DEMO/ }],
    ['saved', stateFixture('saved'), { badge: /SAVED/, forbidden: /LIVE|DEMO/ }],
  ];
  for (const [columns, rows] of [[54, 20], [72, 24], [120, 40]]) {
    for (const [name, snapshot, expectation] of fixtures) {
      const ui = name === 'demo'
        ? { ...baseUi, selectedNodeId: 'api', selectedTaskId: 'st_index' }
        : baseUi;
      const result = renderApp(snapshot, ui, {
        width: columns, height: rows, time: 0, now, palette, theme,
      });
      const lines = result.text.split('\n');
      assert.equal(lines.length, rows, `${name} ${columns}x${rows} line count`);
      for (const line of lines) {
        assert.equal(textWidth(line), columns, `${name} ${columns}x${rows} width ${textWidth(line)}`);
      }
      const header = lines[0];
      assert.match(header, /DAG STUDIO/);
      assert.match(header, expectation.badge, `${name} ${columns} badge`);
      assert.doesNotMatch(header, expectation.forbidden, `${name} ${columns} mislabels mode`);
      assert.ok(header.indexOf('v0.1.0') < header.search(expectation.badge));
      if (columns === 54) assert.doesNotMatch(header, new RegExp(sessionId));
      const footer = lines.at(-1);
      const glyph = name === 'demo' ? '◆' : name === 'saved' ? '○' : '●';
      assert.ok(footer.includes(glyph), `${name} ${columns} footer glyph ${glyph}`);
    }
  }
});

test('unknown percent never renders as zero and the graph keeps an empty track', () => {
  const live = stateFixture('live');
  assert.equal(live.runs[0].nodes[0].percent, undefined);
  assert.equal(live.runs[0].nodes[0].provenance.percent.kind, 'unavailable');
  for (const snapshot of [live, stateFixture('saved')]) {
    const result = render(snapshot, {}, { width: 120, height: 40 });
    assert.doesNotMatch(result.text, /(?:^|[^0-9])0%/);
    assert.match(result.text, /—/);
    assert.match(result.text, /░/);
  }
});

test('missing reasoning is labelled and a reply is never painted under THINKING', () => {
  for (const mode of ['live', 'saved']) {
    const result = render(stateFixture(mode), { verbose: true }, { width: 120, height: 60 });
    const lines = detailsLines(result);
    const heading = lines.findIndex(line => line.includes('THINKING'));
    assert.ok(heading >= 0, `${mode} THINKING heading`);
    const body = lines.slice(heading + 1, heading + 6).join('\n');
    assert.match(body, /reasoning not captured yet/i);
    assert.doesNotMatch(body, /Bounded parsing implemented/);
    assert.match(lines.join('\n'), /REPLY/);
    assert.match(lines.join('\n'), /Bounded parsing implemented/);
    assert.match(lines.join('\n'), /retries\s+not recorded/);
  }
});

test('a category-only host task renders category provenance, not a bare agent', () => {
  const hostTask = normalizeOmOTask({
    task_id: 'st_category', parent_session_id: sessionId,
    description: 'Category-only host task', status: 'running', category: 'quick',
  });
  const snapshot = normalizeSnapshot({
    version: 3, sessionId, mode: 'live', connected: true,
    updatedAt: '2026-11-10T00:00:00Z',
    runs: [{
      id: 'run-category', name: 'Category run', status: 'running',
      nodes: [{ id: 'category', label: 'category', state: 'running', taskId: 'st_category' }],
      edges: [],
    }],
    tasks: [hostTask],
  });
  const task = snapshot.tasks[0];
  assert.equal(task.agent, undefined);
  assert.equal(task.category, 'quick');
  assert.equal(task.provenance.agent.kind, 'derived');
  assert.equal(task.provenance.agent.from, 'category');

  const result = render(snapshot, { focus: 'tasks', selectedTaskId: 'st_category' }, { width: 120, height: 40 });
  const identity = detailsLines(result).find(line => line.includes('category quick'));
  assert.ok(identity, 'category provenance identity row is rendered');
  assert.match(identity, /category quick · model not reco/);
  assert.doesNotMatch(identity.replace('category quick', ''), /\bquick\b/);
});

test('a category-only checkpoint node renders category provenance, not a bare agent', () => {
  const snapshot = normalizeSnapshot({
    version: 3, sessionId, mode: 'live', connected: true,
    updatedAt: '2026-11-10T00:00:00Z',
    runs: [{
      id: 'run-category-node', name: 'Category node run', status: 'running',
      nodes: [{ id: 'category-node', label: 'category-node', state: 'running', route: { kind: 'category', category: 'quick' } }],
      edges: [],
    }],
    tasks: [],
  });
  const node = snapshot.runs[0].nodes[0];
  assert.equal(node.agent, undefined);
  assert.equal(node.category, 'quick');
  assert.equal(node.provenance.agent.kind, 'derived');
  assert.equal(node.provenance.agent.from, 'category');

  const result = render(snapshot, { focus: 'graph', selectedNodeId: 'category-node' }, { width: 120, height: 40 });
  assert.match(result.text, /category quick/);
  assert.doesNotMatch(result.text, /agent not recorded/);
});

test('terminal tasks without replies or error reasons are labelled, not zeroed', () => {
  const live = stateFixture('live');
  const taskResult = render(live, {
    focus: 'tasks', selectedTaskId: 'st_done', selectedNodeId: 'done', verbose: true,
  }, {
    width: 120, height: 60,
  });
  assert.match(taskResult.text, /reply not recorded/);
  assert.match(taskResult.text, /reasoning not recorded/);

  const failed = normalizeSnapshot({
    version: 3, mode: 'live', connected: true,
    runs: [{ id: 'r', status: 'failed', nodes: [{ id: 'n', state: 'failed' }], edges: [] }],
    tasks: [],
  });
  const failedResult = render(failed, { selectedNodeId: 'n' }, { width: 120, height: 40 });
  assert.match(failedResult.text, /failure reason not recorded/);
  assert.doesNotMatch(failedResult.text, /(?:^|[^0-9])0%/);
});

test('the source panel exposes mode, origin, paths, capture time, and field provenance', () => {
  const live = stateFixture('live');
  const result = render(live, { verbose: true }, { width: 120, height: 60 });
  const text = result.text;
  assert.match(text, /SOURCE/);
  assert.match(text, /mode\s+LIVE/);
  assert.match(text, /origin\s+controller/);
  assert.match(text, /captured\s+1970-01-01T00:16:37Z/);
  assert.match(text, /snapshot\s+\/tmp\/dag-state\.json/);
  assert.match(text, /task store\s+\/tmp\/senpi-task/);
  assert.match(text, /percent\s+not recorded/);
  assert.match(text, /thinking\s+not recorded/);
  assert.match(text, /retries\s+not recorded/);

  const demo = render(demoSnapshot(), { verbose: true, selectedTaskId: 'st_index' }, {
    width: 120, height: 60,
  });
  assert.match(demo.text, /SOURCE/);
  assert.match(demo.text, /origin\s+demo-engine/);
  assert.match(demo.text, /simulated/);
});

test('an empty saved capture says so instead of promising a live workflow', () => {
  const empty = normalizeSnapshot({
    version: 3, sessionId: 'saved-empty', mode: 'saved', connected: false,
    provenance: {
      origin: 'controller', statePath: '/tmp/saved.json',
      capturedAt: new Date(now - 3_600_000).toISOString(),
    },
    runs: [], tasks: [],
  });
  const result = render(empty, { selectedNodeId: undefined }, { width: 120, height: 24 });
  assert.match(result.text, /SAVED/);
  assert.doesNotMatch(result.text, /LIVE/);
  assert.match(result.text, /This saved snapshot has no runs/);
  assert.match(result.text, /Captured 1969-12-31T23:16:40Z/);
  assert.doesNotMatch(result.text, /Start OmO/);
});

test('the controller writer stamps live and saved modes with provenance', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dag-provenance-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const controller = new DagPane({
    sessionId: 'session-1', parentPane: 'parent', socket: '/tmp/herdr.sock', stateDir,
    cwd: stateDir, node: '/usr/bin/node', viewer: '/tmp/viewer.mjs', herdr: async () => ({}),
  });
  try {
    await controller.save(true);
    const live = await readJson(controller.stateFile);
    assert.equal(live.version, 3);
    assert.equal(live.mode, 'live');
    assert.equal(live.connected, true);
    assert.equal(live.provenance.origin, 'controller');
    assert.equal(live.provenance.statePath, controller.stateFile);
    assert.ok(live.provenance.capturedAt);

    await controller.save(false);
    const saved = await readJson(controller.stateFile);
    assert.equal(saved.mode, 'saved');
    assert.equal(saved.connected, false);
    assert.equal(saved.provenance.origin, 'controller');
  } finally {
    await controller.stop();
  }
});

test('new i18n keys exist in both languages', () => {
  for (const key of [
    'modeDemo', 'modeWaiting', 'capturedAgo', 'sourceSection', 'provenanceRecorded',
    'provenanceDerived', 'provenanceSimulated', 'provenanceUnavailable', 'provenanceUnknown',
    'percentUnavailable', 'percentInProgress', 'thinkingNotRecorded', 'thinkingNotYet',
    'replyNotRecorded', 'agentNotRecorded', 'agentCategory', 'modelNotRecorded',
    'retriesNotRecorded', 'errorNotRecorded', 'graphBadgeCounts', 'completeCount',
    'emptySaved', 'emptyLiveWaiting', 'helpDataSource', 'toastSavedSnapshotEmpty',
  ]) {
    assert.ok(Object.hasOwn(messages.en, key), `en.${key}`);
    assert.ok(Object.hasOwn(messages.zh, key), `zh.${key}`);
  }
  assert.equal(t('zh', 'modeDemo'), '模拟');
  assert.equal(t('zh', 'sourceSection'), '来源');
  assert.equal(t('zh', 'provenanceUnavailable'), '未记录');
});
