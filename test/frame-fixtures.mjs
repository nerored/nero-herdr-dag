import { readFileSync } from 'node:fs';
import { normalizeSnapshot } from '../src/model.mjs';
import { renderApp } from '../src/render.mjs';
import { width as textWidth } from '../src/text.mjs';
import { baseUi, themeFor } from './helpers.mjs';

// The header paints the capture clock in local time. Pin the timezone as well
// as the instant, or a fixture generated in UTC fails on a CST laptop and the
// suite stops being deterministic.
process.env.TZ = 'UTC';

// Golden frame fixtures pin the exact painted text and the pointer hitbox map
// for every surface the renderer split will move. A fixed capture instant, a
// color-disabled theme, and motion disabled keep the frames deterministic: no
// clock, spinner, shimmer, or palette path can change a byte.

export const FIXED_NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
export const FIXED_TIME = 0;

export const FRAME_WIDTHS = [54, 70, 90, 111, 120];
export const FRAME_LANGUAGES = ['en', 'zh'];
export const FRAME_SURFACES = ['details', 'help', 'palette', 'switcher', 'settings', 'tour', 'plan'];

// The representative height per width follows the existing suite: 54x42 is
// the narrow duty QA size, 70x24 the short duty size, and 120x40 the wide
// investigation size. 111 exercises the last duty column before 112.
export const FRAME_HEIGHTS = Object.freeze({
  54: 42,
  70: 24,
  90: 30,
  111: 40,
  120: 40,
});

export const FRAME_DIR = new URL('./fixtures/frames/', import.meta.url);

const iso = ms => new Date(ms).toISOString();

// One deterministic snapshot rich enough to paint every surface: completed and
// running nodes, a pending node, two runs, live token rate and activity, and a
// spawned plan task carrying the task contract fields.
export function frameSnapshot() {
  return normalizeSnapshot({
    version: 3,
    mode: 'live',
    connected: true,
    sessionId: 'frame-fixture-0001',
    updatedAt: iso(FIXED_NOW),
    provenance: {
      origin: 'controller',
      statePath: '/tmp/herdr-dag/state.json',
      capturedAt: iso(FIXED_NOW),
    },
    runs: [
      {
        id: 'run_build',
        name: 'build pipeline',
        status: 'running',
        createdAt: iso(FIXED_NOW - 180_000),
        updatedAt: iso(FIXED_NOW - 1_000),
        nodes: [
          {
            id: 'intake', label: 'intake', state: 'completed', task_id: 'st_intake',
            percent: 100, startedAt: iso(FIXED_NOW - 170_000),
            completedAt: iso(FIXED_NOW - 150_000),
          },
          {
            id: 'api', label: 'build-api', state: 'running', task_id: 'st_api',
            percent: 62, startedAt: iso(FIXED_NOW - 140_000),
            tokenRate: [18, 24, 31, 42],
            activity: { phase: 'tool', tool: 'bash', since: FIXED_NOW - 3_000, lastAt: FIXED_NOW - 1_000 },
          },
          {
            id: 'tests', label: 'test-suite', state: 'pending', task_id: 'st_tests',
            percent: 0,
          },
        ],
        edges: [{ from: 'intake', to: 'api' }, { from: 'api', to: 'tests' }],
      },
      {
        id: 'run_docs',
        name: 'docs refresh',
        status: 'completed',
        createdAt: iso(FIXED_NOW - 360_000),
        updatedAt: iso(FIXED_NOW - 200_000),
        nodes: [{ id: 'docs', label: 'docs', state: 'completed', task_id: 'st_docs', percent: 100 }],
        edges: [],
      },
    ],
    tasks: [
      { id: 'st_intake', description: 'intake probe', status: 'completed', percent: 100 },
      {
        id: 'st_api', description: 'build the HTTP API', status: 'running', percent: 62,
        agent: 'coder', model: 'provider/model', tokensIn: 12_345, tokensOut: 6_789,
        tokenRate: [18, 24, 31, 42],
        activity: { phase: 'tool', tool: 'bash', since: FIXED_NOW - 3_000, lastAt: FIXED_NOW - 1_000 },
      },
      { id: 'st_tests', description: 'run the test suite', status: 'pending' },
      {
        id: 'st_plan', description: 'Execute plan todo 13', status: 'running', percent: 40,
        summary: 'Build golden frames', ownerKind: 'task', ownerTaskId: 'st_parent',
        executionMode: 'in-process', backgroundMode: 'background', depth: 2,
        planPath: '.omo/plans/quality-and-next.md', planRole: 'plan-executor',
        workdir: '/home/me/project', modelRequested: 'provider/requested',
        modelResolved: 'provider/resolved', runtimeMs: 120_000, tokensPerSecond: 42,
        costUsd: 0.0123, cacheHitRate: 0.75,
      },
    ],
  });
}

