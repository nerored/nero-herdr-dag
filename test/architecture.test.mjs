import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Static architecture checks. The scan is deliberately dependency-free: it
// reads the shipped ESM sources as text, so it cannot be fooled by a module
// that is not imported at test time and it adds no parser dependency.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_TARGETS = ['src', 'test', 'scripts', 'bin', 'demo', 'extension.mjs'];

async function listMjs(target) {
  const absolute = join(root, target);
  const info = await stat(absolute);
  if (info.isFile()) return absolute.endsWith('.mjs') ? [absolute] : [];
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    files.push(...await listMjs(join(target, entry.name)));
  }
  return files;
}

const SELF = 'test/architecture.test.mjs';
const sources = new Map();
for (const target of SCAN_TARGETS) {
  for (const file of await listMjs(target)) {
    sources.set(relative(root, file), await readFile(file, 'utf8'));
  }
}

const IMPORT_FROM = /^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;
const SIDE_EFFECT_IMPORT = /^[ \t]*import\s+['"]([^'"]+)['"]/gm;
const EXPORT_FROM = /^[ \t]*export\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const FS_SPECIFIERS = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);

function importedNames(clause) {
  const names = new Set();
  const trimmed = clause.trim();
  const named = trimmed.match(/\{([\s\S]*)\}/);
  if (named) {
    for (const part of named[1].split(',')) {
      const bit = part.trim();
      if (!bit) continue;
      const source = bit.split(/\s+as\s+/)[0].trim();
      if (source) names.add(source);
    }
  }
  if (/\*\s+as\s+[A-Za-z_$][\w$]*/.test(trimmed)) names.add('*');
  const head = trimmed
    .replace(/\{[\s\S]*\}/, '')
    .replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, '')
    .trim()
    .replace(/,$/, '')
    .trim();
  if (head && /^[A-Za-z_$][\w$]*$/.test(head)) names.add('default');
  return [...names];
}

function parseImports(text) {
  const entries = [];
  for (const match of text.matchAll(IMPORT_FROM)) {
    entries.push({ kind: 'import', specifier: match[2], names: importedNames(match[1]) });
  }
  for (const match of text.matchAll(SIDE_EFFECT_IMPORT)) {
    entries.push({ kind: 'side-effect', specifier: match[1], names: [] });
  }
  for (const match of text.matchAll(EXPORT_FROM)) {
    entries.push({ kind: 're-export', specifier: match[2], names: importedNames(match[1]) });
  }
  for (const match of text.matchAll(DYNAMIC_IMPORT)) {
    entries.push({ kind: 'dynamic', specifier: match[1], names: ['*'] });
  }
  return entries;
}

function resolveTarget(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  return relative(root, resolve(root, dirname(fromFile), specifier));
}

function renderBoundaryViolations(file, text) {
  const violations = [];
  for (const entry of parseImports(text)) {
    const target = resolveTarget(file, entry.specifier);
    if (target === 'src/viewer.mjs' || target?.endsWith('/viewer.mjs')) {
      violations.push(`${file} imports the viewer (${entry.kind} ${entry.specifier})`);
    }
    if (FS_SPECIFIERS.has(entry.specifier)) {
      violations.push(`${file} imports the filesystem (${entry.kind} ${entry.specifier})`);
    }
  }
  return violations;
}

function assertRenderBoundary(file, text) {
  const violations = renderBoundaryViolations(file, text);
  assert.deepEqual(violations, [], `render must stay a pure frame module:\n${violations.join('\n')}`);
}

function declaredExports(file) {
  const text = sources.get(file) ?? '';
  const names = new Set();
  for (const match of text.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/^export\s*\{([^}]*)\}(?:\s*from\s*['"][^'"]+['"])?/gm)) {
    for (const part of match[1].split(',')) {
      const bit = part.trim();
      if (!bit) continue;
      const name = bit.split(/\s+as\s+/).pop().trim();
      if (name && name !== 'default') names.add(name);
    }
  }
  return names;
}

