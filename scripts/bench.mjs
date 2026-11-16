import { createFrameBuffers } from '../src/frame-primitives.mjs';
import { computeLayout, graphLayoutMatches, resetWireRaster, wireRasterStats } from '../src/graph.mjs';
import { dashboardLayout, renderApp, subjectResolutionStats } from '../src/render.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskData } from '../src/task-data.mjs';
import { textCacheStats } from '../src/text.mjs';
import { createTheme, paletteAt, themeCacheStats } from '../src/theme.mjs';
import { benchFixtures, FIXED_NOW, FRAME } from './bench-fixtures.mjs';

// Published budgets: a regression past any of these is a release blocker, not
// a benchmarking curiosity. Rows without a published budget are report-only.
// The 300/500 warm limits are the viewport-paint gate: a warm frame must cost
// the visible rows, not the full layout height. They are additive to the
// original demo/100 budgets and never relax them.
const BUDGETS = Object.freeze({
  demoWarmMs: 8, layout100Ms: 200, warm100Ms: 8, warm300Ms: 8, warm500Ms: 3,
});
const LAYOUT_WARMUP = 1;
const LAYOUT_SAMPLES = 5;
const WARM_WARMUP = 3;
const WARM_SAMPLES = 7;
// Frame-lifetime memory gate. Ten thousand frames is roughly three minutes of
// the shipped 60 fps demo. Every frame gets a fresh snapshot identity, which is
// the adversarial case for per-snapshot caches: a cache that retains snapshots
// strongly must fail this gate. The normal tree's WeakMap caches are collected
// back to roughly the starting heap (+0.2MB), so 4MB leaves headroom for GC/JIT
// noise while a snapshot-keyed leak of a few MB is caught.
const MEMORY_FRAMES = 10_000;
const MEMORY_WARMUP = 500;
const MEMORY_GC_INTERVAL = 1_000;
const MEMORY_GROWTH_LIMIT_MB = 4;

const palette = paletteAt(0);
const theme = createTheme({ palette, color: false });
const graphRect = dashboardLayout(FRAME.width, FRAME.height, { sidebar: true }).graph;
if (!graphRect) throw new Error('bench frame has no graph pane');
// graphPanel measures the graph canvas as rect.w - 2 and then insets twice.
const CONTENT_WIDTH = Math.max(8, graphRect.w - 4);

