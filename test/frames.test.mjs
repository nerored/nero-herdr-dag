import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  compareFrame, expectedFixtureMatrix, formatFrameDiff, FRAME_DIR, FRAME_HEIGHTS, FRAME_LANGUAGES,
  FRAME_SURFACES, FRAME_WIDTHS, frameFixtureName, frameFixturePath, loadFrameFixture,
  renderFixtureFrame, serializeFrame,
} from './frame-fixtures.mjs';

// Set UPDATE_FRAMES=1 to regenerate the committed fixtures from this exact
// deterministic render path. Normal runs only read them.
const UPDATE = process.env.UPDATE_FRAMES === '1';
const fixtureDir = fileURLToPath(FRAME_DIR);
const widthList = FRAME_WIDTHS.join('/');

for (const surface of FRAME_SURFACES) {
  test(`golden ${surface} frames and hitboxes match at ${widthList} in en and zh`, () => {
    for (const width of FRAME_WIDTHS) {
      const height = FRAME_HEIGHTS[width];
      for (const language of FRAME_LANGUAGES) {
        const name = frameFixtureName(surface, language, width, height);
        const result = renderFixtureFrame(surface, language, width, height);
        const actual = serializeFrame(result, { surface, language, width, height });
        const path = frameFixturePath(surface, language, width, height);
        if (UPDATE) {
          mkdirSync(fixtureDir, { recursive: true });
          writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
        }
        const fixture = JSON.parse(readFileSync(path, 'utf8'));
        assert.equal(fixture.surface, surface, `${name} surface metadata`);
        assert.equal(fixture.width, width, `${name} width metadata`);
        assert.equal(fixture.height, height, `${name} height metadata`);
        assert.equal(fixture.language, language, `${name} language metadata`);
        const diff = compareFrame(fixture, result);
        assert.equal(diff, null, diff ? formatFrameDiff(name, diff) : '');
      }
    }
  });
}

test('the fixture corpus covers every surface, width, and language', () => {
  assert.deepEqual(
    readdirSync(fixtureDir).filter(name => name.endsWith('.json')).sort(),
    expectedFixtureMatrix(),
  );
});

test('fixture rendering is deterministic across repeated frames', () => {
  for (const surface of FRAME_SURFACES) {
    for (const width of FRAME_WIDTHS) {
      const height = FRAME_HEIGHTS[width];
      for (const language of FRAME_LANGUAGES) {
        const first = serializeFrame(
          renderFixtureFrame(surface, language, width, height),
          { surface, language, width, height },
        );
        const second = serializeFrame(
          renderFixtureFrame(surface, language, width, height),
          { surface, language, width, height },
        );
        assert.deepEqual(second, first, `${surface} ${width}x${height} ${language} is deterministic`);
      }
    }
  }
});

test('the comparator reports the first differing row, column, and hitboxes at that cell', () => {
  const result = renderFixtureFrame('plan', 'en', 120, 40);
  const fixture = serializeFrame(result, { surface: 'plan', language: 'en', width: 120, height: 40 });
  const row = fixture.text.findIndex(line => line.includes('Execute plan todo 13'));
  assert.ok(row > 0, 'the plan task body is painted');
  const column = fixture.text[row].indexOf('Execute');
  assert.ok(column > 0, 'the plan summary starts inside the details border');

  const mutated = structuredClone(fixture);
  mutated.text[row] = `${mutated.text[row].slice(0, column)}X${mutated.text[row].slice(column + 1)}`;
  const diff = compareFrame(mutated, result);
  assert.ok(diff, 'a one-character fixture change must fail the comparison');
  assert.equal(diff.text.row, row, 'first differing row');
  assert.equal(diff.text.column, column, 'first differing column');
  assert.equal(diff.text.expectedChar, 'X', 'expected character comes from the fixture');
  assert.equal(diff.text.actualChar, 'E', 'actual character comes from the live frame');
  assert.ok(diff.text.hitboxes.includes('regions.details'), 'the changed cell names its hitbox target');
  assert.match(formatFrameDiff('plan.120x40.en.json', diff), /row \d+, column \d+/);
});

test('the comparator reports the first shifted hitbox key at its row and column', () => {
  const result = renderFixtureFrame('details', 'en', 120, 40);
  const fixture = serializeFrame(result, { surface: 'details', language: 'en', width: 120, height: 40 });
  const api = fixture.hitboxes.nodes.api;
  assert.ok(api, 'the graph node hitbox is painted');

  const mutated = structuredClone(fixture);
  mutated.hitboxes.nodes.api.x += 1;
  const diff = compareFrame(mutated, result);
  assert.ok(diff, 'a one-cell hitbox shift must fail the comparison');
  assert.equal(diff.text, null, 'the painted text itself still matches');
  assert.equal(diff.hitbox.key, 'nodes.api', 'first differing hitbox key');
  assert.equal(diff.hitbox.row, api.y, 'reported hitbox row');
  assert.equal(diff.hitbox.column, api.x, 'reported hitbox column');
  assert.match(formatFrameDiff('details.120x40.en.json', diff), /hitbox "nodes\.api"/);
});

test('a missing fixture is not silently skipped', () => {
  assert.throws(
    () => loadFrameFixture('help', 'en', 200),
    /ENOENT|no such file/i,
    'unknown cases must fail instead of rendering nothing',
  );
});
