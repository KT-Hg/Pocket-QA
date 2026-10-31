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

export function renderEditor(app, { focus = null } = {}) {
  const s = app.state;
  const c = findCase(s, s.caseId);
  if (!c) {
    el.inspInner.replaceChildren(h('div', { class: 'insp-empty' },
      h('div', null, h('div', { class: 'ic' }, '📮'), h('p', null, 'Pick a request in the list to edit and send it.'))));
    return;
  }
  const id = c.id;
  const current = () => findCase(app.state, id);
  const patch = (fields) => app.set(updateCase(app.state, id, fields), { render: 'list' });

  // ---- head: name, folder, Duplicate / Delete
  const name = h('input', { type: 'text', class: 'ac-name', value: c.name, placeholder: 'Request name', 'aria-label': 'Request name',
    oninput: () => patch({ name: name.value }) });
  const folder = h('select', { class: 'mini-select', 'aria-label': 'Folder', onchange: () => app.moveTo([id], folder.value) },
    ...s.folders.map((f) => h('option', { value: f.id }, f.name)));
  folder.value = c.folderId;
  const head = h('div', { class: 'insp-head ac-insp-head' },
    name,
    h('div', { class: 'ac-insp-sub' },
      h('label', { class: 'ac-inline' }, 'Folder', folder),
      h('span', { class: 'ac-spacer' }),
      h('button', { class: 't-btn t-btn-sm', onclick: () => app.set(duplicateCase(app.state, id).state) }, 'Duplicate'),
      h('button', { class: 't-btn t-btn-sm', onclick: () => removeCases(app, [id]) }, 'Delete')));

  // ---- request line: method + URL
  const urlError = errorLine();
  const method = h('select', { class: 'mini-select ac-method-select', 'aria-label': 'Method',
    onchange: () => { patch({ method: method.value }); bodyNote(); } },
  ...METHODS.map((m) => h('option', { value: m }, m)));
  method.value = c.method;
  const url = h('input', { type: 'text', class: 'ac-url', value: c.url, placeholder: 'https://api.example.com/users  or  ${baseUrl}/users',
    'aria-label': 'URL', spellcheck: false,
    oninput: () => { patch({ url: url.value }); showError(urlError, urlProblem(url.value)); } });
  if (c.url) showError(urlError, urlProblem(c.url));
  const requestLine = h('div', { class: 'ac-request-line' }, method, url, sendButton(app, id));

  // ---- Headers
  const headers = h('textarea', { class: 'ac-code', rows: 7, spellcheck: false, value: c.headers, 'aria-label': 'Headers',
    placeholder: 'Content-Type: application/json\nAuthorization: Bearer ${token}',
    oninput: () => patch({ headers: headers.value }) });
  const headersPane = h('div', { class: 'ac-pane' }, headers,
    h('p', { class: 'helper' }, 'One per line, as Name: value. A line starting with # is left out. ${variables} from the Data tab work here.'));

  // ---- Body
  const bodyError = errorLine();
  const note = h('p', { class: 'helper ac-note', hidden: true }, 'GET and HEAD requests are sent without a body.');
  const body = h('textarea', { class: 'ac-code', rows: 10, spellcheck: false, value: c.body, 'aria-label': 'Body',
    oninput: () => { patch({ body: body.value }); checkBody(); } });
  const format = h('button', { class: 't-btn t-btn-sm', title: 'Indent the JSON',
    onclick: () => {
      try { body.value = JSON.stringify(JSON.parse(body.value), null, 2); patch({ body: body.value }); } catch { checkBody(); }
    } }, 'Format');
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Body type' },
    ...BODY_TYPES.map((t) => h('button', { type: 'button', class: c.bodyType === t ? 'active' : '', dataset: { t },
      onclick: () => {
        seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.t === t));
        patch({ bodyType: t });
        bodyMode();
      } }, BODY_LABELS[t])));
  function checkBody() {
    showError(bodyError, current().bodyType === 'json' ? jsonProblem(body.value) : '');
  }
  function bodyNote() {
    note.hidden = !(current().method === 'GET' || current().method === 'HEAD') || current().bodyType === 'none';
  }
  function bodyMode() {
    const t = current().bodyType;
    body.hidden = t === 'none';
    format.hidden = t !== 'json';
    body.placeholder = BODY_HINTS[t] || '';
    checkBody();
    bodyNote();
  }
  const bodyPane = h('div', { class: 'ac-pane' }, h('div', { class: 'ac-pane-head' }, seg, format), body, bodyError, note);
  bodyMode();

  // ---- Settings
  const timeout = h('input', { type: 'number', class: 'ac-num-input', min: 1, max: MAX_TIMEOUT_MS / 1000, step: 1,
    value: Math.round(c.timeoutMs / 1000), 'aria-label': 'Timeout in seconds',
    onchange: () => {
      const sec = Math.min(Math.max(Math.round(Number(timeout.value) || 30), 1), MAX_TIMEOUT_MS / 1000);
      timeout.value = sec;
      patch({ timeoutMs: sec * 1000 });
    } });
  const cookies = h('input', { type: 'checkbox', checked: c.cookies, onchange: () => patch({ cookies: cookies.checked }) });
  const settingsPane = h('div', { class: 'ac-pane' },
    h('label', { class: 'ac-setting' }, 'Timeout', timeout, h('span', { class: 'ac-unit' }, `seconds (at most ${MAX_TIMEOUT_MS / 1000})`)),
    h('label', { class: 'check-row ac-setting' }, cookies,
      h('span', null, 'Send the site\'s cookies', h('span', { class: 'helper ac-block' },
        'The request goes out with the cookies your browser has for that site, so it is signed in as you are. A response that sets or clears cookies changes them in the browser too (a logout endpoint signs you out).'))));

  // ---- tabs
  const panes = { headers: headersPane, body: bodyPane, settings: settingsPane };
  const tabs = h('div', { class: 'ac-tabs', role: 'tablist' }, ...TABS.map(([k, label]) => h('button', {
    type: 'button', role: 'tab', class: `rtab${k === tab ? ' active' : ''}`, dataset: { k },
    onclick: () => {
      tab = k;
      tabs.querySelectorAll('.rtab').forEach((b) => b.classList.toggle('active', b.dataset.k === k));
      for (const [pk, p] of Object.entries(panes)) p.hidden = pk !== k;
    },
  }, label)));
  for (const [pk, p] of Object.entries(panes)) p.hidden = pk !== tab;

  el.inspInner.replaceChildren(head, h('div', {
    class: 'insp-body ac-insp-body',
    onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendCase(app, id); } },
  }, requestLine, urlError, tabs, headersPane, bodyPane, settingsPane, responseBox(id)));
  if (focus === 'url') url.focus();
  else if (focus === 'name') name.select();
}
