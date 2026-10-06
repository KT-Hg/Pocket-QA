/**
 * ui/run.js — running the generator on the query (or both queries in compare
 * mode) and showing the result, parse problems and stats.
 */

import { buildAllFixtures } from '../datagen.js';
import { generateCases, generateComparison } from '../generate.js';
import { t } from '../i18n.js';
import { parse } from '../parser.js';
import { renderDiff } from './diff-view.js';
import { el, node } from './dom.js';
import { renderClauseFilter, renderColumnFilter, renderFilterCount, renderStale, renderTechniqueFilter, renderTriage } from './filters.js';
import { renderAnalysis, renderCoverage, renderFindings } from './insight.js';
import { renderInspector } from './inspector.js';
import { applyLayout, renderInsight, renderRail, scheduleCmdHeight } from './layout.js';
import { positionOf, renderList } from './list.js';
import { renderSchema } from './schema.js';
import { view } from './state.js';
import { readOptions, updateTechniqueCounts } from './techniques.js';
import { setLabel } from './text.js';
import { toast } from './toast.js';
import { renderValues } from './values-panel.js';

/**
 * The SQL text that produced `current` — #sqlInput in single mode, but
 * #sqlInputAfter in compare mode, since that is the query the case table,
 * fixtures and exports are actually generated from.
 */
export function activeSql() {
  return view.mode === 'compare' ? el.sqlAfter.value : el.sql.value;
}

// ---- run -------------------------------------------------------------

function renderParseProblems(sql, result, target = el.parseErrors) {
  target.replaceChildren();
  const errors = result.errors || [];
  const warnings = result.warnings || [];

  if (!errors.length && !warnings.length) {
    target.hidden = true;
    return;
  }

  errors.forEach(e => {
    const p = node('div');
    const { line, col } = positionOf(sql, e.pos);
    p.append(node('b', null, t('ui.parseError', { line, col })));
    p.append(node('span', null, e.message));
    target.append(p);
    const lineText = sql.split('\n')[line - 1];
    if (lineText) target.append(node('code', null, `${lineText}\n${' '.repeat(Math.max(0, col - 1))}^`));
  });

  warnings.forEach(w => {
    // A warning that names a position is usually one about text that went
    // unanalysed — pointing at it is the difference between a shrug and a fix.
    const where = w.pos > 0 ? positionOf(sql, w.pos) : null;
    target.append(node('div', null, where
      ? t('ui.warnAt', { line: where.line, col: where.col, message: w.message })
      : t('ui.warn', { message: w.message })));
  });
  target.hidden = false;
  // A parse error is the reason nothing else on the page updated, and the rail
  // may well be showing the technique list — put the query back on screen.
  if (errors.length) view.railTab = 'sql';
}

/** Wipe everything a result feeds, without touching the query or the options. */
function clearResult() {
  view.current = null;
  view.data = null;
  view.selectedId = null;
  view.staleCases = [];
  renderSchema();
  renderValues();
  renderAnalysis(null);
  renderFindings([]);
  renderCoverage([]);
  renderTechniqueFilter(null);
  renderClauseFilter();
  renderColumnFilter();
  renderFilterCount();
  renderTriage();
  setStats(null);
  renderList();
  renderInspector();
  renderRail();
  applyLayout();
}

/**
 * Render everything the results pane shows for one already-computed
 * generateCases() result: schema, value book, analysis, findings, coverage,
 * technique filter, stats, and the case list itself.
 *
 * Shared by single mode (called from a plain generateCases() run) and by
 * compare mode's "after" side (called with the already-tagged result out of
 * generateComparison()) — the rendering does not care where the result came
 * from, only that its shape matches.
 */
function renderResult(sql, result, errorsEl) {
  renderParseProblems(sql, result, errorsEl);

  if (!result.ok) {
    el.parseStatus.textContent = t('ui.parseFailed');
    clearResult();
    return;
  }

  view.current = result;
  // A case that is no longer in the result cannot stay in the inspector.
  if (view.selectedId && !result.cases.some(c => c.id === view.selectedId)) view.selectedId = null;

  // Fixtures depend only on the model and the case list, so they are rebuilt
  // with every generation — including a language switch, which re-runs it.
  try {
    view.data = buildAllFixtures(result.model, result.cases);
    view.fixtureError = false;
  } catch (err) {
    console.error('[SQLCASES] fixture generation failed:', err);
    view.data = null;
    // Rising edge only — retyping the same broken query re-runs this on
    // every debounce tick, and a fresh toast each time would just be noise.
    if (!view.fixtureError) toast(t('ui.toastFixtureError'), 'error');
    view.fixtureError = true;
  }
  renderSchema();
  renderValues();
  el.parseStatus.textContent = t('ui.parsedAs', { statement: result.model.statement.toUpperCase(), n: result.cases.length });
  renderAnalysis(result.model);
  renderFindings(result.findings);
  renderCoverage(result.coverage);
  updateTechniqueCounts(result.stats);
  if (view.activeTechnique && !result.stats.byTechnique[view.activeTechnique]) view.activeTechnique = '';
  renderTechniqueFilter(result.stats);
  renderClauseFilter();
  renderColumnFilter();
  renderFilterCount();
  renderTriage();
  setStats(result.stats);
  renderList();
  renderInspector();
  renderRail();
  applyLayout();
}