// UI overrides per surface. Everything else comes from the shared baseUi
// helper merged over these, so one test cannot leak folded nodes or toasts.
const surfaceUi = {
  details: { focus: 'graph', selectedNodeId: 'api', selectedTaskId: 'st_api' },
  help: { help: true },
  palette: { palette: true, paletteIndex: 0 },
  switcher: { switcher: { query: '' } },
  settings: { settingsMenu: true, settingsIndex: 1 },
  tour: { tour: 3 },
  plan: { focus: 'tasks', lastFocus: 'tasks', selectedNodeId: undefined, selectedTaskId: 'st_plan' },
};

export function frameUi(surface, language) {
  return baseUi({ motion: false, language, ...surfaceUi[surface] });
}

export function renderFixtureFrame(surface, language, width, height = FRAME_HEIGHTS[width]) {
  const { palette, theme } = themeFor(0);
  return renderApp(frameSnapshot(), frameUi(surface, language), {
    width,
    height,
    time: FIXED_TIME,
    now: FIXED_NOW,
    palette,
    theme,
  });
}

export function frameFixtureName(surface, language, width, height = FRAME_HEIGHTS[width]) {
  return `${surface}.${width}x${height}.${language}.json`;
}

export function frameFixturePath(surface, language, width, height = FRAME_HEIGHTS[width]) {
  return new URL(frameFixtureName(surface, language, width, height), FRAME_DIR);
}

const isRect = value => value !== null && typeof value === 'object' &&
  ['x', 'y', 'w', 'h'].every(key => typeof value[key] === 'number');

