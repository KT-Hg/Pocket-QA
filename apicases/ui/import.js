/**
 * ui/import.js — the Import dialog: a Postman collection or environment file
 * is read (apicases/postman-import.js), what it holds is shown — the hosts
 * its requests go to first, then what was left out — and nothing is added
 * until Add. Nothing runs on Add either: a request is only sent on Send or Run.
 */

import { MAX_IMPORT_BYTES, fromPostman, hostsOf, importInto } from '../postman-import.js';
import { h, toast } from './dom.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function summary(parsed, withEnv) {
  const env = parsed.environment;
  if (parsed.kind === 'environment') {
    return [h('p', null, 'Environment ', h('b', null, parsed.name), ` — ${plural(env.vars.length, 'variable')}. It is added next to yours, not put in use.`)];
  }
  const cases = parsed.folders.reduce((n, f) => n + f.cases.length, 0);
  const hosts = hostsOf(parsed);
  return [
    h('p', null, h('b', null, parsed.name), ` — ${plural(parsed.folders.length, 'folder')}, ${plural(cases, 'request')}`),
    hosts.length ? h('div', { class: 'ac-import-sect' },
      h('div', { class: 'ac-import-label' }, 'Requests go to'),
      h('div', { class: 'ac-hosts' }, ...hosts.map((x) => h('code', { class: 'ac-host' }, x))),
      h('p', { class: 'helper' }, 'Check these are the servers you expect: a request to a site is sent with your browser\'s cookies for it. Nothing is sent until you press Send or Run.')) : null,
    parsed.notes.length ? h('div', { class: 'ac-import-sect' },
      h('div', { class: 'ac-import-label' }, 'Left out or changed'),
      h('ul', { class: 'ac-import-notes' }, ...parsed.notes.map((n) => h('li', null, n)))) : null,
    env ? h('label', { class: 'ac-inline ac-import-env' }, withEnv, `Also add the environment "${env.name}" (${plural(env.vars.length, 'variable')})`) : null,
  ];
}

function addedText(parsed, withEnv) {
  const cases = parsed.folders.reduce((n, f) => n + f.cases.length, 0);
  const parts = parsed.folders.length ? [`${plural(parsed.folders.length, 'folder')}, ${plural(cases, 'request')}`] : [];
  if (!withEnv || !parsed.environment) return `Added ${parts.join('')}`;
  const env = parsed.environment.name;
  return `Added ${[...parts, `the environment "${env}"`].join(' and ')} — pick "${env}" under Environment to send with its variables`;
}

function openDialog(app) {
  let parsed = null;
  const info = h('div', { class: 'ac-import-info' });
  const error = h('div', { class: 'ac-field-error', role: 'alert', hidden: true });
  const withEnv = h('input', { type: 'checkbox', checked: true });
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); };
  const fail = (message) => { error.textContent = message; error.hidden = false; };
  const add = h('button', { class: 't-btn t-btn-primary', disabled: true, onclick: () => {
    const env = parsed.kind === 'environment' || withEnv.checked;
    close();
    app.set(importInto(app.state, parsed, { environment: env }));
    toast(addedText(parsed, env), 'success', { ms: 4000 });
  } }, 'Add');
  const read = async () => {
    parsed = null;
    add.disabled = true;
    info.replaceChildren();
    error.hidden = true;
    const f = file.files[0];
    if (!f) return;
    if (f.size > MAX_IMPORT_BYTES) { fail(`${f.name} is ${(f.size / 1048576).toFixed(1)} MB — files up to ${MAX_IMPORT_BYTES / 1048576} MB are read`); return; }
    let json;
    try { json = JSON.parse(await f.text()); } catch (e) { fail(`${f.name} is not JSON: ${e.message}`); return; }
    const r = fromPostman(json);
    if (r.error) { fail(r.error); return; }
    parsed = r;
    info.replaceChildren(...summary(r, withEnv));
    add.disabled = !(r.folders.length || r.environment);
  };
  const file = h('input', { type: 'file', accept: '.json,application/json', class: 'ac-file', 'aria-label': 'Postman file', onchange: read });
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } },
    h('div', { class: 'modal ac-import', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Import from Postman' },
      h('div', { class: 'modal-head' }, h('h3', null, 'Import from Postman'),
        h('button', { class: 't-btn t-btn-sm', 'aria-label': 'Close', onclick: close }, '✕')),
      h('p', { class: 'helper ac-curl-help' },
        'A collection (in Postman: ⋯ → Export → Collection v2.1) or an environment file, up to 5 MB. ',
        'Folders inside folders become "Parent / Child"; Postman\'s scripts are not run.'),
      file, error, info,
      h('div', { class: 'ac-ask-foot' },
        h('button', { class: 't-btn', onclick: close }, 'Cancel'),
        add)));
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey, true);
  file.focus();
}

export function importButton(app) {
  return h('button', { class: 't-btn', title: 'Add folders and requests from a Postman collection, or an environment', onclick: () => openDialog(app) }, 'Import');
}
