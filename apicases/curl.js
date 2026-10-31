/**
 * curl.js — a curl command read into a request of the API Tests page, as
 * Chrome / Edge DevTools write it with Network → Copy → Copy as cURL (bash).
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

/** Options with an argument that the request uses. */
const WITH_ARG = new Set([
  '-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii',
  '--data-urlencode', '--json', '-b', '--cookie', '-u', '--user', '-A', '--user-agent', '-e', '--referer',
  '--url', '-m', '--max-time',
]);

const NOT_SUPPORTED = {
  '-F': 'multipart/form-data (-F) is not supported yet',
  '--form': 'multipart/form-data (--form) is not supported yet',
  '-T': 'uploading a file (-T) is not supported',
  '--upload-file': 'uploading a file (--upload-file) is not supported',
};

/** Set by the browser, or not allowed in fetch: left out of a pasted request. */
const BROWSER_HEADERS = /^(host|content-length|connection|keep-alive|accept-encoding|accept-charset|origin|referer|user-agent|dnt|te|trailer|transfer-encoding|upgrade|upgrade-insecure-requests|via|expect|date|priority|sec-.*|proxy-.*|access-control-request-.*)$/i;

const ANSI_ESCAPES = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', '?': '?' };

/** The words of a bash command line, or { error }. */
export function splitWords(cmd) {
  const words = [];
  let word = null;
  const add = (s) => { word = (word ?? '') + s; };
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === '\\' && (cmd[i + 1] === '\n' || (cmd[i + 1] === '\r' && cmd[i + 2] === '\n'))) {
      i += cmd[i + 1] === '\r' ? 3 : 2;
      continue;
    }
    if (/\s/.test(ch)) {
      if (word !== null) { words.push(word); word = null; }
      i++;
      continue;
    }
    if (ch === '\\') { add(cmd[i + 1] ?? ''); i += 2; continue; }
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) return { error: 'A quote (\') is never closed' };
      add(cmd.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (ch === '$' && cmd[i + 1] === "'") {
      let j = i + 2;
      let out = '';
      for (; j < cmd.length && cmd[j] !== "'"; j++) {
        if (cmd[j] !== '\\') { out += cmd[j]; continue; }
        const e = cmd[++j];
        const hex = e === 'x' ? cmd.slice(j + 1, j + 3).match(/^[0-9a-fA-F]{1,2}/)?.[0]
          : e === 'u' ? cmd.slice(j + 1, j + 5).match(/^[0-9a-fA-F]{1,4}/)?.[0]
            : e === 'U' ? cmd.slice(j + 1, j + 9).match(/^[0-9a-fA-F]{1,8}/)?.[0] : null;
        if (hex) { out += String.fromCodePoint(parseInt(hex, 16)); j += hex.length; } else out += ANSI_ESCAPES[e] ?? `\\${e}`;
      }
      if (j >= cmd.length) return { error: 'A quote ($\') is never closed' };
      // \xHH is a byte of UTF-8 text in a hand-written $'\xc3\xa9', but a
      // character code in what DevTools writes ($'\xe9' for é): read as UTF-8
      // only when the bytes are valid UTF-8.
      add(decodeBytes(out));
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === '\\' && '"\\$`\n'.includes(cmd[j + 1])) { if (cmd[j + 1] !== '\n') out += cmd[j + 1]; j++; } else out += cmd[j];
      }
      if (j >= cmd.length) return { error: 'A quote (") is never closed' };
      add(out);
      i = j + 1;
      continue;
    }
    add(ch);
    i++;
  }
  if (word !== null) words.push(word);
  return { words };
}

/** A string whose chars below 256 may be UTF-8 bytes (from \xHH), read as UTF-8 when they are. */
function decodeBytes(s) {
  if (!/[\x80-\xff]/.test(s) || /[^\x00-\xff]/.test(s)) return s;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0))); } catch { return s; }
}

function base64Utf8(s) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