// The UI fixture is frozen: no folded nodes and no clock-derived scroll.
// Motion is requested only by the animated row; every run starts from the same
// state so only renderer work varies.
function uiFor(run, motion = false) {
  return {
    runIndex: 0,
    focus: 'graph',
    lastFocus: 'graph',
    selectedNodeId: run.nodes[0]?.id,
    selectedTaskId: undefined,
    follow: false,
    motion,
    help: false,
    verbose: false,
    folded: new Set(),
    graphScroll: 0,
    graphScrollTarget: 0,
    manualScroll: false,
    sidebar: true,
    language: 'en',
    fps: 12,
    toasts: [],
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const round = value => Math.round(value * 100) / 100;

function timed(fn) {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function samplesOf(fn, count) {
  return Array.from({ length: count }, () => timed(fn));
}

// Pixel witness for the animated row: the whole cell grid (glyph, fg, bg,
// flags, wide-glyph halves), not the ANSI text, because the color-disabled
// bench theme strips color escapes. A cold build and a cached flow reuse
// must hash identically at the same instant.
function cellSignature(frame) {
  let hash = 0x811c9dc5;
  for (const row of frame.canvas.cells) {
    for (const cell of row) {
      const token = cell.ch + '\u0000' + cell.fg + '\u0000' + cell.bg +
        '\u0000' + cell.flags + '\u0000' + cell.cont + '\u0000' + cell.width;
      for (let index = 0; index < token.length; index++) {
        hash ^= token.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function collectGarbage() {
  if (typeof Bun !== 'undefined' && typeof Bun.gc === 'function') Bun.gc(true);
}

function memorySnapshot() {
  collectGarbage();
  const usage = process.memoryUsage();
  return {
    heapUsedMb: round(usage.heapUsed / (1024 * 1024)),
    rssMb: round(usage.rss / (1024 * 1024)),
  };
}

function budgetsFor(name, layoutMs, warmMs) {
  if (name === 'demo') {
    return [{
      metric: 'warmMs',
      limitMs: BUDGETS.demoWarmMs,
      valueMs: warmMs,
      pass: Number.isFinite(warmMs) && warmMs <= BUDGETS.demoWarmMs,
    }];
  }
  if (name === '100/185') {
    return [
      {
        metric: 'layoutMs',
        limitMs: BUDGETS.layout100Ms,
        valueMs: layoutMs,
        pass: Number.isFinite(layoutMs) && layoutMs <= BUDGETS.layout100Ms,
      },
      {
        metric: 'warmMs',
        limitMs: BUDGETS.warm100Ms,
        valueMs: warmMs,
        pass: Number.isFinite(warmMs) && warmMs <= BUDGETS.warm100Ms,
      },
    ];
  }
  const wideWarmLimit = {
    '300/560': BUDGETS.warm300Ms,
    '500/990': BUDGETS.warm500Ms,
  }[name];
  if (wideWarmLimit !== undefined) {
    return [{
      metric: 'warmMs',
      limitMs: wideWarmLimit,
      valueMs: warmMs,
      pass: Number.isFinite(warmMs) && warmMs <= wideWarmLimit,
    }];
  }
  return [];
}

function runFixture({ name, snapshot, motion = false, time = 0 }) {
  const run = snapshot.runs[0];
  const now = Date.parse(snapshot.provenance?.capturedAt ?? snapshot.generatedAt) || FIXED_NOW;
  const ui = uiFor(run, motion);
  // The viewer owns one frame-buffer handle for its lifetime. Reuse the same
  // handle here or the benchmark measures per-frame allocation the product
  // does not do.
  const buffers = createFrameBuffers();
  for (let index = 0; index < LAYOUT_WARMUP; index++) computeLayout(run, CONTENT_WIDTH);
  let layout;
  const layoutSamples = samplesOf(() => {
    layout = computeLayout(run, CONTENT_WIDTH);
  }, LAYOUT_SAMPLES);
  // Layout samples leave a large amount of short-lived garbage behind. Clear
  // it before warm frames so the median measures rendering, not the collector.
  collectGarbage();
  const render = () => renderApp(snapshot, ui, {
    width: FRAME.width,
    height: FRAME.height,
    time,
    now,
    palette,
    theme,
    graphLayout: layout,
    buffers,
  });
  // Measure the first frame with a cold wire raster separately, then the
  // warm median. The animated row reports both so a cache miss (or a
  // regression back to per-frame flow allocation) is visible in the row.
  resetWireRaster();
  const flowBefore = wireRasterStats().flow;
  const coldStart = performance.now();
  const coldFrame = render();
  const firstFrameMs = performance.now() - coldStart;
  for (let index = 0; index < WARM_WARMUP; index++) render();
  const warmSamples = samplesOf(render, WARM_SAMPLES);
  const warmFrame = render();
  const layoutMs = median(layoutSamples);
  const warmMs = median(warmSamples);
  const budgets = budgetsFor(name, layoutMs, warmMs);
  const finite = Number.isFinite(layoutMs) && Number.isFinite(warmMs);
  const budgetPass = budgets.length ? budgets.every(budget => budget.pass) : null;
  const status = !finite ? 'FAIL' : budgets.length ? (budgetPass ? 'PASS' : 'FAIL') : 'REPORT';
  const flowAfter = wireRasterStats().flow;
  const coldSignature = cellSignature(coldFrame);
  const warmSignature = cellSignature(warmFrame);
  const motionRow = motion
    ? {
      time,
      firstFrameMs: round(firstFrameMs),
      warmMs: round(warmMs),
      // Cold and warm must paint the same pixels; only the work changes.
      pixelsEqual: warmSignature === coldSignature,
      pixelHash: coldSignature,
      flow: {
        allocatedCells: flowAfter.allocatedCells - flowBefore.allocatedCells,
        skippedCells: flowAfter.skippedCells - flowBefore.skippedCells,
        evaluatedCells: flowAfter.evaluatedCells - flowBefore.evaluatedCells,
        zeroCells: flowAfter.zeroCells - flowBefore.zeroCells,
        cachedCells: flowAfter.cachedCells,
      },
    }
    : undefined;
  return {
    fixture: name,
    nodes: run.nodes.length,
    edges: run.edges.length,
    layout: { medianMs: layoutMs, samplesMs: layoutSamples },
    // Reuse is decided by the same geometry key the renderer uses, so a
    // capped layout is reusable and the warm median is its true frame cost.
    warm: {
      medianMs: warmMs,
      samplesMs: warmSamples,
      layoutReusable: graphLayoutMatches(layout, run, CONTENT_WIDTH, ui.folded),
    },
    ...(motionRow ? { motion: motionRow } : {}),
    memory: memorySnapshot(),
    finite,
    budgets,
    pass: budgetPass,
    status,
  };
}

function formatRow(row) {
  const budgets = row.budgets.length
    ? row.budgets.map(budget => `${budget.metric}<=${budget.limitMs}`).join(' ')
    : 'report-only';
  const parts = [
    row.fixture.padEnd(10),
    `nodes=${String(row.nodes).padStart(3)}`,
    `edges=${String(row.edges).padStart(3)}`,
    `layout=${row.layout.medianMs.toFixed(2)}ms`,
    `warm=${row.warm.medianMs.toFixed(2)}ms`,
  ];
  if (row.motion) {
    parts.push(`motion-cold=${row.motion.firstFrameMs.toFixed(2)}ms`);
    parts.push(`motion-warm=${row.motion.warmMs.toFixed(2)}ms`);
    parts.push(`pixels=${row.motion.pixelsEqual ? 'same' : 'CHANGED'}`);
    parts.push(`flow-alloc=${row.motion.flow.allocatedCells}`);
    parts.push(`flow-cached=${row.motion.flow.cachedCells}`);
    parts.push(`flow-skip=${row.motion.flow.skippedCells}`);
  }
  parts.push(`heap=${row.memory.heapUsedMb.toFixed(1)}MB`);
  parts.push(`rss=${row.memory.rssMb.toFixed(1)}MB`);
  parts.push(budgets, row.status);
  return parts.join('  ');
}

// The frame-path memory probe. It renders the committed demo fixture with a
// fresh snapshot identity for every frame, forcing the snapshot-keyed caches
// to churn while the shared text/theme/wire/rate caches stay capped. The
// returned snapshotRotations counter is the machine witness for that rotation;
// heap is sampled after a forced collection every 1,000 frames, so retained
// growth is distinguishable from short-lived garbage.
function memoryProbe({ snapshot }) {
  const run = snapshot.runs[0];
  const now = Date.parse(snapshot.provenance?.capturedAt ?? snapshot.generatedAt) || FIXED_NOW;
  const ui = {
    ...uiFor(run),
    focus: 'details',
    lastFocus: 'graph',
    selectedNodeId: run.nodes[0]?.id,
  };
  const buffers = createFrameBuffers();
  const layout = computeLayout(run, CONTENT_WIDTH);
  const options = {
    width: FRAME.width,
    height: FRAME.height,
    time: 0,
    now,
    palette,
    theme,
    graphLayout: layout,
    buffers,
  };
  for (let index = 0; index < MEMORY_WARMUP; index++) renderApp(snapshot, ui, options);
  // A real store-cache instance: the same TaskData the controller uses, with
  // the demo tasks restored into its session cache. Its memoryStats() proves
  // the shipped caps, not a copy of the constants.
  const taskData = new TaskData({
    sessionId: 'bench-memory-probe',
    stateDirs: [{ root: join(tmpdir(), 'dag-studio-bench-memory'), origin: 'explicit', label: 'bench probe' }],
    notify: () => {},
  });
  taskData.restore(snapshot.tasks ?? []);
  collectGarbage();
  const before = process.memoryUsage().heapUsed;
  const samplesMb = [];
  let snapshotRotations = 0;
  for (let index = 0; index < MEMORY_FRAMES; index++) {
    // A fresh identity every frame: a 10kHz accepted-read stream is harsher
    // than the product's 10Hz, and it makes any strong snapshot-keyed cache
    // grow instead of hoping the collector catches the sparse case.
    const view = { ...snapshot };
    snapshotRotations += 1;
    renderApp(view, ui, options);
    if ((index + 1) % MEMORY_GC_INTERVAL === 0) {
      collectGarbage();
      samplesMb.push(round(process.memoryUsage().heapUsed / (1024 * 1024)));
    }
  }
  collectGarbage();
  const after = process.memoryUsage().heapUsed;
  const growthMb = round((after - before) / (1024 * 1024));
  const text = textCacheStats();
  const themeCache = themeCacheStats();
  const subject = subjectResolutionStats();
  const wire = wireRasterStats();
  const taskDataStats = taskData.memoryStats();
  const taskDataCapsOk = ['cache', 'live', 'rateHistory', 'rateSeen', 'rateSources', 'warnings']
    .every(name => taskDataStats[name].size <= taskDataStats[name].limit);
  const capsOk = Object.entries(text.sizes).every(([kind, size]) => size <= text.limits[kind]) &&
    themeCache.size <= themeCache.limit &&
    subject.maxEntries <= subject.limit &&
    wire.retained <= wire.capacity &&
    taskDataCapsOk;
  const heapOk = growthMb <= MEMORY_GROWTH_LIMIT_MB;
  return {
    frames: MEMORY_FRAMES,
    snapshotRotations,
    heapBeforeMb: round(before / (1024 * 1024)),
    heapAfterMb: round(after / (1024 * 1024)),
    growthMb,
    limitMb: MEMORY_GROWTH_LIMIT_MB,
    samplesMb,
    caches: { text, theme: themeCache, subject, wire, taskData: taskDataStats },
    capsOk,
    pass: heapOk && capsOk,
  };
}

function formatProbe(probe) {
  const growth = probe.growthMb >= 0 ? `+${probe.growthMb}` : String(probe.growthMb);
  return [
    'memory'.padEnd(8),
    `frames=${probe.frames}`,
    `heap=${probe.heapBeforeMb.toFixed(1)}->${probe.heapAfterMb.toFixed(1)}MB (${growth}MB <= ${probe.limitMb}MB)`,
    `wire=${probe.caches.wire.retained}/${probe.caches.wire.capacity}`,
    `subject=${probe.caches.subject.maxEntries}/${probe.caches.subject.limit}`,
    `text=${Object.entries(probe.caches.text.sizes).map(([kind, size]) => `${kind}:${size}/${probe.caches.text.limits[kind]}`).join(',')}`,
    `theme=${probe.caches.theme.size}/${probe.caches.theme.limit}`,
    probe.pass ? 'PASS' : 'FAIL',
  ].join('  ');
}

function failuresFor(row) {
  const failures = [];
  if (row.motion && !row.motion.pixelsEqual) {
    failures.push(`${row.fixture} motion pixels differ between cold and cached frames`);
  }
  // A reused raster must not walk a wire again: the only allocation in a
  // motion row is the one build that fills the cache.
  if (row.motion && row.motion.flow.allocatedCells !== row.motion.flow.cachedCells) {
    failures.push(`${row.fixture} allocated ${row.motion.flow.allocatedCells} flow cells for ${row.motion.flow.cachedCells} cached cells`);
  }
  if (!Number.isFinite(row.layout.medianMs)) {
    failures.push(`${row.fixture} layoutMs ${String(row.layout.medianMs)} is not finite`);
  }
  if (!Number.isFinite(row.warm.medianMs)) {
    failures.push(`${row.fixture} warmMs ${String(row.warm.medianMs)} is not finite`);
  }
  // Budget comparisons already use the raw median. Only add budget failures
  // for finite values so a NaN row reports its validity failure, not a
  // misleading comparison.
  if (row.finite) {
    for (const budget of row.budgets.filter(entry => !entry.pass)) {
      failures.push(`${row.fixture} ${budget.metric} ${String(budget.valueMs)}ms > ${budget.limitMs}ms`);
    }
  }
  return failures;
}

try {
  const fixtures = benchFixtures();
  const rows = fixtures.map(runFixture);
  const probe = memoryProbe({ snapshot: fixtures[0].snapshot });
  const failures = rows.flatMap(failuresFor);
  if (!probe.pass) {
    if (probe.growthMb > probe.limitMb) {
      failures.push(`memory probe heap grew ${probe.growthMb}MB > ${probe.limitMb}MB over ${probe.frames} frames`);
    }
    for (const [kind, size] of Object.entries(probe.caches.text.sizes)) {
      if (size > probe.caches.text.limits[kind]) {
        failures.push(`memory probe text.${kind} cache ${size} > ${probe.caches.text.limits[kind]}`);
      }
    }
    if (probe.caches.theme.size > probe.caches.theme.limit) {
      failures.push(`memory probe theme cache ${probe.caches.theme.size} > ${probe.caches.theme.limit}`);
    }
    if (probe.caches.subject.maxEntries > probe.caches.subject.limit) {
      failures.push(`memory probe subject cache ${probe.caches.subject.maxEntries} > ${probe.caches.subject.limit}`);
    }
    if (probe.caches.wire.retained > probe.caches.wire.capacity) {
      failures.push(`memory probe wire raster ${probe.caches.wire.retained} > ${probe.caches.wire.capacity}`);
    }
  }
  const result = { budgets: BUDGETS, rows, memoryProbe: probe, pass: failures.length === 0 };
  console.log('fixture   nodes  edges  layout      warm        memory               budgets');
  for (const row of rows) console.log(formatRow(row));
  console.log(formatProbe(probe));
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) {
    for (const failure of failures) console.error(`BENCH FAIL: ${failure}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`bench: ${error.stack ?? error.message}`);
  process.exitCode = 1;
}
