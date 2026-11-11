import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoEngine } from '../src/demo.mjs';
import { Canvas } from '../src/canvas.mjs';
import { normalizeSnapshot, modeFor } from '../src/model.mjs';
import { diagnosisFor } from '../src/diagnosis.mjs';
import {
  contrastRatio, dashboardLayout, detailsSubjectKey, navTasks, pillForeground, recordForSelection,
  renderApp, runListLayout, snapshotFreshness, taskListLayout,
} from '../src/render.mjs';
import { computeLayout } from '../src/graph.mjs';
import { regionAt } from '../src/scroll.mjs';
import {
  contrastRatio as themeContrastRatio, createTheme, paletteAt, paletteFor,
} from '../src/theme.mjs';
import { width } from '../src/text.mjs';

const now = 1_000_000;
const frameLines = result => result.text.split('\n');
const snapshot = normalizeSnapshot(new DemoEngine({ now, startOffset: 32_000 }).snapshot(now));
const palette = paletteAt(0);
const theme = createTheme({ palette, color: false });
const ui = {
  runIndex: 0, focus: 'graph', selectedNodeId: 'api', selectedTaskId: 'st_index',
  follow: false, motion: true, help: false, verbose: false, folded: new Set(),
  graphScroll: 0, graphScrollTarget: 0, manualScroll: false, paletteIndex: 0,
  sidebar: true, fps: 12, toasts: [],
};

test('the dashboard fills the requested frame without horizontal overflow', () => {
  for (const [columns, rows] of [[120, 40], [90, 30], [70, 24]]) {
    const result = renderApp(snapshot, ui, {
      width: columns, height: rows, time: 1000, now, palette, theme,
    });
    const lines = result.text.split('\n');
    assert.equal(lines.length, rows, `${columns}x${rows} line count`);
    for (const line of lines) assert.equal(width(line), columns, `${columns}x${rows} width ${width(line)}`);
    assert.match(result.text, /DAG STUDIO/);
    if (columns >= 112) assert.match(result.text, /GRAPH/);
    else assert.match(result.text, /CURRENT NODE/);
    assert.match(result.text, /build-api/);
  }
});

test('a run todo title is the primary displayed run title', () => {
  const withTodo = {
    ...snapshot,
    runs: snapshot.runs.map((run, index) => index === 0
      ? { ...run, name: 'producer-only title', todoTitle: 'adjust metric layout' }
      : run),
  };
  const result = renderApp(withTodo, { ...ui, runIndex: 0 }, {
    width: 120, height: 40, time: 1000, now, palette, theme,
  });
  assert.match(result.text, /adjust metric layout/);
  assert.doesNotMatch(result.text, /producer-only title/);
});

test('the three-pane layout exposes navigation, graph, and node details', () => {
  const result = renderApp(snapshot, ui, { width: 140, height: 42, time: 1000, now, palette, theme });
  assert.match(result.text, /NAVIGATION/);
  assert.match(result.text, /NODE · build-api/);
  assert.match(result.text, /METRICS/);
  assert.match(result.text, /CONNECTIONS/);
  assert.match(result.text, /FOLLOW/);
  assert.equal(result.layout.mode, 'columns');
  assert.ok(result.hitboxes.nodes.size > 0);
  assert.equal(result.hitboxes.runs.size, 4);
  assert.ok(result.hitboxes.tasks.size >= 8);
});

test('the sidebar toggle reclaims the left column on wide screens', () => {
  const result = renderApp(snapshot, { ...ui, sidebar: false }, {
    width: 140, height: 42, time: 1000, now, palette, theme,
  });
  assert.equal(result.layout.mode, 'columns');
  assert.equal(result.layout.sidebar, null);
  assert.equal(result.layout.graph.x, 0);

  const compact = renderApp(snapshot, { ...ui, sidebar: false }, {
    width: 120, height: 40, time: 1000, now, palette, theme,
  });
  assert.equal(compact.layout.mode, 'columns');
  assert.equal(compact.layout.sidebar, null);
  assert.equal(compact.layout.graph.x, 0);
});

test('narrow layouts become one duty panel with no graph canvas', () => {
  for (const width of [90, 70]) {
    const result = renderApp(snapshot, ui, { width, height: 30, time: 1000, now, palette, theme });
    assert.equal(result.layout.mode, 'single');
    assert.equal(result.layout.layout, 'duty');
    assert.equal(result.layout.sidebar, null);
    assert.equal(result.layout.graph, null);
    assert.deepEqual(result.layout.details, {
      x: 0, y: 3, w: width, h: 30 - 3 - 2,
    });
    assert.equal(result.graph.layout, null);
  }
});

test('graph cell borders stay on their declared column and row', () => {
  for (const [columns, rows] of [[120, 40], [112, 36]]) {
    const result = renderApp(snapshot, { ...ui, graphScroll: 0, graphScrollTarget: 0, selectedNodeId: 'api' }, {
      width: columns, height: rows, time: 0, now, palette, theme,
    });
    const graphRect = result.layout.graph;
    const graph = result.graph;
    assert.ok(graph.layout);
    const innerX = graphRect.x + 2;
    const innerY = graphRect.y + 1;
    const offset = graph.layout.height <= graph.viewportH
      ? Math.floor((graph.viewportH - graph.layout.height) / 2)
      : -graph.scroll;
    const cells = result.canvas.cells;
    for (const box of graph.layout.boxes.values()) {
      const top = innerY + offset + box.y;
      if (top < innerY || top + box.h > innerY + graph.viewportH) continue;
      const left = innerX + box.x;
      assert.ok(['╭', '╔'].includes(cells[top][left].ch), `${columns} ${box.node.id} tl`);
      assert.ok(['╮', '╗'].includes(cells[top][left + box.w - 1].ch), `${columns} ${box.node.id} tr`);
      assert.ok(['╰', '╚'].includes(cells[top + box.h - 1][left].ch), `${columns} ${box.node.id} bl`);
      assert.ok(['╯', '╝'].includes(cells[top + box.h - 1][left + box.w - 1].ch), `${columns} ${box.node.id} br`);
      for (let row = 1; row < box.h - 1; row++) {
        assert.ok(['│', '║'].includes(cells[top + row][left].ch), `${columns} ${box.node.id} left ${row}`);
        assert.ok(['│', '║'].includes(cells[top + row][left + box.w - 1].ch), `${columns} ${box.node.id} right ${row}`);
      }
    }
  }
});

test('the graph keeps a clean border with no side scrollbar overlay', () => {
  const result = renderApp(snapshot, { ...ui, graphScroll: 20 }, {
    width: 120, height: 40, time: 0, now, palette, theme,
  });
  const graph = result.layout.graph;
  const x = graph.x + graph.w - 1;
  for (let y = graph.y + 1; y < graph.y + graph.h - 1; y++) {
    assert.equal(result.canvas.cells[y][x].ch, '│', `graph border row ${y}`);
  }
});