function urlEncodeData(v) {
  const eq = v.indexOf('=');
  if (eq < 0) return encodeURIComponent(v);
  return `${v.slice(0, eq)}=${encodeURIComponent(v.slice(eq + 1))}`;
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
  const words = split.words;
  if (!/^curl(\.exe)?$/i.test(words[0] || '')) return { error: 'Not a curl command — it should start with curl' };

  let method = null;
  let head = false;
  let get = false;
  let url = null;
  let timeoutMs;
  const headers = [];
  const data = [];
  let json = false;
  const notes = [];

  for (let i = 1; i < words.length; i++) {
    let w = words[i];
    let value;
    if (w.startsWith('--') && w.includes('=')) { value = w.slice(w.indexOf('=') + 1); w = w.slice(0, w.indexOf('=')); }
    // -XPOST, -H'…': a short option with its argument attached.
    else if (/^-[A-Za-z]./.test(w) && WITH_ARG.has(w.slice(0, 2))) { value = w.slice(2); w = w.slice(0, 2); }
    // -sSL: several short flags in one.
    else if (/^-[A-Za-z]{2,}$/.test(w) && [...w.slice(1)].every((c) => SKIP_FLAGS.has(`-${c}`) || c === 'I' || c === 'G')) {
      if (w.includes('I')) head = true;
      if (w.includes('G')) get = true;
      continue;
    }

    if (NOT_SUPPORTED[w]) return { error: NOT_SUPPORTED[w] };
    if (SKIP_FLAGS.has(w)) continue;
    if (w === '-I' || w === '--head') { head = true; continue; }
    if (w === '-G' || w === '--get') { get = true; continue; }
    if (SKIP_WITH_ARG.has(w)) { if (value === undefined) i++; continue; }
    if (WITH_ARG.has(w)) {
      if (value === undefined) {
        if (i + 1 >= words.length) return { error: `${w} needs a value` };
        value = words[++i];
      }
    } else if (w.startsWith('-') && w !== '-') {
      return { error: `Option ${w} is not understood` };
    } else {
      if (url !== null) return { error: `Two URLs: ${url} and ${w}` };
      url = w;
      continue;
    }

    switch (w) {
      case '-X': case '--request': method = value.toUpperCase(); break;
      case '-H': case '--header': {
        const colon = value.indexOf(':');
        if (colon <= 0) return { error: `Header is not "Name: value": ${value}` };
        headers.push([value.slice(0, colon).trim(), value.slice(colon + 1).trim()]);
        break;
      }
      case '-d': case '--data': case '--data-ascii': case '--data-binary':
        if (value.startsWith('@')) return { error: `Data from a file (${value}) is not supported — paste the content instead` };
        data.push(value);
        break;
      case '--data-raw': data.push(value); break;
      case '--data-urlencode': data.push(urlEncodeData(value)); break;
      case '--json': data.push(value); json = true; break;
      case '-b': case '--cookie': notes.push('the -b cookies (the browser\'s own cookies for the site are sent instead)'); break;
      case '-u': case '--user': headers.push(['Authorization', `Basic ${base64Utf8(value)}`]); break;
      case '-A': case '--user-agent': case '-e': case '--referer': notes.push(`${w} (the browser sets it)`); break;
      case '--url': if (url !== null) return { error: `Two URLs: ${url} and ${value}` }; url = value; break;
      case '-m': case '--max-time': {
        const sec = Number(value);
        if (sec > 0) timeoutMs = Math.min(Math.round(sec * 1000), MAX_TIMEOUT_MS);
        break;
      }
    }
  }

  if (!url) return { error: 'No URL in the command' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  let parsed;
  try { parsed = new URL(url); } catch { return { error: `Not a valid URL: ${url}` }; }
  if (!/^https?:$/.test(parsed.protocol)) return { error: `Only http:// and https:// URLs can be sent: ${url}` };

  let body = data.join('&');
  if (get && data.length) {
    parsed.search += (parsed.search ? '&' : '?') + body;
    body = '';
  }
  if (!method) method = head ? 'HEAD' : body ? 'POST' : 'GET';
  if (!METHODS.includes(method)) return { error: `Method ${method} is not supported (${METHODS.join(', ')})` };

  const has = (name) => headers.some(([n]) => n.toLowerCase() === name);
  if (json) {
    if (!has('content-type')) headers.push(['Content-Type', 'application/json']);
    if (!has('accept')) headers.push(['Accept', 'application/json']);
  }
  const dropped = headers.filter(([n]) => BROWSER_HEADERS.test(n)).map(([n]) => n);
  const cookie = headers.some(([n]) => n.toLowerCase() === 'cookie');
  const kept = headers.filter(([n]) => !BROWSER_HEADERS.test(n) && n.toLowerCase() !== 'cookie');
  if (cookie) notes.unshift('the Cookie header (the browser\'s own cookies for the site are sent instead)');
  if (dropped.length) notes.push(`${dropped.length} header${dropped.length === 1 ? '' : 's'} the browser sets itself (${dropped.join(', ')})`);

  const contentType = (kept.find(([n]) => n.toLowerCase() === 'content-type')?.[1] || '').toLowerCase();
  let bodyType = 'none';
  if (body) {
    let isJson = false;
    try { const v = JSON.parse(body); isJson = typeof v === 'object' && v !== null; } catch { /* not JSON */ }
    if (contentType.includes('json') || (!contentType && isJson)) bodyType = 'json';
    else if (contentType.includes('x-www-form-urlencoded') || !contentType) bodyType = 'form';
    else bodyType = 'text';
    if (bodyType === 'json' && isJson) body = JSON.stringify(JSON.parse(body), null, 2);
  }

  return {
    request: {
      name: `${method} ${parsed.pathname}`,
      method,
      url: parsed.href,
      headers: kept.map(([n, v]) => `${n}: ${v}`).join('\n'),
      bodyType,
      body,
      ...(timeoutMs ? { timeoutMs } : {}),
    },
    notes,
  };
}
