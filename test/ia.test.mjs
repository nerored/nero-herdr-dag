import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoEngine } from '../src/demo.mjs';
import { messages } from '../src/i18n.mjs';
import { normalizeSnapshot } from '../src/model.mjs';
import { navTasks, renderApp } from '../src/render.mjs';
import { createTheme, paletteAt } from '../src/theme.mjs';
import { width as textWidth } from '../src/text.mjs';
import {
  collapseTransition, expandTransition, filterSwitcher, moveSwitcher,
  preserveScrolls, reconcileSwitcher, scrollRegionFor, structuralFor,
  switcherItems,
} from '../src/view-state.mjs';
import { applySwitcherSelection, createViewer, selectRunById } from '../src/viewer.mjs';

const now = 1_000_000;
const snapshot = normalizeSnapshot(new DemoEngine({ now, startOffset: 32_000 }).snapshot(now));
const palette = paletteAt(0);
const theme = createTheme({ palette, color: false });
const baseUi = {
  runIndex: 0, focus: 'graph', lastFocus: 'graph',
  selectedNodeId: 'api', selectedTaskId: 'st_api',
  follow: false, motion: false, help: false, verbose: false, folded: new Set(),
  graphScroll: 0, graphScrollTarget: 0, manualScroll: false, sidebar: true,
  language: 'en', fps: 12, toasts: [],
  expanded: false, returnFocus: 'graph', switcher: null,
};

function render(overrides = {}, { width = 120, height = 40 } = {}) {
  return renderApp(snapshot, { ...baseUi, ...overrides }, {
    width, height, time: 0, now, palette, theme,
  });
}

function frameLines(result) {
  return result.text.split('\n');
}

test('structural classes split at 112 and expanded always owns the body', () => {
  assert.equal(structuralFor(54), 'duty');
  assert.equal(structuralFor(111), 'duty');
  assert.equal(structuralFor(112), 'investigation');
  assert.equal(structuralFor(120), 'investigation');
  assert.equal(structuralFor(54, { expanded: true }), 'expanded');
  assert.equal(structuralFor(120, { expanded: true }), 'expanded');
  assert.deepEqual(scrollRegionFor('investigation'), ['tasks', 'graph', 'details']);
  assert.deepEqual(scrollRegionFor('investigation', { sidebar: false }), ['graph', 'details']);
  assert.deepEqual(scrollRegionFor('duty'), ['details']);
  assert.deepEqual(scrollRegionFor('expanded'), ['details']);
});

test('expand and collapse save and restore the subject owner', () => {
  const graphUi = { focus: 'graph', lastFocus: 'graph', expanded: false, follow: true, returnFocus: 'graph' };
  Object.assign(graphUi, expandTransition(graphUi));
  assert.equal(graphUi.expanded, true);
  assert.equal(graphUi.focus, 'details');
  assert.equal(graphUi.lastFocus, 'graph');
  assert.equal(graphUi.returnFocus, 'graph');
  assert.equal(graphUi.follow, false);
  // Repeating e while expanded is a no-op for the saved owner.
  assert.deepEqual(expandTransition(graphUi), {
    expanded: true, focus: 'details', lastFocus: 'graph', returnFocus: 'graph',
  });
  Object.assign(graphUi, collapseTransition(graphUi));
  assert.equal(graphUi.expanded, false);
  assert.equal(graphUi.focus, 'graph');

  const taskUi = { focus: 'tasks', lastFocus: 'tasks', expanded: false, follow: true, returnFocus: 'graph' };
  Object.assign(taskUi, expandTransition(taskUi));
  assert.equal(taskUi.returnFocus, 'tasks');
  assert.equal(taskUi.lastFocus, 'tasks');
  Object.assign(taskUi, collapseTransition(taskUi));
  assert.equal(taskUi.focus, 'tasks');
  assert.equal(collapseTransition({ expanded: false }), null);
});

