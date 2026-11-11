import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { readEnv } from './env.mjs';

const execute = promisify(execFile);

export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function shellCommand(args, platform = process.platform) {
  if (platform === 'win32') {
    return `& ${args.map(value => `'${String(value).replaceAll("'", "''")}'`).join(' ')}`;
  }
  return args.map(quote).join(' ');
}

function executableFile(path, platform = process.platform) {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}

export function resolveHerdrBin(env = process.env, platform = process.platform) {
  const { herdrBinPath: explicit, path } = readEnv(env);
  if (explicit && executableFile(explicit, platform)) return explicit;
  const name = platform === 'win32' ? 'herdr.exe' : 'herdr';
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (executableFile(candidate, platform)) return candidate;
  }
  return null;
}

export function herdrSession(env = process.env, platform = process.platform) {
  const { herdrEnabled, herdrPaneId, herdrSocketPath } = readEnv(env);
  if (!herdrEnabled || !herdrPaneId || !herdrSocketPath) return false;
  if (!existsSync(herdrSocketPath)) return false;
  return Boolean(resolveHerdrBin(env, platform));
}

export function createHerdr(env = process.env) {
  return async (...args) => {
    const bin = resolveHerdrBin(env);
    if (!bin) throw new Error('Herdr is not available in this session');
    const { stdout } = await execute(bin, ['pane', ...args], {
      env, timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
    });
    if (!stdout.trim()) return {};
    const reply = JSON.parse(stdout);
    if (reply.error) throw new Error(reply.error.message ?? JSON.stringify(reply.error));
    return reply.result;
  };
}
