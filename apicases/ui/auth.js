/**
 * ui/auth.js — how a request signs in: a case's Auth tab and a folder's Auth
 * dialog, one form for both. None, Bearer token, Basic (username, password),
 * API key (a name and value, in a header or the query); a case can also take
 * its folder's, so the requests of a folder share one token.
 *
 * Fields take ${variables}. The auth is added when the request is sent
 * (shared/api-request.js), and a header the Headers tab writes wins over it —
 * the case's tab says so when that happens.
 */

import { parseRows } from '../headers.js';
import { findFolder, setFolderAuth } from '../model.js';
import { h } from './dom.js';
import { suggestVars } from './var-suggest.js';

const LABELS = { none: 'No auth', bearer: 'Bearer token', basic: 'Basic auth', apikey: 'API key' };
const SHORT = { none: 'None', bearer: 'Bearer', basic: 'Basic', apikey: 'API key' };
const FOLDER_TYPES = ['none', 'bearer', 'basic', 'apikey'];

/** "Bearer", "Basic", "API key", "None". */
export function authShort(a) {
  return SHORT[a?.type] || SHORT.none;
}

/** The header `a` adds (lower case), or '' — none, inherit, or an API key in the query. */
function headerOf(a) {
  if (a?.type === 'bearer' || a?.type === 'basic') return 'authorization';
  return a?.type === 'apikey' && a.in !== 'query' ? String(a.key || '').trim().toLowerCase() : '';
}

/**
 * The form for `auth`: a type, then its fields. `types` the choices,
 * `inheritText` the label of 'inherit'; `onChange(next)` on each edit.
 */
function authForm(app, auth, { types, inheritText = '', hints = {}, onChange }) {
  let cur = { ...auth };
  const set = (fields) => { cur = { ...cur, ...fields }; onChange(cur); };
  const fields = h('div', { class: 'ac-auth-fields' });
  const type = h('select', { class: 'mini-select', 'aria-label': 'Auth type',
    onchange: () => { set({ type: type.value, ...(type.value === 'apikey' && !cur.in ? { in: 'header' } : {}) }); draw(); } },
  ...types.map((t) => h('option', { value: t }, t === 'inherit' ? inheritText : LABELS[t])));
  type.value = cur.type;

  const field = (k, label, placeholder) => {
    const input = h('input', { type: 'text', value: cur[k] || '', placeholder, spellcheck: false, 'aria-label': label,
      oninput: () => set({ [k]: input.value }) });
    suggestVars(input, app);
    return h('label', { class: 'ac-auth-field' }, h('span', null, label), input);
  };
  const where = () => {
    const sel = h('select', { class: 'mini-select', 'aria-label': 'Add to', onchange: () => set({ in: sel.value }) },
      h('option', { value: 'header' }, 'Header'), h('option', { value: 'query' }, 'Query (?name=value)'));
    sel.value = cur.in === 'query' ? 'query' : 'header';
    return h('label', { class: 'ac-auth-field' }, h('span', null, 'Add to'), sel);
  };
  const FIELDS = {
    bearer: () => [field('token', 'Token', '${token}')],
    basic: () => [field('username', 'Username', '${username}'), field('password', 'Password', '${password}')],
    apikey: () => [field('key', 'Name', 'X-Api-Key'), field('value', 'Value', '${apiKey}'), where()],
  };
  function draw() {
    const hint = hints[cur.type];
    fields.replaceChildren(...(FIELDS[cur.type]?.() || []), ...(hint ? [h('p', { class: 'helper' }, hint)] : []));
  }
  draw();
  return h('div', { class: 'ac-auth' }, h('label', { class: 'ac-auth-field' }, h('span', null, 'Type'), type), fields);
}

/** The case's Auth tab, and `refresh()` for when its headers or folder change. */
export function authPane(ed) {
  const { app } = ed;
  const folder = () => findFolder(app.state, ed.current().folderId);
  const note = h('p', { class: 'ac-auth-note', role: 'status', hidden: true });
  const pane = h('div', { class: 'ac-pane' });

  function refresh() {
    const c = ed.current();
    const a = c.auth?.type === 'inherit' ? folder()?.auth : c.auth;
    const name = headerOf(a);
    const row = name && parseRows(c.headers).find((r) => r.on && r.name.trim().toLowerCase() === name);
    note.textContent = row ? `The Headers tab sets ${row.name.trim()} — that value is sent, not this auth.` : '';
    note.hidden = !row;
  }
  function draw() {
    const f = folder();
    pane.replaceChildren(authForm(app, ed.current().auth, {
      types: ['inherit', ...FOLDER_TYPES],
      inheritText: `Inherit from folder (${f?.name || 'folder'}: ${authShort(f?.auth)})`,
      hints: {
        inherit: 'Sent with the folder\'s auth — set it with 🔑 Auth above the list.',
        none: 'Sent without auth, even when the folder has one.',
      },
      onChange: (auth) => { ed.patch({ auth }); refresh(); },
    }), note);
    refresh();
  }
  draw();
  return { pane, refresh };
}

/** The folder's Auth dialog: edits apply as they are typed. */
function openFolderAuth(app, id) {
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); app.set(app.state); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const f = findFolder(app.state, id);
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } },
    h('div', { class: 'modal ac-auth-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Auth of ${f.name}` },
      h('div', { class: 'modal-head' }, h('h3', null, `Auth of "${f.name}"`),
        h('button', { class: 't-btn t-btn-sm', 'aria-label': 'Close', onclick: close }, '✕')),
      h('p', { class: 'helper' }, 'Used by the requests of this folder whose Auth is "Inherit from folder" — new requests are.'),
      authForm(app, f.auth, {
        types: FOLDER_TYPES,
        onChange: (auth) => app.set(setFolderAuth(app.state, id, auth), { render: 'none' }),
      })));
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey, true);
  backdrop.querySelector('select').focus();
}

/** "🔑 Auth: Bearer" for the head of the list, opening the folder's dialog. */
export function folderAuthButton(app, folder) {
  return h('button', { class: 't-btn', title: 'How the requests of this folder sign in', onclick: () => openFolderAuth(app, folder.id) },
    `🔑 Auth: ${authShort(folder.auth)}`);
}
