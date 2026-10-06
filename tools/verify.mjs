#!/usr/bin/env node
/**
 * verify.mjs — the per-change checklist in one command.
 *
 *   node tools/verify.mjs                 static checks, unit + golden tests, selftests
 *   node tools/verify.mjs --eslint        … plus ESLint against tools/eslint-baseline.json
 *   node tools/verify.mjs --smoke         … plus tools/smoke.mjs (Playwright), or tools/smoke-cdp.mjs without it
 *   node tools/verify.mjs --all           everything
 *   node tools/verify.mjs --eslint --update-baseline   rewrite the ESLint baseline
 *
 * Exits 1 when any step fails. ESLint fails the run only when a rule has more
 * warnings than the baseline — fewer is always fine.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const ALL = args.has('--all');
const ESLINT_VERSION = '9.39.5';
const BASELINE = join(ROOT, 'tools', 'eslint-baseline.json');

const results = [];
function step(name, fn) {
  process.stdout.write(`• ${name} … `);
  const t0 = Date.now();
  let res;
  try { res = fn(); } catch (e) { res = { ok: false, detail: e.message }; }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${res.ok ? 'OK' : 'FAIL'} (${secs}s)${res.detail ? ' — ' + res.detail : ''}`);
  if (!res.ok && res.output) console.log(res.output.split('\n').map((l) => '    ' + l).join('\n'));
  results.push({ name, ...res });
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', shell: opts.shell || false, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), error: r.error };
}

const tail = (s, n = 25) => s.trim().split('\n').slice(-n).join('\n');

step('check-imports', () => {
  const r = run(process.execPath, ['tools/check-imports.mjs']);
  return { ok: r.status === 0, detail: tail(r.out, 1), output: r.status ? tail(r.out) : '' };
});

step('syntax (node --check)', () => {
  const files = run('git', ['ls-files', '*.js', '*.mjs']).out.trim().split('\n').filter(Boolean)
    .filter((f) => existsSync(join(ROOT, f)));
  const extra = run('git', ['ls-files', '--others', '--exclude-standard', '*.js', '*.mjs']).out.trim().split('\n').filter(Boolean);
  const bad = [];
  for (const f of [...files, ...extra]) {
    const r = run(process.execPath, ['--check', f]);
    if (r.status !== 0) bad.push(`${f}: ${tail(r.out, 3)}`);
  }
  return { ok: !bad.length, detail: `${files.length + extra.length} files`, output: bad.join('\n') };
});

step('tests (node --test)', () => {
  const r = run(process.execPath, ['--test', 'tests/*.test.mjs']);
  const pass = /ℹ pass (\d+)/.exec(r.out)?.[1];
  const failCount = /ℹ fail (\d+)/.exec(r.out)?.[1];
  return { ok: r.status === 0, detail: `pass ${pass}, fail ${failCount}`, output: r.status ? tail(r.out, 60) : '' };
});

step('sqlcases selftest', () => {
  const r = run(process.execPath, ['sqlcases/selftest.mjs']);
  return { ok: r.status === 0, detail: tail(r.out, 1), output: r.status ? tail(r.out) : '' };
});

step('dbtools selftest', () => {
  const r = run(process.execPath, ['dbtools/selftest.mjs']);
  return { ok: r.status === 0, detail: tail(r.out, 1), output: r.status ? tail(r.out) : '' };
});

if (ALL || args.has('--eslint')) {
  step(`eslint@${ESLINT_VERSION} vs baseline`, () => {
    const r = run('npx', ['--yes', `eslint@${ESLINT_VERSION}`, '-c', 'tools/eslint.config.mjs', '-f', 'json', '.'], { shell: process.platform === 'win32' });
    const start = r.out.indexOf('[');
    if (start < 0) return { ok: false, detail: 'no ESLint output', output: tail(r.out) };
    const report = JSON.parse(r.out.slice(start, r.out.lastIndexOf(']') + 1));
    const byRule = {};
    let errors = 0;
    for (const f of report) for (const m of f.messages) {
      byRule[m.ruleId || 'parse'] = (byRule[m.ruleId || 'parse'] || 0) + 1;
      if (m.severity === 2) errors++;
    }
    const total = Object.values(byRule).reduce((a, b) => a + b, 0);
    if (args.has('--update-baseline')) {
      writeFileSync(BASELINE, JSON.stringify({ total, byRule }, null, 2) + '\n');
      return { ok: true, detail: `baseline written: ${total}` };
    }
    const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
    if (!base) return { ok: false, detail: 'no baseline — run with --update-baseline' };
    const worse = Object.keys(byRule).filter((k) => byRule[k] > (base.byRule[k] || 0))
      .map((k) => `${k}: ${base.byRule[k] || 0} → ${byRule[k]}`);
    return {
      ok: !worse.length && !errors,
      detail: `${total} warnings (baseline ${base.total})${errors ? `, ${errors} errors` : ''}`,
      output: worse.join('\n'),
    };
  });
}

if (ALL || args.has('--smoke')) {
  step('smoke (Chromium + extension)', () => {
    let r = run(process.execPath, ['tools/smoke.mjs']);
    let how = 'Playwright';
    // smoke.mjs exits 2 when Playwright is not installed: the same checks over plain CDP.
    if (r.status === 2) { r = run(process.execPath, ['tools/smoke-cdp.mjs']); how = 'CDP'; }
    return { ok: r.status === 0, detail: `${how}: ${tail(r.out, 1)}`, output: r.status ? tail(r.out, 40) : '' };
  });
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nverify: ${failed.length} step(s) failed` : '\nverify: all steps passed');
process.exit(failed.length ? 1 : 0);
