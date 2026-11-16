import { number } from './normalize.mjs';
import { memoRunSummary } from './derived-cache.mjs';

// Pure run-level aggregation for the run overview. No I/O, no i18n reads and
// no clock reads beyond the `now` the caller supplies: live snapshots pass the
// wall clock, saved/stale snapshots pass the capture instant so durations freeze.
const time = value => {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : undefined;
};

// A node contributes a duration only when it recorded a start. A running node
// ends at the supplied clock; a terminal node without an end has no duration,
// and a queued node has no start at all.
function nodeWindow(node, clock) {
  const start = time(node?.startedAt);
  if (start === undefined) return undefined;
  const done = time(node?.completedAt);
  if (done !== undefined) return { start, end: Math.max(start, done) };
  if (node?.state === 'running') return { start, end: Math.max(start, clock) };
  return undefined;
}

// The ready frontier used to be a sorted array re-sorted after every release.
// A binary min-heap keeps the same lexicographic pop order (the old default
// sort comparator) at O(log n) per push instead of O(n log n) per edge.
function heapPush(heap, value) {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (heap[parent] <= heap[index]) break;
    const swap = heap[parent];
    heap[parent] = heap[index];
    heap[index] = swap;
    index = parent;
  }
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (!heap.length) return top;
  heap[0] = last;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && heap[right] < heap[left] ? right : left;
    if (heap[index] <= heap[child]) break;
    const swap = heap[index];
    heap[index] = heap[child];
    heap[child] = swap;
    index = child;
  }
  return top;
}

function maxOverlap(intervals) {
  // Intervals arrive sorted by start, so one pass over them is enough. A
  // min-heap of active end times closes finished windows: an end at the same
  // millisecond as a start closes first, so touching windows are not
  // concurrent. This avoids rebuilding and re-sorting a 2n event list.
  const ends = [];
  let max = 0;
  for (const [start, end] of intervals) {
    while (ends.length && ends[0] <= start) heapPop(ends);
    heapPush(ends, end);
    if (ends.length > max) max = ends.length;
  }
  return max;
}

function criticalPath(run, nodes, windowsById) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const duration = new Map();
  const timed = new Map();
  let anyTimed = false;
  for (const node of nodes) {
    const window = windowsById.get(node.id);
    const hasWindow = Boolean(window);
    duration.set(node.id, window ? window.end - window.start : 0);
    timed.set(node.id, hasWindow);
    if (hasWindow) anyTimed = true;
  }
  if (!anyTimed) return undefined;

  const indegree = new Map(nodes.map(node => [node.id, 0]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const edge of run?.edges ?? []) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
  }

  const queue = [];
  for (const node of nodes) {
    if (indegree.get(node.id) === 0) heapPush(queue, node.id);
  }
  const distance = new Map(nodes.map(node => [node.id, duration.get(node.id) ?? 0]));
  const steps = new Map(nodes.map(node => [node.id, 1]));
  const previous = new Map();
  const order = [];
  while (queue.length) {
    const id = heapPop(queue);
    order.push(id);
    for (const next of outgoing.get(id)) {
      const candidate = distance.get(id) + (duration.get(next) ?? 0);
      const nextSteps = steps.get(id) + 1;
      if (candidate > distance.get(next) ||
          (candidate === distance.get(next) && nextSteps > steps.get(next))) {
        distance.set(next, candidate);
        steps.set(next, nextSteps);
        previous.set(next, id);
      }
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) heapPush(queue, next);
    }
  }
  // A cycle has no honest critical path; the graph renderer reports the cycle.
  if (order.length !== nodes.length) return { cycle: true };

  let best;
  for (const node of nodes) {
    const ms = distance.get(node.id) ?? 0;
    if (best === undefined ||
        ms > best.ms ||
        (ms === best.ms && steps.get(node.id) < best.steps) ||
        (ms === best.ms && steps.get(node.id) === best.steps && node.id < best.id)) {
      best = { id: node.id, ms, steps: steps.get(node.id) };
    }
  }

  const path = [];
  for (let id = best?.id; id !== undefined; id = previous.get(id)) {
    path.push(id);
    if (path.length > nodes.length) break;
  }
  path.reverse();
  return {
    path: {
      nodeIds: path,
      labels: path.map(id => byId.get(id)?.label ?? id),
      ms: best?.ms ?? 0,
      partial: path.some(id => !timed.get(id)),
    },
  };
}

export function runSummary(run, { now = Date.now() } = {}) {
  const clock = Number.isFinite(now) ? now : Date.now();
  return memoRunSummary(run, clock, () => computeRunSummary(run, clock));
}

