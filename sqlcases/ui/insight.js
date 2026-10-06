/**
 * ui/insight.js — the insight block: analysis, findings, coverage.
 */

import { t } from '../i18n.js';
import { el, node } from './dom.js';
import { renderInsight } from './layout.js';
import { insight, view } from './state.js';

// ---- rendering: parsed analysis --------------------------------------

export function renderAnalysis(model) {
  el.analysisBody.replaceChildren();
  if (!model) { insight.analysis.available = false; renderInsight(); return; }

  const section = (label, chips) => {
    if (!chips.length) return;
    const g = node('div', 'an-group');
    g.append(node('div', 'an-label', label));
    const row = node('div', 'chip-row');
    chips.forEach(c => row.append(c));
    g.append(row);
    el.analysisBody.append(g);
  };

  const plainChip = (text) => node('span', 'chip', text);

  section(t('ui.statement'), [plainChip(model.statement.toUpperCase())]);

  section(t('ui.tables'), model.tables.map(tbl => {
    const chip = node('span', 'chip');
    chip.append(node('code', null, tbl.name));
    if (tbl.alias) chip.append(node('span', 'chip-type', t('ui.as', { alias: tbl.alias })));
    if (tbl.joinType) chip.append(node('span', 'chip-type', tbl.joinType));
    return chip;
  }));

  const conds = [...model.conditions, ...model.havingConditions];
  section(t('ui.conditions'), conds.map(c => {
    const chip = node('span', 'chip');
    chip.append(node('span', 'chip-id', c.id));
    chip.append(node('code', null, c.sql));
    chip.append(node('span', 'chip-type', `${c.dataType.type}${c.dataType.confidence === 'name' ? '?' : ''}`));
    return chip;
  }));

  section(t('ui.joins'), model.joins.map(j =>
    plainChip(`${j.joinType}${j.implicit ? ' (comma)' : ''} · ${j.leftLabel} ⋈ ${j.rightLabel}`)
  ));

  const shape = [];
  if (model.grouping.distinct) shape.push(plainChip('DISTINCT'));
  model.grouping.groupBy.forEach(g => shape.push(plainChip(`GROUP BY ${g.sql}`)));
  model.grouping.aggregates.forEach(a => shape.push(plainChip(a.sql)));
  model.paging.orderBy.forEach(o => shape.push(plainChip(`ORDER BY ${o.sql} ${o.dir}`)));
  if (model.paging.limit) shape.push(plainChip(`LIMIT ${model.paging.limit.sql}`));
  if (model.paging.offset) shape.push(plainChip(`OFFSET ${model.paging.offset.sql}`));
  section(t('ui.resultShape'), shape);

  if (model.writes) {
    section(t('ui.writes'), model.writes.columns.map(c => plainChip(`${c.name} : ${c.dataType.type}`)));
  }

  insight.analysis.available = true;
  renderInsight();
}

// ---- rendering: findings & coverage ----------------------------------

const FINDING_ICON = { error: '⛔', warn: '⚠', info: 'ℹ' };

/** The worst level among the findings: err, warn, or '' for notes only. */
function findingsLevel(counts) {
  if (counts.error) return 'err';
  return counts.warn ? 'warn' : '';
}

export function renderFindings(findings) {
  el.findings.replaceChildren();

  if (!findings.length) {
    insight.findings = { available: false, count: 0, level: '' };
    renderInsight();
    return;
  }

  findings.forEach(f => {
    const row = node('div', `finding finding-${f.level}`);
    row.append(node('span', 'finding-icon', FINDING_ICON[f.level] || 'ℹ'));
    row.append(node('span', null, f.message));
    el.findings.append(row);
  });

  const counts = { error: 0, warn: 0, info: 0 };
  findings.forEach(f => { if (counts[f.level] !== undefined) counts[f.level]++; });

  insight.findings = {
    available: true,
    count: findings.length,
    level: findingsLevel(counts)
  };
  // An error is worth opening unasked; warnings and notes are not. Only when
  // the block is shut, though: generation re-runs on every keystroke, and
  // while the query holds an error that would drag the reader off whichever
  // tab they had deliberately opened, once per character typed.
  if (counts.error && !view.insightOpen) { view.insightTab = 'findings'; view.insightOpen = true; }
  renderInsight();
}

export function renderCoverage(summaries) {
  el.coverage.replaceChildren();
  if (!summaries.length) {
    insight.coverage = { available: false, count: 0 };
    renderInsight();
    return;
  }

  summaries.forEach(s => {
    const card = node('div', 'cov-card');
    const head = node('div', 'cov-head');
    head.append(node('span', 'cov-scope', s.scope));
    head.append(node('span', 'cov-mode',
      t('ui.covCombinations', { mode: s.mode, rules: s.ruleCount, total: s.fullTableSize ?? '—' })));
    card.append(head);

    const bars = node('div', 'cov-bars');
    const bar = (label, pct) => {
      const row = node('div', 'cov-bar-row');
      row.append(node('span', 'cov-bar-lbl', label));
      const track = node('div', 'cov-bar');
      const fill = node('div', `cov-bar-fill${pct < 100 ? ' partial' : ''}`);
      fill.style.width = `${pct}%`;
      track.append(fill);
      row.append(track, node('span', 'cov-bar-val', `${pct}%`));
      bars.append(row);
    };
    bar(t('ui.covCondition'), s.conditionCoverage);
    bar(t('ui.covDecision'), s.decisionCoverage);
    card.append(bars);

    const legend = node('div', 'cov-legend');
    s.legend.forEach(l => {
      const line = node('div');
      line.append(node('span', 'chip-id', l.id + ' '));
      line.append(node('code', null, l.sql));
      legend.append(line);
    });
    card.append(legend);

    if (s.maskedConditions.length) {
      card.append(node('div', 'helper',
        t('ui.covMasked', { ids: s.maskedConditions.join(', ') })));
    }
    el.coverage.append(card);
  });

  insight.coverage = { available: true, count: summaries.length };
  renderInsight();
}