test('verbose details stay inside their panel and toasts do not overlay panels', () => {
  const toast = { id: 1, text: 'build-api completed', kind: 'completed', at: now };
  const result = renderApp(snapshot, {
    ...ui, verbose: true, selectedNodeId: 'api', toasts: [toast],
  }, { width: 70, height: 24, time: 0, now, palette, theme });
  const lines = result.text.split('\n');
  const footer = lines.at(-1);
  assert.match(footer, /build-api completed/);
  assert.equal(lines.filter(line => line.includes('build-api completed')).length, 1);
  assert.doesNotMatch(footer, /METRICS|RECENT LOG|ACTIVITY|──/);
  assert.match(footer, /●run.*◌wait.*\? Help/);
  assert.ok(result.hitboxes.helpHint.x > 1);
  const compact = renderApp(snapshot, { ...ui, verbose: false, selectedNodeId: 'api' }, {
    width: 140, height: 42, time: 0, now, palette, theme,
  });
  const verbose = renderApp(snapshot, {
    ...ui, verbose: true, selectedNodeId: 'api', detailsScroll: 999,
  }, {
    width: 140, height: 42, time: 0, now, palette, theme,
  });
  assert.doesNotMatch(compact.text, /RECENT LOG/);
  assert.match(verbose.text, /RECENT LOG/);
  assert.match(verbose.text, /reading src\/api\/schema/);
  const compactSmall = renderApp(snapshot, { ...ui, verbose: false, selectedNodeId: 'api' }, {
    width: 120, height: 40, time: 0, now, palette, theme,
  });
  const verboseSmall = renderApp(snapshot, {
    ...ui, verbose: true, selectedNodeId: 'api', detailsScroll: 999,
  }, {
    width: 120, height: 42, time: 0, now, palette, theme,
  });
  assert.doesNotMatch(compactSmall.text, /RECENT LOG/);
  assert.match(verboseSmall.text, /RECENT LOG/);
  assert.match(verboseSmall.text, /\[00:/);
});

test('a cycle is reported inside the graph instead of throwing', () => {
  const cyclic = normalizeSnapshot({
    sessionId: 's', tasks: [], runs: [{
      id: 'cycle', name: 'cycle', status: 'running',
      nodes: [{ id: 'a', label: 'a', state: 'pending' }, { id: 'b', label: 'b', state: 'pending' }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    }],
  });
  const result = renderApp(cyclic, { ...ui, selectedNodeId: 'a' }, {
    width: 120, height: 40, time: 0, now, palette, theme,
  });
  assert.match(result.text, /Graph error/);
  assert.match(result.text, /cycle/i);
});

test('a precomputed graph layout renders the same frame', () => {
  const first = renderApp(snapshot, ui, {
    width: 140, height: 42, time: 1000, now, palette, theme,
  });
  const second = renderApp(snapshot, ui, {
    width: 140, height: 42, time: 1000, now, palette, theme,
    graphLayout: first.graph.layout,
  });
  assert.equal(second.text, first.text);
});

test('default-color page surfaces keep the terminal background transparent', () => {
  const system = paletteFor('system', { appearance: 'dark' });
  const colored = createTheme({ palette: system, color: true, truecolor: true });
  const canvas = new Canvas(4, 2, { fg: system.text, bg: system.bg });
  canvas.fill(0, 0, 4, 2, { fg: system.text, bg: system.bg });
  canvas.put(0, 0, 'ok', { fg: system.accent, bg: system.bg });
  const text = canvas.toString(colored);
  assert.ok(text.includes('\x1b[49m'));
  assert.ok(text.includes('\x1b[39m'));
  assert.ok(!text.includes('48;2;'));
  canvas.fadeRect(0, 0, 4, 2, 0.58, '');
  assert.equal(canvas.cell(0, 0).bg, '');
  assert.ok(canvas.cell(0, 0).flags & 2);
});

test('truecolor themes emit ANSI and no-color themes do not', () => {
  const colored = createTheme({ palette, color: true, truecolor: true });
  const withColor = renderApp(snapshot, ui, { width: 120, height: 40, time: 0, now, palette, theme: colored });
  assert.ok(withColor.text.includes('\x1b[38;2;'));
  const plain = renderApp(snapshot, ui, { width: 120, height: 40, time: 0, now, palette, theme });
  assert.ok(!plain.text.includes('\x1b[38'));
});

test('Chinese chrome translates labels and exposes the footer settings button', () => {
  const result = renderApp(snapshot, { ...ui, language: 'zh', selectedNodeId: 'intake' }, {
    width: 140, height: 42, time: 0, now, palette, theme,
  });
  assert.match(result.text, /导航/);
  assert.match(result.text, /图谱/);
  assert.match(result.text, /设置/);
  assert.match(result.text, /指标/);
  assert.match(result.text, /连接/);
  assert.match(result.text, /\? 帮助/);
  assert.match(result.text, /思考/);
  assert.doesNotMatch(result.text, /回复/);
  assert.match(result.text, /刚刚/);
  assert.doesNotMatch(result.text, /图谱连线/);
  assert.doesNotMatch(result.text, /最近日志/);
  assert.doesNotMatch(result.text, /NAVIGATION|METRICS|RECENT LOG|SETTINGS|GRAPH LINKS/);
  assert.ok(result.hitboxes.settings);
  assert.ok(result.hitboxes.settings.y > result.layout.sidebar.y);
  assert.equal(result.hitboxes.settings.x + result.hitboxes.settings.w, 139);
});

test('the settings menu exposes theme, animation, language, and hitboxes', () => {
  const result = renderApp(snapshot, {
    ...ui, language: 'en', settingsMenu: true, settingsIndex: 0,
  }, { width: 120, height: 40, time: 0, now, palette, theme });
  assert.match(result.text, /SETTINGS/);
  assert.match(result.text, /Theme/);
  assert.match(result.text, /Animation/);
  assert.match(result.text, /Animation: ON \(this session\)/);
  assert.match(result.text, /Language/);
  assert.match(result.text, /English/);
  assert.deepEqual([...result.hitboxes.settingsOptions.keys()], ['theme', 'animation', 'language']);
  assert.ok(result.hitboxes.helpHint);
  const zh = renderApp(snapshot, {
    ...ui, language: 'zh', settingsMenu: true, settingsIndex: 2,
  }, { width: 120, height: 40, time: 0, now, palette, theme });
  assert.match(zh.text, /设置/);
  assert.match(zh.text, /主题/);
  assert.match(zh.text, /动画/);
  assert.match(zh.text, /本会话/);
  assert.match(zh.text, /中文/);
});

test('wheel regions cover exactly the three panes and exclude chrome', () => {
  const result = renderApp(snapshot, ui, { width: 120, height: 40, time: 0, now, palette, theme });
  const regions = result.hitboxes.regions;
  assert.deepEqual([...regions.keys()], ['graph', 'tasks', 'details']);
  assert.deepEqual(regions.get('graph'), result.layout.graph);
  assert.deepEqual(regions.get('details'), result.layout.details);
  assert.deepEqual(regions.get('tasks'), { x: 1, y: 15, w: 24, h: 22 });

  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w &&
    a.y < b.y + b.h && b.y < a.y + a.h;
  const rects = [...regions.values()];
  for (let index = 0; index < rects.length; index++) {
    for (let other = index + 1; other < rects.length; other++) {
      assert.ok(!overlaps(rects[index], rects[other]), `region overlap ${index}/${other}`);
    }
  }

  const center = rect => [rect.x + Math.floor(rect.w / 2), rect.y + Math.floor(rect.h / 2)];
  for (const [id, rect] of regions) {
    assert.equal(regionAt(...center(rect), regions), id, `center of ${id}`);
  }
  const outside = [
    [0, 0], [0, 39],
    [25, 20], [1, 4], [1, 14], [1, 38], [1, 39],
    [83, 20],
  ];
  for (const [x, y] of outside) {
    assert.equal(regionAt(x, y, regions), null, `outside cell ${x},${y}`);
  }
});

test('duty exposes runs, cells, and details scroll regions', () => {
  const result = renderApp(snapshot, { ...ui, focus: 'tasks' }, {
    width: 70, height: 24, time: 0, now, palette, theme,
  });
  const regions = result.hitboxes.regions;
  assert.deepEqual([...regions.keys()], ['runs', 'cells', 'details']);
  assert.equal(result.scroll.tasks.viewportH, 0);
  assert.equal(result.scroll.tasks.bar, null);
  assert.equal(result.scroll.graph.viewportH, 0);
  const detailsRegion = regions.get('details');
  assert.ok(detailsRegion);
  assert.equal(regionAt(35, detailsRegion.y + 1, regions), 'details');
  assert.equal(regionAt(35, 0, regions), null);
  assert.equal(regionAt(35, 22, regions), null);
});

test('graph scrollbar uses the last interior column and tracks the offset', () => {
  const top = renderApp(snapshot, ui, { width: 120, height: 40, time: 0, now, palette, theme });
  const graph = top.layout.graph;
  const bar = top.scroll.graph.bar;
  assert.ok(bar);
  assert.equal(bar.x, graph.x + graph.w - 2);
  assert.equal(bar.w, 1);
  assert.equal(bar.y, graph.y + 1);
  assert.equal(bar.h, top.scroll.graph.viewportH);
  assert.deepEqual(top.hitboxes.scrollbars.get('graph'), bar);
  assert.equal(top.canvas.cells[bar.y][graph.x + graph.w - 1].ch, '│');
  assert.equal(top.canvas.cells[bar.y][bar.x].ch, '█');
  assert.equal(top.canvas.cells[bar.y + bar.thumbH][bar.x].ch, '░');

  const bottom = renderApp(snapshot, { ...ui, graphScroll: 47 }, {
    width: 120, height: 40, time: 0, now, palette, theme,
  });
  assert.equal(bottom.scroll.graph.offset, 47);
  const bottomBar = bottom.scroll.graph.bar;
  assert.equal(bottomBar.thumbTop + bottomBar.thumbH, bottomBar.y + bottomBar.h);
  assert.equal(bottom.canvas.cells[bottomBar.y][bottomBar.x].ch, '░');
  assert.equal(bottom.canvas.cells[bottomBar.y + bottomBar.h - 1][bottomBar.x].ch, '█');

  const tall = renderApp(snapshot, ui, { width: 120, height: 100, time: 0, now, palette, theme });
  assert.equal(tall.scroll.graph.maxScroll, 0);
  assert.equal(tall.scroll.graph.bar, null);
  const column = tall.layout.graph.x + tall.layout.graph.w - 2;
  for (let y = tall.layout.graph.y + 1; y < tall.layout.graph.y + tall.layout.graph.h - 1; y++) {
    assert.ok(!['░', '█'].includes(tall.canvas.cells[y][column].ch), `rail at ${column},${y}`);
  }
});

test('navigation tasks scroll by items with a reserved bar column', () => {
  const tasks = navTasks(snapshot);
  assert.equal(tasks.length, 43);

  const top = renderApp(snapshot, ui, { width: 120, height: 40, time: 0, now, palette, theme });
  assert.equal(top.scroll.tasks.contentH, 43);
  assert.equal(top.scroll.tasks.viewportH, 11);
  assert.equal(top.scroll.tasks.maxScroll, 32);
  assert.equal(top.scroll.tasks.offset, 0);
  assert.deepEqual(
    [top.scroll.tasks.bar.x, top.scroll.tasks.bar.y, top.scroll.tasks.bar.h, top.scroll.tasks.bar.w],
    [24, 15, 22, 1],
  );
  assert.equal(top.hitboxes.tasks.size, 11);
  assert.deepEqual([...top.hitboxes.tasks.keys()], tasks.slice(0, 11).map(task => task.id));
  for (const rect of top.hitboxes.tasks.values()) {
    assert.equal(rect.x, 1);
    assert.equal(rect.w, 23);
    assert.equal(rect.x + rect.w, top.scroll.tasks.bar.x);
    assert.ok(!(24 >= rect.x && 24 < rect.x + rect.w), 'bar column is not clickable');
  }
  assert.equal(top.canvas.cells[top.scroll.tasks.bar.y][24].ch, '█');
  assert.equal(top.canvas.cells[top.scroll.tasks.bar.y][25].ch, '│');

  const bottom = renderApp(snapshot, { ...ui, tasksScroll: 33 }, {
    width: 120, height: 40, time: 0, now, palette, theme,
  });
  assert.equal(bottom.scroll.tasks.offset, 32);
  assert.equal(bottom.hitboxes.tasks.size, 11);
  assert.deepEqual([...bottom.hitboxes.tasks.keys()], tasks.slice(32).map(task => task.id));
  const bottomBar = bottom.scroll.tasks.bar;
  assert.equal(bottomBar.thumbTop + bottomBar.thumbH, bottomBar.y + bottomBar.h);

  const small = renderApp(snapshot, { ...ui, tasksScroll: 35 }, {
    width: 112, height: 36, time: 0, now, palette, theme,
  });
  assert.equal(small.scroll.tasks.viewportH, 9);
  assert.equal(small.scroll.tasks.maxScroll, 34);
  assert.equal(small.scroll.tasks.offset, 34);
  assert.deepEqual([...small.hitboxes.tasks.keys()], tasks.slice(34).map(task => task.id));
  assert.equal(small.scroll.tasks.bar.thumbTop, 31);
  assert.equal(small.scroll.tasks.bar.thumbH, 2);

  const short = renderApp(snapshot, ui, { width: 140, height: 24, time: 0, now, palette, theme });
  assert.equal(short.scroll.tasks.viewportH, 4);
  assert.equal(short.scroll.tasks.maxScroll, 39);
  assert.equal(short.hitboxes.regions.get('tasks').h, 8);
  assert.doesNotMatch(short.text, /\+39 more/);

  const roots = snapshot.tasks.filter(task => !task.parentTaskId).slice(0, 3);
  const few = { ...snapshot, runs: [], tasks: roots };
  const fit = renderApp(few, { ...ui, selectedTaskId: roots[0].id }, {
    width: 120, height: 40, time: 0, now, palette, theme,
  });
  assert.equal(fit.scroll.tasks.contentH, 3);
  assert.equal(fit.scroll.tasks.maxScroll, 0);
  assert.equal(fit.scroll.tasks.bar, null);
  assert.equal(fit.hitboxes.tasks.size, 3);
});

test('details measure scrollable content and clip above the viewport', () => {
  const verbose = { ...ui, verbose: true, selectedNodeId: 'api' };
  const top = renderApp(snapshot, verbose, { width: 120, height: 40, time: 0, now, palette, theme });
  assert.equal(top.scroll.details.contentH, 51);
  assert.equal(top.scroll.details.viewportH, 32);
  assert.equal(top.scroll.details.maxScroll, 19);
  const bar = top.scroll.details.bar;
  assert.deepEqual([bar.x, bar.y, bar.h, bar.w], [118, 5, 32, 1]);
  assert.deepEqual(top.hitboxes.scrollbars.get('details'), bar);
  assert.equal(top.canvas.cells[bar.y][119].ch, '│');
  assert.equal(top.canvas.cells[bar.y][bar.x].ch, '█');

  const bottom = renderApp(snapshot, { ...verbose, detailsScroll: 5 }, {
    width: 120, height: 40, time: 0, now, palette, theme,
  });
  assert.equal(bottom.scroll.details.offset, 5);
  assert.notEqual(bottom.text, top.text);
  assert.match(top.text, /NODE · build-api/);
  assert.match(bottom.text, /NODE · build-api/);

  const rect = top.layout.details;
  for (const result of [top, bottom]) {
    for (let x = rect.x + 1; x <= rect.x + rect.w - 2; x++) {
      assert.equal(result.canvas.cells[rect.y + 1][x].ch, ' ', `clip row ${x}`);
    }
    let content = 0;
    for (let x = rect.x + 1; x <= rect.x + rect.w - 2; x++) {
      if (result.canvas.cells[rect.y + 2][x].ch !== ' ') content++;
    }
    assert.ok(content > 0, 'first content row is populated');
  }

  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 120; x++) {
      const inDetails = x >= rect.x && x < rect.x + rect.w &&
        y >= rect.y && y < rect.y + rect.h;
      if (!inDetails) {
        assert.equal(bottom.canvas.cells[y][x].ch, top.canvas.cells[y][x].ch, `${x},${y}`);
      }
    }
  }

  const compact = renderApp(snapshot, ui, { width: 120, height: 40, time: 0, now, palette, theme });
  assert.equal(compact.scroll.details.contentH, 32);
  assert.equal(compact.scroll.details.viewportH, 32);
  assert.equal(compact.scroll.details.maxScroll, 0);
  assert.equal(compact.scroll.details.bar, null);

  const mid = renderApp(snapshot, ui, { width: 112, height: 36, time: 0, now, palette, theme });
  assert.equal(mid.scroll.details.contentH, 32);
  assert.equal(mid.scroll.details.viewportH, 28);
  assert.equal(mid.scroll.details.maxScroll, 4);
  assert.deepEqual([mid.scroll.details.bar.x, mid.scroll.details.bar.y, mid.scroll.details.bar.h], [110, 5, 28]);
  assert.equal(mid.scroll.details.offset, 0);
});

