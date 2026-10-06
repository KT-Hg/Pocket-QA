// Characterization tests: the pure modules and the code exporters must return
// exactly what they returned when tests/golden/*.json was written.
// Regenerate (only for an intended change): node tests/golden/update.mjs
// Run: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeGolden } from './golden/compute.mjs';

const FILES = {
  pure: 'pure.json',
  switchBlocks: 'switch-blocks.json',
  exportBookmarklet: 'export-bookmarklet.json',
  exportSelenium: 'export-selenium.json',
};

const actual = await computeGolden();

for (const [section, file] of Object.entries(FILES)) {
  const expected = JSON.parse(readFileSync(new URL(`./golden/${file}`, import.meta.url), 'utf8'));
  const got = JSON.parse(JSON.stringify(actual[section]));
  test(`golden: ${section}`, async (t) => {
    const keys = new Set([...Object.keys(expected), ...Object.keys(got)]);
    for (const key of keys) {
      await t.test(key, () => assert.deepStrictEqual(got[key], expected[key]));
    }
  });
}
