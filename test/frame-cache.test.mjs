import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { derivedCacheCounts, resetDerivedCacheCounts } from '../src/derived-cache.mjs';
import { runStats } from '../src/model.mjs';
import { navTasks, progressCounts, renderApp } from '../src/render.mjs';
import { runSummary } from '../src/run-summary.mjs';
import { hiddenSnapshot } from '../src/view-state.mjs';
import {
  compareFrame, FRAME_HEIGHTS, FRAME_LANGUAGES, FRAME_SURFACES, FRAME_WIDTHS, FIXED_NOW,
  FIXED_TIME, frameFixturePath, frameSnapshot, frameUi, serializeFrame,
} from './frame-fixtures.mjs';
import { baseUi, themeFor } from './helpers.mjs';

// A run-overview frame uses both runSummary call sites: the graph badge and the
// details RUN SUMMARY. Counter assertions therefore prove the two sites share
// one computation instead of merely counting one call.
function renderOverview(snapshot, ui = {}, options = {}) {
  const { palette, theme } = themeFor(0);
  return renderApp(snapshot, baseUi({
    language: 'en',
    motion: false,
    focus: 'graph',
    selectedNodeId: undefined,
    selectedTaskId: undefined,
    ...ui,
  }), {
    width: 120,
    height: 40,
    time: FIXED_TIME,
    now: FIXED_NOW,
    palette,
    theme,
    ...options,
  });
}

test('one frame computes navigation and run summary once per snapshot object', () => {
  const snapshot = frameSnapshot();
  resetDerivedCacheCounts();
  const first = renderOverview(snapshot);
  assert.match(first.text, /RUN SUMMARY/);
  const cold = derivedCacheCounts();
  assert.equal(cold.navTasks, 1, 'all navigation readers share one sorted list');
  assert.equal(cold.runSummary, 1, 'the graph badge and RUN SUMMARY share one aggregation');
  assert.equal(cold.runStats, snapshot.runs.length, 'one stats computation per run, not per row');

  // A selection/scroll-only change does not change the derived inputs: the
  // next frame reuses the same snapshot entry.
  const second = renderOverview(snapshot, { detailsScroll: 3 }, { time: 90 });
  assert.match(second.text, /RUN SUMMARY/);
  assert.deepEqual(derivedCacheCounts(), cold, 'a ui-only state change reuses the snapshot entry');
});

// A live run whose summary wall time is exactly the supplied clock offset:
// the run starts at T0, one node is still running, so wallMs = now - T0.
function clockedRun(t0) {
  return {
    id: 'run_clock',
    createdAt: new Date(t0).toISOString(),
    updatedAt: new Date(t0 + 500).toISOString(),
    status: 'running',
    nodes: [{
      id: 'live',
      label: 'live',
      state: 'running',
      startedAt: new Date(t0 + 100).toISOString(),
    }],
    edges: [],
  };
}

test('run summary cache keys on the resolved clock and reuses equal clocks', () => {
  const t0 = Date.parse('2026-11-11T12:00:00.000Z');
  const run = clockedRun(t0);
  resetDerivedCacheCounts();

  const first = runSummary(run, { now: t0 + 1_000 });
  const sameClock = runSummary(run, { now: t0 + 1_000 });
  assert.equal(sameClock, first, 'an equal resolved clock returns the cached object');
  assert.equal(first.wallMs, 1_000);
  assert.deepEqual(derivedCacheCounts().runSummary, 1, 'an equal clock does not recompute');

  const later = runSummary(run, { now: t0 + 2_000 });
  assert.notEqual(later, first, 'a changed wall time is a different summary object');
  assert.equal(later.wallMs, 2_000, 'the changed clock is reflected, not served stale');
  assert.deepEqual(derivedCacheCounts().runSummary, 2, 'a changed clock increments the counter');

  const freshRun = clockedRun(t0);
  const fresh = runSummary(freshRun, { now: t0 + 2_000 });
  assert.notEqual(fresh, later, 'a new run object recomputes even at the same clock');
  assert.deepEqual(fresh, later, 'the recomputed summary is the same honest result');
  assert.deepEqual(derivedCacheCounts().runSummary, 3);
});

test('the run summary ring bounds retained clocks and recomputes an evicted one', () => {
  const t0 = Date.parse('2026-11-11T12:00:00.000Z');
  const run = clockedRun(t0);
  const offsets = [1_000, 2_000, 3_000, 4_000];
  resetDerivedCacheCounts();

  const retained = offsets.map(offset => runSummary(run, { now: t0 + offset }));
  assert.deepEqual(derivedCacheCounts().runSummary, 4, 'the ring keeps all four clocks');

  // A fifth distinct clock can only be retained by evicting the oldest entry.
  const fifth = runSummary(run, { now: t0 + 5_000 });
  assert.equal(fifth.wallMs, 5_000);
  assert.deepEqual(derivedCacheCounts().runSummary, 5);

  // The newest retained clock is still a hit; the oldest was evicted.
  const newest = runSummary(run, { now: t0 + 4_000 });
  assert.equal(newest, retained[3], 'the newest retained clock is reused');
  assert.deepEqual(derivedCacheCounts().runSummary, 5);

  const evicted = runSummary(run, { now: t0 + offsets[0] });
  assert.notEqual(evicted, retained[0], 'the evicted clock recomputes a fresh object');
  assert.equal(evicted.wallMs, offsets[0],
    'the recomputed summary reflects its own clock instead of stale data');
  assert.deepEqual(derivedCacheCounts().runSummary, 6, 'the evicted clock recomputes once');
});

