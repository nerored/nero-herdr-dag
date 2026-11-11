#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const help = `Herdr DAG Studio — animated workflow dashboard for Herdr

Usage:
  dag-studio demo [--scenario early|late] [--fps 12] [--no-motion]
  dag-studio view --state PATH [--fps 12]
  dag-studio install [--dry-run] [--agent-dir PATH|--agent-dir=PATH]
  dag-studio uninstall [--dry-run] [--agent-dir PATH|--agent-dir=PATH]
  dag-studio --help
  dag-studio --version

Without --scenario, the demo starts 32 seconds into the cycle; early starts at
the beginning and late starts near the end. The demo needs no OmO or Herdr
installation. Start OmO inside a Herdr pane and run /dag-studio after installing
the extension.
`;

function viewerPath() {
  // Test seam: the signal probe needs a viewer it can observe for a forwarded
  // signal. Production falls through to the built or source viewer.
  if (process.env.DAG_STUDIO_VIEWER) return process.env.DAG_STUDIO_VIEWER;
  const built = join(root, 'dist', 'src', 'viewer.mjs');
  return existsSync(built) ? built : join(root, 'src', 'viewer.mjs');
}

// The viewer needs a real path after --state: a following option must not be
// mistaken for one, or a malformed invocation settles on a file named like the
// flag instead of reporting the usage error.
function requireStatePath(viewerArgs) {
  for (let index = 0; index < viewerArgs.length; index++) {
    if (viewerArgs[index] !== '--state') continue;
    const value = viewerArgs[index + 1];
    if (value === undefined || value.trim() === '' || value.startsWith('-')) {
      throw new Error('view requires --state PATH.');
    }
    return value;
  }
  throw new Error('view requires --state PATH.');
}

function launch(viewerArgs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [viewerPath(), ...viewerArgs], {
      stdio: 'inherit',
      env: process.env,
    });
    let childExited = false;
    const handlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();
      process.off('exit', killOnExit);
    };
    const killChild = signal => {
      if (childExited) return;
      try { child.kill(signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    // Forward the terminating signal instead of dying and orphaning the viewer.
    for (const signal of forwardedSignals) {
      const handler = () => killChild(signal);
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    // Belt and braces for any explicit process.exit() path: never leave the
    // child behind, even when the exit event cannot wait for it.
    const killOnExit = () => killChild('SIGTERM');
    process.on('exit', killOnExit);
    child.on('exit', (code, signal) => {
      childExited = true;
      cleanup();
      process.exitCode = signal ? 128 + (constants.signals[signal] ?? 0) : code ?? 0;
      resolve();
    });
    child.on('error', error => {
      childExited = true;
      cleanup();
      console.error(`dag-studio: ${error.message}`);
      process.exitCode = 1;
      resolve();
    });
  });
}

try {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(help);
  } else if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
    console.log(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
  } else if (args[0] === 'demo') {
    await launch(['--demo', ...args.slice(1)]);
  } else if (args[0] === 'view') {
    const viewerArgs = args.slice(1);
    requireStatePath(viewerArgs);
    await launch(viewerArgs);
  } else if (args[0] === 'install' || args[0] === 'uninstall') {
    const script = `${args[0]}.mjs`;
    // Scripts shipped next to the sources stay live with the checkout; the
    // dist copy is the fallback for a minimal installed package.
    const scriptRoot = process.env.DAG_STUDIO_SCRIPTS
      ?? (existsSync(join(root, 'scripts', script)) ? join(root, 'scripts') : join(root, 'dist', 'scripts'));
    await import(join(scriptRoot, script));
  } else {
    throw new Error(`Unknown command: ${args[0]}. Use --help.`);
  }
} catch (error) {
  console.error(`dag-studio: ${error.message}`);
  process.exitCode = 1;
}
