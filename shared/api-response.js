/**
 * api-response.js — reading an API response: a value at a JSON path, the
 * checks of a test case, the values a case saves into variables.
 *
 * Used by the API Tests page (apicases/run.js) and meant for the API Request
 * step of plan 14. A response is what shared/api-request.js sendRequest()
 * resolves to when it got one: { status, headers: [[name, value]], text, json,
 * isJson, isBinary, ms }.
 *
 * A check is { on, path, op, expected }:
 *   status  op 'is'        expected "201" | "2xx" | "200,201" | "not5xx"
 *   json    op 'equals' | 'contains' | 'exists' | 'notExists' | 'gt' | 'lt'   path "data.items[0].id"
 *   header  op 'exists' | 'equals' | 'contains'                                path = the header name
 *   body    op 'contains' | 'notContains'
 *   time    op 'lt'        expected in ms
 * A check that comes out false is kind 'assert' (the API is wrong); one that
 * cannot be checked — the body is not JSON, the path is malformed, a variable
 * has no value — is kind 'broken' (the test is wrong), as in shared/verdict.js.
 *
 * Pure — no chrome.*, no DOM.
 */

import { normalizeVarName } from './var-name.js';
import { extractWithPattern, patternVarNames } from './text-pattern.js';

// Shown values are cut to this many characters.
const SHOW_MAX = 200;

/* ── JSON path ─────────────────────────────────────────────────────────────── */

/**
 * The segments of a path, or { error }: `data.items[0].id` → ['data', 'items', 0, 'id'].
 * `[-1]` counts from the end, `["x.y"]` is a key holding dots or brackets, a
 * leading `$` (as JSONPath writes it) is allowed, and '' is the whole body.
 */
export function parsePath(path) {
  let p = String(path ?? '').trim();
  if (p === '$' || p.startsWith('$[')) p = p.slice(1);
  else if (p.startsWith('$.')) p = p.slice(2);
  const segs = [];
  let i = 0;
  while (i < p.length) {
    if (p[i] === '[') {
      const b = readBracket(p, i);
      if (b.error) return b;
      segs.push(b.seg);
      i = b.next;
      continue;
    }
    if (p[i] === '.') {
      if (i === 0 || i === p.length - 1) return { error: `A path does not ${i ? 'end' : 'start'} with "."` };
      i++;
    }
    let j = i;
    while (j < p.length && p[j] !== '.' && p[j] !== '[') j++;
    if (j === i) return { error: `Empty name at position ${i + 1}` };
    segs.push(p.slice(i, j));
    i = j;
  }
  return { segs };
}

/** `[0]`, `[-1]` or `["key"]` at `i`: { seg, next } (the index after it), or { error }. */
function readBracket(p, i) {
  const quote = p[i + 1] === '"' ? closingQuote(p, i + 1) : i;
  const end = quote < 0 ? -1 : p.indexOf(']', quote);
  if (end < 0) return { error: `"[" at position ${i + 1} is never closed` };
  const inner = p.slice(i + 1, end).trim();
  let seg;
  if (/^-?\d+$/.test(inner)) seg = Number(inner);
  else if (inner.startsWith('"')) {
    try { seg = JSON.parse(inner); } catch { return { error: `${inner} is not a quoted key` }; }
  } else return { error: `[${inner}] is not an index or a "quoted key"` };
  const next = end + 1;
  if (next < p.length && p[next] !== '.' && p[next] !== '[') return { error: `Expected "." or "[" after "]" at position ${next + 1}` };
  return { seg, next };
}

/** The index of the quote that closes the one at `start`, skipping escaped quotes; -1 if none. */
function closingQuote(s, start) {
  for (let k = start + 1; k < s.length; k++) {
    if (s[k] === '\\') k++;
    else if (s[k] === '"') return k;
  }
  return -1;
}

