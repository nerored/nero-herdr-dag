import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoundedCache, BoundedKeySet, SingleEntryCache } from '../src/bounded-cache.mjs';
import { wireRasterStats } from '../src/graph.mjs';
import { normalizeSnapshot } from '../src/model.mjs';
import { selectionResolution, SUBJECT_RESOLUTION_LIMIT, subjectResolutionStats } from '../src/render.mjs';
import { TASK_DATA_LIMITS, TaskData, legacyProbeStats, resolveTaskStateDirs } from '../src/task-data.mjs';
import { SNAPSHOT_LIMITS } from '../src/viewer-snapshot.mjs';
import { charWidth, clean, segments, textCacheStats, width } from '../src/text.mjs';
import { HEX_CACHE_LIMIT, parseHex, themeCacheStats } from '../src/theme.mjs';
import { createViewer } from '../src/viewer.mjs';

// Every cache on the frame/session path has a documented cap and one eviction
// test here. The 2x-limit stress proves the cap is the configured limit, not a
// luck-of-the-input number, and the product tests prove the wiring uses it.
test('BoundedCache evicts the least recently used entry at its cap', () => {
  const cache = new BoundedCache(3, { name: 'unit' });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), 1, 'a hit returns the stored value');

  cache.set('d', 4);
  assert.equal(cache.size, 3, 'the cap is exact');
  assert.equal(cache.has('b'), false, 'the least recently used key is evicted');
  assert.deepEqual([...cache.keys()], ['c', 'a', 'd'], 'insertion order reflects recency');
  assert.equal(cache.stats().evictions, 1);
  assert.equal(cache.stats().limit, 3);
});

test('a cache configured at twice its product limit never exceeds that configured cap', () => {
  for (const base of [SUBJECT_RESOLUTION_LIMIT, TASK_DATA_LIMITS.rateTaskIds, HEX_CACHE_LIMIT]) {
    const limit = base * 2;
    const cache = new BoundedCache(limit, { name: `stress-${limit}` });
    for (let index = 0; index < limit * 2; index++) cache.set(`key-${index}`, index);
    assert.equal(cache.size, limit, `${limit}: a 2x limit still caps the cache`);
    assert.equal(cache.stats().evictions, limit, `${limit}: every insert past the cap evicts one entry`);
    assert.equal(cache.has('key-0'), false, `${limit}: the oldest key is gone`);
    assert.equal(cache.get(`key-${limit}`), limit, `${limit}: retained keys keep their values`);
  }
});

test('BoundedKeySet evicts the oldest key at its cap', () => {
  const set = new BoundedKeySet(2, { name: 'unit-set' });
  set.add('a');
  set.add('b');
  set.add('c');
  assert.equal(set.size, 2);
  assert.equal(set.has('a'), false, 'the oldest key is evicted');
  assert.equal(set.has('b'), true);
  assert.equal(set.has('c'), true);
  assert.equal(set.stats().evictions, 1);
});

test('subject resolution keeps at most its cap per snapshot and recomputes an evicted key', () => {
  const snapshot = {
    version: 3,
    mode: 'demo',
    provenance: { origin: 'demo-engine' },
    runs: [{ id: 'run_mem', status: 'running', nodes: [{ id: 'node_mem', state: 'running' }], edges: [] }],
    tasks: [],
    sources: [],
  };
  const run = snapshot.runs[0];
  const args = { snapshot, run, node: run.nodes[0], subject: 'node' };
  const before = subjectResolutionStats();
  for (let index = 0; index < SUBJECT_RESOLUTION_LIMIT + 2; index++) {
    selectionResolution(snapshot, args, `subject-${index}`);
  }
  const filled = subjectResolutionStats();
  assert.ok(filled.maxEntries <= SUBJECT_RESOLUTION_LIMIT,
    `subject cache observed ${filled.maxEntries} entries, limit ${SUBJECT_RESOLUTION_LIMIT}`);
  assert.equal(filled.misses - before.misses, SUBJECT_RESOLUTION_LIMIT + 2,
    'each distinct subject is resolved once');
  assert.equal(filled.evictions - before.evictions, 2, 'two inserts past the cap evicted two entries');

  // The first subject was evicted; selecting it again must resolve, not serve
  // a stale entry from a cleared table.
  const again = selectionResolution(snapshot, args, 'subject-0');
  assert.ok(again && typeof again === 'object');
  const after = subjectResolutionStats();
  assert.equal(after.misses - filled.misses, 1, 'the evicted subject recomputes');
  assert.equal(after.hits - filled.hits, 0, 'no hit is claimed for an evicted key');
  assert.ok(after.maxEntries <= SUBJECT_RESOLUTION_LIMIT);
});

