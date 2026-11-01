/**
 * postman-export.js — the page's folders and cases as a Postman Collection
 * v2.1, for Postman itself or for Newman in CI
 * (`newman run file.json --env-var baseUrl=…`).
 *
 * ${x} becomes {{x}} wherever a request has text: URL, headers, body, auth,
 * the expected value of a check. Checks and saved values become the request's
 * `test` script, pm.test() and pm.environment.set() written to pass and fail
 * as the page does (the default 2xx check included). Its first line,
 * `// pocket-qa: {…}`, keeps them as the page has them, with what else Postman
 * has no field for (the timeout), so a file that went through Postman imports
 * back whole (postman-import.js).
 *
 * A secret written out in full — a token, a password, an API key, the value
 * of a header such as Authorization — is left blank unless includeSecrets,
 * and listed, so a file passed around carries no credential by accident.
 * Values that are ${variables} are kept: they hold nothing themselves.
 *
 * Pure — no chrome.*, no DOM.
 */

import { isSecretName } from '../shared/api-request.js';
import { DEFAULT_STATUS_CHECK, checkLabel, parsePath } from '../shared/api-response.js';
import { parsePattern, patternRegexSource } from '../shared/text-pattern.js';
import { normalizeVarName } from '../shared/var-name.js';
import { parseRows } from './headers.js';
import { ALL, DEFAULT_TIMEOUT_MS } from './model.js';

export const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
/** The first line of an exported test script: the checks and saved values as the page keeps them. */
export const MARKER = '// pocket-qa: ';

const VAR = /\$\{([^}]*)\}/g;
const hasVar = (text) => /\$\{[^}]*\}/.test(String(text ?? ''));
/** ${x} → {{x}}. */
export const toPm = (text) => String(text ?? '').replace(VAR, '{{$1}}');
const q = JSON.stringify;

/** `value`, or '' and a note in ctx.removed when it is a secret written out in full and secrets are left out. */
function secret(ctx, value, where) {
  if (ctx.includeSecrets || !value || hasVar(value)) return value;
  ctx.removed.push(where);
  return '';
}

/* ── Request ───────────────────────────────────────────────────────────────── */

function pmHeaders(c, ctx) {
  return parseRows(c.headers).filter((r) => r.name).map((r) => {
    const value = isSecretName(r.name) ? secret(ctx, r.value, `${c.name}: ${r.name} header`) : r.value;
    return { key: r.name, value: toPm(value), ...(r.on ? {} : { disabled: true }) };
  });
}

const decode = (s) => {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
};

/** A form body (`a=1&b=${x}`, sent as written) as Postman's key / value rows, which Postman encodes itself. */
function formRows(body) {
  return body.split('&').filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    return { key: toPm(decode(i < 0 ? pair : pair.slice(0, i))), value: toPm(decode(i < 0 ? '' : pair.slice(i + 1))) };
  });
}

/** The body as sent: none for GET and HEAD, as the page sends them. */
function pmBody(c) {
  if (c.bodyType === 'none' || c.method === 'GET' || c.method === 'HEAD') return undefined;
  if (c.bodyType === 'form') return { mode: 'urlencoded', urlencoded: formRows(c.body) };
  return { mode: 'raw', raw: toPm(c.body), options: { raw: { language: c.bodyType === 'json' ? 'json' : 'text' } } };
}

const kv = (key, value) => ({ key, value, type: 'string' });

/** Postman's auth for a case or folder; undefined for inherit (Postman inherits when there is none). */
function pmAuth(auth, owner, ctx) {
  const plain = (k) => toPm(auth[k] ?? '');
  const hidden = (k, what) => toPm(secret(ctx, auth[k] ?? '', `${owner}: ${what}`));
  switch (auth?.type) {
    case 'bearer': return { type: 'bearer', bearer: [kv('token', hidden('token', 'Bearer token'))] };
    case 'basic': return { type: 'basic', basic: [kv('username', plain('username')), kv('password', hidden('password', 'Basic password'))] };
    case 'apikey': return { type: 'apikey', apikey: [kv('key', plain('key')), kv('value', hidden('value', 'API key value')), kv('in', auth.in)] };
    case 'none': return { type: 'noauth' };
    default: return undefined;
  }
}

