import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandItems } from '../src/commands.mjs';
import { messages, t } from '../src/i18n.mjs';
import { normalizeSnapshot } from '../src/model.mjs';
import { renderApp } from '../src/render.mjs';
import { themeFor, viewerUi } from './helpers.mjs';

const now = Date.parse('2026-11-11T12:00:00.000Z');
const at = ms => new Date(ms).toISOString();
const snapshot = normalizeSnapshot({
  version: 3,
  mode: 'live',
  connected: true,
  sessionId: 'cockpit-test',
  generatedAt: at(now),
  runs: [{
    id: 'run',
    name: 'Cockpit run',
    status: 'running',
    createdAt: at(now - 60_000),
    updatedAt: at(now),
    nodes: [
      {
        id: 'a', label: 'alpha', state: 'failed', taskId: 't_a',
        startedAt: at(now - 50_000), completedAt: at(now - 40_000),
      },
      { id: 'b', label: 'beta', state: 'blocked', taskId: 't_b' },
      { id: 'c', label: 'gamma', state: 'running', taskId: 't_c', startedAt: at(now - 30_000) },
      {
        id: 'd', label: 'delta', state: 'completed', taskId: 't_d',
        startedAt: at(now - 20_000), completedAt: at(now - 10_000),
      },
    ],
    edges: [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }],
  }],
  tasks: [
    { id: 't_a', description: 'Alpha task', status: 'failed' },
    { id: 't_b', description: 'Beta task', status: 'blocked' },
    { id: 't_c', description: 'Gamma task', status: 'running' },
    { id: 't_d', description: 'Delta task', status: 'completed' },
  ],
});

const { palette, theme } = themeFor('dark');
const base = () => viewerUi({ selectedRunId: 'run', runOverview: true, focus: 'details' });
const render = (overrides = {}, options = {}) => renderApp(snapshot, { ...base(), ...overrides }, {
  width: 140, height: 42, time: 0, now, palette, theme, ...options,
});

test('the run cockpit exposes attention counts, grouped metrics, and filter chips', () => {
  const result = render();
  assert.match(result.text, /RUN SUMMARY/);
  assert.match(result.text, /1 failed/);
  assert.match(result.text, /EFFICIENCY/);
  assert.match(result.text, /TIME/);
  assert.match(result.text, /SCOPE/);
  assert.match(result.text, /1 all/);
  assert.match(result.text, /5 path/);
  assert.match(result.text, /overview/);
});

test('summary filter keys drive the graph filter line', () => {
  const failed = render({ graphFilter: 'failed' });
  assert.match(failed.text, /filter: Failed/);
  const critical = render({ graphFilter: 'critical' });
  assert.match(critical.text, /path: alpha → gamma/);
});

const collapse = text => String(text).replace(/\s+/g, ' ').trim();

// Read only the inner rows of the tour panel so its box borders cannot split
// the wrapped sentence the test is asserting.
const panelText = (frame, panel) => {
  const rows = [];
  for (let row = panel.y + 2; row < panel.y + panel.h - 2; row++) {
    let line = '';
    for (let col = panel.x + 1; col < panel.x + panel.w - 1; col++) {
      const cell = frame.canvas.cells[row]?.[col];
      if (cell && !cell.cont) line += cell.ch;
    }
    rows.push(line);
  }
  return collapse(rows.join(' '));
};
const tourStepKeys = language => Object.keys(messages[language])
  .filter(key => /^tourStep\d+$/.test(key))
  .map(key => Number(key.slice('tourStep'.length)))
  .sort((left, right) => left - right);

test('the command palette paints every command and an empty query', () => {
  const items = commandItems('en');
  const paletteFrame = render({ palette: true });
  assert.equal(paletteFrame.hitboxes.palette.size, items.length);
  assert.deepEqual([...paletteFrame.hitboxes.palette.keys()], items.map(item => item.id));
  assert.equal(paletteFrame.hitboxes.tasks.size, 0);
  assert.equal(paletteFrame.hitboxes.nodes.size, 0);
  assert.equal(paletteFrame.hitboxes.runs.size, 0);

  const empty = render({ palette: true, paletteFilter: 'no such command' });
  assert.equal(empty.hitboxes.palette.size, 0);
  assert.ok(collapse(empty.text).includes(collapse(t('en', 'paletteEmpty'))));
  assert.ok(collapse(empty.text).includes('no such command'));
  assert.equal(empty.hitboxes.tasks.size, 0);
  assert.equal(empty.hitboxes.nodes.size, 0);
});

test('every tour step paints its localized copy as a modal overlay', () => {
  const steps = tourStepKeys('en');
  assert.ok(steps.length > 0, 'the tour source has localized steps');
  assert.deepEqual(steps, steps.map((_, index) => index + 1), 'tour steps are numbered from 1');
  assert.deepEqual(tourStepKeys('zh'), steps, 'both languages document the same steps');

  for (const step of steps) {
    const tour = render({ tour: step });
    assert.ok(tour.hitboxes.tourPanel, `step ${step} paints the tour panel`);
    assert.equal(tour.hitboxes.tasks.size, 0);
    assert.equal(tour.hitboxes.nodes.size, 0);
    assert.equal(tour.hitboxes.runs.size, 0);
    const text = panelText(tour, tour.hitboxes.tourPanel);
    assert.ok(text.includes(collapse(t('en', `tourStep${step}`))), `step ${step} paints its source copy`);
    assert.ok(text.includes(`${step}/${steps.length}`), `step ${step} paints its position`);
  }
});

test('task scope and completed collapse shrink the navigation list', () => {
  const node = render({
    runOverview: false, selectedNodeId: 'c', selectedTaskId: 't_c', focus: 'graph',
  });
  assert.match(node.text, /TASKS\s+4\s+· run/);
  assert.match(node.text, /✓1/);
  assert.equal(node.hitboxes.tasks.size, 0);
  assert.equal(node.scroll.tasks.contentH, 3);

  const expanded = render({
    runOverview: false, selectedNodeId: 'c', selectedTaskId: 't_c', focus: 'graph',
    completedCollapsed: false,
  });
  assert.equal(expanded.hitboxes.tasks.size, 0);
  assert.equal(expanded.scroll.tasks.contentH, 4);
});

test('graph focus keeps only the selected node and its direct neighbors', () => {
  const focused = render({ graphFocus: 'c' });
  assert.deepEqual([...focused.graph.layout.boxes.keys()].sort(), ['a', 'b', 'c']);
});

test('node details show a why line when there is room', () => {
  const detail = render({
    runOverview: false, selectedNodeId: 'c', selectedTaskId: 't_c', focus: 'details',
  });
  assert.match(detail.text, /why/);
});
