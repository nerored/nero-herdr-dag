// Shared install/uninstall surface. Keeping the parser, the layout inspection
// and the filesystem gates in one module means the destructive path and the
// write path cannot drift apart: every guard that protects a write also
// protects a removal.
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export const marker = '// managed by herdr-dag-studio';
export const entry = 'omo-herdr-dag-studio.js';
export const DEFAULT_KEEP_GENERATIONS = 2;

const generationPattern = /^generation-(\d+)$/;

export function parseArgs(argv, { command = 'install', env = process.env, home = homedir() } = {}) {
  const tokens = [...argv];
  if (tokens[0] === command) tokens.shift();
  let rawAgentDir;
  let dryRun = false;
  let keepGenerations = DEFAULT_KEEP_GENERATIONS;
  const readKeep = value => {
    if (value === undefined || !/^\d+$/.test(value)) {
      throw new Error('--keep-generations requires a non-negative integer');
    }
    return Number(value);
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '--dry-run') { dryRun = true; continue; }
    if (token === '--keep-generations') {
      keepGenerations = readKeep(tokens[index + 1]);
      index++;
      continue;
    }
    if (token.startsWith('--keep-generations=')) {
      keepGenerations = readKeep(token.slice('--keep-generations='.length));
      continue;
    }
    if (token === '--agent-dir') {
      const value = tokens[index + 1];
      if (value === undefined || value.trim() === '' || value.startsWith('-')) {
        throw new Error('--agent-dir requires a value');
      }
      rawAgentDir = value;
      index++;
      continue;
    }
    if (token.startsWith('--agent-dir=')) {
      const value = token.slice('--agent-dir='.length);
      if (value.trim() === '') throw new Error('--agent-dir requires a value');
      rawAgentDir = value;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  const fallback = [env.OMO_CODING_AGENT_DIR, env.SENPI_CODING_AGENT_DIR, join(home, '.omo', 'agent')]
    .find(value => typeof value === 'string' && value.trim() !== '');
  const raw = rawAgentDir ?? fallback;
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
  return { agentDir: resolve(expanded), dryRun, keepGenerations };
}

export function isWithin(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function lstatOptional(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function realpathOptional(path) {
  try { return await realpath(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

// Resolve every component we are about to read, write, or remove and refuse
// symlinked components or targets whose real path leaves the agent directory.
// The returned `inodes` let a caller prove the container it inspected is still
// the container it is about to delete.
export async function inspectLayout(agentDir) {
  const studio = join(agentDir, 'herdr-dag-studio');
  const container = join(studio, 'integration');
  const extensions = join(agentDir, 'extensions');
  const wrapper = join(extensions, entry);
  const realAgent = (await realpathOptional(agentDir)) ?? agentDir;
  const checks = [
    [studio, 'studio directory', 'directory'],
    [container, 'integration directory', 'directory'],
    [extensions, 'extensions directory', 'directory'],
    [wrapper, 'extension entry', 'file'],
  ];
  const inodes = new Map();
  for (const [path, label, kind] of checks) {
    const info = await lstatOptional(path);
    if (info?.isSymbolicLink()) throw new Error(`Refusing to use ${label}: symlink at ${path}`);
    if (info && kind === 'directory' && !info.isDirectory()) {
      throw new Error(`Refusing to use ${label}: not a directory at ${path}`);
    }
    if (info && kind === 'file' && !info.isFile()) {
      throw new Error(`Refusing to use ${label}: not a file at ${path}`);
    }
    if (info && kind === 'directory') inodes.set(path, { dev: info.dev, ino: info.ino });
    const real = await realpathOptional(path);
    if (real !== undefined && !isWithin(realAgent, real)) {
      throw new Error(`Refusing to use ${label} outside the agent directory: ${path}`);
    }
  }
  return { studio, container, extensions, wrapper, inodes };
}

export async function optionalText(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export function sameInode(expected, actual) {
  return expected !== undefined && actual !== undefined
    && expected.dev === actual.dev && expected.ino === actual.ino;
}

// Prove the container is still the inode that was inspected and still carries
// this tool's ownership marker. Called immediately before the destructive
// calls; the caller moves the directory away and deletes that inode rather
// than whatever path-based recursion would find afterwards.
export async function verifyManagedContainer(container, inode) {
  const info = await lstatOptional(container);
  if (info?.isSymbolicLink()) throw new Error(`Refusing to remove: symlink appeared at ${container}`);
  if (inode !== undefined && !sameInode(inode, info)) {
    throw new Error(`Refusing to remove: the integration directory changed after inspection: ${container}`);
  }
  if ((await optionalText(join(container, '.installed-by'))) !== marker) {
    throw new Error(`Refusing to remove: ownership marker changed: ${container}`);
  }
}

// Write through an opened descriptor with O_NOFOLLOW so a component swapped to
// a symlink between the layout inspection and the write is refused instead of
// followed. The parent directory is re-checked on every call.
export async function writeFileNoFollow(path, text, { mode = 0o600, agentDir, kind } = {}) {
  if (agentDir !== undefined) {
    const parent = dirname(path);
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Refusing to write ${kind ?? 'file'}: unsafe parent at ${parent}`);
    }
    const real = await realpath(parent);
    if (!isWithin((await realpath(agentDir)), real)) {
      throw new Error(`Refusing to write ${kind ?? 'file'} outside the agent directory: ${path}`);
    }
  }
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(text); }
  finally { await handle.close(); }
}

// Create a leaf directory, failing when it already exists so a swapped
// directory can never be adopted as a fresh generation.
export async function mkdirExclusive(path, label, mode = 0o700) {
  try { await mkdir(path, { mode }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Refusing to reuse existing ${label}: ${path}`);
    throw error;
  }
}

export const generationNumbers = names => names
  .map(name => generationPattern.exec(name))
  .filter(Boolean)
  .map(match => Number(match[1]));

export const generationName = number => `generation-${String(number).padStart(6, '0')}`;

// Keep the newest `keep` generations (at least one) and always keep the
// generation current.json points at. Anything older is owned backup data.
// With dryRun the retention set is computed without removing anything.
export async function pruneGenerations(container, { keep, current, keepCurrent = true, dryRun = false, present } = {}) {
  let names;
  if (present !== undefined) {
    names = present;
  } else {
    try { names = await readdir(container); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { retained: current ? [current] : [], removed: [] };
    }
  }
  const existing = names.filter(name => generationPattern.test(name))
    .map(name => ({ name, number: Number(generationPattern.exec(name)[1]) }))
    .sort((a, b) => a.number - b.number)
    .map(item => item.name);
  // `current` may be the generation the installer is about to create, so it
  // participates in the retention window even when it is not on disk yet.
  const known = current && !existing.includes(current) ? [...existing, current] : existing;
  const keepWindow = Math.max(1, keep);
  const window = known.slice(-keepWindow);
  // When the current generation sits outside the newest window, keep it and
  // drop the newest non-current entry instead of retaining one extra copy.
  const retained = keepCurrent && current && !window.includes(current)
    ? [...window.slice(1), current].sort()
    : window;
  const generations = existing;
  const removed = [];
  if (dryRun) return { retained, removed: generations.filter(name => !retained.includes(name)) };
  for (const name of generations) {
    if (retained.includes(name)) continue;
    const path = join(container, name);
    const info = await lstatOptional(path);
    if (info?.isSymbolicLink() || !info?.isDirectory()) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(name);
  }
  return { retained, removed };
}

// Interrupted installs leave `integration.stage-*` siblings behind. They are
// owned when they carry the marker; remove those and leave anything else.
export async function pruneStaleStages(container) {
  const studio = dirname(container);
  const prefix = `${container.split(sep).pop()}.stage-`;
  let names;
  try { names = await readdir(studio); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const removed = [];
  for (const name of names.filter(candidate => candidate.startsWith(prefix))) {
    const path = join(studio, name);
    const info = await lstatOptional(path);
    if (info?.isSymbolicLink() || !info?.isDirectory()) continue;
    if ((await optionalText(join(path, '.installed-by'))) !== marker) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

export async function removeManagedTree(path) {
  const info = await lstatOptional(path);
  if (info === undefined) return;
  if (info.isSymbolicLink()) throw new Error(`Refusing to remove a symlink: ${path}`);
  await rm(path, { recursive: true, force: true });
}