function computeRunSummary(run, clock) {
  const nodes = Array.isArray(run?.nodes) ? run.nodes : [];
  const total = nodes.length;
  const result = { nodes: total };
  if (!total) return result;

  let tokensIn = 0;
  let tokensOut = 0;
  let tokensSeen = 0;
  let cost = 0;
  let costSeen = 0;
  let cacheRead = 0;
  let cacheTotal = 0;
  let cacheSeen = 0;
  let retries = 0;
  let retriesSeen = 0;
  let retriesDerived = false;
  let turns = 0;
  let turnsSeen = 0;
  let tools = 0;
  let toolsSeen = 0;
  const windows = [];
  const windowsById = new Map();

  for (const node of nodes) {
    // Token in/out are only a complete pair when both were recorded; a node
    // with one side alone cannot contribute an honest in/out row.
    const input = number(node?.tokensIn);
    const output = number(node?.tokensOut);
    if (input !== undefined && output !== undefined) {
      tokensIn += input;
      tokensOut += output;
      tokensSeen++;
    }

    const nodeCost = number(node?.costUsd);
    const costStatus = node?.costStatus;
    if (nodeCost !== undefined && (costStatus === undefined || costStatus === 'reported')) {
      cost += nodeCost;
      costSeen++;
    }

    const read = number(node?.cacheReadTokens);
    const nodeTotal = number(node?.totalTokens);
    if (read !== undefined && nodeTotal !== undefined && nodeTotal > 0) {
      cacheRead += read;
      cacheTotal += nodeTotal;
      cacheSeen++;
    }

    const retry = number(node?.retries);
    if (retry !== undefined) {
      retries += retry;
      retriesSeen++;
      if (node?.retriesKind === 'derived') retriesDerived = true;
    }

    const turn = number(node?.turns);
    if (turn !== undefined) {
      turns += turn;
      turnsSeen++;
    }
    const tool = number(node?.toolCalls);
    if (tool !== undefined) {
      tools += tool;
      toolsSeen++;
    }

    // One window per node feeds totals, overlap and the critical path; the
    // clock-sensitive computation never runs twice for the same node.
    const window = nodeWindow(node, clock);
    windowsById.set(node.id, window);
    if (window) windows.push(window);
  }

  if (tokensSeen) result.tokens = { in: tokensIn, out: tokensOut, seen: tokensSeen, total };
  if (costSeen) result.cost = { usd: cost, seen: costSeen, total, lowerBound: costSeen < total };
  if (cacheSeen && cacheTotal > 0) {
    result.cache = {
      read: cacheRead,
      tokens: cacheTotal,
      hitRate: cacheRead / cacheTotal,
      seen: cacheSeen,
      total,
    };
  }
  if (retriesSeen) result.retries = { value: retries, seen: retriesSeen, total, derived: retriesDerived };
  if (turnsSeen) result.turns = { value: turns, seen: turnsSeen, total };
  if (toolsSeen) result.tools = { value: tools, seen: toolsSeen, total };

  {
    const runStart = time(run?.createdAt);
    const starts = windows.map(window => window.start);
    const ends = windows.map(window => window.end);
    const start = runStart ?? (starts.length ? Math.min(...starts) : undefined);
    // A legacy run without node end times still has its own last update; use
    // it rather than inventing a duration from the wall clock.
    const end = ends.length ? Math.max(...ends) : time(run?.updatedAt);
    if (start !== undefined && end !== undefined && end >= start) {
      result.wallMs = end - start;
    }
    result.timed = { seen: windows.length, total };
  }

  const intervals = windows
    .map(window => [window.start, window.end])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (intervals.length) {
    let busy = 0;
    let [start, end] = intervals[0];
    for (const [nextStart, nextEnd] of intervals.slice(1)) {
      if (nextStart <= end) {
        end = Math.max(end, nextEnd);
      } else {
        busy += end - start;
        start = nextStart;
        end = nextEnd;
      }
    }
    busy += end - start;
    result.busyMs = busy;
    if (result.wallMs > 0) {
      const occupied = intervals.reduce((sum, [s, e]) => sum + (e - s), 0);
      result.parallel = {
        max: maxOverlap(intervals),
        avg: occupied / result.wallMs,
        seen: windows.length,
        total,
      };
    }
  }

  const critical = criticalPath(run, nodes, windowsById);
  if (critical?.path) result.critical = critical.path;
  if (critical?.cycle) result.criticalCycle = true;
  return result;
}
