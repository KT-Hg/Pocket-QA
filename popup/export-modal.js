/**
 * export-modal.js — the one modal every code export opens (JS bookmarklet,
 * Python Selenium, …): the code preview and its warnings, the variables and
 * actions it reviews, the tabs, Copy, Download, Regenerate, and focus.
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

/**
 * The file name a scenario's code is saved as, before the suffix: its name with
 * what a file name cannot hold replaced and spaces as underscores. Letters
 * outside a–z stay — keeping only [a-z0-9] turned "Đăng nhập" into "__ng_nh_p".
 */
const exportFileBase = (scenarioName) => safeFileName(scenarioName).replace(/\s+/g, '_').toLowerCase();

// How long the Copy button says "Copied".
const COPIED_LABEL_MS = 1500;

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
 * @param {string}   cfg.format        - its Settings block ([data-format]) and strip / chip style ('js', 'py')
 * @param {string}   cfg.badge         - the chip's text ('JS', 'PY')
 * @param {string}   cfg.title         - header, followed by " — <scenario>"
 * @param {string}   cfg.downloadLabel - the Download button's text ('⬇ .js')
 * @param {Function} cfg.fileName      - (base, options) → the file name, from the scenario's safe name
 *                                       and the options the code was made with
 * @param {Function} cfg.readOptions   - () → the generator's options, read from its Settings block
 * @param {Function} cfg.generate      - (scenarioName, actions, variables, options) → { code, stats, steps, warnings }
 * @param {Function} cfg.copyText      - (code) → what Copy puts on the clipboard
 * @param {Function} cfg.file          - (code) → { text, type } that Download saves
 * @param {Function} [cfg.beforeOpen]  - run first each time the modal opens for it
 * @param {Function} [cfg.wire]        - wires its own extra controls
 */
export function initExportModal(cfg) {
  if (!modalWired) modalWired = wireModal();
  document.getElementById(cfg.triggerId)?.addEventListener('click', () => {
    run.cfg = cfg;
    showFormat(cfg);
    load(open);
  });
  cfg.wire?.();
}

// The parts that are the format's own: the strip, the chip, its Settings block, Download.
function showFormat(cfg) {
  byId('Modal').dataset.format = cfg.format;
  byId('Accent').className = `export-bm-accent-bar export-bm-accent-${cfg.format}`;
  const badge = byId('Badge');
  badge.className = `export-bm-lang-badge export-bm-lang-badge-${cfg.format}`;
  badge.textContent = cfg.badge;
  byId('Download').textContent = cfg.downloadLabel;
  for (const block of byId('TabSettings').querySelectorAll('[data-format]')) block.hidden = block.dataset.format !== cfg.format;
}

const fileName = () => run.cfg.fileName(exportFileBase(run.scenarioName), run.options);

// The code for what `run` holds, with the options the Settings tab has now.
function generate() {
  run.options = run.cfg.readOptions();
  return run.cfg.generate(run.scenarioName, run.actions, run.variables, run.options);
}

function close() {
  const modal = byId('Modal');
  modal?.classList.remove('show');
  modal?.setAttribute('aria-hidden', 'true');
  if (run.releaseFocus) { run.releaseFocus(); run.releaseFocus = null; }
  unlockScroll();
}

function switchTab(tab) {
  byId('Modal').querySelectorAll('.export-bm-tab').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  byId('TabPreview').hidden   = tab !== 'preview';
  byId('TabVariables').hidden = tab !== 'variables';
  byId('TabActions').hidden   = tab !== 'actions';
  byId('TabSettings').hidden  = tab !== 'settings';
}

function render(result) {
  const filename = fileName();

  // Header
  byId('Title').textContent = `${run.cfg.title} — ${run.scenarioName}`;
  byId('Sub').textContent = `${filename} · ${result.stats.supported} steps`;
  byId('CodeLabel').textContent = filename;

  // Code preview
  const codeEl = byId('Code')?.querySelector('code');
  if (codeEl) codeEl.textContent = result.code;

  // Warning bar — steps not exported as is, plus anything the generator could
  // not express faithfully (renamed identifiers, unresolved ${...}, script
  // placeholders). These used to surface only when the exported code was run.
  const warning = byId('Warning');
  const skipMsg = byId('SkipMsg');
  const msgs = [...stepNotices(result.steps), ...(result.warnings || [])];
  if (msgs.length) {
    skipMsg.style.whiteSpace = 'pre-line';
    skipMsg.textContent = msgs.join('\n');
    warning.style.display = '';
  } else {
    warning.style.display = 'none';
  }

  // Variables — row layout
  const vars = Object.entries(run.variables || {});
  byId('VarCount').textContent = vars.length;
  renderVariables(byId('NoVars'), byId('VarList'), vars);

  // Actions review tab
  const actStats = renderActionsTab(PREFIX, run.actions, result.steps);

  // Stats pills
  const { supported, skipped } = result.stats;
  byId('StatSteps').textContent = `${supported} steps`;
  byId('StatVars').textContent  = `${vars.length} variables`;

  const warnPill    = byId('StatWarnPill');
  const skippedPill = byId('StatSkippedPill');
  if (actStats.warnCount > 0) {
    byId('StatWarn').textContent = `${actStats.warnCount} verify`;
    warnPill.style.display = '';
  } else {
    warnPill.style.display = 'none';
  }
  if (skipped > 0) {
    byId('StatSkipped').textContent = `${skipped} skipped`;
    skippedPill.style.display = '';
  } else {
    skippedPill.style.display = 'none';
  }
}

