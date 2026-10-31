/**
 * ui.js — page wiring for API Tests (apicases.html).
 *
 * Folders on the left, the cases of the chosen folder in the middle, the chosen
 * case on the right. The theme is the popup's (THEME_KEY), so the page follows
 * the light / dark choice made anywhere else in the extension.
 */

import { THEME_KEY } from '../shared/storage-keys.js';
import '../shared/ui/calm-focus.js';
import { el, h, toast } from './ui/dom.js';

/** Extension storage, or null when the page is opened as a plain file. */
const storage = (typeof chrome !== 'undefined' && chrome.storage?.local) || null;

export function storageSet(items) {
  if (!storage) return;
  storage.set(items, () => {
    if (chrome.runtime.lastError) {
      console.error('[APICASES] storage write failed:', chrome.runtime.lastError);
      toast('Could not save — the change is lost when this tab closes', 'error');
    }
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  el.theme.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function render() {
  el.folderList.replaceChildren();
  el.listHead.replaceChildren(h('h2', { class: 'ac-title' }, 'API Tests'));
  el.caseList.replaceChildren(h('div', { class: 'empty-state' },
    h('div', { class: 'empty-icon' }, '🔌'),
    h('div', { class: 'empty-title' }, 'No folders yet'),
    h('div', { class: 'empty-sub' }, 'Create a folder, then add API requests to it.')));
  el.inspInner.replaceChildren(h('div', { class: 'insp-empty' },
    h('div', null, h('div', { class: 'ic' }, '📮'), h('p', null, 'Pick a request to edit and send it.'))));
}

function init() {
  el.theme.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    storageSet({ [THEME_KEY]: next });
  });
  if (!storage) { applyTheme('light'); render(); return; }
  storage.get([THEME_KEY], (res) => {
    applyTheme(res?.[THEME_KEY] === 'dark' ? 'dark' : 'light');
    render();
  });
}

init();