test('partially visible node hitboxes clamp to the graph viewport', () => {
  const result = renderApp(snapshot, { ...ui, graphScroll: 3 }, {
    width: 120, height: 40, time: 0, now, palette, theme,
  });
  assert.equal(result.scroll.graph.offset, 3);
  assert.deepEqual(result.hitboxes.nodes.get('intake'), { x: 42, y: 4, w: 25, h: 5 });
  assert.deepEqual(result.hitboxes.nodes.get('security'), { x: 42, y: 34, w: 25, h: 1 });
  const graph = result.layout.graph;
  for (const [id, rect] of result.hitboxes.nodes) {
    assert.ok(rect.y >= graph.y + 1, `${id} top`);
    assert.ok(rect.y + rect.h <= graph.y + 1 + result.graph.viewportH, `${id} bottom`);
    assert.ok(rect.x >= graph.x + 2, `${id} left`);
    assert.ok(rect.x + rect.w <= graph.x + graph.w - 2, `${id} right`);
  }
});

test('details subject key changes only when the subject changes', () => {
  const node = detailsSubjectKey(snapshot, { ...ui, focus: 'graph', selectedNodeId: 'api' });
  const otherNode = detailsSubjectKey(snapshot, { ...ui, focus: 'graph', selectedNodeId: 'intake' });
  const task = detailsSubjectKey(snapshot, { ...ui, focus: 'tasks', selectedTaskId: 'st_index' });
  const run = detailsSubjectKey(snapshot, { ...ui, focus: 'graph', selectedNodeId: undefined });
  assert.match(node, /^node:.*:api$/);
  assert.match(task, /^task:/);
  assert.match(run, /^run:/);
  assert.notEqual(node, otherNode);
  assert.equal(node, detailsSubjectKey(snapshot, {
    ...ui, focus: 'graph', selectedNodeId: 'api', detailsScroll: 5, tasksScroll: 4, graphScroll: 20,
  }));
});

