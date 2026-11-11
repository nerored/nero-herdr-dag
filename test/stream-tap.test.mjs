import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityUpdate, tapStreams } from '../src/stream-tap.mjs';

const taskId = 'st_stream';

function textEvent(text) {
  return {
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text },
  };
}

function thinkingEvent(thinking) {
  return {
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking }] },
    assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: thinking },
  };
}

test('stream activity maps every agent phase', () => {
  assert.deepEqual(activityUpdate(taskId, { type: 'turn_start' }, 1000),
    { taskId, active: true, phase: 'waiting', now: 1000 });
  assert.deepEqual(activityUpdate(taskId, { type: 'tool_execution_start', toolName: 'bash' }, 1100),
    { taskId, active: true, phase: 'tool', tool: 'bash', now: 1100 });
  assert.deepEqual(activityUpdate(taskId, { type: 'tool_execution_end', toolName: 'bash' }, 1200),
    { taskId, active: true, phase: 'waiting', now: 1200 });
  assert.deepEqual(activityUpdate(taskId, { type: 'auto_retry_start', attempt: 2, maxAttempts: 5 }, 1300),
    { taskId, active: true, phase: 'retry', now: 1300, attempt: 2, maxAttempts: 5 });
  assert.deepEqual(activityUpdate(taskId, { type: 'agent_end' }, 1400), { taskId, active: false });
  assert.deepEqual(activityUpdate(taskId, {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  }, 1500), { taskId, active: false });
  assert.equal(activityUpdate(taskId, {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'toolCall' }] },
  }, 1600), null);
  assert.equal(activityUpdate(taskId, { type: 'unknown_event' }, 1700), null);

  assert.deepEqual(activityUpdate(taskId, textEvent('reply text'), 2000),
    { taskId, active: true, phase: 'text', text: 'reply text', now: 2000 });
  assert.deepEqual(activityUpdate(taskId, thinkingEvent('reasoning'), 2100),
    { taskId, active: true, phase: 'thinking', text: 'reasoning', now: 2100 });
  assert.deepEqual(activityUpdate(taskId, {
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', partialJson: '{"cmd":' }] },
    assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"cmd":' },
  }, 2200), { taskId, active: true, phase: 'toolArgs', tool: 'bash', text: '{"cmd":', now: 2200 });
});

test('stream tails keep the last 200 cleaned characters', () => {
  const source = `${'x'.repeat(500)}${'y'.repeat(200)}`;
  const update = activityUpdate(taskId, textEvent(source), 10);
  assert.equal(update.text.length, 200);
  assert.equal(update.text, 'y'.repeat(200));

  const spaced = activityUpdate(taskId, textEvent(`a\n\nb${' '.repeat(10)}c`), 20);
  assert.equal(spaced.text, 'a b c');

  const control = activityUpdate(taskId, textEvent(`bad${String.fromCharCode(27)}[31mred${String.fromCharCode(27)}[0m`), 30);
  assert.equal(control.text, 'badred');
  assert.ok(!control.text.includes(String.fromCharCode(27)));
});

test('stream tails keep graphemes intact and drop unterminated escapes', () => {
  const emoji = activityUpdate(taskId, textEvent(`${'x'.repeat(200)}\u{1F600}${'y'.repeat(199)}`), 40);
  assert.equal(emoji.text.endsWith(`\u{1F600}${'y'.repeat(199)}`), true);
  assert.equal([...emoji.text].length, 200);
  assert.equal([...emoji.text].some(character => {
    const cp = character.codePointAt(0);
    return cp >= 0xd800 && cp <= 0xdfff;
  }), false);

  const csi = activityUpdate(taskId, textEvent(`hello${String.fromCharCode(27)}[38;5;`), 50);
  assert.equal(csi.text, 'hello');
  const osc = activityUpdate(taskId, textEvent(`ok${String.fromCharCode(27)}]0;title`), 60);
  assert.equal(osc.text, 'ok');
});