test('hidden task and graph offsets survive expansion and resize', () => {
  const kept = preserveScrolls(
    { graph: 7, tasks: 5, details: 3 },
    { visible: { graph: false, tasks: false, details: true }, limits: { graph: 2, tasks: 2, details: 2 } },
  );
  assert.deepEqual(kept, { graph: 7, tasks: 5, details: 2 });

  const folded = new Set(['api']);
  const duty = render({ detailsScroll: 2, folded }, { width: 54, height: 20 });
  assert.equal(duty.layout.layout, 'duty');
  assert.equal(duty.scroll.details.offset, 2);
  assert.equal(duty.selectedNode.id, 'api');
  const resized = render({ detailsScroll: 2, folded }, { width: 72, height: 24 });
  assert.equal(resized.layout.layout, 'duty');
  assert.equal(resized.scroll.details.offset, 2);
  assert.equal(resized.detailsKey, duty.detailsKey);
  const expanded = render({
    detailsScroll: 2, folded, expanded: true, focus: 'details', lastFocus: 'graph',
  }, { width: 54, height: 20 });
  assert.equal(expanded.layout.layout, 'expanded');
  assert.equal(expanded.detailsKey, duty.detailsKey);
  assert.equal(expanded.scroll.details.offset, 2);
  assert.equal(expanded.selectedNode.id, 'api');
  assert.equal(expanded.detailsKey, duty.detailsKey);
  assert.deepEqual([...folded], ['api']);
});

test('the renderer honors the 111/112 structural breakpoint', () => {
  const duty = render({}, { width: 111, height: 30 });
  assert.equal(duty.layout.layout, 'duty');
  assert.equal(duty.layout.graph, null);
  const investigation = render({}, { width: 112, height: 30 });
  assert.equal(investigation.layout.layout, 'investigation');
  assert.ok(investigation.layout.graph);
  assert.ok(investigation.layout.sidebar);
  const expanded = render({ expanded: true, focus: 'details' }, { width: 111, height: 30 });
  assert.equal(expanded.layout.layout, 'expanded');
  assert.equal(expanded.layout.graph, null);
});

test('duty is one panel below 112 with no graph or sidebar hitboxes', () => {
  for (const [columns, rows] of [[54, 20], [72, 24]]) {
    const result = render({}, { width: columns, height: rows });
    assert.equal(result.layout.layout, 'duty');
    assert.equal(result.layout.graph, null);
    assert.equal(result.layout.sidebar, null);
    assert.deepEqual([...result.hitboxes.regions.keys()], ['runs', 'cells', 'details']);
    assert.ok(result.hitboxes.nodes.size > 0);
    assert.equal(result.hitboxes.tasks.size, 0);
    assert.match(result.text, /CURRENT NODE/);
    assert.doesNotMatch(result.text, /DUTY/);
    assert.doesNotMatch(result.text, /╭─ GRAPH/);
  }
});

test('duty focus states mark the painted pane without color', () => {
  const at = focus => render({ focus }, { width: 54, height: 42 });
  assert.match(at('runs').text, /▸ RUNS/);
  assert.match(at('cells').text, /▸ CELLS/);
  for (const focus of ['details', 'duty']) {
    const frame = at(focus);
    assert.match(frame.text, /▸ CURRENT NODE · build-api/);
    assert.doesNotMatch(frame.text, /▸ RUNS|▸ CELLS/);
  }
  const unfocused = at('graph');
  assert.match(unfocused.text, /CURRENT NODE · build-api/);
  // Focus marks the pane title; selection marks the row regardless of focus.
  assert.doesNotMatch(unfocused.text, /▸ RUNS|▸ CELLS|▸ CURRENT NODE/);
  assert.match(unfocused.text, /│ ▸ ● integration review/);
  assert.match(unfocused.text, /│ ▸ ● build-api/);
});

test('narrow duty paints scrollable runs and cells above the selected details', () => {
  const result = render({}, { width: 54, height: 24 });
  assert.deepEqual([...result.hitboxes.regions.keys()], ['runs', 'cells', 'details']);
  assert.ok(result.hitboxes.runs.size > 0);
  assert.ok(result.hitboxes.nodes.size > 0);
  assert.ok(result.scroll.runs.viewportH > 0);
  assert.ok(result.scroll.cells.viewportH > 0);
  assert.match(result.text, /RUNS/);
  assert.match(result.text, /CELLS/);
  assert.match(result.text, /METRICS/);
  assert.ok(result.scroll.details.maxScroll > 0);
});

