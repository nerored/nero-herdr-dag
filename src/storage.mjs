import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    // Write and fsync before the rename: otherwise the rename can survive a
    // crash while the file contents are still only in the page cache.
    handle = await open(temporary, 'w', 0o600);
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, path);
        break;
      } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 5) throw error;
        await delay(10 * 2 ** attempt);
      }
    }
  } catch (error) {
    if (handle) {
      try { await handle.close(); }
      catch (closeError) { error.cause = closeError; }
    }
    try { await rm(temporary, { force: true }); }
    catch (cleanupError) { error.cause = cleanupError; }
    throw error;
  }
}
