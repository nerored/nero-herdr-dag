import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot } from '../src/model.mjs';
import { DEFAULT_STALE_AFTER_MS, contrastRatio, pillForeground, renderApp } from '../src/render.mjs';
import { failedReadPlaceholder } from '../src/viewer.mjs';
import { createTheme, paletteAt, paletteFor, statusColor } from '../src/theme.mjs';
import { width as textWidth } from '../src/text.mjs';

const now = 1_000_000;
const palette = paletteAt(0);
const theme = createTheme({ palette, color: false });
const baseUi = {
  runIndex: 0, focus: 'graph', lastFocus: 'graph',
  selectedNodeId: 'evidence', selectedTaskId: 'st_ev',
  follow: false, motion: false, help: false, verbose: false, folded: new Set(),
  graphScroll: 0, graphScrollTarget: 0, manualScroll: false, sidebar: true,
  language: 'en', fps: 12, toasts: [],
};

// A host-shaped response long enough to cross the 1200-character excerpt bound
// and to prove that middle content, not just the four-line tail, is painted.
const LONG_REPLY = `EVIDENCE-START ${'alpha beta gamma '.repeat(60)}MIDDLE-MARKER-${'delta epsilon zeta '.repeat(50)}`;
const replyBytes = Buffer.byteLength(LONG_REPLY.trim(), 'utf8');

function hostTask(overrides = {}) {
  return {
    id: 'st_ev',
    description: 'Ship the evidence UI',
    status: 'failed',
    agent: 'implementer',
    model: 'crs/deepseek-v4.1-flash',
    final_response: LONG_REPLY,
    error_message: 'child process exited 1 while running typecheck',
    failure_kind: 'tool_failure',
    run_stats: {
      turns: 22,
      tool_calls: 26,
      failed_turns: 4,
      input_tokens: 45231,
      output_tokens: 19512,
      cache_read_tokens: 1065600,
      cache_write_tokens: 2048,
      total_tokens: 1130343,
      cost_usd: 0.02168865,
      cost_status: 'reported',
      cache_hit_rate_run: 0.959281834950591,
      cache_hit_rate_last: 0.9946844873529863,
      tokens_per_second: 225,
    },
    ...overrides,
  };
}

function hostNode(overrides = {}) {
  return {
    id: 'evidence',
    label: 'Evidence node',
    state: 'failed',
    task_id: 'st_ev',
    output: 'output alpha\noutput beta\noutput gamma\noutput delta\noutput epsilon',
    outputBytes: 2627,
    logs: ['node log alpha', 'node log beta'],
    resultArtifact: {
      relativePath: 'dag/results/run-1/evidence.txt',
      bytes: 943,
      sha256: '95d16fabc786856839dfe918266620159b32229ea3bee56a4afa1d89eded118d',
      stats: { relativePath: 'dag/results/run-1/evidence.stats.json', bytes: 477 },
    },
    runStats: {
      turns: 22,
      tool_calls: 26,
      failed_turns: 4,
      input_tokens: 45231,
      output_tokens: 19512,
      cache_read_tokens: 1065600,
      cache_write_tokens: 2048,
      total_tokens: 1130343,
      cost_usd: 0.02168865,
      cost_status: 'reported',
      cache_hit_rate_run: 0.959281834950591,
      tokens_per_second: 225,
    },
    ...overrides,
  };
}

function snapshot({ task = {}, node = {}, run = {} } = {}) {
  return normalizeSnapshot({
    version: 3,
    mode: 'live',
    sessionId: 'evidence-session',
    connected: true,
    updatedAt: '2026-11-10T00:00:00Z',
    runs: [{
      id: 'run-evidence',
      name: 'Evidence run',
      status: 'failed',
      createdAt: '2026-11-10T00:00:00Z',
      nodes: [hostNode(node)],
      edges: [],
      ...run,
    }],
    tasks: [hostTask(task)],
  });
}

function render(snap, overrides = {}, { width = 140, height = 120 } = {}) {
  return renderApp(snap, { ...baseUi, ...overrides }, {
    width, height, time: 0, now, palette, theme,
  });
}

function detailsLines(result) {
  const { x, y, w, h } = result.layout.details;
  return result.text.split('\n').slice(y, y + h).map(line => line.slice(x, x + w));
}

function headingIndex(lines, heading) {
  const index = lines.findIndex(line => line.includes(heading));
  assert.ok(index >= 0, `${heading} heading is missing`);
  return index;
}

const hasHeading = (lines, heading) => lines.some(line => line.includes(heading));