/* ── Test script ───────────────────────────────────────────────────────────── */

const test = (label, body) => [`pm.test(${q(label)}, function () {`, ...body.map((l) => `  ${l}`), '});'];
const broken = (label, message) => test(label, [`throw new Error(${q(message)});`]);
const expect = (cond, message) => `pm.expect(${cond}, ${message}).to.be.true;`;

/** The expected text as a script expression: {{variables}} filled in when it runs. */
const expr = (text) => (hasVar(text) ? `pm.variables.replaceIn(${q(toPm(text))})` : q(String(text ?? '')));

/** `data.items[-1].id` → `pm.response.json()?.data?.items?.at(-1)?.id`, or null for a malformed path. */
export function jsAccess(path) {
  const { segs, error } = parsePath(path);
  if (error) return null;
  return `pm.response.json()${segs.map((s) => {
    if (typeof s === 'number') return s < 0 ? `?.at(${s})` : `?.[${s}]`;
    return /^[A-Za-z_$][\w$]*$/.test(s) ? `?.${s}` : `?.[${q(s)}]`;
  }).join('')}`;
}

// The page's comparisons (shared/api-response.js sameValue, jsonContains), added to a script that uses them.
const HELPERS = {
  pqSame: 'function pqSame(a, e) { if (typeof a === "string") return a === e; if (a === null || typeof a !== "object") return String(a) === e.trim(); try { return JSON.stringify(a) === JSON.stringify(JSON.parse(e)); } catch (err) { return false; } }',
  pqContains: 'function pqContains(a, e) { if (Array.isArray(a)) return a.some(function (x) { return pqSame(x, e); }); if (a !== null && typeof a === "object") return JSON.stringify(a).includes(e); return String(a).includes(e); }',
};

const NOT_CLASS = /^not\s*([1-5])xx$/i;
function statusCond(part) {
  if (/^\d{3}$/.test(part)) return `code === ${Number(part)}`;
  if (/^[1-5]xx$/i.test(part)) return `Math.floor(code / 100) === ${part[0]}`;
  const not = NOT_CLASS.exec(part);
  return not ? `Math.floor(code / 100) !== ${not[1]}` : null;
}

function statusTest(x, label) {
  const want = String(x.expected ?? '');
  const conds = want.split(',').map((s) => s.trim()).filter(Boolean).map(statusCond);
  if (!conds.length || conds.includes(null)) return broken(label, `Status check "${want}": write 200, 2xx, 200,201 or not5xx`);
  return test(label, ['const code = pm.response.code;', expect(conds.join(' || '), `${q(`Expected status ${want}, got `)} + code`)]);
}

const JSON_OPS = {
  exists: (n) => [expect('v !== undefined', q(`Expected ${n} to exist`))],
  notExists: (n) => [expect('v === undefined', `${q(`Expected ${n} not to exist, got `)} + JSON.stringify(v)`)],
  equals: (n) => [expect('pqSame(v, e)', `${q(`Expected ${n} = `)} + JSON.stringify(e) + ", got " + JSON.stringify(v)`)],
  contains: (n) => [expect('pqContains(v, e)', `${q(`Expected ${n} to contain `)} + JSON.stringify(e) + ", got " + JSON.stringify(v)`)],
  gt: (n) => numberTest(n, '>'),
  lt: (n) => numberTest(n, '<'),
};

function numberTest(n, sign) {
  return [
    'const want = Number(e);',
    `if (e.trim() === "" || !Number.isFinite(want)) throw new Error(${q(`${n} ${sign}: `)} + JSON.stringify(e) + " is not a number");`,
    'const got = typeof v === "number" ? v : Number(v);',
    expect(`typeof v !== "boolean" && v !== null && Number.isFinite(got) && got ${sign} want`, `${q(`Expected ${n} ${sign} `)} + want + ", got " + JSON.stringify(v)`),
  ];
}

