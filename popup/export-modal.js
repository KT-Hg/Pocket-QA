/**
 * export-modal.js — the one modal every code export opens (JS bookmarklet,
 * Python Selenium, …): the code preview and its warnings, the variables and
 * actions it reviews, the tabs, Copy, Download, Reload scenario, and focus.
 * The code follows the Settings tab: it is generated again whenever one changes.
 *
 * Each export registers what is its own with initExportModal(cfg): the button
 * that opens it, its strip, chip and title, how its code is generated, copied
 * and saved, and its block of the Settings tab ([data-format]). What became of
 * each action comes from the generator itself (popup/export/steps.js).
 */

import { showToast, lockScroll, unlockScroll, escHtml, getUsedVarNames } from './utils.js';
import { trapFocus } from './ui/focus.js';
import { isAlwaysSwitch } from '../shared/switch-blocks.js';
import { normalizeVarName } from '../shared/var-name.js';
import { activeValue, parseRandomSpec, parsePickSpec, previewRandom } from '../shared/var-spec.js';
import { downloadBlob, safeFileName } from './lib/download.js';
import { highlightLines } from './export/highlight.js';

/**
 * The file name a scenario's code is saved as, before the suffix: its name with
 * what a file name cannot hold replaced and spaces as underscores. Letters
 * outside a–z stay — keeping only [a-z0-9] turned "Đăng nhập" into "__ng_nh_p".
 */
const exportFileBase = (scenarioName) => safeFileName(scenarioName).replace(/\s+/g, '_').toLowerCase();

// How long the Copy button says "Copied".
const COPIED_LABEL_MS = 1500;
// How long typing in a Settings field has to pause before the code follows it.
const TYPING_SETTLE_MS = 300;
// How long the lines of a step shown from the Actions tab stay tinted.
const STEP_FLASH_MS = 1500;
// Room left above a step's first line once it is scrolled to.
const STEP_SCROLL_MARGIN_PX = 8;
// The comment every export opens a step with: "# Step 7: …", "// Step 7: …".
const STEP_LINE = /^\s*(?:#|\/\/) Step (\d+)\b/;

// The modal's elements are #export<Suffix>.
const PREFIX = 'export';
const byId = (suffix) => document.getElementById(PREFIX + suffix);

// What the modal shows: the format that opened it (its cfg), the scenario, the code.
const run = { cfg: null, code: '', scenarioName: '', actions: [], variables: {}, options: {}, releaseFocus: null };
let modalWired = false;

/**
 * Register one export with the modal.
 *
 * @param {object}   cfg
 * @param {string}   cfg.triggerId     - the button that opens the modal for it
 * @param {string}   cfg.format        - its Settings block ([data-format]) and strip / chip style ('js', 'py', 'pw', 'rf')
 * @param {string}   cfg.badge         - the chip's text ('JS', 'PY', 'PW', 'RF')
 * @param {string}   cfg.title         - header, followed by " — <scenario>"
 * @param {Function} cfg.fileName      - (base, options) → the file name, from the scenario's safe name
 *                                       and the options the code was made with
 * @param {Function} cfg.readOptions   - () → the generator's options, read from its Settings block
 * @param {Function} cfg.generate      - (scenarioName, actions, variables, options) → { code, stats, steps, warnings }
 * @param {Function} cfg.copyText      - (code) → what Copy puts on the clipboard
 * @param {Function} cfg.file          - (code) → { text, type } that Download saves
 * @param {string[]} [cfg.remember]    - ids of its Settings inputs kept between popups, in the
 *                                       order they are put back
 * @param {object}   [cfg.startUrl]    - its Starting URL setting: { field, button, badge } ids — filled
 *                                       from the tab on opening when empty, again by the button
 * @param {Function} [cfg.wire]        - wires its own extra controls
 */
export function initExportModal(cfg) {
  if (!modalWired) modalWired = wireModal();
  document.getElementById(cfg.triggerId)?.addEventListener('click', () => {
    run.cfg = cfg;
    showFormat(cfg);
    restoreSettings(cfg, () => load(open));
  });
  rememberSettings(cfg);
  if (cfg.startUrl) document.getElementById(cfg.startUrl.button)?.addEventListener('click', () => fillCurrentUrl(cfg.startUrl));
  cfg.wire?.();
}

// The URL of the page the popup is over, or '' for a browser or extension page.
function withTabUrl(use) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs?.[0]?.url || '';
    use(url && !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') ? url : '');
  });
}

