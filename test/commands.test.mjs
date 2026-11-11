import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandItems, filterCommands } from '../src/commands.mjs';

test('the command palette exposes unique, translated actions', () => {
  const en = commandItems('en');
  const zh = commandItems('zh');
  assert.ok(en.length >= 12);
  assert.equal(new Set(en.map(item => item.id)).size, en.length);
  assert.deepEqual(en.map(item => item.id), zh.map(item => item.id));
  assert.notEqual(en.find(item => item.id === 'overview').label, zh.find(item => item.id === 'overview').label);
  assert.ok(en.every(item => typeof item.label === 'string' && item.label.length > 0));
});

test('command filtering matches ids and labels without dropping the whole list', () => {
  const items = commandItems('en');
  assert.deepEqual(filterCommands(items, '').map(item => item.id), items.map(item => item.id));
  assert.ok(filterCommands(items, 'critical').some(item => item.id === 'filter-critical'));
  assert.ok(filterCommands(items, 'scope').some(item => item.id === 'scope'));
  assert.deepEqual(filterCommands(items, 'no such command'), []);
});
