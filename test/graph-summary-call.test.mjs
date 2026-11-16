import { test, mock } from 'bun:test';
import assert from 'node:assert/strict';

const calls = [];
const realRunSummary = await import('../src/run-summary.mjs');
const originalRunSummary = realRunSummary.runSummary; // capture before mock
mock.module('../src/run-summary.mjs', () => ({
  ...realRunSummary,
  runSummary: (...args) => {
    calls.push(args);
    return originalRunSummary(...args);
  },
}));

const { renderApp } = await import('../src/render.mjs');
const { frameSnapshot, frameUi, FIXED_NOW, FIXED_TIME } = await import('./frame-fixtures.mjs');
const { themeFor } = await import('./helpers.mjs');

const { palette, theme } = themeFor(0);
const snapshot = frameSnapshot();
const options = {
  width: 120,
  height: 40,
  time: FIXED_TIME,
  now: FIXED_NOW,
  palette,
  theme,
};

function renderPlan(graphFilter) {
  return renderApp(snapshot, {
    ...frameUi('plan', 'en'),
    graphFilter,
  }, options);
}

function renderDetails(graphFilter = 'all') {
  // The run overview is the details pane's summary-rows path; a selected node
  // or task switches the pane to subject details, which compute no summary.
  return renderApp(snapshot, {
    ...frameUi('details', 'en'),
    selectedNodeId: undefined,
    selectedTaskId: undefined,
    graphFilter,
  }, options);
}

test('plan graph filter=all does not compute a graph summary', () => {
  calls.length = 0;
  renderPlan('all');
  assert.equal(calls.length, 0);
});

test('filtered plan graph computes exactly one summary', () => {
  calls.length = 0;
  renderPlan('critical');
  assert.equal(calls.length, 1);
});

test('details run overview still computes its summary exactly once', () => {
  calls.length = 0;
  renderDetails();
  assert.equal(calls.length, 1);
});
