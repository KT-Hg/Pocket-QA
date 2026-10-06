/**
 * ui/filters.js — filters (priority, clause, column, technique, fixture), the
 * triage bar and the stale-case list.
 */

import { t } from '../i18n.js';
import { el, node } from './dom.js';
import { closeMenus, toggleMenu } from './exports.js';
import { renderInsight, scheduleCmdHeight } from './layout.js';
import { renderList, techniqueMatches } from './list.js';
import { insight, view } from './state.js';
import { pillLabel } from './text.js';

// ---- rendering: filters ----------------------------------------------

/** Order the clause dropdown lists its options in — matches the enum the
 *  technique modules tag cases with via diff.js's caseSourceFrom*() helpers. */
const CLAUSE_ORDER = ['WHERE', 'HAVING', 'JOIN', 'GROUP_BY', 'ORDER_BY', 'LIMIT_OFFSET', 'SET', 'INSERT', 'CASE_EXPR', 'DML_SCOPE', 'OTHER'];

const CLAUSE_LABELS = {
  WHERE: 'ui.clauseWhere', HAVING: 'ui.clauseHaving', JOIN: 'ui.clauseJoin',
  GROUP_BY: 'ui.clauseGroupBy', ORDER_BY: 'ui.clauseOrderBy', LIMIT_OFFSET: 'ui.clauseLimitOffset',
  SET: 'ui.clauseSet', INSERT: 'ui.clauseInsert', CASE_EXPR: 'ui.clauseCaseExpr',
  DML_SCOPE: 'ui.clauseDmlScope', OTHER: 'ui.clauseOther'
};

const IMPACT_ICON = { changed: '🎯', unrelated: '➖', stale: '🗑' };

const IMPACT_TIP_KEY = { changed: 'ui.impactChangedTip', unrelated: 'ui.impactUnrelatedTip', stale: 'ui.impactStaleTip' };

/** The small coloured marker shown beside a stale case. */
function impactBadge(impact) {
  const b = node('span', `impact-badge impact-${impact}`, IMPACT_ICON[impact] || '');
  b.title = t(IMPACT_TIP_KEY[impact] || '');
  return b;
}

/** Whether any of a case's `columns` matches the Table/Column filter value —
 *  a bare table label matches every column on that table, a full `table.col`
 *  value matches only that one column. */
export function columnMatches(caseColumns, filterValue) {
  if (!filterValue) return true;
  const wanted = filterValue.toLowerCase();
  return (caseColumns || []).some(col => {
    const raw = (col.raw || (col.table ? `${col.table}.${col.name}` : col.name) || '').toLowerCase();
    if (raw === wanted) return true;
    return (col.table || '').toLowerCase() === wanted;
  });
}

/**
 * Compare mode's three buckets, over the same run the list shows.
 *
 * Two of them are filters over the case list. The third is not — a stale case
 * is not in the list to be filtered down to, so that box opens the panel that
 * does hold them, which is the only place they exist.
 */
export function renderTriage() {
  const counts = { changed: 0, unrelated: 0 };
  (view.current?.cases || []).forEach(c => { if (counts[c.impact] !== undefined) counts[c.impact]++; });
  const tagged = counts.changed + counts.unrelated > 0;

  if (!tagged && !view.staleCases.length) {
    el.triage.hidden = true;
    view.activeImpact = '';
    return;
  }

  el.triChangedN.textContent = counts.changed;
  el.triUnrelatedN.textContent = counts.unrelated;
  el.triStaleN.textContent = view.staleCases.length;

  el.triage.querySelector('[data-tri="changed"]').classList.toggle('active', view.activeImpact === 'changed');
  el.triage.querySelector('[data-tri="unrelated"]').classList.toggle('active', view.activeImpact === 'unrelated');
  el.triage.querySelector('[data-tri="stale"]')
    .classList.toggle('active', view.insightTab === 'stale' && view.insightOpen);
  el.triage.hidden = false;
}

/** Clause dropdown — only lists clauses that actually occur in the current case list. */
export function renderClauseFilter() {
  const sel = el.clauseFilter;
  const prevValue = view.activeClause;
  sel.replaceChildren();
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = t('ui.allClauses');
  sel.append(allOpt);

  const present = view.current ? new Set(view.current.cases.map(c => c.clause).filter(Boolean)) : new Set();
  CLAUSE_ORDER.filter(k => present.has(k)).forEach(k => {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = t(CLAUSE_LABELS[k]);
    sel.append(opt);
  });

  sel.disabled = present.size === 0;
  view.activeClause = present.has(prevValue) ? prevValue : '';
  sel.value = view.activeClause;
}