test('the whole persisted reply excerpt renders under verbose REPLY with a truncation marker', () => {
  const result = render(snapshot(), { focus: 'tasks', selectedTaskId: 'st_ev', verbose: true });
  const lines = detailsLines(result);
  const reply = headingIndex(lines, 'REPLY');
  const source = headingIndex(lines, 'SOURCE');
  const thinking = headingIndex(lines, 'THINKING');
  assert.ok(reply < source, 'SOURCE must follow REPLY');
  assert.ok(source < thinking, 'SOURCE must precede THINKING');
  assert.match(result.text, /EVIDENCE-START/);
  assert.match(result.text, /MIDDLE-MARKER/);
  assert.ok(replyBytes > 1200, 'fixture exceeds the excerpt bound');
  assert.match(result.text, new RegExp(`truncated · ${replyBytes} B total`));
  const thinkingBody = lines.slice(headingIndex(lines, 'THINKING') + 1, headingIndex(lines, 'THINKING') + 6).join('\n');
  assert.doesNotMatch(thinkingBody, /EVIDENCE-START/);
});

test('a short details viewport scrolls to the end of the verbose reply and its marker', () => {
  const tall = render(snapshot(), { focus: 'tasks', selectedTaskId: 'st_ev', verbose: true });
  const lines = detailsLines(tall);
  const replyRow = headingIndex(lines, 'REPLY');
  const markerRow = lines.findIndex(line => line.includes('truncated ·'));
  assert.ok(markerRow > replyRow, 'marker is measured below the reply heading');
  const replyOffset = Math.max(0, replyRow - 2);
  const markerOffset = Math.max(0, markerRow - 2 - 4);

  const top = render(snapshot(), {
    focus: 'tasks', selectedTaskId: 'st_ev', verbose: true, detailsScroll: replyOffset,
  }, { height: 30 });
  assert.match(top.text, /EVIDENCE-START/);
  assert.doesNotMatch(top.text, /truncated ·/);
  const bottom = render(snapshot(), {
    focus: 'tasks', selectedTaskId: 'st_ev', verbose: true, detailsScroll: markerOffset,
  }, { height: 30 });
  assert.match(bottom.text, /truncated ·/);
  assert.ok(bottom.scroll.details.offset > 0);
});

test('failed, cancelled, and blocked details expose reason provenance or not-recorded', () => {
  const failed = render(snapshot(), { focus: 'tasks', selectedTaskId: 'st_ev' });
  assert.match(failed.text, /child process exited 1 while running/);
  assert.match(failed.text, /typecheck/);
  assert.match(failed.text, /source error_message/);
  assert.match(failed.text, /kind tool_failure/);

  const cancelled = render(snapshot({
    task: {
      status: 'cancelled', error_message: undefined, failure_kind: undefined,
      final_response: undefined, run_stats: undefined,
    },
    node: { state: 'cancelled' },
    run: { status: 'cancelled' },
  }), { focus: 'tasks', selectedTaskId: 'st_ev' });
  assert.equal(hasHeading(detailsLines(cancelled), 'ERROR'), true);
  assert.match(cancelled.text, /failure reason not recorded/);

  const blocked = render(snapshot({
    task: {
      status: 'blocked', error_message: undefined, failure_kind: undefined,
      final_response: undefined,
    },
    node: { state: 'blocked' },
    run: { status: 'blocked' },
  }), { focus: 'tasks', selectedTaskId: 'st_ev' });
  assert.equal(hasHeading(detailsLines(blocked), 'ERROR'), true);
  assert.match(blocked.text, /failure reason not recorded/);
});

test('cache reads, hit rate, and cost render on aligned metric rows', () => {
  const result = render(snapshot(), { focus: 'tasks', selectedTaskId: 'st_ev' });
  assert.match(result.text, /hit\s+1\.1m\/1\.1m \(95\.9%\) · \$0\.0217/);
  assert.match(result.text, /retries\s+4\b/);
  assert.match(result.text, /recorded from failed turns/);
  assert.doesNotMatch(result.text, /cache not recorded|cost not reported/);
});

test('metrics rows share one value column', () => {
  const lines = detailsLines(render(snapshot(), { focus: 'tasks', selectedTaskId: 'st_ev' }));
  const start = headingIndex(lines, 'METRICS');
  const end = headingIndex(lines, 'THINKING');
  const rows = lines.slice(start + 1, end).filter(line => line.replace(/[│\s]/g, '').length > 0);
  const expected = [
    'tokens', 'TOKEN RATE', 'hit', 'retries',
    'recorded from failed turns', 'turns',
  ];
  for (const [index, label] of expected.entries()) {
    assert.ok(rows[index]?.includes(label), `row ${index} should carry ${label}: ${rows[index]}`);
  }
  const valueColumn = (line, label) => {
    let index = line.indexOf(label) + label.length;
    let column = textWidth(line.slice(0, index));
    while (line[index] === ' ') { index++; column++; }
    return column;
  };
  const columns = expected
    .map((label, index) => (label.startsWith('recorded') ? undefined : valueColumn(rows[index], label)))
    .filter(column => column !== undefined);
  assert.equal(new Set(columns).size, 1, `value columns: ${columns.join(',')}`);
});

test('an unreported cost status suppresses the number instead of printing a fake value', () => {
  const result = render(snapshot({
    task: { run_stats: { ...hostTask().run_stats, cost_status: 'estimated' } },
    node: { runStats: { ...hostNode().runStats, cost_status: 'estimated' } },
  }), { focus: 'tasks', selectedTaskId: 'st_ev' });
  assert.match(result.text, /\$ -/);
  assert.doesNotMatch(result.text, /\$0\.0217/);
});

