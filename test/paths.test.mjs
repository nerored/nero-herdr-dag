import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { projectKey } from '../src/omo.mjs';
import { ENV_NAMES, readEnv } from '../src/env.mjs';
import { resolveTaskStateDir, resolveTaskStateDirs } from '../src/task-data.mjs';

const hostSession = '/home/u/.omo/agent/projects/demo-d1641f7ebb40/senpi-task/children/st_01a1c400/sessions/st_01a1c400/2026.jsonl';
const hostRoot = '/home/u/.omo/agent/projects/demo-d1641f7ebb40/senpi-task';
const agentStore = cwd => join(homedir(), '.omo', 'agent', 'projects', projectKey(cwd), 'senpi-task');

test('explicit task state env wins over the session file and cwd', () => {
  assert.equal(resolveTaskStateDir({
    sessionFile: hostSession,
    env: { OMO_HERDR_DAG_STUDIO_TASK_STATE_DIR: '/tmp/explicit-store' },
    cwd: '/work',
  }), '/tmp/explicit-store');
  const roots = resolveTaskStateDirs({
    sessionFile: hostSession,
    env: { OMO_HERDR_DAG_STUDIO_TASK_STATE_DIR: '/tmp/explicit-store' },
    cwd: '/work',
  });
  assert.deepEqual(roots.map(root => root.root), ['/tmp/explicit-store']);
  assert.equal(roots[0].origin, 'explicit');
});

test('task state env is trimmed and ~ is expanded', () => {
  assert.equal(resolveTaskStateDir({
    env: { OMO_HERDR_DAG_STUDIO_TASK_STATE_DIR: '  ~/custom/senpi-task/  ' },
  }), join(homedir(), 'custom', 'senpi-task'));
  assert.equal(resolveTaskStateDir({
    env: { OMO_HERDR_DAG_STUDIO_TASK_STATE_DIR: '   ' },
    cwd: '/work',
  }), agentStore('/work'));
});

test('task-store variables are parsed by the shared env reader', () => {
  const env = readEnv({
    [ENV_NAMES.TASK_STATE_DIRS]: `/tmp/a${delimiter}  ~/b/  `,
    [ENV_NAMES.TASK_STATE_DIR]: '  ~/ignored  ',
  });
  assert.deepEqual(env.taskStateDirs, ['/tmp/a', join(homedir(), 'b')]);
  assert.equal(env.taskStateDir, join(homedir(), 'ignored'));
});

test('a delimiters-only multi-root override falls back to the single root', () => {
  assert.equal(resolveTaskStateDir({
    env: {
      [ENV_NAMES.TASK_STATE_DIRS]: `${delimiter}${delimiter}`,
      [ENV_NAMES.TASK_STATE_DIR]: '/tmp/single-store',
    },
    cwd: '/work',
  }), '/tmp/single-store');
});

test('explicit multi-root env is ordered, trimmed, expanded, and exclusive', () => {
  const roots = resolveTaskStateDirs({
    sessionFile: hostSession,
    env: { OMO_HERDR_DAG_STUDIO_TASK_STATE_DIRS: `/tmp/a${delimiter}  ~/b/  ` },
    cwd: '/work',
  });
  assert.deepEqual(roots.map(root => root.root), ['/tmp/a', join(homedir(), 'b')]);
  assert.ok(roots.every(root => root.origin === 'explicit'));
  assert.notDeepEqual(roots.map(root => root.id), [roots[0].id, roots[0].id]);
});

test('duplicate explicit roots collapse to one descriptor', () => {
  const roots = resolveTaskStateDirs({
    env: { OMO_HERDR_DAG_STUDIO_TASK_STATE_DIRS: `/tmp/a${delimiter}/tmp/a/` },
    cwd: '/work',
  });
  assert.equal(roots.length, 1);
  assert.equal(roots[0].root, '/tmp/a');
});

test('session file derives the host project store root before /senpi-task/', () => {
  assert.equal(resolveTaskStateDir({ sessionFile: hostSession, env: {}, cwd: '/work' }), hostRoot);
  assert.equal(resolveTaskStateDir({ sessionFile: ` ${hostSession} `, env: {}, cwd: '/work' }), hostRoot);
  assert.equal(resolveTaskStateDir({ sessionFile: hostRoot, env: {}, cwd: '/work' }), hostRoot);
  const roots = resolveTaskStateDirs({ sessionFile: hostSession, env: {}, cwd: '/work' });
  assert.equal(roots[0].root, hostRoot);
  assert.equal(roots[0].origin, 'session');
  assert.equal(roots.filter(root => root.root === hostRoot).length, 1);
});