test('duty names its subject and renders focus as a visible glyph', () => {
  const at = (focus, overrides = {}) => renderApp(snapshot, { ...ui, focus, ...overrides }, {
    width: 54, height: 42, time: 0, now, palette, theme,
  });
  const frames = {
    graph: at('graph'), runs: at('runs'), cells: at('cells'),
    details: at('details'), duty: at('duty'),
  };
  assert.match(frames.graph.text, /CURRENT NODE · build-api/);
  assert.doesNotMatch(frames.graph.text, /DUTY/);
  assert.match(frames.runs.text, /▸ RUNS/);
  assert.match(frames.cells.text, /▸ CELLS · integration review/);
  assert.match(frames.details.text, /▸ CURRENT NODE · build-api/);
  assert.match(frames.duty.text, /▸ CURRENT NODE · build-api/);
  assert.doesNotMatch(frames.graph.text, /▸ RUNS|▸ CELLS|▸ CURRENT NODE/);
  assert.notEqual(frames.graph.text, frames.details.text);
  assert.notEqual(frames.runs.text, frames.graph.text);
  assert.notEqual(frames.cells.text, frames.graph.text);
  assert.notEqual(frames.details.text, frames.runs.text);
  assert.equal(frames.duty.text, frames.details.text);

  const zh = at('details', { language: 'zh' });
  assert.match(zh.text, /▸ 当前节点 · build-api/);
  assert.doesNotMatch(zh.text, /任务面板/);
});

test('selected narrow run and cell rows keep a row-level marker without color', () => {
  const runs = renderApp(snapshot, { ...ui, runIndex: 2, focus: 'runs' }, {
    width: 54, height: 42, time: 0, now, palette, theme,
  });
  const selectedRun = frameLines(runs).find(line => /^│/.test(line) && line.includes('release audit'));
  assert.ok(selectedRun, 'selected third run row is painted');
  assert.match(selectedRun, /^│ ▸ /, 'selected non-first run carries the row marker');
  const otherRun = frameLines(runs).find(line => /^│/.test(line) && line.includes('integration review'));
  assert.ok(otherRun, 'unselected first run row is painted');
  assert.match(otherRun, /^│   /, 'unselected run keeps the marker column blank');
  assert.doesNotMatch(otherRun, /▸/);

  const cells = renderApp(snapshot, {
    ...ui, runIndex: 0, focus: 'cells', selectedNodeId: 'api',
  }, { width: 54, height: 42, time: 0, now, palette, theme });
  const selectedCell = frameLines(cells).find(line => /^│/.test(line) && line.includes('build-api'));
  assert.ok(selectedCell, 'selected third cell row is painted');
  assert.match(selectedCell, /^│ ▸ /, 'selected non-first cell carries the row marker');
  const otherCell = frameLines(cells).find(line => /^│/.test(line) && line.includes('intake'));
  assert.ok(otherCell, 'unselected first cell row is painted');
  assert.match(otherCell, /^│   /, 'unselected cell keeps the marker column blank');
  assert.doesNotMatch(otherCell, /▸/);
});

