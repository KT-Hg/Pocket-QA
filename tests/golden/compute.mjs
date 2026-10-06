// Golden (characterization) outputs: what the pure modules and the two code
// exporters return today for a fixed corpus of inputs. golden.test.mjs compares
// against the stored copies byte for byte, so a refactor that moves or reshapes
// this code proves it did not change a single result.
//
// Everything that varies between runs is pinned here: Math.random is a seeded
// generator reset before each case, Date reads a fixed instant, TZ is UTC.
// `chrome` is a no-op stub, for any module that touches chrome.* as it loads.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SYNTHETIC_SCENARIOS, VARIABLE_SETS } from '../fixtures/synthetic.mjs';

process.env.TZ = 'UTC';

const FIXED_NOW = Date.UTC(2026, 0, 15, 9, 5, 7);
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(FIXED_NOW); }
  static now() { return FIXED_NOW; }
}

let seed = 1;
function reseed(s = 1) { seed = s >>> 0; }
function seededRandom() {
  // mulberry32
  seed = (seed + 0x6D2B79F5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function chromeStub() {
  const fn = () => {};
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (prop === 'lastError') return undefined;
      if (prop === 'getURL') return (p) => `chrome-extension://test/${String(p).replace(/^\//, '')}`;
      return chromeStub();
    },
    apply() { return undefined; },
  });
}

/** JSON-safe copy that keeps undefined, Sets, Maps, NaN and errors visible. */
function snap(v, seen = new WeakSet()) {
  if (v === undefined) return { $undefined: true };
  if (typeof v === 'number' && !Number.isFinite(v)) return { $number: String(v) };
  if (typeof v === 'function') return { $function: v.name || 'anonymous' };
  if (v === null || typeof v !== 'object') return v;
  if (seen.has(v)) return { $circular: true };
  seen.add(v);
  let out;
  if (v instanceof Set) out = { $set: [...v].map((x) => snap(x, seen)) };
  else if (v instanceof Map) out = { $map: [...v].map(([k, x]) => [snap(k, seen), snap(x, seen)]) };
  else if (Array.isArray(v)) out = Array.from(v, (x) => snap(x, seen));
  else {
    out = {};
    for (const k of Object.keys(v)) out[k] = snap(v[k], seen);
  }
  seen.delete(v);
  return out;
}

function run(fn) {
  reseed(1);
  try { return snap(fn()); } catch (e) { return { $error: `${e?.name}: ${e?.message}` }; }
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// switch-blocks returns whole action lists; storing every copy in full made the
// golden file several MB. An action is kept as the fields switch-blocks reads or
// rewrites plus a hash of the whole object, so any other change still shows.
const SB_FIELDS = ['type', 'disabled', 'skipCount', 'conditionSkipCount', 'empty', 'cases', 'continueAt', 'switchVar'];
function compactActions(v) {
  if (Array.isArray(v)) return v.map(compactActions);
  if (!v || typeof v !== 'object') return v;
  if (typeof v.type === 'string' && ('selector' in v || 'label' in v || 'value' in v || 'cases' in v || 'conditionType' in v || 'code' in v || 'url' in v)) {
    const c = { $hash: createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 10) };
    for (const k of SB_FIELDS) if (k in v) c[k] = v[k];
    return c;
  }
  const o = {};
  for (const k of Object.keys(v)) o[k] = compactActions(v[k]);
  return o;
}

export function scenarios() {
  const fixtures = JSON.parse(readFileSync(new URL('../fixtures/scenarios.json', import.meta.url), 'utf8'));
  const list = Object.values(fixtures).map((s) => ({ name: s.name, actions: s.actions || [] }));
  return [...list, ...SYNTHETIC_SCENARIOS];
}

export async function computeGolden() {
  globalThis.chrome = chromeStub();
  const realRandom = Math.random;
  Math.random = seededRandom;
  globalThis.Date = FixedDate;
  try {
    return await _compute();
  } finally {
    Math.random = realRandom;
    globalThis.Date = RealDate;
  }
}