test('missing or unrelated session file falls back to the host project store', () => {
  assert.equal(resolveTaskStateDir({ env: {}, cwd: '/work' }), agentStore('/work'));
  assert.equal(resolveTaskStateDir({ sessionFile: '/tmp/session.jsonl', env: {}, cwd: '/work' }),
    agentStore('/work'));
  assert.equal(resolveTaskStateDir({ sessionFile: '', env: {}, cwd: '/work' }),
    agentStore('/work'));
});

test('automatic roots read the host project store, never the repository store', () => {
  const roots = resolveTaskStateDirs({
    sessionFile: '/home/nero/.omo/agent/sessions/--home-nero-projects-github-nero-herdr-dag--/2026-11-09T09-01-40-289Z_01a1bf8a-b241-7c95-8e04-d36830a6755a.jsonl',
    env: { OMO_CODING_AGENT_DIR: '/home/nero/.omo/agent' },
    cwd: '/home/nero/projects/github/nero-herdr-dag',
  });
  assert.deepEqual(roots.map(root => root.root), [
    '/home/nero/.omo/agent/projects/nero-herdr-dag-d1641f7ebb40/senpi-task',
  ]);
  assert.deepEqual(roots.map(root => root.origin), ['agent-project']);
  assert.ok(roots.every(root => /^[a-z-]+-[0-9a-f]{8}$/.test(root.id)));
});

test('projectKey mirrors the host project directory name', () => {
  assert.equal(projectKey('/home/nero/projects/github/nero-herdr-dag'), 'nero-herdr-dag-d1641f7ebb40');
  const odd = join(tmpdir(), 'unsafe name!');
  assert.match(projectKey(odd), /^unsafe_name_-[\da-f]{12}$/);
});

test('legacy flat agent root only joins when it holds current-session records', async t => {
  const base = await mkdtemp(join(tmpdir(), 'dag-paths-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const agentDir = join(base, 'agent');
  const legacy = join(agentDir, 'senpi-task');
  const cwd = join(base, 'work');
  await mkdir(cwd, { recursive: true });
  assert.equal(resolveTaskStateDirs({ env: { OMO_CODING_AGENT_DIR: agentDir }, cwd }).length, 1);
  await mkdir(join(legacy, 'tasks'), { recursive: true });
  const { writeJson } = await import('../src/storage.mjs');
  await writeJson(join(legacy, 'tasks', 'st_one.json'), {
    task_id: 'st_one', parent_session_id: 'session-1', status: 'completed',
  });
  const roots = resolveTaskStateDirs({ env: { OMO_CODING_AGENT_DIR: agentDir }, cwd, sessionId: 'session-1' });
  assert.equal(roots.at(-1).origin, 'agent');
  assert.equal(roots.at(-1).root, legacy);
  assert.equal(resolveTaskStateDirs({ env: { OMO_CODING_AGENT_DIR: agentDir }, cwd, sessionId: 'other' }).length, 1);
});

test('the legacy probe notices records added after an earlier resolution', async t => {
  const base = await mkdtemp(join(tmpdir(), 'dag-paths-cache-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const agentDir = join(base, 'agent');
  const legacy = join(agentDir, 'senpi-task');
  const cwd = join(base, 'work');
  await mkdir(cwd, { recursive: true });
  assert.equal(resolveTaskStateDirs({ env: { OMO_CODING_AGENT_DIR: agentDir }, cwd, sessionId: 'session-1' }).length, 1);

  const { writeJson } = await import('../src/storage.mjs');
  await writeJson(join(legacy, 'tasks', 'st_late.json'), {
    task_id: 'st_late', parent_session_id: 'session-1', status: 'completed',
  });
  const roots = resolveTaskStateDirs({ env: { OMO_CODING_AGENT_DIR: agentDir }, cwd, sessionId: 'session-1' });
  assert.equal(roots.length, 2);
  assert.equal(roots.at(-1).origin, 'agent');
  assert.equal(roots.at(-1).root, legacy);
  assert.equal(resolveTaskStateDirs({ env: { OMO_CODING_AGENT_DIR: agentDir }, cwd, sessionId: 'other' }).length, 1);
});

test('missing candidate roots still yield descriptors without throwing', () => {
  const roots = resolveTaskStateDirs({
    env: { OMO_CODING_AGENT_DIR: '/definitely/missing/agent' },
    cwd: '/definitely/missing/work',
    sessionId: 'session-1',
  });
  assert.equal(roots.length, 1);
  assert.equal(roots[0].origin, 'agent-project');
});
