import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readEnv } from './env.mjs';

// DAG Studio owns only these state names: a 24-hex view key with a snapshot,
// pane-record, or view-state suffix, optionally followed by the UUID temp
// suffix storage.mjs uses before an atomic rename. Anything else in a
// user-configurable state directory belongs to the user or another tool.
const ownedName = /^[0-9a-f]{24}(?:\.pane\.json|\.json\.view\.json|\.json)(?:\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp)?$/i;

export function isOwnedSnapshotName(name) {
  return ownedName.test(name);
}

// Invalid values disable pruning (0) rather than selecting an arbitrary
// retention window; see the documented rule in src/env.mjs.
export function retentionDaysFromEnv(env = process.env) {
  return readEnv(env).retentionDays;
}

export async function pruneExpiredSnapshots(directory, { keepFiles = [], now = Date.now(), days, notify = () => {} } = {}) {
  if (!(days > 0)) return;
  let files;
  try { files = await readdir(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return; }
  const deadline = now - days * 86_400_000;
  for (const file of files) {
    if (!isOwnedSnapshotName(file)) continue;
    if (keepFiles.includes(file)) continue;
    const path = join(directory, file);
    try {
      const info = await lstat(path);
      if (!info.isFile()) continue;
      if (info.mtimeMs > deadline) continue;
      await rm(path, { force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') notify(error.message);
    }
  }
}
