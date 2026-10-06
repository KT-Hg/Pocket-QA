// Rewrites the stored golden outputs from the current code.
//
// Only run this when a change of output is intended, and in its own commit, so
// the diff of tests/golden/*.json shows exactly which results changed and why.
// A refactor never needs it: golden.test.mjs passing unchanged is the proof.
//
// Usage: node tests/golden/update.mjs

import { writeFileSync } from 'node:fs';
import { computeGolden } from './compute.mjs';

const FILES = {
  pure: 'pure.json',
  switchBlocks: 'switch-blocks.json',
  exportBookmarklet: 'export-bookmarklet.json',
  exportSelenium: 'export-selenium.json',
};

// Indented down to `depth`, one line per value below it: small files whose diff
// still points at the function and input that changed.
function stringify(v, depth = 4, pad = '') {
  if (depth === 0 || v === null || typeof v !== 'object' || !Object.keys(v).length) return JSON.stringify(v);
  const inner = pad + ' ';
  if (Array.isArray(v)) return '[\n' + v.map((x) => inner + stringify(x, depth - 1, inner)).join(',\n') + '\n' + pad + ']';
  return '{\n' + Object.keys(v).map((k) => inner + JSON.stringify(k) + ': ' + stringify(v[k], depth - 1, inner)).join(',\n') + '\n' + pad + '}';
}

const golden = await computeGolden();
for (const [section, file] of Object.entries(FILES)) {
  writeFileSync(new URL(file, import.meta.url), stringify(golden[section]) + '\n');
  console.log(`wrote tests/golden/${file}`);
}
