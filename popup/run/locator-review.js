/**
 * run/locator-review.js — the 🩹 line of the Last run card and its Review
 * window: the steps of the last Play or Resume whose other locators did not
 * agree on their element (content.js _locatorNote, kept as lastRun.notes by
 * bg/playback.js), each with what every locator found, and a button that takes
 * the step's locators again from the element the run found. Nothing is changed
 * without that click: a locator that found another element may be the right one.
 */

import { LAST_RUN_KEY } from '../../shared/storage-keys.js';
import { SELECTOR_KEYS } from '../../shared/var-name.js';
import { scenarioList } from '../dom.js';
import { previewActions } from '../record/preview.js';
import { updateUndoRedoState } from '../record/undo-redo.js';
import { attachModalKeyHandlers, closeModal, openModal } from '../ui/modal.js';
import { ui } from '../ui-state.js';
import { showToast } from '../utils.js';

const MODAL = 'locatorReviewModal';
// The locators in the order playback tries them (content.js _locators).
const ORDER = ['fullXpath', 'id', 'xpath', 'css', 'testId', 'dataId', 'name', 'text'];
const WORDS = { fullXpath: 'full XPath', xpath: 'XPath', id: 'ID', css: 'CSS', testId: 'data-testid', dataId: 'data-id', name: 'name', text: 'text' };

/** "ID", "ID and CSS", "ID, CSS and name". */
function _words(types) {
  const w = types.map((t) => WORDS[t] || t);
  return w.length < 2 ? (w[0] || '') : `${w.slice(0, -1).join(', ')} and ${w.at(-1)}`;
}

/** input#email “Email” — an element as the page names it (content.js _previewLabel). */
const _chip = (l) => `${l?.tag || 'element'}${l?.id ? `#${l.id}` : ''}${l?.name ? ` “${l.name}”` : ''}`;
/** “Email”, else input#email: short enough for a button. */
const _short = (l) => (l?.name ? `“${l.name}”` : `${l?.tag || 'element'}${l?.id ? `#${l.id}` : ''}`);

/** The notes of `run` not dealt with yet. */
export const openNotes = (run) => (run?.notes || []).filter((n) => !n.done);

/** The card's 🩹 line: how many steps have locators to check. */
export function renderNotesLine(run) {
  const line = document.getElementById('lastRunNotes');
  if (!line) return;
  const n = openNotes(run).length;
  line.hidden = !n;
  if (n) document.getElementById('lastRunNotesText').textContent = `🩹 ${n} step${n === 1 ? '' : 's'}: locators to check`;
}

/** The step as it was when the run played it (bg/playback.js _saveLastRun). */
function _snapshot(run, note) {
  const list = note.scenarioId ? run.otherActions?.[note.scenarioId] : run.actions;
  return list?.[note.index - 1] || null;
}

const _locatorStrings = (a) => [a?.selector, ...Object.values(a?.selectors || {})].filter((v) => typeof v === 'string');
const _usesVars = (a) => _locatorStrings(a).some((v) => v.includes('${'));
const _sameStep = (a, b) => !!a && !!b && a.type === b.type
  && JSON.stringify([a.selector || '', a.selectors || null]) === JSON.stringify([b.selector || '', b.selectors || null]);

function _el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  // textContent: names and selectors come from the page under test.
  if (text != null) e.textContent = text;
  return e;
}