// Auto-fill Starting URL from current tab (if input is still empty), then `done`.
function autoFillStartUrl({ field, badge }, done) {
  const urlInput = document.getElementById(field);
  if (!urlInput || urlInput.value.trim()) { done(); return; }
  withTabUrl((url) => {
    if (url) {
      urlInput.value = url;
      urlInput.dispatchEvent(new Event('input'));
      const badgeEl = document.getElementById(badge);
      if (badgeEl) badgeEl.style.display = '';
    }
    done();
  });
}

function fillCurrentUrl({ field, badge }) {
  withTabUrl((url) => {
    if (!url) {
      showToast('Could not get URL from this tab', 'error');
      return;
    }
    const input = document.getElementById(field);
    if (input) {
      input.value = url;
      // Bubbling, as a change made by hand: the modal generates the code again.
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const badgeEl = document.getElementById(badge);
      if (badgeEl) badgeEl.style.display = '';
    }
  });
}

// Where each format's Settings are kept between popups: { [format]: { [inputId]: value } }.
// Only this modal reads it.
const SETTINGS_KEY = 'exportCodeSettings';
// True while restoreSettings puts values back: their change events are not new settings.
let restoring = false;
// SETTINGS_KEY as last read or written in this popup.
let settingsCache = null;

const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);

const settingValue = (el) => (el.type === 'checkbox' ? el.checked : el.value);

// Whether a stored value is one `el` can take: storage may be edited, an option dropped.
function settingFits(el, value) {
  if (el.type === 'checkbox') return typeof value === 'boolean';
  if (el.tagName === 'SELECT') return [...el.options].some((o) => o.value === value);
  return el.type === 'number' && typeof value === 'string' && /^\d+$/.test(value);
}

/**
 * Put back what was last set in `cfg`'s remembered Settings inputs (cfg.remember,
 * in order), then call `done`. A value an input cannot take is left out, and so is
 * an input an earlier one disabled (Headless, once Safari is back): it keeps its
 * default. Each one put back fires its change event, as if chosen.
 */
function restoreSettings(cfg, done) {
  if (!cfg.remember?.length) { done(); return; }
  chrome.storage.local.get(SETTINGS_KEY, (res) => {
    settingsCache = isMap(res?.[SETTINGS_KEY]) ? res[SETTINGS_KEY] : {};
    setWrap(settingsCache.wrap === true);
    const saved = settingsCache[cfg.format];
    restoring = true;
    try {
      for (const id of cfg.remember) {
        const el = document.getElementById(id);
        if (!el || el.disabled || !isMap(saved) || !settingFits(el, saved[id])) continue;
        if (el.type === 'checkbox') el.checked = saved[id]; else el.value = saved[id];
        el.dispatchEvent(new Event('change'));
      }
    } finally {
      restoring = false;
    }
    done();
  });
}

/**
 * Keep each of `cfg`'s remembered Settings inputs when it changes, apart from
 * the other formats'. Written straight from settingsCache, which restoreSettings
 * read before the modal opened: a read before each write let two changes in a
 * row write each other away, and one made just before the popup closed be lost.
 */
function rememberSettings(cfg) {
  for (const id of cfg.remember || []) {
    document.getElementById(id)?.addEventListener('change', (e) => {
      if (restoring) return;
      const all  = settingsCache || {};
      const mine = isMap(all[cfg.format]) ? all[cfg.format] : {};
      settingsCache = { ...all, [cfg.format]: { ...mine, [id]: settingValue(e.target) } };
      chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache });
    });
  }
}

// Wrap of the code, on or off; kept with the Settings, for every format.
function setWrap(on) {
  byId('Code')?.classList.toggle('export-bm-code-wrap', on);
  byId('WrapBtn')?.setAttribute('aria-pressed', String(on));
}