test('metric values use distinct purpose colors', () => {
  const wide = render(snapshot(), { focus: 'tasks', selectedTaskId: 'st_ev' });
  const lines = detailsLines(wide);
  const cellOf = (result, row, column) => result.canvas.cells[result.layout.details.y + row][result.layout.details.x + column].fg;
  const valueColumn = (line, needle) => {
    let index = line.indexOf(needle) + needle.length;
    while (line[index] === ' ') index++;
    return index;
  };

  const tokenRow = lines.findIndex(line => line.includes('tokens') && line.includes('in /'));
  const rateRow = lines.findIndex(line => line.includes('TOKEN RATE'));
  const cacheRow = lines.findIndex(line => line.includes('1.1m/'));
  const retryRow = lines.findIndex(line => line.includes('retries'));
  const toolsRow = lines.findIndex(line => line.includes('tools'));
  assert.ok(tokenRow >= 0 && rateRow >= 0 && cacheRow >= 0 && retryRow >= 0);

  const tokenColor = cellOf(wide, tokenRow, valueColumn(lines[tokenRow], 'tokens'));
  const rateColor = cellOf(wide, rateRow, valueColumn(lines[rateRow], 'TOKEN RATE'));
  const costColor = cellOf(wide, cacheRow, lines[cacheRow].indexOf('$'));
  const retryColor = cellOf(wide, retryRow, valueColumn(lines[retryRow], 'retries'));
  const toolsColor = cellOf(wide, toolsRow, valueColumn(lines[toolsRow], 'tools'));

  assert.equal(tokenColor, palette.accent2);
  assert.equal(rateColor, palette.accent);
  assert.equal(costColor, palette.warn);
  assert.equal(toolsColor, palette.accent3);
  assert.equal(retryColor, palette.warn);
  assert.ok(new Set([tokenColor, rateColor, costColor, toolsColor, retryColor]).size >= 4);
});

test('known failed turns render with their recorded source and unknown retries stay unknown', () => {
  const known = render(snapshot(), { focus: 'tasks', selectedTaskId: 'st_ev' });
  assert.match(known.text, /retries\s+4\b/);
  assert.match(known.text, /recorded from failed turns/);
  const knownLines = known.text.split('\n');
  const knownRow = knownLines.findIndex(line => line.includes('retries'));
  const knownLabel = knownLines[knownRow].indexOf('retries');
  const knownValue = knownLines[knownRow].indexOf('4', knownLabel);
  assert.ok(knownRow >= 0 && knownValue > knownLabel);
  assert.equal(known.canvas.cells[knownRow][knownValue].fg, palette.warn);

  const unknown = render(snapshot({
    task: { run_stats: undefined, error_message: undefined, failure_kind: undefined },
    node: { runStats: undefined },
  }), { focus: 'tasks', selectedTaskId: 'st_ev' });
  assert.match(unknown.text.replace(/[│█]/g, ' '), /failed turns not\s+recorded/);
  assert.doesNotMatch(unknown.text, /retries 0/);
  assert.match(unknown.text, /— in \/ — out/);
});

test('retry provenance distinguishes derived, recorded, and unknown counts', () => {
  const inferred = snapshot({
    task: { run_stats: { turns: 6, tool_calls: 2 } },
    node: { runStats: { turns: 6, tool_calls: 2 } },
  });
  for (const [width, height] of [[54, 42], [120, 40]]) {
    const result = render(inferred, { focus: 'tasks', selectedTaskId: 'st_ev' }, { width, height });
    assert.match(result.text, /retries\s+0\b/, `derived retry at ${width}`);
    assert.match(result.text, /derived from turns/, `derived source at ${width}`);
    assert.doesNotMatch(result.text, /retries 0 ·/, `no bare recorded-looking zero at ${width}`);
  }

  const recorded = render(snapshot(), { focus: 'tasks', selectedTaskId: 'st_ev' }, { width: 140, height: 60 });
  assert.match(recorded.text, /retries\s+4\b/);
  assert.match(recorded.text, /recorded from failed turns/);

  const unknown = render(snapshot({
    task: { run_stats: undefined },
    node: { runStats: undefined },
  }), { focus: 'tasks', selectedTaskId: 'st_ev' }, { width: 120, height: 40 });
  assert.match(unknown.text.replace(/[│█]/g, ' '), /failed turns not\s+recorded/);
  assert.doesNotMatch(unknown.text, /retries \d/);
});

