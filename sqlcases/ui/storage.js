/**
 * ui/storage.js — what the page keeps in chrome.storage.local: the query and
 * options, the layout, the language, the value overrides.
 */

import { THEME_KEY } from '../../shared/storage-keys.js';
import { TECHNIQUES } from '../generate.js';
import { DEFAULT_LANG, getLang, setLang, t } from '../i18n.js';
import * as valuebook from '../valuebook.js';
import { el } from './dom.js';
import { EXAMPLES } from './examples.js';
import { applyUiState } from './layout.js';
import { setMode } from './run.js';
import { view } from './state.js';
import { applyTheme } from './text.js';
import { toast } from './toast.js';

const STATE_KEY = 'sqlCasesState';

const LANG_KEY = 'sqlCasesLang';

export const UI_KEY = 'sqlCasesUi';

export const VALUES_KEY = 'sqlCasesValues';

/**
 * Extension storage, or null when the page is opened as a plain file.
 * Everything it holds is a convenience (last query, toggles, theme), so the
 * page stays fully usable without it rather than failing to start.
 */
const storage = (typeof chrome !== 'undefined' && chrome.storage?.local) || null;

/**
 * storage.set() wrapped to surface a write failure (quota exceeded, revoked
 * permission) instead of swallowing it — otherwise the query, theme or
 * sample values look saved right up until the page is reopened and they
 * turn out not to be, with nothing having said so in between.
 */
export function storageSet(items) {
  if (!storage) return;
  storage.set(items, () => {
    if (chrome.runtime.lastError) {
      console.error('[SQLCASES] storage write failed:', chrome.runtime.lastError);
      toast(t('ui.toastSaveError'), 'error');
    }
  });
}

// ---- persistence -----------------------------------------------------

export function saveState() {
  const techniques = {};
  TECHNIQUES.forEach(tech => {
    techniques[tech.key] = el.techList.querySelector(`input[data-tech="${tech.key}"]`)?.checked ?? true;
  });
  storageSet({
    [STATE_KEY]: {
      sql: el.sql.value,
      sqlAfter: el.sqlAfter.value,
      mode: view.mode,
      techniques,
      maxFullTable: el.maxFull.value,
      includeJoinConditions: el.joinConds.checked
    },
    [LANG_KEY]: getLang()
  });
}

/**
 * Put back what the last visit left, and tell the caller whether this is a
 * first visit.
 *
 * With nothing saved, the query box opens empty and the page is left
 * describing itself to someone who has not seen it work yet. Seeding the first
 * example instead means the first thing on screen is a real query with real
 * cases under it; init() follows it with the toast naming the button that
 * clears it. Anything saved — including a query deliberately cleared to empty
 * — is a returning reader and is restored untouched.
 */
export function restoreState(done) {
  const seedSample = () => { el.sql.value = EXAMPLES[0].sql; };
  if (!storage) { applyTheme('light'); setLang(DEFAULT_LANG); seedSample(); done(true); return; }
  storage.get([STATE_KEY, THEME_KEY, LANG_KEY, UI_KEY, VALUES_KEY], (res) => {
    applyTheme(res?.[THEME_KEY] === 'dark' ? 'dark' : 'light');
    // Only select the language here. Rendering and the first generation wait
    // until the saved query is back in the textarea, so startup runs once.
    setLang(res?.[LANG_KEY] || DEFAULT_LANG);
    applyUiState(res?.[UI_KEY]);
    // Before the first generation: the saved values are an input to it, not a
    // decoration applied to the result afterwards.
    valuebook.load(res?.[VALUES_KEY]);
    const s = res?.[STATE_KEY];
    setMode(s?.mode);
    if (s) {
      if (typeof s.sql === 'string') el.sql.value = s.sql;
      if (typeof s.sqlAfter === 'string') el.sqlAfter.value = s.sqlAfter;
      if (s.maxFullTable) el.maxFull.value = s.maxFullTable;
      if (typeof s.includeJoinConditions === 'boolean') el.joinConds.checked = s.includeJoinConditions;
      if (s.techniques) {
        Object.entries(s.techniques).forEach(([key, on]) => {
          const input = el.techList.querySelector(`input[data-tech="${key}"]`);
          if (input) input.checked = !!on;
        });
      }
    } else {
      seedSample();
    }
    done(!s);
  });
}
