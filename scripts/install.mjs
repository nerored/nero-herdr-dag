import { constants, rmSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  entry, generationName, generationNumbers, inspectLayout, lstatOptional, marker,
  mkdirExclusive, optionalText, parseArgs, pruneGenerations, pruneStaleStages,
  writeFileNoFollow,
} from './install-lib.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Every path this run created and has not finished with. A signal or a thrown
// error must never leave a staged copy or a temp pointer behind.
const active = new Set();
const abandon = () => {
  for (const path of active) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  active.clear();
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    abandon();
    process.exit(128 + (osConstants.signals[signal] ?? 0));
  });
}

// Missing parents are created (recursively); an existing component is only
// accepted when it is a real directory, never a symlink.
async function ensureDirectory(path, label) {
  const info = await lstatOptional(path);
  if (info === undefined) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    return;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Refusing to use ${label}: not a real directory at ${path}`);
  }
}

async function main(argv) {
  const { agentDir, dryRun, keepGenerations } = parseArgs(argv);
  const layout = await inspectLayout(agentDir);
  const { container, wrapper } = layout;

  let entries;
  try { entries = await readdir(container); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const currentText = await optionalText(join(container, 'current.json'));
  const current = currentText === undefined ? undefined : JSON.parse(currentText).generation;
  if (currentText !== undefined && (typeof current !== 'string' || !/^generation-\d+$/.test(current))) {
    throw new Error(`Invalid installation generation: ${container}`);
  }
  if (current !== undefined && entries !== undefined && !entries.includes(current)) {
    throw new Error(`current.json points at a missing generation: ${current}`);
  }

  try {
    const content = await readFile(wrapper, 'utf8');
    if (!content.startsWith(marker)) throw new Error(`Refusing to overwrite an unrelated user file: ${wrapper}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (entries && (await optionalText(join(container, '.installed-by'))) !== marker) {
    throw new Error(`This directory is not managed by herdr-dag-studio: ${container}`);
  }

  const numbers = generationNumbers(entries ?? []);
  const generation = generationName(Math.max(0, ...numbers) + 1);
  const integration = join(container, generation);
  const previous = current ? join(container, current) : undefined;
  // Compute the post-install retention set up front so a dry run reports the
  // exact same set a real run would keep.
  const retention = await pruneGenerations(container, {
    keep: keepGenerations, current: generation, dryRun: true,
  });
  const plan = {
    installed: false,
    agentDir,
    integration,
    extension: wrapper,
    source,
    entry,
    keepGenerations,
    retained: retention.retained,
    ...(previous ? { backup: previous } : {}),
    activation: 'Start a new OmO session or run /reload, then use /dag-studio.',
  };

  if (dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  await ensureDirectory(agentDir, 'agent directory');
  const studio = dirname(container);
  await ensureDirectory(studio, 'studio directory');
  await ensureDirectory(container, 'integration directory');
  await ensureDirectory(layout.extensions, 'extensions directory');
  // Re-check after mkdir so a component swapped for a symlink between the
  // read-only inspection and the first write is still refused.
  await inspectLayout(agentDir);

  // A previous run that died after staging but before renaming leaves an owned
  // copy behind; clear it before adding a new one.
  await pruneStaleStages(container);

  const stamp = randomUUID();
  const staged = `${container}.stage-${stamp}`;
  await mkdirExclusive(integration, 'integration generation');
  active.add(integration);
  await mkdirExclusive(staged, 'staging directory');
  active.add(staged);
  const pointerTmp = join(container, `current.json.tmp-${stamp}`);
  const wrapperTmp = `${wrapper}.tmp-${stamp}`;
  try {
    await cp(join(source, 'src'), join(staged, 'src'), { recursive: true });
    await cp(join(source, 'extension.mjs'), join(staged, 'extension.mjs'));
    await cp(join(source, 'LICENSE'), join(staged, 'LICENSE'));
    await writeFileNoFollow(join(staged, '.installed-by'), marker, { agentDir, kind: 'staged marker' });
    await writeFileNoFollow(join(container, '.installed-by'), marker, { agentDir, kind: 'container marker' });
    await rename(staged, integration);
    active.delete(staged);
    active.delete(integration);

    await writeFileNoFollow(pointerTmp, JSON.stringify({ generation }) + '\n', { agentDir, kind: 'generation pointer' });
    active.add(pointerTmp);
    await rename(pointerTmp, join(container, 'current.json'));
    active.delete(pointerTmp);

    const text = `${marker}\nexport { default } from '../herdr-dag-studio/integration/${generation}/extension.mjs';\n`;
    await writeFileNoFollow(wrapperTmp, text, { agentDir, kind: 'extension entry' });
    active.add(wrapperTmp);
    await rename(wrapperTmp, wrapper);
    active.delete(wrapperTmp);
  } finally {
    for (const path of [...active]) {
      await rm(path, { recursive: true, force: true });
      active.delete(path);
    }
  }

  const pruned = await pruneGenerations(container, {
    keep: keepGenerations, current: generation, present: [...(entries ?? []), generation],
  });
  console.log(JSON.stringify({
    ...plan,
    installed: true,
    retained: pruned.retained,
    ...(pruned.removed.length ? { removed: pruned.removed } : {}),
  }, null, 2));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  abandon();
  console.error(`install: ${error.message}`);
  process.exitCode = 1;
}
