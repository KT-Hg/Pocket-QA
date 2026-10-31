/**
 * ui/editor.js — the right column: the open case's name, folder, request
 * (method, URL, headers, body, settings), Send, and the response under it
 * (ui/response.js).
 *
 * Built once per opened case. Typing changes the state without rebuilding the
 * editor, which would take the caret away; only the list is redrawn, since its
 * row shows the name, method and URL.
 */

import { BODY_TYPES, MAX_TIMEOUT_MS, METHODS, duplicateCase, findCase, jsonProblem, updateCase, urlProblem } from '../model.js';
import { el, h } from './dom.js';
import { removeCases } from './list.js';
import { responseBox, sendButton, sendCase } from './response.js';

const TABS = [['headers', 'Headers'], ['body', 'Body'], ['settings', 'Settings']];
const BODY_LABELS = { none: 'None', json: 'JSON', text: 'Text', form: 'Form' };
const BODY_HINTS = {
  json: '{\n  "name": "${name}",\n  "age": 30\n}',
  text: 'Plain text',
  form: 'name=${name}&age=30',
};

/** The tab last chosen, kept from one case to the next. */
let tab = 'headers';

function errorLine() {
  return h('div', { class: 'ac-field-error', role: 'alert', hidden: true });
}

function showError(line, message) {
  line.textContent = message;
  line.hidden = !message;
}

// Each part below takes `ed`: { app, id, c (the case as opened), current() (as
// it is now), patch(fields) }.

function headPart(ed) {
  const { app, id, c } = ed;
  const name = h('input', { type: 'text', class: 'ac-name', value: c.name, placeholder: 'Request name', 'aria-label': 'Request name',
    oninput: () => ed.patch({ name: name.value }) });
  const folder = h('select', { class: 'mini-select', 'aria-label': 'Folder', onchange: () => app.moveTo([id], folder.value) },
    ...app.state.folders.map((f) => h('option', { value: f.id }, f.name)));
  folder.value = c.folderId;
  const head = h('div', { class: 'insp-head ac-insp-head' },
    name,
    h('div', { class: 'ac-insp-sub' },
      h('label', { class: 'ac-inline' }, 'Folder', folder),
      h('span', { class: 'ac-spacer' }),
      h('button', { class: 't-btn t-btn-sm', onclick: () => app.set(duplicateCase(app.state, id).state) }, 'Duplicate'),
      h('button', { class: 't-btn t-btn-sm', onclick: () => removeCases(app, [id]) }, 'Delete')));
  return { head, name };
}

/** Method + URL + Send, and the URL's error line. `onMethod` runs after the method changes. */
function requestPart(ed, onMethod) {
  const { c } = ed;
  const urlError = errorLine();
  const method = h('select', { class: 'mini-select ac-method-select', 'aria-label': 'Method',
    onchange: () => { ed.patch({ method: method.value }); onMethod(); } },
  ...METHODS.map((m) => h('option', { value: m }, m)));
  method.value = c.method;
  const url = h('input', { type: 'text', class: 'ac-url', value: c.url, placeholder: 'https://api.example.com/users  or  ${baseUrl}/users',
    'aria-label': 'URL', spellcheck: false,
    oninput: () => { ed.patch({ url: url.value }); showError(urlError, urlProblem(url.value)); } });
  if (c.url) showError(urlError, urlProblem(c.url));
  return { line: h('div', { class: 'ac-request-line' }, method, url, sendButton(ed.app, ed.id)), urlError, url };
}

function headersPane(ed) {
  const headers = h('textarea', { class: 'ac-code', rows: 7, spellcheck: false, value: ed.c.headers, 'aria-label': 'Headers',
    placeholder: 'Content-Type: application/json\nAuthorization: Bearer ${token}',
    oninput: () => ed.patch({ headers: headers.value }) });
  return h('div', { class: 'ac-pane' }, headers,
    h('p', { class: 'helper' }, 'One per line, as Name: value. A line starting with # is left out. ${variables} from the Data tab work here.'));
}

