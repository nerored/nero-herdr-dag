import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareNavigationTasks, standaloneTasks } from '../src/model.mjs';
import { navTasks } from '../src/render.mjs';
import {
  collapseTransition, completedItems, expandTransition, foldedFromView, hiddenSnapshot,
  loadViewState, saveViewState, setExpanded, switcherItems, syncFoldedRun,
} from '../src/view-state.mjs';

const expandedKey = (runId, nodeId) => JSON.stringify([runId, nodeId]);

test('explicit fold preferences survive a reload and malformed keys are ignored', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dag-view-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, 'session.json');
  const view = { version: 1, sessionId: 's1', expanded: {} };
  setExpanded(view, 'run', 'a', false);
  setExpanded(view, 'run', 'b', true);
  await saveViewState(stateFile, view);
  const loaded = await loadViewState(stateFile, 's1');
  assert.equal(loaded.expanded[expandedKey('run', 'a')], false);
  assert.equal(loaded.expanded[expandedKey('run', 'b')], true);
  assert.deepEqual([...foldedFromView(loaded)], ['a']);
  assert.deepEqual(foldedFromView({
    expanded: {
      notJson: false,
      [JSON.stringify(['run', 42])]: false,
      [JSON.stringify(['run', 'kept'])]: false,
      [JSON.stringify(['run', 'open'])]: true,
    },
  }), new Set(['kept']));
  const crossRun = {
    expanded: {
      [expandedKey('run_a', 'shared')]: false,
      [expandedKey('run_b', 'other')]: false,
    },
  };
  assert.deepEqual([...foldedFromView(crossRun, 'run_a')], ['shared']);
  assert.deepEqual([...foldedFromView(crossRun)], ['shared', 'other']);
});

test('a missing view state starts empty for the requested session', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dag-view-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await loadViewState(join(directory, 'missing.json'), 's1'), {
    version: 1, sessionId: 's1', expanded: {},
  });
});

test('a different session does not inherit view preferences', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dag-view-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, 'session.json');
  const view = { version: 1, sessionId: 's1', expanded: {} };
  setExpanded(view, 'run', 'a', false);
  await saveViewState(stateFile, view);
  const loaded = await loadViewState(stateFile, 's2');
  assert.deepEqual(loaded.expanded, {});
});

test('expanding from details, runs, or cells restores that focus', () => {
  for (const focus of ['details', 'runs', 'cells']) {
    const ui = { focus, lastFocus: 'graph', expanded: false, follow: true, returnFocus: 'graph' };
    const expanded = expandTransition(ui);
    assert.deepEqual(expanded, {
      expanded: true, focus: 'details', lastFocus: focus, returnFocus: focus, follow: false,
    });
    assert.deepEqual(collapseTransition({ ...ui, ...expanded }), {
      expanded: false, focus,
    });
  }
});

test('graph and task expansion keeps the existing owner contract', () => {
  assert.deepEqual(expandTransition({ focus: 'graph', lastFocus: 'graph', expanded: false }), {
    expanded: true, focus: 'details', lastFocus: 'graph', returnFocus: 'graph', follow: false,
  });
  assert.deepEqual(expandTransition({ focus: 'tasks', lastFocus: 'tasks', expanded: false }), {
    expanded: true, focus: 'details', lastFocus: 'tasks', returnFocus: 'tasks', follow: false,
  });
  assert.equal(expandTransition({ expanded: false }).returnFocus, 'graph');
  assert.equal(collapseTransition({ expanded: false }), null);
  assert.deepEqual(
    collapseTransition({ expanded: true, returnFocus: 'bogus', lastFocus: 'tasks' }),
    { expanded: false, focus: 'tasks' },
  );
});

test('description-less tasks sort by id instead of throwing', () => {
  const snapshot = {
    runs: [],
    tasks: [
      { id: 'b', status: 'pending' },
      { id: 'r', status: 'running' },
      { id: 'a', status: 'pending' },
      { id: 'z', status: 'completed', description: 'alpha' },
    ],
  };
  const items = switcherItems(snapshot, null);
  assert.deepEqual(items.map(item => item.id), ['r', 'a', 'z', 'b']);
});

test('F-53 fold state follows the selected run instead of leaking node ids', () => {
  const view = { expanded: {} };
  setExpanded(view, 'run_a', 'shared', false);

  // The viewer loads one persisted set per visible run.
  const ui = {
    folded: new Set(foldedFromView(view, 'run_a')),
    foldedRunId: 'run_a',
    foldedByRun: new Map([
      ['run_a', foldedFromView(view, 'run_a')],
      ['run_b', foldedFromView(view, 'run_b')],
    ]),
  };
  assert.deepEqual([...ui.folded], ['shared']);

  // run_b has a node with the same id, but it was never folded there.
  syncFoldedRun(ui, 'run_b');
  assert.deepEqual([...ui.folded], []);

  ui.folded.add('other');
  syncFoldedRun(ui, 'run_a');
  assert.deepEqual([...ui.folded], ['shared']);
  syncFoldedRun(ui, 'run_b');
  assert.deepEqual([...ui.folded], ['other']);

  // Folds toggled before a view file exists are parked and restored too.
  const bare = { folded: new Set(), foldedRunId: undefined, foldedByRun: new Map() };
  syncFoldedRun(bare, 'run_a');
  bare.folded.add('shared');
  syncFoldedRun(bare, 'run_b');
  assert.equal(bare.folded.size, 0);
  syncFoldedRun(bare, 'run_a');
  assert.deepEqual([...bare.folded], ['shared']);
});