function jsonTest(x, label, used) {
  const path = String(x.path ?? '').trim();
  const at = jsAccess(path);
  if (!at) return broken(label, `Path ${path}: ${parsePath(path).error}`);
  const op = JSON_OPS[x.op];
  if (!op) return broken(label, `Unknown JSON check "${x.op}"`);
  const n = path || 'the body';
  const lines = [`const v = ${at};`];
  if (!['exists', 'notExists'].includes(x.op)) {
    lines.push(`const e = ${expr(x.expected)};`, expect('v !== undefined', `${q(`Expected ${n} ${x.op === 'equals' ? '=' : x.op} `)} + JSON.stringify(e) + ${q(`, but ${n} is not there`)}`));
  }
  if (x.op === 'equals' || x.op === 'contains') used.add('pqSame');
  if (x.op === 'contains') used.add('pqContains');
  return test(label, [...lines, ...op(n)]);
}

function headerTest(x, label) {
  const name = String(x.path ?? '').trim();
  if (!name) return broken(label, 'Header check: which header?');
  const get = `pm.response.headers.get(${q(name)})`;
  if (x.op === 'exists') return test(label, [expect(`${get} !== undefined`, q(`Expected a ${name} header`))]);
  const cmp = { equals: 'String(v).trim() === e.trim()', contains: 'String(v).toLowerCase().includes(e.toLowerCase())' }[x.op];
  if (!cmp) return broken(label, `Unknown header check "${x.op}"`);
  return test(label, [`const v = ${get};`, `const e = ${expr(x.expected)};`,
    expect('v !== undefined', q(`Expected a ${name} header, there is none`)),
    expect(cmp, `${q(`Expected ${name} ${x.op === 'equals' ? '=' : 'to contain'} `)} + JSON.stringify(e) + ", got " + JSON.stringify(v)`)]);
}

function bodyTest(x, label) {
  if (x.op !== 'contains' && x.op !== 'notContains') return broken(label, `Unknown body check "${x.op}"`);
  const not = x.op === 'notContains';
  return test(label, [`const e = ${expr(x.expected)};`,
    expect(`${not ? '!' : ''}pm.response.text().includes(e)`, `${q(`Expected the body ${not ? 'not ' : ''}to contain `)} + JSON.stringify(e)`)]);
}

function timeTest(x, label) {
  const max = Number(x.expected);
  if (!Number.isFinite(max) || max <= 0) return broken(label, `Time check: "${x.expected}" is not a number of ms`);
  return test(label, [expect(`pm.response.responseTime < ${max}`, `${q(`Expected under ${max} ms, took `)} + pm.response.responseTime + " ms"`)]);
}

function checkTest(x, used) {
  const label = checkLabel({ ...x, expected: toPm(x.expected) });
  switch (x.on) {
    case 'status': return statusTest(x, label);
    case 'json': return jsonTest(x, label, used);
    case 'header': return headerTest(x, label);
    case 'body': return bodyTest(x, label);
    case 'time': return timeTest(x, label);
    default: return broken(label, `Unknown check "${x.on}"`);
  }
}

const setVar = (name, value) => `pm.environment.set(${q(name)}, ${value});`;

function patternTest(pattern) {
  const slots = parsePattern(pattern).filter((p) => 'name' in p);
  const names = slots.map((p) => p.name).filter(Boolean);
  return test(`save ${names.join(', ')}`, [
    `const m = new RegExp(${q(patternRegexSource(pattern))}, "i").exec(pm.response.text());`,
    expect('m !== null', q(`The body does not match ${pattern}`)),
    ...slots.flatMap((p, k) => (p.name ? [setVar(p.name, `(m[${k + 1}] || "").trim()`)] : [])),
  ]);
}

