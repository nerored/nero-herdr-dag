import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  languages, languageLabel, messages, normalizeLanguage, statusLabel, t,
} from '../src/i18n.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function placeholders(template) {
  return [...new Set([...template.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort();
}

function splitTopLevel(body) {
  const args = [];
  let depth = 0;
  let quote;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      args.push(body.slice(start, index));
      start = index + 1;
    }
  }
  args.push(body.slice(start));
  return args;
}

// Second-argument string literals of every t() call. Comparison operands in a
// ternary condition (`mode === 'demo'`) are not message keys and are stripped.
function tCallKeys(source) {
  const keys = new Set();
  for (let start = source.indexOf('t('); start !== -1; start = source.indexOf('t(', start + 2)) {
    if (start > 0 && /[\w$]/.test(source[start - 1])) continue;
    let depth = 0;
    let index = start + 1;
    let quote;
    let escaped = false;
    for (; index < source.length; index++) {
      const char = source[index];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (quote) { if (char === quote) quote = undefined; continue; }
      if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const args = splitTopLevel(source.slice(start + 2, index));
    if (args.length < 2) continue;
    const second = args[1].replace(/(?:===|!==|==|!=)\s*'(?:[^'\\]|\\.)*'/g, '');
    for (const match of second.matchAll(/'([^']+)'/g)) keys.add(match[1]);
  }
  return keys;
}

async function sourceTree(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceTree(path));
    else if (/\.(?:mjs|js)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test('English and Chinese message tables have the same keys', () => {
  assert.deepEqual(
    Object.keys(messages.en).sort(),
    Object.keys(messages.zh).sort(),
  );
  assert.deepEqual(languages.map(language => language.id), ['en', 'zh']);
});

test('translations keep placeholder sets and are non-empty in every language', () => {
  for (const key of Object.keys(messages.en)) {
    assert.equal(typeof messages.en[key], 'string', `en.${key} is a string`);
    assert.equal(typeof messages.zh[key], 'string', `zh.${key} is a string`);
    assert.ok(messages.en[key].trim(), `en.${key} is non-empty`);
    assert.ok(messages.zh[key].trim(), `zh.${key} is non-empty`);
    assert.deepEqual(
      placeholders(messages.zh[key]),
      placeholders(messages.en[key]),
      `zh.${key} placeholders match en.${key}`,
    );
  }
});

test('every literal t() key referenced in src exists in the English table', async () => {
  const directory = join(root, 'src');
  const missing = [];
  for (const file of await sourceTree(directory)) {
    const source = await readFile(file, 'utf8');
    if (!/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*'\.\/i18n\.mjs'/.test(source)) continue;
    for (const key of tCallKeys(source)) {
      if (!Object.hasOwn(messages.en, key)) missing.push(`${file.slice(root.length + 1)}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('no translation key is left unreferenced outside the message tables', async () => {
  let corpus = '';
  for (const directory of ['src', 'test', 'bin']) {
    for (const file of await sourceTree(join(root, directory))) {
      if (file.endsWith(join('src', 'i18n.mjs'))) continue;
      corpus += `\n${await readFile(file, 'utf8')}`;
    }
  }
  corpus += `\n${await readFile(join(root, 'extension.mjs'), 'utf8')}`;
  const dead = Object.keys(messages.en)
    .filter(key => !key.startsWith('status_'))
    .filter(key => !corpus.includes(`'${key}'`) && !corpus.includes(`"${key}"`));
  assert.deepEqual(dead, []);
});

test('translations interpolate values and fall back to English', () => {
  assert.equal(t('en', 'attempt', { count: 2 }), 'attempt 2');
  assert.equal(t('zh', 'attempt', { count: 2 }), '第 2 次');
  assert.equal(t('fr', 'settings'), 'SETTINGS');
  assert.equal(t('zh', 'settings'), '设置');
  assert.equal(t('zh', 'missing.key'), 'missing.key');
});

test('language and status identifiers normalize predictably', () => {
  assert.equal(normalizeLanguage('zh'), 'zh');
  assert.equal(normalizeLanguage('zh-cn'), 'zh');
  assert.equal(normalizeLanguage('zh_CN'), 'zh');
  assert.equal(normalizeLanguage('zh-CN'), 'zh');
  assert.equal(normalizeLanguage('en'), 'en');
  assert.equal(normalizeLanguage('fr'), 'en');
  assert.equal(normalizeLanguage(undefined), 'en');
  assert.equal(languageLabel('zh'), '中文');
  assert.equal(languageLabel('en'), 'English');
  assert.equal(statusLabel('zh', 'running'), '运行中');
  assert.equal(statusLabel('en', 'completed'), 'Completed');
});