function toggleWrap() {
  const on = byId('WrapBtn')?.getAttribute('aria-pressed') !== 'true';
  setWrap(on);
  settingsCache = { ...(settingsCache || {}), wrap: on };
  chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache });
}

// The parts that are the format's own: the strip, the chip, its Settings block.
function showFormat(cfg) {
  byId('Modal').dataset.format = cfg.format;
  byId('Accent').className = `export-bm-accent-bar export-bm-accent-${cfg.format}`;
  const badge = byId('Badge');
  badge.className = `export-bm-lang-badge export-bm-lang-badge-${cfg.format}`;
  badge.textContent = cfg.badge;
  for (const block of byId('TabSettings').querySelectorAll('[data-format]')) block.hidden = block.dataset.format !== cfg.format;
}

const fileName = () => run.cfg.fileName(exportFileBase(run.scenarioName), run.options);

// Generate the code for what `run` holds, with the options the Settings tab has
// now, and show it: Copy and Download take what is shown.
function generate() {
  run.options = run.cfg.readOptions();
  const result = run.cfg.generate(run.scenarioName, run.actions, run.variables, run.options);
  run.code = result.code;
  render(result);
}

function close() {
  const modal = byId('Modal');
  modal?.classList.remove('show');
  modal?.setAttribute('aria-hidden', 'true');
  if (run.releaseFocus) { run.releaseFocus(); run.releaseFocus = null; }
  unlockScroll();
}

// The open tab alone takes Tab focus (roving tabindex); the arrow keys reach the others.
function switchTab(tab) {
  byId('Modal').querySelectorAll('.export-bm-tab').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
  });
  byId('TabPreview').hidden   = tab !== 'preview';
  byId('TabVariables').hidden = tab !== 'variables';
  byId('TabActions').hidden   = tab !== 'actions';
  byId('TabSettings').hidden  = tab !== 'settings';
}

function render(result) {
  const filename = fileName();

  // Header: every step the export looked at, as many as the Actions tab lists.
  const skipped = result.steps.filter((s) => s.status === 'skip').length;
  byId('Title').textContent = `${run.cfg.title} — ${run.scenarioName}`;
  byId('Sub').textContent = `${filename} · ${result.steps.length} steps${skipped ? ` · ${skipped} skipped` : ''}`;
  byId('CodeLabel').textContent = filename;

  // Code preview
  const codeEl = byId('Code')?.querySelector('code');
  if (codeEl) renderCode(codeEl, result.code, { py: 'py', rf: 'robot' }[run.cfg.format] || 'js');

  // Warning bar (Code tab): one line counting the steps not exported as is and
  // what the generator could not express faithfully (renamed identifiers,
  // unresolved ${...}); the Actions tab lists them. These used to surface only
  // when the exported code was run.
  const toCheck = result.steps.filter((s) => s.status === 'verify').length;
  const notes = result.warnings?.length || 0;
  const counts = [
    toCheck && `${toCheck} to check`,
    skipped && `${skipped} skipped`,
    notes && `${notes} note${notes > 1 ? 's' : ''}`,
  ].filter(Boolean);
  byId('Warning').hidden = !counts.length;
  byId('WarningText').textContent = `${counts.join(' · ')} — see Actions`;

  // Variables — row layout
  const vars = Object.entries(run.variables || {});
  byId('VarCount').textContent = vars.length;
  renderVariables(byId('NoVars'), byId('VarList'), vars);

  // Actions review tab
  renderActionsTab(PREFIX, run.actions, result.steps);
  renderNotices(byId('ActSummary'), result.steps, result.warnings || []);
}

function open() {
  const modal = byId('Modal');
  if (!modal) return;
  const show = () => {
    generate();
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    lockScroll();
    switchTab('preview');
    run.releaseFocus = trapFocus(modal);
    // Focus on the open tab, not on ✕: Enter there would close what was just opened.
    modal.querySelector('.export-bm-tab.active')?.focus();
  };
  // The start URL may come from the tab first: generated at once, the code read the
  // field before the URL had come.
  if (run.cfg.startUrl) autoFillStartUrl(run.cfg.startUrl, show); else show();
}