test('task-store caps match the snapshot limits they backstop', () => {
  assert.equal(TASK_DATA_LIMITS.cacheEntries, SNAPSHOT_LIMITS.tasks,
    'a restored cache must not evict a task the accepted snapshot can contain');
  assert.equal(TASK_DATA_LIMITS.liveEntries, SNAPSHOT_LIMITS.tasks,
    'a live overlay must not evict a task the accepted snapshot can contain');
  assert.equal(TASK_DATA_LIMITS.rateTaskIds, SNAPSHOT_LIMITS.tasks,
    'rate state covers every task id a snapshot can carry');
  assert.equal(TASK_DATA_LIMITS.rateSamples, SNAPSHOT_LIMITS.rateSamples,
    'one rate-series length is shared by the snapshot bound and the store');
});

test('task-store rate maps and restored cache stop at their documented caps', () => {
  const data = new TaskData({
    sessionId: 'session-memory',
    stateDirs: [{ root: '/tmp/dag-memory-bounds', origin: 'in-project', label: 'test store' }],
    notify: () => {},
  });
  const cap = TASK_DATA_LIMITS.rateTaskIds;
  for (let index = 0; index <= cap; index++) {
    const id = `st_rate_${index}`;
    data.rateHistory.set(id, []);
    data.rateSeen.set(id, { at: undefined, rate: 1, wall: index });
    data.rateSources.set(id, 'live');
  }
  for (const map of [data.rateHistory, data.rateSeen, data.rateSources]) {
    assert.equal(map.size, cap, 'a rate map never exceeds its cap');
    assert.equal(map.has('st_rate_0'), false, 'the oldest rate id is evicted');
    assert.equal(map.has(`st_rate_${cap}`), true, 'the newest rate id is retained');
    assert.equal(map.limit, cap, 'the documented limit is the configured limit');
  }

  const restored = Array.from({ length: TASK_DATA_LIMITS.cacheEntries + 5 }, (_, index) => ({
    id: `st_cache_${index}`,
    description: `restored ${index}`,
    status: 'completed',
  }));
  data.restore(restored);
  assert.equal(data.cache.size, TASK_DATA_LIMITS.cacheEntries);
  assert.equal(data.cache.has('st_cache_0'), false, 'the oldest restored task is evicted');
  assert.equal(data.cache.has(`st_cache_${TASK_DATA_LIMITS.cacheEntries + 4}`), true);

  for (let index = 0; index <= TASK_DATA_LIMITS.liveEntries; index++) {
    data.live.set(`st_live_${index}`, { task: { id: `st_live_${index}` }, source: 'live' });
  }
  assert.equal(data.live.size, TASK_DATA_LIMITS.liveEntries, 'the live overlay cache never exceeds its cap');
  assert.equal(data.live.has('st_live_0'), false, 'the oldest live overlay is evicted');
  assert.equal(data.live.has(`st_live_${TASK_DATA_LIMITS.liveEntries}`), true);

  const stats = data.memoryStats();
  for (const name of ['cache', 'live', 'rateHistory', 'rateSeen', 'rateSources', 'warnings']) {
    assert.ok(stats[name].size <= stats[name].limit, `${name} reports size <= limit`);
  }
});

test('the legacy root probe cache stops at its documented cap', () => {
  const env = { OMO_CODING_AGENT_DIR: '/tmp/dag-memory-bounds-agent' };
  const before = legacyProbeStats();
  for (let index = 0; index < TASK_DATA_LIMITS.legacyProbes + 10; index++) {
    resolveTaskStateDirs({ cwd: '/tmp/dag-memory-bounds-cwd', sessionId: `session-${index}`, env });
  }
  const stats = legacyProbeStats();
  assert.equal(stats.limit, TASK_DATA_LIMITS.legacyProbes);
  assert.equal(stats.size, TASK_DATA_LIMITS.legacyProbes, 'the probe cache is full but never over its cap');
  assert.ok(stats.evictions >= before.evictions + 10, 'each probe past the cap evicted one entry');
});

test('warning coalescing keeps its cap and can re-notify an evicted key', () => {
  const messages = [];
  const data = new TaskData({
    sessionId: 'session-memory',
    stateDirs: [{ root: '/tmp/dag-memory-bounds', origin: 'in-project', label: 'test store' }],
    notify: message => messages.push(message),
  });
  const cap = TASK_DATA_LIMITS.warnings;
  for (let index = 0; index < cap + 10; index++) data.warnOnce(`warning-${index}`, `message-${index}`);
  assert.equal(data.warnings.size, cap, 'the dedupe set never exceeds its cap');
  assert.equal(messages.length, cap + 10, 'every first-seen key notifies once');

  // The first key was evicted, so the same failure notifies once more instead
  // of being silently suppressed for the rest of the session.
  data.warnOnce('warning-0', 'message-0 again');
  assert.equal(messages.length, cap + 11);
  assert.equal(data.warnings.size, cap);
  assert.equal(data.warnings.has('warning-0'), true);
  assert.equal(data.warnings.has(`warning-${cap + 9}`), true);
});