// The viewer is allowed to call the frame entry point and the pure helpers
// that build its inputs. It must not reach into render's private layout or
// drawing internals: that is the seam the view-model work will formalize.
const RENDER_PUBLIC_API = Object.freeze([
  'renderApp',
  'detailsSubjectKey',
  'dashboardLayout',
  'diagnosisForSelection',
  'navTasks',
  'recordForSelection',
  'snapshotFreshness',
  'switcherView',
  'taskAtPoint',
]);

function occurrences(line, name) {
  return line.match(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g'))?.length ?? 0;
}

function referenceCounts(file, name, { local = false } = {}) {
  const lines = sources.get(file).split('\n');
  const declaration = lines.findIndex(line =>
    new RegExp(`(?:function|const|let|class)\\s+${name.replace(/\$/g, '\\$')}\\b|^export\\s*\\{[^}]*\\b${name.replace(/\$/g, '\\$')}\\b`).test(line));
  let internal = 0;
  let production = 0;
  let test = 0;
  for (const [other, text] of sources) {
    // The GAP-9 table names these symbols; it is not a reader of them.
    if (other === SELF) continue;
    // A module-local symbol can only be read inside its own module; the same
    // word in another file is a different binding.
    if (local && other !== file) continue;
    const otherLines = text.split('\n');
    for (let index = 0; index < otherLines.length; index += 1) {
      if (other === file && index === declaration) continue;
      const count = occurrences(otherLines[index], name);
      if (!count) continue;
      if (other === file) internal += count;
      else if (other.startsWith('test/')) test += count;
      else production += count;
    }
  }
  return { internal, production, test };
}

// GAP-9 in .omo/plans/quality-and-next.md. Task 26 deleted every symbol; this
// list now pins the removal so a reintroduced export or lookup fails the scan.
const GAP9_REMOVED = Object.freeze([
  { name: 'normalizeProvenance', file: 'src/model.mjs', kind: 'export' },
  { name: 'taskStatusCounts', file: 'src/model.mjs', kind: 'export' },
  { name: 'percentOf', file: 'src/model.mjs', kind: 'export' },
  { name: 'projectNode', file: 'src/model.mjs', kind: 'export' },
  { name: 'taskForNode', file: 'src/model.mjs', kind: 'export' },
  { name: 'graphHeight', file: 'src/graph.mjs', kind: 'export' },
  { name: 'GRAPH_FILTERS', file: 'src/cockpit.mjs', kind: 'export' },
]);

const MATRIX_MODULES = [
  'src/render.mjs',
  'src/viewer.mjs',
  'src/model.mjs',
  'src/graph.mjs',
  'src/task-data.mjs',
  'src/cockpit.mjs',
];

function boundaryMatrix() {
  return MATRIX_MODULES.map(file => {
    const entries = parseImports(sources.get(file));
    const targets = entries
      .map(entry => resolveTarget(file, entry.specifier))
      .filter(target => target && MATRIX_MODULES.includes(target));
    const fs = entries.some(entry => FS_SPECIFIERS.has(entry.specifier)) ? 'fs' : '';
    return { file, imports: [...new Set(targets)].sort(), fs };
  });
}

test('render never imports the viewer or the filesystem', () => {
  const entries = parseImports(sources.get('src/render.mjs'));
  // Guard the scan itself: an empty parse would make the boundary vacuous.
  assert.ok(
    entries.some(entry => resolveTarget('src/render.mjs', entry.specifier) === 'src/model.mjs'),
    'the import scan must see render -> model',
  );
  assertRenderBoundary('src/render.mjs', sources.get('src/render.mjs'));
});

test('the boundary scan rejects a synthetic render -> viewer import', () => {
  const synthetic = "import { createViewer } from './viewer.mjs';\n";
  assert.throws(
    () => assertRenderBoundary('src/render.mjs', synthetic),
    /render\.mjs imports the viewer/,
  );
});

test('the boundary scan rejects a synthetic render -> fs import', () => {
  const synthetic = "import { readFile } from 'node:fs/promises';\n";
  assert.throws(
    () => assertRenderBoundary('src/render.mjs', synthetic),
    /render\.mjs imports the filesystem/,
  );
});

test('viewer imports render only through the public frame API', () => {
  const renderExports = declaredExports('src/render.mjs');
  for (const name of RENDER_PUBLIC_API) {
    assert.ok(renderExports.has(name), `the public frame API names ${name}, but render does not export it`);
  }

  const imports = parseImports(sources.get('src/viewer.mjs'))
    .filter(entry => resolveTarget('src/viewer.mjs', entry.specifier) === 'src/render.mjs');
  assert.equal(imports.length, 1, 'viewer must have exactly one render import');
  const [entry] = imports;
  assert.equal(entry.kind, 'import', 'viewer must import render with a named import, not a side effect');
  assert.ok(!entry.names.includes('*'), 'viewer must not namespace-import render');
  assert.ok(!entry.names.includes('default'), 'render has no default export');
  assert.ok(entry.names.includes('renderApp'), 'viewer must draw through renderApp');

  const outside = entry.names.filter(name => !RENDER_PUBLIC_API.includes(name));
  assert.deepEqual(outside, [], `viewer reached past the public frame API: ${outside.join(', ')}`);
});

test('the GAP-9 dead and duplicate symbols are gone', t => {
  for (const spec of GAP9_REMOVED) {
    if (spec.kind === 'export') {
      assert.equal(declaredExports(spec.file).has(spec.name), false,
        `${spec.name} was deleted from ${spec.file}`);
    }
    const counts = referenceCounts(spec.file, spec.name, { local: spec.kind === 'local' });
    const readers = spec.kind === 'local'
      ? counts.internal
      : counts.internal + counts.production + counts.test;
    assert.equal(readers, 0, `${spec.name} still has a reader`);
  }

  // GAP-9 also calls out the duplicate lookup. The renderer now reads
  // model.nodeForTask, the one public task-to-node lookup.
  assert.equal(declaredExports('src/render.mjs').has('linkedNodeForTask'), false,
    'linkedNodeForTask must stay deleted');
  assert.ok(declaredExports('src/model.mjs').has('nodeForTask'), 'model.nodeForTask is the public lookup');
  const duplicate = referenceCounts('src/render.mjs', 'linkedNodeForTask');
  assert.equal(duplicate.internal + duplicate.production + duplicate.test, 0,
    'the private duplicate lookup must have no reader');

  t.diagnostic('architecture boundary matrix');
  for (const row of boundaryMatrix()) {
    t.diagnostic(`  ${row.file} -> ${row.imports.length ? row.imports.join(', ') : '(none)'}${row.fs ? ' [+fs]' : ''}`);
  }
  t.diagnostic('GAP-9 removed symbols');
  for (const spec of GAP9_REMOVED) t.diagnostic(`  ${spec.name} @ ${spec.file} ${spec.kind} removed`);
  t.diagnostic('duplicate lookup: render.linkedNodeForTask removed');
});

test('failure and diagnosis state vocabulary has one owner', () => {
  const model = sources.get('src/model.mjs');
  const diagnosis = sources.get('src/diagnosis.mjs');
  const subject = sources.get('src/render-subject.mjs');
  assert.match(model, /export const UNSUCCESSFUL_STATES/);
  assert.match(model, /export const isUnsuccessfulState/);
  assert.match(diagnosis, /new Set\(\[\.\.\.UNSUCCESSFUL_STATES, 'paused'\]\)/);
  assert.doesNotMatch(subject, /function isFailureState|function isUnsuccessfulState|UNSUCCESSFUL_STATES/);
  assert.equal((model.match(/(?:export )?const FAILED_STATES\s*=/g) ?? []).length, 1);
  assert.equal((model.match(/(?:export )?const UNSUCCESSFUL_STATES\s*=/g) ?? []).length, 1);
  assert.equal((model.match(/(?:export )?const isFailedState\s*=/g) ?? []).length, 1);
  assert.equal((model.match(/(?:export )?const isUnsuccessfulState\s*=/g) ?? []).length, 1);
});
