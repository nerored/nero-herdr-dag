import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Canvas } from '../src/canvas.mjs';
import { t } from '../src/i18n.mjs';
import { normalizeSnapshot } from '../src/model.mjs';
import { meaningfulReply, recordForKey, recordForSelection, renderApp } from '../src/render.mjs';
import { createTheme, paletteAt } from '../src/theme.mjs';
import {
  center, fitTail, padEnd, padStart, truncateMiddle, width as textWidth, wrap,
} from '../src/text.mjs';

const now = 1_000_000;
const palette = paletteAt(0);
const theme = createTheme({ palette, color: false });
const baseUi = {
  runIndex: 0, focus: 'graph', selectedNodeId: 'n', selectedTaskId: undefined,
  follow: false, motion: false, help: false, verbose: false, folded: new Set(),
  graphScroll: 0, graphScrollTarget: 0, manualScroll: false, sidebar: true,
  fps: 12, toasts: [],
};

function synthetic(node = {}, task = {}) {
  return normalizeSnapshot({
    version: 2,
    sessionId: 's',
    connected: true,
    runs: [{
      id: 'r', name: 'Run', status: 'running', createdAt: '2026-11-10T00:00:00Z',
      nodes: [{
        id: 'n', label: 'Focus node', state: 'running', task_id: 'st_n',
        ...node,
      }],
      edges: [],
    }],
    tasks: [{ id: 'st_n', description: 'Focus task', status: 'running', ...task }],
  });
}

