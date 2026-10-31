/**
 * api-request.js — one API request: ${variables} filled in, headers read from
 * their "Name: value" lines, sent with a timeout, the response read back.
 *
 * Used by the API Tests page (apicases.html) and meant for the service worker
 * too (plan 14), so it uses fetch and nothing of chrome.*. From an extension
 * page or worker with host permission, fetch is not held to CORS and sends the
 * site's cookies with `credentials: 'include'` (checked in Edge 156, plan 13
 * Task 1).
 *
 * A request is { method, url, headers, bodyType, body, timeoutMs, cookies } as
 * the page stores it (apicases/model.js).
 */

/** Header names whose values are never written into a saved result or an export. */
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$|token|secret|passw/i;

export const MASK = '••••';

/**
 * How a variable's value is written into each part of a request: escaped
 * inside a JSON string (a `"` in a CSV cell must not end the string), encoded
 * in a form body, kept on one line in a header.
 */
const ENCODE = {
  plain: (v) => v,
  json: (v) => JSON.stringify(v).slice(1, -1),
  form: encodeURIComponent,
  header: (v) => v.replace(/[\r\n]+/g, ' '),
};

const DEFAULT_CONTENT_TYPE = {
  json: 'application/json',
  form: 'application/x-www-form-urlencoded;charset=UTF-8',
};

/** `text` with each ${name} of `vars` filled in; names `vars` lacks are added to `missing`. */
function fill(text, vars, encode, missing) {
  return text.replace(/\$\{([^}]+)\}/g, (ref, k) => {
    if (Object.hasOwn(vars, k)) return encode(String(vars[k]));
    missing.add(k);
    return ref;
  });
}

/** [[name, value]] from "Name: value" lines; blank lines and lines starting with # are left out. */
export function parseHeaders(text) {
  const headers = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: `Header line ${i + 1} is not "Name: value": ${line}` };
    headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return { headers };
}

/** The same headers with the values of secret ones (Authorization, Cookie, *token*…) masked. */
export function maskHeaders(headers) {
  return headers.map(([n, v]) => [n, SECRET_HEADER.test(n) ? MASK : v]);
}

/**
 * { url, init, timeoutMs } ready for fetch, or { error, kind } when the request
 * cannot be sent as it stands: kind 'vars' (a ${name} with no value), 'url',
 * 'headers'. GET and HEAD go without a body, as fetch requires.
 */
export function buildRequest(req, vars = {}) {
  const missing = new Set();
  const method = String(req.method || 'GET').toUpperCase();
  const url = fill(String(req.url || '').trim(), vars, ENCODE.plain, missing);
  const parsed = parseHeaders(fill(String(req.headers || ''), vars, ENCODE.header, missing));
  const bodyType = req.bodyType || 'none';
  const withBody = bodyType !== 'none' && method !== 'GET' && method !== 'HEAD';
  const body = withBody ? fill(String(req.body || ''), vars, ENCODE[bodyType] || ENCODE.plain, missing) : undefined;

  if (missing.size) {
    const names = [...missing].map((k) => `\${${k}}`).join(', ');
    return { error: `No value for ${names} — add ${missing.size === 1 ? 'it' : 'them'} in the Data tab`, kind: 'vars' };
  }
  if (!url) return { error: 'Enter a URL', kind: 'url' };
  let target;
  try { target = new URL(url); } catch { return { error: `Not a valid URL: ${url}`, kind: 'url' }; }
  if (!/^https?:$/.test(target.protocol)) return { error: `Only http:// and https:// URLs can be sent: ${url}`, kind: 'url' };
  if (parsed.error) return { error: parsed.error, kind: 'headers' };

  const headers = parsed.headers;
  if (withBody && DEFAULT_CONTENT_TYPE[bodyType] && !headers.some(([n]) => n.toLowerCase() === 'content-type')) {
    headers.push(['Content-Type', DEFAULT_CONTENT_TYPE[bodyType]]);
  }
  try { new Headers(headers); } catch (e) { return { error: `Header not allowed: ${e.message}`, kind: 'headers' }; }

  return {
    url: target.href,
    init: { method, headers, body, credentials: req.cookies === false ? 'omit' : 'include', redirect: 'follow' },
    timeoutMs: Math.max(1, Number(req.timeoutMs) || 30_000),
  };
}

/** The body as JSON when it is JSON (by its Content-Type or its first character), else undefined. */
function readJson(text, contentType) {
  const t = text.trimStart();
  if (!/json/i.test(contentType || '') && !t.startsWith('{') && !t.startsWith('[')) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * Send it. Resolves (never rejects) to
 *   { status, statusText, url, redirected, headers: [[name, value]], text, json, isJson, ms, sent }
 * or { error, kind, ms?, sent? } — kind 'vars' | 'url' | 'headers' (not sent), 'timeout', 'network'.
 * `sent` is { method, url } as it went out, variables filled in.
 */
export async function sendRequest(req, vars = {}) {
  const built = buildRequest(req, vars);
  if (built.error) return built;
  const sent = { method: built.init.method, url: built.url };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timed out', 'TimeoutError')), built.timeoutMs);
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  try {
    const res = await fetch(built.url, { ...built.init, signal: ctrl.signal });
    const text = await res.text();
    const json = readJson(text, res.headers.get('content-type'));
    return {
      status: res.status, statusText: res.statusText, url: res.url, redirected: res.redirected,
      headers: [...res.headers], text, json, isJson: json !== undefined, ms: ms(), sent,
    };
  } catch (e) {
    if (ctrl.signal.aborted) {
      return { error: `No response within ${Math.round(built.timeoutMs / 100) / 10} s`, kind: 'timeout', ms: ms(), sent };
    }
    // fetch says only "Failed to fetch": a host that does not resolve, a refused
    // connection, a certificate error and a blocked request all look the same.
    return { error: `Could not connect to ${new URL(built.url).host} (${e?.message || 'network error'}) — check the address, that the server is up, and the network`, kind: 'network', ms: ms(), sent };
  } finally {
    clearTimeout(timer);
  }
}
