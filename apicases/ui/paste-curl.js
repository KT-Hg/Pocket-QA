/**
 * ui/paste-curl.js — the Paste cURL dialog: a command copied from DevTools
 * becomes a new request in the open folder (apicases/curl.js reads it).
 */

import { parseCurl } from '../curl.js';
import { addCase } from '../model.js';
import { h, toast } from './dom.js';

function openDialog(app) {
  const error = h('div', { class: 'ac-field-error', role: 'alert', hidden: true });
  const input = h('textarea', {
    class: 'ac-code', rows: 12, spellcheck: false, 'aria-label': 'curl command',
    placeholder: "curl 'https://api.example.com/users' \\\n  -H 'accept: application/json' \\\n  -H 'authorization: Bearer …'",
  });
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); };
  const add = () => {
    const r = parseCurl(input.value);
    if (r.error) { error.textContent = r.error; error.hidden = false; input.focus(); return; }
    close();
    app.set(addCase(app.state, r.request).state);
    if (r.notes.length) toast(`Added "${r.request.name}" — left out ${r.notes.join('; ')}`, 'warn', { ms: 7000 });
    else toast(`Added "${r.request.name}"`, 'success');
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); }
  };
  input.addEventListener('input', () => { error.hidden = true; });
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } },
    h('div', { class: 'modal ac-curl', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Paste a cURL command' },
      h('div', { class: 'modal-head' }, h('h3', null, 'Paste a cURL command'),
        h('button', { class: 't-btn t-btn-sm', 'aria-label': 'Close', onclick: close }, '✕')),
      h('p', { class: 'helper ac-curl-help' },
        'In DevTools → Network, right-click a request → Copy → ', h('b', null, 'Copy as cURL (bash)'),
        '. Headers the browser sets itself and the Cookie header are left out: the request sends the browser\'s own cookies for the site.'),
      input, error,
      h('div', { class: 'ac-ask-foot' },
        h('button', { class: 't-btn', onclick: close }, 'Cancel'),
        h('button', { class: 't-btn t-btn-primary', onclick: add }, 'Add request'))));
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey, true);
  input.focus();
}

export function pasteCurlButton(app) {
  return h('button', { class: 't-btn', title: 'Make a request from a curl command', onclick: () => openDialog(app) }, 'Paste cURL');
}