test('F-52 sidebar, switcher, and standalone tasks share one navigation order', () => {
  const tasks = [
    { id: 'st_b', status: 'pending', description: 'alpha' },
    { id: 'st_a', status: 'pending', description: 'alpha' },
    { id: 'st_r', status: 'running', description: 'zeta' },
    { id: 'st_missing', status: 'pending' },
  ];
  const snapshot = { runs: [], tasks };
  const expected = [...tasks].sort(compareNavigationTasks).map(task => task.id);
  assert.deepEqual(expected, ['st_r', 'st_a', 'st_b', 'st_missing']);
  assert.deepEqual(navTasks(snapshot).map(task => task.id), expected);
  assert.deepEqual(
    switcherItems(snapshot, null).filter(item => item.kind === 'task').map(item => item.id),
    expected,
  );
  assert.deepEqual(standaloneTasks(snapshot).map(task => task.id), expected);
});

test('old finished runs and tasks, including cancelled, can be hidden without deleting the snapshot', () => {
  const state = {
    runs: [
      { id: 'done', status: 'completed', nodes: [{ taskId: 'done_task' }] },
      { id: 'failed', status: 'failed', nodes: [{ taskId: 'failed_task' }] },
      { id: 'cancelled', status: 'cancelled', nodes: [{ taskId: 'cancelled_task' }] },
      { id: 'live', status: 'running', nodes: [{ taskId: 'live_task' }] },
    ],
    tasks: [
      { id: 'done_task', status: 'completed' },
      { id: 'failed_task', status: 'failed' },
      { id: 'cancelled_task', status: 'cancelled' },
      { id: 'live_task', status: 'running' },
    ],
  };
  const completed = completedItems(state);
  assert.deepEqual(completed.runs.map(run => run.id), ['done', 'failed', 'cancelled']);
  assert.deepEqual(completed.tasks.map(task => task.id), ['done_task', 'failed_task', 'cancelled_task']);
  const visible = hiddenSnapshot(state, { runIds: new Set(['done', 'failed', 'cancelled']) });
  assert.deepEqual(visible.runs.map(run => run.id), ['live']);
  assert.deepEqual(visible.tasks.map(task => task.id), ['live_task']);
  assert.equal(state.runs.length, 4);
  assert.equal(state.tasks.length, 4);
  assert.equal(hiddenSnapshot(state, {}), state);
});

test('x clear keeps running and recently finished subjects', () => {
  const now = Date.parse('2026-11-11T12:00:00.000Z');
  const recent = new Date(now - 60_000).toISOString();
  const old = new Date(now - 10 * 60_000).toISOString();
  const state = {
    runs: [
      { id: 'live', status: 'running', updatedAt: recent },
      { id: 'recent-completed', status: 'completed', updatedAt: recent },
      { id: 'recent-failed', status: 'failed', updatedAt: recent },
      { id: 'recent-cancelled', status: 'cancelled', updatedAt: recent },
      { id: 'old-completed', status: 'completed', updatedAt: old },
      { id: 'old-failed', status: 'failed', updatedAt: old },
      { id: 'old-cancelled', status: 'cancelled', updatedAt: old },
      { id: 'untimed-completed', status: 'completed' },
    ],
    tasks: [
      { id: 'live-task', status: 'running', updatedAt: recent },
      { id: 'recent-task', status: 'completed', completedAt: recent },
      { id: 'recent-cancel-task', status: 'cancelled', updatedAt: recent },
      { id: 'old-task', status: 'completed', completedAt: old },
      { id: 'old-cancel-task', status: 'cancelled', updatedAt: old },
      { id: 'untimed-task', status: 'failed' },
    ],
  };
  const items = completedItems(state, { now });
  assert.deepEqual(items.runs.map(run => run.id), [
    'old-completed', 'old-failed', 'old-cancelled', 'untimed-completed',
  ]);
  assert.deepEqual(items.tasks.map(task => task.id), ['old-task', 'old-cancel-task', 'untimed-task']);
  assert.ok(items.runs.every(run => !['live', 'recent-completed', 'recent-failed', 'recent-cancelled'].includes(run.id)));
  assert.ok(items.tasks.every(task => !['live-task', 'recent-task', 'recent-cancel-task'].includes(task.id)));
});

test('clearing a cancelled run keeps its queued linked tasks visible', () => {
  const state = {
    runs: [{
      id: 'cancelled',
      status: 'cancelled',
      nodes: [
        { taskId: 'done_task' },
        { taskId: 'queued_task' },
        { taskId: 'blocked_task' },
        { taskId: 'scheduled_task' },
        { taskId: 'running_task' },
        { taskId: 'paused_task' },
      ],
    }],
    tasks: [
      { id: 'done_task', status: 'completed' },
      { id: 'queued_task', status: 'pending' },
      { id: 'blocked_task', status: 'blocked' },
      { id: 'scheduled_task', status: 'scheduled' },
      { id: 'running_task', status: 'running' },
      { id: 'paused_task', status: 'paused' },
    ],
  };
  const items = completedItems(state);
  assert.deepEqual(items.runs.map(run => run.id), ['cancelled']);
  assert.deepEqual(items.tasks.map(task => task.id), ['done_task']);
  const visible = hiddenSnapshot(state, { runIds: new Set(items.runs.map(run => run.id)) });
  assert.deepEqual(
    visible.tasks.map(task => task.id),
    ['queued_task', 'blocked_task', 'scheduled_task', 'running_task', 'paused_task'],
  );
});