function open() {
  const modal = byId('Modal');
  if (!modal) return;
  run.cfg.beforeOpen?.();
  const result = generate();
  run.code = result.code;
  render(result);
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  lockScroll();
  switchTab('preview');
  run.releaseFocus = trapFocus(modal);
}

/**
 * Read the scenario chosen in the card and the variables it uses into `run`,
 * then call `done`. Opening the modal and Regenerate both come through here:
 * Regenerate of the Python export reused what was read on opening (a step
 * added since never showed), the JS one passed every variable there is.
 */
function load(done) {
  const sel = document.getElementById('exportCodeSelect');
  const scenarioId = sel?.value;
  if (!scenarioId) { showToast('Please select a scenario first', 'error'); return; }

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

function regenerate() {
  load(() => {
    const result = generate();
    run.code = result.code;
    render(result);
    switchTab('preview');
    showToast('Code regenerated');
  });
}

/** Wire what every format shares; false when the page has no export modal. */
function wireModal() {
  const modal = byId('Modal');
  if (!modal) return false;
  byId('Close')?.addEventListener('click', close);
  byId('Cancel')?.addEventListener('click', close);
  byId('Copy')?.addEventListener('click', copy);
  byId('Download')?.addEventListener('click', download);
  byId('Regenerate')?.addEventListener('click', regenerate);

  byId('WrapBtn')?.addEventListener('click', () => {
    const code = byId('Code');
    if (code) code.style.whiteSpace = code.style.whiteSpace === 'pre-wrap' ? 'pre' : 'pre-wrap';
  });

  byId('SelectAllBtn')?.addEventListener('click', () => {
    const code = byId('Code')?.querySelector('code');
    if (!code) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });

  modal.querySelectorAll('.export-bm-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  return true;
}

/** Warning-bar lines for the steps not exported as is: one per reason, with its step numbers. */
function stepNotices(steps) {
  const byReason = new Map();
  for (const s of steps) {
    if (s.status === 'ok') continue;
    const key = `${s.status === 'skip' ? 'Skipped' : 'Check'} — ${s.reason}`;
    if (!byReason.has(key)) byReason.set(key, []);
    byReason.get(key).push(s.n);
  }
  return [...byReason].map(([key, ns]) => `${key}: step${ns.length > 1 ? 's' : ''} ${ns.join(', ')}`);
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

const ACT_TYPE_INFO = {
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
};

function actionDesc(a) {
  const sel = (a.selectors?.css
    || (a.selectors?.id ? '#' + a.selectors.id : '')
    || a.selector
    || '').slice(0, 40);
  switch (a.type) {
    case 'navigate':  return (a.value || a.url || '').slice(0, 50);
    case 'wait':      return `${a.delay ?? a.value ?? 1000} ms`;
    case 'script':    return 'custom JS code';
    case 'condition': return a.conditionType || 'condition';
    case 'switch':    return isAlwaysSwitch(a)
      ? `always → ${a.cases[0].scenarioName || a.cases[0].scenarioId}`.slice(0, 40)
      : `→ ${(a.scenario || a.value || '')}`.slice(0, 40);
    case 'readdom':   return a.pattern
      ? `${sel} → ${String(a.pattern).trim()}`
      : `${sel} → \${${normalizeVarName(a.varName) || 'var'}}`;
    case 'screenshot':
    case 'screenshot_full':    return 'viewport';
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

// One row per step the generator reported, numbered as in the scenario and the code's comments.
function renderActionsTab(prefix, actions, steps) {
  const listEl    = document.getElementById(`${prefix}ActList`);
  const summaryEl = document.getElementById(`${prefix}ActSummary`);
  if (!listEl || !summaryEl) return { okCount: 0, warnCount: 0, skipCount: 0 };

  let html = '';
  for (const s of steps) {
    const a = actions?.[s.n - 1] || {};
    // The fallback label is a.type straight out of an imported .json, so both it
    // and the class name are escaped at the interpolation site below.
    const info = ACT_TYPE_INFO[a.type] || { icon: '●', label: String(a.type ?? 'unknown'), cls: 'wait' };
    const view = STEP_STATUS_VIEW[s.status];
    html += `<div class="export-bm-action-row ${view.rowCls}">
      <span class="export-bm-action-step">${s.n}</span>
      <span class="export-bm-action-type abt-${escHtml(info.cls)}">${info.icon} ${escHtml(info.label)}</span>
      <span class="export-bm-action-desc">${escHtml(actionDesc(a))}</span>
      <span class="export-bm-action-status ast-${view.cls}" title="${escHtml(s.reason)}">${view.label}</span>
    </div>`;
  }
  const okCount   = steps.filter(s => s.status === 'ok').length;
  const warnCount = steps.filter(s => s.status === 'verify').length;
  const skipCount = steps.filter(s => s.status === 'skip').length;
  listEl.innerHTML = html;

  let sumHtml = '<span class="export-bm-act-sum-label">Will export:</span>';
  sumHtml += `<span class="export-bm-act-sum-pill act-sum-ok">✓ ${okCount} OK</span>`;
  if (warnCount) sumHtml += `<span class="export-bm-act-sum-pill act-sum-warn">⚠ ${warnCount} needs review</span>`;
  if (skipCount) sumHtml += `<span class="export-bm-act-sum-pill act-sum-skip">— ${skipCount} skipped</span>`;
  summaryEl.innerHTML = sumHtml;

  const badge = document.getElementById(`${prefix}ActCount`);
  if (badge) {
    const warnTotal = skipCount + warnCount;
    badge.textContent = warnTotal > 0 ? `${warnTotal} ⚠` : String(steps.length);
    badge.className   = 'export-bm-tab-count' + (warnTotal > 0 ? ' warn' : '');
  }

  return { okCount, warnCount, skipCount };
}
