import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, watch, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pagerCommand } from '../src/clipboard.mjs';
import { safeFileWithin } from '../src/safe-path.mjs';
import { normalizeSnapshot } from '../src/model.mjs';
import { recordForKey } from '../src/records.mjs';
import { detailsSubjectKey, diagnosisForSelection, recordForSelection, renderApp } from '../src/render.mjs';
import { createTheme, paletteAt } from '../src/theme.mjs';
import { terminalRestoreSequence } from '../src/viewer.mjs';

const now = 1_000_000;
const palette = paletteAt(0);
const theme = createTheme({ palette, color: false });
const baseUi = {
  runIndex: 0, focus: 'tasks', lastFocus: 'tasks',
  selectedNodeId: 'done', selectedTaskId: 'st_done',
  follow: false, motion: false, help: false, verbose: false, folded: new Set(),
  graphScroll: 0, graphScrollTarget: 0, manualScroll: false, sidebar: true,
  language: 'en', fps: 12, toasts: [],
};

// The task record, not the snapshot, carries the complete 3373-character
// response. The viewer model may only keep its 1200-character excerpt.
const FULL_RESPONSE = (`FULL-RECORD-START ${'the complete final response survives only in the raw task record. '.repeat(80)}`)
  .padEnd(3373, 'z')
  .slice(0, 3373);

function recordJson({ finalResponse = FULL_RESPONSE } = {}) {
  return JSON.stringify({
    task_id: 'st_done',
    status: 'completed',
    description: 'Completed release task',
    final_response: finalResponse,
  }, null, 2);
}

function fixture({ root, task = {}, node = {}, run = {}, mode = 'live', sources } = {}) {
  return normalizeSnapshot({
    version: 3,
    sessionId: 'full-record-session',
    mode,
    connected: mode !== 'saved',
    updatedAt: '2026-11-10T06:05:00Z',
    sources,
    provenance: root ? {
      origin: 'controller',
      statePath: join(root, 'snapshot.json'),
      taskStateDir: root,
      capturedAt: '2026-11-10T06:05:00Z',
    } : undefined,
    runs: [{
      id: 'dag_done',
      name: 'Completed run',
      status: 'completed',
      createdAt: '2026-11-10T05:00:00Z',
      updatedAt: '2026-11-10T06:00:00Z',
      nodes: [{
        id: 'done', label: 'Ship release', state: 'completed', task_id: 'st_done',
        attempt: 1, completed_at: '2026-11-10T06:00:00Z',
        ...node,
      }],
      edges: [],
      ...run,
    }],
    tasks: [{
      id: 'st_done',
      description: 'Completed release task',
      status: 'completed',
      agent: 'forge',
      model: 'crs/deepseek-v4.1-flash',
      started_at: '2026-11-10T05:40:00Z',
      completed_at: '2026-11-10T06:00:00Z',
      final_response: FULL_RESPONSE,
      run_stats: { turns: 12, tool_calls: 18 },
      ...task,
    }],
  });
}

function makeStore({ withRecord = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dag-full-record-'));
  mkdirSync(join(root, 'tasks'), { recursive: true });
  mkdirSync(join(root, 'dag', 'runs'), { recursive: true });
  if (withRecord) writeFileSync(join(root, 'tasks', 'st_done.json'), recordJson());
  writeFileSync(join(root, 'dag', 'runs', 'dag_done.json'), '{}');
  writeFileSync(join(root, 'snapshot.json'), '{}');
  return root;
}

function render(snapshot, overrides = {}, { width = 160, height = 120 } = {}) {
  return renderApp(snapshot, { ...baseUi, ...overrides }, {
    width, height, time: 0, now, palette, theme,
  });
}

function fakePager(root, { capture } = {}) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'less');
  // The capture path appears atomically through rename, so a test can wait on
  // the directory event instead of polling for a partially written file.
  writeFileSync(script, capture
    ? `#!/bin/sh\n/bin/cp "$1" ${JSON.stringify(`${capture}.tmp`)} && mv ${JSON.stringify(`${capture}.tmp`)} ${JSON.stringify(capture)}\n`
    : '#!/bin/sh\nexec /bin/cat "$@"\n');
  chmodSync(script, 0o755);
  return { ...process.env, PAGER: 'less', PATH: `${bin}:${process.env.PATH ?? ''}` };
}