test('tier 1 survives at 54x12 and compact tier 2 appears at 54x20', () => {
  const tiny = render({}, { width: 54, height: 12 });
  const tinyText = tiny.text;
  for (const token of [
    'RUNNING', 'build-api', 'st_api', '00:00:14', 'attempt 1',
    'progress 2/9', '27%', 'retries 0', 'error none recorded', 'running typeche',
  ]) {
    assert.ok(tinyText.includes(token), `54x12 tier 1 missing ${token}`);
  }
  assert.equal(tiny.scroll.details.viewportH, 4);

  const compact = render({}, { width: 54, height: 20 });
  assert.match(compact.text, /integration review · 2\/9 done · 3 running/);
  assert.match(compact.text, /CELLS/);
  assert.ok(compact.hitboxes.runs.size > 0);
  assert.ok(compact.hitboxes.nodes.size > 0);
  assert.doesNotMatch(compact.text, /THINKING/);
  assert.doesNotMatch(compact.text, /REPLY/);

  const full = render({}, { width: 72, height: 32 });
  assert.match(full.text, /tokens\s+5\.1k in \/ 1\.2k out/);
  assert.match(full.text, /turns\s+3/);
  assert.match(full.text, /tools\s+6/);
});

test('investigation keeps graph, details, sidebar, and a clickable breadcrumb', () => {
  const result = render({}, { width: 120, height: 40 });
  assert.equal(result.layout.layout, 'investigation');
  assert.ok(result.layout.graph && result.layout.details && result.layout.sidebar);
  assert.deepEqual([...result.hitboxes.regions.keys()], ['graph', 'tasks', 'details']);
  const header = frameLines(result)[1];
  assert.match(header, /integration review/);
  assert.match(header, /build-api/);
  assert.match(header, /st_api/);
  assert.match(header, /RUNNING/);
  assert.match(header, /2\/9 done · 3 running/);
  assert.equal(result.hitboxes.context.run.id, 'run_integration');
  assert.equal(result.hitboxes.context.node.id, 'api');
  assert.equal(result.hitboxes.context.task.id, 'st_api');
  for (const rect of Object.values(result.hitboxes.context)) {
    assert.equal(rect.y, 1);
    assert.ok(rect.w > 0);
    assert.ok(rect.x >= 2 && rect.x + rect.w <= 118);
  }
});

test('expanded details own the full body at 72 and 120 and keep the subject', () => {
  for (const [columns, rows] of [[72, 24], [120, 40]]) {
    const result = render({
      expanded: true, focus: 'details', lastFocus: 'graph',
    }, { width: columns, height: rows });
    assert.equal(result.layout.layout, 'expanded');
    assert.equal(result.layout.graph, null);
    assert.equal(result.layout.sidebar, null);
    assert.deepEqual(result.layout.details, { x: 0, y: 3, w: columns, h: rows - 5 });
    assert.deepEqual([...result.hitboxes.regions.keys()], ['details']);
    assert.equal(result.hitboxes.nodes.size, 0);
    assert.equal(result.hitboxes.tasks.size, 0);
    assert.equal(result.selectedNode.id, 'api');
    if (columns === 72) {
      assert.ok(result.scroll.details.contentH > result.scroll.details.viewportH);
      assert.match(result.text, /METRICS/);
    } else {
      assert.match(result.text, /THINKING/);
    }
    assert.doesNotMatch(result.text, /╭─ GRAPH/);
    for (const line of frameLines(result)) assert.equal(textWidth(line), columns);
  }
});

test('the breadcrumb truncates the run, survives, and names an unlinked task', () => {
  const unlinked = normalizeSnapshot({
    version: 2,
    sessionId: 'breadcrumb-session',
    connected: true,
    runs: [{
      id: 'run_long',
      name: 'a very long workflow name that must truncate',
      status: 'running',
      nodes: [{ id: 'node_a', label: 'linked-node', state: 'running', task_id: 'st_linked' }],
      edges: [],
    }],
    tasks: [
      { id: 'st_linked', description: 'Linked task', status: 'running' },
      { id: 'st_free', description: 'Free running task', status: 'running' },
    ],
  });
  const result = renderApp(unlinked, {
    ...baseUi,
    selectedNodeId: undefined,
    selectedTaskId: 'st_free',
    selectedTaskUnlinked: true,
    focus: 'tasks',
  }, { width: 54, height: 20, time: 0, now, palette, theme });
  const header = frameLines(result)[1];
  assert.match(header, /…/);
  assert.match(header, /no node/);
  assert.match(header, /st_free/);
  assert.match(header, /RUNNING/);
  assert.equal(textWidth(header), 54);
  assert.equal(result.hitboxes.context.task.id, 'st_free');
  assert.equal(result.hitboxes.context.node, undefined);
});