function _button(text, className, onClick) {
  const b = _el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** Each recorded locator of the step: its value, and what it found in this run (`loc`: the note's locator). */
function _table(loc, step) {
  const map = step?.selectors && typeof step.selectors === 'object' ? step.selectors : {};
  const found = (t) => {
    if (loc.used.by.includes(t)) return ['lrv-ok', `✓ ${_chip(loc.used.label)}${loc.kind === 'split' ? ' (used)' : ''}`];
    if (loc.other?.by.includes(t)) return ['lrv-other', `≠ ${_chip(loc.other.label)}`];
    return ['lrv-miss', '✗ nothing'];
  };
  const table = _el('table', 'lrv-table');
  const head = _el('tr');
  head.append(_el('th', null, 'Locator'), _el('th', null, 'Recorded'), _el('th', null, 'This run'));
  table.append(head);
  for (const t of ORDER.filter((x) => typeof map[x] === 'string' && map[x])) {
    const [cls, text] = found(t);
    const tr = _el('tr');
    const rec = _el('td');
    rec.append(_el('code', null, t === 'text' && map.textTag ? `“${map.text}” (${map.textTag})` : map[t]));
    tr.append(_el('td', null, WORDS[t]), rec, _el('td', cls, text));
    table.append(tr);
  }
  return table;
}

/** What the locators said, in a sentence. */
function _sentence(loc) {
  const nothing = _words(loc.missed || []);
  const missed = nothing ? ` ${nothing[0].toUpperCase()}${nothing.slice(1)} found nothing.` : '';
  if (loc.kind === 'split') {
    return `This run used ${_chip(loc.used.label)}, found by ${_words(loc.used.by)}; ${_words(loc.other.by)} find ${_chip(loc.other.label)}.${missed}`;
  }
  return `Only ${_words(loc.used.by)} still finds ${_chip(loc.used.label)}.${missed} One more change to the page and this step breaks.`;
}

/**
 * The Review window of the run `getRun()` gives. `showAction(scenarioId, index)`
 * selects a step in the list, as a failure of the card does.
 */
export function initLocatorReview(getRun, showAction) {
  const list = document.getElementById('locatorReviewList');
  const reviewButton = document.getElementById('lastRunNotesReview');
  if (!list || !reviewButton) return;
  let opener = null;
  const close = () => closeModal(MODAL, opener);
  attachModalKeyHandlers(MODAL, close);
  document.getElementById('locatorReviewClose')?.addEventListener('click', close);

  /** The step's locators taken again from the element `which` ('used' or 'other') of the run. */
  const retake = (run, note, which) => {
    const scenarioId = note.scenarioId || run.scenarioId;
    chrome.runtime.sendMessage({ type: 'GET_PREVIEW_ACTIONS', scenarioId }, (res) => {
      const current = res?.actions?.[note.index - 1];
      if (!_sameStep(current, _snapshot(run, note))) {
        showToast('This step changed since the run — pick its element again in the form', 'warn');
        return;
      }
      const fresh = note.locator[which]?.selectors || {};
      const selectors = {};
      for (const k of [...SELECTOR_KEYS, 'textTag']) if (typeof fresh[k] === 'string' && fresh[k]) selectors[k] = fresh[k];
      const action = { ...current, selectors, selector: selectors.css || current.selector };
      chrome.runtime.sendMessage({ type: 'UPDATE_ACTION', scenarioId, index: note.index - 1, action }, (done) => {
        if (!done?.success) { showToast('Could not change the step', 'error'); return; }
        note.done = true;
        // Kept with the run, so the line and the window stay right when the popup opens again.
        chrome.storage.local.get(LAST_RUN_KEY, (x) => {
          const stored = x[LAST_RUN_KEY];
          if (stored?.endedAt !== run.endedAt || !stored.notes) return;
          const same = stored.notes.find((n) => n.index === note.index && n.scenarioId === note.scenarioId);
          if (same) same.done = true;
          chrome.storage.local.set({ [LAST_RUN_KEY]: stored });
        });
        showToast(`#${note.index} — locators taken again from ${_short(note.locator[which].label)}`, 'success');
        if ((scenarioList.value || null) === scenarioId) { previewActions(); updateUndoRedoState(); }
        render(run);
        renderNotesLine(run);
      });
    });
  };

  const render = (run) => {
    list.replaceChildren(...(run?.notes || []).map((note) => {
      const step = _snapshot(run, note);
      const box = _el('div', `lrv-step${note.done ? ' lrv-done' : ''}`);
      // A step of another scenario a Switch played: its number is that one's.
      const where = note.scenarioId ? ` in “${ui.scenariosCache?.[note.scenarioId]?.name || note.scenarioId}”` : '';
      box.append(_el('div', 'lrv-head', `#${note.index}${where} ${note.label || note.type} · ${note.type}`));
      box.append(_el('p', 'lrv-why', _sentence(note.locator)));
      box.append(_table(note.locator, step));
      const row = _el('div', 'lrv-buttons');
      if (note.done) row.append(_el('span', 'lrv-fixed', '✓ Locators taken again'));
      else if (!step) row.append(_el('span', 'lrv-cannot', 'This step is not in the run any more.'));
      else if (_usesVars(step)) row.append(_el('span', 'lrv-cannot', 'Its locators use ${…} variables: edit them in the form.'));
      else if (note.locator.kind === 'split') {
        row.append(
          _button(`Use ${_short(note.locator.other.label)}`, 'lrv-fix', () => retake(run, note, 'other')),
          _button(`Keep ${_short(note.locator.used.label)}`, 'secondary lrv-fix', () => retake(run, note, 'used')),
        );
      } else row.append(_button('Take locators again', 'lrv-fix', () => retake(run, note, 'used')));
      row.append(_button('Show', 'secondary lrv-show', () => { close(); showAction(note.scenarioId || run.scenarioId, note.index - 1); }));
      box.append(row);
      return box;
    }));
  };

  reviewButton.addEventListener('click', (e) => {
    opener = e.currentTarget;
    render(getRun());
    openModal(MODAL, '.lrv-fix, #locatorReviewClose');
  });
}
