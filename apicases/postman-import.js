/**
 * postman-import.js — a Postman Collection (v2.0 or v2.1), or a Postman
 * environment file, read into folders, cases and an environment for the page.
 *
 * {{x}} becomes ${x}. Folders inside folders are made flat, "Parent / Child";
 * requests at the top go into a folder named after the collection. A folder
 * takes the auth it would have in Postman: its own, else its parent's, else
 * the collection's. A turned-off header becomes a "# " line. The collection's
 * variables become an environment the Import dialog offers to add.
 *
 * A test script exported by this page (postman-export.js) starts with
 * `// pocket-qa: {…}`: its checks and saved values come back from that line.
 * Any other script is never run — JS from a file is not turned into checks,
 * and this page runs no one else's code — and, like a form-data body, an
 * OAuth 2 auth or anything else the page has no place for, it is named in
 * the notes rather than dropped without a word.
 *
 * Pure — no chrome.*, no DOM.
 */

import { normalizeVarName } from '../shared/var-name.js';
import { DEFAULT_TIMEOUT_MS, METHODS, addEnvironment, makeCase, newId, normalizeAuth, normalizeState } from './model.js';
import { MARKER } from './postman-export.js';

/** The largest file the Import dialog reads. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/** {{x}} → ${x}; anything not a string is read as text, null as ''. */
export const fromPm = (v) => (v === null || v === undefined ? '' : String(v)).replace(/\{\{([^{}]+)\}\}/g, (m, k) => `\${${k}}`);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

/** Notes: what → the requests (or folders) it happened to. */
function note(ctx, what, who) {
  (ctx.notes[what] ||= []).push(who);
}

function noteLines(notes) {
  return Object.entries(notes).map(([what, who]) => {
    const names = [...new Set(who)];
    return `${what}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}`;
  });
}

/* ── Auth ──────────────────────────────────────────────────────────────────── */

/** An auth's fields: v2.1 writes [{ key, value }], v2.0 an object. */
function authFields(a) {
  const p = a[a.type];
  if (Array.isArray(p)) return Object.fromEntries(p.filter((x) => isObj(x) && typeof x.key === 'string').map((x) => [x.key, x.value]));
  return isObj(p) ? p : {};
}

const AUTH = {
  noauth: () => ({ type: 'none' }),
  bearer: (p) => ({ type: 'bearer', token: fromPm(p.token) }),
  basic: (p) => ({ type: 'basic', username: fromPm(p.username), password: fromPm(p.password) }),
  apikey: (p) => ({ type: 'apikey', key: fromPm(p.key), value: fromPm(p.value), in: p.in === 'query' ? 'query' : 'header' }),
};

/** The page's auth, or null when Postman would inherit. One the page does not have is None, and noted. */
function readAuth(a, who, ctx) {
  if (!isObj(a) || !a.type || a.type === 'inherit') return null;
  if (AUTH[a.type]) return AUTH[a.type](authFields(a));
  note(ctx, `${a.type} auth set to None`, who);
  return { type: 'none' };
}

/* ── Request ───────────────────────────────────────────────────────────────── */

function readHeaders(h) {
  if (typeof h === 'string') return fromPm(h);
  return list(h).filter((x) => isObj(x) && x.key).map((x) => `${x.disabled ? '# ' : ''}${x.key}: ${fromPm(x.value)}`).join('\n');
}

/** A URL: v2 writes a string or { raw, host, path, query }. */
function readUrl(u) {
  if (!isObj(u)) return fromPm(u);
  if (typeof u.raw === 'string') return fromPm(u.raw);
  const host = Array.isArray(u.host) ? u.host.join('.') : String(u.host ?? '');
  const path = Array.isArray(u.path) ? u.path.map((p) => (isObj(p) ? p.value ?? '' : p)).join('/') : String(u.path ?? '');
  const query = list(u.query).filter((x) => isObj(x) && !x.disabled && x.key).map((x) => `${x.key}=${x.value ?? ''}`).join('&');
  return fromPm(`${u.protocol ? `${u.protocol}://` : ''}${host}${path ? `/${path}` : ''}${query ? `?${query}` : ''}`);
}

/** URL-encoded, the ${variables} left as they are (they are encoded when sent). */
const encodePart = (t) => t.split(/(\$\{[^}]*\})/).map((p, i) => (i % 2 ? p : encodeURIComponent(p))).join('');

