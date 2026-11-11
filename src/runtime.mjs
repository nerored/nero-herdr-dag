import { execFile } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { readEnv } from './env.mjs';

const execute = promisify(execFile);
const probe = 'JSON.stringify({runtime:"herdr-dag-studio-runtime",node:process.versions.node??null,bun:process.versions.bun??null,path:process.execPath})';

function atLeast(version, major, minor = 0) {
  const match = /^(\d+)(?:\.(\d+))?/.exec(String(version ?? ''));
  if (!match) return false;
  const actualMajor = Number(match[1]);
  const actualMinor = Number(match[2] ?? 0);
  return actualMajor > major || (actualMajor === major && actualMinor >= minor);
}

export async function resolveViewerRuntime({ env = process.env, execPath = process.execPath, run = execute } = {}) {
  const override = readEnv(env).runtime;
  const candidates = override ? [override] : [
    ...(/^bun(?:\.exe)?$/i.test(basename(execPath)) ? [execPath] : []),
    'bun',
    ...(/^node(?:js)?(?:\.exe)?$/i.test(basename(execPath)) ? [execPath] : []),
    'node',
  ];
  for (const candidate of new Set(candidates)) {
    try {
      const { stdout } = await run(candidate, ['--eval', `console.log(${probe})`], {
        env, timeout: 5000, maxBuffer: 16_384,
      });
      const result = JSON.parse(stdout.trim());
      const bun = typeof result.bun === 'string' ? result.bun : '';
      const node = typeof result.node === 'string' ? result.node : '';
      const supported = bun ? atLeast(bun, 1, 4) : atLeast(node, 24);
      if (result.runtime === 'herdr-dag-studio-runtime' && supported &&
          typeof result.path === 'string' && isAbsolute(result.path)) return result.path;
    } catch { /* try the next candidate */ }
  }
  throw new Error('The DAG viewer requires Bun 1.4+ or Node.js 24+. Install bun on PATH or set OMO_HERDR_DAG_STUDIO_RUNTIME, then open the pane again.');
}

// Keep the previous export for callers installed from older generations.
export const resolveViewerNode = resolveViewerRuntime;
