/**
 * model.js — the API Tests page's data: folders, the cases in them, the
 * environments (sets of variables, one of them in use), and which folder and
 * case are open. Kept in chrome.storage.local under STATE_KEY.
 *
 * Every function takes a state and returns a new one; the state passed in is
 * never changed, so the page can keep the previous one for Undo.
 *
 * The order of `cases` is the order the list shows: a folder's cases are the
 * ones whose folderId is that folder, in array order.
 *
 * Pure — no chrome.*, no DOM.
 */

import { normalizeVarName } from '../shared/var-name.js';

export const STATE_KEY = 'apiCasesState';

/** The "All requests" entry of the folder list: not a folder, a view of every case. */
export const ALL = '__all__';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const BODY_TYPES = ['none', 'json', 'text', 'form'];
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 60_000;

const DEFAULT_FOLDER_NAME = 'My API tests';

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** The environment a page starts with, and gets back when its saved ones are unusable. */
const DEFAULT_ENV_ID = 'default';
const defaultEnv = () => ({ id: DEFAULT_ENV_ID, name: 'Default', vars: [] });

export function emptyState() {
  return { folders: [], cases: [], environments: [defaultEnv()], envId: DEFAULT_ENV_ID, folderId: ALL, caseId: null };
}

/** A case with every field filled in; `fields` overrides the defaults. */
export function makeCase(fields = {}) {
  return {
    id: newId(),
    folderId: null,
    name: 'New request',
    method: 'GET',
    url: '',
    headers: '',
    bodyType: 'none',
    body: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cookies: true,
    auth: { type: 'inherit' },
    ...fields,
  };
}

const str = (v, d = '') => (typeof v === 'string' ? v : d);

/** Auth of a case ('inherit' takes its folder's) or a folder (never 'inherit'). */
export const AUTH_TYPES = ['inherit', 'none', 'bearer', 'basic', 'apikey'];

/** An auth made safe: a known type (else `fallback`), string fields, `in` header or query. */
export function normalizeAuth(a, fallback) {
  let type = AUTH_TYPES.includes(a?.type) ? a.type : fallback;
  if (type === 'inherit' && fallback === 'none') type = 'none';
  const out = { type };
  for (const k of ['token', 'username', 'password', 'key', 'value']) if (typeof a?.[k] === 'string') out[k] = a[k];
  if (type === 'apikey') out.in = a?.in === 'query' ? 'query' : 'header';
  return out;
}

/** The case as it is sent (shared/api-request.js): with its folder's auth when it inherits. */
export function requestOf(state, c) {
  if (c.auth?.type !== 'inherit') return c;
  return { ...c, auth: state.folders.find((f) => f.id === c.folderId)?.auth || { type: 'none' } };
}

export function setFolderAuth(state, id, auth) {
  return { ...state, folders: state.folders.map((f) => (f.id === id ? { ...f, auth: normalizeAuth(auth, 'none') } : f)) };
}

/** The verdicts a case's last result (apicases/run.js lastOf) can have. */
export const VERDICTS = ['passed', 'failed', 'broken'];

/** A saved last result made safe to render, or null when it is not one. */
function normalizeLast(l) {
  if (!l || typeof l !== 'object' || !VERDICTS.includes(l.verdict)) return null;
  const failures = (Array.isArray(l.failures) ? l.failures : []).filter((f) => typeof f?.reason === 'string');
  return { ...l, failures, bodyHead: str(l.bodyHead) };
}

function normalizeCase(raw, folderIds) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !folderIds.has(raw.folderId)) return null;
  const { last: rawLast, ...c } = raw;
  const last = normalizeLast(rawLast);
  const timeout = Number(c.timeoutMs);
  return {
    ...c,
    ...(last ? { last } : {}),
    name: str(c.name, 'Request'),
    method: METHODS.includes(c.method) ? c.method : 'GET',
    url: str(c.url),
    headers: str(c.headers),
    bodyType: BODY_TYPES.includes(c.bodyType) ? c.bodyType : 'none',
    body: str(c.body),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
    cookies: c.cookies !== false,
    auth: normalizeAuth(c.auth, 'inherit'),
  };
}

function normalizeEnvironments(raw) {
  const envs = (Array.isArray(raw) ? raw : [])
    .filter((e) => e && typeof e.id === 'string')
    .map((e) => ({
      id: e.id,
      name: str(e.name, 'Environment'),
      vars: (Array.isArray(e.vars) ? e.vars : []).filter((v) => v && typeof v === 'object')
        .map((v) => ({ name: str(v.name), value: str(v.value) })),
    }));
  return envs.length ? envs : [defaultEnv()];
}

