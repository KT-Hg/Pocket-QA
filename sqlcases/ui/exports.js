/**
 * ui/exports.js — the Export menu (CSV, JSON, test data, verification SQL).
 */

import { fixturesToCsv, verifyFor } from '../datagen.js';
import { downloadText, suggestFilename, toCsv, toJson } from '../export.js';
import { t } from '../i18n.js';
import { el } from './dom.js';
import { activeSql } from './run.js';
import { view } from './state.js';
import { toast } from './toast.js';

/** Close both dropdowns. They are mutually exclusive and share every dismissal. */
export function closeMenus() {
  el.exportMenu.hidden = true;
  el.filterPop.hidden = true;
  el.exportBtn.setAttribute('aria-expanded', 'false');
  el.filtersBtn.setAttribute('aria-expanded', 'false');
}

export function toggleMenu(menu, button) {
  const open = menu.hidden;
  closeMenus();
  menu.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
}

export function initExports() {
  el.exportBtn.addEventListener('click', () => toggleMenu(el.exportMenu, el.exportBtn));

  el.csv.addEventListener('click', () => {
    if (!view.current) return;
    downloadText(toCsv(view.current.cases), suggestFilename(view.current, 'csv'), 'text/csv');
    toast(t('ui.toastCsv', { n: view.current.cases.length }), 'success');
  });

  el.json.addEventListener('click', () => {
    if (!view.current) return;
    downloadText(toJson(activeSql(), view.current), suggestFilename(view.current, 'json'), 'application/json');
    toast(t('ui.toastJson'), 'success');
  });

  el.dataCsv.addEventListener('click', () => {
    if (!view.current || !view.data) return;
    const files = fixturesToCsv(view.data.schema, view.data.fixtures, view.current.cases).filter(f => f.rows > 0);
    // Every table came back empty (all rows filtered out above) — nothing
    // was actually downloaded, so this must not read as the success toast
    // below or the click looks like it worked when it did nothing.
    if (!files.length) {
      toast(t('ui.toastNoDataRows'), 'warn');
      return;
    }
    // One file per table, as asked. chrome.downloads queues them, so a
    // multi-table query produces several downloads from the single click.
    files.forEach(f => downloadText(f.csv, `testdata_${f.table.replace(/[^a-z0-9_-]+/gi, '_')}.csv`, 'text/csv'));
    toast(t('dg.toastCsv', { n: files.length }), 'success');
  });

  el.verifySql.addEventListener('click', () => {
    if (!view.current) return;
    const lines = [`-- ${t('dg.verifyHeader')}`, `-- ${t('dg.verifyIntro')}`, ''];
    view.current.cases.forEach(c => {
      const v = verifyFor(activeSql(), c);
      lines.push(`-- ${'='.repeat(70)}`);
      lines.push(`-- ${v.header}`);
      lines.push(`-- ${t('dg.expected')}: ${v.expectation}`);
      lines.push(v.sql, '');
    });
    downloadText(lines.join('\n'), suggestFilename(view.current, 'sql'), 'text/plain');
    toast(t('dg.toastVerify'), 'success');
  });

  el.copyJson.addEventListener('click', async () => {
    if (!view.current) return;
    try {
      await navigator.clipboard.writeText(toJson(activeSql(), view.current));
      toast(t('ui.toastCopied'), 'success');
    } catch (err) {
      console.error('[SQLCASES] clipboard write failed:', err);
      toast(t('ui.toastCopyFail'), 'error');
    }
  });

  // The menu is a list of one-shot actions, so every one of them dismisses it.
  el.exportMenu.querySelectorAll('button').forEach(b => b.addEventListener('click', closeMenus));
}
