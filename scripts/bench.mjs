import { createFrameBuffers } from '../src/frame-primitives.mjs';
import { computeLayout, wireRasterStats } from '../src/graph.mjs';
import { dashboardLayout, renderApp, subjectResolutionStats } from '../src/render.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskData } from '../src/task-data.mjs';
import { textCacheStats } from '../src/text.mjs';
import { createTheme, paletteAt, themeCacheStats } from '../src/theme.mjs';
import { benchFixtures, FIXED_NOW, FRAME } from './bench-fixtures.mjs';

// Published budgets: a regression past any of these is a release blocker, not
// a benchmarking curiosity. Rows without a published budget are report-only.
const BUDGETS = Object.freeze({ demoWarmMs: 8, layout100Ms: 200, warm100Ms: 8 });
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

// The UI fixture is frozen: no folded nodes, no motion, no clock-derived
// scroll. Every run starts from the same state so only renderer work varies.
function uiFor(run) {
  return {
    runIndex: 0,
    focus: 'graph',
    lastFocus: 'graph',
    selectedNodeId: run.nodes[0]?.id,
    selectedTaskId: undefined,
    follow: false,
    motion: false,
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
  return [];
}

function runFixture({ name, snapshot }) {
  const run = snapshot.runs[0];
  const now = Date.parse(snapshot.provenance?.capturedAt ?? snapshot.generatedAt) || FIXED_NOW;
  const ui = uiFor(run);
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
    time: 0,
    now,
    palette,
    theme,
    graphLayout: layout,
    buffers,
  });
  for (let index = 0; index < WARM_WARMUP; index++) render();
  const warmSamples = samplesOf(render, WARM_SAMPLES);
  const layoutMs = median(layoutSamples);
  const warmMs = median(warmSamples);
  const budgets = budgetsFor(name, layoutMs, warmMs);
  const finite = Number.isFinite(layoutMs) && Number.isFinite(warmMs);
  const budgetPass = budgets.length ? budgets.every(budget => budget.pass) : null;
  const status = !finite ? 'FAIL' : budgets.length ? (budgetPass ? 'PASS' : 'FAIL') : 'REPORT';
  return {
    fixture: name,
    nodes: run.nodes.length,
    edges: run.edges.length,
    layout: { medianMs: layoutMs, samplesMs: layoutSamples },
    // A capped layout cannot be reused, so renderApp recomputes it inside the
    // frame. Record that honestly instead of calling a 600ms frame "warm".
    warm: {
      medianMs: warmMs,
      samplesMs: warmSamples,
      layoutReusable: layout.boxes.size === run.nodes.length,
    },
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
  return [
    row.fixture.padEnd(8),
    `nodes=${String(row.nodes).padStart(3)}`,
    `edges=${String(row.edges).padStart(3)}`,
    `layout=${row.layout.medianMs.toFixed(2)}ms`,
    `warm=${row.warm.medianMs.toFixed(2)}ms`,
    `heap=${row.memory.heapUsedMb.toFixed(1)}MB`,
    `rss=${row.memory.rssMb.toFixed(1)}MB`,
    budgets,
    row.status,
  ].join('  ');
}

// The frame-path memory probe. It renders the committed demo fixture with a
// fresh snapshot identity every eighth frame (a 10Hz accepted read), forcing
// the snapshot-keyed caches to churn while the shared text/theme/wire/rate
// caches stay capped. Heap is sampled after a forced collection every 1,000
// frames, so retained growth is distinguishable from short-lived garbage.
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
  for (let index = 0; index < MEMORY_FRAMES; index++) {
    // A fresh identity every frame: a 10kHz accepted-read stream is harsher
    // than the product's 10Hz, and it makes any strong snapshot-keyed cache
    // grow instead of hoping the collector catches the sparse case.
    const view = { ...snapshot };
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
    snapshotRotations: MEMORY_FRAMES,
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
