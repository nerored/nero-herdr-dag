import { readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectLayout, marker, optionalText, parseArgs, pruneStaleStages, removeManagedTree,
  verifyManagedContainer,
} from './install-lib.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main(argv) {
  const { agentDir, dryRun, keepGenerations } = parseArgs(argv, { command: 'uninstall' });
  const layout = await inspectLayout(agentDir);
  const { container, wrapper } = layout;
  const containerInode = layout.inodes.get(container);

  const wrapperText = await optionalText(wrapper);
  if (wrapperText !== undefined && !wrapperText.startsWith(marker)) {
    throw new Error(`Refusing to remove an unrelated user file: ${wrapper}`);
  }

  let entries;
  try { entries = await readdir(container); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (entries && (await optionalText(join(container, '.installed-by'))) !== marker) {
    throw new Error(`This directory is not managed by herdr-dag-studio: ${container}`);
  }

  const plan = {
    installed: wrapperText !== undefined || entries !== undefined,
    source,
    agentDir,
    container: entries !== undefined ? container : undefined,
    extension: wrapperText !== undefined ? wrapper : undefined,
    policy: `install keeps up to ${Math.max(1, keepGenerations)} generation(s)`,
    preserved: 'user config and state are left untouched',
  };

  if (!plan.installed || dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  // Re-check ownership immediately before the destructive calls, then move the
  // exact inspected directory aside and delete that inode rather than whatever
  // path-based recursion would find afterwards.
  await verifyManagedContainer(container, containerInode);
  const stages = await pruneStaleStages(container);
  const aside = `${container}.removing-${randomUUID()}`;
  await rename(container, aside);
  // Prove the moved directory is still the verified inode; anything else is
  // left alone instead of being recursively deleted.
  await verifyManagedContainer(aside, containerInode);

  if (wrapperText !== undefined) await removeManagedTree(wrapper);
  await removeManagedTree(aside);
  // The studio directory is ours when it is empty after the container is gone;
  // leave it (and any foreign entry) untouched otherwise.
  const studio = dirname(container);
  const leftover = await readdir(studio).catch(() => []);
  if (leftover.length === 0) await rm(studio, { recursive: true, force: true });

  console.log(JSON.stringify({
    ...plan,
    removed: true,
    ...(stages.length ? { staged: stages } : {}),
  }, null, 2));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`uninstall: ${error.message}`);
  process.exitCode = 1;
}