test('text caches drop entries at their documented caps', () => {
  const textLimit = textCacheStats().limits.clean;
  for (let index = 0; index < textLimit + 100; index++) {
    width(`memory-bounds-${index}`);
  }
  // charWidth has its own smaller cap; unique graphemes exercise it directly.
  for (let index = 0; index < textCacheStats().limits.charWidth + 100; index++) {
    charWidth(String.fromCodePoint(0x4e00 + index));
  }
  const stats = textCacheStats();
  for (const [kind, size] of Object.entries(stats.sizes)) {
    assert.ok(size <= stats.limits[kind], `${kind} cache ${size} exceeds ${stats.limits[kind]}`);
  }
  assert.equal(stats.sizes.clean, textLimit, 'the clean cache reached its cap and stopped growing');
  assert.equal(stats.sizes.charWidth, stats.limits.charWidth, 'the char-width cache reached its cap');
  assert.ok(clean('memory-bounds-0').startsWith('memory-bounds-'));
  assert.ok(segments('memory-bounds-0').length > 0);
});

test('the hex color cache drops entries at its documented cap', () => {
  for (let index = 0; index < HEX_CACHE_LIMIT + 100; index++) {
    parseHex(`#${index.toString(16).padStart(6, '0')}`);
  }
  const stats = themeCacheStats();
  assert.equal(stats.size, HEX_CACHE_LIMIT, 'the hex cache reached its cap and stopped growing');
  assert.equal(stats.limit, HEX_CACHE_LIMIT);
});

test('the wire raster reports its one-entry cap and never retains more', () => {
  const stats = wireRasterStats();
  assert.equal(stats.capacity, 1, 'task 33 single-entry semantics are explicit');
  assert.ok(stats.retained <= stats.capacity, 'the retained raster count never exceeds one');
});

test('SingleEntryCache replaces its single entry and counts the eviction', () => {
  const cache = new SingleEntryCache('layout');
  let builds = 0;
  const build = () => ++builds;
  assert.equal(cache.get('a', build), 1);
  assert.equal(cache.get('a', build), 1, 'the same key reuses the built value');
  assert.equal(builds, 1, 'a hit does not rebuild');
  assert.equal(cache.get('b', build), 2);
  assert.equal(cache.size, 1, 'replacement keeps exactly one entry');
  assert.equal(cache.has('a'), false, 'the previous key was evicted');
  assert.equal(cache.has('b'), true);
  assert.equal(cache.stats().evictions, 1);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('SingleEntryCache retains the previous entry when replacement build throws', () => {
  const cache = new SingleEntryCache('transactional');
  const first = cache.get('a', () => ({ value: 1 }));
  const before = cache.stats();
  assert.throws(() => cache.get('b', () => { throw new Error('build failed'); }), /build failed/);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.get('a', () => { throw new Error('must not rebuild'); }), first);
  assert.deepEqual(cache.stats(), { ...before, hits: before.hits + 1 });

  const empty = new SingleEntryCache('empty-transactional');
  const emptyBefore = empty.stats();
  assert.throws(() => empty.get('a', () => { throw new Error('empty failure'); }), /empty failure/);
  assert.equal(empty.size, 0);
  assert.equal(empty.has('a'), false);
  assert.deepEqual(empty.stats(), emptyBefore);
});

test('the viewer keeps one graph layout and replaces it when the run changes', async () => {
  const viewer = await createViewer(
    { noColor: true, noMotion: true, fps: 10 },
    {
      loadConfig: async () => ({ language: 'en' }),
      loadOmoTheme: async () => 'system',
      loadOmoAppearance: async () => ({}),
      columns: 120,
      rows: 40,
      write: () => {},
      // close() calls exitFn; the default is process.exit, which would kill the
      // test runner. The viewer contract only needs the cleanup to run.
      exit: () => {},
    },
  );
  const at = '2026-11-10T00:00:00.000Z';
  const snapshotFor = (runId, nodes) => normalizeSnapshot({
    version: 3,
    mode: 'demo',
    connected: true,
    sessionId: 'session-memory',
    generatedAt: at,
    provenance: { origin: 'demo-engine', capturedAt: at },
    runs: [{
      id: runId,
      name: runId,
      status: 'running',
      createdAt: at,
      updatedAt: at,
      nodes: nodes.map((id, index) => ({ id, label: id, state: index ? 'completed' : 'running', startedAt: at })),
      edges: nodes.slice(1).map((id, index) => ({ from: nodes[index], to: id })),
    }],
    tasks: [],
  });

  viewer.acceptSnapshot(snapshotFor('run_a', ['a1', 'a2']), { silent: true });
  viewer.draw();
  const first = viewer.graphLayoutCacheStats;
  assert.equal(first.limit, 1, 'the layout cache is documented as one entry');
  assert.equal(first.size, 1);

  viewer.acceptSnapshot(snapshotFor('run_b', ['b1', 'b2', 'b3']), { silent: true });
  viewer.draw();
  const second = viewer.graphLayoutCacheStats;
  assert.equal(second.size, 1, 'a different run replaces the retained layout');
  assert.equal(second.evictions, first.evictions + 1, 'the previous run layout was evicted');
  assert.ok(second.builds > first.builds, 'the new run was laid out');
  await viewer.close();
});