async function _compute() {
  const varName = await import('../../shared/var-name.js');
  const varSpec = await import('../../shared/var-spec.js');
  const textPattern = await import('../../shared/text-pattern.js');
  const varOrder = await import('../../shared/var-order.js');
  const updateLock = await import('../../shared/update-lock.js');
  const sb = await import('../../shared/switch-blocks.js');
  const interpolate = await import('../../bg/interpolate.js');
  const variables = await import('../../popup/variables.js');
  const { generateBookmarklet } = await import('../../popup/export-bookmarklet.js');
  const { generateSeleniumPy } = await import('../../popup/export-selenium.js');

  const all = scenarios();
  const allActions = all.flatMap((s) => s.actions);
  const out = { pure: {}, switchBlocks: {}, exportBookmarklet: {}, exportSelenium: {} };
  const P = out.pure;

  // ── var-name ──────────────────────────────────────────────────────────────
  const NAMES = ['', 'abc', '${abc}', ' ${ abc } ', '$abc', '{abc}', '${{abc}}', 'tên', 'họ tên', 'a.b', 'a-b', '1x',
    '${a}${b}', '${}', '$', null, undefined, 42, { x: 1 }];
  P.normalizeVarName = NAMES.map((n) => run(() => varName.normalizeVarName(n)));
  P.normalizeVarRef = NAMES.map((n) => run(() => varName.normalizeVarRef(n)));
  P.SELECTOR_KEYS = snap(varName.SELECTOR_KEYS);
  P.selectorStrings = allActions.map((a) => run(() => varName.selectorStrings(a)));
  P.writtenVarNames = allActions.map((a) => run(() => varName.writtenVarNames(a)));
  const LISTS = [[], ['a', null, ''], ['x|y', 'z\\w', '}'], null, 'x', [1, 2]];
  P.listEntries = LISTS.map((l) => run(() => varName.listEntries(l)));
  P.listSpec = ['pick', 'fallback'].flatMap((k) => LISTS.map((l) => run(() => varName.listSpec(k, l))));
  const SPECS = ['{pick:a|b}', '{pick:}', '{pick:a||b}', '{fallback:a||b}', '{fallback:}', '{pick:a\\|b|c}', '{pick:a}b}',
    'plain', '', null, undefined, '{random:alpha:8}', ' {pick:a|b} '];
  P.parseListSpec = ['pick', 'fallback'].flatMap((k) => SPECS.map((s) => run(() => varName.parseListSpec(k, s))));

  // ── text-pattern ─────────────────────────────────────────────────────────
  const PATTERNS = ['', 'Order #${id}', '${a} - ${b}', '${a}${b}', 'x ${a', '${1bad}', 'Total: ${amount} VND', '(${x}) [${y}]',
    ' ${a} ', '${a}.*${b}', 'no vars', '${tên} và ${họ}', '${a} ${a}', null];
  P.parsePattern = PATTERNS.map((p) => run(() => textPattern.parsePattern(p)));
  P.patternVarNames = PATTERNS.map((p) => run(() => textPattern.patternVarNames(p)));
  P.patternError = PATTERNS.map((p) => run(() => textPattern.patternError(p)));
  P.patternRegexSource = PATTERNS.map((p) => run(() => textPattern.patternRegexSource(p)));
  const TEXTS = ['Order #123 for Ann', 'order #9 FOR bob', 'x - y', 'Total: 1,000 VND', '(1) [2]', 'Đức và Nguyễn', '', 'nothing'];
  P.extractWithPattern = PATTERNS.flatMap((p) => TEXTS.flatMap((t) => [false, true].map((mc) =>
    run(() => textPattern.extractWithPattern(t, p, { matchCase: mc })))));
  P.patternMismatch = PATTERNS.flatMap((p) => TEXTS.map((t) => run(() => textPattern.patternMismatch(t, p))));

  // ── var-order ────────────────────────────────────────────────────────────
  P.VARIABLE_SORTS = snap(varOrder.VARIABLE_SORTS);
  P.normalizeVariableSort = [...varOrder.VARIABLE_SORTS, '', 'bogus', null, undefined].map((m) => run(() => varOrder.normalizeVariableSort(m)));
  const VARS = {
    zeta: { activeType: 's', s: 'z', createdAt: 3, updatedAt: 9 },
    alpha: { activeType: 'r', r: { type: 'alpha', length: '4' }, createdAt: 1, updatedAt: 1 },
    Beta: { activeType: 'p', p: ['a', 'b'], createdAt: 2, updatedAt: 20 },
    tên: { activeType: 'f', f: ['x', ''], createdAt: 2, updatedAt: 5 },
    legacy: 'plain string',
    legacyPick: '{pick:a|b}',
    legacyRand: '{random:numeric:3}',
    noDates: { activeType: 's', s: '' },
    stamp: { activeType: 'r', r: { type: 'datetime', length: '0' }, createdAt: 5 },
  };
  const ORDERS = [[], ['tên', 'zeta', 'missing'], ['legacy', 'alpha', 'Beta', 'zeta', 'tên', 'noDates']];
  P.orderNames = ORDERS.map((o) => run(() => varOrder.orderNames(Object.keys(VARS), o)));
  P.orderVariableNames = ORDERS.map((o) => run(() => varOrder.orderVariableNames(VARS, o)));
  P.variableType = Object.values(VARS).map((v) => run(() => varOrder.variableType(v)));
  P.variableComparator = varOrder.VARIABLE_SORTS.map((m) => run(() => {
    const cmp = varOrder.variableComparator(m);
    return Object.entries(VARS).sort((a, b) => cmp(a, b)).map(([k]) => k);
  }));
  P.sortVariableNames = varOrder.VARIABLE_SORTS.flatMap((m) => ORDERS.map((o) => run(() => varOrder.sortVariableNames(VARS, o, m))));

  // ── update-lock ──────────────────────────────────────────────────────────
  P.updateLockConstants = snap({
    DAY_MS: updateLock.DAY_MS, GRACE_MS: updateLock.GRACE_MS, MIN_GRACE_MS: updateLock.MIN_GRACE_MS,
    WARN_MS: updateLock.WARN_MS, LOCK_MESSAGE: updateLock.LOCK_MESSAGE, CRITICAL_LOCK_MESSAGE: updateLock.CRITICAL_LOCK_MESSAGE,
  });
  const VERSIONS = ['1.0.0', '1.0', '1.0.10', '1.0.9', '2', '1.0.0.1', '', null, 'x.y', '1.0.20', '01.0.0'];
  P.compareVersions = VERSIONS.flatMap((a) => VERSIONS.map((b) => run(() => updateLock.compareVersions(a, b))));
  const D = updateLock.DAY_MS;
  const now = FIXED_NOW;
  const times = [undefined, null, 0, now, now - 2 * D, now - 6 * D, now - 8 * D, now - 26 * D, now - 29 * D, now - 31 * D, now - 60 * D];
  P.computeLockState = [];
  for (const lastUpdateAt of times) for (const availableSince of times) for (const hardLock of [false, true]) {
    P.computeLockState.push(run(() => updateLock.computeLockState({ lastUpdateAt, availableSince, hardLock, now })));
  }
  P.computeLockStateDefaults = run(() => updateLock.computeLockState());
  const CONFIGS = [null, {}, { hardLock: true }, { hardLock: true, minVersion: '1.0.21' },
    { hardLock: true, minVersion: '1.0.21', fetchedAt: now - D }, { hardLock: true, minVersion: '1.0.21', fetchedAt: now - 8 * D },
    { hardLock: true, minVersion: '1.0.20', fetchedAt: now }, { hardLock: true, minVersion: '2.0.0', fetchedAt: now, message: 'Custom' },
    { hardLock: 'true', minVersion: '9', fetchedAt: now }];
  P.evaluateRemoteConfig = CONFIGS.flatMap((c) => ['1.0.20', '1.0.19', '3.0.0'].map((v) =>
    run(() => updateLock.evaluateRemoteConfig(c, v, undefined, now))));

  // ── bg/interpolate.js variable handling ──────────────────────────────────
  P.resolveRandomVars = Object.entries(VARIABLE_SETS).map(([k, set]) => [k, run(() => interpolate.resolveRandomVars(clone(set)))]);
  P.applyVars = ['${user} ${missing}', '${tên}${tên}', 'none', '', null, 5, '${}', '${a}b}'].map((s) =>
    run(() => interpolate.applyVars(s, VARIABLE_SETS.strings)));
  P.interpolateAction = Object.entries({ none: {}, strings: VARIABLE_SETS.strings, odd: { role: 'x', user: '$&', tên: '${user}' } })
    .map(([k, set]) => [k, allActions.map((a) => run(() => interpolate.interpolateAction(clone(a), set)))]);

  // ── popup/variables.js config model ──────────────────────────────────────
  const RAW = ['', 'plain', '{random:alpha:8}', '{random:datetime:0}', '{pick:a|b|}', '{fallback:x||y}', '{pick:}', null, undefined, 5,
    { activeType: 's', s: 'v' }, { activeType: 'r' }, { activeType: 'p', p: [] }, { activeType: 'f', f: ['a'] , r: { length: '3' } },
    { s: 'no type' }];
  P.migrateToConfig = RAW.map((r) => run(() => variables.migrateToConfig(r)));
  P.getActiveValue = RAW.map((r) => run(() => varSpec.configValue(variables.migrateToConfig(r))));
  P.getActiveValueRaw = [{ activeType: 'r', r: { type: 'numeric', length: 4 } }, { activeType: 'p', p: ['a', null] }, {}, { activeType: 'x', s: 'q' }]
    .map((c) => run(() => varSpec.configValue(c)));

  // ── shared/var-spec.js + time-format.js (added with them; equal to the copies they replaced) ──
  const SPEC_VALUES = [...RAW, 0, NaN, true, [], { activeType: 'r', r: { type: 'alpha', length: 6 } }, '{random:weird:3}'];
  P.varSpecActiveValue = SPEC_VALUES.map((v) => run(() => varSpec.activeValue(v)));
  P.varSpecActiveValueText = SPEC_VALUES.map((v) => run(() => varSpec.activeValueText(v)));
  P.varSpecParseRandomSpec = SPEC_VALUES.map((v) => run(() => varSpec.parseRandomSpec(v)));
  P.varSpecParsePickSpec = SPEC_VALUES.map((v) => run(() => varSpec.parsePickSpec(v)));
  P.varSpecPreviewRandom = ['datetime', 'alpha', 'numeric', 'alphanumeric', 'other'].flatMap((t) =>
    [0, 1, 12].map((n) => run(() => varSpec.previewRandom(t, n))));
  // ── CSV run: parser, result files, ZIP writer (popup/csv, popup/lib) ──
  const { parseCSV } = await import('../../popup/csv/csv-parse.js');
  const resultExport = await import('../../popup/csv/result-export.js');
  const { ZipWriter } = await import('../../popup/lib/zip-writer.js');
  const CSVS = ['', 'a', 'a,b\n1,2', '﻿name,age\r\nAnn,3\r\nBob,4\r\n', 'h1,h2\n"x, y","multi\nline"\n" pad ",  trim  \n',
    'a,b\n\n1,2\n\n', 'a\n""\n', 'a,b,c\n1\n1,2,3,4\n', 'q\n"he said ""hi"""\n', 'x,y\r\n"open quote\r\n'];
  P.parseCSV = CSVS.map((c) => run(() => parseCSV(c)));
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const csvHeaders = ['user', 'pass', 'shot'];
  const csvRows = [{ user: 'a', pass: '1', shot: '' }, { user: 'b "q"', pass: '<2>', shot: '' }, { user: 'Đức', pass: '&', shot: '' }];
  const csvResults = [{ rowIndex: 0, vars: { user: 'a', extra: 'x' }, failures: [] },
    { rowIndex: 1, vars: {}, failures: [{ index: 3, type: 'click', label: 'Go' }, { index: 5, type: 'input' }] },
    { rowIndex: 2, vars: { shot: 'f.png', read: '1' }, failures: null }];
  const shots = { '0:shot': png, '2:shot': png, '1:other': png };
  const blobDigest = async (blob) => `${blob.type} ${createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex')}`;
  P.generateResultCsv = run(() => resultExport.generateResultCsv(csvHeaders, csvRows, csvResults));
  P.generateResultHtml = [undefined, ['shot']].map((o) => run(() => resultExport.generateResultHtml(csvHeaders, csvRows, csvResults, shots, o)));
  P.generateResultXlsx = [];
  for (const o of [undefined, ['shot'], ['other', 'shot']]) P.generateResultXlsx.push(await blobDigest(resultExport.generateResultXlsx(csvHeaders, csvRows, csvResults, shots, o)));
  const zw = new ZipWriter();
  zw.add('results.csv', '﻿a,b');
  zw.add('row_01/x.png', Uint8Array.from([1, 2, 3]));
  P.zipWriter = await blobDigest(zw.build('application/zip'));

  const timeFormat = await import('../../shared/time-format.js');
  P.formatStamp = [new Date(), new Date(2026, 0, 2, 3, 4, 5), new Date(1999, 11, 31, 23, 59, 59)].map((d) => run(() => timeFormat.formatStamp(d)));

  // ── switch-blocks over every scenario ────────────────────────────────────
  for (const s of all) {
    const A = s.actions;
    const n = A.length;
    const idx = [...Array(n).keys()];
    const r = {};
    r.getSwitchLayout = run(() => sb.getSwitchLayout(clone(A)));
    r.getConditionLayout = run(() => sb.getConditionLayout(clone(A)));
    r.anyConditions = run(() => sb.anyConditions(clone(A)));
    r.anyBlocks = run(() => sb.anyBlocks(clone(A)));
    r.perIndex = idx.map((i) => {
      const a = A[i];
      const e = {};
      e.hasBlock = run(() => sb.hasBlock(a));
      if (a.type === 'switch') {
        e.cases = (a.cases || []).map((c) => [run(() => sb.caseLabel(c)), run(() => sb.isBlockCase(c)), run(() => sb.caseRange(c))]);
        e.blockEnd = run(() => sb.blockEnd(clone(A), i));
        e.continueIndex = run(() => sb.continueIndex(clone(A), i));
        e.validateSwitch = run(() => sb.validateSwitch(clone(A), i));
        e.validateExternalCase = (a.cases || []).map((c) => run(() => sb.validateExternalCase(c, clone(A))));
      }
      if (a.type === 'condition') {
        e.conditionSkip = run(() => sb.conditionSkip(a));
        e.conditionSkipTarget = [0, 1, 2, 3, 50].map((k) => run(() => sb.conditionSkipTarget(clone(A), i, k)));
        e.conditionChoices = run(() => sb.conditionChoices(clone(A), i));
        e.conditionRange = run(() => sb.conditionRange(clone(A), i));
      }
      e.childRange = run(() => sb.childRange(clone(A), i));
      e.toggleDisabled = run(() => sb.toggleDisabled(clone(A), i));
      e.resumeSegments = run(() => sb.resumeSegments(clone(A), i));
      e.remapAfterRemove = run(() => sb.remapAfterRemove(clone(A), i));
      const toFront = [i, ...idx.filter((j) => j !== i)];
      const toBack = [...idx.filter((j) => j !== i), i];
      e.remapToFront = run(() => sb.remapAfterReorder(clone(A), toFront));
      e.remapToBack = run(() => sb.remapAfterReorder(clone(A), toBack));
      const anchors = [{ kind: 'top' }, { kind: 'after', index: 0 }, { kind: 'after', index: Math.floor(n / 2) }, { kind: 'after', index: n - 1 }];
      A.forEach((b, j) => {
        if (b.type === 'switch') {
          anchors.push({ kind: 'afterCollapsed', switchIdx: j }, { kind: 'outside', switchIdx: j });
          (b.cases || []).forEach((_c, k) => anchors.push({ kind: 'caseHead', switchIdx: j, caseIdx: k }));
        }
        if (b.type === 'condition') anchors.push({ kind: 'afterCollapsedCond', condIdx: j }, { kind: 'outsideCond', condIdx: j });
      });
      // The resulting list is remapAfterReorder's (covered above); a hash keeps it checked.
      e.planDrop = anchors.map((an) => [an, run(() => {
        const plan = sb.planDrop(clone(A), i, an);
        if (!plan) return plan;
        const { actions, ...rest } = plan;
        return { ...rest, actionsHash: createHash('sha1').update(JSON.stringify(actions)).digest('hex').slice(0, 12) };
      })]);
      return e;
    });
    out.switchBlocks[s.name] = compactActions(r);
  }

  // ── code exporters ───────────────────────────────────────────────────────
  const fixtureCount = all.length - SYNTHETIC_SCENARIOS.length;
  all.forEach((s, k) => {
    const sets = k < fixtureCount ? ['none', 'strings'] : Object.keys(VARIABLE_SETS);
    for (const setName of sets) {
      const key = `${s.name} | ${setName}`;
      out.exportBookmarklet[key] = run(() => generateBookmarklet(s.name, clone(s.actions), clone(VARIABLE_SETS[setName])));
      out.exportSelenium[key] = run(() => generateSeleniumPy(s.name, clone(s.actions), clone(VARIABLE_SETS[setName])));
    }
  });
  const syn = SYNTHETIC_SCENARIOS[0];
  out.exportBookmarklet[`${syn.name} | opts`] = run(() => generateBookmarklet(syn.name, clone(syn.actions), clone(VARIABLE_SETS.configs), { stepDelay: 0, elTimeout: 1234 }));
  out.exportSelenium[`${syn.name} | opts`] = run(() => generateSeleniumPy(syn.name, clone(syn.actions), clone(VARIABLE_SETS.configs),
    { stepDelay: 0, elTimeout: 1234, driverType: 'Firefox', startUrl: 'https://start.example/${page}' }));

  return out;
}