/**
 * Read the scenario chosen in the card and the variables it uses into `run`,
 * then call `done`. Opening the modal and Reload scenario both come through here:
 * a reload of the Python export once reused what was read on opening (a step
 * added since never showed), the JS one passed every variable there is.
 */
function load(done) {
  const sel = document.getElementById('exportCodeSelect');
  const scenarioId = sel?.value;
  // The card's buttons are off until a scenario is chosen (export/code-card.js).
  if (!scenarioId) return;

  run.scenarioName = sel.options[sel.selectedIndex]?.text || 'Scenario';

  chrome.runtime.sendMessage({ type: 'GET_SCENARIOS' }, res => {
    const scenario = (res?.scenarios || {})[scenarioId];
    run.actions = scenario?.actions || [];
    chrome.runtime.sendMessage({ type: 'GET_VARIABLES' }, varRes => {
      const allVariables = varRes?.variables || {};
      const usedNames = getUsedVarNames(run.actions);
      run.variables = Object.fromEntries(
        Object.entries(allVariables).filter(([k]) => usedNames.has(k))
      );
      done();
    });
  });
}

async function copy() {
  if (!run.code) return;
  try {
    await navigator.clipboard.writeText(run.cfg.copyText(run.code));
    const btn = byId('Copy');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, COPIED_LABEL_MS);
    }
  } catch {
    showToast('Clipboard not available', 'error');
  }
}

function download() {
  if (!run.code) return;
  const { text, type } = run.cfg.file(run.code);
  // Through downloadBlob, which revokes the URL a moment later: revoked right
  // after click() it can go before the browser has read the file.
  downloadBlob(new Blob([text], { type }), fileName());
}

/**
 * The code into `codeEl`, coloured as `lang` ('py', 'robot' or 'js'): a span per line,
 * the line breaks between them as text, so its text is the code as is (Select
 * all, the checks that read it). A line that opens a step carries its number
 * (data-step). Built from text nodes, never parsed as HTML: the code holds the
 * scenario's values, and a value may be markup.
 */
function renderCode(codeEl, code, lang) {
  const lines = document.createDocumentFragment();
  const texts = code.split('\n');
  highlightLines(code, lang).forEach((pieces, i) => {
    if (i) lines.append('\n');
    const line = document.createElement('span');
    line.className = 'export-bm-line';
    const step = STEP_LINE.exec(texts[i]);
    if (step) line.dataset.step = step[1];
    for (const [text, kind] of pieces) {
      line.append(kind ? Object.assign(document.createElement('span'), { className: `tok-${kind}`, textContent: text }) : text);
    }
    lines.append(line);
  });
  codeEl.replaceChildren(lines);
}

let flashTimer = null;

/**
 * Show step `n` in the Code tab: its first line near the top of the code, its
 * lines (to the next step or blank line) tinted a moment. A step in a skipped
 * Switch block has no comment of its own: the block's is shown. `focusCode`:
 * keyboard focus goes on to the code (the row it was on is hidden now).
 */
function showStep(n, focusCode = false) {
  const pre = byId('Code');
  const lines = [...pre.querySelectorAll('.export-bm-line')];
  const starts = lines.filter((l) => l.dataset.step && Number(l.dataset.step) <= n);
  const start = starts.find((l) => Number(l.dataset.step) === n) || starts.at(-1);
  if (!start) return;
  switchTab('preview');
  const from = lines.indexOf(start);
  const end = lines.findIndex((l, i) => i > from && (l.dataset.step || !l.textContent.trim()));
  clearTimeout(flashTimer);
  pre.querySelectorAll('.export-bm-line-flash').forEach((l) => l.classList.remove('export-bm-line-flash'));
  for (const line of lines.slice(from, end < 0 ? lines.length : end)) line.classList.add('export-bm-line-flash');
  flashTimer = setTimeout(() => start.parentNode?.querySelectorAll('.export-bm-line-flash')
    .forEach((l) => l.classList.remove('export-bm-line-flash')), STEP_FLASH_MS);
  pre.scrollTop += start.getBoundingClientRect().top - pre.getBoundingClientRect().top - STEP_SCROLL_MARGIN_PX;
  if (focusCode) pre.focus({ preventScroll: true });
}

