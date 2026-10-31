/**
 * api-request.js — one API request: ${variables} filled in, headers read from
 * their "Name: value" lines, sent with a timeout, the response read back.
 *
 * Used by the API Tests page (apitest.html) and meant for the service worker
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
    if (colon === 0) return { error: `A header has a value but no name (line ${i + 1}: ${line})` };
    if (colon < 0) return { error: `Header line ${i + 1} is not "Name: value": ${line}` };
    headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return { headers };
}

/** The same headers with the values of secret ones (Authorization, Cookie, *token*…) masked. */
export function maskHeaders(headers) {
  return headers.map(([n, v]) => [n, SECRET_HEADER.test(n) ? MASK : v]);
}

/** { target: URL } for an http(s) URL, else { error, kind: 'url' }. */
function targetUrl(url) {
  if (!url) return { error: 'Enter a URL', kind: 'url' };
  let target;
  try { target = new URL(url); } catch { return { error: `Not a valid URL: ${url}`, kind: 'url' }; }
  if (!/^https?:$/.test(target.protocol)) return { error: `Only http:// and https:// URLs can be sent: ${url}`, kind: 'url' };
  return { target };
}

/** The body as sent, or undefined: GET and HEAD go without one, as fetch requires. */
function requestBody(req, method, vars, missing) {
  const type = req.bodyType || 'none';
  if (type === 'none' || method === 'GET' || method === 'HEAD') return undefined;
  return fill(String(req.body || ''), vars, ENCODE[type] || ENCODE.plain, missing);
}

/**
 * { url, init, timeoutMs } ready for fetch, or { error, kind } when the request
 * cannot be sent as it stands: kind 'vars' (a ${name} with no value), 'url',
 * 'headers'.
 */
export function buildRequest(req, vars = {}) {
  const missing = new Set();
  const method = String(req.method || 'GET').toUpperCase();
  const url = fill(String(req.url || '').trim(), vars, ENCODE.plain, missing);
  const parsed = parseHeaders(fill(String(req.headers || ''), vars, ENCODE.header, missing));
  const body = requestBody(req, method, vars, missing);

  if (missing.size) {
    const names = [...missing].map((k) => `\${${k}}`).join(', ');
    return { error: `No value for ${names} — add ${missing.size === 1 ? 'it' : 'them'} to the environment or the Data tab`, kind: 'vars' };
  }
  const { target, ...bad } = targetUrl(url);
  if (!target) return bad;
  if (parsed.error) return { error: parsed.error, kind: 'headers' };

  const headers = parsed.headers;
  const contentType = body !== undefined && DEFAULT_CONTENT_TYPE[req.bodyType];
  if (contentType && !headers.some(([n]) => n.toLowerCase() === 'content-type')) headers.push(['Content-Type', contentType]);
  try { new Headers(headers); } catch (e) { return { error: `Header not allowed: ${e.message}`, kind: 'headers' }; }

  return {
    url: target.href,
    init: { method, headers, body, credentials: req.cookies === false ? 'omit' : 'include', redirect: 'follow' },
    timeoutMs: Math.max(1, Number(req.timeoutMs) || 30_000),
  };
}

/** Base64 of the UTF-8 bytes of `s` (btoa alone takes Latin-1 only): Basic auth, `curl -u`. */
export function base64Utf8(s) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

/** The body as JSON when it is JSON (by its Content-Type or its first character), else undefined. */
function readJson(text, contentType) {
  const t = text.trimStart();
  if (!/json/i.test(contentType || '') && !t.startsWith('{') && !t.startsWith('[')) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Read as text: no Content-Type, text/*, and the JSON / XML / script / form types. Anything else is bytes. */
const TEXT_TYPE = /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded/i;

/**
 * The body: text (and JSON when it is JSON), or for an image, a PDF, a zip… the
 * bytes as a Blob — read as text they would come out as replacement characters.
 */
async function readBody(res) {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType || TEXT_TYPE.test(contentType)) {
    const text = await res.text();
    const json = readJson(text, contentType);
    return { contentType, text, json, isJson: json !== undefined, isBinary: false };
  }
  const blob = await res.blob();
  // A HEAD response, or a 204, has a type but nothing in it: show it as no body.
  if (!blob.size) return { contentType, text: '', json: undefined, isJson: false, isBinary: false };
  return { contentType, text: '', json: undefined, isJson: false, isBinary: true, bytes: blob.size, blob };
}

/**
 * Send it. Resolves (never rejects) to
 *   { status, statusText, url, redirected, headers: [[name, value]], contentType,
 *     text, json, isJson, isBinary, bytes?, blob?, ms, sent }
 * or { error, kind, ms?, sent? } — kind 'vars' | 'url' | 'headers' (not sent), 'timeout', 'network'.
 * A binary body (isBinary) has `bytes` and `blob`, and text ''. `sent` is
 * { method, url } as it went out, variables filled in.
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
    const body = await readBody(res);
    return {
      status: res.status, statusText: res.statusText, url: res.url, redirected: res.redirected,
      headers: [...res.headers], ...body, ms: ms(), sent,
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
