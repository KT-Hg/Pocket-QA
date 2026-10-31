/**
 * curl.js — a curl command read into a request of the API Tests page, as
 * Chrome / Edge DevTools write it with Network → Copy → Copy as cURL (bash),
 * and a request written back as one (toCurl, for the editor's Copy cURL).
 *
 * The command is split the way bash would split it (single quotes, $'…'
 * ANSI-C quotes, double quotes, backslashes, line continuations); nothing is
 * expanded or run. Options that change what is sent are read; options about
 * how curl itself behaves (-s, -L, --compressed…) are skipped; anything else
 * is refused by name rather than guessed at, since a misread option would take
 * its argument for the URL.
 *
 * Headers the browser sets itself (Cookie, User-Agent, Sec-*, …) are left out:
 * fetch would drop or overrule them, and Cookie would pin one session into the
 * request. The request sends the browser's own cookies instead.
 *
 * Pure — no chrome.*, no DOM.
 */

import { base64Utf8, buildRequest } from '../shared/api-request.js';
import { MAX_TIMEOUT_MS, METHODS } from './model.js';

/** Flags that take no argument and change nothing the page sends. */
const SKIP_FLAGS = new Set([
  '--compressed', '-s', '--silent', '-S', '--show-error', '-k', '--insecure', '-L', '--location',
  '-i', '--include', '-v', '--verbose', '-g', '--globoff', '--http1.0', '--http1.1', '--http2',
  '--http2-prior-knowledge', '--http3', '-f', '--fail', '-N', '--no-buffer', '-#', '--progress-bar',
  '-q', '--disable', '--location-trusted', '--tr-encoding', '--raw',
]);

/** Options whose argument is about curl itself (where output goes, proxies, certificates…). */
const SKIP_WITH_ARG = new Set([
  '-o', '--output', '-w', '--write-out', '--connect-timeout', '--retry', '--retry-delay', '--retry-max-time',
  '--cacert', '--capath', '--cert', '--key', '-E', '-x', '--proxy', '--resolve', '--limit-rate',
  '--max-redirs', '-c', '--cookie-jar', '--interface', '--dns-servers', '-D', '--dump-header',
]);

const NOT_SUPPORTED = {
  '-F': 'multipart/form-data (-F) is not supported yet',
  '--form': 'multipart/form-data (--form) is not supported yet',
  '-T': 'uploading a file (-T) is not supported',
  '--upload-file': 'uploading a file (--upload-file) is not supported',
};

/** Set by the browser, or not allowed in fetch: left out of a pasted request. */
const BROWSER_HEADERS = /^(host|content-length|connection|keep-alive|accept-encoding|accept-charset|origin|referer|user-agent|dnt|te|trailer|transfer-encoding|upgrade|upgrade-insecure-requests|via|expect|date|priority|sec-.*|proxy-.*|access-control-request-.*)$/i;

const COOKIES_INSTEAD = '(the browser\'s own cookies for the site are sent instead)';

/* ── Splitting the command line ───────────────────────────────────────────── */

const ANSI_ESCAPES = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', '?': '?' };
/** How many hex digits \x, \u and \U take at most. */
const HEX_DIGITS = { x: 2, u: 4, U: 8 };

/** A string whose chars below 256 may be UTF-8 bytes (from \xHH), read as UTF-8 when they are. */
function decodeBytes(s) {
  if (!/[\x80-\xff]/.test(s) || /[^\x00-\xff]/.test(s)) return s;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0))); } catch { return s; }
}

// Each reader takes the command and the index of the opening quote, and
// returns [text, index after the closing quote], or null when it never closes.

function readSingle(cmd, i) {
  const end = cmd.indexOf("'", i + 1);
  return end < 0 ? null : [cmd.slice(i + 1, end), end + 1];
}