/** Table/column dropdown — populated from the current query's own schema. */
export function renderColumnFilter() {
  const sel = el.columnFilter;
  const prevValue = view.activeColumn;
  sel.replaceChildren();
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = t('ui.allColumns');
  sel.append(allOpt);

  if (view.current?.model) {
    const seen = new Set();
    view.current.model.tables.forEach(tbl => {
      if (!tbl.label || seen.has(tbl.label)) return;
      seen.add(tbl.label);
      const opt = document.createElement('option');
      opt.value = tbl.label;
      opt.textContent = `🗂 ${tbl.label}`;
      sel.append(opt);
    });
    view.current.model.columns.forEach(col => {
      if (!col.raw || seen.has(col.raw)) return;
      seen.add(col.raw);
      const opt = document.createElement('option');
      opt.value = col.raw;
      opt.textContent = `  ${col.raw}`;
      sel.append(opt);
    });
  }

  const available = new Set([...sel.options].map(o => o.value));
  sel.disabled = available.size <= 1;
  view.activeColumn = available.has(prevValue) ? prevValue : '';
  sel.value = view.activeColumn;
}

/**
 * Compare mode: the "before" query's cases whose source condition/join/etc.
 * is gone in the "after" query — shown as a compact list rather than in the
 * main list, since they describe behaviour that no longer exists to test.
 */
export function renderStale(list) {
  view.staleCases = list || [];
  el.staleBody.replaceChildren();

  if (!view.staleCases.length) {
    insight.stale = { available: false, count: 0 };
    renderInsight();
    return;
  }

  view.staleCases.forEach(c => {
    const row = node('div', 'stale-row');
    row.append(impactBadge('stale'));
    row.append(node('span', 'stale-title', `${c.title} — ${c.data}`));
    row.append(node('span', 'stale-group', `${t('tech.code.' + c.technique)} · ${c.group}`));
    el.staleBody.append(row);
  });

  insight.stale = { available: true, count: view.staleCases.length };
  renderInsight();
}

export function renderTechniqueFilter(stats) {
  el.techFilter.replaceChildren();
  const codes = Object.keys(stats?.byTechnique || {});

  const mk = (key, value, count) => {
    const b = node('button', `pill${view.activeTechnique === value ? ' active' : ''}`);
    b.append(pillLabel(key));
    if (count !== undefined) b.append(node('span', 'pill-n', count));
    b.addEventListener('click', () => {
      view.activeTechnique = view.activeTechnique === value ? '' : value;
      renderTechniqueFilter(stats);
      renderList();
    });
    return b;
  };

  // A merged code like 'EP+BVA' counts towards its own pill *and* towards
  // 'EP' and 'BVA' individually — the count next to a pill should match how
  // many cases clicking it will actually show (see techniqueMatches()).
  const countFor = code => (view.current?.cases || []).filter(c => techniqueMatches(c.technique, code)).length;

  el.techFilter.append(mk('ui.filterAll', '', stats?.total ?? 0));
  codes.forEach(code => el.techFilter.append(mk('tech.code.' + code, code, countFor(code))));
  scheduleCmdHeight();
}

/** How many of the popover's filters are narrowing the list right now. */
function activeFilterCount() {
  return [el.prioFilter.value, view.activeClause, view.activeColumn].filter(Boolean).length + (view.onlyWithFixture ? 1 : 0);
}

export function renderFilterCount() {
  const n = activeFilterCount();
  el.filterCount.hidden = !n;
  el.filterCount.textContent = n;
  el.filtersBtn.classList.toggle('active', !!n);
}

function clearAllFilters() {
  view.activeTechnique = '';
  view.activeClause = '';
  view.activeColumn = '';
  view.activeImpact = '';
  view.onlyWithFixture = false;
  el.search.value = '';
  el.prioFilter.value = '';
  el.clauseFilter.value = '';
  el.columnFilter.value = '';
  el.fixtureFilter.checked = false;
  renderTechniqueFilter(view.current?.stats);
  renderFilterCount();
  renderTriage();
  renderList();
}

export function initFilters() {
  el.filtersBtn.addEventListener('click', () => toggleMenu(el.filterPop, el.filtersBtn));
  el.closeFilters.addEventListener('click', closeMenus);
  el.clearFilters.addEventListener('click', clearAllFilters);
  el.emptyClear.addEventListener('click', clearAllFilters);

  el.search.addEventListener('input', renderList);
  el.prioFilter.addEventListener('change', () => { renderFilterCount(); renderList(); });
  el.clauseFilter.addEventListener('change', () => {
    view.activeClause = el.clauseFilter.value;
    renderFilterCount();
    renderList();
  });
  el.columnFilter.addEventListener('change', () => {
    view.activeColumn = el.columnFilter.value;
    renderFilterCount();
    renderList();
  });
  el.fixtureFilter.addEventListener('change', () => {
    view.onlyWithFixture = el.fixtureFilter.checked;
    renderFilterCount();
    renderList();
  });

  // A click anywhere that is not inside a dropdown closes both of them.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-wrap')) closeMenus();
  });
}
