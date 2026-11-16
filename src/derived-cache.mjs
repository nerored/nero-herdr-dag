// Per-frame derived-data memoization.
//
// A snapshot is read-only by contract: the viewer replaces it with a new
// object on every accepted read, demo tick, or hidden-subject overlay. That
// makes object identity the honest cache key. A cached entry therefore lives
// exactly as long as the snapshot (or run/task) it was derived from, and a
// replaced object is collected instead of needing an invalidation call.
//
// What is memoized here is pure derivation, never frame state:
// - navTasks: the single sorted navigation list
// - linked task ids per snapshot and per run
// - runStats per run
// - progressCounts per (snapshot, task, run)
// - runSummary per (run, clock)
//
// runSummary is clock-sensitive (a running node's window ends at the supplied
// instant), so its cache is keyed by the clock as well and keeps a small ring
// of recent clocks. A live viewer therefore recomputes once per frame while
// the two call sites in that frame share the same result; a fixed-clock bench
// reuses one entry across frames.
//
// Arrays and stats handed back are frozen: every caller holds the same object,
// so a mutation would leak into the next frame. Sets stay internal to the
// lookup and are read-only by convention, matching the old return values.
//
// Bound: every entry is either a WeakMap key (collected with the snapshot/run/
// task it describes) or, for progressCounts, an inner Map keyed by object
// identities that belong to that snapshot (tasks <= SNAPSHOT_LIMITS.tasks,
// runs <= SNAPSHOT_LIMITS.runs). No frame path looks up a freshly synthesized
// key object, so the inner maps are bounded by snapshot cardinality and die
// with the WeakMap key. runSummary keeps its own four-clock ring.

const EMPTY_LIST = Object.freeze([]);
const EMPTY_SET = new Set();
const RUN_SUMMARY_CLOCKS = 4;

const navTaskCache = new WeakMap();
const linkedIdsCache = new WeakMap();
const runLinkedIdsCache = new WeakMap();
const runStatsCache = new WeakMap();
const progressCountsCache = new WeakMap();
const runSummaryCache = new WeakMap();

const counters = {
  navTasks: 0,
  linkedTaskIds: 0,
  runLinkedTaskIds: 0,
  runStats: 0,
  progressCounts: 0,
  runSummary: 0,
};

// Instrumentation for the frame-counter tests: how many times this module ran
// the computing function rather than returning a memoized value.
export function derivedCacheCounts() {
  return { ...counters };
}

export function resetDerivedCacheCounts() {
  for (const key of Object.keys(counters)) counters[key] = 0;
}

const cacheable = value => Boolean(value) && typeof value === 'object';

export function memoNavTasks(snapshot, compute) {
  if (!cacheable(snapshot)) return EMPTY_LIST;
  const cached = navTaskCache.get(snapshot);
  if (cached) return cached;
  counters.navTasks++;
  const value = Object.freeze(compute(snapshot));
  navTaskCache.set(snapshot, value);
  return value;
}

export function memoLinkedTaskIds(snapshot, compute) {
  if (!cacheable(snapshot)) return EMPTY_SET;
  const cached = linkedIdsCache.get(snapshot);
  if (cached) return cached;
  counters.linkedTaskIds++;
  const value = compute(snapshot);
  linkedIdsCache.set(snapshot, value);
  return value;
}

export function memoLinkedRunTaskIds(run, compute) {
  if (!cacheable(run)) return EMPTY_SET;
  const cached = runLinkedIdsCache.get(run);
  if (cached) return cached;
  counters.runLinkedTaskIds++;
  const value = compute(run);
  runLinkedIdsCache.set(run, value);
  return value;
}

export function memoRunStats(run, compute) {
  if (!cacheable(run)) return compute(run);
  const cached = runStatsCache.get(run);
  if (cached) return cached;
  counters.runStats++;
  const stats = compute(run);
  const value = Object.freeze({ ...stats, counts: Object.freeze({ ...stats.counts }) });
  runStatsCache.set(run, value);
  return value;
}

export function memoProgressCounts(snapshot, task, run, compute) {
  // A caller without a snapshot (or a standalone run) gets the honest answer
  // without a cache entry; there is no identity to key it on.
  if (!cacheable(snapshot)) return compute();
  let byTask = progressCountsCache.get(snapshot);
  if (!byTask) {
    byTask = new Map();
    progressCountsCache.set(snapshot, byTask);
  }
  const taskKey = cacheable(task) ? task : null;
  let byRun = byTask.get(taskKey);
  if (!byRun) {
    byRun = new Map();
    byTask.set(taskKey, byRun);
  }
  const runKey = cacheable(run) ? run : null;
  if (byRun.has(runKey)) return byRun.get(runKey);
  counters.progressCounts++;
  const counts = compute();
  const value = counts === undefined ? undefined : Object.freeze(counts);
  byRun.set(runKey, value);
  return value;
}

export function memoRunSummary(run, clock, compute) {
  if (!cacheable(run)) return compute();
  let entries = runSummaryCache.get(run);
  if (!entries) {
    entries = [];
    runSummaryCache.set(run, entries);
  }
  for (const entry of entries) {
    if (Object.is(entry.clock, clock)) return entry.summary;
  }
  counters.runSummary++;
  const summary = compute();
  entries.push({ clock, summary });
  if (entries.length > RUN_SUMMARY_CLOCKS) entries.shift();
  return summary;
}