function readAnsi(cmd, i) {
  let out = '';
  for (let j = i + 2; j < cmd.length; j++) {
    if (cmd[j] === "'") {
      // \xHH is a byte of UTF-8 text in a hand-written $'\xc3\xa9', but a
      // character code in what DevTools writes ($'\xe9' for é): read as UTF-8
      // only when the bytes are valid UTF-8.
      return [decodeBytes(out), j + 1];
    }
    if (cmd[j] !== '\\') { out += cmd[j]; continue; }
    const e = cmd[++j];
    const hex = HEX_DIGITS[e] && cmd.slice(j + 1, j + 1 + HEX_DIGITS[e]).match(/^[0-9a-fA-F]+/)?.[0];
    if (hex && parseInt(hex, 16) <= 0x10ffff) {
      out += String.fromCodePoint(parseInt(hex, 16));
      j += hex.length;
    } else {
      out += ANSI_ESCAPES[e] ?? `\\${e}`;
    }
  }
  return null;
}

function readDouble(cmd, i) {
  let out = '';
  for (let j = i + 1; j < cmd.length; j++) {
    if (cmd[j] === '"') return [out, j + 1];
    if (cmd[j] === '\\' && '"\\$`\n'.includes(cmd[j + 1])) {
      j++;
      if (cmd[j] !== '\n') out += cmd[j];
    } else {
      out += cmd[j];
    }
  }
  return null;
}

/** The words of a bash command line, or { error }. */
export function splitWords(cmd) {
  const words = [];
  let word = null;
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    const continuation = cmd.slice(i, i + 3).match(/^\\\r?\n/);
    if (continuation) { i += continuation[0].length; continue; }
    if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
      i++;
      continue;
    }
    let part;
    if (ch === '\\') part = [cmd[i + 1] ?? '', i + 2];
    else if (ch === "'") part = readSingle(cmd, i) || "'";
    else if (ch === '$' && cmd[i + 1] === "'") part = readAnsi(cmd, i) || "$'";
    else if (ch === '"') part = readDouble(cmd, i) || '"';
    else part = [ch, i + 1];
    if (typeof part === 'string') return { error: `A quote (${part}) is never closed` };
    word = (word ?? '') + part[0];
    i = part[1];
  }
  if (word !== null) words.push(word);
  return { words };
}

/* ── Reading the options ──────────────────────────────────────────────────── */

function urlEncodeData(v) {
  const eq = v.indexOf('=');
  if (eq < 0) return encodeURIComponent(v);
  return `${v.slice(0, eq)}=${encodeURIComponent(v.slice(eq + 1))}`;
}

function setUrl(r, url) {
  if (r.url !== null) return `Two URLs: ${r.url} and ${url}`;
  r.url = url;
  return '';
}

function addData(r, v) {
  if (v.startsWith('@')) return `Data from a file (${v}) is not supported — paste the content instead`;
  r.data.push(v);
  return '';
}

/** What each option with an argument does to the command being read; a string returned is an error. */
const OPTIONS = {
  '-X': (r, v) => { r.method = v.toUpperCase(); },
  '-H': (r, v) => {
    const colon = v.indexOf(':');
    if (colon <= 0) return `Header is not "Name: value": ${v}`;
    r.headers.push([v.slice(0, colon).trim(), v.slice(colon + 1).trim()]);
    return '';
  },
  '-d': addData,
  '--data-raw': (r, v) => { r.data.push(v); },
  '--data-urlencode': (r, v) => { r.data.push(urlEncodeData(v)); },
  '--json': (r, v) => { r.data.push(v); r.json = true; },
  '-b': (r) => { r.notes.push(`the -b cookies ${COOKIES_INSTEAD}`); },
  '-u': (r, v) => { r.headers.push(['Authorization', `Basic ${base64Utf8(v)}`]); },
  '-A': (r, v, name) => { r.notes.push(`${name} (the browser sets it)`); },
  '--url': setUrl,
  '-m': (r, v) => {
    const sec = Number(v);
    if (sec > 0) r.timeoutMs = Math.min(Math.round(sec * 1000), MAX_TIMEOUT_MS);
  },
};
Object.assign(OPTIONS, {
  '--request': OPTIONS['-X'], '--header': OPTIONS['-H'],
  '--data': addData, '--data-ascii': addData, '--data-binary': addData,
  '--cookie': OPTIONS['-b'], '--user': OPTIONS['-u'],
  '--user-agent': OPTIONS['-A'], '-e': OPTIONS['-A'], '--referer': OPTIONS['-A'],
  '--max-time': OPTIONS['-m'],
});