function formBody(rows, who, ctx) {
  if (list(rows).some((r) => r?.disabled)) note(ctx, 'turned-off form fields left out', who);
  return list(rows).filter((r) => isObj(r) && !r.disabled && r.key).map((r) => `${encodePart(fromPm(r.key))}=${encodePart(fromPm(r.value))}`).join('&');
}

function graphqlBody(g) {
  let variables = {};
  try { variables = g?.variables ? JSON.parse(g.variables) : {}; } catch { variables = g.variables; }
  return fromPm(JSON.stringify({ query: g?.query ?? '', variables }, null, 2));
}

function readBody(b, headers, who, ctx) {
  const none = { bodyType: 'none', body: '' };
  if (!isObj(b) || b.disabled) return none;
  switch (b.mode) {
    case 'raw': {
      const lang = b.options?.raw?.language;
      const json = lang ? lang === 'json' : /^content-type:[^\n]*json/im.test(headers);
      return { bodyType: json ? 'json' : 'text', body: fromPm(b.raw) };
    }
    case 'urlencoded': return { bodyType: 'form', body: formBody(b.urlencoded, who, ctx) };
    case 'graphql': note(ctx, 'GraphQL body sent as JSON { query, variables }', who); return { bodyType: 'json', body: graphqlBody(b.graphql) };
    case 'formdata': note(ctx, 'form-data body (fields and files) left out', who); return none;
    case 'file': note(ctx, 'file body left out', who); return none;
    default: return none;
  }
}

/** The checks, saved values and timeout of a `// pocket-qa:` line, or null when it is not one. */
function readMarker(line) {
  let k;
  try { k = JSON.parse(line.slice(MARKER.length)); } catch { return null; }
  if (!isObj(k)) return null;
  const timeout = Number(k.timeoutMs);
  return {
    checks: list(k.checks).filter(isObj),
    extracts: list(k.extracts).filter(isObj),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
  };
}

/** What an item's scripts give back: the page's own line, else a note that a script is not run. */
function readScripts(item, who, ctx) {
  for (const ev of list(item.event)) {
    const exec = ev?.script?.exec;
    const lines = (Array.isArray(exec) ? exec : String(exec ?? '').split(/\r?\n/)).map(String);
    if (!lines.some((l) => l.trim())) continue;
    const kept = ev.listen === 'test' && lines[0].startsWith(MARKER) ? readMarker(lines[0]) : null;
    if (kept) return kept;
    note(ctx, `${ev.listen === 'prerequest' ? 'pre-request' : 'test'} script not run`, who);
  }
  return {};
}

