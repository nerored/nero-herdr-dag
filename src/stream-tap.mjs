import { clean, segments } from './text.mjs';

const BARREL = Symbol.for('omo.senpi-task.senpiBarrel');
const HUB = Symbol.for('herdr-dag-studio.streamHub');
const forwarded = new Set(['turn_start', 'message_update', 'message_end', 'tool_execution_start',
  'tool_execution_end', 'auto_retry_start', 'agent_end']);
const TAIL = 200;
const childTask = /[/\\]senpi-task[/\\]children[/\\](st_[A-Za-z0-9_-]{1,253})[/\\]/;

function hub(global) {
  global[HUB] ??= {};
  const state = global[HUB];
  // Hot reload can inherit a hub object created by an older extension
  // generation. Upgrade it in place instead of assuming both collections
  // exist, otherwise the next patch() throws on state.patches.has().
  if (!(state.listeners instanceof Set)) state.listeners = new Set();
  if (!(state.patches instanceof Map)) state.patches = new Map();
  return state;
}

function patch(global) {
  const module = global[BARREL]?.module;
  if (!module) return 'missing';
  const proto = module.AgentSession?.prototype;
  if (typeof proto?._emit !== 'function') return 'unsupported';
  const state = hub(global);
  if (state.patches.has(proto)) return 'installed';
  const original = proto._emit;
  const wrapper = function emitWithStreamTap(...args) {
    const event = args[0];
    if (forwarded.has(event?.type)) {
      for (const listener of state.listeners) {
        try { listener(this, event); } catch { /* display taps never break the agent */ }
      }
    }
    return original.apply(this, args);
  };
  proto._emit = wrapper;
  state.patches.set(proto, { original, wrapper });
  return 'installed';
}

// Once the last tap stops, put the host method back and drop the hub so the
// patch cannot outlive the extension that installed it.
function restore(global) {
  const state = global[HUB];
  if (!state) return;
  if (!(state.listeners instanceof Set) || state.listeners.size) return;
  if (state.patches instanceof Map) {
    for (const [proto, { original, wrapper }] of state.patches) {
      if (proto._emit === wrapper) proto._emit = original;
    }
  }
  delete global[HUB];
}

const danglingEscape = /\u001b(?:\[[0-?]*[ -/]*|[\]P^_X][^\u0007\u001b]*)$/;
const tail = text => {
  // A streamed delta can end inside an escape sequence; drop that residue
  // before clean() turns its bytes into stray parameter characters.
  const cleaned = clean(String(text ?? '').replace(danglingEscape, '')).replace(/\s+/g, ' ').trim();
  const parts = segments(cleaned);
  return parts.length > TAIL ? parts.slice(-TAIL).join('') : cleaned;
};
const toolName = value => typeof value === 'string' && value ? clean(value).slice(0, 64) : undefined;

export function activityUpdate(taskId, event, now = Date.now()) {
  switch (event?.type) {
    case 'turn_start': return { taskId, active: true, phase: 'waiting', now };
    case 'tool_execution_start': return { taskId, active: true, phase: 'tool', tool: toolName(event.toolName), now };
    case 'tool_execution_end': return { taskId, active: true, phase: 'waiting', now };
    case 'auto_retry_start': return { taskId, active: true, phase: 'retry', now,
      ...(Number.isSafeInteger(event.attempt) ? { attempt: event.attempt } : {}),
      ...(Number.isSafeInteger(event.maxAttempts) ? { maxAttempts: event.maxAttempts } : {}) };
    case 'agent_end': return { taskId, active: false };
    case 'message_end': {
      const content = event.message?.role === 'assistant' ? event.message.content : undefined;
      if (!Array.isArray(content)) return null;
      return content.some(block => block?.type === 'toolCall') ? null : { taskId, active: false };
    }
    case 'message_update': break;
    default: return null;
  }
  const delta = event.assistantMessageEvent;
  if (event.message?.role !== 'assistant' || !delta) return null;
  const block = event.message.content?.[delta.contentIndex];
  if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
    const source = delta.type === 'text_delta' ? block?.text : block?.thinking;
    const text = typeof source === 'string' ? tail(source) : '';
    return text ? { taskId, active: true, phase: delta.type === 'text_delta' ? 'text' : 'thinking', text, now } : null;
  }
  if (delta.type === 'toolcall_delta') {
    const source = typeof block?.partialJson === 'string' ? block.partialJson : typeof delta.delta === 'string' ? delta.delta : '';
    return { taskId, active: true, phase: 'toolArgs', tool: toolName(block?.name), text: tail(source), now };
  }
  return null;
}

export function tapStreams(onUpdate, { global = globalThis, onUnsupported = () => {}, clock = Date.now } = {}) {
  const sessions = new WeakMap();
  const listener = (session, event) => {
    let taskId = sessions.get(session);
    if (taskId === undefined) {
      taskId = childTask.exec(session.sessionFile ?? '')?.[1] ?? null;
      sessions.set(session, taskId);
    }
    if (!taskId) return;
    const update = activityUpdate(taskId, event, clock());
    if (update) onUpdate(update);
  };
  const state = hub(global);
  state.listeners.add(listener);
  let installed = false;
  let reported = false;
  let stopped = false;
  const install = () => {
    if (stopped || installed) return installed;
    const result = patch(global);
    installed = result === 'installed';
    if (result === 'unsupported' && !reported) {
      reported = true;
      onUnsupported();
    }
    return installed;
  };
  if (!install()) global[BARREL]?.promise?.then(install, () => {});
  return {
    retry: install,
    installed: () => installed,
    stop: () => {
      stopped = true;
      installed = false;
      state.listeners.delete(listener);
      restore(global);
    },
  };
}