/** One step down: { found, value }. Own keys only; `length` of an array or a string. */
function step(cur, seg) {
  if (typeof seg === 'number' && Array.isArray(cur)) {
    const i = seg < 0 ? cur.length + seg : seg;
    return i >= 0 && i < cur.length ? { found: true, value: cur[i] } : { found: false };
  }
  const key = String(seg);
  if (cur !== null && typeof cur === 'object' && Object.hasOwn(cur, key)) return { found: true, value: cur[key] };
  if (key === 'length' && (Array.isArray(cur) || typeof cur === 'string')) return { found: true, value: cur.length };
  return { found: false };
}

/** { found: true, value } at `path` in `value`, { found: false }, or { error } for a malformed path. */
export function jsonPath(value, path) {
  const parsed = parsePath(path);
  if (parsed.error) return parsed;
  let cur = { found: true, value };
  for (const seg of parsed.segs) {
    cur = step(cur.value, seg);
    if (!cur.found) return cur;
  }
  return cur;
}

/** The path jsonPath() reads `segs` with: ['data', 'items', 0, 'x.y'] → data.items[0]["x.y"]. */
export function pathOf(segs) {
  return segs.map((s, i) => {
    if (typeof s === 'number') return `[${s}]`;
    const plain = /^[^.[\]"\s$]+$/.test(s) && !/^-?\d+$/.test(s);
    if (plain) return i ? `.${s}` : s;
    return `[${JSON.stringify(s)}]`;
  }).join('');
}

/* ── Checks ────────────────────────────────────────────────────────────────── */

const show = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > SHOW_MAX ? `${s.slice(0, SHOW_MAX)}…` : s;
};
const quoted = (v) => (typeof v === 'string' ? `"${show(v)}"` : show(v));

/** `text` with ${name} filled from `vars`; names it lacks are added to `missing`. */
function fill(text, vars, missing) {
  return String(text ?? '').replace(/\$\{([^}]+)\}/g, (ref, k) => {
    if (Object.hasOwn(vars, k)) return String(vars[k]);
    missing.add(k);
    return ref;
  });
}

/** A JSON value equal to the expected text: "42" is 42, "true" is true, '{"a":1}' is { a: 1 }. */
function sameValue(actual, expected) {
  if (typeof actual === 'string') return actual === expected;
  if (actual === null || typeof actual !== 'object') return String(actual) === expected.trim();
  try { return JSON.stringify(actual) === JSON.stringify(JSON.parse(expected)); } catch { return false; }
}

const STATUS_CLASS = /^([1-5])xx$/i;
const NOT_CLASS = /^not\s*([1-5])xx$/i;

/** Whether `status` is one of "201", "2xx", "200,201", "not5xx"; null when the text is none of those. */
export function statusMatches(status, expected) {
  const parts = String(expected).split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  let hit = false;
  for (const part of parts) {
    if (/^\d{3}$/.test(part)) hit ||= status === Number(part);
    else if (STATUS_CLASS.test(part)) hit ||= Math.floor(status / 100) === Number(part[0]);
    else if (NOT_CLASS.test(part)) hit ||= Math.floor(status / 100) !== Number(NOT_CLASS.exec(part)[1]);
    else return null;
  }
  return hit;
}

const pass = () => ({ ok: true, kind: null });
const fail = (message, actual) => ({ ok: false, kind: 'assert', message, ...(actual === undefined ? {} : { actual: show(actual) }) });
const broken = (message) => ({ ok: false, kind: 'broken', message });

function checkStatus(res, expected) {
  const hit = statusMatches(res.status, expected);
  if (hit === null) return broken(`Status check "${expected}": write 200, 2xx, 200,201 or not5xx`);
  return hit ? pass() : fail(`Expected status ${expected}, got ${res.status}`, res.status);
}

function compareNumbers(op, path, actual, expected) {
  const want = Number(expected);
  if (expected.trim() === '' || !Number.isFinite(want)) return broken(`${path} ${op === 'gt' ? '>' : '<'}: "${expected}" is not a number`);
  const got = typeof actual === 'number' ? actual : Number(actual);
  const ok = typeof actual !== 'boolean' && actual !== null && Number.isFinite(got) && (op === 'gt' ? got > want : got < want);
  return ok ? pass() : fail(`Expected ${path} ${op === 'gt' ? '>' : '<'} ${want}, got ${quoted(actual)}`, actual);
}