/** The body pane, and `refresh()` for when the method or body type changes. */
function bodyPane(ed) {
  const { c, current } = ed;
  const bodyError = errorLine();
  const note = h('p', { class: 'helper ac-note', hidden: true }, 'GET and HEAD requests are sent without a body.');
  const body = h('textarea', { class: 'ac-code', rows: 10, spellcheck: false, value: c.body, 'aria-label': 'Body',
    oninput: () => { ed.patch({ body: body.value }); check(); } });
  const format = h('button', { class: 't-btn t-btn-sm', title: 'Indent the JSON',
    onclick: () => {
      try { body.value = JSON.stringify(JSON.parse(body.value), null, 2); ed.patch({ body: body.value }); } catch { check(); }
    } }, 'Format');
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Body type' },
    ...BODY_TYPES.map((t) => h('button', { type: 'button', class: c.bodyType === t ? 'active' : '', dataset: { t },
      onclick: () => {
        seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.t === t));
        ed.patch({ bodyType: t });
        refresh();
      } }, BODY_LABELS[t])));
  function check() {
    showError(bodyError, current().bodyType === 'json' ? jsonProblem(body.value) : '');
  }
  function refresh() {
    const { bodyType, method } = current();
    body.hidden = bodyType === 'none';
    format.hidden = bodyType !== 'json';
    body.placeholder = BODY_HINTS[bodyType] || '';
    note.hidden = bodyType === 'none' || !(method === 'GET' || method === 'HEAD');
    check();
  }
  refresh();
  return { pane: h('div', { class: 'ac-pane' }, h('div', { class: 'ac-pane-head' }, seg, format), body, bodyError, note), refresh };
}

function settingsPane(ed) {
  const maxSec = MAX_TIMEOUT_MS / 1000;
  const timeout = h('input', { type: 'number', class: 'ac-num-input', min: 1, max: maxSec, step: 1,
    value: Math.round(ed.c.timeoutMs / 1000), 'aria-label': 'Timeout in seconds',
    onchange: () => {
      const sec = Math.min(Math.max(Math.round(Number(timeout.value) || 30), 1), maxSec);
      timeout.value = sec;
      ed.patch({ timeoutMs: sec * 1000 });
    } });
  const cookies = h('input', { type: 'checkbox', checked: ed.c.cookies, onchange: () => ed.patch({ cookies: cookies.checked }) });
  return h('div', { class: 'ac-pane' },
    h('label', { class: 'ac-setting' }, 'Timeout', timeout, h('span', { class: 'ac-unit' }, `seconds (at most ${maxSec})`)),
    h('label', { class: 'check-row ac-setting' }, cookies,
      h('span', null, 'Send the site\'s cookies', h('span', { class: 'helper ac-block' },
        'The request goes out with the cookies your browser has for that site, so it is signed in as you are. A response that sets or clears cookies changes them in the browser too (a logout endpoint signs you out).'))));
}

/** The tab strip over `panes` ({ key: pane }); the last tab chosen stays chosen. */
function tabStrip(panes) {
  const show = () => { for (const [k, p] of Object.entries(panes)) p.hidden = k !== tab; };
  const strip = h('div', { class: 'ac-tabs', role: 'tablist' }, ...TABS.map(([k, label]) => h('button', {
    type: 'button', role: 'tab', class: `rtab${k === tab ? ' active' : ''}`, dataset: { k },
    onclick: () => {
      tab = k;
      strip.querySelectorAll('.rtab').forEach((b) => b.classList.toggle('active', b.dataset.k === k));
      show();
    },
  }, label)));
  show();
  return strip;
}

export function renderEditor(app, { focus = null } = {}) {
  const c = findCase(app.state, app.state.caseId);
  if (!c) {
    el.inspInner.replaceChildren(h('div', { class: 'insp-empty' },
      h('div', null, h('div', { class: 'ic' }, '📮'), h('p', null, 'Pick a request in the list to edit and send it.'))));
    return;
  }
  const id = c.id;
  const ed = {
    app, id, c,
    current: () => findCase(app.state, id),
    patch: (fields) => app.set(updateCase(app.state, id, fields), { render: 'list' }),
  };
  const { head, name } = headPart(ed);
  const body = bodyPane(ed);
  const request = requestPart(ed, body.refresh);
  const panes = { headers: headersPane(ed), body: body.pane, settings: settingsPane(ed) };

  el.inspInner.replaceChildren(head, h('div', {
    class: 'insp-body ac-insp-body',
    onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendCase(app, id); } },
  }, request.line, request.urlError, tabStrip(panes), panes.headers, panes.body, panes.settings, responseBox(id)));
  if (focus === 'url') request.url.focus();
  else if (focus === 'name') name.select();
}