/** A saved value: a test that fails, as the page's run goes ⚠, when there is nothing to save. */
function extractTest(x) {
  const path = String(x.path ?? '').trim();
  if (x.from === 'body' && parsePattern(path).some((p) => p.name)) return patternTest(path);
  const name = normalizeVarName(x.varName);
  if (!name) return broken('save', 'No variable name');
  const label = `save ${name}`;
  switch (x.from) {
    case 'status': return test(label, [setVar(name, 'String(pm.response.code)')]);
    case 'body': return test(label, [setVar(name, 'pm.response.text()')]);
    case 'header': return test(label, [`const v = pm.response.headers.get(${q(path)});`, expect('v !== undefined', q(`No ${path || '(unnamed)'} header`)), setVar(name, 'v')]);
    case 'json': {
      const at = jsAccess(path);
      if (!at) return broken(label, `Path ${path}: ${parsePath(path).error}`);
      return test(label, [`const v = ${at};`, expect('v !== undefined', q(`${path || 'body'} not found`)),
        setVar(name, 'typeof v === "string" ? v : JSON.stringify(v)')]);
    }
    default: return broken(label, `Unknown source "${x.from}"`);
  }
}

/** The lines of a case's test script: the marker, the helpers it uses, a pm.test per check and saved value. */
export function testScript(c) {
  const checks = c.checks || [];
  const extracts = c.extracts || [];
  const keep = { checks, extracts, ...(c.timeoutMs !== DEFAULT_TIMEOUT_MS ? { timeoutMs: c.timeoutMs } : {}) };
  const all = checks.some((x) => x?.on === 'status') ? checks : [DEFAULT_STATUS_CHECK, ...checks];
  const used = new Set();
  // Postman has no timeout per request: one that answers too late fails here, as the page's run would go ⚠.
  const late = keep.timeoutMs ? test(`answers within ${c.timeoutMs} ms`,
    [expect(`pm.response.responseTime < ${c.timeoutMs}`, q(`No response within ${Math.round(c.timeoutMs / 100) / 10} s`))]) : [];
  const tests = [...late, ...all.flatMap((x) => checkTest(x, used)), ...extracts.flatMap(extractTest)];
  // U+2028 / U+2029 end a line in JS, and so the comment; escaped they are the same JSON.
  const marker = MARKER + JSON.stringify(keep).replace(/\p{Zl}|\p{Zp}/gu, (ch) => `\\u${ch.charCodeAt(0).toString(16)}`);
  return [marker, ...[...used].map((k) => HELPERS[k]), ...tests];
}

function requestItem(c, ctx) {
  const auth = pmAuth(c.auth, c.name, ctx);
  const body = pmBody(c);
  return {
    name: c.name,
    event: [{ listen: 'test', script: { type: 'text/javascript', exec: testScript(c) } }],
    ...(c.cookies === false ? { protocolProfileBehavior: { disableCookies: true } } : {}),
    request: {
      method: c.method,
      header: pmHeaders(c, ctx),
      ...(body ? { body } : {}),
      url: toPm(c.url),
      ...(auth ? { auth } : {}),
    },
  };
}

/**
 * The folder `folderId` (or every folder, for ALL) as a collection:
 * { collection, removedSecrets: ['Login: Authorization header', …] }.
 * Each folder is a folder of the collection, its auth on it.
 */
export function toPostman(state, { folderId = ALL, includeSecrets = false } = {}) {
  const ctx = { includeSecrets, removed: [] };
  const folders = folderId === ALL ? state.folders : state.folders.filter((f) => f.id === folderId);
  const name = folderId === ALL ? 'API Tests' : folders[0]?.name || 'API Tests';
  const item = folders.map((f) => {
    // A folder with None needs no auth: the collection has none to inherit.
    const auth = f.auth?.type === 'none' ? undefined : pmAuth(f.auth, `${f.name} (folder)`, ctx);
    return { name: f.name, item: state.cases.filter((c) => c.folderId === f.id).map((c) => requestItem(c, ctx)), ...(auth ? { auth } : {}) };
  });
  return { collection: { info: { name, schema: SCHEMA }, item }, removedSecrets: ctx.removed };
}

/** `Shop API.postman_collection.json`, safe as a file name. */
export function collectionFileName(collection) {
  const stem = String(collection.info.name).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'API Tests';
  return `${stem}.postman_collection.json`;
}