test('one token-rate sample keeps its instant or average label and paints a zero-padded chart', () => {
  for (const [width, height] of [[120, 40], [54, 40]]) {
    const instant = render(snapshot(), { focus: 'tasks', selectedTaskId: 'st_ev' }, { width, height });
    const instantLine = instant.text.split('\n').find(line => line.includes('TOKEN RATE'));
    assert.ok(instantLine, `TOKEN RATE row exists at ${width}x${height}`);
    const chart = instantLine.match(/TOKEN RATE\s+([▁▂▃▄▅▆▇█]+)/)?.[1];
    assert.ok(chart && chart.length >= 4, `zero-padded chart at ${width}x${height}`);
    assert.ok(chart.startsWith('▁'), `missing samples lead with zero slots at ${width}x${height}`);
    assert.match(instantLine, /225\/s \(instant\)/);
    assert.doesNotMatch(instantLine, /peak/);
  }

  const averageSnapshot = snapshot({
    task: {
      final_response: 'Average rate fixture',
      run_stats: undefined,
      tokens_out: 1000,
      started_at: '2026-11-10T00:00:00Z',
      completed_at: '2026-11-10T00:01:40Z',
    },
    node: { runStats: undefined, output: undefined, outputBytes: undefined, resultArtifact: undefined },
  });
  for (const width of [120, 54]) {
    const average = render(averageSnapshot, { focus: 'tasks', selectedTaskId: 'st_ev' }, { width, height: 40 });
    assert.match(average.text, /TOKEN RATE\s+[▁▂▃▄▅▆▇█]+/,
      `one-sample average chart at width ${width}`);
    assert.match(average.text, /10\/s/, `one-sample average reading at width ${width}`);
    assert.match(average.text, /\(average \(lifetime\)\)/,
      `lifetime average label at width ${width}`);
  }

  const history = render(snapshot({
    task: { run_stats: undefined, tokenRate: [2, 4, 8, 16], tokenRateKind: 'history' },
    node: { runStats: undefined },
  }), { focus: 'tasks', selectedTaskId: 'st_ev' });
  const historyLine = history.text.split('\n').find(line => line.includes('TOKEN RATE'));
  assert.match(historyLine, /TOKEN RATE [▁▂▃▄▅▆▇█]+ \(history\)/);
  assert.match(history.text, /peak 16\/s/);
});

// ---- N1 freshness, source health, and empty-state truth ----

function staleSnapshot(mutate = () => {}) {
  const snap = snapshot();
  snap.provenance = {
    ...snap.provenance,
    origin: 'controller',
    statePath: '/tmp/herdr-dag/state.json',
    capturedAt: new Date(now - 8 * 3600_000).toISOString(),
  };
  snap.sources = [];
  mutate(snap);
  return snap;
}

function unreadableSource() {
  return {
    id: 'store-a', label: 'repo store', origin: 'in-project', root: '/tmp/senorepo',
    status: 'unreadable',
    tasks: { files: 3, accepted: 12, foreign: 0, invalid: 1 },
    runs: { files: 4, accepted: 3, foreign: 1, invalid: 0 },
    scannedAt: new Date(now - 5000).toISOString(),
    error: 'EACCES: permission denied',
  };
}

test('a stale connected capture renders STALE with a visible age at 54 and 120', () => {
  const snap = staleSnapshot();
  for (const [width, height] of [[54, 42], [120, 40]]) {
    const result = render(snap, { focus: 'graph' }, { width, height });
    assert.match(result.text, /▲ STALE/, `stale badge at ${width}`);
    assert.doesNotMatch(result.text, /● LIVE/, `no live badge at ${width}`);
    assert.match(result.text, /captured 8h ago/, `capture age at ${width}`);
  }
  // Below 48 columns the full phrase cannot fit, but the age value must.
  const short = render(snap, { focus: 'graph' }, { width: 40, height: 24 });
  assert.match(short.text, /▲ STALE/, 'stale badge at 40');
  assert.match(short.text, /8h/, 'compact age survives below 48 columns');
  assert.doesNotMatch(short.text, /captu…/, 'the age value is not clipped away');
});

test('the stale threshold is configurable and a fresh capture stays LIVE', () => {
  assert.equal(DEFAULT_STALE_AFTER_MS, 60_000, 'render and viewer share config default');
  const snap = staleSnapshot(snapshotValue => {
    snapshotValue.provenance.capturedAt = new Date(now - 10_000).toISOString();
  });
  const fresh = render(snap, { focus: 'graph' }, { width: 120, height: 40 });
  assert.match(fresh.text, /● LIVE/);
  assert.match(fresh.text, /captured 10s ago/);
  assert.doesNotMatch(fresh.text, /STALE/);

  const thresholded = render(snap, { focus: 'graph', staleAfterMs: 5000 }, { width: 120, height: 40 });
  assert.match(thresholded.text, /▲ STALE/);
  assert.doesNotMatch(thresholded.text, /● LIVE/);
});

test('the verbose source section never calls a stale capture LIVE', () => {
  const snap = staleSnapshot();
  const result = render(snap, { focus: 'tasks', selectedTaskId: 'st_ev', verbose: true }, { width: 140, height: 120 });
  assert.match(result.text, /SOURCE/);
  assert.match(result.text, /mode\s+STALE/, 'source mode follows frame freshness');
  assert.doesNotMatch(result.text, /mode\s+LIVE/, 'stale source mode must not claim LIVE');
});

