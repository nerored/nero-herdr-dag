import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DagPane } from './src/controller.mjs';
import { createHerdr, herdrSession } from './src/herdr.mjs';
import { readEnv } from './src/env.mjs';
import { generationPointer } from './src/layout.mjs';
import { resolveViewerRuntime } from './src/runtime.mjs';
import { tapStreams } from './src/stream-tap.mjs';
import { resolveTaskStateDirs } from './src/task-data.mjs';

// The installer places this module at
// <agent-dir>/herdr-dag-studio/integration/generation-NNNNNN/extension.mjs and
// writes current.json in the integration directory beside the generation. A
// checkout load has neither, so the pane-generation check is simply unavailable
// there.
export function installLocation(moduleUrl) {
  const dir = dirname(fileURLToPath(moduleUrl));
  const generation = /^generation-\d+$/.test(basename(dir)) ? basename(dir) : undefined;
  return {
    generation,
    pointer: generation === undefined ? undefined : generationPointer(dirname(dir)),
  };
}

export default function extension(pi, { moduleUrl = import.meta.url } = {}) {
  if (!herdrSession()) return;
  let controller;
  let unsubscribe;
  let streams;
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const viewer = join(moduleDir, 'src', 'viewer.mjs');
  const installed = installLocation(moduleUrl);
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
      installGeneration: installed.generation,
      generationFile: installed.pointer,
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