// Race a promise against a bounded deadline and clear the losing timer so a
// passing frame does not leave an 8s timer holding the test process open.
function within(promise, ms, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Wait for the pager's atomic rename to publish a parseable capture. The file
// event is the signal; the timeout only bounds a broken child.
function waitForJsonFile(path, timeoutMs) {
  return new Promise((resolve, reject) => {
    let watcher;
    let timer;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { watcher?.close(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(value);
    };
    const check = () => {
      try {
        finish(null, JSON.parse(readFileSync(path, 'utf8')));
        return true;
      } catch {
        return false;
      }
    };
    timer = setTimeout(() => finish(new Error(`timed out waiting for ${basename(path)}`)), timeoutMs);
    try {
      watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
        if (!filename || filename === basename(path)) check();
      });
      watcher.on('error', error => finish(error));
    } catch (error) {
      finish(error);
      return;
    }
    check();
  });
}

function writeViewerState(root) {
  const snapshot = fixture({ root });
  const statePath = join(root, 'snapshot.json');
  writeFileSync(statePath, JSON.stringify(snapshot));
  return statePath;
}

function startViewer(root) {
  const statePath = writeViewerState(root);
  const env = { ...process.env, NERO_HERDR_DAG_CONFIG_DIR: join(root, 'config') };
  let output = '';
  let painted;
  const firstFrame = new Promise(resolve => { painted = resolve; });
  const proc = Bun.spawn([
    process.execPath, 'src/viewer.mjs', '--state', statePath, '--no-color', '--no-motion',
  ], {
    cwd: process.cwd(),
    env,
    terminal: {
      cols: 120,
      rows: 40,
      data(_term, chunk) {
        output += new TextDecoder().decode(chunk);
        if (output.includes('METRICS')) painted();
      },
    },
  });
  return { proc, firstFrame, get output() { return output; } };
}

// Two runs so a focused task's linked run differs from the clamped run index.
// The focus/lastFocus combinations below all resolve the same subject for
// painting, details reset, and record actions.
function selectionFixture() {
  return normalizeSnapshot({
    version: 3,
    sessionId: 'selection-session',
    mode: 'live',
    connected: true,
    updatedAt: '2026-11-10T06:05:00Z',
    runs: [
      {
        id: 'dag_selected', name: 'Selected run', status: 'completed',
        createdAt: '2026-11-10T05:00:00Z', updatedAt: '2026-11-10T06:00:00Z',
        nodes: [{ id: 'other', label: 'Other node', state: 'completed', task_id: 'st_other', attempt: 1 }],
        edges: [],
      },
      {
        id: 'dag_linked', name: 'Linked run', status: 'running',
        createdAt: '2026-11-10T04:00:00Z', updatedAt: '2026-11-10T06:00:00Z',
        nodes: [{ id: 'linked', label: 'Linked node', state: 'running', task_id: 'st_focus', attempt: 1 }],
        edges: [],
      },
    ],
    tasks: [
      { id: 'st_focus', description: 'Focus task', status: 'running' },
      { id: 'st_other', description: 'Other task', status: 'completed' },
    ],
  });
}

test('a completed task opens the raw record and reads the full 3373-character final_response', t => {
  const root = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = fixture({ root });
  const task = snapshot.tasks[0];

  // No copy leaked into the snapshot: only the bounded excerpt and its size.
  assert.equal(FULL_RESPONSE.length, 3373);
  assert.equal(task.final_response, undefined);
  assert.equal(task.reply.length, 1200);
  assert.equal(task.replyBytes, 3373);
  assert.equal(task.replyTruncated, true);
  assert.equal(task.replySource, 'final_response');
  assert.equal(JSON.stringify(snapshot).includes(FULL_RESPONSE), false);

  const record = recordForSelection(snapshot, baseUi);
  assert.equal(record.kind, 'task');
  assert.equal(record.state, 'completed');
  assert.match(record.openPath, /tasks\/st_done\.json$/);
  const action = recordForKey('o', record);
  assert.equal(action.kind, 'open');
  assert.equal(action.path, record.openPath);

  const env = fakePager(root);
  const pager = pagerCommand(env);
  assert.equal(pager.command, 'less');
  const opened = spawnSync(pager.command, [...pager.args, action.path], { env, encoding: 'utf8' });
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stdout, /final_response/);
  assert.ok(opened.stdout.includes(FULL_RESPONSE), 'the pager output carries the whole response');
  const parsed = JSON.parse(opened.stdout);
  assert.equal(parsed.final_response, FULL_RESPONSE);
  assert.equal(parsed.final_response.length, 3373);
  assert.equal(readFileSync(join(root, 'tasks', 'st_done.json'), 'utf8'), recordJson());
});