test('stale elapsed time freezes at capturedAt instead of growing with the clock', () => {
  const snap = staleSnapshot(snapshotValue => {
    const captured = Date.parse(snapshotValue.provenance.capturedAt);
    for (const entity of [snapshotValue.tasks[0], snapshotValue.runs[0].nodes[0]]) {
      entity.status = 'running';
      entity.state = 'running';
      entity.startedAt = new Date(captured - 60_000).toISOString();
      entity.completedAt = undefined;
    }
    snapshotValue.runs[0].status = 'running';
  });
  const first = render(snap, { focus: 'tasks', selectedTaskId: 'st_ev' }, { width: 120, height: 40 });
  assert.match(first.text, /00:01:00/);
  const laterNow = renderApp(snap, {
    ...baseUi, focus: 'tasks', selectedTaskId: 'st_ev', staleAfterMs: 120_000,
  }, { width: 120, height: 40, time: 0, now: now + 60_000, palette, theme });
  assert.match(laterNow.text, /00:01:00/);
  assert.doesNotMatch(laterNow.text, /00:02:00/);
});

test('unreadable source health with EACCES is visible at 54 and 120', () => {
  const snap = staleSnapshot(snapshotValue => { snapshotValue.sources = [unreadableSource()]; });
  for (const [width, height] of [[54, 42], [120, 40]]) {
    const result = render(snap, { focus: 'tasks', selectedTaskId: 'st_ev' }, { width, height });
    assert.match(result.text, /\bSOURCE\b/, `source heading at ${width}`);
    assert.match(result.text, /unreadable/, `status at ${width}`);
    assert.match(result.text, /EACCES/, `error at ${width}`);
    assert.match(result.text, /12 accepted/, `accepted count at ${width}`);
    assert.match(result.text, /0 foreign/, `foreign count at ${width}`);
    assert.match(result.text, /1 invalid/, `invalid count at ${width}`);
    assert.match(result.text, /runs 3\/1\/0/, `run counts at ${width}`);
    assert.match(result.text, /scanned 5s ago/, `scan age at ${width}`);
    assert.match(result.text, /repo store/, `root/label at ${width}`);
  }
});

test('connected-empty and never-read empty states are distinct and actionable', () => {
  const connected = normalizeSnapshot({
    version: 3, mode: 'live', connected: true, sessionId: 'empty-live',
    provenance: {
      origin: 'controller', statePath: '/tmp/herdr-dag/state.json',
      capturedAt: new Date(now - 3000).toISOString(),
    },
    sources: [{ ...unreadableSource(), status: 'ok', error: undefined }],
    runs: [], tasks: [],
  });
  for (const [width, height] of [[54, 42], [120, 40]]) {
    const result = render(connected, { focus: 'graph' }, { width, height });
    assert.match(result.text, /CONNECTED · NO WORKFLOW YET/, `connected label at ${width}`);
    assert.match(result.text, /~?\/tmp\/herdr-dag\/state\.json/, `watched path at ${width}`);
    assert.match(result.text, /captured 3s ago/, `capture age at ${width}`);
    assert.match(result.text, /next:/i, `next step at ${width}`);
    assert.match(result.text, /scanned 5s ago/, `scan age uses the frame clock at ${width}`);
    assert.doesNotMatch(result.text, /Waiting for a workflow snapshot/, `no waiting copy at ${width}`);
  }

  const neverRead = normalizeSnapshot({
    version: 3, mode: 'live', connected: false, sessionId: 'never-read',
    provenance: { origin: 'controller', statePath: '/tmp/herdr-dag/state.json' },
    runs: [], tasks: [],
  });
  const waiting = render(neverRead, { focus: 'graph' }, { width: 54, height: 42 });
  assert.match(waiting.text, /WAITING · NO SNAPSHOT/);
  assert.match(waiting.text, /next:/i);
  assert.match(waiting.text, /retry:/i, 'never-read still advertises the retry loop');
  assert.doesNotMatch(waiting.text, /CONNECTED · NO WORKFLOW YET/);
});

test('a failed read keeps its path, last error, and a retry indicator in WAITING', () => {
  const placeholder = failedReadPlaceholder(
    '/tmp/herdr-dag/state.json',
    { message: 'ENOENT: no such file or directory' },
    { view: 'watch', now },
  );
  for (const [width, height] of [[54, 42], [120, 40]]) {
    const result = render(placeholder, { focus: 'graph' }, { width, height });
    assert.match(result.text, /WAITING · NO SNAPSHOT/, `waiting label at ${width}`);
    assert.match(result.text, /state\.json/, `state path at ${width}`);
    assert.match(result.text, /last read error: ENOENT/, `persistent error at ${width}`);
    assert.match(result.text, /retry: auto-retry on file change/, `retry indicator at ${width}`);
    assert.doesNotMatch(result.text, /CONNECTED · NO WORKFLOW YET/, `not connected-empty at ${width}`);
  }

  const later = renderApp(placeholder, { ...baseUi, focus: 'graph' }, {
    width: 54, height: 42, time: 0, now: now + 60_000, palette, theme,
  });
  assert.match(later.text, /last read error: ENOENT/);
  assert.match(later.text, /retry: auto-retry/);
});

