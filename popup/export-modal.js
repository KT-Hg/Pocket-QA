/**
 * export-modal.js — the modal both code exports open (JS bookmarklet, Python
 * Selenium): the code preview and its warnings, the variables and actions it
 * reviews, the tabs, Copy, Download, Regenerate, and focus.
 *
 * Each export passes what is its own (see initExportModal): its element ids,
 * how its code is generated, what it cannot export, and how the code is copied
 * and saved.
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

/**
 * Wire one export's modal.
 *
 * @param {object}   cfg
 * @param {string}   cfg.triggerId    - the button that opens it
 * @param {string}   cfg.prefix       - prefix of the modal's element ids ('exportBm', …)
 * @param {string}   cfg.tabClass     - class of its tab buttons
 * @param {string}   cfg.title        - header, followed by " — <scenario>"
 * @param {string}   cfg.fileSuffix   - after the scenario's safe name, e.g. '_selenium.py'
 * @param {Function} cfg.readOptions  - () → the generator's options, read from the Settings tab
 * @param {Function} cfg.generate     - (scenarioName, actions, variables, options) → { code, stats, warnings }
 * @param {boolean}  cfg.regenerateFromStorage - Regenerate reads the scenario and all
 *                                      variables again (else it reuses what was opened)
 * @param {Function} cfg.noticeLines  - (stats) → lines for the warning bar, before the generator's own
 * @param {Function} cfg.isSkipped    - (action) → true when the export leaves it out
 * @param {Function} cfg.copyText     - (code) → what Copy puts on the clipboard
 * @param {Function} cfg.file         - (code) → { text, type } that Download saves
 * @param {Function} [cfg.beforeOpen] - run first each time the modal opens
 * @param {Function} [cfg.wire]       - wires the export's own extra controls
 */