test('the switcher freezes runs-then-tasks order by id and refreshes values', () => {
  const tasks = navTasks(snapshot);
  const items = switcherItems(snapshot, null, { tasks });
  assert.ok(items.length >= snapshot.runs.length + tasks.length);
  assert.equal(items[0].kind, 'run');
  assert.equal(items[0].id, 'run_integration');
  const firstTask = items.findIndex(item => item.kind === 'task');
  assert.ok(firstTask > 0);
  assert.ok(items.slice(0, firstTask).every(item => item.kind === 'run'));

  const keys = items.map(item => item.key);
  const reversed = [...keys].reverse();
  assert.deepEqual(
    switcherItems(snapshot, reversed, { tasks }).map(item => item.key),
    reversed,
  );
  assert.deepEqual(
    switcherItems(snapshot, [...keys, 'task:missing'], { tasks }).map(item => item.key),
    keys,
  );

  const filtered = filterSwitcher(items, 'build-api');
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every(item => /build-api/i.test(item.search)));
  assert.ok(filterSwitcher(items, 'build-api running').every(item =>
    /build-api/i.test(item.search) && /running/i.test(item.search)));
  assert.equal(reconcileSwitcher(filtered, 'task:missing'), filtered[0].key);
  assert.equal(moveSwitcher(filtered, filtered[0].key, 1), filtered[1].key);
  assert.equal(moveSwitcher(filtered, filtered[0].key, -1), filtered.at(-1).key);

  const cjk = [{ key: 'task:1', search: '修复 并发 泄漏 运行中' }];
  assert.equal(filterSwitcher(cjk, '并发').length, 1);
  assert.equal(filterSwitcher(cjk, '并发 泄漏').length, 1);
  assert.equal(filterSwitcher(cjk, '并发 缺失').length, 0);
});

test('the switcher overlay blocks every underlying hitbox', () => {
  const items = switcherItems(snapshot, null, { tasks: navTasks(snapshot) });
  const active = items.find(item => item.kind === 'task' && /build-api/i.test(item.search));
  const result = render({
    switcher: { query: 'build', frozenKeys: items.map(item => item.key), activeKey: active.key },
  });
  assert.match(result.text, /SWITCH · RUNS & TASKS/);
  assert.match(result.text, /filter/);
  assert.equal(result.hitboxes.regions.size, 0);
  assert.equal(result.hitboxes.nodes.size, 0);
  assert.equal(result.hitboxes.tasks.size, 0);
  assert.equal(result.hitboxes.runs.size, 0);
  assert.equal(result.hitboxes.helpHint, null);
  assert.ok(result.hitboxes.switcher.size > 0);
  assert.ok(result.hitboxes.switcherPanel);
  for (const rect of result.hitboxes.switcher.values()) {
    assert.ok(rect.x >= result.hitboxes.switcherPanel.x);
    assert.ok(rect.x + rect.w <= result.hitboxes.switcherPanel.x + result.hitboxes.switcherPanel.w);
  }
});

