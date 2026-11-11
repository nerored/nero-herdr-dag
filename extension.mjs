import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DagPane } from './src/controller.mjs';
import { createHerdr, herdrSession } from './src/herdr.mjs';
import { readEnv } from './src/env.mjs';
import { resolveViewerRuntime } from './src/runtime.mjs';
import { tapStreams } from './src/stream-tap.mjs';
import { resolveTaskStateDirs } from './src/task-data.mjs';

export default function extension(pi) {
  if (!herdrSession()) return;
  let controller;
  let unsubscribe;
  let streams;
  const viewer = join(dirname(fileURLToPath(import.meta.url)), 'src', 'viewer.mjs');
  const stateDir = readEnv().stateDir;

  async function stop() {
    unsubscribe?.();
    unsubscribe = undefined;
    streams?.stop();
    streams = undefined;
    await controller?.stop();
    controller = undefined;
  }

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    await stop();
    if (/[/\\]senpi-task[/\\]children[/\\]/.test(ctx.sessionManager.getSessionFile?.() ?? '')) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = pi.cwd ?? process.cwd();
    const taskStateDirs = resolveTaskStateDirs({
      sessionFile: ctx.sessionManager.getSessionFile?.(),
      env: process.env,
      cwd,
      sessionId,
    });
    const sessionEnv = readEnv();
    controller = new DagPane({
      sessionId,
      parentPane: sessionEnv.herdrPaneId,
      socket: sessionEnv.herdrSocketPath,
      stateDir,
      cwd,
      node: () => resolveViewerRuntime(),
      viewer,
      herdr: createHerdr(),
      notify: message => ctx.ui.notify(message, 'warning'),
      taskStateDirs,
      taskStateDir: taskStateDirs[0]?.root,
      sessionFile: ctx.sessionManager.getSessionFile?.(),
    });
    const owner = controller;
    streams = tapStreams(
      update => owner.receiveStream(update),
      { onUnsupported: () => ctx.ui.notify('DAG Studio: streaming output is unavailable; task cards use the normal progress line.', 'warning') },
    );
    unsubscribe = pi.events.on('senpi:extension-rpc-event', event => {
      if (event?.name !== 'omo.dag.updated' && event?.name !== 'omo.task.updated') return;
      streams?.retry();
      try {
        const promise = event.name === 'omo.dag.updated' ? controller?.receive(event.data) : controller?.receiveTasks(event.data);
        void promise?.catch(() => {});
      } catch (error) {
        ctx.ui.notify(`DAG Studio: ${error.message}`, 'warning');
      }
    });
    await controller.start().catch(() => {});
  });

  pi.on('session_shutdown', stop);
  pi.registerCommand('dag-studio', {
    description: 'Open or reopen the current session DAG Studio pane',
    handler: async (_args, ctx) => {
      if (!controller) return ctx.ui.notify('DAG Studio is unavailable in this session.', 'warning');
      await controller.open().catch(() => {});
    },
  });
}