function jsonContains(actual, expected) {
  if (Array.isArray(actual)) return actual.some((el) => sameValue(el, expected));
  if (actual !== null && typeof actual === 'object') return JSON.stringify(actual).includes(expected);
  return String(actual).includes(expected);
}

function checkJson(res, path, op, expected) {
  if (res.isBinary) return broken('The response is binary, not JSON');
  if (!res.isJson) return broken('The response is not JSON');
  const at = jsonPath(res.json, path);
  if (at.error) return broken(`Path ${path}: ${at.error}`);
  const name = path || 'the body';
  if (op === 'exists') return at.found ? pass() : fail(`Expected ${name} to exist`);
  if (op === 'notExists') return at.found ? fail(`Expected ${name} not to exist, got ${quoted(at.value)}`, at.value) : pass();
  if (!at.found) return fail(`Expected ${name} ${op === 'equals' ? '=' : op} ${quoted(expected)}, but ${name} is not there`);
  if (op === 'gt' || op === 'lt') return compareNumbers(op, name, at.value, expected);
  if (op === 'equals') return sameValue(at.value, expected) ? pass() : fail(`Expected ${name} = ${quoted(expected)}, got ${quoted(at.value)}`, at.value);
  if (op === 'contains') return jsonContains(at.value, expected) ? pass() : fail(`Expected ${name} to contain ${quoted(expected)}, got ${quoted(at.value)}`, at.value);
  return broken(`Unknown JSON check "${op}"`);
}

/** The value of header `name` (any case), or undefined. */
export function headerValue(res, name) {
  const n = String(name).trim().toLowerCase();
  return (res.headers || []).find(([k]) => k.toLowerCase() === n)?.[1];
}

function checkHeader(res, name, op, expected) {
  if (!String(name ?? '').trim()) return broken('Header check: which header?');
  const v = headerValue(res, name);
  if (op === 'exists') return v === undefined ? fail(`Expected a ${name} header`) : pass();
  if (v === undefined) return fail(`Expected a ${name} header, there is none`);
  // Header values are compared as HTTP does for most of them: equals exactly, contains in any case.
  if (op === 'equals') return v.trim() === expected.trim() ? pass() : fail(`Expected ${name}: ${quoted(expected)}, got ${quoted(v)}`, v);
  if (op === 'contains') return v.toLowerCase().includes(expected.toLowerCase()) ? pass() : fail(`Expected ${name} to contain ${quoted(expected)}, got ${quoted(v)}`, v);
  return broken(`Unknown header check "${op}"`);
}

function checkBody(res, op, expected) {
  if (res.isBinary) return broken('The response is binary — body text checks do not apply');
  const has = res.text.includes(expected);
  if (op === 'contains') return has ? pass() : fail(`Expected the body to contain ${quoted(expected)}`);
  if (op === 'notContains') return has ? fail(`Expected the body not to contain ${quoted(expected)}`) : pass();
  return broken(`Unknown body check "${op}"`);
}

function checkTime(res, expected) {
  const max = Number(expected);
  if (!Number.isFinite(max) || max <= 0) return broken(`Time check: "${expected}" is not a number of ms`);
  return res.ms < max ? pass() : fail(`Expected under ${max} ms, took ${res.ms} ms`, res.ms);
}

const RUN = {
  status: (res, c, expected) => checkStatus(res, expected),
  json: (res, c, expected) => checkJson(res, String(c.path ?? '').trim(), c.op, expected),
  header: (res, c, expected) => checkHeader(res, c.path, c.op, expected),
  body: (res, c, expected) => checkBody(res, c.op, expected),
  time: (res, c, expected) => checkTime(res, expected),
};

/** The check a case has when it has no status check of its own: a 500 never passes unnoticed. */
export const DEFAULT_STATUS_CHECK = Object.freeze({ on: 'status', op: 'is', expected: '2xx', implicit: true });

