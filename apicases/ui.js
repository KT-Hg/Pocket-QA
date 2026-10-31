/**
 * ui.js — page wiring for API Tests (apicases.html).
 *
 * Folders on the left (ui/folders.js), the cases of the open folder in the
 * middle (ui/list.js), the open case on the right (ui/editor.js). All three
 * draw from one state (model.js), kept in chrome.storage.local; `app.set()`
 * replaces it, saves it a moment later and redraws. The theme is the popup's
 * (THEME_KEY), so the page follows the light / dark choice made anywhere else
 * in the extension.
 */

import { THEME_KEY } from '../shared/storage-keys.js';
import '../shared/ui/calm-focus.js';
import { STATE_KEY, emptyState, findFolder, moveCases, normalizeState } from './model.js';
import { el, toast } from './ui/dom.js';
import { renderEditor } from './ui/editor.js';
import { initFolders, renderFolders } from './ui/folders.js';
import { initList, renderList } from './ui/list.js';

/** Extension storage, or null when the page is opened as a plain file. */
const storage = (typeof chrome !== 'undefined' && chrome.storage?.local) || null;

// Typing saves once it pauses this long; leaving the page saves at once.
const SAVE_DEBOUNCE_MS = 400;

function storageSet(items) {
  if (!storage) return;
  storage.set(items, () => {
    if (chrome.runtime.lastError) {
      console.error('[APICASES] storage write failed:', chrome.runtime.lastError);
      toast('Could not save — the change is lost when this tab closes', 'error');
    }
  });
}

let saveTimer = null;
function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  storageSet({ [STATE_KEY]: app.state });
}

const app = {
  state: emptyState(),
  /** List filters and the cases ticked in it — this visit only. */
  view: { query: '', method: '', selected: new Set() },

  /**
   * Replace the state, save it shortly, redraw. `render`: 'all', or 'list' when
   * the editor itself made the change and must not be rebuilt under the caret.
   * `focus`: a field of the editor to focus once it is drawn ('url', 'name').
   */
  set(next, { render = 'all', focus = null } = {}) {
    app.state = next;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
    renderList(app);
    if (render === 'all') {
      renderFolders(app);
      renderEditor(app, { focus });
    }
  },

  moveTo(ids, folderId) {
    const folder = findFolder(app.state, folderId);
    if (!folder || !ids.length) return;
    app.view.selected.clear();
    app.set(moveCases(app.state, ids, folderId));
    toast(`Moved ${ids.length} request${ids.length === 1 ? '' : 's'} to "${folder.name}"`, 'success');
  },
};

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  el.theme.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function start(saved) {
  app.state = normalizeState(saved);
  renderFolders(app);
  renderList(app);
  renderEditor(app);
}

function init() {
  initFolders(app);
  initList(app);
  el.theme.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    storageSet({ [THEME_KEY]: next });
  });
  addEventListener('pagehide', () => { if (saveTimer) flushSave(); });
  addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) flushSave(); });

  if (!storage) { applyTheme('light'); start(null); return; }
  storage.get([THEME_KEY, STATE_KEY], (res) => {
    applyTheme(res?.[THEME_KEY] === 'dark' ? 'dark' : 'light');
    start(res?.[STATE_KEY]);
  });
}

init();
