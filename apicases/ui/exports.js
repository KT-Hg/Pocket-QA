/**
 * ui/exports.js — the Export ▾ menu over the list: the open folder (or every
 * folder, under All requests) as a Postman collection, secret values left
 * blank unless "Include secret values" is ticked.
 */

import { downloadText } from '../../shared/file-export.js';
import { ALL, findFolder } from '../model.js';
import { collectionFileName, toPostman } from '../postman-export.js';
import { h, toast } from './dom.js';

/** Ticked for this visit only: a file with credentials in it is never the default. */
let includeSecrets = false;
/** The open menu's { wrap, close }, or null. */
let open = null;

function closeMenu() {
  open?.close();
  open = null;
}

document.addEventListener('click', (e) => { if (open && !open.wrap.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') closeMenu(); }, true);

function exportPostman(app) {
  closeMenu();
  const s = app.state;
  const { collection, removedSecrets } = toPostman(s, { folderId: s.folderId, includeSecrets });
  const file = collectionFileName(collection);
  downloadText(JSON.stringify(collection, null, 2), file, 'application/json');
  const n = collection.item.reduce((sum, f) => sum + f.item.length, 0);
  if (!removedSecrets.length) { toast(`Exported ${n} request${n === 1 ? '' : 's'} to ${file}`, 'success'); return; }
  toast(`Exported ${file} — left blank: ${removedSecrets.join('; ')}. Use \${variables} for them, or tick "Include secret values".`, 'warn', { ms: 9000 });
}

export function exportMenu(app) {
  const s = app.state;
  const scope = s.folderId === ALL ? 'every folder' : `"${findFolder(s, s.folderId)?.name}"`;
  const button = h('button', { class: 't-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', disabled: !s.folders.length,
    title: `Save ${scope} as a file`, onclick: () => (menu.hidden ? show() : closeMenu()) },
  'Export', h('span', { class: 'caret' }, ' ▾'));
  const secrets = h('input', { type: 'checkbox', checked: includeSecrets, onchange: () => { includeSecrets = secrets.checked; } });
  const menu = h('div', { class: 'menu ac-menu', role: 'menu', hidden: true },
    h('button', { role: 'menuitem', title: `${scope} as a Postman Collection v2.1, checks as test scripts — for Postman or Newman`, onclick: () => exportPostman(app) },
      h('span', { class: 'i' }, '📦'), h('span', null, 'Postman collection'), h('small', null, '.json')),
    h('label', { class: 'ac-menu-check', title: 'Tokens, passwords and API keys written out in full go into the file too. Values that are ${variables} always do.' },
      secrets, 'Include secret values'));
  const wrap = h('div', { class: 'menu-wrap' }, button, menu);
  const show = () => {
    closeMenu();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    open = { wrap, close: () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); } };
  };
  return wrap;
}