test('tapStreams extracts the child task id and forwards activity', () => {
  const barrel = Symbol.for('omo.senpi-task.senpiBarrel');
  const previous = globalThis[barrel];
  class Session {
    _emit(event) { this.events.push(event); }
    constructor() { this.events = []; }
  }
  globalThis[barrel] = { module: { AgentSession: Session }, promise: Promise.resolve() };
  const updates = [];
  const tap = tapStreams(update => updates.push(update), { clock: () => 77 });
  try {
    const session = new Session();
    session.sessionFile = '/project/senpi-task/children/st_child/sessions/s.jsonl';
    session._emit({ type: 'turn_start' });
    session._emit({ type: 'tool_execution_end', toolName: 'bash' });
    assert.deepEqual(updates, [
      { taskId: 'st_child', active: true, phase: 'waiting', now: 77 },
      { taskId: 'st_child', active: true, phase: 'waiting', now: 77 },
    ]);
    assert.equal(session.events.length, 2);
  } finally {
    tap.stop();
    if (previous === undefined) delete globalThis[barrel];
    else globalThis[barrel] = previous;
  }
});

test('tapStreams retries after the barrel module appears', () => {
  const barrel = Symbol.for('omo.senpi-task.senpiBarrel');
  const previous = globalThis[barrel];
  delete globalThis[barrel];
  class Session {
    constructor() { this.events = []; }
    _emit(event) { this.events.push(event); }
  }
  const updates = [];
  const tap = tapStreams(update => updates.push(update), { clock: () => 5 });
  try {
    assert.equal(tap.installed(), false);
    globalThis[barrel] = { module: { AgentSession: Session }, promise: Promise.resolve() };
    assert.equal(tap.retry(), true);
    const session = new Session();
    session.sessionFile = '/project/senpi-task/children/st_retry/sessions/s.jsonl';
    session._emit({ type: 'turn_start' });
    assert.deepEqual(updates, [{ taskId: 'st_retry', active: true, phase: 'waiting', now: 5 }]);
  } finally {
    tap.stop();
    if (previous === undefined) delete globalThis[barrel];
    else globalThis[barrel] = previous;
  }
});

test('tapStreams installs when the barrel promise resolves later', async () => {
  const barrel = Symbol.for('omo.senpi-task.senpiBarrel');
  const previous = globalThis[barrel];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis[barrel] = { module: null, promise: gate };
  class Session {
    constructor() { this.events = []; }
    _emit(event) { this.events.push(event); }
  }
  const tap = tapStreams(() => {}, { clock: () => 6 });
  try {
    assert.equal(tap.installed(), false);
    globalThis[barrel].module = { AgentSession: Session };
    release();
    await gate;
    assert.equal(tap.installed(), true);
  } finally {
    tap.stop();
    if (previous === undefined) delete globalThis[barrel];
    else globalThis[barrel] = previous;
  }
});

test('tapStreams reports an unsupported AgentSession once', () => {
  const barrel = Symbol.for('omo.senpi-task.senpiBarrel');
  const previous = globalThis[barrel];
  class Session {}
  globalThis[barrel] = { module: { AgentSession: Session }, promise: Promise.resolve() };
  let reported = 0;
  const tap = tapStreams(() => {}, { onUnsupported: () => { reported += 1; } });
  try {
    assert.equal(tap.installed(), false);
    assert.equal(reported, 1);
    assert.equal(tap.retry(), false);
    assert.equal(reported, 1);
  } finally {
    tap.stop();
    if (previous === undefined) delete globalThis[barrel];
    else globalThis[barrel] = previous;
  }
});

test('a throwing display listener never breaks the agent emit', () => {
  const barrel = Symbol.for('omo.senpi-task.senpiBarrel');
  const previous = globalThis[barrel];
  class Session {
    constructor() { this.events = []; }
    _emit(event) { this.events.push(event); return 'ok'; }
  }
  globalThis[barrel] = { module: { AgentSession: Session }, promise: Promise.resolve() };
  let calls = 0;
  const tap = tapStreams(() => { calls += 1; throw new Error('display failed'); }, { clock: () => 7 });
  try {
    const session = new Session();
    session.sessionFile = '/project/senpi-task/children/st_throw/sessions/s.jsonl';
    let result;
    assert.doesNotThrow(() => { result = session._emit({ type: 'turn_start' }); });
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
    assert.equal(session.events.length, 1);
  } finally {
    tap.stop();
    if (previous === undefined) delete globalThis[barrel];
    else globalThis[barrel] = previous;
  }
});