/**
 * What was saved, made safe to render: anything not shaped like a folder, a
 * case or an environment is dropped (a case whose folder is gone included),
 * there is always at least one environment, and the open folder and case and
 * the environment in use fall back when they no longer exist.
 */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return emptyState();
  const folders = (Array.isArray(raw.folders) ? raw.folders : [])
    .filter((f) => f && typeof f.id === 'string')
    .map((f) => ({ ...f, name: str(f.name, 'Folder'), auth: normalizeAuth(f.auth, 'none') }));
  const folderIds = new Set(folders.map((f) => f.id));
  const cases = (Array.isArray(raw.cases) ? raw.cases : []).map((c) => normalizeCase(c, folderIds)).filter(Boolean);
  const environments = normalizeEnvironments(raw.environments);
  const envId = environments.some((e) => e.id === raw.envId) ? raw.envId : environments[0].id;
  const folderId = folderIds.has(raw.folderId) ? raw.folderId : ALL;
  const caseId = cases.some((c) => c.id === raw.caseId) ? raw.caseId : null;
  return { folders, cases, environments, envId, folderId, caseId };
}

export const findCase = (state, id) => state.cases.find((c) => c.id === id) || null;
export const findFolder = (state, id) => state.folders.find((f) => f.id === id) || null;

/** The open folder and case changed, nothing else. */
export function select(state, { folderId = state.folderId, caseId = state.caseId }) {
  return { ...state, folderId, caseId };
}

export function addFolder(state, name) {
  const folder = { id: newId(), name: name.trim() || 'Folder', auth: { type: 'none' } };
  return { state: { ...state, folders: [...state.folders, folder], folderId: folder.id, caseId: null }, id: folder.id };
}

export function renameFolder(state, id, name) {
  const n = name.trim();
  if (!n) return state;
  return { ...state, folders: state.folders.map((f) => (f.id === id ? { ...f, name: n } : f)) };
}

/** The folder and every case in it. */
export function deleteFolder(state, id) {
  const cases = state.cases.filter((c) => c.folderId !== id);
  return {
    ...state,
    folders: state.folders.filter((f) => f.id !== id),
    cases,
    folderId: state.folderId === id ? ALL : state.folderId,
    caseId: cases.some((c) => c.id === state.caseId) ? state.caseId : null,
  };
}

/**
 * Where a new case goes: the open folder, or under "All requests" the first
 * folder — created, as DEFAULT_FOLDER_NAME, when there is none yet.
 */
function targetFolder(state) {
  if (state.folderId !== ALL) return { state, folderId: state.folderId };
  if (state.folders.length) return { state, folderId: state.folders[0].id };
  const { state: next, id } = addFolder(state, DEFAULT_FOLDER_NAME);
  return { state: { ...next, folderId: ALL }, folderId: id };
}

/** A new case in the open folder, opened. */
export function addCase(state, fields = {}) {
  const { state: s, folderId } = targetFolder(state);
  const c = makeCase({ ...fields, folderId });
  return { state: { ...s, cases: [...s.cases, c], caseId: c.id }, id: c.id };
}

export function updateCase(state, id, patch) {
  return { ...state, cases: state.cases.map((c) => (c.id === id ? { ...c, ...patch, id } : c)) };
}

/** A copy right after the original, without its run result, opened. */
export function duplicateCase(state, id) {
  const i = state.cases.findIndex((c) => c.id === id);
  if (i < 0) return { state, id: null };
  const { last: _last, ...rest } = state.cases[i];
  const copy = { ...structuredClone(rest), id: newId(), name: `${rest.name} (copy)` };
  const cases = [...state.cases.slice(0, i + 1), copy, ...state.cases.slice(i + 1)];
  return { state: { ...state, cases, caseId: copy.id }, id: copy.id };
}

export function deleteCases(state, ids) {
  const gone = new Set(ids);
  return {
    ...state,
    cases: state.cases.filter((c) => !gone.has(c.id)),
    caseId: gone.has(state.caseId) ? null : state.caseId,
  };
}

/** Into another folder, after the cases already there. */
export function moveCases(state, ids, folderId) {
  if (!findFolder(state, folderId)) return state;
  const moving = new Set(ids);
  const moved = state.cases.filter((c) => moving.has(c.id)).map((c) => ({ ...c, folderId }));
  return { ...state, cases: [...state.cases.filter((c) => !moving.has(c.id)), ...moved] };
}

/** Case `id` moved to just before case `beforeId`, or to the end when beforeId is null. */
export function reorderCase(state, id, beforeId) {
  if (id === beforeId) return state;
  const c = findCase(state, id);
  if (!c) return state;
  const rest = state.cases.filter((x) => x.id !== id);
  const at = beforeId === null ? rest.length : rest.findIndex((x) => x.id === beforeId);
  if (at < 0) return state;
  return { ...state, cases: [...rest.slice(0, at), c, ...rest.slice(at)] };
}

/**
 * The cases the middle column lists: the open folder's (or all), filtered by
 * text, method and last result (a verdict, or 'none' for not run yet).
 */
