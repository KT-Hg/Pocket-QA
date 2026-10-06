/**
 * help/help-modals.js — the Condition guide and the per-card ? guides, in both
 * languages (content in condition-help-data.js and card-help-data.js).
 */

import { attachModalKeyHandlers, closeModal, openModal } from '../ui/modal.js';
import { CARD_HELP_DATA } from './card-help-data.js';
import { COND_DATA } from './condition-help-data.js';

/* === CONDITION HELP MODAL === */
let _condLang = 'en';

function buildConditionHelpHTML(lang) {
  return COND_DATA.map(item => {
    const examplesHtml = item.examples.map(ex => {
      let rows = `<span class="ex-label">${ex.label[lang]}</span>`;
      if (ex.selector) rows += `\n            <span class="ex-key">Selector:</span> <span class="ex-val">${ex.selector}</span><br>`;
      if (ex.expected) rows += `\n            <span class="ex-key">Expected:</span> <span class="ex-val">${ex.expected}</span><br>`;
      rows += `\n            <span class="ex-note">${ex.note[lang]}</span>`;
      return rows;
    }).join('<br><br>\n            ');

    return `<div class="ch-item">
          <div class="ch-name">
            <span class="ch-badge ${item.badge}">${item.badgeLabel[lang]}</span>
            <span class="ch-title">${item.title[lang]}</span>
          </div>
          <p class="ch-desc">${item.desc[lang]}</p>
          <div class="ch-fields">
            <span class="ch-field${item.selectorReq ? ' required' : ''}">${item.selectorLabel[lang]}</span>
            <span class="ch-field${item.valueReq ? ' required' : ''}">${item.valueLabel[lang]}</span>
          </div>
          <div class="ch-example">
            ${examplesHtml}
          </div>
        </div>`;
  }).join('\n\n        ');
}

function applyCondLang(lang) {
  _condLang = lang;
  const isVi = lang === 'vi';
  document.getElementById('condHelpTitle').textContent = isVi ? 'Hướng dẫn Condition (If)' : 'Condition (If) Guide';
  document.getElementById('conditionHelpClose').textContent = isVi ? '✕ Đóng' : '✕ Close';
  document.getElementById('condLangToggle').textContent = isVi ? 'EN' : 'VI';
  document.getElementById('conditionHelpBody').innerHTML = buildConditionHelpHTML(lang);
  chrome.storage.local.set({ condHelpLang: lang });
}

let _condHelpOpener = null;

/* === CARD HELP MODALS === */
let _cardHelpLang = 'en';

let _cardHelpKey = null;

function _renderCardHelp() {
  const data = CARD_HELP_DATA[_cardHelpKey];
  if (!data) return;
  const isVi = _cardHelpLang === 'vi';
  document.getElementById('cardHelpTitle').textContent = data.title[_cardHelpLang];
  document.getElementById('cardHelpLangToggle').textContent = isVi ? 'EN' : 'VI';
  document.getElementById('cardHelpClose').textContent = isVi ? '✕ Đóng' : '✕ Close';
  document.getElementById('cardHelpBody').innerHTML = data[_cardHelpLang];
}

const CARD_HELP_LABELS = {
  recording: 'Open Recording guide',
  addManual: 'Open Manual Action guide',
  save: 'Open Save Scenario guide',
  manage: 'Open Manage Scenarios guide',
  folders: 'Open Manage Folders guide',
  importExport: 'Open Import / Export guide',
  sequence: 'Open Sequence Scenarios guide',
  schedule: 'Open Scheduled Playback guide',
  csv: 'Open CSV Data-Driven Run guide',
  variables: 'Open Variables guide',
  exportCode: 'Open Export Code guide',
  sqlcases: 'Open SQL Test Case Designer guide',
  dbtools: 'Open DB Test Session guide',
  capture: 'Open Capture guide',
  highlight: 'Open Highlight guide',
  hotkeys: 'Open Hotkeys guide',
  screenshot: 'Open Screenshot settings guide',
  notifications: 'Open Notifications guide',
  backup: 'Open Backup / Restore guide',
};

let _cardHelpOpener = null;

function openCardHelp(cardKey) {
  const data = CARD_HELP_DATA[cardKey];
  if (!data) return;
  _cardHelpKey = cardKey;
  chrome.storage.local.get('cardHelpLang', ({ cardHelpLang }) => {
    _cardHelpLang = cardHelpLang || 'en';
    _renderCardHelp();
  });
  openModal('cardHelpModal', '#cardHelpClose');
}

export function initHelpModals() {
  document.getElementById("conditionHelpBtn")?.addEventListener("click", (e) => {
    _condHelpOpener = e.currentTarget;
    chrome.storage.local.get('condHelpLang', ({ condHelpLang }) => {
      applyCondLang(condHelpLang || 'en');
    });
    openModal("conditionHelpModal", "#conditionHelpClose");
  });
  attachModalKeyHandlers("conditionHelpModal", () => closeModal("conditionHelpModal", _condHelpOpener));
  document.getElementById("condLangToggle")?.addEventListener("click", () => {
    applyCondLang(_condLang === 'vi' ? 'en' : 'vi');
  });
  document.getElementById("conditionHelpClose")?.addEventListener("click", () => {
    closeModal("conditionHelpModal", _condHelpOpener);
  });
  document.getElementById("conditionHelpModal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) { closeModal("conditionHelpModal", _condHelpOpener); }
  });
  document.querySelectorAll('.card-help-btn').forEach(btn => {
    const cardKey = btn.dataset.card;
    btn.setAttribute('aria-label', CARD_HELP_LABELS[cardKey] || `Open ${cardKey} help`);
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _cardHelpOpener = btn;
      openCardHelp(cardKey);
    });
  });
  attachModalKeyHandlers('cardHelpModal', () => closeModal('cardHelpModal', _cardHelpOpener));
  document.getElementById('cardHelpLangToggle')?.addEventListener('click', () => {
    _cardHelpLang = _cardHelpLang === 'vi' ? 'en' : 'vi';
    chrome.storage.local.set({ cardHelpLang: _cardHelpLang });
    _renderCardHelp();
  });
  document.getElementById('cardHelpClose')?.addEventListener('click', () => {
    closeModal('cardHelpModal', _cardHelpOpener);
  });
  document.getElementById('cardHelpModal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) { closeModal('cardHelpModal', _cardHelpOpener); }
  });
}