// ---- N5 truthful rate and progress signals ----

test('a constant 32-sample rate series paints a flat strip, names its kind, and omits peak', () => {
  const constant = snapshot({
    task: {
      status: 'running', run_stats: undefined,
      tokenRate: Array(32).fill(180), tokenRateKind: 'history',
    },
    node: { state: 'running', runStats: undefined },
    run: { status: 'running' },
  });
  constant.runs[0].nodes[0].tokenRate = Array(32).fill(180);
  constant.runs[0].nodes[0].tokenRateKind = 'history';
  for (const [width, height] of [[54, 42], [120, 40]]) {
    const result = render(constant, { focus: 'tasks', selectedTaskId: 'st_ev' }, { width, height });
    const row = detailsLines(result).find(line => line.includes('TOKEN RATE'));
    assert.ok(row, `rate row at ${width}`);
    assert.match(row, /\(constant\)/, `constant label at ${width}`);
    assert.doesNotMatch(row, /peak/, `no peak at ${width}`);
    assert.doesNotMatch(row, /[▂▃▄▅▆▇█]/, `flat strip at ${width}`);
    const strip = row.match(/TOKEN RATE\s+(▁+)/)?.[1] ?? '';
    assert.ok(strip.length >= 4, `flat strip width at ${width}`);
  }
});

test('a timestamp-less producer ring is labeled tick-sampled', () => {
  const sampled = snapshot({
    task: {
      status: 'running', run_stats: undefined,
      tokenRate: Array(8).fill(100), tokenRateKind: 'history',
      tokenRateHistory: Array.from({ length: 8 }, () => ({ rate: 100 })),
    },
    node: { state: 'running', runStats: undefined },
    run: { status: 'running' },
  });
  for (const [width, height] of [[54, 42], [120, 40]]) {
    const result = render(sampled, { focus: 'tasks', selectedTaskId: 'st_ev' }, { width, height });
    const row = detailsLines(result).find(line => line.includes('TOKEN RATE'));
    assert.ok(row, `rate row at ${width}`);
    assert.match(row, /\(tick-sampled\)/, `tick-sampled label at ${width}`);
    assert.doesNotMatch(row, /peak/, `no peak at ${width}`);
  }
});

test('a varying series keeps its sparkline, history kind, and peak at 54 and 120', () => {
  const varying = snapshot({
    task: { status: 'running', run_stats: undefined, tokenRate: [2, 4, 8, 16], tokenRateKind: 'history' },
    node: { state: 'running', runStats: undefined },
    run: { status: 'running' },
  });
  varying.runs[0].nodes[0].tokenRate = [2, 4, 8, 16];
  varying.runs[0].nodes[0].tokenRateKind = 'history';
  for (const [width, height] of [[54, 42], [120, 40]]) {
    const result = render(varying, { focus: 'tasks', selectedTaskId: 'st_ev' }, { width, height });
    const row = detailsLines(result).find(line => line.includes('TOKEN RATE'));
    assert.match(row, /\(history\)/, `kind at ${width}`);
    assert.match(row, /[▁▂▃▄▅▆▇█]{2,}/, `sparkline at ${width}`);
    assert.match(result.text, /peak 16\/s/, `peak at ${width}`);
  }
});