test('a completed task sourced from the host store opens that root, not the primary repo root', t => {
  const host = makeStore();
  const repo = mkdtempSync(join(tmpdir(), 'dag-full-record-repo-'));
  t.after(() => {
    rmSync(host, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });
  mkdirSync(join(repo, 'tasks'), { recursive: true });
  mkdirSync(join(repo, 'dag', 'runs'), { recursive: true });
  writeFileSync(join(repo, 'tasks', 'st_done.json'), recordJson({ finalResponse: 'REPO-DECOY' }));
  writeFileSync(join(repo, 'dag', 'runs', 'dag_done.json'), '{}');

  const snapshot = fixture({
    root: repo,
    sources: [
      {
        id: 'repo-store', label: 'repo store', origin: 'in-project', root: repo, status: 'ok',
        tasks: { files: 1, accepted: 1, foreign: 0, invalid: 0 },
        runs: { files: 1, accepted: 1, foreign: 0, invalid: 0 },
      },
      {
        id: 'host-store', label: 'host store', origin: 'agent-project', root: host, status: 'ok',
        tasks: { files: 1, accepted: 1, foreign: 0, invalid: 0 },
        runs: { files: 1, accepted: 1, foreign: 0, invalid: 0 },
      },
    ],
    task: { source: 'host-store' },
    run: { source: 'host-store' },
  });

  const record = recordForSelection(snapshot, baseUi);
  const taskRecord = record.records.find(entry => entry.key === 'task');
  const checkpoint = record.records.find(entry => entry.key === 'checkpoint');
  assert.equal(taskRecord.root, host);
  assert.equal(checkpoint.root, host);
  assert.match(record.openPath, /tasks\/st_done\.json$/);

  const action = recordForKey('o', record);
  assert.equal(action.kind, 'open');
  const env = fakePager(host);
  const pager = pagerCommand(env);
  const opened = spawnSync(pager.command, [...pager.args, action.path], { env, encoding: 'utf8' });
  assert.equal(opened.status, 0, opened.stderr);
  const parsed = JSON.parse(opened.stdout);
  assert.equal(parsed.final_response, FULL_RESPONSE);
  assert.equal(parsed.final_response.length, 3373);
  assert.doesNotMatch(opened.stdout, /REPO-DECOY/);

  // Task and run roots are matched independently: a host task keeps its host
  // record while a repo-sourced run keeps its repo checkpoint.
  const split = fixture({
    root: repo,
    sources: [
      { id: 'repo-store', label: 'repo store', origin: 'in-project', root: repo, status: 'ok' },
      { id: 'host-store', label: 'host store', origin: 'agent-project', root: host, status: 'ok' },
    ],
    task: { source: 'host-store' },
    run: { source: 'repo-store' },
  });
  const splitRecord = recordForSelection(split, baseUi);
  assert.equal(splitRecord.records.find(entry => entry.key === 'task').root, host);
  assert.equal(splitRecord.records.find(entry => entry.key === 'checkpoint').root, repo);

  // A source-stamped task never falls back to the primary repo store, even
  // when a same-id decoy record is readable there.
  unlinkSync(join(host, 'tasks', 'st_done.json'));
  unlinkSync(join(host, 'dag', 'runs', 'dag_done.json'));
  const missing = recordForSelection(snapshot, baseUi);
  assert.ok(missing.records.every(entry => entry.root === host));
  assert.equal(missing.openPath, undefined);
  assert.equal(recordForKey('o', missing).kind, 'unavailable');
  assert.equal(existsSync(join(repo, 'tasks', 'st_done.json')), true);
});

test('missing, non-JSON, outside-root, and symlinked records are refused', t => {
  const root = mkdtempSync(join(tmpdir(), 'dag-full-record-unsafe-'));
  const outside = mkdtempSync(join(tmpdir(), 'dag-full-record-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'tasks'), { recursive: true });
  mkdirSync(join(root, 'dag', 'runs'), { recursive: true });
  writeFileSync(join(root, 'snapshot.json'), '{}');
  const outsideRecord = join(outside, 'outside.json');
  writeFileSync(outsideRecord, recordJson());
  const snapshot = fixture({ root });
  const taskPath = join(root, 'tasks', 'st_done.json');

  // Missing task record: the derived path is still known, but not openable.
  let record = recordForSelection(snapshot, baseUi);
  assert.equal(record.openPath, undefined);
  assert.equal(recordForKey('o', record).kind, 'unavailable');

  // Direct gates: directory, non-JSON, outside root, and a resolved path that
  // climbs out of the store are all rejected.
  writeFileSync(join(root, 'tasks', 'note.txt'), '{}');
  assert.equal(safeFileWithin(root, join(root, 'tasks')), undefined);
  assert.equal(safeFileWithin(root, join(root, 'tasks', 'note.txt')), undefined);
  assert.equal(safeFileWithin(root, outsideRecord), undefined);
  assert.equal(safeFileWithin(root, join(root, 'tasks', '..', '..', 'outside.json')), undefined);

  // A regular .json inside the root is accepted.
  writeFileSync(taskPath, recordJson());
  assert.equal(safeFileWithin(root, taskPath), taskPath);

  // A record over the size cap is refused rather than piped into the terminal.
  writeFileSync(taskPath, Buffer.alloc(4 * 1024 * 1024 + 1, 0x7b));
  const oversizedRecord = recordForSelection(snapshot, baseUi);
  assert.equal(oversizedRecord.openPath, undefined);
  assert.equal(recordForKey('o', oversizedRecord).kind, 'unavailable');
  writeFileSync(taskPath, recordJson());

  // A symlink that escapes the store is refused even when it is named .json.
  const escaped = join(root, 'tasks', 'st_link.json');
  symlinkSync(outsideRecord, escaped);
  assert.equal(safeFileWithin(root, escaped), undefined);

  // Replace the authoritative task record with an escaping symlink.
  unlinkSync(taskPath);
  symlinkSync(outsideRecord, taskPath);
  record = recordForSelection(snapshot, baseUi);
  assert.equal(record.openPath, undefined);
  assert.equal(recordForKey('o', record).kind, 'unavailable');

  // A record removed after the frame was drawn is revalidated on the action.
  unlinkSync(taskPath);
  writeFileSync(taskPath, recordJson());
  record = recordForSelection(snapshot, baseUi);
  assert.equal(recordForKey('o', record).kind, 'open');
  unlinkSync(taskPath);
  assert.equal(recordForKey('o', record).kind, 'unavailable');
});

test('default hides reply and source; verbose advertises o open and names final_response', t => {
  const root = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = fixture({ root });

  const plain = render(snapshot).text;
  assert.doesNotMatch(plain, /REPLY/);
  assert.doesNotMatch(plain, /SOURCE/);
  assert.doesNotMatch(plain, /… truncated · 3373 B total/);
  assert.doesNotMatch(plain, /o open · full record/);

  const verbose = render(snapshot, { verbose: true }).text;
  assert.match(verbose, /… truncated · 3373 B total/);
  assert.match(verbose, /o open · full record/);
  assert.match(verbose, /reply\s+recorded · from final_response/);

  const zh = render(snapshot, { language: 'zh', verbose: true }).text;
  assert.match(zh, /o 打开 · 完整记录/);
  assert.match(zh, /已记录 · 来自 final_response/);
});

test('a completed task without a readable record shows the action unavailable', t => {
  const withoutRoot = render(fixture({}), { verbose: true }).text;
  const noRootRecord = recordForSelection(fixture({}), baseUi);
  assert.equal(noRootRecord.records.length, 0);
  assert.equal(recordForKey('o', noRootRecord).kind, 'unavailable');
  assert.match(withoutRoot, /o unavailable · record not readable/);
  assert.doesNotMatch(withoutRoot, /o open · full record/);

  const root = makeStore({ withRecord: false });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  unlinkSync(join(root, 'dag', 'runs', 'dag_done.json'));
  const missing = fixture({ root });
  const missingRecord = recordForSelection(missing, baseUi);
  assert.equal(missingRecord.openPath, undefined);
  assert.equal(recordForKey('o', missingRecord).kind, 'unavailable');
  const text = render(missing, { verbose: true }).text;
  assert.match(text, /o unavailable · record not readable/);
  assert.doesNotMatch(text, /o open · full record/);
});

test('demo snapshots never advertise or open a raw record', () => {
  const snapshot = fixture({ mode: 'demo' });
  const record = recordForSelection(snapshot, baseUi);
  assert.equal(record.simulated, true);
  assert.equal(record.records.length, 0);
  assert.equal(recordForKey('o', record).kind, 'unavailable');
  const text = render(snapshot, { verbose: true }).text;
  assert.match(text, /o unavailable · record not readable/);
  assert.doesNotMatch(text, /o open · full record/);
});

test('narrow run rows translate the running count instead of hardcoding English', () => {
  const snapshot = fixture({
    run: { status: 'running' },
    node: { state: 'running', percent: undefined },
    task: { status: 'running', completed_at: undefined, percent: undefined },
  });
  const row = (language) => {
    const text = render(snapshot, { language, focus: 'runs' }, { width: 80, height: 40 }).text;
    return text.split('\n').find(line => line.startsWith('│') && line.includes('● Completed run'));
  };

  assert.match(row('en'), /1 running/);
  assert.match(row('zh'), /1 个运行中/);
  assert.doesNotMatch(row('zh'), /\d+ running/);

  // The token-rate axis stays a time axis: a timestamp-less series never
  // turns its sample count into a "N pts" label.
  const rate = fixture({
    task: { tokenRate: [2, 4, 8], tokenRateKind: 'history', tokenRateHistory: [{ rate: 2 }, { rate: 4 }, { rate: 8 }] },
  });
  const rateText = render(rate, { focus: 'tasks', selectedTaskId: 'st_done' }, { width: 160, height: 60 }).text;
  assert.doesNotMatch(rateText, /\d+ pts/);
});

// F-131: the pane title, the details reset key, and the record action must name
// the same subject for every focus/lastFocus combination, including a task
// whose linked run is not the clamped run index.
test('painted subject, details key, and record action agree for every focus combination', () => {
  const snapshot = selectionFixture();
  const base = { ...baseUi, runIndex: 1, selectedTaskId: 'st_focus' };
  const expected = {
    task: { title: 'TASK · st_focus', key: 'task:st_focus', record: { kind: 'task', id: 'st_focus' } },
    node: { title: 'CURRENT NODE · Other node', key: 'node:dag_selected:other', record: { kind: 'node', id: 'other' } },
    run: { title: 'RUN · Selected run', key: 'run:dag_selected', record: null },
  };
  const combinations = [
    { kind: 'task', focus: 'tasks', lastFocus: 'graph', selectedNodeId: 'other' },
    { kind: 'task', focus: 'tasks', lastFocus: 'tasks', selectedNodeId: 'other' },
    { kind: 'task', focus: 'details', lastFocus: 'tasks', selectedNodeId: 'other' },
    { kind: 'node', focus: 'graph', lastFocus: 'tasks', selectedNodeId: 'other' },
    { kind: 'node', focus: 'runs', lastFocus: 'graph', selectedNodeId: 'other' },
    { kind: 'node', focus: 'cells', lastFocus: 'tasks', selectedNodeId: 'other' },
    { kind: 'node', focus: 'details', lastFocus: 'graph', selectedNodeId: 'other' },
    { kind: 'node', focus: 'details', lastFocus: 'runs', selectedNodeId: 'other' },
    { kind: 'node', focus: 'details', lastFocus: 'cells', selectedNodeId: 'other' },
    { kind: 'run', focus: 'graph', lastFocus: 'tasks', selectedNodeId: undefined },
    { kind: 'run', focus: 'details', lastFocus: 'graph', selectedNodeId: undefined },
  ];

  for (const combo of combinations) {
    const ui = { ...base, focus: combo.focus, lastFocus: combo.lastFocus, selectedNodeId: combo.selectedNodeId };
    const intent = expected[combo.kind];
    const frame = render(snapshot, ui, { width: 80, height: 40 }).text;
    assert.ok(frame.includes(intent.title), `${combo.focus}/${combo.lastFocus} paints ${intent.title}`);
    assert.equal(detailsSubjectKey(snapshot, ui), intent.key, `${combo.focus}/${combo.lastFocus} details key`);
    const record = recordForSelection(snapshot, ui);
    if (intent.record) {
      assert.equal(record?.kind, intent.record.kind, `${combo.focus}/${combo.lastFocus} record kind`);
      assert.equal(record?.id, intent.record.id, `${combo.focus}/${combo.lastFocus} record id`);
    } else {
      assert.equal(record, null, `${combo.focus}/${combo.lastFocus} has no record target`);
      assert.equal(diagnosisForSelection(snapshot, ui), null, `${combo.focus}/${combo.lastFocus} has no diagnosis target`);
    }
  }

  // A task focus paints its linked run, not the clamped run index.
  const frame = render(snapshot, {
    ...base, focus: 'tasks', lastFocus: 'graph', selectedNodeId: 'other',
  }, { width: 80, height: 40 }).text;
  assert.ok(frame.includes('Linked run · 0/1 done · 1 running'));
});

// F-79: quitting must leave the alternate screen, restore the cursor, and
// disable mouse tracking, whether the viewer exits through q or a signal.
test('q and termination signals restore the terminal before exit', { timeout: 30_000 }, async t => {
  const stops = [
    ['q', proc => proc.terminal.write('q')],
    ['SIGINT', proc => proc.kill('SIGINT')],
    ['SIGHUP', proc => proc.kill('SIGHUP')],
  ];
  for (const [name, stop] of stops) {
    const root = makeStore();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const viewer = startViewer(root);
    t.after(() => { try { viewer.proc.kill('SIGTERM'); } catch { /* already gone */ } });
    await within(viewer.firstFrame, 8000, `${name}: viewer painted a frame`);
    stop(viewer.proc);
    assert.equal(await within(viewer.proc.exited, 5000, `${name}: viewer exited`), 0, `${name}: clean exit`);
    assert.ok(viewer.output.includes('\x1b[?1049l'), `${name}: leaves the alternate screen`);
    assert.ok(viewer.output.includes('\x1b[?25h'), `${name}: restores the cursor`);
    assert.ok(viewer.output.includes('\x1b[?1000l\x1b[?1006l'), `${name}: disables mouse tracking`);
    assert.ok(viewer.output.includes(terminalRestoreSequence()), `${name}: full restore sequence`);
  }
});

test('the interactive viewer opens a completed record through the allowlisted pager', { timeout: 20_000 }, async t => {
  const root = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = writeViewerState(root);
  const capture = join(root, 'capture.json');
  const env = fakePager(root, { capture });
  env.NERO_HERDR_DAG_CONFIG_DIR = join(root, 'config');

  let output = '';
  let painted;
  let replyPainted;
  let verbosePressed = false;
  const firstFrame = new Promise(resolve => { painted = resolve; });
  const replyFrame = new Promise(resolve => { replyPainted = resolve; });
  const proc = Bun.spawn([
    process.execPath, 'src/viewer.mjs', '--state', statePath, '--no-color', '--no-motion',
  ], {
    cwd: process.cwd(),
    env,
    terminal: {
      cols: 120,
      rows: 40,
      data(_term, chunk) {
        output += new TextDecoder().decode(chunk);
        if (output.includes('METRICS')) painted();
        if (verbosePressed && output.includes('REPLY')) replyPainted();
      },
    },
  });
  t.after(() => { try { proc.kill('SIGTERM'); } catch {} });

  await within(firstFrame, 8000, 'the viewer painted a details frame');
  assert.doesNotMatch(output, /REPLY/, 'reply stays hidden until d');
  verbosePressed = true;
  proc.terminal.write('d');
  await within(replyFrame, 8000, 'd reveals REPLY');
  proc.terminal.write('o');

  const parsed = await waitForJsonFile(capture, 8000);
  assert.equal(parsed.final_response, FULL_RESPONSE);
  assert.equal(parsed.final_response.length, 3373);

  // A fresh viewer owns q/teardown; after the pager this one may still be in
  // its 300ms key-ignore window, so the signal path is the deterministic exit.
  proc.kill('SIGTERM');
  assert.equal(await within(proc.exited, 5000, 'the viewer exits after SIGTERM'), 0);
});