/** What a check says, for its row: `status is 2xx`, `data.id exists`, `time < 1000 ms`. */
export function checkLabel(c) {
  const v = c.expected ?? '';
  switch (c.on) {
    case 'status': return `status is ${v}${c.implicit ? ' (default)' : ''}`;
    case 'json': return `${c.path || 'body'} ${{ equals: '=', gt: '>', lt: '<', notExists: 'does not exist' }[c.op] || c.op}${['exists', 'notExists'].includes(c.op) ? '' : ` ${v}`}`;
    case 'header': return `header ${c.path} ${c.op}${c.op === 'exists' ? '' : ` ${v}`}`;
    case 'body': return `body ${c.op === 'notContains' ? 'does not contain' : 'contains'} ${v}`;
    case 'time': return `time < ${v} ms`;
    default: return `${c.on} ${c.op} ${v}`;
  }
}

/**
 * Each check against the response: [{ check, label, ok, kind, message?, actual? }],
 * in order, with DEFAULT_STATUS_CHECK first when the case has no status check.
 * `expected` may hold ${variables}, filled from `vars`.
 */
export function runChecks(res, checks = [], vars = {}) {
  const list = (checks || []).some((c) => c?.on === 'status') ? checks : [DEFAULT_STATUS_CHECK, ...(checks || [])];
  return list.map((c) => {
    const missing = new Set();
    const expected = fill(c.expected, vars, missing);
    const run = RUN[c.on];
    let r;
    if (missing.size) r = broken(`No value for ${[...missing].map((k) => `\${${k}}`).join(', ')}`);
    else if (!run) r = broken(`Unknown check "${c.on}"`);
    else r = run(res, c, expected);
    return { check: c, label: checkLabel({ ...c, expected }), ...r };
  });
}

/* ── Saving values into variables ──────────────────────────────────────────── */

/** A value as a variable holds it: strings as they are, anything else as JSON. */
const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

function extractOne(res, x) {
  const path = String(x.path ?? '').trim();
  if (x.from === 'status') return { value: String(res.status) };
  if (x.from === 'header') {
    const v = headerValue(res, path);
    return v === undefined ? { reason: `No ${path || '(unnamed)'} header` } : { value: v };
  }
  if (x.from === 'json') {
    if (!res.isJson) return { reason: 'The response is not JSON' };
    const at = jsonPath(res.json, path);
    if (at.error) return { reason: `Path ${path}: ${at.error}` };
    return at.found ? { value: asText(at.value) } : { reason: `${path || 'body'} not found` };
  }
  if (x.from === 'body') return res.isBinary ? { reason: 'The response is binary' } : { value: res.text };
  return { reason: `Unknown source "${x.from}"` };
}

/**
 * The values `extracts` take from the response: { values: { name: text },
 * problems: [{ varName, reason }] }. An extract is { varName, from: 'json' |
 * 'header' | 'status' | 'body', path }. From the body, a path holding ${names}
 * is an Extract pattern (as Read DOM's): each ${name} gets its part; with no
 * pattern the whole body goes to varName.
 */
export function extractValues(res, extracts = []) {
  const values = {};
  const problems = [];
  for (const x of extracts || []) {
    const pattern = x.from === 'body' ? String(x.path ?? '').trim() : '';
    if (pattern && patternVarNames(pattern).length) {
      const parts = res.isBinary ? null : extractWithPattern(res.text, pattern);
      if (parts) Object.assign(values, parts);
      else problems.push({ varName: patternVarNames(pattern).join(', '), reason: res.isBinary ? 'The response is binary' : `The body does not match ${pattern}` });
      continue;
    }
    const name = normalizeVarName(x.varName);
    if (!name) { problems.push({ varName: String(x.varName ?? ''), reason: 'No variable name' }); continue; }
    const r = extractOne(res, x);
    if ('value' in r) values[name] = r.value;
    else problems.push({ varName: name, reason: r.reason });
  }
  return { values, problems };
}