test('help scrolls to every documented key at 54x20 with the data line pinned', () => {
  const help = (helpScroll, width = 54, height = 20) => renderApp(snapshot, {
    ...ui, help: true, helpScroll,
  }, { width, height, time: 0, now, palette, theme });
  const top = help(0);
  const end = help(999);
  assert.equal(top.help.total, 22);
  assert.equal(top.help.scroll, 0);
  assert.ok(top.help.maxScroll > 0);
  assert.equal(end.help.scroll, end.help.maxScroll);
  assert.match(top.text, /1 \/ 2 \/ 3/);
  assert.match(top.text, /PgUp \/ PgDn/);
  assert.match(top.text, /g \/ G  Home\/End/);
  assert.match(end.text, /q\s+quit \(close Help first\)/, 'Help says it must close before quitting');
  assert.match(end.text, /\? \/ Esc/);
  assert.match(end.text, /\bs\s+open settings/);
  assert.match(end.text, /\bS\s+toggle sidebar/);
  assert.match(end.text, /\br\s+restart demo cycle/);
  const all = top.text + end.text;
  for (const key of ['t', 's', 'S', 'r', '? / Esc', 'q', 'g / G', 'Home/End', '1 / 2 / 3']) {
    assert.ok(all.includes(key), `help key missing ${key}`);
  }
  const topData = frameLines(top).find(line => line.includes('Demo data:'));
  const endData = frameLines(end).find(line => line.includes('Demo data:'));
  assert.ok(topData);
  assert.equal(endData, topData);
  assert.match(top.text, /\d+-\d+\/22/);
  assert.match(end.text, /10-22\/22/);

  const roomy = help(0, 54, 42);
  assert.equal(roomy.help.maxScroll, 0);
  assert.equal(roomy.help.visibleRows, 22);
  assert.doesNotMatch(roomy.text, /\d+-\d+\/22/);
  const wide = help(0, 120, 40);
  assert.equal(wide.help.maxScroll, 0);
});

test('footer names actions in both languages and keeps m/x hitboxes inside 54 columns', () => {
  const foot = (language = 'en', width = 54) => renderApp(snapshot, {
    ...ui, language,
  }, { width, height: 42, time: 0, now, palette, theme });
  const en = foot('en');
  const footer = frameLines(en).at(-1);
  assert.match(footer, /● ✓ × ◌/);
  assert.match(footer, /\? Help m select x clear/);
  assert.match(footer, /⚙ SETTINGS/);
  assert.doesNotMatch(footer, /…/);
  for (const key of ['helpHint', 'selectHint', 'clearHint', 'settings']) {
    const rect = en.hitboxes[key];
    assert.ok(rect, `${key} hitbox`);
    assert.ok(rect.x >= 0 && rect.x + rect.w <= 54, `${key} inside 0-53`);
    assert.equal(rect.y, 41);
  }
  assert.ok(en.hitboxes.settings.x + en.hitboxes.settings.w <= 54);

  const zh = foot('zh');
  const zhFooter = frameLines(zh).at(-1);
  assert.match(zhFooter, /m 选区/);
  assert.match(zhFooter, /x 清除/);
  assert.match(zhFooter, /⚙ 设置/);
  for (const key of ['selectHint', 'clearHint']) {
    const rect = zh.hitboxes[key];
    assert.ok(rect, `zh ${key} hitbox`);
    assert.ok(rect.x + rect.w <= 54);
  }
  assert.equal(zh.hitboxes.settings.x + zh.hitboxes.settings.w, 53);

  const wide = renderApp(snapshot, ui, {
    width: 120, height: 40, time: 0, now, palette, theme,
  });
  const wideFooter = frameLines(wide).at(-1);
  assert.match(wideFooter, /●run ✓done ×fail ◌wait/);
  assert.match(wideFooter, /m select x clear/);
  assert.equal(wide.hitboxes.settings.x + wide.hitboxes.settings.w, 119);
  assert.ok(wide.hitboxes.selectHint && wide.hitboxes.clearHint);

  for (const columns of [40, 51, 54, 60, 64, 71, 84, 120]) {
    const result = renderApp(snapshot, ui, {
      width: columns, height: 42, time: 0, now, palette, theme,
    });
    const settings = result.hitboxes.settings;
    assert.equal(settings.x + settings.w, columns - 1, `settings right at ${columns}`);
    assert.ok(settings.x >= 0 && settings.w > 0, `settings inside ${columns}`);
    assert.ok(result.hitboxes.selectHint, `select hint at ${columns}`);
    assert.ok(result.hitboxes.clearHint, `clear hint at ${columns}`);
    assert.ok(result.hitboxes.selectHint.x + result.hitboxes.selectHint.w <= columns);
    assert.ok(result.hitboxes.clearHint.x + result.hitboxes.clearHint.w <= columns);
  }
});

// A stale capture keeps its last recorded activity as evidence, but it is no
// longer live work: the graph and navigation must freeze that activity age and
// every spinner/shimmer at the capture instant while the header keeps growing.
function staleCaptureFixture() {
  const capturedAt = Date.UTC(2026, 10, 10, 12, 0, 0);
  const startedAt = new Date(capturedAt - 60_000).toISOString();
  const snap = normalizeSnapshot({
    version: 3, mode: 'live', connected: true, sessionId: 'stale-graph',
    provenance: {
      origin: 'controller', statePath: '/tmp/herdr-dag/state.json',
      capturedAt: new Date(capturedAt).toISOString(),
    },
    runs: [{
      id: 'run_stale', name: 'Stale run', status: 'running',
      createdAt: new Date(capturedAt - 3600_000).toISOString(),
      updatedAt: new Date(capturedAt).toISOString(),
      nodes: [
        {
          id: 'stale_node', label: 'stale probe', state: 'running', task_id: 'st_stale',
          startedAt, percent: 40,
          activity: { phase: 'tool', tool: 'rg', since: capturedAt - 5000, lastAt: capturedAt - 1000 },
        },
        {
          id: 'stale_done', label: 'stale done', state: 'completed', task_id: 'st_stale_done',
          startedAt: new Date(capturedAt - 120_000).toISOString(), percent: 100,
          completedAt: new Date(capturedAt - 10_000).toISOString(),
        },
      ],
      edges: [{ from: 'stale_node', to: 'stale_done' }],
    }],
    tasks: [
      { id: 'st_stale', description: 'stale probe task', status: 'running', startedAt },
      {
        id: 'st_stale_done', description: 'stale finished task', status: 'completed',
        startedAt: new Date(capturedAt - 120_000).toISOString(),
        completedAt: new Date(capturedAt - 10_000).toISOString(),
      },
    ],
  });
  return { snap, capturedAt };
}

const regionCells = (result, rect) => {
  const rows = [];
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    rows.push(result.canvas.cells[y].slice(rect.x, rect.x + rect.w));
  }
  return rows;
};
const regionText = (result, rect) => regionCells(result, rect)
  .map(row => row.map(cell => cell.ch).join('')).join('\n');
const regionSignature = (result, rect) => regionCells(result, rect)
  .map(row => row.map(cell => `${cell.ch}\u0000${cell.fg}\u0000${cell.bg}\u0000${cell.flags}`).join('\u0001'))
  .join('\n');