const sortedObject = entries => Object.fromEntries(
  [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
);

// Hitboxes mix Maps, plain objects, rects and nulls. Canonical JSON means a
// fixture diff cannot depend on insertion order and a rect stays one leaf
// (`nodes.api`) instead of four coordinate leaves.
function canonicalHitboxes(value) {
  if (value instanceof Map) {
    return sortedObject([...value].map(([key, entry]) => [key, canonicalHitboxes(entry)]));
  }
  if (isRect(value)) return { x: value.x, y: value.y, w: value.w, h: value.h };
  if (Array.isArray(value)) return value.map(canonicalHitboxes);
  if (value !== null && typeof value === 'object') {
    return sortedObject(Object.entries(value).map(([key, entry]) => [key, canonicalHitboxes(entry)]));
  }
  return value;
}

export function serializeFrame(result, { surface, language, width, height = FRAME_HEIGHTS[width] }) {
  return {
    surface,
    width,
    height,
    language,
    text: result.text.split('\n'),
    hitboxes: canonicalHitboxes(result.hitboxes),
  };
}

const flattenHitboxes = (value, prefix, out) => {
  if (isRect(value)) {
    out.set(prefix, value);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      flattenHitboxes(entry, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  out.set(prefix, value);
};

function hitboxLeaves(hitboxes) {
  const leaves = new Map();
  flattenHitboxes(canonicalHitboxes(hitboxes), '', leaves);
  return leaves;
}

// The column in terminal cells, not UTF-16 units, so a wide CJK glyph does not
// shift the reported column.
function cellColumn(line, index) {
  return textWidth(Array.from(line).slice(0, index).join(''));
}

function firstTextDifference(expectedLines, actualLines) {
  const rows = Math.max(expectedLines.length, actualLines.length);
  for (let row = 0; row < rows; row++) {
    const expected = expectedLines[row];
    const actual = actualLines[row];
    if (expected === actual) continue;
    if (expected === undefined || actual === undefined) {
      return {
        row,
        column: 0,
        expected: expected ?? null,
        actual: actual ?? null,
        expectedChar: null,
        actualChar: null,
      };
    }
    const expectedChars = Array.from(expected);
    const actualChars = Array.from(actual);
    let index = 0;
    while (index < expectedChars.length && index < actualChars.length &&
      expectedChars[index] === actualChars[index]) index++;
    return {
      row,
      column: cellColumn(expected, index),
      expected,
      actual,
      expectedChar: expectedChars[index] ?? null,
      actualChar: actualChars[index] ?? null,
    };
  }
  return null;
}

function firstHitboxDifference(expected, actual) {
  const expectedLeaves = hitboxLeaves(expected);
  const actualLeaves = hitboxLeaves(actual);
  const keys = [...new Set([...expectedLeaves.keys(), ...actualLeaves.keys()])].sort();
  for (const key of keys) {
    const before = expectedLeaves.get(key);
    const after = actualLeaves.get(key);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    return {
      key,
      expected: before ?? null,
      actual: after ?? null,
      row: (isRect(after) ? after.y : isRect(before) ? before.y : null),
      column: (isRect(after) ? after.x : isRect(before) ? before.x : null),
    };
  }
  return null;
}

// The hitboxes that contain the first differing text cell, sorted for stable
// failure messages. A text-only layout drift still names the pointer targets
// it moved through.
function hitboxesAt(hitboxes, row, column) {
  const hits = [];
  for (const [key, rect] of hitboxLeaves(hitboxes)) {
    if (!isRect(rect)) continue;
    if (column < rect.x || column >= rect.x + rect.w) continue;
    if (row < rect.y || row >= rect.y + rect.h) continue;
    hits.push(key);
  }
  return hits.sort();
}

// Returns null when the frame matches, otherwise the first text difference and
// the first hitbox difference (either may be null). Text is compared first:
// a cell shift is the most useful failure, and the hitbox map then names the
// pointer target whose rectangle moved.
export function compareFrame(fixture, result) {
  const expectedHitboxes = fixture.hitboxes;
  const actualHitboxes = canonicalHitboxes(result.hitboxes);
  const text = firstTextDifference(fixture.text, result.text.split('\n'));
  if (text) text.hitboxes = hitboxesAt(expectedHitboxes, text.row, text.column);
  const hitbox = firstHitboxDifference(expectedHitboxes, actualHitboxes);
  if (!text && !hitbox) return null;
  return { text, hitbox };
}

export function formatFrameDiff(name, diff) {
  const lines = [`golden frame mismatch: ${name}`];
  if (diff.text) {
    const { row, column, expectedChar, actualChar, hitboxes = [] } = diff.text;
    lines.push(`  text row ${row}, column ${column}: expected ${JSON.stringify(expectedChar)}, actual ${JSON.stringify(actualChar)}`);
    if (hitboxes.length) lines.push(`  hitboxes at that cell: ${hitboxes.join(', ')}`);
  }
  if (diff.hitbox) {
    const { key, expected, actual, row, column } = diff.hitbox;
    lines.push(`  hitbox ${JSON.stringify(key)} at row ${row}, column ${column}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`);
  }
  return lines.join('\n');
}

export function loadFrameFixture(surface, language, width, height = FRAME_HEIGHTS[width]) {
  return JSON.parse(readFileSync(frameFixturePath(surface, language, width, height), 'utf8'));
}

export function expectedFixtureMatrix() {
  const names = [];
  for (const surface of FRAME_SURFACES) {
    for (const width of FRAME_WIDTHS) {
      for (const language of FRAME_LANGUAGES) {
        names.push(frameFixtureName(surface, language, width, FRAME_HEIGHTS[width]));
      }
    }
  }
  return names.sort();
}
