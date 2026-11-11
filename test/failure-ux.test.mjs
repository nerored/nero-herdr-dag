import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DIAGNOSIS_ACTIONS, diagnosisCopyText, diagnosisFor, diagnosisForKey,
  diagnosisPathsText, osc52, pagerCommand, payloadLines, safeFileWithin,
  safeOpenRecordPath,
} from '../src/clipboard.mjs';
import { normalizeSnapshot } from '../src/model.mjs';
import { diagnosisForSelection, renderApp } from '../src/render.mjs';
import { createTheme, paletteAt } from '../src/theme.mjs';
import { width as textWidth } from '../src/text.mjs';

const now = 1_000_000;
const palette = paletteAt(0);
const theme = createTheme({ palette, color: false });
const baseUi = {
  runIndex: 0, focus: 'graph', lastFocus: 'graph',
  selectedNodeId: 'ship', selectedTaskId: 'st_fail',
  follow: false, motion: false, help: false, verbose: false, folded: new Set(),
  graphScroll: 0, graphScrollTarget: 0, manualScroll: false, sidebar: true,
  language: 'en', fps: 12, toasts: [],
};

const taskRecord = (overrides = {}) => ({
  id: 'st_fail',
  description: 'Ship release',
  status: 'failed',
  agent: 'forge',
  model: 'crs/deepseek-v4.1-flash',
  started_at: '2026-11-10T05:58:00Z',
  terminal_at: '2026-11-10T06:04:30Z',
  error_message: 'permission denied: /srv/release (EACCES) while promoting build 8842',
  retries: 2,
  run_stats: { turns: 17, failed_turns: 4, tool_calls: 31 },
  turns: 17,
  tool_calls: 31,
  ...overrides,
});

function fixture({ mode = 'live', root, task = {}, node = {}, run = {} } = {}) {
  return normalizeSnapshot({
    version: 3,
    sessionId: 'failure-ux-session',
    mode,
    connected: mode !== 'saved',
    updatedAt: '2026-11-10T06:05:00Z',
    provenance: root ? {
      origin: mode === 'demo' ? 'demo-engine' : 'controller',
      statePath: join(root, 'snapshot.json'),
      taskStateDir: root,
      capturedAt: '2026-11-10T06:05:00Z',
    } : undefined,
    runs: [{
      id: 'dag_release_audit',
      name: 'Release audit',
      status: 'failed',
      createdAt: '2026-11-10T05:00:00Z',
      updatedAt: '2026-11-10T06:05:00Z',
      nodes: [
        {
          id: 'ship', label: 'Ship release', state: 'failed', task_id: 'st_fail',
          attempt: 3, started_at: '2026-11-10T05:59:00Z',
          completed_at: '2026-11-10T06:04:00Z',
          error: 'permission denied: /srv/release (EACCES) while promoting build 8842',
          logs: ['promote build 8842', 'upload failed after 3 attempts'],
          resultArtifact: {
            relativePath: 'dag/results/dag_release_audit/ship.txt',
            bytes: 1843,
            sha256: '8cfdf642c786856839dfe918266620159b32229ea3bee56a4afa1d89eded118d',
            stats: { relativePath: 'dag/results/dag_release_audit/ship.stats.json', bytes: 477 },
          },
          ...node,
        },
        {
          id: 'announce', label: 'Announce release', state: 'cancelled', task_id: 'st_cancel',
          attempt: 1, completed_at: '2026-11-10T05:20:00Z',
        },
        {
          id: 'verify', label: 'Verify release', state: 'blocked', task_id: 'st_block',
          attempt: 2, started_at: '2026-11-10T05:30:00Z',
        },
        { id: 'security', label: 'Security review', state: 'pending' },
      ],
      edges: [
        { from: 'security', to: 'verify' },
        { from: 'verify', to: 'ship' },
      ],
      ...run,
    }],
    tasks: [
      {
        ...taskRecord(),
        ...task,
      },
      {
        id: 'st_cancel', description: 'Announce release', status: 'cancelled',
        started_at: '2026-11-10T05:10:00Z', terminal_at: '2026-11-10T05:20:00Z',
        error_message: 'User directed termination: pause the announcement until the audit closes',
        run_stats: { turns: 6, failed_turns: 1 }, turns: 6, tool_calls: 9,
      },
      {
        id: 'st_block', description: 'Verify release', status: 'blocked',
        started_at: '2026-11-10T05:30:00Z', turns: 9, tool_calls: 20,
      },
    ],
  });
}

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), 'dag-failure-ux-'));
  mkdirSync(join(root, 'tasks'), { recursive: true });
  mkdirSync(join(root, 'dag', 'runs'), { recursive: true });
  for (const id of ['st_fail', 'st_cancel', 'st_block']) {
    writeFileSync(join(root, 'tasks', `${id}.json`), '{}');
  }
  writeFileSync(join(root, 'dag', 'runs', 'dag_release_audit.json'), '{}');
  writeFileSync(join(root, 'snapshot.json'), '{}');
  return root;
}