export function initExportModal(cfg) {
  const { prefix, tabClass } = cfg;
  const byId = (suffix) => document.getElementById(prefix + suffix);
  const run = { code: '', scenarioName: '', actions: [], variables: {}, releaseFocus: null };

  const close = () => {
    const modal = byId('Modal');
    modal?.classList.remove('show');
    modal?.setAttribute('aria-hidden', 'true');
    if (run.releaseFocus) { run.releaseFocus(); run.releaseFocus = null; }
    unlockScroll();
  };

  const switchTab = (tab) => {
    document.querySelectorAll(`.${tabClass}`).forEach(btn => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    byId('TabPreview').hidden   = tab !== 'preview';
    byId('TabVariables').hidden = tab !== 'variables';
    byId('TabActions').hidden   = tab !== 'actions';
    byId('TabSettings').hidden  = tab !== 'settings';
  };

  const render = (scenarioName, result, variables) => {
    const filename = `${exportFileBase(scenarioName)}${cfg.fileSuffix}`;

    // Header
    byId('Title').textContent = `${cfg.title} — ${scenarioName}`;
    byId('Sub').textContent = `${filename} · ${result.stats.supported} steps`;
    byId('CodeLabel').textContent = filename;

    // Code preview
    const codeEl = document.querySelector(`#${prefix}Code code`);
    if (codeEl) codeEl.textContent = result.code;

    // Warning bar — skipped steps plus anything the generator could not express
    // faithfully (renamed identifiers, unresolved ${...}, script placeholders).
    // These used to surface only when the exported code was run.
    const warning = byId('Warning');
    const skipMsg = byId('SkipMsg');
    const msgs = [...cfg.noticeLines(result.stats)];
    msgs.push(...(result.warnings || []));
    if (msgs.length) {
      skipMsg.style.whiteSpace = 'pre-line';
      skipMsg.textContent = msgs.join('\n');
      warning.style.display = '';
    } else {
      warning.style.display = 'none';
    }

    // Variables — row layout
    const vars = Object.entries(variables || {});
    byId('VarCount').textContent = vars.length;
    renderVariables(byId('NoVars'), byId('VarList'), vars);

    // Actions review tab
    const actStats = renderActionsTab(prefix, run.actions, cfg.isSkipped);

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
  };

  const open = (scenarioName, actions, variables) => {
    const modal = byId('Modal');
    if (!modal) return;
    cfg.beforeOpen?.();
    const result = cfg.generate(scenarioName, actions, variables, cfg.readOptions());
    run.code = result.code;
    render(scenarioName, result, variables);
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    lockScroll();
    switchTab('preview');
    run.releaseFocus = trapFocus(modal);
  };

  const onTrigger = () => {
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
        open(run.scenarioName, run.actions, run.variables);
      });
    });
  };

  const copy = async () => {
    if (!run.code) return;
    try {
      await navigator.clipboard.writeText(cfg.copyText(run.code));
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
  };

  const download = () => {
    if (!run.code) return;
    const { text, type } = cfg.file(run.code);
    // Through downloadBlob, which revokes the URL a moment later: revoked right
    // after click() it can go before the browser has read the file.
    downloadBlob(new Blob([text], { type }), `${exportFileBase(run.scenarioName)}${cfg.fileSuffix}`);
  };

  const showRegenerated = (result, variables) => {
    run.code = result.code;
    render(run.scenarioName, result, variables);
    switchTab('preview');
    showToast('Code regenerated');
  };

  const regenerate = () => {
    if (!cfg.regenerateFromStorage) {
      showRegenerated(cfg.generate(run.scenarioName, run.actions, run.variables, cfg.readOptions()), run.variables);
      return;
    }
    const sel        = document.getElementById('exportCodeSelect');
    const scenarioId = sel?.value;
    if (!scenarioId) return;

    const options = cfg.readOptions();
    chrome.runtime.sendMessage({ type: 'GET_SCENARIOS' }, res => {
      const scenario = (res?.scenarios || {})[scenarioId];
      run.actions    = scenario?.actions || [];
      chrome.runtime.sendMessage({ type: 'GET_VARIABLES' }, varRes => {
        const variables = varRes?.variables || {};
        showRegenerated(cfg.generate(run.scenarioName, run.actions, variables, options), variables);
      });
    });
  };

  const triggerBtn = document.getElementById(cfg.triggerId);
  if (!triggerBtn) return;

  triggerBtn.addEventListener('click', onTrigger);
  byId('Close')?.addEventListener('click', close);
  byId('Cancel')?.addEventListener('click', close);
  byId('Copy')?.addEventListener('click', copy);
  byId('Download')?.addEventListener('click', download);
  byId('Regenerate')?.addEventListener('click', regenerate);
  cfg.wire?.();

  byId('WrapBtn')?.addEventListener('click', () => {
    const code = byId('Code');
    if (code) code.style.whiteSpace = code.style.whiteSpace === 'pre-wrap' ? 'pre' : 'pre-wrap';
  });

  byId('SelectAllBtn')?.addEventListener('click', () => {
    const code = document.querySelector(`#${prefix}Code code`);
    if (!code) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });

  document.querySelectorAll(`.${tabClass}`).forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  const modal = byId('Modal');
  modal?.addEventListener('click', e => { if (e.target === modal) close(); });
  modal?.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
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

function renderActionsTab(prefix, actions, isSkipped) {
  const listEl    = document.getElementById(`${prefix}ActList`);
  const summaryEl = document.getElementById(`${prefix}ActSummary`);
  if (!listEl || !summaryEl) return { okCount: 0, warnCount: 0, skipCount: 0 };

  let okCount = 0, skipCount = 0, warnCount = 0;
  let html = '';

  const enabled = (actions || []).filter(a => !a.disabled);
  enabled.forEach((a, i) => {
    // The fallback label is a.type straight out of an imported .json, so both it
    // and the class name are escaped at the interpolation site below.
    const info = ACT_TYPE_INFO[a.type] || { icon: '●', label: String(a.type ?? 'unknown'), cls: 'wait' };
    const desc = actionDesc(a);
    let status, statusLabel, rowCls;
    if (isSkipped(a)) {
      status = 'skip'; statusLabel = '— Skip'; rowCls = 'row-skip'; skipCount++;
    } else if (a.type === 'script') {
      status = 'warn'; statusLabel = '⚠ Verify'; rowCls = 'row-warn'; warnCount++;
    } else {
      status = 'ok'; statusLabel = '✓ OK'; rowCls = ''; okCount++;
    }
    html += `<div class="export-bm-action-row ${rowCls}">
      <span class="export-bm-action-step">${i + 1}</span>
      <span class="export-bm-action-type abt-${escHtml(info.cls)}">${info.icon} ${escHtml(info.label)}</span>
      <span class="export-bm-action-desc">${escHtml(desc)}</span>
      <span class="export-bm-action-status ast-${status}">${statusLabel}</span>
    </div>`;
  });
  listEl.innerHTML = html;

  let sumHtml = '<span class="export-bm-act-sum-label">Will export:</span>';
  sumHtml += `<span class="export-bm-act-sum-pill act-sum-ok">✓ ${okCount} OK</span>`;
  if (warnCount) sumHtml += `<span class="export-bm-act-sum-pill act-sum-warn">⚠ ${warnCount} needs review</span>`;
  if (skipCount) sumHtml += `<span class="export-bm-act-sum-pill act-sum-skip">— ${skipCount} skipped</span>`;
  summaryEl.innerHTML = sumHtml;

  const badge = document.getElementById(`${prefix}ActCount`);
  if (badge) {
    const warnTotal = skipCount + warnCount;
    badge.textContent = warnTotal > 0 ? `${warnTotal} ⚠` : String(enabled.length);
    badge.className   = 'export-bm-tab-count' + (warnTotal > 0 ? ' warn' : '');
  }

  return { okCount, warnCount, skipCount };
}