/** Single mode: parse, generate and render one query. */
function runFor(sql, errorsEl) {
  if (!sql.trim()) {
    errorsEl.hidden = true;
    el.parseStatus.textContent = t('ui.parseHint');
    clearResult();
    return;
  }

  let result;
  try {
    result = generateCases(sql, readOptions());
  } catch (err) {
    console.error('[SQLCASES] generation failed:', err);
    errorsEl.replaceChildren(node('div', null, t('ui.genFailed', { message: err.message })));
    errorsEl.hidden = false;
    el.parseStatus.textContent = t('ui.parseFailed');
    clearResult();
    return;
  }

  renderResult(sql, result, errorsEl);
}

/**
 * Compare mode: one generateComparison() call drives the whole page — the
 * case list, findings etc. still come off the "after" query (now with
 * `.impact` tagged on each case), and the diff panel comes off the same
 * call's `.diff` rather than a second, separate diffQueries() run.
 */
function runCompare() {
  const beforeSql = el.sql.value;
  const afterSql = el.sqlAfter.value;

  if (!afterSql.trim()) {
    // Nothing to generate cases from yet — still show whatever is wrong
    // with the "before" side, so a mistake there does not read as silence.
    const beforeParsed = parse(beforeSql);
    renderParseProblems(beforeSql, beforeParsed, el.parseErrors);
    renderDiff(null);
    renderStale([]);
    runFor('', el.parseErrorsAfter);
    return;
  }

  let comparison;
  try {
    comparison = generateComparison(beforeSql, afterSql, readOptions());
  } catch (err) {
    console.error('[SQLCASES] comparison failed:', err);
    el.parseErrorsAfter.replaceChildren(node('div', null, t('ui.genFailed', { message: err.message })));
    el.parseErrorsAfter.hidden = false;
    el.parseStatus.textContent = t('ui.parseFailed');
    renderDiff(null);
    renderStale([]);
    clearResult();
    return;
  }

  // The before side never drives the results pane, only its own errors —
  // its cases are only consulted below, for which of them the after-side
  // change left with no source element to test any more.
  renderParseProblems(beforeSql, comparison.before, el.parseErrors);
  renderResult(afterSql, comparison.after, el.parseErrorsAfter);
  renderDiff(comparison.diff);
  renderStale(comparison.before.ok ? comparison.before.cases.filter(c => c.impact === 'stale') : []);
  renderTriage();
}

export function run() {
  view.insightSettling = true;
  try {
    if (view.mode !== 'compare') {
      renderDiff(null);
      renderStale([]);
      runFor(el.sql.value, el.parseErrors);
    } else {
      runCompare();
    }
  } finally {
    // Resolved here and nowhere else, so the tab moves at most once per run —
    // and only when the pane behind it really did go away.
    view.insightSettling = false;
    renderInsight();
    renderTriage();
  }
}

function setStats(stats) {
  const enabled = !!stats && stats.total > 0;
  el.stats.total.textContent = stats?.total ?? 0;
  el.stats.high.textContent = stats?.byPriority.High ?? 0;
  el.stats.conds.textContent = stats?.conditions ?? 0;
  el.stats.joins.textContent = stats?.joins ?? 0;
  el.stats.tables.textContent = stats?.tables ?? 0;
  [el.csv, el.json, el.copyJson].forEach(b => { b.disabled = !enabled; });
  const hasData = enabled && !!view.data && view.data.schema.tables.length > 0;
  [el.dataCsv, el.verifySql].forEach(b => { b.disabled = !hasData; });
  el.exportBtn.disabled = !enabled;
  el.cmdbarDock.hidden = !enabled;
  // ResizeObserver reports a hidden element as 0x0 but never fires for the
  // `hidden` attribute itself, so the show/hide above has to say so.
  scheduleCmdHeight();
}

/**
 * Switch between analysing one query and diffing two.
 *
 * The "before" side reuses #sqlInput rather than adding a third textarea —
 * one query is one query whichever mode is active, only its role and label
 * change, and the AFTER block is shown or hidden beneath it.
 */
export function setMode(next) {
  view.mode = next === 'compare' ? 'compare' : 'single';
  el.modeToggle.querySelectorAll('button[data-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === view.mode);
  });
  el.sqlAfterCard.hidden = view.mode !== 'compare';
  setLabel(el.sqlLabel, view.mode === 'compare' ? 'ui.sqlQueryBefore' : 'ui.sqlQuery');
  // The tab sits above two textareas in compare mode, so "Query" stops being
  // the honest name for what is behind it.
  setLabel(el.railTabSqlLabel, view.mode === 'compare' ? 'ui.railSqlCompare' : 'ui.railSql');
  // Switching mode is switching what you are about to type into.
  if (view.mode === 'compare') view.railTab = 'sql';
}