test('a stale capture freezes graph and sidebar activity age and animation', () => {
  const { snap, capturedAt } = staleCaptureFixture();
  const staleUi = {
    ...ui, runIndex: 0, focus: 'graph', selectedNodeId: 'stale_node', selectedTaskId: 'st_stale',
  };
  const frame = (timeValue, frameNow, motion = true) => renderApp(snap, { ...staleUi, motion }, {
    width: 140, height: 42, time: timeValue, now: frameNow, palette, theme,
  });

  const atCapture = frame(0, capturedAt + 120_000);
  assert.match(atCapture.text, /▲ STALE/, 'the fixture renders as stale');
  const graph = regionText(atCapture, atCapture.layout.graph);
  assert.match(graph, /rg running 5s/, 'graph activity is measured to the capture instant');
  assert.doesNotMatch(graph, /running 8h/, 'graph activity does not include time after capture');

  const twoMinutesLater = frame(0, capturedAt + 240_000);
  assert.equal(
    regionText(twoMinutesLater, twoMinutesLater.layout.graph), graph,
    'stale graph activity age does not grow with the wall clock',
  );
  assert.equal(
    regionText(twoMinutesLater, twoMinutesLater.layout.sidebar),
    regionText(atCapture, atCapture.layout.sidebar),
    'stale sidebar rows do not change with the wall clock',
  );

  const animated = frame(360, capturedAt + 120_000);
  assert.equal(
    regionSignature(animated, animated.layout.graph), regionSignature(atCapture, atCapture.layout.graph),
    'stale graph spinner and wire shimmer are frozen',
  );
  assert.equal(
    regionSignature(animated, animated.layout.sidebar), regionSignature(atCapture, atCapture.layout.sidebar),
    'stale sidebar spinner and indeterminate bar are frozen',
  );

  // Control: a fresh capture of the same origin keeps aging and animating, so
  // the freeze applies to staleness only.
  const freshNow = capturedAt + 5000;
  const freshUi = { ...staleUi, staleAfterMs: 600_000 };
  const freshFrame = (timeValue, frameNow, motion = true) => renderApp(snap, { ...freshUi, motion }, {
    width: 140, height: 42, time: timeValue, now: frameNow, palette, theme,
  });
  const live = freshFrame(0, freshNow);
  assert.match(live.text, /● LIVE/, 'the control capture is live');
  const liveGraph = regionText(live, live.layout.graph);
  assert.match(liveGraph, /rg running 10s/);
  const liveLater = freshFrame(0, freshNow + 120_000);
  assert.match(
    regionText(liveLater, liveLater.layout.graph), /rg running 2m 10s/,
    'a live capture keeps aging with the wall clock',
  );
  const liveAnimated = freshFrame(360, freshNow);
  assert.notEqual(
    regionSignature(liveAnimated, liveAnimated.layout.graph), regionSignature(live, live.layout.graph),
    'a live capture keeps animating',
  );
});

// A completed node linked to a task that is still running is finished work:
// the graph box and details pane must show completion evidence, never the
// task's live "bash running" line. A running node sharing the task still does.
test('a completed node linked to a running task shows completion, not live activity', () => {
  const activity = { phase: 'tool', tool: 'bash', since: 1000, lastAt: 2000 };
  const snap = normalizeSnapshot({
    version: 3, mode: 'live', connected: true,
    runs: [{
      id: 'run_residual', name: 'residual activity', status: 'running',
      nodes: [
        { id: 'done', label: 'done node', state: 'completed', task_id: 'st_live' },
        { id: 'live', label: 'live node', state: 'running', task_id: 'st_live' },
      ],
      edges: [],
    }],
    tasks: [{ id: 'st_live', description: 'live task', status: 'running', activity }],
  });
  const frame = selectedNodeId => renderApp(snap, {
    ...ui, runIndex: 0, selectedNodeId, selectedTaskId: 'st_live', motion: false,
  }, { width: 140, height: 42, time: 0, now: 6000, palette, theme });

  const done = frame('done');
  const doneGraph = regionText(done, done.hitboxes.nodes.get('done'));
  assert.match(doneGraph, /evidence captured/, 'the completed node keeps completion evidence');
  assert.doesNotMatch(doneGraph, /bash running/, 'the completed node inherits no live activity');
  assert.doesNotMatch(regionText(done, done.layout.details), /bash running/,
    'the completed node details pane shows no live activity');

  const live = frame('live');
  assert.match(regionText(live, live.hitboxes.nodes.get('live')), /bash running/,
    'the running node linked to the same task still shows live activity');
  assert.match(regionText(live, live.layout.details), /bash running/,
    'the running node details pane still shows live activity');
});

// ---- Phase 3 regressions (ui-render-a) ----

function emptySourceSnapshot({ capturedAt, sources = [] }) {
  return normalizeSnapshot({
    version: 3, mode: 'live', connected: true, sessionId: 'empty-audit',
    provenance: {
      origin: 'controller', statePath: '/tmp/herdr-dag/state.json',
      capturedAt: new Date(capturedAt).toISOString(),
    },
    sources,
    runs: [], tasks: [],
  });
}

const auditSource = (status = 'unreadable') => ({
  id: 'store', label: 'repo store', root: '/tmp/senorepo', status,
  tasks: { files: 3, accepted: 12, foreign: 0, invalid: 1 },
  runs: { files: 4, accepted: 3, foreign: 1, invalid: 0 },
  scannedAt: new Date(now - 5000).toISOString(),
  ...(status === 'unreadable' ? { error: 'EACCES: permission denied' } : {}),
});

// F-38: a stale live capture owns the empty body but must not claim CONNECTED.
test('a stale empty capture renders STALE, not CONNECTED', () => {
  const captured = now - 8 * 3600_000;
  const snap = emptySourceSnapshot({ capturedAt: captured, sources: [auditSource('ok')] });
  for (const [columns, rows] of [[120, 40], [54, 42]]) {
    const result = renderApp(snap, ui, { width: columns, height: rows, time: 0, now, palette, theme });
    assert.match(result.text, /▲ STALE/, `header STALE at ${columns}`);
    assert.match(result.text, /STALE · No workflow yet\./, `empty STALE headline at ${columns}`);
    assert.doesNotMatch(result.text, /CONNECTED · NO WORKFLOW YET/, `no CONNECTED claim at ${columns}`);
    assert.match(result.text, /captured 8h ago/, `captured age at ${columns}`);
    assert.match(result.text, /check the path and retry/, `stale next step at ${columns}`);
    assert.doesNotMatch(result.text, /wait for the producer/, `no live-wait copy at ${columns}`);
  }
  const zh = renderApp(snap, { ...ui, language: 'zh' }, {
    width: 120, height: 40, time: 0, now, palette, theme,
  });
  assert.match(zh.text, /已过期 · 暂无 workflow/);
  assert.doesNotMatch(zh.text, /已连接/);

  // Control: a fresh connected capture still says CONNECTED.
  const fresh = emptySourceSnapshot({ capturedAt: now - 3000, sources: [auditSource('ok')] });
  const freshFrame = renderApp(fresh, ui, {
    width: 120, height: 40, time: 0, now, palette, theme,
  });
  assert.match(freshFrame.text, /CONNECTED · NO WORKFLOW YET/);
  assert.doesNotMatch(freshFrame.text, /STALE · No workflow yet\./);
});

// F-39: source health is bounded by the empty-state bottom, never the border.
test('source health cannot paint over the graph box at minimum heights', () => {
  const snap = emptySourceSnapshot({ capturedAt: now - 3000, sources: [auditSource()] });
  for (let height = 12; height <= 18; height++) {
    const result = renderApp(snap, { ...ui, staleAfterMs: 60 * 60_000 }, {
      width: 120, height, time: 0, now, palette, theme,
    });
    const rect = result.layout.graph;
    const rows = regionText(result, rect).split('\n');
    assert.match(rows.at(-1), /^╰─+╯$/, `graph bottom border at height ${height}`);
    if (height === 12) {
      // No heading-plus-one-row room: the block is skipped entirely.
      assert.doesNotMatch(rows.join('\n'), /\bSOURCE\b/, 'no orphan source heading');
      assert.doesNotMatch(rows.join('\n'), /EACCES/, 'no health row over the border');
    }
  }
});

