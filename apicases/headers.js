/**
 * headers.js — a case's headers as rows for the Headers tab, and back.
 *
 * A case keeps its headers as text, one "Name: value" per line, a line turned
 * off starting with "#" (what shared/api-request.js sends, the cURL reader
 * writes and Bulk edit shows). The tab shows the same text as a table: a row
 * per header with a tick to send it or not, so nobody has to know the syntax.
 * parseRows() and rowsText() turn one into the other without losing a line.
 *
 * Also what is worth saying under a row (a name the browser will not let a
 * page send, a name with a space) and the names and values offered as
 * suggestions.
 *
 * Pure — no chrome.*, no DOM.
 */

/** [{ on, name, value }] from the text. A line with no ":" keeps its text as the name, to be fixed. */
export function parseRows(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line !== '#').map((line) => {
    const on = !line.startsWith('#');
    const body = on ? line : line.replace(/^#\s*/, '');
    const colon = body.indexOf(':');
    return colon < 0
      ? { on, name: body, value: '' }
      : { on, name: body.slice(0, colon).trim(), value: body.slice(colon + 1).trim() };
  });
}

/** The text of the rows; rows with neither name nor value are left out. */
export function rowsText(rows) {
  return rows.filter((r) => r.name.trim() || r.value.trim())
    .map((r) => `${r.on ? '' : '# '}${r.name.trim()}: ${r.value.trim()}`).join('\n');
}

/**
 * Headers a page cannot set: the browser drops them from the request (fetch's
 * forbidden header names), so a row with one would look sent and not be.
 */
const FORBIDDEN = /^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i;

/** What is wrong with a row's name, or ''. */
export function rowProblem(row) {
  const name = row.name.trim();
  if (!name) return row.value.trim() ? 'Give this header a name' : '';
  if (/^cookie$/i.test(name)) return 'The browser does not let a page send Cookie — the site\'s own cookies go along instead (Settings)';
  if (FORBIDDEN.test(name)) return `The browser sets ${name} itself — this row is not sent`;
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return 'A header name has only letters, digits and - (no spaces or ":")';
  return '';
}

/** Header names offered as you type, the usual ones first. */
export const NAME_SUGGESTIONS = [
  'Accept', 'Authorization', 'Content-Type', 'Accept-Language', 'Cache-Control', 'X-Api-Key',
  'X-Requested-With', 'X-Request-Id', 'X-Correlation-Id', 'If-None-Match', 'If-Match', 'Idempotency-Key', 'Pragma',
];

/** Values offered for a header name (any case). */
const VALUES = {
  accept: ['application/json', '*/*', 'text/plain', 'text/html', 'application/xml'],
  'content-type': ['application/json', 'application/x-www-form-urlencoded', 'text/plain', 'application/xml'],
  authorization: ['Bearer ${token}', 'Basic ${credentials}'],
  'accept-language': ['vi-VN', 'en-US', 'vi-VN,vi;q=0.9,en;q=0.8'],
  'cache-control': ['no-cache', 'no-store', 'max-age=0'],
  'x-api-key': ['${apiKey}'],
  'x-requested-with': ['XMLHttpRequest'],
  pragma: ['no-cache'],
};

export function valueSuggestions(name) {
  return VALUES[String(name).trim().toLowerCase()] || [];
}

/**
 * Headers the request gets without a row of its own, as [name, value, why]:
 * the Content-Type of a JSON, form or text body (unless a row sets one) and
 * the site's cookies. Shown under the rows so what is sent is no surprise.
 */
export function addedHeaders(c, rows) {
  const out = [];
  const set = (n) => rows.some((r) => r.on && r.name.trim().toLowerCase() === n);
  const withBody = c.bodyType !== 'none' && c.method !== 'GET' && c.method !== 'HEAD';
  const type = { json: 'application/json', form: 'application/x-www-form-urlencoded;charset=UTF-8', text: 'text/plain;charset=UTF-8' }[c.bodyType];
  if (withBody && type && !set('content-type')) out.push(['Content-Type', type, `for the ${c.bodyType === 'json' ? 'JSON' : c.bodyType} body`]);
  if (c.cookies !== false) out.push(['Cookie', 'the browser\'s cookies for the site', 'turn off in Settings']);
  return out;
}