test('memoized run stats and progress counts are read-only for every caller', () => {
  const snapshot = frameSnapshot();
  const run = snapshot.runs[0];
  const task = snapshot.tasks.find(item => item.id === 'st_api');

  const stats = runStats(run);
  assert.equal(runStats(run), stats, 'a run reuses its computed stats object');
  assert.ok(Object.isFrozen(stats), 'a shared stats object must not be mutable');
  assert.ok(Object.isFrozen(stats.counts), 'the counts bucket must not be mutable either');
  assert.throws(() => { stats.total = 99; }, TypeError);
  assert.throws(() => { stats.counts.failed = 99; }, TypeError);

  const counts = progressCounts(snapshot, task, run);
  assert.equal(progressCounts(snapshot, task, run), counts, 'a snapshot reuses its progress counts');
  assert.ok(Object.isFrozen(counts), 'shared progress counts must not be mutable');
  assert.throws(() => { counts.done = 4; }, TypeError);
});

test('a new snapshot object forces recomputation even when the content is equal', () => {
  const snapshot = frameSnapshot();
  resetDerivedCacheCounts();
  renderOverview(snapshot);
  const cold = derivedCacheCounts();
  renderOverview(frameSnapshot());
  const warm = derivedCacheCounts();
  assert.equal(warm.navTasks, cold.navTasks + 1, 'a new snapshot identity is a cache miss');
  assert.equal(warm.runSummary, cold.runSummary + 1);
  assert.equal(warm.runStats, cold.runStats + snapshot.runs.length);
});

test('a state-only snapshot change invalidates the derived data', () => {
  const source = frameSnapshot();
  resetDerivedCacheCounts();
  renderOverview(source);
  const before = derivedCacheCounts();
  // A status change is a new snapshot object; the run that owns the node is a
  // new object too, while the untouched second run keeps its cached stats.
  const changed = {
    ...source,
    runs: source.runs.map((run, index) => (index === 0
      ? {
        ...run,
        nodes: run.nodes.map(node => (node.id === 'api' ? { ...node, state: 'failed' } : node)),
      }
      : run)),
    tasks: source.tasks.map(task => (task.id === 'st_api' ? { ...task, status: 'failed' } : task)),
  };
  assert.notEqual(changed, source);
  renderOverview(changed);
  const after = derivedCacheCounts();
  assert.equal(after.navTasks, before.navTasks + 1, 'the reordered navigation list is rebuilt');
  assert.equal(after.runStats, before.runStats + 1, 'only the changed run is re-aggregated');
  assert.equal(after.runSummary, before.runSummary + 1, 'the selected run is re-summarized');
});

test('a live hidden-subject overlay invalidates the snapshot-derived entry', () => {
  const source = frameSnapshot();
  resetDerivedCacheCounts();
  renderOverview(source);
  const before = derivedCacheCounts();
  const overlaid = hiddenSnapshot(source, { taskIds: new Set(['st_tests']) });
  assert.notEqual(overlaid, source, 'the overlay produces a new snapshot object');
  assert.equal(overlaid.runs[0], source.runs[0], 'run objects are shared, so run-level entries stay valid');
  assert.equal(overlaid.runs[1], source.runs[1], 'run objects are shared, so run-level entries stay valid');
  renderOverview(overlaid);
  const after = derivedCacheCounts();
  assert.equal(after.navTasks, before.navTasks + 1, 'the visible navigation list changed');
  assert.equal(after.runStats, before.runStats, 'unchanged run objects reuse their stats');
  assert.deepEqual(navTasks(overlaid).map(task => task.id), navTasks(source).map(task => task.id).filter(id => id !== 'st_tests'));
});

test('memoized navigation arrays are read-only for every caller', () => {
  const tasks = navTasks(frameSnapshot());
  assert.ok(Object.isFrozen(tasks), 'a shared list must not be mutable');
  assert.throws(() => tasks.push({ id: 'st_injected' }), TypeError);
});

test('cold and warm snapshot caches paint byte-identical golden frames', () => {
  const { palette, theme } = themeFor(0);
  for (const surface of FRAME_SURFACES) {
    for (const width of FRAME_WIDTHS) {
      const height = FRAME_HEIGHTS[width];
      for (const language of FRAME_LANGUAGES) {
        const snapshot = frameSnapshot();
        const options = {
          width, height, time: FIXED_TIME, now: FIXED_NOW, palette, theme,
        };
        const cold = renderApp(snapshot, frameUi(surface, language), options);
        const warm = renderApp(snapshot, frameUi(surface, language), options);
        const meta = { surface, language, width, height };
        assert.deepEqual(serializeFrame(warm, meta), serializeFrame(cold, meta),
          `${surface} ${width}x${height} ${language}: cached frame differs from its cold frame`);
        const fixture = JSON.parse(readFileSync(frameFixturePath(surface, language, width, height), 'utf8'));
        assert.equal(compareFrame(fixture, cold), null,
          `${surface} ${width}x${height} ${language}: cold frame differs from the golden fixture`);
        assert.equal(compareFrame(fixture, warm), null,
          `${surface} ${width}x${height} ${language}: warm frame differs from the golden fixture`);
      }
    }
  }
});
