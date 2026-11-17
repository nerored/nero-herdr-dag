import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withOrphanRun } from '../src/orphan-run.mjs';
import { renderApp } from '../src/render.mjs';
import { scrollRegionForFocus } from '../src/viewer-session.mjs';
import { baseUi, createTestViewer, makeSnapshot, themeFor } from './helpers.mjs';

const now = 1_000_000;

function manyRunsBase() {
  const runs = Array.from({ length: 10 }, (_, index) => ({
    id: `run_${index}`,
    name: `Run ${index}`,
    status: 'completed',
    createdAt: new Date(Date.UTC(2026, 10, 17, 0, index)).toISOString(),
    nodes: [{ id: `node_${index}`, label: `Node ${index}`, state: 'completed', taskId: `task_${index}` }],
    edges: [],
  }));
  const tasks = Array.from({ length: 10 }, (_, index) => ({
    id: `task_${index}`, description: `Task ${index}`, status: 'completed',
  }));
  tasks.push({ id: 'st_orphan', description: 'Orphan task', status: 'running' });
  return makeSnapshot({ runs, tasks });
}

function manyRunsSnapshot() {
  return withOrphanRun(manyRunsBase());
}

function render(snapshot, overrides = {}) {
  const { palette, theme } = themeFor(0);
  return renderApp(snapshot, baseUi(overrides), {
    width: 120, height: 40, time: 0, now, palette, theme,
  });
}

test('wide RUNS has a real viewport and scrolls to the appended virtual run', () => {
  const snapshot = manyRunsSnapshot();
  assert.equal(snapshot.runs.length, 11);
  assert.equal(snapshot.runs.at(-1).id, 'orphan:tasks');

  const top = render(snapshot, { runsScroll: 0, runsScrollTarget: 0 });
  assert.ok(top.scroll.runs.viewportH > 0, 'wide RUNS reports a viewport');
  assert.ok(top.scroll.runs.maxScroll > 0, 'wide RUNS is scrollable');
  assert.ok(top.scroll.runs.bar, 'wide RUNS paints a scrollbar');
  assert.equal(top.scroll.runs.offset, 0);
  assert.equal(top.hitboxes.runs.has('orphan:tasks'), false);
  assert.doesNotMatch(top.text, /UNATTACHED TASKS/);

  const bottom = render(snapshot, {
    runsScroll: top.scroll.runs.maxScroll,
    runsScrollTarget: top.scroll.runs.maxScroll,
  });
  assert.equal(bottom.scroll.runs.offset, top.scroll.runs.maxScroll);
  assert.equal(bottom.hitboxes.runs.has('orphan:tasks'), true);
  assert.match(bottom.text, /UNATTACHED TASKS/);
});

test('selecting the virtual run through right-arrow reveals its wide RUNS row', async () => {
  const { viewer } = await createTestViewer({
    args: { noColor: true, noMotion: true, fps: 10 },
    deps: {
      loadConfig: async () => ({ language: 'en' }),
      loadOmoTheme: async () => 'system',
      loadOmoAppearance: async () => ({}),
      columns: 120,
      rows: 40,
    },
  });
  viewer.ui.follow = false;
  viewer.acceptSnapshot(manyRunsBase(), { silent: true });
  viewer.draw();
  const virtualIndex = viewer.snapshot.runs.findIndex(run => run.virtual?.kind === 'orphans');
  for (let index = 0; index < virtualIndex; index++) {
    viewer.handleKey('\x1b[C', { sequence: '\x1b[C', name: 'right' });
  }
  assert.equal(viewer.ui.runIndex, virtualIndex);
  assert.ok(viewer.ui.runsScroll > 0, 'virtual selection reveals the last RUNS row');
  viewer.draw();
  assert.equal(viewer.lastRender.hitboxes.runs.has('orphan:tasks'), true);
  assert.match(viewer.lastRender.text, /UNATTACHED TASKS/);
});

test('the virtual run never paints a producer status or failure X', () => {
  const failed = withOrphanRun(makeSnapshot({
    runs: [],
    tasks: [{ id: 'st_fail', description: 'Failed orphan', status: 'failed' }],
  }));
  const wide = render(failed);
  assert.match(wide.text, /UNATTACHED TASKS/);
  assert.doesNotMatch(wide.text, /UNATTACHED TASKS · UNATTACHED › run overview · FAILED/);
  assert.doesNotMatch(wide.text, /RUN · UNATTACHED TASKS[^\n]*Failed/);
  assert.doesNotMatch(wide.text, /▸ × UNATTACHED TASKS/);
  assert.doesNotMatch(wide.text, /× FAILED/);

  const { palette, theme } = themeFor(0);
  const narrow = renderApp(failed, baseUi(), {
    width: 70, height: 24, time: 0, now, palette, theme,
  });
  assert.match(narrow.text, /UNATTACHED TASKS/);
  assert.doesNotMatch(narrow.text, /× UNATTACHED TASKS/);
});

test('wide RUNS is a focusable scroll region, not the details pane', () => {
  const top = render(manyRunsSnapshot());
  const region = top.hitboxes.regions.get('runs');
  assert.ok(region && region.h > 0, 'wide RUNS has a hit region');
  assert.equal(top.hitboxes.scrollbars.has('runs'), true);
  assert.equal(scrollRegionForFocus('runs', 'investigation', top.scroll), 'runs');
  assert.equal(scrollRegionForFocus('details', 'investigation', top.scroll), 'details');
});

test('a wheel over wide RUNS scrolls RUNS, not the details pane', async () => {
  const { viewer } = await createTestViewer({
    args: { noColor: true, noMotion: true, fps: 10 },
    deps: {
      loadConfig: async () => ({ language: 'en' }),
      loadOmoTheme: async () => 'system',
      loadOmoAppearance: async () => ({}),
      columns: 120,
      rows: 40,
    },
  });
  viewer.ui.follow = false;
  viewer.acceptSnapshot(manyRunsBase(), { silent: true });
  viewer.draw();
  const region = viewer.lastRender.hitboxes.regions.get('runs');
  assert.ok(region, 'wide RUNS has a wheel region');
  const beforeDetails = viewer.ui.detailsScrollTarget;
  viewer.onMouseEvent({
    button: 65,
    x: region.x + Math.floor(region.w / 2),
    y: region.y + Math.floor(region.h / 2),
    release: false,
  });
  assert.ok(viewer.ui.runsScrollTarget > 0, 'wheel moved the RUNS target');
  assert.equal(viewer.ui.detailsScrollTarget, beforeDetails, 'details did not take the wheel');
});