export function visibleCases(state, { query = '', method = '', result = '' } = {}) {
  const q = query.trim().toLowerCase();
  return state.cases.filter((c) => (state.folderId === ALL || c.folderId === state.folderId)
    && (!method || c.method === method)
    && (!result || (c.last?.verdict || 'none') === result)
    && (!q || c.name.toLowerCase().includes(q) || c.url.toLowerCase().includes(q)));
}

/* ── Environments ──────────────────────────────────────────────────────────── */

/** The environment in use. */
export const activeEnv = (state) => state.environments.find((e) => e.id === state.envId) || state.environments[0];
export const findEnv = (state, id) => state.environments.find((e) => e.id === id) || null;

export function useEnvironment(state, id) {
  return findEnv(state, id) ? { ...state, envId: id } : state;
}

/** A new environment (not put in use): { state, id }. */
export function addEnvironment(state, name, vars = []) {
  const env = { id: newId(), name: name.trim() || 'Environment', vars: vars.map((v) => ({ name: v.name, value: v.value })) };
  return { state: { ...state, environments: [...state.environments, env] }, id: env.id };
}

const mapEnv = (state, id, f) => ({ ...state, environments: state.environments.map((e) => (e.id === id ? f(e) : e)) });

export function renameEnvironment(state, id, name) {
  const n = name.trim();
  return n ? mapEnv(state, id, (e) => ({ ...e, name: n })) : state;
}

/** A copy right after the original: { state, id }. */
export function duplicateEnvironment(state, id) {
  const i = state.environments.findIndex((e) => e.id === id);
  if (i < 0) return { state, id: null };
  const src = state.environments[i];
  const copy = { id: newId(), name: `${src.name} (copy)`, vars: src.vars.map((v) => ({ ...v })) };
  const environments = [...state.environments.slice(0, i + 1), copy, ...state.environments.slice(i + 1)];
  return { state: { ...state, environments }, id: copy.id };
}

/** Gone, unless it is the last one; the one in use falls back to the first left. */
export function deleteEnvironment(state, id) {
  if (state.environments.length < 2 || !findEnv(state, id)) return state;
  const environments = state.environments.filter((e) => e.id !== id);
  return { ...state, environments, envId: state.envId === id ? environments[0].id : state.envId };
}

/** The variables of environment `id`, replaced: [{ name, value }]. */
export function setEnvVars(state, id, vars) {
  return mapEnv(state, id, (e) => ({ ...e, vars: vars.map((v) => ({ name: v.name, value: v.value })) }));
}

/** `values` ({ name: value }) written into the environment in use: a name already there is updated, a new one added. */
export function saveEnvValues(state, values) {
  const names = Object.keys(values || {});
  if (!names.length) return state;
  return mapEnv(state, activeEnv(state).id, (e) => {
    const vars = e.vars.map((v) => (Object.hasOwn(values, v.name) ? { ...v, value: values[v.name] } : v));
    for (const n of names) if (!vars.some((v) => v.name === n)) vars.push({ name: n, value: values[n] });
    return { ...e, vars };
  });
}

/**
 * What is wrong with each variable row of an environment, by index: '' when
 * nothing. Names follow the Tools tab's rule (normalizeVarName: no "}"), and
 * two rows may not share one.
 */
export function envVarProblems(vars) {
  const seen = new Set();
  return vars.map((v) => {
    if (!v.name.trim()) return v.value ? 'Name this variable' : '';
    const n = normalizeVarName(v.name);
    if (!n) return 'A name cannot hold "}"';
    if (seen.has(n)) return `"${n}" is already above`;
    seen.add(n);
    return '';
  });
}

/**
 * What is wrong with a URL as typed, or ''. One that starts with a variable
 * (`${baseUrl}/users`) is only known once the variable is filled in.
 */
export function urlProblem(url) {
  const u = url.trim();
  if (!u) return 'Enter a URL';
  if (u.startsWith('${')) return '';
  let parsed;
  try { parsed = new URL(u.replace(/\$\{[^}]*\}/g, 'x')); } catch { return 'Not a valid URL — it starts with http:// or https://'; }
  return /^https?:$/.test(parsed.protocol) ? '' : 'Only http:// and https:// URLs can be sent';
}

/**
 * What is wrong with a JSON body as typed, or ''. A variable stands for a value
 * (`"${name}"` or a bare `${n}`), so each one is read as 0 for the check.
 */
export function jsonProblem(body) {
  if (!body.trim()) return '';
  try { JSON.parse(body.replace(/\$\{[^}]*\}/g, '0')); return ''; } catch (e) { return `Not valid JSON: ${e.message}`; }
}

/** { folderId: number of cases }. */
export function folderCounts(state) {
  const counts = Object.fromEntries(state.folders.map((f) => [f.id, 0]));
  for (const c of state.cases) counts[c.folderId] = (counts[c.folderId] || 0) + 1;
  return counts;
}
