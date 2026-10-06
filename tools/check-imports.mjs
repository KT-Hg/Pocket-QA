#!/usr/bin/env node
/**
 * check-imports.mjs — every path the extension loads must exist.
 *
 * Moving a file is the commonest way to break an unbundled extension without a
 * single syntax error: a stale `import`, a renamed export, a `<script src>` or a
 * manifest entry that no longer points anywhere only fails when that page or
 * worker loads. This walks all of them statically:
 *
 *   - static / side-effect / literal dynamic imports resolve to a file, and every
 *     imported name is exported by it (following `export * from`);
 *   - manifest.json: background, content scripts, icons, popup, and each
 *     web_accessible_resources glob matches at least one file;
 *   - `<script src>` / `<link href>` in the HTML pages;
 *   - `chrome.runtime.getURL('…')`, `files: ['…']` and page names ('x.html');
 *   - every module an Adminer page loads through `import(chrome.runtime.getURL())`
 *     (and what that module imports in turn) is covered by web_accessible_resources —
 *     a page can only import what that list exposes.
 *
 * Usage: node tools/check-imports.mjs        (exit 1 on any problem)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeModule } from './lib/modules.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude']);
const problems = [];
const report = (file, line, msg) => problems.push(`${file}${line ? ':' + line : ''}  ${msg}`);

const toPosix = (p) => p.split(sep).join('/');
const rel = (abs) => toPosix(relative(ROOT, abs));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

const allFiles = walk(ROOT).map(rel);
const fileSet = new Set(allFiles);
const jsFiles = allFiles.filter((f) => /\.(m?js)$/.test(f));

const cache = new Map();
function info(file) {
  if (!cache.has(file)) cache.set(file, analyzeModule(readFileSync(join(ROOT, file), 'utf8')));
  return cache.get(file);
}

/** Resolve an import specifier against the importing file; null for bare/node specifiers. */
function resolveSpec(fromFile, spec) {
  if (spec.startsWith('node:') || !/^[./]/.test(spec)) return null;
  const base = spec.startsWith('/') ? spec.slice(1) : toPosix(join(dirname(fromFile), spec));
  return toPosix(base).replace(/^\.\//, '');
}

/** Names a module exports, following `export * from`. */
function exportedNames(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const { exports, reexports } = info(file);
  const names = new Set(exports);
  for (const r of reexports) {
    if (r.names !== '*') continue;
    const target = resolveSpec(file, r.spec);
    if (target && fileSet.has(target)) {
      for (const n of exportedNames(target, seen)) if (n !== 'default') names.add(n);
    }
  }
  return names;
}

// 1. Imports and exports.
for (const file of jsFiles) {
  const { imports, reexports } = info(file);
  for (const imp of [...imports, ...reexports.map((r) => ({ ...r, kind: 'reexport' }))]) {
    if (imp.kind === 'extension-url') {
      if (!fileSet.has(imp.spec)) report(file, imp.line, `import(getURL('${imp.spec}')): file not found`);
      continue;
    }
    const target = resolveSpec(file, imp.spec);
    if (target === null) continue;
    if (!fileSet.has(target)) { report(file, imp.line, `import '${imp.spec}': file not found (${target})`); continue; }
    const names = Array.isArray(imp.names) ? imp.names : [];
    if (!names.length) continue;
    const available = exportedNames(target);
    for (const n of names) {
      if (n.imported === '*') continue;
      if (!available.has(n.imported)) report(file, imp.line, `'${n.imported}' is not exported by ${target}`);
    }
  }
}

// 2. Paths named in code: getURL('…'), files: ['…'], and page names.
// Only extension code: tools/ and tests/ name globs and fixtures, not loadable files.
const PAGE_LITERAL = /^[\w-]+(\/[\w-]+)*\.html$/;
const contentScriptFiles = [];
for (const file of jsFiles.filter((f) => !/^(tools|tests)\//.test(f))) {
  const { calls, strings } = info(file);
  for (const c of calls) {
    if (c.callee === 'getURL') {
      const path = c.arg.replace(/^\//, '').split(/[?#]/)[0];
      if (path && !fileSet.has(path)) report(file, c.line, `getURL('${c.arg}'): file not found`);
    }
    if (c.key === 'files') {
      for (const p of c.items) if (!fileSet.has(p.replace(/^\//, ''))) report(file, c.line, `files: ['${p}']: file not found`);
      if (c.name === 'CONTENT_SCRIPT_FILES') contentScriptFiles.push({ file, line: c.line, items: c.items });
    }
  }
  for (const s of strings) {
    if (!s.template && PAGE_LITERAL.test(s.v) && !fileSet.has(s.v)) {
      // Only extension pages are checked; generated code may name arbitrary .html files.
      if (['popup', 'sqlcases', 'dbtools', 'editor', 'capture-window'].some((p) => s.v === `${p}.html`)) {
        report(file, s.line, `page '${s.v}' not found`);
      }
    }
  }
}

// 3. manifest.json
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const mustExist = (what, p) => { if (!fileSet.has(p)) report('manifest.json', 0, `${what}: '${p}' not found`); };
if (manifest.background?.service_worker) mustExist('background.service_worker', manifest.background.service_worker);
for (const cs of manifest.content_scripts || []) {
  for (const p of cs.js || []) mustExist('content_scripts.js', p);
  for (const p of cs.css || []) mustExist('content_scripts.css', p);
}
for (const p of Object.values(manifest.icons || {})) mustExist('icons', p);
if (manifest.action?.default_popup) mustExist('action.default_popup', manifest.action.default_popup);
for (const p of Object.values(manifest.action?.default_icon || {})) mustExist('action.default_icon', p);
if (manifest.options_page) mustExist('options_page', manifest.options_page);

// The popup re-injects content.js into tabs opened before install: it must inject
// exactly what the manifest does, in the same order.
const manifestContent = (manifest.content_scripts || []).find((cs) => (cs.js || []).includes('content.js'))?.js || [];
for (const c of contentScriptFiles) {
  if (JSON.stringify(c.items) !== JSON.stringify(manifestContent)) {
    report(c.file, c.line, `CONTENT_SCRIPT_FILES ${JSON.stringify(c.items)} differs from manifest ${JSON.stringify(manifestContent)}`);
  }
}

// Chrome's own matching may let `*` cross `/`; the check is stricter on purpose,
// so a module moved into a subfolder is listed explicitly rather than by accident.
const globToRegex = (g) => new RegExp('^' + g.replace(/^\//, '').split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
const warGlobs = (manifest.web_accessible_resources || []).flatMap((w) => w.resources || []);
const warRegexes = warGlobs.map(globToRegex);
for (const g of warGlobs) {
  const re = globToRegex(g);
  if (!allFiles.some((f) => re.test(f))) report('manifest.json', 0, `web_accessible_resources '${g}' matches no file`);
}

// 4. Modules a web page imports through getURL must be web-accessible, with
//    everything they import in turn.
const pageEntries = new Set();
for (const cs of manifest.content_scripts || []) {
  for (const p of cs.js || []) {
    if (!fileSet.has(p)) continue;
    for (const imp of info(p).imports) if (imp.kind === 'extension-url') pageEntries.add(imp.spec);
  }
}
const pageModules = new Set();
const queue = [...pageEntries].filter((f) => fileSet.has(f));
while (queue.length) {
  const f = queue.pop();
  if (pageModules.has(f)) continue;
  pageModules.add(f);
  const { imports, reexports } = info(f);
  for (const imp of [...imports, ...reexports]) {
    const t = resolveSpec(f, imp.spec);
    if (t && fileSet.has(t) && /\.m?js$/.test(t)) queue.push(t);
  }
}
for (const f of [...pageModules].sort()) {
  if (!warRegexes.some((re) => re.test(f))) report('manifest.json', 0, `'${f}' is loaded by a web page but not in web_accessible_resources`);
}

// 5. HTML pages: <script src>, <link href>.
for (const html of allFiles.filter((f) => f.endsWith('.html') && !f.includes('/'))) {
  const src = readFileSync(join(ROOT, html), 'utf8');
  const re = /<(script|link)\b[^>]*?\b(src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(src))) {
    const p = m[3];
    if (/^(https?:|data:|#|chrome:)/.test(p)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    if (!fileSet.has(p.replace(/^\.?\//, '').split(/[?#]/)[0])) report(html, line, `<${m[1]} ${m[2]}="${p}">: file not found`);
  }
}

if (problems.length) {
  console.error(`check-imports: ${problems.length} problem(s)`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`check-imports: OK — ${jsFiles.length} JS files, ${pageModules.size} page-loaded modules, manifest and ${allFiles.filter((f) => f.endsWith('.html') && !f.includes('/')).length} pages checked.`);
