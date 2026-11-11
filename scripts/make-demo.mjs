import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DemoEngine } from '../src/demo.mjs';
import { writeJson } from '../src/storage.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, 'demo', 'snapshot.json');

// `--at/--now <epoch-ms>` fixes the generation instant so repeated runs from
// unchanged demo content produce byte-identical snapshots. Defaults to the
// wall clock for live use.
function parseAt(argv) {
  let at;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      console.log('Usage: bun scripts/make-demo.mjs [--at EPOCH_MS | --now EPOCH_MS]');
      process.exit(0);
    }
    if (token === '--at' || token === '--now') {
      const value = argv[index + 1];
      if (value === undefined || value.trim() === '') throw new Error(`${token} requires an epoch in milliseconds`);
      at = parseEpoch(token, value);
      index++;
      continue;
    }
    const match = /^--(?:at|now)=(.*)$/.exec(token);
    if (match) {
      if (match[1].trim() === '') throw new Error(`${token.slice(0, token.indexOf('='))} requires an epoch in milliseconds`);
      at = parseEpoch(token.slice(0, token.indexOf('=')), match[1]);
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return at;
}

function parseEpoch(label, value) {
  if (!/^\d+$/.test(value)) throw new Error(`${label} requires an epoch in milliseconds, got: ${value}`);
  const at = Number(value);
  if (!Number.isSafeInteger(at)) throw new Error(`${label} is outside the safe integer range: ${value}`);
  return at;
}

try {
  const at = parseAt(process.argv.slice(2));
  const now = at ?? Date.now();
  const snapshot = new DemoEngine({ now, startOffset: 32_000 }).snapshot(now);
  await mkdir(dirname(path), { recursive: true });
  await writeJson(path, snapshot);
  console.log(`Wrote ${path} (${snapshot.runs.length} runs, ${snapshot.tasks.length} tasks).`);
} catch (error) {
  console.error(`make-demo: ${error.message}`);
  process.exitCode = 1;
}