/** Flags (no argument) that change what is sent. */
const FLAGS = {
  '-I': (r) => { r.head = true; },
  '--head': (r) => { r.head = true; },
  '-G': (r) => { r.get = true; },
  '--get': (r) => { r.get = true; },
};

/** [option, its attached value or undefined]: --name=value and -XPOST carry theirs. */
function splitOption(w) {
  if (w.startsWith('--') && w.includes('=')) return [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)];
  if (/^-[A-Za-z]./.test(w) && OPTIONS[w.slice(0, 2)]) return [w.slice(0, 2), w.slice(2)];
  return [w, undefined];
}

/** True when `w` is a flag, or several short ones in one (-sSL), and has been applied. */
function applyFlags(r, w) {
  if (SKIP_FLAGS.has(w)) return true;
  if (FLAGS[w]) { FLAGS[w](r); return true; }
  if (!/^-[A-Za-z]{2,}$/.test(w)) return false;
  const each = [...w.slice(1)].map((c) => `-${c}`);
  if (!each.every((f) => SKIP_FLAGS.has(f) || FLAGS[f])) return false;
  for (const f of each) FLAGS[f]?.(r);
  return true;
}

/** The options of the command, or { error }. */
function readOptions(words) {
  const r = { method: null, head: false, get: false, url: null, timeoutMs: undefined, headers: [], data: [], json: false, notes: [] };
  for (let i = 1; i < words.length; i++) {
    const [name, attached] = splitOption(words[i]);
    if (NOT_SUPPORTED[name]) return { error: NOT_SUPPORTED[name] };
    if (applyFlags(r, name)) continue;
    if (SKIP_WITH_ARG.has(name)) { if (attached === undefined) i++; continue; }
    if (!name.startsWith('-') || name === '-') {
      const err = setUrl(r, name);
      if (err) return { error: err };
      continue;
    }
    if (!OPTIONS[name]) return { error: `Option ${name} is not understood` };
    let value = attached;
    if (value === undefined) {
      if (i + 1 >= words.length) return { error: `${name} needs a value` };
      value = words[++i];
    }
    const err = OPTIONS[name](r, value, name);
    if (err) return { error: err };
  }
  return r;
}

/* ── The request ──────────────────────────────────────────────────────────── */

function parseUrl(url) {
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
  let parsed;
  try { parsed = new URL(full); } catch { return { error: `Not a valid URL: ${url}` }; }
  if (!/^https?:$/.test(parsed.protocol)) return { error: `Only http:// and https:// URLs can be sent: ${url}` };
  return { parsed };
}

function defaultMethod(r, body) {
  if (r.head) return 'HEAD';
  return body ? 'POST' : 'GET';
}

/** The headers to keep, with what was left out added to r.notes. */
function keptHeaders(r) {
  const has = (name) => r.headers.some(([n]) => n.toLowerCase() === name);
  if (r.json && !has('content-type')) r.headers.push(['Content-Type', 'application/json']);
  if (r.json && !has('accept')) r.headers.push(['Accept', 'application/json']);
  const dropped = r.headers.filter(([n]) => BROWSER_HEADERS.test(n)).map(([n]) => n);
  if (has('cookie')) r.notes.unshift(`the Cookie header ${COOKIES_INSTEAD}`);
  if (dropped.length) r.notes.push(`${dropped.length} header${dropped.length === 1 ? '' : 's'} the browser sets itself (${dropped.join(', ')})`);
  return r.headers.filter(([n]) => !BROWSER_HEADERS.test(n) && n.toLowerCase() !== 'cookie');
}

