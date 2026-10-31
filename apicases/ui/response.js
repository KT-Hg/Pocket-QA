/**
 * ui/response.js — Send, and the response under the editor: status, time,
 * size, what was sent, then the body (JSON indented) or the headers.
 *
 * Responses are kept for this visit only, by case: going to another case and
 * back shows the last one again. Variables come from the Data tab, resolved as
 * a playback resolves them ({random:…} and {pick:…} drawn once per send).
 */

import { resolveRandomVars } from '../../bg/interpolate.js';
import { sendRequest } from '../../shared/api-request.js';
import { parseListSpec } from '../../shared/var-name.js';
import { findCase } from '../model.js';
import { h } from './dom.js';

// A body longer than this is cut in the view; the response itself is kept whole.
const SHOW_MAX_CHARS = 200_000;

const responses = new Map();
const sending = new Set();
/** The box and Send button of the case open in the editor. */
let open = { id: null, box: null, button: null };
let tab = 'body';

/** The Data tab's variables, each a plain value. */
export async function loadVars() {
  const raw = await new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) resolve({});
    else chrome.storage.local.get('variables', resolve);
  });
  const vars = resolveRandomVars(raw?.variables || {});
  // {fallback:a|b} picks the first value that works on the page; a request has
  // no page to try them on, so the first one is it.
  for (const [k, v] of Object.entries(vars)) {
    const list = parseListSpec('fallback', v);
    if (list) vars[k] = list.find((x) => x !== '') ?? '';
  }
  return vars;
}

export async function sendCase(app, id) {
  const c = findCase(app.state, id);
  if (!c || sending.has(id)) return;
  sending.add(id);
  draw(id);
  try {
    responses.set(id, await sendRequest(c, await loadVars()));
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

export function responseBox(id) {
  const box = h('section', { class: 'ac-response', 'aria-live': 'polite' });
  open = { ...open, id, box };
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

function bodyView(res) {
  if (res.isBinary) return binaryView(res);
  const full = res.isJson ? JSON.stringify(res.json, null, 2) : res.text;
  if (!full) return h('p', { class: 'helper' }, 'The response has no body.');
  const cut = full.length > SHOW_MAX_CHARS;
  return [
    h('pre', { class: 'ac-pre' }, cut ? full.slice(0, SHOW_MAX_CHARS) : full),
    cut ? h('p', { class: 'helper' }, `Showing the first ${bytes(SHOW_MAX_CHARS)} of ${bytes(full.length)}.`) : null,
  ];
}

function headersView(res) {
  return h('table', { class: 'ac-headers' }, ...res.headers.map(([n, v]) => h('tr', null, h('th', null, n), h('td', null, v))));
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
  const box = open.box;
  if (!box) return;
  const res = responses.get(id);
  const title = h('div', { class: 'pane-label ac-resp-label' }, 'Response');
  if (busy) { box.replaceChildren(title, h('p', { class: 'helper' }, 'Waiting for the response…')); return; }
  if (!res) { box.replaceChildren(title, h('p', { class: 'helper' }, 'Send the request (Ctrl+Enter) to see its response here.')); return; }
  if (res.error) {
    box.replaceChildren(...[title, h('div', { class: 'ac-resp-error', role: 'alert' }, res.error), sentLine(res)].filter(Boolean));
    return;
  }
  const panes = { body: h('div', null, ...[bodyView(res)].flat().filter(Boolean)), headers: headersView(res) };
  const tabs = h('div', { class: 'ac-tabs ac-resp-tabs', role: 'tablist' }, ...[['body', 'Body'], ['headers', `Headers (${res.headers.length})`]].map(([k, label]) =>
    h('button', { type: 'button', role: 'tab', class: `rtab${k === tab ? ' active' : ''}`, dataset: { k },
      onclick: () => {
        tab = k;
        tabs.querySelectorAll('.rtab').forEach((b) => b.classList.toggle('active', b.dataset.k === k));
        for (const [pk, p] of Object.entries(panes)) p.hidden = pk !== k;
      } }, label)));
  for (const [pk, p] of Object.entries(panes)) p.hidden = pk !== tab;
  // replaceChildren() would write a null as the text "null".
  box.replaceChildren(...[
    title,
    h('div', { class: 'ac-resp-meta' },
      h('span', { class: statusClass(res.status) }, `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`),
      h('span', null, `${res.ms} ms`),
      res.isBinary
        ? h('span', null, bytes(res.bytes))
        : h('span', { title: 'Size of the body as read — on the wire it may be smaller, when the server compresses it' },
          `${bytes(new Blob([res.text]).size)} decoded`)),
    sentLine(res),
    res.redirected ? h('div', { class: 'helper' }, `Redirected to ${res.url}`) : null,
    tabs, panes.body, panes.headers,
  ].filter(Boolean));
}
