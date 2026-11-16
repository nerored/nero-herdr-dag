import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The three architecture maps are hand-written prose, so this check reads them
// as text instead of importing anything. It pins the structural contract only:
// every current src module is named exactly once per map, and no map names a
// module that no longer exists. Wording and grouping stay free to change.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MAPS = [
  { name: 'README.md', start: 'Modules are grouped by role.', end: '### v3 snapshot' },
  { name: 'README_ZH.md', start: '模块按职责分组', end: '## 性能' },
  { name: 'docs/PLAN.md', start: '## 7. 模块地图', end: '## 8. ' },
];

async function currentModules() {
  const entries = await readdir(join(root, 'src'), { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))
    .map(entry => entry.name)
    .sort();
}

function mapSection(text, map) {
  const from = text.indexOf(map.start);
  assert.notEqual(from, -1, `${map.name}: map section start ${JSON.stringify(map.start)} is missing`);
  const to = text.indexOf(map.end, from + map.start.length);
  assert.notEqual(to, -1, `${map.name}: map section end ${JSON.stringify(map.end)} is missing`);
  return text.slice(from, to);
}

function moduleCounts(section) {
  const counts = new Map();
  for (const match of section.matchAll(/\bsrc\/([A-Za-z0-9_.-]+)\.mjs\b/g)) {
    counts.set(`${match[1]}.mjs`, (counts.get(`${match[1]}.mjs`) ?? 0) + 1);
  }
  return counts;
}

const modules = await currentModules();
const maps = [];
for (const map of MAPS) {
  const text = await readFile(join(root, map.name), 'utf8');
  maps.push({ name: map.name, counts: moduleCounts(mapSection(text, map)) });
}

test('each architecture map names every current src module exactly once', () => {
  for (const map of maps) {
    const missing = modules.filter(name => !map.counts.has(name));
    const duplicates = modules
      .filter(name => (map.counts.get(name) ?? 0) > 1)
      .map(name => `${name} x${map.counts.get(name)}`);
    const stale = [...map.counts.keys()].filter(name => !modules.includes(name));
    assert.deepEqual(
      { missing, duplicates, stale },
      { missing: [], duplicates: [], stale: [] },
      `${map.name}: modules=${modules.length}, mapped=${map.counts.size}`,
    );
  }
});

test('English and Chinese maps agree structurally', () => {
  const [readme, readmeZh] = maps;
  assert.deepEqual(
    [...readme.counts.keys()].sort(),
    [...readmeZh.counts.keys()].sort(),
    'README.md and README_ZH.md must list the same module set',
  );
  assert.deepEqual(
    [...readme.counts.entries()].map(([name, count]) => `${name}:${count}`).sort(),
    [...readmeZh.counts.entries()].map(([name, count]) => `${name}:${count}`).sort(),
    'README.md and README_ZH.md must agree on each module count',
  );
});