function render(snapshot, overrides = {}, { width = 140, height = 60 } = {}) {
  return renderApp(snapshot, { ...baseUi, ...overrides }, {
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

const knownHeadings = [
  'METRICS', 'CONNECTIONS', 'THINKING', 'REPLY', 'ACTIVITY',
  'TOKEN RATE', 'SUBTASKS', 'ERROR', 'RECENT LOG', 'SOURCE',
];
const hasHeading = (lines, heading) => lines.some(line => line.includes(heading));
const content = line => line.slice(1, -1).trim();
function body(lines, heading) {
  const index = headingIndex(lines, heading);
  return lines.slice(index + 1, index + 6).map(content);
}

test('meaningful replies suppress placeholders, echoes, and duplicate context', () => {
  assert.equal(meaningfulReply(undefined), false);
  assert.equal(meaningfulReply('   '), false);
  assert.equal(meaningfulReply('-'), false);
  assert.equal(meaningfulReply('...'), false);
  assert.equal(meaningfulReply('no reply captured'), false);
  assert.equal(meaningfulReply('暂无回复'), false);
  assert.equal(meaningfulReply('ok ok ok'), false);
  assert.equal(meaningfulReply('Plan the work', { thinking: 'Plan the work' }), false);
  assert.equal(meaningfulReply('running typecheck', { progress: 'running typecheck' }), false);
  assert.equal(meaningfulReply('Focus task', { description: 'Focus task' }), false);
  assert.equal(meaningfulReply('Blocked on Focus task. boom failure', {
    description: 'Focus task', error: 'boom failure',
  }), false);
  assert.equal(meaningfulReply('完成 实现 HTTP API', { description: '实现 HTTP API' }), false);
  assert.equal(meaningfulReply('All 14 handler tests pass on Node 22'), true);
  assert.equal(meaningfulReply('修复了并发泄漏'), true);
  assert.equal(meaningfulReply('unique log phrase', { logs: ['unique log phrase'], verbose: false }), true);
  assert.equal(meaningfulReply('unique log phrase', { logs: ['unique log phrase'], verbose: true }), false);
});

test('missing persisted thinking is labelled and never borrows the reply', () => {
  const snapshot = synthetic({
    thinking: undefined,
    reply: 'Implemented pointer-scoped scrolling for the graph, tasks and details.',
    tokenRate: [2, 4, 8, 16],
  });
  const lines = detailsLines(render(snapshot));
  assert.equal(hasHeading(lines, 'THINKING'), true);
  assert.match(lines.join('\n'), /reasoning not captured yet/i);
  assert.equal(hasHeading(lines, 'REPLY'), false);
  assert.doesNotMatch(lines.join('\n'), /Implemented pointer-scoped scrolling/);

  const verbose = detailsLines(render(snapshot, { verbose: true }));
  assert.equal(hasHeading(verbose, 'REPLY'), true);
  assert.match(verbose.join('\n'), /Implemented pointer-scoped scrolling/);
  const thinkingBody = body(verbose, 'THINKING').join('\n');
  assert.doesNotMatch(thinkingBody, /Implemented pointer-scoped scrolling/);

  const duty = detailsLines(render(snapshot, {}, { width: 54, height: 42 }));
  assert.equal(hasHeading(duty, 'TOKEN RATE'), true);
  assert.equal(hasHeading(duty, 'THINKING'), false);
  assert.equal(hasHeading(duty, 'REPLY'), false);
  assert.ok(headingIndex(duty, 'CONNECTIONS') < headingIndex(duty, 'ACTIVITY'));
  assert.match(duty.join('\n'), /RUNNING/);
  assert.match(duty.join('\n'), /st_n/);
  const expanded = detailsLines(render(snapshot, {
    expanded: true, focus: 'details', lastFocus: 'graph', verbose: true,
  }, { width: 54, height: 42 }));
  assert.equal(hasHeading(expanded, 'TOKEN RATE'), true);
  assert.match(expanded.join('\n'), /Implemented pointer-scoped scrolling/);
  const expandedBottom = detailsLines(render(snapshot, {
    expanded: true, focus: 'details', lastFocus: 'graph', verbose: true, detailsScroll: 6,
  }, { width: 54, height: 42 }));
  assert.equal(hasHeading(expandedBottom, 'THINKING'), true);
  assert.doesNotMatch(body(expandedBottom, 'THINKING').join('\n'), /Implemented pointer-scoped scrolling/);
});

test('metrics end immediately before the next section', () => {
  const lines = detailsLines(render(synthetic({ tokenRate: [2, 4, 8, 16] })));
  const start = headingIndex(lines, 'METRICS');
  const end = headingIndex(lines, 'CONNECTIONS');
  assert.ok(end > start + 1, 'metrics has at least one row');
  assert.notEqual(lines[end - 1].replace(/[│\s]/g, ''), '', 'no blank row before the next section');
});

test('node details follow metrics, connections, thinking, activity, reply, and log order', () => {
  const snapshot = synthetic({
    thinking: 'Review the parser edge cases before shipping.',
    reply: 'All 14 handler tests pass on Node 22',
    activity: { phase: 'text', text: 'running typecheck', since: now - 1000, lastAt: now },
    tokenRate: [2, 4, 8, 16],
    children: [{ id: 'c', description: 'Child work', status: 'pending' }],
    error: 'boom failure',
    logs: ['log line alpha', 'log line beta'],
  });

  const compact = detailsLines(render(snapshot));
  const order = ['METRICS', 'TOKEN RATE', 'CONNECTIONS', 'THINKING', 'ACTIVITY', 'SUBTASKS', 'ERROR'];
  for (let index = 1; index < order.length; index++) {
    assert.ok(
      headingIndex(compact, order[index - 1]) < headingIndex(compact, order[index]),
      `${order[index - 1]} must precede ${order[index]}`,
    );
  }
  assert.equal(hasHeading(compact, 'REPLY'), false);
  assert.equal(hasHeading(compact, 'SOURCE'), false);
  assert.equal(hasHeading(compact, 'RECENT LOG'), false);

  const verbose = detailsLines(render(snapshot, { verbose: true }));
  const verboseOrder = ['METRICS', 'TOKEN RATE', 'CONNECTIONS', 'REPLY', 'SOURCE', 'THINKING', 'ACTIVITY'];
  for (let index = 1; index < verboseOrder.length; index++) {
    assert.ok(
      headingIndex(verbose, verboseOrder[index - 1]) < headingIndex(verbose, verboseOrder[index]),
      `${verboseOrder[index - 1]} must precede ${verboseOrder[index]}`,
    );
  }
  assert.ok(headingIndex(verbose, 'ERROR') < headingIndex(verbose, 'RECENT LOG'));
});

test('task details use the same spine without connections', () => {
  const snapshot = synthetic({}, {
    thinking: 'Review the parser edge cases before shipping.',
    reply: 'All 14 handler tests pass on Node 22',
    activity: { phase: 'text', text: 'running typecheck', since: now - 1000, lastAt: now },
    tokenRate: [2, 4, 8, 16],
    children: [{ id: 'c', description: 'Child work', status: 'pending' }],
    logs: ['log line alpha', 'log line beta'],
  });
  const lines = detailsLines(render(snapshot, { focus: 'tasks', selectedTaskId: 'st_n' }));
  assert.ok(hasHeading(lines, 'TASK · st_n'));
  const order = ['METRICS', 'TOKEN RATE', 'THINKING', 'ACTIVITY', 'SUBTASKS'];
  for (let index = 1; index < order.length; index++) {
    assert.ok(
      headingIndex(lines, order[index - 1]) < headingIndex(lines, order[index]),
      `${order[index - 1]} must precede ${order[index]}`,
    );
  }
  assert.equal(hasHeading(lines, 'CONNECTIONS'), false);
  assert.equal(hasHeading(lines, 'REPLY'), false);
  assert.equal(hasHeading(lines, 'SOURCE'), false);
  assert.equal(hasHeading(lines, 'RECENT LOG'), false);
  const verbose = detailsLines(render(snapshot, {
    focus: 'tasks', selectedTaskId: 'st_n', verbose: true,
  }));
  const verboseOrder = ['METRICS', 'TOKEN RATE', 'REPLY', 'SOURCE', 'THINKING', 'ACTIVITY'];
  for (let index = 1; index < verboseOrder.length; index++) {
    assert.ok(
      headingIndex(verbose, verboseOrder[index - 1]) < headingIndex(verbose, verboseOrder[index]),
      `${verboseOrder[index - 1]} must precede ${verboseOrder[index]}`,
    );
  }
  assert.ok(headingIndex(verbose, 'RECENT LOG') > 0);

  const duty = detailsLines(render(snapshot, {
    focus: 'tasks', selectedTaskId: 'st_n', verbose: true,
  }, { width: 54, height: 42 }));
  assert.equal(hasHeading(duty, 'CONNECTIONS'), false);
  assert.equal(hasHeading(duty, 'THINKING'), false);
  assert.equal(hasHeading(duty, 'REPLY'), false);
  assert.equal(hasHeading(duty, 'SOURCE'), false);
  assert.ok(headingIndex(duty, 'TOKEN RATE') < headingIndex(duty, 'ACTIVITY'));
});

test('verbose reply follows connections and is hidden in the default details', () => {
  const thinking = 'Review the parser edge cases before shipping.';
  const snapshot = synthetic({
    thinking,
    reply: 'All 14 handler tests pass on Node 22',
    activity: { phase: 'text', text: 'running typecheck', since: now - 1000, lastAt: now },
    tokenRate: [2, 4, 8, 16],
  });
  const compact = detailsLines(render(snapshot));
  assert.equal(hasHeading(compact, 'REPLY'), false);
  assert.doesNotMatch(compact.join('\n'), /All 14 handler tests pass on Node 22/);
  assert.ok(headingIndex(compact, 'CONNECTIONS') < headingIndex(compact, 'THINKING'));

  const meaningful = detailsLines(render(snapshot, { verbose: true }));
  const reply = headingIndex(meaningful, 'REPLY');
  const thinkingIndex = headingIndex(meaningful, 'THINKING');
  assert.ok(headingIndex(meaningful, 'CONNECTIONS') < reply, 'REPLY must follow CONNECTIONS');
  assert.ok(reply < headingIndex(meaningful, 'SOURCE'), 'SOURCE must follow REPLY');
  assert.ok(headingIndex(meaningful, 'SOURCE') < thinkingIndex, 'SOURCE must precede THINKING');
  assert.match(meaningful.slice(reply + 1, reply + 2).join('\n'), /All 14 handler tests pass on Node 22/);

  for (const suppressed of [undefined, '   ', 'no reply captured', thinking]) {
    const lines = detailsLines(render(synthetic({
      thinking,
      reply: suppressed,
      activity: { phase: 'text', text: 'running typecheck', since: now - 1000, lastAt: now },
      tokenRate: [2, 4, 8, 16],
    }), { verbose: true }));
    assert.equal(hasHeading(lines, 'REPLY'), false);
    assert.ok(headingIndex(lines, 'CONNECTIONS') < headingIndex(lines, 'THINKING'));
  }
});

test('duplicate or empty replies are suppressed without placeholders', () => {
  const thinking = 'Review the parser edge cases before shipping.';
  for (const reply of [thinking, undefined, '   ', 'no reply captured']) {
    const lines = detailsLines(render(synthetic({
      thinking,
      reply,
      activity: { phase: 'text', text: 'running typecheck', since: now - 1000, lastAt: now },
    })));
    assert.equal(hasHeading(lines, 'REPLY'), false);
    assert.doesNotMatch(lines.join('\n'), /no reply captured/i);
    assert.match(lines.join('\n'), /THINKING/);
  }

  const snapshot = synthetic({
    thinking,
    reply: 'All 14 handler tests pass on Node 22',
    activity: { phase: 'text', text: 'running typecheck', since: now - 1000, lastAt: now },
  });
  assert.equal(hasHeading(detailsLines(render(snapshot)), 'REPLY'), false);
  const novel = detailsLines(render(snapshot, { verbose: true }));
  assert.equal(hasHeading(novel, 'REPLY'), true);
  assert.equal(novel.join('\n').split('All 14 handler tests pass on Node 22').length - 1, 1);

  const chinese = render(synthetic({
    thinking: '检查解析器边界条件。',
    reply: '暂无回复',
    activity: { phase: 'text', text: '运行类型检查', since: now - 1000, lastAt: now },
  }), { language: 'zh' });
  assert.doesNotMatch(chinese.text, /暂无回复/);
});

test('thinking renders exactly five rows with tail truncation and blank padding', () => {
  const longThinking = Array.from({ length: 14 }, (_, index) =>
    `reasoning line ${index + 1} with enough words to wrap`).join(' ');
  const snapshot = synthetic({
    thinking: longThinking,
    reply: 'All 14 handler tests pass on Node 22',
    activity: { phase: 'text', text: 'running typecheck', since: now - 1000, lastAt: now },
    tokenRate: [2, 4, 8, 16],
  });
  const result = render(snapshot, { verbose: true });
  const lines = detailsLines(result);
  const width = result.layout.details.w - 6;
  const expected = wrap(longThinking, width).slice(-5).map(line => line.trim());
  assert.ok(wrap(longThinking, width).length > 5);
  assert.deepEqual(body(lines, 'THINKING'), expected);
  assert.ok(!lines.join('\n').includes(wrap(longThinking, width)[0]));
  assert.ok(headingIndex(lines, 'REPLY') < headingIndex(lines, 'THINKING'));
  assert.ok(headingIndex(lines, 'SOURCE') < headingIndex(lines, 'THINKING'));
  assert.equal(headingIndex(lines, 'THINKING') + 6, headingIndex(lines, 'ACTIVITY'));

  const short = detailsLines(render(synthetic({
    thinking: 'One line of reasoning.',
    activity: { phase: 'text', text: 'running typecheck', since: now - 1000, lastAt: now },
  })));
  assert.deepEqual(body(short, 'THINKING'), ['One line of reasoning.', '', '', '', '']);
});

test('activity renders a summary plus four tail-truncated detail rows', () => {
  const longActivity = Array.from({ length: 10 }, (_, index) =>
    `activity detail ${index + 1} with more words`).join(' ');
  const snapshot = synthetic({
    thinking: 'Review the parser edge cases before shipping.',
    reply: 'All 14 handler tests pass on Node 22',
    activity: { phase: 'text', text: longActivity, since: now - 1000, lastAt: now },
    tokenRate: [2, 4, 8, 16],
  });
  const result = render(snapshot);
  const lines = detailsLines(result);
  const width = result.layout.details.w - 6;
  const expected = wrap(longActivity, width).slice(-4).map(line => line.trim());
  assert.ok(wrap(longActivity, width).length > 4);
  const rows = body(lines, 'ACTIVITY');
  assert.ok(rows[0].length > 0, 'the first row is the activity summary');
  assert.deepEqual(rows.slice(1), expected);
  assert.ok(headingIndex(lines, 'TOKEN RATE') < headingIndex(lines, 'ACTIVITY'));
  assert.ok(!lines.join('\n').includes(wrap(longActivity, width)[0]));

  const empty = detailsLines(render(synthetic({ thinking: 'One line of reasoning.' })));
  const emptyRows = body(empty, 'ACTIVITY');
  assert.match(emptyRows[0], /waiting for first event/i);
  assert.deepEqual(emptyRows.slice(1), ['', '', '', '']);
});

test('token rate stays visible in compact detail heights', () => {
  const lines = detailsLines(render(synthetic({ tokenRate: [2, 4, 8, 16] }), {}, { width: 120, height: 32 }));
  assert.equal(hasHeading(lines, 'TOKEN RATE'), true);
  assert.match(lines.join('\n'), /[▁▂▃▄▅▆▇█]{4}/);
});

test('fixed sections are atomic across short panel heights', () => {
  const snapshot = synthetic({
    thinking: 'Review the parser edge cases before shipping.',
    reply: 'All 14 handler tests pass on Node 22',
    activity: { phase: 'text', text: 'running typecheck', since: now - 1000, lastAt: now },
    tokenRate: [2, 4, 8, 16],
  });
  for (let height = 24; height <= 50; height++) {
    const lines = detailsLines(render(snapshot, {}, { height }));
    for (const heading of ['THINKING', 'ACTIVITY']) {
      if (!hasHeading(lines, heading)) continue;
      const index = headingIndex(lines, heading);
      assert.ok(index + 6 <= lines.length, `${heading} body fits at height ${height}`);
      const next = lines.slice(index + 1, index + 6).join('\n');
      for (const other of knownHeadings) {
        assert.ok(!next.includes(other), `${heading} partial block before ${other} at height ${height}`);
      }
    }
  }
});

test('a connected-empty duty body names the real state and fabricates no subject fields', () => {
  const empty = normalizeSnapshot({
    version: 3, mode: 'live', connected: true, sessionId: 'empty',
    provenance: {
      origin: 'controller', statePath: '/tmp/herdr-dag/state.json',
      capturedAt: new Date(now - 3000).toISOString(),
    },
    sources: [{
      id: 'store', label: 'repo store', root: '/tmp/senorepo', status: 'ok',
      tasks: { files: 1, accepted: 1, foreign: 0, invalid: 0 },
      runs: { files: 0, accepted: 0, foreign: 0, invalid: 0 },
      scannedAt: new Date(now - 2000).toISOString(),
    }],
    runs: [], tasks: [],
  });
  for (const [width, height] of [[54, 42], [120, 40]]) {
    const text = render(empty, { selectedNodeId: undefined, selectedTaskId: undefined }, { width, height }).text;
    assert.match(text, /CONNECTED · NO WORKFLOW YET/, `connected empty at ${width}`);
    assert.match(text, /state\.json/, `watched path at ${width}`);
    assert.match(text, /captured 3s ago/, `capture age at ${width}`);
    assert.match(text, /next:/i, `next step at ${width}`);
    assert.doesNotMatch(text, /attempt 1/, `no fabricated attempt at ${width}`);
    assert.doesNotMatch(text, /percent not recorded/, `no fabricated percent at ${width}`);
    assert.doesNotMatch(text, /error none recorded/, `no fabricated error at ${width}`);
    assert.doesNotMatch(text, /agent not recorded/, `no fabricated agent at ${width}`);
    assert.doesNotMatch(text, /Waiting for a workflow snapshot/, `no waiting copy at ${width}`);
  }
});

test('stale duty elapsed is pinned to capturedAt at 54 columns', () => {
  const captured = now - 8 * 3600_000;
  const snap = normalizeSnapshot({
    version: 3, mode: 'live', connected: true, sessionId: 'stale-duty',
    provenance: {
      origin: 'controller', statePath: '/tmp/herdr-dag/state.json',
      capturedAt: new Date(captured).toISOString(),
    },
    runs: [{
      id: 'r', name: 'Run', status: 'running', createdAt: new Date(captured - 60_000).toISOString(),
      nodes: [{
        id: 'n', label: 'Focus node', state: 'running', task_id: 'st_n',
        startedAt: new Date(captured - 60_000).toISOString(),
      }],
      edges: [],
    }],
    tasks: [{
      id: 'st_n', description: 'Focus task', status: 'running',
      startedAt: new Date(captured - 60_000).toISOString(),
    }],
  });
  const first = render(snap, {}, { width: 54, height: 42 });
  assert.match(first.text, /▲ STALE/);
  assert.match(first.text, /00:01:00/);
  const later = renderApp(snap, baseUi, {
    width: 54, height: 42, time: 0, now: now + 120_000, palette, theme,
  });
  assert.match(later.text, /00:01:00/);
  assert.doesNotMatch(later.text, /00:02:00|00:03:00/);
});

// ---- F-33 / F-34: one record resolver for the hint, the display, and `o` ----

function recordStore() {
  const root = mkdtempSync(join(tmpdir(), 'herdr-detail-record-'));
  mkdirSync(join(root, 'tasks'), { recursive: true });
  mkdirSync(join(root, 'dag', 'runs'), { recursive: true });
  writeFileSync(join(root, 'state.json'), '{}');
  return root;
}

function recordSnapshot(root, {
  task = {}, sources, oversizedTask = false, taskFile = true, checkpoint = false, withProvenance = true,
} = {}) {
  if (taskFile) {
    writeFileSync(join(root, 'tasks', 'st_n.json'),
      oversizedTask ? 'x'.repeat(4 * 1024 * 1024 + 1) : '{"task":true}');
  }
  if (checkpoint) writeFileSync(join(root, 'dag', 'runs', 'r.json'), '{"checkpoint":true}');
  return normalizeSnapshot({
    version: 3,
    mode: 'live',
    sessionId: 'record-session',
    connected: true,
    updatedAt: '2026-11-10T00:00:00Z',
    provenance: withProvenance
      ? {
        origin: 'controller',
        taskStateDir: root,
        statePath: join(root, 'state.json'),
        capturedAt: new Date(now).toISOString(),
      }
      : undefined,
    ...(sources ? { sources } : {}),
    runs: [{
      id: 'r', name: 'Run', status: 'failed', createdAt: '2026-11-10T00:00:00Z',
      nodes: [{ id: 'n', label: 'Focus node', state: 'failed', task_id: 'st_n' }],
      edges: [],
    }],
    tasks: [{
      id: 'st_n', description: 'Focus task', status: 'failed',
      error_message: 'boom failure', ...task,
    }],
  });
}

test('the diagnosis action hint follows the same record gates as the open action', () => {
  const primary = recordStore();
  try {
    // An oversized task record passes safeFileWithin (diagnosis.openPath) but
    // not the 4 MiB cap that recordForKey enforces.
    const oversized = recordSnapshot(primary, { oversizedTask: true });
    const oversizedUi = { ...baseUi, focus: 'tasks', selectedTaskId: 'st_n' };
    const oversizedFrame = render(oversized, oversizedUi);
    assert.match(oversizedFrame.text, /c copy · p path · o unavailable/);
    assert.doesNotMatch(oversizedFrame.text, /o open/);
    const oversizedRecord = recordForSelection(oversized, oversizedUi);
    assert.equal(oversizedRecord.openPath, undefined);
    assert.deepEqual(recordForKey('o', oversizedRecord), { kind: 'unavailable', reason: 'no-safe-record' });
  } finally {
    rmSync(primary, { recursive: true, force: true });
  }

  // A task stored in a secondary source resolves through that source's root;
  // the hint must advertise the open that the action can actually perform.
  const provenanceRoot = recordStore();
  const secondaryRoot = mkdtempSync(join(tmpdir(), 'herdr-detail-host-'));
  try {
    mkdirSync(join(secondaryRoot, 'tasks'), { recursive: true });
    writeFileSync(join(secondaryRoot, 'tasks', 'st_n.json'), '{"host":true}');
    const secondary = recordSnapshot(provenanceRoot, {
      taskFile: false,
      sources: [{ id: 'host', label: 'host store', root: secondaryRoot, status: 'ok' }],
      task: { source: 'host' },
    });
    const secondaryUi = { ...baseUi, focus: 'tasks', selectedTaskId: 'st_n' };
    const secondaryFrame = render(secondary, secondaryUi);
    assert.match(secondaryFrame.text, /c copy · p path · o open/);
    assert.doesNotMatch(secondaryFrame.text, /o unavailable/);
    assert.match(secondaryFrame.text, /tasks\/st_n\.json/);
    const secondaryRecord = recordForSelection(secondary, secondaryUi);
    assert.equal(secondaryRecord.openPath, join(secondaryRoot, 'tasks', 'st_n.json'));
    assert.equal(secondaryRecord.openKey, 'task');
    assert.deepEqual(recordForKey('o', secondaryRecord), {
      kind: 'open', path: join(secondaryRoot, 'tasks', 'st_n.json'),
    });
  } finally {
    rmSync(provenanceRoot, { recursive: true, force: true });
    rmSync(secondaryRoot, { recursive: true, force: true });
  }

  // With no provenance root, diagnosis has no copyable paths, but the source
  // root still makes the record openable. The hint follows the open action.
  const anchor = recordStore();
  const hostRoot = mkdtempSync(join(tmpdir(), 'herdr-detail-host-bare-'));
  try {
    mkdirSync(join(hostRoot, 'tasks'), { recursive: true });
    writeFileSync(join(hostRoot, 'tasks', 'st_n.json'), '{"host":true}');
    const bare = recordSnapshot(anchor, {
      withProvenance: false,
      taskFile: false,
      sources: [{ id: 'host', label: 'host store', root: hostRoot, status: 'ok' }],
      task: { source: 'host' },
    });
    const bareUi = { ...baseUi, focus: 'tasks', selectedTaskId: 'st_n' };
    const bareFrame = render(bare, bareUi);
    assert.match(bareFrame.text, /o open/);
    assert.doesNotMatch(bareFrame.text, /p\/o unavailable/);
    assert.equal(recordForSelection(bare, bareUi).openPath, join(hostRoot, 'tasks', 'st_n.json'));
  } finally {
    rmSync(anchor, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('a checkpoint fallback never claims to hold the full reply record', () => {
  const root = recordStore();
  try {
    const snapshot = recordSnapshot(root, {
      oversizedTask: true,
      checkpoint: true,
      task: { reply: 'x'.repeat(1300), replyBytes: 9000, replyTruncated: true },
    });
    const ui = { ...baseUi, focus: 'tasks', selectedTaskId: 'st_n', verbose: true };
    const frame = render(snapshot, ui, { width: 140, height: 90 });
    assert.match(frame.text, /truncated · 9000 B total/);
    assert.doesNotMatch(frame.text, /o open · full record/);
    assert.match(frame.text, /o unavailable · record not readable/);
    assert.equal(recordForSelection(snapshot, ui).openKey, 'checkpoint');
    assert.deepEqual(recordForKey('o', recordForSelection(snapshot, ui)), {
      kind: 'open', path: join(root, 'dag', 'runs', 'r.json'),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // A readable task record is still advertised as the full reply source.
  const readableRoot = recordStore();
  try {
    const snapshot = recordSnapshot(readableRoot, {
      task: { reply: 'x'.repeat(1300), replyBytes: 9000, replyTruncated: true },
    });
    const ui = { ...baseUi, focus: 'tasks', selectedTaskId: 'st_n', verbose: true };
    const frame = render(snapshot, ui, { width: 140, height: 90 });
    assert.match(frame.text, /o open · full record/);
    assert.equal(recordForSelection(snapshot, ui).openKey, 'task');
  } finally {
    rmSync(readableRoot, { recursive: true, force: true });
  }
});

// ---- F-35 / F-36: per-snapshot resolution and scratch canvas reuse ----

test('record resolution is memoized for a snapshot while the open action revalidates', () => {
  const root = recordStore();
  try {
    const raw = {
      version: 3,
      mode: 'live',
      sessionId: 'memo-session',
      connected: true,
      updatedAt: '2026-11-10T00:00:00Z',
      provenance: {
        origin: 'controller',
        taskStateDir: root,
        statePath: join(root, 'state.json'),
        capturedAt: new Date(now).toISOString(),
      },
      runs: [{
        id: 'r', name: 'Run', status: 'failed', createdAt: '2026-11-10T00:00:00Z',
        nodes: [{ id: 'n', label: 'Focus node', state: 'failed', task_id: 'st_n' }],
        edges: [],
      }],
      tasks: [{ id: 'st_n', description: 'Focus task', status: 'failed', error_message: 'boom' }],
    };
    const ui = { ...baseUi, focus: 'tasks', selectedTaskId: 'st_n' };
    const snapshot = normalizeSnapshot(raw);
    writeFileSync(join(root, 'tasks', 'st_n.json'), '{"task":true}');
    const first = render(snapshot, ui);
    assert.match(first.text, /c copy · p path · o open/);

    // The same snapshot object is painted many times per accepted read. A
    // deleted record must not be re-stat'ed for every frame; a new snapshot
    // invalidates the resolution and the hint then reports the truth.
    unlinkSync(join(root, 'tasks', 'st_n.json'));
    const second = render(snapshot, ui);
    assert.equal(second.text, first.text);
    assert.match(second.text, /c copy · p path · o open/);
    assert.deepEqual(recordForKey('o', recordForSelection(snapshot, ui)), {
      kind: 'unavailable', reason: 'no-safe-record',
    });

    const refreshed = normalizeSnapshot(raw);
    const refreshedFrame = render(refreshed, ui);
    assert.match(refreshedFrame.text, /o unavailable/);
    assert.doesNotMatch(refreshedFrame.text, /o open/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repeated details frames reuse their scratch canvases without leaking content', () => {
  const snapshot = synthetic({
    thinking: 'Review the parser edge cases before shipping.',
    reply: 'All 14 handler tests pass on Node 22',
    activity: { phase: 'text', text: 'running typecheck', since: now - 1000, lastAt: now },
    tokenRate: [2, 4, 8, 16],
  }, {
    thinking: 'Review the parser edge cases before shipping.',
    reply: 'All 14 handler tests pass on Node 22',
    activity: { phase: 'text', text: 'running typecheck', since: now - 1000, lastAt: now },
    tokenRate: [2, 4, 8, 16],
  });
  const ui = { ...baseUi, focus: 'tasks', selectedTaskId: 'st_n', verbose: true };
  const first = render(snapshot, ui);
  const second = render(snapshot, ui);
  assert.equal(second.text, first.text);
  assert.equal(second.scroll.details.contentH, first.scroll.details.contentH);

  // A different size allocates another scratch grid and repaints it. Returning
  // to the first size must reproduce the first frame exactly, proving the
  // reused grid is cleared rather than blitted with stale cells.
  render(snapshot, ui, { width: 100, height: 40 });
  const returned = render(snapshot, ui);
  assert.equal(returned.text, first.text);
  assert.equal(returned.scroll.details.contentH, first.scroll.details.contentH);
  for (const line of returned.text.split('\n')) assert.equal(textWidth(line), 140);
});

// ---- F-76: literal display-width oracles for the text engine ----

test('wrap breaks at display width with literal rows for wide and combining glyphs', () => {
  const cases = [
    ['hello world', 5, ['hello', 'world']],
    ['abcdefgh', 4, ['abcd', 'efgh']],
    ['你好世界', 4, ['你好', '世界']],
    ['👩👩👧', 3, ['👩', '👩', '👧']],
    ['e\u0301e\u0301e\u0301', 2, ['e\u0301e\u0301', 'e\u0301']],
    ['♥\uFE0F!', 2, ['♥\uFE0F', '!']],
  ];
  for (const [input, columns, expected] of cases) {
    assert.deepEqual(wrap(input, columns), expected, `${JSON.stringify(input)} at ${columns}`);
    for (const row of wrap(input, columns)) assert.ok(textWidth(row) <= columns);
  }
});

test('truncateMiddle and fitTail keep literal head and tail rows at fixed widths', () => {
  const middle = [
    ['abcdef', 6, 'abcdef'],
    ['abcdef', 5, 'ab…ef'],
    ['abcdef', 4, 'a…ef'],
    ['abcdef', 3, '…'],
    ['abcdef', 2, '…'],
    ['abcdef', 0, ''],
    ['你好世界', 5, '你…界'],
  ];
  for (const [input, columns, expected] of middle) {
    assert.equal(truncateMiddle(input, columns), expected, `truncateMiddle ${input} at ${columns}`);
    assert.ok(textWidth(truncateMiddle(input, columns)) <= columns);
  }
  const tail = [
    ['abcdef', 5, '…cdef'],
    ['abcdef', 6, 'abcdef'],
    ['你好世界', 4, '…界'],
    ['abc', 0, ''],
  ];
  for (const [input, columns, expected] of tail) {
    assert.equal(fitTail(input, columns), expected, `fitTail ${input} at ${columns}`);
    assert.ok(textWidth(fitTail(input, columns)) <= columns);
  }
});

test('pad and center fill exactly the requested display columns', () => {
  assert.equal(padEnd('ab', 4), 'ab  ');
  assert.equal(padStart('ab', 4), '  ab');
  assert.equal(center('ab', 5), ' ab  ');
  assert.equal(padEnd('你', 4), '你  ');
  assert.equal(center('你', 5), ' 你  ');
  for (const [value, columns] of [['ab', 4], ['你', 4], ['你', 5]]) {
    for (const output of [padEnd(value, columns), padStart(value, columns), center(value, columns)]) {
      assert.equal(textWidth(output), columns);
    }
  }
});

test('canvas rows keep display width when wide glyphs are overwritten or clipped', () => {
  const canvas = new Canvas(8, 2, { fg: '#ffffff', bg: '#000000' });
  canvas.fill(0, 0, 8, 2, { fg: '#ffffff', bg: '#000000' });
  canvas.put(1, 0, '你', { fg: '#ff0000' });
  assert.equal(canvas.cell(1, 0).width, 2);
  assert.equal(canvas.cell(2, 0).cont, true);
  for (const line of canvas.toString(theme).split('\n')) assert.equal(textWidth(line), 8);

  // Overwriting the continuation cell clears the orphaned head and the row
  // still measures the full canvas width.
  canvas.put(2, 0, 'x');
  assert.equal(canvas.cell(1, 0).ch, ' ');
  assert.equal(canvas.cell(1, 0).width, 1);
  assert.equal(canvas.cell(2, 0).cont, false);
  assert.equal(canvas.cell(2, 0).ch, 'x');

  // A two-cell glyph cannot start in the last column.
  canvas.put(7, 0, '你');
  assert.equal(canvas.cell(7, 0).ch, ' ');

  // Filling across a wide glyph removes both halves.
  canvas.put(0, 1, '你好');
  canvas.fill(1, 1, 1, 1, { fg: '#ffffff', bg: '#000000' });
  assert.equal(canvas.cell(0, 1).ch, ' ');
  assert.equal(canvas.cell(0, 1).width, 1);
  for (const line of canvas.toString(theme).split('\n')) assert.equal(textWidth(line), 8);
});

// ---- F-125: a timestamp-less history owns no time axis ----

// F-126 deleted the unreachable single/zero-sample axis branches. Their labels
// stay part of the message table until the i18n cleanup can remove them.
test('legacy single-sample rate labels remain available', () => {
  assert.equal(t('en', 'rateSingleSample'), '1 sample');
  assert.equal(t('en', 'rateCollecting'), 'collecting');
});

test('a timestamp-less rate history leaves the time-axis slot blank', () => {
  const snapshot = synthetic({}, {
    tokenRate: [2, 4, 8, 16],
    tokenRateKind: 'history',
    tokenRateHistory: [{ rate: 2 }, { rate: 4 }, { rate: 8 }, { rate: 16 }],
  });
  const frame = render(snapshot, { focus: 'tasks', selectedTaskId: 'st_n' });
  const lines = detailsLines(frame);
  const index = lines.findIndex(candidate => candidate.includes('TOKEN RATE'));
  assert.ok(index >= 0, 'TOKEN RATE row is present');
  const line = lines[index];
  const block = lines.slice(index, index + 2).join('\n');
  assert.match(line, /\(history\)/);
  assert.match(block, /peak 16\/s/);
  assert.doesNotMatch(block, /\d+ pts/, 'a sample count is not a time axis');
  assert.doesNotMatch(block, /-\d+s/, 'no timestamp span is invented');
});

// ---- F-129: diagnosis parts keep their own styles ----

test('status mismatch and mode keep their distinct styles in fitting and wrapped rows', () => {
  const snapshot = synthetic({ state: 'running' }, { status: 'failed' });
  for (const width of [140, 66]) {
    const result = render(snapshot, {
      ...baseUi, expanded: true, focus: 'tasks', selectedTaskId: 'st_n',
    }, { width, height: 60 });
    const lines = detailsLines(result);
    const row = lines.findIndex(line => line.includes('MISMATCH'));
    assert.ok(row >= 0, `MISMATCH row at width ${width}`);
    const column = lines[row].indexOf('MISMATCH');
    const mismatch = result.canvas.cells[result.layout.details.y + row][result.layout.details.x + column];
    assert.equal(mismatch.fg, palette.warn, `mismatch warning tone at width ${width}`);
    assert.ok(mismatch.flags & 1, `mismatch stays bold at width ${width}`);

    const modeColumn = lines[row].indexOf('LIVE');
    assert.ok(modeColumn > column, `mode follows mismatch at width ${width}`);
    const mode = result.canvas.cells[result.layout.details.y + row][result.layout.details.x + modeColumn];
    assert.ok(mode.flags & 2, `mode stays dim at width ${width}`);
  }
});
