import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('the command palette and tour are modal overlays', () => {
  const paletteFrame = render({ palette: true });
  assert.match(paletteFrame.text, /COMMANDS/);
  assert.equal(paletteFrame.hitboxes.palette.size, 16);
  assert.equal(paletteFrame.hitboxes.tasks.size, 0);
  assert.equal(paletteFrame.hitboxes.nodes.size, 0);

  const tour = render({ tour: 1 });
  assert.match(tour.text, /TOUR/);
  assert.match(tour.text, /1\/5/);
  assert.equal(tour.hitboxes.tasks.size, 0);
  assert.equal(tour.hitboxes.nodes.size, 0);
});

test('task scope and completed collapse shrink the navigation list', () => {
  const node = render({
    runOverview: false, selectedNodeId: 'c', selectedTaskId: 't_c', focus: 'graph',
  });
  assert.match(node.text, /TASKS\s+4\s+· run/);
  assert.match(node.text, /✓1/);
  assert.equal(node.hitboxes.tasks.size, 3);

  const expanded = render({
    runOverview: false, selectedNodeId: 'c', selectedTaskId: 't_c', focus: 'graph',
    completedCollapsed: false,
  });
  assert.equal(expanded.hitboxes.tasks.size, 4);
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
