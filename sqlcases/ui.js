/**
 * ui.js — Page wiring for the SQL Test Case Designer.
 *
 * Everything below the surface lives in generate.js and the technique modules;
 * this file only renders what they return and keeps the query, the technique
 * toggles, the layout and the theme in chrome.storage.local so reopening the
 * tab lands where the user left off.
 *
 * The page is three columns: a rail of inputs, a list of cases, and an
 * inspector holding one case. All three are written out in sqlcases.html and
 * only toggled here — the query textarea has a caret and an undo stack, and
 * rebuilding it on a tab switch would throw both away. What this file builds
 * from scratch is what changes with every run: the case cards, the inspector,
 * the chips and bars in the insight block.
 *
 * Rendering builds nodes rather than assigning innerHTML: case text is derived
 * from the user's own SQL, and a table name containing angle brackets should
 * appear as text, not become markup.
 *
 * The parts live in ui/ (run, list, inspector, filters, insight, values,
 * schema, diff, layout, exports, storage…), state shared between them in
 * ui/state.js; this file wires the page together in init().
 */

import { THEME_KEY } from '../shared/storage-keys.js';
import { LANGUAGES, getLang, t } from './i18n.js';
import { el } from './ui/dom.js';
import { initExamples } from './ui/examples.js';
import { closeMenus, initExports } from './ui/exports.js';
import { initFilters } from './ui/filters.js';
import { renderInspector } from './ui/inspector.js';
import { applyLayout, initLayoutControls, saveUi, trackCmdbarHeight } from './ui/layout.js';
import { groupKeyOf, renderList, visibleCases } from './ui/list.js';
import { run, setMode } from './ui/run.js';
import { closeDiagram, diagram, openDiagram } from './ui/schema.js';
import { collapsedGroups, view } from './ui/state.js';
import { restoreState, saveState, storageSet } from './ui/storage.js';
import { buildTechniqueList } from './ui/techniques.js';
import { applyLanguage, applyStaticText, applyTheme } from './ui/text.js';
import { toast } from './ui/toast.js';
import { saveValues } from './ui/values-panel.js';
import * as valuebook from './valuebook.js';
import '../shared/ui/calm-focus.js';

// The query is analysed once typing pauses this long.
const TYPING_DEBOUNCE_MS = 500;

function init() {
  buildTechniqueList();
  initExamples();
  initExports();
  initLayoutControls();
  initFilters();

  el.analyze.addEventListener('click', () => { saveState(); run(); });

  const runOnCtrlEnter = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveState();
      run();
    }
  };
  el.sql.addEventListener('keydown', runOnCtrlEnter);
  el.sqlAfter.addEventListener('keydown', runOnCtrlEnter);

  // Typing re-runs on a debounce: generation is pure and fast enough that
  // waiting for a button press only makes the tool feel slower than it is.
  let debounce = null;
  el.sql.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { saveState(); run(); }, TYPING_DEBOUNCE_MS);
  });
  let debounceAfter = null;
  el.sqlAfter.addEventListener('input', () => {
    clearTimeout(debounceAfter);
    debounceAfter = setTimeout(() => { saveState(); run(); }, TYPING_DEBOUNCE_MS);
  });

  el.modeToggle.querySelectorAll('button[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === view.mode) return;
      setMode(btn.dataset.mode);
      saveState();
      saveUi();
      run();
    });
  });

  el.clear.addEventListener('click', () => {
    el.sql.value = '';
    el.sqlAfter.value = '';
    saveState();
    run();
    el.sql.focus();
  });

  el.resetValues.addEventListener('click', () => {
    if (!valuebook.clearAll()) return;
    saveValues();
    run();
    toast(t('vb.toastReset'), 'success');
  });

  el.maxFull.addEventListener('change', () => { saveState(); run(); });
  el.joinConds.addEventListener('change', () => { saveState(); run(); });

  el.theme.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    storageSet({ [THEME_KEY]: next });
  });

  el.lang.addEventListener('click', () => {
    const idx = LANGUAGES.findIndex(l => l.code === getLang());
    applyLanguage(LANGUAGES[(idx + 1) % LANGUAGES.length].code);
    saveState();
  });

  el.help.addEventListener('click', () => { el.helpModal.hidden = false; });
  el.helpClose.addEventListener('click', () => { el.helpModal.hidden = true; });
  el.helpModal.addEventListener('click', (e) => {
    if (e.target === el.helpModal) el.helpModal.hidden = true;
  });

  el.diagramBtn.addEventListener('click', openDiagram);
  el.dgClose.addEventListener('click', closeDiagram);
  el.diagramModal.addEventListener('click', (e) => {
    if (e.target === el.diagramModal) closeDiagram();
  });
  el.dgFit.addEventListener('click', () => diagram?.fit());
  el.dgZoomIn.addEventListener('click', () => diagram?.zoomBy(1.25));
  el.dgZoomOut.addEventListener('click', () => diagram?.zoomBy(1 / 1.25));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.diagramModal.hidden) { closeDiagram(); return; }
    if (!el.helpModal.hidden) { el.helpModal.hidden = true; return; }
    if (!el.exportMenu.hidden || !el.filterPop.hidden) { closeMenus(); return; }
    // Escape with a case open closes the inspector, which is the only other
    // thing on this page that is "open" in the sense Escape usually means.
    if (view.selectedId) { view.selectedId = null; renderList(); renderInspector(); applyLayout(); }
  });

  // Walking the list from the keyboard, but only when the caret is not in a
  // field — an arrow key inside the query textarea moves the caret and must
  // keep doing so.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!view.selectedId || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const list = visibleCases();
    const at = list.findIndex(c => c.id === view.selectedId);
    const next = list[at + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    // Walking into a shut group opens it: the alternative is an arrow press
    // that selects a case the list is not showing.
    collapsedGroups.delete(groupKeyOf(next));
    view.selectedId = next.id;
    renderList();
    renderInspector();
  });

  trackCmdbarHeight();

  restoreState((firstVisit) => {
    applyStaticText();
    el.density.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.d === view.density));
    // A rail that starts shut on a narrow window is the same call the CSS
    // makes at that width; making it here too keeps the toggle honest.
    if (window.innerWidth < 900) view.railOpen = false;
    run();
    el.sql.focus();
    // After applyStaticText(), or the note would be in whatever language the
    // catalog defaulted to rather than the one now on screen.
    if (firstVisit) toast(t('ui.firstRunSample'), 'success', 6000);
  });
}

init();