test('stop removes the listener and the last stop restores the original _emit', () => {
  const barrel = Symbol.for('omo.senpi-task.senpiBarrel');
  const hubSymbol = Symbol.for('herdr-dag-studio.streamHub');
  const previous = globalThis[barrel];
  class Session {
    constructor() { this.events = []; }
    _emit(event) { this.events.push(event); return 'ok'; }
  }
  globalThis[barrel] = { module: { AgentSession: Session }, promise: Promise.resolve() };
  const original = Session.prototype._emit;
  const updates = [];
  const first = tapStreams(update => updates.push(['first', update]), { clock: () => 1 });
  const second = tapStreams(update => updates.push(['second', update]), { clock: () => 2 });
  try {
    assert.notEqual(Session.prototype._emit, original);
    const session = new Session();
    session.sessionFile = '/project/senpi-task/children/st_stop/sessions/s.jsonl';
    session._emit({ type: 'turn_start' });
    assert.deepEqual(updates.map(([tap]) => tap), ['first', 'second']);

    first.stop();
    assert.notEqual(Session.prototype._emit, original);
    session._emit({ type: 'turn_start' });
    assert.deepEqual(updates.map(([tap]) => tap), ['first', 'second', 'second']);

    second.stop();
    assert.equal(Session.prototype._emit, original);
    assert.equal(globalThis[hubSymbol], undefined);
    assert.equal(session._emit({ type: 'turn_start' }), 'ok');
    assert.deepEqual(updates.map(([tap]) => tap), ['first', 'second', 'second']);
  } finally {
    first.stop();
    second.stop();
    if (previous === undefined) delete globalThis[barrel];
    else globalThis[barrel] = previous;
  }
});

test('tapStreams upgrades a hub created by an older extension generation', () => {
  const barrel = Symbol.for('omo.senpi-task.senpiBarrel');
  const hubSymbol = Symbol.for('herdr-dag-studio.streamHub');
  const previousBarrel = globalThis[barrel];
  const previousHub = globalThis[hubSymbol];
  class Session {
    constructor() { this.events = []; }
    _emit(event) { this.events.push(event); return 'ok'; }
  }
  globalThis[barrel] = { module: { AgentSession: Session }, promise: Promise.resolve() };
  // The pre-hot-reload generation created a hub with listeners only.
  globalThis[hubSymbol] = { listeners: new Set() };
  const tap = tapStreams(() => {}, { clock: () => 12 });
  try {
    assert.equal(tap.installed(), true);
    assert.ok(globalThis[hubSymbol].patches instanceof Map);
    const session = new Session();
    session.sessionFile = '/project/senpi-task/children/st_legacy/sessions/s.jsonl';
    assert.doesNotThrow(() => session._emit({ type: 'turn_start' }));
  } finally {
    tap.stop();
    if (previousBarrel === undefined) delete globalThis[barrel];
    else globalThis[barrel] = previousBarrel;
    if (previousHub === undefined) delete globalThis[hubSymbol];
    else globalThis[hubSymbol] = previousHub;
  }
});

test('the _emit patch forwards a distinct capture source to the host', () => {
  const barrel = Symbol.for('omo.senpi-task.senpiBarrel');
  const previous = globalThis[barrel];
  class Session {
    constructor() { this.calls = []; }
    _emit(event, captureSource = event) { this.calls.push([event, captureSource]); return 'host'; }
  }
  globalThis[barrel] = { module: { AgentSession: Session }, promise: Promise.resolve() };
  const tap = tapStreams(() => {}, { clock: () => 9 });
  try {
    const session = new Session();
    session.sessionFile = '/project/senpi-task/children/st_args/sessions/s.jsonl';
    const event = { type: 'turn_start' };
    const captureSource = { type: 'message_update', transformed: true };
    assert.equal(session._emit(event, captureSource), 'host');
    assert.equal(session.calls[0][0], event);
    assert.equal(session.calls[0][1], captureSource);
  } finally {
    tap.stop();
    if (previous === undefined) delete globalThis[barrel];
    else globalThis[barrel] = previous;
  }
});
