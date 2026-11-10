#!/usr/bin/env node
/**
 * pack.mjs — the Web Store zip, "<name> <version>.zip" next to the repo folder.
 *
 * Packs HEAD (git archive), so commit first; tests, tools, docs and dev-only
 * files (.md / .mjs / .sh, dbtools/e2e) stay out.
 *
 * Usage: node tools/pack.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const { name, version } = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const out = resolve(root, '..', `${name} ${version}.zip`);

if (git('status', '--porcelain').trim()) console.warn('Warning: uncommitted changes are NOT in the zip (it packs HEAD).');
git('archive', '--format=zip', '-9', '-o', out, 'HEAD', '--', '.',
  ':!tests', ':!tools', ':!docs', ':!README.md', ':!.gitattributes', ':!.gitignore',
  ':!**/*.md', ':!**/*.mjs', ':!**/*.sh', ':!dbtools/e2e');
console.log(out);
