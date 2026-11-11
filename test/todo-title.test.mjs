import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTodoEvents, parseTodoEvents, todoTitleAt, todoTitleForRun } from '../src/todo-title.mjs';

const record = (timestamp, phases) => JSON.stringify({
  type: 'custom',
  customType: 'senpi.todo-state',
  timestamp,
  data: { phases },
});

const dataRecord = (timestamp, data) => JSON.stringify({
  type: 'custom',
  customType: 'senpi.todo-state',
  timestamp,
  data,
});

test('the latest in-progress todo item maps to a run creation time', () => {
  const events = parseTodoEvents([
    record('2026-11-10T09:00:00.000Z', [{ name: 'Diagnosis', tasks: [{ content: 'inspect runtime', status: 'in_progress' }] }]),
    record('2026-11-10T09:10:00.000Z', [{ name: 'Implementation', tasks: [{ content: 'adjust metric layout', status: 'in_progress' }] }]),
    'not json',
    record('2026-11-10T09:20:00.000Z', [{ name: 'Verification', tasks: [{ content: 'run checks', status: 'pending' }] }]),
  ].join('\n'));

  assert.equal(todoTitleAt(events, '2026-11-10T09:05:00.000Z'), 'inspect runtime');
  assert.equal(todoTitleAt(events, '2026-11-10T09:15:00.000Z'), 'adjust metric layout');
  assert.equal(todoTitleAt(events, '2026-11-10T09:25:00.000Z'), 'adjust metric layout');
  assert.equal(todoTitleAt(events, '2026-11-10T08:55:00.000Z'), undefined);
  assert.equal(todoTitleForRun({ createdAt: '2026-11-10T09:15:00.000Z' }, events), 'adjust metric layout');
  assert.equal(todoTitleForRun({ createdAt: 'bad', todoTitle: 'fallback' }, events), 'fallback');
});

test('a missing session file yields no todo annotation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dag-todo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'session.jsonl');
  await writeFile(file, [
    record('2026-11-10T09:00:00.000Z', [{ name: 'Implementation', tasks: [{ content: 'build it', status: 'in_progress' }] }]),
  ].join('\n'));
  assert.equal((await loadTodoEvents(file))[0].title, 'build it');
  assert.deepEqual(await loadTodoEvents(join(root, 'missing.jsonl')), []);
  assert.deepEqual(await loadTodoEvents(undefined), []);
});

test('malformed todo phases are skipped without losing valid snapshots', () => {
  const warnings = [];
  const events = parseTodoEvents([
    record('2026-11-10T09:00:00.000Z', [{ name: 'Build', tasks: [{ content: 'first title', status: 'in_progress' }] }]),
    dataRecord('2026-11-10T09:05:00.000Z', { phases: 'not-an-array' }),
    dataRecord('2026-11-10T09:06:00.000Z', {
      phases: [null, { name: 'bad tasks', tasks: 7 }, { name: 'bad entries', tasks: [null, 3] }],
    }),
    record('2026-11-10T09:10:00.000Z', [{ name: 'Verify', tasks: [{ content: 'second title', status: 'in_progress' }] }]),
  ].join('\n'), message => warnings.push(message));

  assert.deepEqual(events.map(event => event.title), ['first title', 'second title']);
  assert.equal(warnings.length, 1, 'malformed records warn once per parse');
  assert.equal(typeof warnings[0], 'string');
});

test('non-ENOENT todo session read failures warn instead of failing silently', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dag-todo-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const warnings = [];
  assert.deepEqual(await loadTodoEvents(root, message => warnings.push(message)), []);
  assert.equal(warnings.length, 1);
  assert.equal(typeof warnings[0], 'string');

  const missingWarnings = [];
  assert.deepEqual(await loadTodoEvents(join(root, 'missing.jsonl'), message => missingWarnings.push(message)), []);
  assert.deepEqual(missingWarnings, []);
});

test('zero-width todo content cannot become an invisible run title', () => {
  const events = parseTodoEvents([
    record('2026-11-10T09:00:00.000Z', [{ tasks: [{ content: '\u200B\u200C\u200D\u2060\uFEFF', status: 'in_progress' }] }]),
    record('2026-11-10T09:10:00.000Z', [{ tasks: [{ content: ' \u200Bbuild\u200D it\u2060 ', status: 'in_progress' }] }]),
  ].join('\n'), () => {});

  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'build it');
  assert.equal(todoTitleForRun({ createdAt: '2026-11-10T09:05:00.000Z', todoTitle: 'producer name' }, events), 'producer name');
});
