import { readFile } from 'node:fs/promises';

// Zero-width format characters survive trim() but remain invisible in a title.
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
const visible = value => value.replace(INVISIBLE, '').trim();
const sink = notify => typeof notify === 'function' ? notify : message => console.warn(message);

// OmO persists todo snapshots as custom JSONL events. A DAG run starts while
// exactly one todo item is in progress, so its timestamp can be matched to the
// task title the user saw in the TODO panel.
export function parseTodoEvents(text, notify) {
  const events = [];
  const warn = sink(notify);
  let warned = false;
  const warnOnce = message => {
    if (warned) return;
    warned = true;
    warn(message);
  };
  for (const line of String(text).split('\n')) {
    if (!line.includes('senpi.todo-state')) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.customType !== 'senpi.todo-state') continue;
    const at = Date.parse(record.timestamp);
    if (!Number.isFinite(at)) continue;
    const phases = record.data?.phases;
    if (!Array.isArray(phases)) {
      warnOnce('DAG Studio: ignored a todo-state record whose phases are not an array');
      continue;
    }
    const tasks = [];
    let malformed = false;
    for (const phase of phases) {
      if (!phase || typeof phase !== 'object') {
        malformed = true;
        continue;
      }
      if (phase.tasks == null) continue;
      if (!Array.isArray(phase.tasks)) {
        malformed = true;
        continue;
      }
      for (const task of phase.tasks) {
        if (!task || typeof task !== 'object') {
          malformed = true;
          continue;
        }
        tasks.push(task);
      }
    }
    if (malformed) warnOnce('DAG Studio: skipped malformed todo-state phases or tasks');
    const active = tasks.find(task => task.status === 'in_progress');
    const title = typeof active?.content === 'string' ? visible(active.content) : '';
    if (title) events.push({ at, title });
  }
  return events.sort((left, right) => left.at - right.at);
}

export async function loadTodoEvents(sessionFile, notify) {
  if (!sessionFile) return [];
  let text;
  try { text = await readFile(sessionFile, 'utf8'); }
  catch (error) {
    // A missing session file is normal; any other read failure must not look
    // indistinguishable from a session that simply has no todo snapshots.
    if (error?.code !== 'ENOENT') {
      sink(notify)(`DAG Studio: Cannot read todo state ${sessionFile}: ${error?.message ?? error}`);
    }
    return [];
  }
  return parseTodoEvents(text, notify);
}

// Use the latest snapshot at or before the run's creation time. If no snapshot
// existed yet, keep the producer's name instead of guessing from a later todo.
export function todoTitleAt(events, createdAt) {
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at)) return undefined;
  let title;
  for (const event of events) {
    if (event.at > at) break;
    title = event.title;
  }
  return title;
}

export function todoTitleForRun(run, events) {
  return todoTitleAt(events, run?.createdAt) ?? run?.todoTitle;
}