function isJsonObject(text) {
  try { const v = JSON.parse(text); return typeof v === 'object' && v !== null; } catch { return false; }
}

/** curl sends -d as a form unless a Content-Type says otherwise. */
function bodyTypeOf(body, contentType) {
  if (!body) return 'none';
  if (contentType.includes('json') || (!contentType && isJsonObject(body))) return 'json';
  if (!contentType || contentType.includes('x-www-form-urlencoded')) return 'form';
  return 'text';
}

/**
 * { request, notes } — request has name, method, url, headers (text), bodyType,
 * body and, with -m, timeoutMs; notes say what was left out. Or { error }.
 */
export function parseCurl(cmd) {
  const text = String(cmd || '').trim();
  if (!text) return { error: 'Paste a curl command' };
  if (/\^"|\^\r?\n/.test(text)) return { error: 'This is "Copy as cURL (cmd)". Use Copy as cURL (bash) instead.' };
  const split = splitWords(text);
  if (split.error) return split;
  if (!/^curl(\.exe)?$/i.test(split.words[0] || '')) return { error: 'Not a curl command — it should start with curl' };
  const r = readOptions(split.words);
  if (r.error) return r;
  if (!r.url) return { error: 'No URL in the command' };
  const { parsed, error } = parseUrl(r.url);
  if (error) return { error };

  let body = r.data.join('&');
  if (r.get && body) {
    parsed.search += (parsed.search ? '&' : '?') + body;
    body = '';
  }
  const method = r.method || defaultMethod(r, body);
  if (!METHODS.includes(method)) return { error: `Method ${method} is not supported (${METHODS.join(', ')})` };

  const headers = keptHeaders(r);
  const bodyType = bodyTypeOf(body, (headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1] || '').toLowerCase());
  if (bodyType === 'json' && isJsonObject(body)) body = JSON.stringify(JSON.parse(body), null, 2);

  return {
    request: {
      name: `${method} ${parsed.pathname}`,
      method,
      url: parsed.href,
      headers: headers.map(([n, v]) => `${n}: ${v}`).join('\n'),
      bodyType,
      body,
      ...(r.timeoutMs ? { timeoutMs: r.timeoutMs } : {}),
    },
    notes: r.notes,
  };
}

/* ── Writing a command (Copy as cURL) ─────────────────────────────────────── */

/** One shell word: '…' as is, $'…' when it holds control characters; a ' inside closes, escapes, reopens. */
function shellQuote(s) {
  if (/[\x00-\x1f\x7f]/.test(s)) {
    const esc = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\\': '\\\\', "'": "\\'" };
    return `$'${s.replace(/[\x00-\x1f\x7f\\']/g, (c) => esc[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}'`;
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The request as a bash curl command, variables filled in — what Send would
 * send, minus the browser's cookies, which a terminal does not have. A text
 * body gets the Content-Type fetch gives it. Or { error } when it cannot be
 * built (a variable with no value…).
 */
export function toCurl(req, vars = {}) {
  const built = buildRequest(req, vars);
  if (built.error) return { error: built.error };
  const { method, headers, body } = built.init;
  const parts = [`curl ${shellQuote(built.url)}`];
  if (method === 'HEAD') parts.push('--head');
  else if (method !== 'GET') parts.push(`-X ${method}`);
  const all = [...headers];
  if (body !== undefined && !all.some(([n]) => n.toLowerCase() === 'content-type')) all.push(['Content-Type', 'text/plain;charset=UTF-8']);
  for (const [n, v] of all) parts.push(`-H ${shellQuote(`${n}: ${v}`)}`);
  if (body !== undefined) parts.push(`--data-raw ${shellQuote(body)}`);
  // One line: the Windows clipboard turns \n into \r\n, and a "\" followed by
  // \r no longer continues the line in bash.
  return { command: parts.join(' ') };
}