// F-40: the health block translates its status tokens and count vocabulary,
// not only the section heading and the tasks/runs panel words.
test('source health status and counts are translated while English stays stable', () => {
  const zhStatus = { ok: '正常', missing: '缺失', empty: '空', unreadable: '不可读' };
  for (const status of Object.keys(zhStatus)) {
    const snap = emptySourceSnapshot({ capturedAt: now - 3000, sources: [auditSource(status)] });
    const zh = renderApp(snap, { ...ui, language: 'zh' }, {
      width: 120, height: 40, time: 0, now, palette, theme,
    });
    assert.match(zh.text, /来源/);
    assert.match(zh.text, new RegExp(`repo store ${zhStatus[status]}`), `zh ${status} token`);
    assert.match(zh.text, /任务 12 已接受 · 0 外来 · 1 无效/, 'zh task counts');
    assert.match(zh.text, /运行 3\/1\/0/, 'zh run counts keep their numeric form');
    assert.doesNotMatch(zh.text, /accepted|foreign|invalid/, 'no English count vocabulary in zh');

    const en = renderApp(snap, { ...ui, language: 'en' }, {
      width: 120, height: 40, time: 0, now, palette, theme,
    });
    assert.match(en.text, new RegExp(`repo store ${status}`), `en ${status} token`);
    assert.match(en.text, /tasks 12 accepted · 0 foreign · 1 invalid/, 'en task counts');
    assert.match(en.text, /runs 3\/1\/0/, 'en run counts');
  }
});

// F-127: the exported layout helper returns safe degenerate rectangles.
test('dashboardLayout clamps degenerate frames instead of overlapping or negating', () => {
  const tiny = dashboardLayout(8, 8);
  assert.equal(tiny.body.h, 3);
  assert.equal(tiny.body.y + tiny.body.h, tiny.footer.y, 'body stops above the footer');
  assert.equal(tiny.mode, 'single');

  const degenerate = dashboardLayout(-10, 4);
  for (const [name, rect] of Object.entries({
    header: degenerate.header, body: degenerate.body,
    footer: degenerate.footer, details: degenerate.details,
  })) {
    assert.ok(rect.w >= 0 && rect.h >= 0, `${name} is non-negative`);
  }
  assert.equal(degenerate.sidebar, null);
  assert.equal(degenerate.graph, null);
});

// F-128: painting and focus predicates both come from structuralFor.
test('the investigation breakpoint is shared at 111/112 columns', () => {
  assert.equal(dashboardLayout(111, 40).layout, 'duty');
  assert.equal(dashboardLayout(111, 40).mode, 'single');
  assert.equal(dashboardLayout(112, 40).layout, 'investigation');
  assert.equal(dashboardLayout(112, 40).mode, 'columns');
  assert.equal(dashboardLayout(111, 40, { expanded: true }).mode, 'single');
  assert.equal(dashboardLayout(112, 40, { expanded: true }).mode, 'columns');
});

function ghostSnapshot(nodes, edges = []) {
  return normalizeSnapshot({
    version: 2, sessionId: 'ghost-audit', tasks: [],
    runs: [{ id: 'ghost', name: 'ghost', status: 'running', nodes, edges }],
  });
}

// F-130: a cached layout is only reused for the identical node set.
test('a cached graph layout cannot leak nodes absent from the current run', () => {
  const a = { id: 'ghost-a', label: 'ghost-a', state: 'pending' };
  const b = { id: 'ghost-b', label: 'ghost-b', state: 'pending' };
  const cached = computeLayout(ghostSnapshot([a, b], [{ from: 'ghost-a', to: 'ghost-b' }]).runs[0], 60);

  const single = renderApp(ghostSnapshot([a]), {
    ...ui, selectedNodeId: 'ghost-a', graphLayout: cached,
  }, { width: 120, height: 40, time: 0, now, palette, theme });
  assert.deepEqual([...single.hitboxes.nodes.keys()], ['ghost-a']);
  assert.doesNotMatch(single.text, /ghost-b/);
  assert.equal(single.graph.layout.boxes.size, 1);

  const empty = renderApp(ghostSnapshot([]), {
    ...ui, selectedNodeId: undefined, graphLayout: cached,
  }, { width: 120, height: 40, time: 0, now, palette, theme });
  assert.equal(empty.hitboxes.nodes.size, 0);
  assert.doesNotMatch(empty.text, /\bghost-a\b|\bghost-b\b/);
  assert.equal(empty.graph.layout.boxes.size, 0);
});

// F-132: sub-one rates and near-million counts keep their magnitude.
test('token rates keep decimals and near-million counts round to m', () => {
  const snap = normalizeSnapshot({
    version: 3, mode: 'live', connected: true, sessionId: 'rate-audit', tasks: [],
    runs: [{
      id: 'rate', name: 'rate', status: 'running', edges: [],
      nodes: [{
        id: 'n', label: 'rate node', state: 'running',
        tokenRate: [0.4], tokenRateKind: 'instant', tokensIn: 1, tokensOut: 999_999,
      }],
    }],
  });
  const result = renderApp(snap, { ...ui, selectedNodeId: 'n', motion: false }, {
    width: 140, height: 42, time: 0, now, palette, theme,
  });
  assert.match(result.text, /0\.4\/s/);
  assert.doesNotMatch(result.text, / 0\/s/);
  assert.match(result.text, /1 in \/ 1\.0m out/);
  assert.doesNotMatch(result.text, /1000\.0k/);
});

// F-134: painter and hit-test share one run-block geometry.
test('the run block has one geometry source for painting and task rows', () => {
  for (const [columns, rows] of [[120, 40], [140, 24], [112, 36]]) {
    const result = renderApp(snapshot, ui, {
      width: columns, height: rows, time: 0, now, palette, theme,
    });
    const rect = result.layout.sidebar;
    const runs = runListLayout(rect, snapshot);
    const tasks = taskListLayout(rect, snapshot, ui);
    assert.equal(tasks.tasksY, runs.tasksY, `tasksY at ${columns}x${rows}`);
    const rowText = y => result.canvas.cells[y].slice(rect.x, rect.x + rect.w)
      .map(cell => cell.ch).join('');
    assert.match(rowText(runs.headingY), /RUNS/, `runs heading at ${columns}x${rows}`);
    assert.match(rowText(runs.tasksY - 1), /TASKS/, `tasks heading at ${columns}x${rows}`);
  }
});

// F-135: non-finite scroll offsets fall back to the top instead of NaN slicing.
test('NaN and string scroll offsets fall back to a finite top-of-list frame', () => {
  const result = renderApp(snapshot, {
    ...ui, graphScroll: NaN, tasksScroll: 'x', detailsScroll: NaN,
    runsScroll: NaN, cellsScroll: -4,
  }, { width: 120, height: 40, time: 0, now, palette, theme });
  assert.equal(result.scroll.graph.offset, 0);
  assert.equal(result.scroll.tasks.offset, 0);
  assert.equal(result.scroll.details.offset, 0);
  assert.equal(result.hitboxes.tasks.size, 11);
  assert.ok(result.hitboxes.tasks.has(navTasks(snapshot)[0].id));
  for (const rect of result.hitboxes.nodes.values()) {
    for (const value of [rect.x, rect.y, rect.w, rect.h]) {
      assert.ok(Number.isFinite(value), 'node hitbox stays finite');
    }
  }
  const narrow = renderApp(snapshot, {
    ...ui, runsScroll: NaN, cellsScroll: 'x', detailsScroll: NaN,
  }, { width: 70, height: 24, time: 0, now, palette, theme });
  assert.equal(narrow.scroll.runs.offset, 0);
  assert.equal(narrow.scroll.cells.offset, 0);
  assert.equal(narrow.scroll.details.offset, 0);
});