function render(snapshot, overrides = {}, { width = 120, height = 40 } = {}) {
  return renderApp(snapshot, { ...baseUi, ...overrides }, {
    width, height, time: 0, now, palette, theme,
  });
}

function detailsText(result) {
  const { x, y, w, h } = result.layout.details;
  return result.text.split('\n')
    .slice(y + 1, y + h - 1)
    .map(line => line.slice(x + 2, x + w - 2))
    .join('\n');
}

test('failed diagnosis card is compact, visible above metrics, and complete at 54 and 120', t => {
  const root = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = fixture({ root });

  for (const width of [54, 120]) {
    const result = render(snapshot, {}, { width, height: 40 });
    const text = detailsText(result);
    const flat = text.replace(/\s+/g, ' ');
    assert.equal(result.text.split('\n').length, 40, `${width} frame height`);
    for (const line of result.text.split('\n')) {
      assert.equal(textWidth(line), width, `${width}-column line width ${textWidth(line)}`);
    }
    assert.match(text, /DIAGNOSIS/, `${width} diagnosis heading`);
    assert.ok(text.indexOf('DIAGNOSIS') < text.indexOf('METRICS'), `${width} card precedes metrics`);
    assert.match(text, /permission denied/);
    assert.match(flat, /2026-11-10 06:04:00Z/, `${width} terminal time`);
    assert.match(flat, /upload failed/, `${width} last activity`);
    assert.match(flat, /failed turns 4/, `${width} failed turns`);
    assert.match(flat, /task#status\/node#state FAILED/, `${width} status source distinction`);
    assert.match(text, /tasks\/st_fail\.json/, `${width} task record path`);
    assert.match(text, /dag\/runs\/dag_release_audit\.json/, `${width} checkpoint path`);
    assert.match(text, /ship\.txt/);
    assert.match(text, /1\.8 KB/);
    assert.doesNotMatch(text, /(?:^|[^0-9])0%/, `${width} no fake progress`);
    assert.equal(text.split('permission denied').length - 1, 1, `${width} reason is not duplicated`);
    assert.match(text, /c copy/);
    assert.match(text, /p path/);
    assert.match(text, /o open/);
    assert.doesNotMatch(text, /\bR\b.*retry|\bEnter\b.*retry/i);
  }
});

test('cancelled task uses the stop glyph and never a retry action', t => {
  const root = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = fixture({ root });

  for (const width of [54, 120]) {
    const result = render(snapshot, { focus: 'tasks', selectedTaskId: 'st_cancel' }, { width, height: 40 });
    const text = detailsText(result);
    const flat = text.replace(/\s+/g, ' ');
    assert.match(text, /DIAGNOSIS/);
    assert.match(text, /CANCELLED/);
    assert.match(text, /User directed/);
    assert.match(flat, /task#status\/node#state CANCELLED/);
    const reasonLine = text.split('\n').find(line => line.includes('User directed'));
    assert.ok(reasonLine, `${width} stop note line`);
    assert.doesNotMatch(reasonLine, /×/);
    assert.match(text, /−/);
    assert.ok(text.indexOf('DIAGNOSIS') < text.indexOf('METRICS'));
    assert.doesNotMatch(text, /(?:^|[^0-9])0%/);
    assert.match(text, /c copy/);
    assert.match(text, /p path/);
    assert.match(text, /o open/);
  }
});

test('blocked card derives the upstream blocker and reports unknown retries explicitly', t => {
  const root = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = fixture({ root });
  for (const width of [54, 120]) {
    const text = detailsText(render(snapshot, { selectedNodeId: 'verify' }, { width, height: 40 }));
    const flat = text.replace(/\s+/g, ' ');
    assert.match(text, /DIAGNOSIS/);
    assert.match(flat, /waiting on Security/);
    assert.match(flat, /retries not recorded/);
    assert.match(text, /attempt 2/);
    assert.doesNotMatch(text, /(?:^|[^0-9])0%/);
    assert.ok(text.indexOf('DIAGNOSIS') < text.indexOf('METRICS'));
  }
});

test('failed without a reason renders an explicit not-recorded line', t => {
  const root = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = fixture({
    root,
    task: { error_message: undefined, failure_reason: undefined, last_error: undefined },
    node: { error: undefined },
  });
  const text = detailsText(render(snapshot, {}, { width: 120, height: 40 }));
  assert.match(text, /failure reason not recorded/);
  assert.doesNotMatch(text, /retries 0/);
});

test('status mismatch keeps both sources and labels the disagreement', t => {
  const root = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = fixture({ root, task: { status: 'cancelled' } });
  const text = detailsText(render(snapshot, {}, { width: 54, height: 40 }));
  const flat = text.replace(/\s+/g, ' ');
  assert.match(flat, /task#status CANCELLED/);
  assert.match(flat, /node#state FAILED/);
  assert.match(text, /MISMATCH/);
});

test('copy payloads and key gating stay read-only and exclude retry actions', t => {
  const root = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = fixture({ root });
  const node = snapshot.runs[0].nodes.find(candidate => candidate.id === 'ship');
  const task = snapshot.tasks.find(candidate => candidate.id === 'st_fail');
  const diagnosis = diagnosisFor({ snapshot, run: snapshot.runs[0], node, task, subject: 'node' });

  assert.equal(diagnosis.kind, 'node');
  assert.equal(diagnosis.state, 'failed');
  assert.equal(diagnosis.reasonSource, 'error');
  assert.equal(diagnosis.terminalAt, '2026-11-10T06:04:00.000Z');
  assert.equal(diagnosis.failedTurns, 4);
  assert.equal(diagnosis.artifact.bytes, 1843);
  assert.match(diagnosis.artifact.absolute, /dag\/results\/dag_release_audit\/ship\.txt$/);
  assert.deepEqual(diagnosis.records.map(record => record.key), ['task', 'checkpoint', 'snapshot']);
  assert.match(diagnosis.openPath, /tasks\/st_fail\.json$/);

  const copy = diagnosisCopyText(diagnosis);
  assert.match(copy, /^dag-studio diagnosis/m);
  assert.match(copy, /status: FAILED/);
  assert.match(copy, /status source: task#status; node#state/);
  assert.match(copy, /terminal time: 2026-11-10T06:04:00.000Z \(completedAt\)/);
  assert.match(copy, /failed turns: 4/);
  assert.match(copy, /reason: permission denied/);
  assert.match(copy, /reason source: error/);
  assert.match(copy, /artifact: .*ship\.txt \(1843 bytes, sha256 /);
  assert.match(copy, new RegExp(`record: ${root}/tasks/st_fail\\.json`));
  assert.match(copy, /checkpoint: .*dag_release_audit\.json/);
  assert.match(copy, /owner: OmO \(retry\/resume\/cancel unavailable in DAG Studio\)/);
  assert.doesNotMatch(copy, /\x1b|[\x00-\x08\x0b-\x1f\x7f]/);

  assert.equal(payloadLines(copy), copy.split('\n').length);
  const paths = diagnosisPathsText(diagnosis);
  assert.match(paths, /record: .*tasks\/st_fail\.json/);
  assert.match(paths, /artifact: .*ship\.txt/);
  assert.equal(diagnosisForKey('c', diagnosis).kind, 'copy-diagnosis');
  assert.equal(diagnosisForKey('p', diagnosis).kind, 'copy-paths');
  assert.equal(diagnosisForKey('o', diagnosis).kind, 'open');
  for (const key of ['r', 'R', 'Enter', 'enter', ' ', 'retry', 'x']) {
    assert.equal(diagnosisForKey(key, diagnosis), null, `${key} is not a diagnosis action`);
  }
  assert.deepEqual(DIAGNOSIS_ACTIONS, ['c', 'p', 'o']);
});

test('safe open requires an existing JSON file inside the record store', t => {
  const root = makeStore();
  const outside = mkdtempSync(join(tmpdir(), 'dag-failure-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const snapshot = fixture({ root });
  const node = snapshot.runs[0].nodes.find(candidate => candidate.id === 'ship');
  const task = snapshot.tasks.find(candidate => candidate.id === 'st_fail');
  const diagnosis = diagnosisFor({ snapshot, run: snapshot.runs[0], node, task, subject: 'node' });

  const outsideRecord = join(outside, 'outside.json');
  writeFileSync(outsideRecord, '{}');
  assert.equal(safeFileWithin(root, outsideRecord), undefined);
  assert.equal(safeFileWithin(root, join(root, 'tasks')), undefined);
  const escaped = join(root, 'tasks', 'escape.json');
  symlinkSync(outsideRecord, escaped);
  assert.equal(safeFileWithin(root, escaped), undefined);

  assert.equal(safeOpenRecordPath(diagnosis), diagnosis.openPath);
  unlinkSync(join(root, 'tasks', 'st_fail.json'));
  unlinkSync(join(root, 'dag', 'runs', 'dag_release_audit.json'));
  const stale = diagnosisFor({ snapshot, run: snapshot.runs[0], node, task, subject: 'node' });
  assert.equal(safeOpenRecordPath(stale), undefined);
  assert.equal(diagnosisForKey('o', stale).kind, 'unavailable');
  assert.equal(diagnosisForKey('p', stale).kind, 'copy-paths');
});

test('demo diagnoses are simulated and advertise no fake path action', () => {
  const snapshot = fixture({ mode: 'demo' });
  const node = snapshot.runs[0].nodes.find(candidate => candidate.id === 'ship');
  const task = snapshot.tasks.find(candidate => candidate.id === 'st_fail');
  const diagnosis = diagnosisFor({ snapshot, run: snapshot.runs[0], node, task, subject: 'node' });
  assert.equal(diagnosis.simulated, true);
  assert.equal(diagnosisPathsText(diagnosis), undefined);
  assert.equal(diagnosisForKey('p', diagnosis).kind, 'unavailable');
  assert.equal(diagnosisForKey('o', diagnosis).kind, 'unavailable');
  const text = detailsText(render(snapshot, {}, { width: 54, height: 40 }));
  assert.match(text, /simulated FAILED/);
  assert.match(text, /p\/o unavailable/);
});

test('pager selection is allowlisted and OSC 52 is a write-only escape', () => {
  assert.deepEqual(
    pagerCommand({ PAGER: 'less -R', PATH: '' }, { exists: () => true }),
    { command: 'less', args: ['-R'] },
  );
  assert.deepEqual(
    pagerCommand({ PAGER: 'bat --plain', PATH: '' }, { exists: () => true }),
    { command: 'bat', args: ['--plain'] },
  );
  assert.equal(
    pagerCommand({ PAGER: 'rm -rf /', PATH: '' }, { exists: name => name === 'less' }).command,
    'less',
  );
  assert.equal(
    pagerCommand({ PAGER: 'less; rm -rf /', PATH: '' }, { exists: name => name === 'less' }).command,
    'less',
  );
  assert.equal(pagerCommand({ PAGER: 'less', PATH: '' }, { exists: () => false }), undefined);
  assert.equal(osc52('abc'), '\x1b]52;c;YWJj\x07');
  assert.match(osc52('line one\nline two'), /^\x1b\]52;c;[\w+/=]+\x07$/);
});

test('task selection resolves the linked checkpoint and highlights mismatches', t => {
  const root = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = fixture({ root, task: { status: 'cancelled' } });
  const selected = diagnosisForSelection(snapshot, {
    ...baseUi, focus: 'tasks', selectedTaskId: 'st_fail',
  });
  assert.equal(selected.kind, 'task');
  assert.equal(selected.mismatch, true);
});

test('both languages localize the card and keep technical source tokens', t => {
  const root = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = fixture({ root });
  const zh = detailsText(render(snapshot, {
    focus: 'tasks', selectedTaskId: 'st_cancel', language: 'zh',
  }, { width: 54, height: 40 }));
  assert.match(zh, /诊断/);
  assert.match(zh, /来源/);
  assert.match(zh, /记录/);
  assert.match(zh, /重试/);
  assert.match(zh, /任务#status\/节点#state/);
  assert.match(zh, /已取消/);
  assert.doesNotMatch(zh, /DIAGNOSIS/);
});

test('the CLI --once frames show the card at 54 and 120 without a clipboard escape', t => {
  const root = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, 'viewer-state.json');
  writeFileSync(statePath, JSON.stringify({
    version: 3,
    sessionId: 'failure-ux-session',
    mode: 'live',
    connected: true,
    updatedAt: '2026-11-10T06:05:00Z',
    provenance: {
      origin: 'controller',
      statePath,
      taskStateDir: root,
      capturedAt: '2026-11-10T06:05:00Z',
    },
    runs: fixture({ root }).runs,
    // Navigation default selection differs between graph-first and task-list
    // policies; put the failed task first so this CLI check always renders the
    // failure card it is asserting, whichever policy the viewer uses.
    tasks: fixture({ root }).tasks.map(task =>
      task.id === 'st_fail' ? { ...task, description: 'A failed release' } : task),
  }));
  for (const width of [54, 120]) {
    const run = spawnSync(process.execPath, [
      'src/viewer.mjs', '--state', statePath, '--once',
      '--no-color', '--no-motion', '--width', String(width), '--height', '40',
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /诊断|DIAGNOSIS/);
    assert.match(run.stdout, /permission denied/);
    assert.doesNotMatch(run.stdout, /\x1b\]52/);
    for (const line of run.stdout.split('\n').slice(0, 40)) {
      assert.ok(textWidth(line) <= width, `${width} CLI line width ${textWidth(line)}`);
    }
  }
});

test('artifact paths that escape the record root are never displayed or copied', t => {
  const root = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const relativePath of ['../../etc/passwd', '/etc/passwd', 'a\\..\\b']) {
    const snapshot = fixture({
      root,
      node: {
        resultArtifact: {
          relativePath,
          bytes: 12,
          sha256: 'deadbeef',
          stats: { relativePath: '../../etc/shadow', bytes: 4 },
        },
      },
    });
    const node = snapshot.runs[0].nodes.find(candidate => candidate.id === 'ship');
    const task = snapshot.tasks.find(candidate => candidate.id === 'st_fail');
    const diagnosis = diagnosisFor({ snapshot, run: snapshot.runs[0], node, task, subject: 'node' });
    assert.equal(diagnosis.artifact.absolute, undefined, relativePath);
    assert.equal(diagnosis.artifact.statsAbsolute, undefined, relativePath);
    const copy = diagnosisCopyText(diagnosis);
    assert.doesNotMatch(copy, /etc\/passwd|etc\/shadow/, relativePath);
    assert.match(copy, /artifact: not recorded/);
    const paths = diagnosisPathsText(diagnosis);
    assert.ok(paths);
    assert.doesNotMatch(paths, /etc\/passwd|etc\/shadow/, relativePath);
  }
});

test('diagnosis copy and path bundles strip terminal control characters', t => {
  const root = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const esc = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const del = String.fromCharCode(127);
  const snapshot = fixture({
    root,
    task: { error_message: `permission ${esc}[31mdenied${esc}[0m` },
    node: {
      error: `permission ${esc}[31mdenied${esc}[0m`,
      logs: [`upload ${esc}[2Jfailed`, `line ${bell}bell${del}`],
      resultArtifact: {
        relativePath: `dag/results/${esc}[31mevil${esc}[0m.txt`,
        bytes: 10,
        stats: { relativePath: `dag/results/${esc}[31mstats${esc}[0m.json`, bytes: 4 },
      },
    },
  });
  const node = snapshot.runs[0].nodes.find(candidate => candidate.id === 'ship');
  const task = snapshot.tasks.find(candidate => candidate.id === 'st_fail');
  const diagnosis = diagnosisFor({ snapshot, run: snapshot.runs[0], node, task, subject: 'node' });
  const control = /[\x00-\x08\x0b-\x1f\x7f]/;
  const copy = diagnosisCopyText(diagnosis);
  assert.match(copy, /permission/);
  assert.doesNotMatch(copy, control);
  const paths = diagnosisPathsText(diagnosis);
  assert.ok(paths);
  assert.doesNotMatch(paths, control);
});

test('OSC 52 truncation preserves surrogate pairs and advertises the sent line count', () => {
  const decoded = value => Buffer.from(
    value.replace(/^\x1b\]52;c;/, '').replace(/\x07$/, ''), 'base64',
  ).toString('utf8');
  const boundary = `${'a'.repeat(15_999)}😀${'b'.repeat(100)}`;
  const body = decoded(osc52(boundary));
  assert.doesNotMatch(body, /\uFFFD/);
  assert.ok(body.endsWith('\n… truncated'));
  assert.equal(payloadLines(boundary), body.split('\n').length);

  const lines = `${'line\n'.repeat(4000)}tail`;
  const sent = decoded(osc52(lines));
  assert.doesNotMatch(sent, /\uFFFD/);
  assert.equal(payloadLines(lines), sent.split('\n').length);
  assert.ok(payloadLines(lines) < lines.split('\n').length);
});