// The scenario as saved now, for one edited while the modal is open.
function reload() {
  load(() => {
    generate();
    switchTab('preview');
    showToast('Scenario reloaded');
  });
}

/**
 * Generate the code again whenever a Settings input changes: a choice at once,
 * typing once it pauses. Not for the values restoreSettings puts back, nor for
 * what a format fills in before the modal opens: opening generates once.
 */
function followSettings(modal) {
  const settings = byId('TabSettings');
  let typing = null;
  const isOpen = () => modal.classList.contains('show');
  const follow = () => {
    clearTimeout(typing);
    if (!restoring && isOpen()) generate();
  };
  settings?.addEventListener('change', follow);
  settings?.addEventListener('input', (e) => {
    // A select and a switch say it with their change event.
    if (e.target.matches('select, [type="checkbox"]') || !isOpen()) return;
    clearTimeout(typing);
    typing = setTimeout(follow, TYPING_SETTLE_MS);
  });
}

/** Wire what every format shares; false when the page has no export modal. */
function wireModal() {
  const modal = byId('Modal');
  if (!modal) return false;
  byId('Close')?.addEventListener('click', close);
  byId('Copy')?.addEventListener('click', copy);
  byId('Download')?.addEventListener('click', download);
  byId('Reload')?.addEventListener('click', reload);
  byId('Warning')?.addEventListener('click', () => switchTab('actions'));
  byId('ActList')?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-step]');
    // Only a row reached by keyboard hands its focus on: a mouse user gets no ring on the code.
    if (row) showStep(Number(row.dataset.step), row.matches(':focus-visible'));
  });
  byId('StepsBtn')?.addEventListener('click', () => {
    const first = byId('Code')?.querySelector('[data-step]');
    if (first) showStep(Number(first.dataset.step));
  });
  followSettings(modal);

  byId('WrapBtn')?.addEventListener('click', toggleWrap);

  byId('SelectAllBtn')?.addEventListener('click', () => {
    const code = byId('Code')?.querySelector('code');
    if (!code) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });

  const tabs = [...modal.querySelectorAll('.export-bm-tab')];
  tabs.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  // ← → (round), Home, End: the tab there opens and takes the focus.
  modal.querySelector('[role="tablist"]')?.addEventListener('keydown', (e) => {
    const at = tabs.indexOf(document.activeElement);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (at < 0 || to === undefined) return;
    e.preventDefault();
    const tab = tabs[(to + tabs.length) % tabs.length];
    switchTab(tab.dataset.tab);
    tab.focus();
  });

  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  return true;
}

/**
 * What the export did not take as is, for the top of the Actions tab: the steps
 * to check and the skipped ones, one line per reason led by its steps ("Step 8 —
 * custom JS … — check it"), then the generator's notes. [title, lines] each,
 * the empty ones left out.
 */
export function stepNotices(steps, warnings = []) {
  const byStatus = { verify: new Map(), skip: new Map() };
  for (const s of steps) {
    const byReason = byStatus[s.status];
    if (!byReason) continue;
    if (!byReason.has(s.reason)) byReason.set(s.reason, []);
    byReason.get(s.reason).push(s.n);
  }
  const lines = (byReason) => [...byReason].map(([reason, ns]) => `Step${ns.length > 1 ? 's' : ''} ${ns.join(', ')} — ${reason}`);
  return [
    ['To check', lines(byStatus.verify)],
    ['Skipped', lines(byStatus.skip)],
    ['Notes', warnings],
  ].filter(([, items]) => items.length);
}