// F-182: render re-exports theme's WCAG helpers instead of a divergent copy.
test('contrast helpers are theme helpers with the same invalid-color fallback', () => {
  for (const [foreground, background] of [
    ['#ffffff', '#000000'], ['#585858', '#363636'], ['#22c55e', '#0b1220'],
  ]) {
    assert.equal(contrastRatio(foreground, background), themeContrastRatio(foreground, background));
  }
  assert.equal(contrastRatio('', '#ffffff'), null);
  assert.equal(contrastRatio('not-a-color', '#ffffff'), null);
  assert.equal(pillForeground('#ffffff'), '#000000');
  assert.equal(pillForeground('#000000'), '#ffffff');
  assert.equal(pillForeground(''), '#ffffff');
});

// F-95: the header freshness, the record action, and the diagnosis card all
// take their mode from model.modeFor instead of keeping separate derivations.
test('render freshness and record mode use the shared modeFor answer', () => {
  const snapshots = [
    { demo: { cycle: 1 } },
    { mode: 'live', connected: false },
    { mode: 'saved', connected: true },
    { connected: false },
  ];
  for (const candidate of snapshots) {
    assert.equal(snapshotFreshness(candidate).mode, modeFor(candidate));
  }
  assert.equal(snapshotFreshness({ demo: { cycle: 1 } }).mode, 'demo');
  assert.equal(snapshotFreshness({ mode: 'live', connected: false }).mode, 'live');

  const demo = normalizeSnapshot({
    version: 3,
    mode: 'demo',
    runs: [{
      id: 'r', status: 'failed',
      nodes: [{ id: 'n', label: 'n', state: 'failed', task_id: 'st_demo_fail' }], edges: [],
    }],
    tasks: [{ id: 'st_demo_fail', description: 'demo failure', status: 'failed', error: 'boom' }],
  });
  const record = recordForSelection(demo, {
    ...ui, focus: 'tasks', lastFocus: 'tasks', selectedTaskId: 'st_demo_fail',
  });
  assert.equal(record.mode, modeFor(demo));
  assert.equal(record.mode, 'demo');

  const diagnosis = diagnosisFor({ snapshot: demo, task: demo.tasks[0], subject: 'task' });
  assert.equal(diagnosis.mode, modeFor(demo));
  assert.equal(diagnosis.simulated, true);
});

const iso = ms => new Date(ms).toISOString();

function runSummaryFixture(raw) {
  return normalizeSnapshot({
    version: 3,
    mode: 'live',
    connected: true,
    sessionId: 'run-summary',
    updatedAt: iso(now),
    tasks: [],
    ...raw,
  });
}

function selectRun(resultUi = ui) {
  return {
    ...resultUi,
    focus: 'details',
    lastFocus: 'graph',
    selectedNodeId: undefined,
    selectedTaskId: undefined,
  };
}

function detailLines(result) {
  const { x, y, w, h } = result.layout.details;
  return result.text.split('\n').slice(y, y + h).map(line => line.slice(x, x + w));
}

test('the run overview summarizes a run with one aligned value column', () => {
  const result = renderApp(snapshot, selectRun(), {
    width: 140, height: 42, time: 1000, now, palette, theme,
  });
  assert.match(result.text, /RUN SUMMARY/);
  const lines = detailLines(result);
  const labels = ['status', 'tokens', 'retries', 'wall', 'critical', 'parallel', 'nodes'];
  const columns = [];
  for (const label of labels) {
    const line = lines.find(candidate => candidate.includes(label));
    assert.ok(line, `missing ${label} row`);
    let index = line.indexOf(label) + label.length;
    while (line[index] === ' ') index++;
    columns.push(index);
  }
  assert.equal(new Set(columns).size, 1, `value columns: ${columns.join(',')}`);
  assert.match(result.text, /→/);

  const duty = renderApp(snapshot, selectRun(), {
    width: 90, height: 30, time: 1000, now, palette, theme,
  });
  assert.match(duty.text, /RUN SUMMARY/, 'the duty run body carries the same summary');
});

test('run summary marks partial evidence and lower bounds', () => {
  const runAt = now;
  const snap = runSummaryFixture({
    runs: [{
      id: 'run_partial',
      name: 'partial run',
      status: 'completed',
      createdAt: iso(runAt - 10_000),
      updatedAt: iso(runAt),
      nodes: [
        {
          id: 'a', label: 'alpha', state: 'completed', task_id: 'st_a',
          startedAt: iso(runAt - 9_000), completedAt: iso(runAt - 7_000),
          tokensIn: 100, tokensOut: 50,
          costUsd: 0.5, costStatus: 'reported',
          cacheReadTokens: 100, totalTokens: 200,
          retries: 1, turns: 2, toolCalls: 3,
        },
        {
          id: 'b', label: 'beta', state: 'completed', task_id: 'st_b',
          startedAt: iso(runAt - 8_000), completedAt: iso(runAt - 6_000),
          costUsd: 0.2, costStatus: 'estimated', turns: 1,
        },
      ],
      edges: [{ from: 'a', to: 'b' }],
    }],
    tasks: [
      { id: 'st_a', status: 'completed', description: 'alpha' },
      { id: 'st_b', status: 'completed', description: 'beta' },
    ],
  });
  const result = renderApp(snap, selectRun({ ...ui }), {
    width: 140, height: 42, time: 1000, now: runAt, palette, theme,
  });
  assert.match(result.text, /100 in \/ 50 out 1\/2/);
  assert.match(result.text, /≥\$0\.50 1\/2/);
  assert.match(result.text, /50\.0% \(100\/200\) 1\/2/);
  assert.match(result.text, /alpha → beta/);
});

test('a run with only queued nodes invents no metric rows', () => {
  const snap = runSummaryFixture({
    runs: [{
      id: 'run_queued',
      name: 'queued run',
      status: 'pending',
      createdAt: iso(now - 5_000),
      updatedAt: iso(now),
      nodes: [
        { id: 'a', label: 'alpha', state: 'pending', task_id: 'st_a' },
        { id: 'b', label: 'beta', state: 'blocked', task_id: 'st_b' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    }],
    tasks: [
      { id: 'st_a', status: 'pending', description: 'alpha' },
      { id: 'st_b', status: 'blocked', description: 'beta' },
    ],
  });
  const result = renderApp(snap, selectRun({ ...ui }), {
    width: 140, height: 42, time: 1000, now, palette, theme,
  });
  const details = detailLines(result).join('\n');
  assert.match(details, /RUN SUMMARY/);
  assert.match(details, /\bstatus\b/);
  assert.match(details, /\bnodes\b/);
  assert.doesNotMatch(details, /\btokens\b/);
  assert.doesNotMatch(details, /\bcost\b/);
  assert.doesNotMatch(details, /\bhit\b/);
  assert.doesNotMatch(details, /\$\d/);
});