test('switcher selection pins runs, jumps linked tasks, and rejects stale ids', () => {
  const runUi = { ...baseUi, folded: new Set() };
  assert.equal(selectRunById(runUi, snapshot, 'run_goldbach'), true);
  assert.equal(runUi.runIndex, 1);
  assert.equal(runUi.selectedRunId, 'run_goldbach');
  assert.equal(runUi.runPinned, true);
  assert.ok(runUi.selectedNodeId);
  assert.equal(selectRunById(runUi, snapshot, 'run_missing'), false);
  assert.equal(runUi.selectedRunId, 'run_goldbach');

  const taskUi = { ...baseUi, folded: new Set() };
  const taskItems = switcherItems(snapshot, null, { tasks: navTasks(snapshot) });
  const buildTask = taskItems.find(item => item.kind === 'task' && item.id === 'st_api');
  const applied = applySwitcherSelection(taskUi, snapshot, buildTask);
  assert.equal(applied.handled, true);
  assert.equal(applied.linked.node.id, 'api');
  assert.equal(taskUi.selectedTaskId, 'st_api');
  assert.equal(taskUi.selectedNodeId, 'api');
  assert.equal(taskUi.focus, 'tasks');

  const expandedUi = { ...baseUi, folded: new Set(), expanded: true, returnFocus: 'graph' };
  applySwitcherSelection(expandedUi, snapshot, buildTask);
  assert.equal(expandedUi.focus, 'details');
  assert.equal(expandedUi.lastFocus, 'tasks');

  const staleTask = applySwitcherSelection({ ...baseUi }, snapshot, { kind: 'task', id: 'st_gone' });
  assert.deepEqual(staleTask, { handled: false, stale: true, linked: undefined });
  const staleRun = applySwitcherSelection({ ...baseUi }, snapshot, { kind: 'run', id: 'run_gone' });
  assert.equal(staleRun.stale, true);
});

test('Chinese duty stays 54 columns and counts CJK cells as two', () => {
  const result = render({ language: 'zh' }, { width: 54, height: 20 });
  const lines = frameLines(result);
  assert.equal(lines.length, 20);
  for (const line of lines) assert.equal(textWidth(line), 54, `width ${textWidth(line)}`);
  assert.match(result.text, /当前节点/);
  assert.doesNotMatch(result.text, /任务面板/);
  assert.match(result.text, /运行中/);
  assert.match(result.text, /27%/);
  assert.match(result.text, /未记录错误|未记录失败原因/);
});

// F-96: the copied diagnosis artifact must use the same UI language as the
// panel, not a hardcoded English vocabulary.
test('the viewer passes its selected language to the diagnosis copy action', async () => {
  const calls = [];
  const viewer = await createViewer(
    { noColor: true, noMotion: true, fps: 10 },
    {
      loadConfig: async () => ({ language: 'zh' }),
      loadOmoTheme: async () => 'system',
      loadOmoAppearance: async () => ({}),
      columns: 140,
      rows: 42,
      write: () => {},
      diagnosisForKey: (...args) => {
        calls.push(args);
        return { kind: 'copy-diagnosis', text: '诊断负载' };
      },
    },
  );
  viewer.acceptSnapshot({
    version: 3,
    mode: 'live',
    connected: true,
    runs: [{
      id: 'run_fail',
      status: 'failed',
      nodes: [{ id: 'ship', label: 'ship', state: 'failed', task_id: 'st_fail', error: 'upload failed' }],
      edges: [],
    }],
    tasks: [{ id: 'st_fail', description: 'ship it', status: 'failed', error: 'upload failed' }],
  }, { silent: true });
  viewer.ui.focus = 'tasks';
  viewer.ui.lastFocus = 'tasks';
  viewer.ui.selectedTaskId = 'st_fail';

  viewer.handleKey('c');

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'c');
  assert.equal(calls[0][3], 'zh');
});

// F-158: the wide-mode-only details toast is a message-table entry instead of
// the viewer's lone hardcoded bilingual string.
test('the wide-only details toast follows the message table', async () => {
  for (const language of ['en', 'zh']) {
    const viewer = await createViewer(
      { once: true, width: 54, noColor: true, noMotion: true, fps: 10 },
      {
        loadConfig: async () => ({ language }),
        loadOmoTheme: async () => 'system',
        loadOmoAppearance: async () => ({}),
        write: () => {},
      },
    );
    viewer.handleKey('d');

    const toast = viewer.ui.toasts.at(-1);
    assert.equal(toast?.text, messages[language].toastDetailsWideOnly, `${language} toast`);
    assert.equal(toast?.kind, 'warning', `${language} toast kind`);
    assert.equal(viewer.ui.verbose, false, `${language} leaves verbose off`);
    if (language === 'zh') {
      assert.notEqual(toast.text, messages.en.toastDetailsWideOnly, 'zh toast is not the English string');
    }
  }
});
