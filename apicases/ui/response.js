/**
 * ui/response.js — Send, and the result under the editor: the verdict
 * (✓ Passed / ✗ Failed / ⚠ Broken, apicases/run.js), status, time, size, what
 * was sent, then the body or the headers. A JSON body is drawn by
 * ui/json-view.js, its keys clickable.
 *
 * Results are kept for this visit only, by case: going to another case and
 * back shows the last one again. Variables are the Data tab's with the
 * environment in use on top (apicases/vars.js).
 */

import { verdictLabel } from '../../shared/verdict.js';
import { findCase } from '../model.js';
import { runCase } from '../run.js';
import { varsFor } from '../vars.js';
import { h } from './dom.js';
import { MAX_NODES, jsonView } from './json-view.js';

// A body longer than this is cut in the view; the response itself is kept whole.
const SHOW_MAX_CHARS = 200_000;

const results = new Map();
const sending = new Set();
/** The box, Send button and callbacks of the case open in the editor. */
let open = { id: null, box: null, button: null, onResult: null, onKey: null };
let tab = 'body';

export async function sendCase(app, id) {
  const c = findCase(app.state, id);
  if (!c || sending.has(id)) return;
  sending.add(id);
  draw(id);
  try {
    results.set(id, await runCase(c, await varsFor(app.state)));
  } finally {
    sending.delete(id);
    draw(id);
  }
}

export function sendButton(app, id) {
  const button = h('button', { class: 't-btn t-btn-primary ac-send', title: 'Send (Ctrl+Enter)', onclick: () => sendCase(app, id) }, 'Send');
  open = { ...open, id, button };
  return button;
}

/**
 * The response box of case `id`. `onResult(result)` runs whenever it shows a
 * result (the Checks tab marks its rows); `onKey(segs, value, button)` when a
 * key of a JSON body is clicked.
 */
export function responseBox(id, { onResult = null, onKey = null } = {}) {
  const box = h('section', { class: 'ac-response', 'aria-live': 'polite' });
  open = { ...open, id, box, onResult, onKey };
  draw(id);
  return box;
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const statusClass = (status) => `ac-status ac-s${String(status)[0]}xx`;

function sentLine(res) {
  return res.sent ? h('div', { class: 'ac-sent' }, h('b', null, res.sent.method), ' ', res.sent.url) : null;
}

/** "✗ Failed · Expected status 2xx, got 500" — the verdict, with the failure that decided it. */
function verdictLine(result) {
  const first = result.failures[0];
  return h('div', { class: `ac-verdict ac-v-${result.verdict}`, role: 'status' },
    h('b', null, verdictLabel(result.verdict)),
    first ? h('span', null, first.reason) : null,
    result.failures.length > 1 ? h('span', { class: 'ac-more' }, `+${result.failures.length - 1} more`) : null);
}

/** The object URL of the binary body on show, revoked when another response replaces it. */
let blobUrl = null;

/** "Binary · image/png · 12.3 KB", Download, and a preview when it is an image. */
function binaryView(res) {
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(res.blob);
  const type = res.contentType.split(';')[0].trim();
  const name = decodeURIComponent(new URL(res.url).pathname.split('/').pop() || '') || 'response';
  return [
    h('div', { class: 'ac-binary' },
      h('span', null, `Binary · ${type} · ${bytes(res.bytes)}`),
      h('a', { class: 't-btn t-btn-sm', href: blobUrl, download: name }, 'Download')),
    type.startsWith('image/') ? h('img', { class: 'ac-img', src: blobUrl, alt: `Response image (${type})` }) : null,
  ];
}

function textView(full, note) {
  const cut = full.length > SHOW_MAX_CHARS;
  return [
    h('pre', { class: 'ac-pre' }, cut ? full.slice(0, SHOW_MAX_CHARS) : full),
    cut ? h('p', { class: 'helper' }, `Showing the first ${bytes(SHOW_MAX_CHARS)} of ${bytes(full.length)}.`) : null,
    note ? h('p', { class: 'helper' }, note) : null,
  ];
}

function bodyView(res) {
  if (res.isBinary) return binaryView(res);
  if (res.isJson && open.onKey) {
    const tree = jsonView(res.json, open.onKey);
    if (tree) return [tree];
    return textView(JSON.stringify(res.json, null, 2), `Over ${MAX_NODES.toLocaleString('en')} values: keys are not clickable here — type a path in the Checks tab.`);
  }
  const full = res.isJson ? JSON.stringify(res.json, null, 2) : res.text;
  return full ? textView(full) : [h('p', { class: 'helper' }, 'The response has no body.')];
}

function headersView(res) {
  return h('table', { class: 'ac-headers' }, ...res.headers.map(([n, v]) => h('tr', null, h('th', null, n), h('td', null, v))));
}

function tabsOver(panes, labels) {
  const strip = h('div', { class: 'ac-tabs ac-resp-tabs', role: 'tablist' }, ...labels.map(([k, label]) =>
    h('button', { type: 'button', role: 'tab', class: `rtab${k === tab ? ' active' : ''}`, dataset: { k },
      onclick: () => {
        tab = k;
        strip.querySelectorAll('.rtab').forEach((b) => b.classList.toggle('active', b.dataset.k === k));
        for (const [pk, p] of Object.entries(panes)) p.hidden = pk !== k;
      } }, label)));
  for (const [pk, p] of Object.entries(panes)) p.hidden = pk !== tab;
  return strip;
}

/** What a response that came back shows: verdict, status line, what was sent, body / headers. */
function responseParts(result) {
  const res = result.res;
  const panes = { body: h('div', null, ...bodyView(res).filter(Boolean)), headers: headersView(res) };
  return [
    verdictLine(result),
    h('div', { class: 'ac-resp-meta' },
      h('span', { class: statusClass(res.status) }, `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`),
      h('span', null, `${res.ms} ms`),
      res.isBinary
        ? h('span', null, bytes(res.bytes))
        : h('span', { title: 'Size of the body as read — on the wire it may be smaller, when the server compresses it' },
          `${bytes(new Blob([res.text]).size)} decoded`)),
    sentLine(res),
    res.redirected ? h('div', { class: 'helper' }, `Redirected to ${res.url}`) : null,
    tabsOver(panes, [['body', 'Body'], ['headers', `Headers (${res.headers.length})`]]),
    panes.body, panes.headers,
  ];
}

function draw(id) {
  if (open.id !== id) return;
  // `open` is replaced each time the editor is built, so these are the case's
  // own button and box even before they are in the page.
  const busy = sending.has(id);
  if (open.button) {
    open.button.disabled = busy;
    open.button.textContent = busy ? 'Sending…' : 'Send';
  }
  if (!open.box) return;
  const result = results.get(id);
  let parts;
  if (busy) parts = [h('p', { class: 'helper' }, 'Waiting for the response…')];
  else if (!result) parts = [h('p', { class: 'helper' }, 'Send the request (Ctrl+Enter) to see its response here.')];
  else if (result.res.error) parts = [verdictLine(result), sentLine(result.res)];
  else parts = responseParts(result);
  // replaceChildren() would write a null as the text "null".
  open.box.replaceChildren(h('div', { class: 'pane-label ac-resp-label' }, 'Response'), ...parts.filter(Boolean));
  if (!busy) open.onResult?.(result || null);
}
