/**
 * ui/diff-view.js — the compare-mode diff between the two queries.
 */

import { t } from '../i18n.js';
import { el, node } from './dom.js';
import { renderInsight } from './layout.js';
import { insight } from './state.js';

// ---- rendering: compare-mode diff --------------------------------------

/** One coloured chip for a diff panel row: added / removed / changed. */
function diffChip(kind, text) {
  const mark = { added: '+', removed: '−', changed: '~' }[kind] || '';
  const chip = node('span', `chip chip-${kind}`);
  if (mark) chip.append(node('span', 'chip-mark', mark));
  chip.append(node('span', null, text));
  return chip;
}

// How to render one item from each section — most are just their rendered
// SQL; a few (joins, ORDER BY, writes) need more than one field to read as a
// change rather than a mystery.
const DIFF_TABLE = t2 => `${t2.label}${t2.joinType ? ` (${t2.joinType})` : ''}`;

const DIFF_JOIN = j => `${j.leftLabel} ⋈ ${j.rightLabel} (${j.joinType}${j.implicit ? ', implicit' : ''}${j.natural ? ', natural' : ''})`;

const DIFF_JOIN_CHANGED = (o, n) => `${o.leftLabel} ⋈ ${o.rightLabel}: ${o.joinType} → ${n.joinType}`;

const DIFF_COND = c => c.sql;

const DIFF_COND_CHANGED = (o, n) => `${o.sql}  →  ${n.sql}`;

const DIFF_GROUPBY = g => g.sql;

const DIFF_AGG = a => a.sql;

const DIFF_ORDERBY = o => `${o.sql} ${o.dir}`;

const DIFF_ORDERBY_CHANGED = (o, n) =>
  `${o.sql}: ${o.dir}${o.nulls ? ' NULLS ' + o.nulls : ''} → ${n.dir}${n.nulls ? ' NULLS ' + n.nulls : ''}`;

const DIFF_SELECT = c => (c.alias ? `${c.sql} AS ${c.alias}` : c.sql);

const DIFF_SELECT_CHANGED = (o, n) => `${DIFF_SELECT(o)}  →  ${DIFF_SELECT(n)}`;

const DIFF_CASE = c => c.sql;

const DIFF_WRITE = w => `${w.name} = ${w.sql}`;

const DIFF_WRITE_CHANGED = (o, n) => `${o.name}: ${o.sql}  →  ${n.sql}`;

/** One labelled group of chips for a diff section, or null when it has nothing to show. */
function diffSection(labelKey, sec, textOf, changedTextOf) {
  if (!sec) return null;
  const total = sec.added.length + sec.removed.length + sec.changed.length + (sec.shapeChanged ? 1 : 0);
  if (!total) return null;

  const g = node('div', 'an-group');
  g.append(node('div', 'an-label', t(labelKey)));
  const row = node('div', 'chip-row');
  sec.removed.forEach(x => row.append(diffChip('removed', textOf(x))));
  sec.added.forEach(x => row.append(diffChip('added', textOf(x))));
  sec.changed.forEach(x => row.append(
    diffChip('changed', changedTextOf ? changedTextOf(x.old, x.new) : `${textOf(x.old)} → ${textOf(x.new)}`)));
  if (sec.shapeChanged) row.append(diffChip('changed', t('diff.shapeChanged')));
  g.append(row);
  return g;
}

/** How a LIMIT or OFFSET changed: added, removed, or to another value. */
function pagingChange(part) {
  if (!part.old) return 'added';
  return !part.new ? 'removed' : 'changed';
}

/**
 * Render the "changes detected" panel for compare mode.
 *
 * @param {object|null} diff — from diffQueries(), or null to hide the panel
 *   (single mode, or an empty query on either side).
 */
export function renderDiff(diff) {
  el.diffBody.replaceChildren();

  if (!diff) {
    insight.diff = { available: false, count: 0 };
    renderInsight();
    return;
  }

  if (!diff.ok) {
    el.diffBody.append(node('div', 'helper', t('diff.parseFailed')));
    insight.diff = { available: true, count: 0 };
    renderInsight();
    return;
  }

  if (diff.statementChanged) {
    el.diffBody.append(node('div', 'diff-banner', t('diff.statementChanged', {
      old: diff.statement.old.toUpperCase(), new: diff.statement.new.toUpperCase()
    })));
  }

  const groups = [
    diffSection('diff.tables', diff.tables, DIFF_TABLE),
    diffSection('diff.joins', diff.joins, DIFF_JOIN, DIFF_JOIN_CHANGED),
    // The aggregate ON-clause shapeChangedCount across joins does not fit the
    // single boolean the other sections use, so it is folded in here as one.
    diffSection('diff.joinConditions',
      { ...diff.joinConditions, shapeChanged: diff.joinConditions.shapeChangedCount > 0 },
      DIFF_COND, DIFF_COND_CHANGED),
    diffSection('diff.where', diff.where, DIFF_COND, DIFF_COND_CHANGED),
    diffSection('diff.having', diff.having, DIFF_COND, DIFF_COND_CHANGED),
    diffSection('diff.groupBy', diff.groupBy, DIFF_GROUPBY),
    diffSection('diff.aggregates', diff.aggregates, DIFF_AGG),
    diffSection('diff.orderBy', diff.orderBy, DIFF_ORDERBY, DIFF_ORDERBY_CHANGED),
    diffSection('diff.selectList', diff.selectList, DIFF_SELECT, DIFF_SELECT_CHANGED),
    diffSection('diff.caseExprs', diff.caseExprs, DIFF_CASE),
    diffSection('diff.writes', diff.writes, DIFF_WRITE, DIFF_WRITE_CHANGED)
  ].filter(Boolean);

  // LIMIT/OFFSET are a single optional value each, not a list — handled apart
  // from diffSection rather than forcing them into its {added,removed,changed} shape.
  const { limit, offset } = diff.paging;
  const pagingChips = [];
  if (limit.changed) {
    pagingChips.push(diffChip(pagingChange(limit),
      `LIMIT ${limit.old ? limit.old.sql : '—'} → ${limit.new ? limit.new.sql : '—'}`));
  }
  if (offset.changed) {
    pagingChips.push(diffChip(pagingChange(offset),
      `OFFSET ${offset.old ? offset.old.sql : '—'} → ${offset.new ? offset.new.sql : '—'}`));
  }
  if (pagingChips.length) {
    const g = node('div', 'an-group');
    g.append(node('div', 'an-label', t('diff.paging')));
    const row = node('div', 'chip-row');
    pagingChips.forEach(c => row.append(c));
    g.append(row);
    groups.push(g);
  }

  if (!groups.length && !diff.statementChanged) {
    el.diffBody.append(node('div', 'helper', t('diff.noChanges')));
  } else {
    groups.forEach(g => el.diffBody.append(g));
  }

  insight.diff = { available: true, count: diff.summary.totalChanges };
  renderInsight();
}