// stepNotices into `el`, as text: a note may hold a variable name from the scenario.
function renderNotices(el, steps, warnings) {
  const groups = stepNotices(steps, warnings);
  if (!groups.length) { el.textContent = '✓ Every step is exported as recorded'; return; }
  el.replaceChildren(...groups.map(([title, items]) => {
    const group = document.createElement('div');
    group.className = 'export-bm-notice-group';
    const head = document.createElement('div');
    head.className = 'export-bm-notice-title';
    head.textContent = title;
    const list = document.createElement('ul');
    list.className = 'export-bm-notice-list';
    list.append(...items.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
    group.append(head, list);
    return group;
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// VARIABLES TAB
// ─────────────────────────────────────────────────────────────────────────────

function renderVariables(noVarsEl, listEl, vars) {
  if (vars.length === 0) {
    noVarsEl.style.display = '';
    listEl.innerHTML = '';
    return;
  }
  noVarsEl.style.display = 'none';
  listEl.innerHTML = '';
  for (const [key, rawVal] of vars) {
    const val     = activeValue(rawVal);
    const spec    = parseRandomSpec(val);
    const pick    = parsePickSpec(val);
    const isRand  = !!spec;
    const isPick  = !!pick;
    // Fallback specs match neither parser and used to be listed as "Static"
    // showing the raw {fallback:...} text, which reads like a broken value.
    const fbMatch = val.match(/^\{fallback:(.+)\}$/);
    let icon, badgeLabel, badgeCls, preview;
    if (isRand) {
      icon = '🎲'; badgeLabel = 'Random'; badgeCls = 'rand';
      preview = previewRandom(spec.type, spec.length);
    } else if (isPick) {
      icon = '⚄'; badgeLabel = `Pick (${pick.length})`; badgeCls = 'rand';
      preview = pick.map(v => (v === '' ? '∅ blank' : v)).join(' | ');
      if (preview.length > 40) preview = preview.slice(0, 40) + '…';
    } else if (fbMatch) {
      const fbVals = fbMatch[1].split('|').map(s => s.trim());
      icon = '⛓'; badgeLabel = `Fallback (${fbVals.length})`; badgeCls = 'rand';
      preview = fbVals.map(v => (v === '' ? '∅ blank' : v)).join(' → ');
      if (preview.length > 40) preview = preview.slice(0, 40) + '…';
    } else {
      icon = '🔤'; badgeLabel = 'Static'; badgeCls = 'static';
      preview = val.length > 40 ? val.slice(0, 40) + '…' : val;
    }
    const row = document.createElement('div');
    row.className = 'export-bm-var-row';
    row.innerHTML = `
        <div class="export-bm-var-icon ${badgeCls}">${icon}</div>
        <span class="export-bm-var-name">\${${escHtml(key)}}</span>
        <span class="export-bm-badge ${badgeCls}">${badgeLabel}</span>
        <span class="export-bm-preview">${escHtml(preview)}</span>`;
    listEl.appendChild(row);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIONS REVIEW TAB
// ─────────────────────────────────────────────────────────────────────────────

// The type badge of each action type the exports know (tests/export.test.mjs checks none is missing).
export const ACT_TYPE_INFO = {
  navigate:           { icon: '🌐', label: 'navigate',   cls: 'nav' },
  click:              { icon: '👆', label: 'click',      cls: 'click' },
  input:              { icon: '⌨',  label: 'input',      cls: 'input' },
  hover:              { icon: '🖱',  label: 'hover',      cls: 'hover' },
  dropdown:           { icon: '▼',  label: 'dropdown',   cls: 'click' },
  dragdrop:           { icon: '↔',  label: 'dragdrop',   cls: 'dragdrop' },
  wait:               { icon: '⏱',  label: 'wait',       cls: 'wait' },
  script:             { icon: '📜', label: 'script',     cls: 'script' },
  condition:          { icon: '🔀', label: 'condition',  cls: 'condition' },
  screenshot:         { icon: '📷', label: 'screenshot', cls: 'screenshot' },
  screenshot_full:    { icon: '📷', label: 'scr-full',   cls: 'screenshot' },
  screenshot_element: { icon: '📷', label: 'scr-elem',   cls: 'screenshot' },
  screenshot_tovar:   { icon: '📷', label: 'scr-var',    cls: 'screenshot' },
  readdom:            { icon: '📖', label: 'readdom',    cls: 'readdom' },
  switch:             { icon: '🔄', label: 'switch',     cls: 'wait' },
  uploadFile:         { icon: '📎', label: 'upload',     cls: 'upload' },
};

/** What a row of the Actions tab says an action does, after its label if it has one. */
export function actionDesc(a) {
  const sel = (a.selectors?.css
    || (a.selectors?.id ? '#' + a.selectors.id : '')
    || a.selector
    || '').slice(0, 40);
  switch (a.type) {
    case 'navigate':  return (a.value || a.url || '').slice(0, 50);
    case 'wait':      return `${a.delay ?? a.value ?? 1000} ms`;
    case 'script':    return 'custom JS code';
    case 'condition': {
      // A URL check has no element: what it compares the URL with instead.
      const what = String(a.conditionType || '').startsWith('url') ? String(a.expectedValue ?? '').slice(0, 40) : sel;
      return [a.conditionType || 'condition', what].filter(Boolean).join(' · ');
    }
    case 'switch':    return isAlwaysSwitch(a)
      ? `always → ${a.cases[0].scenarioName || a.cases[0].scenarioId}`.slice(0, 40)
      : `→ ${(a.scenario || a.value || '')}`.slice(0, 40);
    case 'readdom':   return a.pattern
      ? `${sel} → ${String(a.pattern).trim()}`
      : `${sel} → \${${normalizeVarName(a.varName) || 'var'}}`;
    case 'screenshot':         return 'viewport';
    case 'screenshot_full':    return 'full page';
    case 'screenshot_element': return sel || 'element';
    case 'dropdown':           return a.pick ? `${sel} → item #${a.pick.index ?? '?'}` : sel;
    case 'screenshot_tovar':   return `→ \${${normalizeVarName(a.varName) || 'screenshot'}}`;
    case 'input': {
      const v = a.value ? ` = "${String(a.value).slice(0, 15)}"` : '';
      return `${sel}${v}`;
    }
    default: return sel;
  }
}

// How each step status of export/steps.js shows in the Actions tab.
const STEP_STATUS_VIEW = {
  ok:     { cls: 'ok',   label: '✓ OK',     rowCls: '' },
  verify: { cls: 'warn', label: '⚠ Verify', rowCls: 'row-warn' },
  skip:   { cls: 'skip', label: '— Skip',   rowCls: 'row-skip' },
};

// One row per step the generator reported, numbered as in the scenario and the code's
// comments; a row is a button that shows its step in the code (showStep).
function renderActionsTab(prefix, actions, steps) {
  const listEl = document.getElementById(`${prefix}ActList`);
  if (!listEl) return;

  let html = '';
  for (const s of steps) {
    const a = actions?.[s.n - 1] || {};
    // The fallback label is a.type straight out of an imported .json, so both it
    // and the class name are escaped at the interpolation site below.
    const info = ACT_TYPE_INFO[a.type] || { icon: '●', label: String(a.type ?? 'unknown'), cls: 'wait' };
    const view = STEP_STATUS_VIEW[s.status];
    // A step named in the scenario reads by its name; what it acts on follows, dimmed.
    const desc = escHtml(actionDesc(a));
    const label = a.label ? String(a.label).trim() : '';
    html += `<button type="button" class="export-bm-action-row ${view.rowCls}" data-step="${s.n}" title="Show step ${s.n} in the code">
      <span class="export-bm-action-step">${s.n}</span>
      <span class="export-bm-action-type abt-${escHtml(info.cls)}">${info.icon} ${escHtml(info.label)}</span>
      <span class="export-bm-action-desc">${label
        ? `<span class="export-bm-action-label">${escHtml(label)}</span> <span class="export-bm-action-sel">${desc}</span>`
        : desc}</span>
      <span class="export-bm-action-status ast-${view.cls}" title="${escHtml(s.reason)}">${view.label}</span>
    </button>`;
  }
  const warnCount = steps.filter(s => s.status === 'verify').length;
  const skipCount = steps.filter(s => s.status === 'skip').length;
  listEl.innerHTML = html;

  const badge = document.getElementById(`${prefix}ActCount`);
  if (badge) {
    const warnTotal = skipCount + warnCount;
    badge.textContent = warnTotal > 0 ? `${warnTotal} ⚠` : String(steps.length);
    badge.className   = 'export-bm-tab-count' + (warnTotal > 0 ? ' warn' : '');
  }
}