test('completed derived percent and running done/total stay honest on compact rows', () => {
  const completed = snapshot({
    task: { status: 'completed', run_stats: undefined, final_response: undefined },
    node: { state: 'completed', runStats: undefined, output: undefined, outputBytes: undefined, resultArtifact: undefined },
    run: { status: 'completed' },
  });
  for (const [width, height] of [[54, 42], [140, 60]]) {
    const result = render(completed, { focus: 'tasks', selectedTaskId: 'st_ev' }, { width, height });
    assert.match(result.text, /100% \(derived from completed status\)/,
      `derived completion at ${width}`);
    assert.doesNotMatch(result.text, /percent not recorded/, `no unknown percent at ${width}`);
  }
  const narrow = render(completed, { focus: 'tasks', selectedTaskId: 'st_ev' }, { width: 120, height: 40 });
  assert.match(narrow.text, /100% \(derived from completed/, 'details state the completed-status source');
  assert.doesNotMatch(narrow.text, /100% \(derived\)/, 'no shorter derived label remains');

  const running = snapshot({
    task: { status: 'running', run_stats: undefined, final_response: undefined, percent: undefined },
    node: { state: 'running', runStats: undefined },
    run: { status: 'running' },
  });
  running.tasks[0].percent = undefined;
  running.runs[0].nodes[0].percent = undefined;
  running.tasks[0].children = [
    { id: 'child-done', description: 'done child', status: 'completed' },
    { id: 'child-run', description: 'running child', status: 'running' },
  ];
  for (const [width, height] of [[54, 42], [120, 40]]) {
    const result = render(running, { focus: 'tasks', selectedTaskId: 'st_ev' }, { width, height });
    assert.match(result.text, /percent not recorded/, `unknown label at ${width}`);
    assert.match(result.text, /1\/2/, `done/total at ${width}`);
    assert.doesNotMatch(result.text, /(?:^|[^0-9])0%/, `no fabricated zero at ${width}`);
  }
});

test('a legacy v2 explicit percent keeps its numeric label', () => {
  const legacy = normalizeSnapshot({
    version: 2, sessionId: 'legacy-v2', connected: true,
    updatedAt: '2026-11-10T00:00:00Z',
    runs: [{
      id: 'legacy-run', name: 'Legacy run', status: 'completed',
      createdAt: '2026-11-10T00:00:00Z',
      nodes: [{ id: 'legacy-node', label: 'Legacy node', state: 'completed', percent: 87 }],
      edges: [],
    }],
    tasks: [{ id: 'legacy-task', description: 'Legacy task', status: 'completed', percent: 87 }],
  });
  assert.equal(legacy.tasks[0].provenance.percent.kind, 'unknown', 'v2 percent provenance is unknown');
  for (const [width, height] of [[54, 42], [120, 40]]) {
    const result = render(legacy, {
      focus: 'tasks', selectedTaskId: 'legacy-task', selectedNodeId: 'legacy-node',
    }, { width, height });
    assert.match(result.text, /87%/, `explicit value at ${width}`);
    assert.doesNotMatch(result.text, /87% \(derived\)/, `no false derived label at ${width}`);
    assert.doesNotMatch(result.text, /87% （推导）/, `no false zh derived label at ${width}`);
  }
});

// ---- N6 palette contrast guardrails ----

test('status pills meet 4.5:1 in every palette and keep glyph plus word', () => {
  const palettes = [
    paletteFor('dark'), paletteFor('light'), paletteFor('grok-day'), paletteFor('grok-night'),
    paletteFor('system', { appearance: 'dark' }), paletteFor('system', { appearance: 'light' }),
  ];
  const statuses = [
    'pending', 'blocked', 'scheduled', 'running', 'paused', 'completed',
    'failed', 'cancelled', 'skipped', 'error', 'interrupted', 'lost',
  ];
  for (const candidate of palettes) {
    for (const status of statuses) {
      const background = statusColor(candidate, status);
      const foreground = pillForeground(background);
      assert.ok(contrastRatio(foreground, background) >= 4.5,
        `${candidate.name}/${status} contrast ${contrastRatio(foreground, background).toFixed(2)}`);
    }
  }

  const light = paletteFor('light');
  const lightTheme = createTheme({ palette: light, color: false });
  const frame = renderApp(snapshot(), { ...baseUi, focus: 'tasks', selectedTaskId: 'st_ev' }, {
    width: 140, height: 60, time: 0, now, palette: light, theme: lightTheme,
  });
  const lines = frame.text.split('\n');
  const row = lines.findIndex(line => line.includes('× FAILED'));
  assert.ok(row >= 0, 'failed status pill is present');
  const column = lines[row].indexOf('FAILED');
  assert.equal(frame.canvas.cells[row][column].fg, pillForeground(light.failed));
  assert.ok(contrastRatio(frame.canvas.cells[row][column].fg, light.failed) >= 4.5);
  assert.match(lines[row], /× FAILED/);
});

test('token-rate history paints multiple bars with a time-axis span', () => {
  const stamp = seconds => new Date(now - seconds * 1000).toISOString();
  const result = render(snapshot({
    task: {
      tokenRate: [10, 20, 30],
      tokenRateKind: 'history',
      tokenRateHistory: [
        { at: stamp(30), rate: 10 },
        { at: stamp(15), rate: 20 },
        { at: stamp(0), rate: 30 },
      ],
    },
  }), { focus: 'tasks', selectedTaskId: 'st_ev' });
  const line = detailsLines(result).find(candidate => candidate.includes('TOKEN RATE'));
  assert.ok(line, 'token rate line should render');
  assert.match(line, /-30s/);
  const bars = line.match(/[▁▂▃▄▅▆▇█]/g) ?? [];
  assert.ok(bars.length >= 3, `expected at least 3 rate bars, got ${bars.length}`);
});

test('node recent events show the output tail and verbose artifact metadata', () => {
  const compact = render(snapshot(), { selectedNodeId: 'evidence' });
  const compactLines = detailsLines(compact);
  assert.equal(hasHeading(compactLines, 'EVENTS'), true);
  assert.match(compact.text, /output gamma/);
  assert.match(compact.text, /output delta/);
  assert.match(compact.text, /output epsilon/);
  assert.doesNotMatch(compact.text, /output alpha/);
  assert.doesNotMatch(compact.text, /output beta/);
  assert.match(compact.text, /output truncated · 2627 B recorded/);
  assert.doesNotMatch(compact.text, /sha256/);

  const verbose = render(snapshot(), { selectedNodeId: 'evidence', verbose: true });
  const verboseLines = detailsLines(verbose);
  const error = headingIndex(verboseLines, 'ERROR');
  const events = headingIndex(verboseLines, 'EVENTS');
  const log = headingIndex(verboseLines, 'RECENT LOG');
  assert.ok(error < events && events < log, 'EVENTS sits between ERROR and RECENT LOG');
  assert.match(verbose.text, /artifact 943 B · sha256 95d16fab/);
  assert.match(verbose.text, /stats 477 B/);
  assert.match(verbose.text, /path dag\/results\/run-1\/evidence\.txt/);
});

test('a node without output or artifact paints no empty EVENTS section', () => {
  const result = render(snapshot({
    node: { output: undefined, outputBytes: undefined, resultArtifact: undefined },
  }), { selectedNodeId: 'evidence', verbose: true });
  assert.equal(hasHeading(detailsLines(result), 'EVENTS'), false);
});

test('the no-evidence fixture renders dashes and omits absent metric rows', () => {
  const noEvidence = snapshot({
    task: {
      final_response: undefined,
      error_message: undefined,
      failure_kind: undefined,
      run_stats: undefined,
    },
    node: {
      state: 'completed', output: undefined, outputBytes: undefined,
      resultArtifact: undefined, runStats: undefined,
    },
    run: { status: 'completed' },
  });
  const result = render(noEvidence, { focus: 'tasks', selectedTaskId: 'st_ev' });
  assert.match(result.text, /reply not recorded|reasoning not recorded/);
  assert.match(result.text, /— in \/ — out/);
  assert.match(result.text, /failed turns not\s+recorded/);
  assert.doesNotMatch(result.text, /% hit/);
  assert.doesNotMatch(result.text, /\btotal \d/);
  assert.doesNotMatch(result.text, /\$\d/);
  assert.doesNotMatch(result.text, /retries 0/);

  const compact = render(noEvidence, { focus: 'tasks', selectedTaskId: 'st_ev' }, { width: 54, height: 42 });
  assert.match(compact.text, /turns\s+—/);
  assert.match(compact.text, /failed turns not\s+recorded/);
  assert.match(result.text, /tools\s+—/);
});

test('evidence sections keep exact frame widths at 54, 72, 120, and 140 columns', () => {
  for (const width of [54, 72, 120, 140]) {
    const result = render(snapshot(), {
      selectedNodeId: 'evidence', verbose: true,
    }, { width, height: 42 });
    for (const line of result.text.split('\n')) {
      assert.equal(textWidth(line), width, `${width}-column line width ${textWidth(line)}`);
    }
  }
});

test('Chinese evidence labels use the same keys and templates', () => {
  const result = render(snapshot(), {
    focus: 'tasks', selectedTaskId: 'st_ev', language: 'zh', verbose: true,
  });
  assert.match(result.text, /回复/);
  assert.match(result.text, /命中\s+1\.1m\/1\.1m \(95\.9%\) · \$0\.0217/);
  assert.match(result.text, /瞬时/);
  assert.match(result.text, /已截断/);
});

// F-162: pin the semantic color tokens, not only the internally consistent
// foreground derived from the same pillForeground used for painting.
test('light palette failed and completed pills pin their foreground and background tokens', () => {
  const light = paletteFor('light');
  assert.equal(light.failed, '#c8253d');
  assert.equal(light.completed, '#337e58');
  assert.equal(statusColor(light, 'failed'), '#c8253d');
  assert.equal(statusColor(light, 'completed'), '#337e58');
  assert.equal(pillForeground('#c8253d'), '#ffffff');
  assert.equal(pillForeground('#337e58'), '#ffffff');

  const lightTheme = createTheme({ palette: light, color: false });
  const frameFor = (snap, needle) => {
    const frame = renderApp(snap, { ...baseUi, focus: 'tasks', selectedTaskId: 'st_ev' }, {
      width: 140, height: 60, time: 0, now, palette: light, theme: lightTheme,
    });
    const lines = frame.text.split('\n');
    const row = lines.findIndex(line => line.includes(needle));
    assert.ok(row >= 0, `${needle} pill is present`);
    const column = lines[row].indexOf(needle);
    return { frame, row, column, line: lines[row] };
  };

  const failed = frameFor(snapshot(), '× FAILED');
  assert.equal(failed.frame.canvas.cells[failed.row][failed.column].bg, '#c8253d');
  assert.equal(failed.frame.canvas.cells[failed.row][failed.column].fg, '#ffffff');
  assert.match(failed.line, /× FAILED/);

  const completed = frameFor(snapshot({
    task: {
      status: 'completed', error_message: undefined, failure_kind: undefined, final_response: undefined,
    },
    node: { state: 'completed' },
    run: { status: 'completed' },
  }), '✓ COMPLETED');
  assert.equal(completed.frame.canvas.cells[completed.row][completed.column].bg, '#337e58');
  assert.equal(completed.frame.canvas.cells[completed.row][completed.column].fg, '#ffffff');
  assert.match(completed.line, /✓ COMPLETED/);

  assert.notEqual('#c8253d', '#337e58', 'failed and completed must not collapse to one token');
});
