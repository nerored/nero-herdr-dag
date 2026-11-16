import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandItems, filterCommands } from '../src/commands.mjs';

// The palette is the keyboard contract for every cockpit action. Pin the exact
// ids and their order so a removed or renamed command cannot disappear behind
// a "some commands exist" length assertion.
const COMMAND_IDS = [
  'overview',
  'find',
  'filter-failed',
  'filter-blocked',
  'filter-running',
  'filter-critical',
  'filter-clear',
  'focus',
  'scope',
  'completed',
  'verbose',
  'tour',
  'undo',
  'help',
  'settings',
  'quit',
];

test('the command palette exposes the exact sixteen command ids in order', () => {
  const en = commandItems('en');
  const zh = commandItems('zh');
  assert.equal(en.length, 16);
  assert.deepEqual(en.map(item => item.id), COMMAND_IDS);
  assert.deepEqual(zh.map(item => item.id), COMMAND_IDS);
  assert.equal(new Set(en.map(item => item.id)).size, en.length);
  assert.ok(en.every(item => typeof item.label === 'string' && item.label.length > 0));
  assert.ok(zh.every(item => typeof item.label === 'string' && item.label.length > 0));
  assert.notEqual(en.find(item => item.id === 'overview').label, zh.find(item => item.id === 'overview').label);
});

test('every command id is reachable through the palette filter', () => {
  const items = commandItems('en');
  for (const id of COMMAND_IDS) {
    const matches = filterCommands(items, id);
    assert.ok(matches.some(item => item.id === id), `${id} is reachable by its own id`);
  }
});

test('command filtering matches ids and labels without dropping the whole list', () => {
  const items = commandItems('en');
  assert.deepEqual(filterCommands(items, '').map(item => item.id), items.map(item => item.id));
  assert.deepEqual(filterCommands(items, '   ').map(item => item.id), items.map(item => item.id));
  assert.deepEqual(filterCommands(items, undefined).map(item => item.id), items.map(item => item.id));

  assert.deepEqual(
    filterCommands(items, 'filter failed').map(item => item.id),
    ['filter-failed'],
  );
  assert.deepEqual(
    filterCommands(items, 'Show all graph nodes').map(item => item.id),
    ['filter-clear'],
  );
  assert.deepEqual(
    filterCommands(items, 'toggle completed').map(item => item.id),
    ['completed'],
  );
  assert.deepEqual(filterCommands(items, 'no such command'), []);
});