function readRequest(item, ctx) {
  const who = String(item.name || 'Request');
  // v2 lets a request be just its URL.
  const r = typeof item.request === 'string' ? { url: item.request } : { ...item.request };
  const method = String(r.method || 'GET').toUpperCase();
  if (!METHODS.includes(method)) note(ctx, `${method} sent as GET`, who);
  const headers = readHeaders(r.header);
  const kept = readScripts(item, who, ctx);
  return {
    name: who,
    method: METHODS.includes(method) ? method : 'GET',
    url: readUrl(r.url),
    headers,
    ...readBody(r.body, headers, who, ctx),
    auth: readAuth(r.auth, who, ctx) || { type: 'inherit' },
    cookies: item.protocolProfileBehavior?.disableCookies !== true,
    checks: kept.checks || [],
    extracts: kept.extracts || [],
    timeoutMs: kept.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/**
 * The items of a collection ('' name) or folder: its requests into a folder
 * of that name — left out when it has none but has folders of its own — then
 * each folder in it walked as `name / child`.
 */
function walk(items, name, auth, ctx) {
  const here = { name, auth, cases: [] };
  ctx.folders.push(here);
  let subfolders = 0;
  for (const it of list(items)) {
    if (!isObj(it)) continue;
    if (!Array.isArray(it.item)) { here.cases.push(readRequest(it, ctx)); continue; }
    subfolders++;
    const child = String(it.name || 'Folder');
    readScripts(it, `${child} (folder)`, ctx);
    walk(it.item, name ? `${name} / ${child}` : child, readAuth(it.auth, `${child} (folder)`, ctx) || auth, ctx);
  }
  if (!here.cases.length && (subfolders || !name)) ctx.folders.splice(ctx.folders.indexOf(here), 1);
}

function readVars(rows) {
  return list(rows).filter((v) => isObj(v) && v.enabled !== false && !v.disabled)
    .map((v) => ({ name: normalizeVarName(v.key), value: fromPm(v.value) })).filter((v) => v.name);
}

function readCollection(json) {
  const name = String(json.info.name || 'Postman collection');
  const ctx = { notes: {}, folders: [] };
  readScripts(json, `${name} (collection)`, ctx);
  walk(json.item, '', readAuth(json.auth, `${name} (collection)`, ctx) || { type: 'none' }, ctx);
  // Requests at the top go into a folder named after the collection; its folders keep their own names.
  const folders = ctx.folders.map((f) => (f.name ? f : { ...f, name }));
  const vars = readVars(json.variable);
  return { kind: 'collection', name, folders, environment: vars.length ? { name: `${name} variables`, vars } : null, notes: noteLines(ctx.notes) };
}

const V1 = 'This is a Postman Collection v1 — open it in Postman, export it as Collection v2.1 and import that file.';
const NOT_POSTMAN = 'Not a Postman collection or environment file — export one from Postman (Collection v2.1, or an environment).';

/**
 * A parsed JSON file as { kind: 'collection' | 'environment', name, folders:
 * [{ name, auth, cases: [fields] }], environment: { name, vars } | null,
 * notes: [text] }, or { error }.
 */
export function fromPostman(input) {
  const json = isObj(input?.collection) && isObj(input.collection.info) ? input.collection : input;
  if (!isObj(json)) return { error: NOT_POSTMAN };
  if (['environment', 'globals'].includes(json._postman_variable_scope)) {
    const name = String(json.name || 'Postman environment');
    return { kind: 'environment', name, folders: [], environment: { name, vars: readVars(json.values) }, notes: [] };
  }
  const schema = String(json.info?.schema ?? '');
  if (Array.isArray(json.requests) || /collection\/v1/.test(schema)) return { error: V1 };
  if (!isObj(json.info) || !Array.isArray(json.item)) return { error: NOT_POSTMAN };
  if (schema && !/collection\/v2\.[01]\.\d/.test(schema)) return { error: `Collection format ${schema.split('/').at(-2) || schema} is not read here — export it from Postman as Collection v2.1.` };
  return readCollection(json);
}

/** Where the requests go: each host, or the ${variable} a URL starts with — filled in from the file's variables when they say. */
export function hostsOf(parsed) {
  const known = Object.fromEntries((parsed.environment?.vars || []).map((v) => [v.name, v.value]));
  const hosts = new Set();
  for (const c of parsed.folders.flatMap((f) => f.cases)) {
    const url = c.url.trim().replace(/\$\{([^}]*)\}/g, (m, k) => known[k] ?? m);
    const lead = /^\$\{[^}]*\}/.exec(url);
    if (lead) { hosts.add(lead[0]); continue; }
    const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)?.[1];
    hosts.add(host || url.split(/[/?#]/)[0] || '(no URL)');
  }
  return [...hosts];
}

const freeName = (name, taken) => {
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} (${n})`)) n++;
  return `${name} (${n})`;
};

/**
 * The state with what fromPostman() read added: its folders after the ones
 * there are ("Shop (2)" when a "Shop" exists), the first of them opened, and
 * its environment unless `environment` is false.
 */
export function importInto(state, parsed, { environment = true } = {}) {
  const taken = new Set(state.folders.map((f) => f.name));
  const folders = [];
  const cases = [];
  for (const f of parsed.folders) {
    const folder = { id: newId(), name: freeName(f.name, taken), auth: normalizeAuth(f.auth, 'none') };
    taken.add(folder.name);
    folders.push(folder);
    cases.push(...f.cases.map((c) => makeCase({ ...c, folderId: folder.id })));
  }
  let next = { ...state, folders: [...state.folders, ...folders], cases: [...state.cases, ...cases] };
  if (folders.length) next = { ...next, folderId: folders[0].id, caseId: null };
  if (environment && parsed.environment) {
    const name = freeName(parsed.environment.name, new Set(state.environments.map((e) => e.name)));
    next = addEnvironment(next, name, parsed.environment.vars).state;
  }
  // The same cleaning a saved state gets: a timeout out of range, a stray field type.
  return normalizeState(next);
}
