/**
 * ui/inspector.js — the inspector: one case in full.
 */

import { verifyFor } from '../datagen.js';
import { t } from '../i18n.js';
import { el, node } from './dom.js';
import { renderList, techBadge, visibleCases } from './list.js';
import { activeSql } from './run.js';
import { sqlHighlight } from './sql-highlight.js';
import { view } from './state.js';

// ---- rendering: the inspector ----------------------------------------

/**
 * The one case on screen in full: why it matters, the rows to create, anything
 * that could not be expressed as a row, and the query to run once the data is
 * in place.
 *
 * This is what used to be a detail row spliced into the table under the case,
 * which meant opening the fourth case pushed the fifth to the bottom of the
 * window. A fixed column holds the same content without moving anything.
 */
export function renderInspector() {
  el.inspInner.replaceChildren();

  const testCase = view.current?.cases.find(c => c.id === view.selectedId);
  if (!testCase) {
    view.selectedId = null;
    const empty = node('div', 'insp-empty');
    const box = node('div');
    box.append(node('div', 'ic', '◧'));
    box.append(node('p', null, t('ui.inspEmpty')));
    empty.append(box);
    el.inspInner.append(empty);
    return;
  }

  const list = visibleCases();
  const at = list.findIndex(c => c.id === testCase.id);

  // --- head: identity and the walk through the filtered list ---
  const head = node('div', 'insp-head');
  const top = node('div', 'top');
  top.append(node('span', 'cid', testCase.id));
  top.append(techBadge(testCase.technique));
  top.append(node('span', `prio prio-${testCase.priority}`, t('prio.' + testCase.priority)));

  const nav = node('span', 'nav');
  const navBtn = (label, titleKey, delta, disabled) => {
    const b = node('button', 't-btn t-btn-icon t-btn-ghost t-btn-sm', label);
    b.title = t(titleKey);
    b.disabled = disabled;
    b.addEventListener('click', () => {
      if (delta === 0) { view.selectedId = null; }
      else {
        const next = list[at + delta];
        if (next) view.selectedId = next.id;
      }
      renderList();
      renderInspector();
    });
    return b;
  };
  nav.append(navBtn('↑', 'ui.inspPrev', -1, at <= 0));
  nav.append(navBtn('↓', 'ui.inspNext', 1, at < 0 || at >= list.length - 1));
  nav.append(navBtn('✕', 'ui.inspClose', 0, false));
  top.append(nav);
  head.append(top);

  head.append(node('h2', null, testCase.title));

  const sub = node('div', 'sub');
  sub.append(node('span', 'tgt', testCase.target));
  if (testCase.group) sub.append(node('span', null, testCase.group));
  if (testCase.impact === 'changed' || testCase.impact === 'unrelated') {
    sub.append(node('span', `imp imp-${testCase.impact}`,
      t(testCase.impact === 'changed' ? 'ui.impactChangedShort' : 'ui.impactUnrelatedShort')));
  }
  head.append(sub);
  el.inspInner.append(head);

  const body = node('div', 'insp-body');

  // --- why this case exists ---
  if (testCase.rationale) {
    const sec = node('div', 'fx-sec');
    sec.append(node('div', 'fx-label', t('dg.rationale')));
    sec.append(node('div', 'fx-rationale', testCase.rationale));
    body.append(sec);
  }

  // --- what to set up, and what should come back ---
  const secData = node('div', 'fx-sec');
  secData.append(node('div', 'fx-label', t('ui.colData')));
  secData.append(node('div', 'fx-data', testCase.data));
  const exp = node('div', 'fx-expected');
  exp.append(node('b', null, `${t('dg.expected')}: `));
  exp.append(node('span', null, testCase.expected));
  secData.append(exp);
  if (testCase.notes) {
    // Same amber as the note on the card, so the two read as one thing said
    // twice rather than as a warning and a footnote.
    const req = node('div', 'fx-req fx-req-warn');
    req.append(node('span', 'b', '⚠'));
    req.append(node('span', null, testCase.notes));
    secData.append(req);
  }
  body.append(secData);

  const fixture = view.data?.fixtures.get(testCase.id);

  if (!fixture) {
    const sec = node('div', 'fx-sec');
    sec.append(node('div', 'fx-label', t('dg.fixture')));
    // Two different reasons look the same to a case without a fixture: the
    // case genuinely has no rows to derive (by design), or fixture
    // generation for this whole result blew up (a bug). Silently falling
    // back to the by-design message for the second case would hide the
    // failure the toast above already reported.
    const req = node('div', view.fixtureError ? 'fx-req fx-req-warn' : 'fx-req');
    req.append(node('span', 'b', view.fixtureError ? '⚠' : '◆'));
    req.append(node('span', null, t(view.fixtureError ? 'dg.fixtureErrorInline' : 'dg.noFixture')));
    sec.append(req);
    body.append(sec);
    el.inspInner.append(body);
    return;
  }

  // --- rows to prepare ---
  const secRows = node('div', 'fx-sec');
  secRows.append(node('div', 'fx-label', t('dg.fixture')));
  const wrap = node('div', 'fx-tables');

  fixture.tables.forEach(tbl => {
    const box = node('div', 'fx-table');
    const name = node('div', 'fx-tname', tbl.table);
    name.append(node('span', 'fx-count',
      tbl.rows.length ? t('dg.rowCount', { n: tbl.rows.length }) : t('dg.row.none')));
    box.append(name);

    if (!tbl.rows.length) {
      box.append(node('div', 'fx-empty', t('dg.row.none')));
    } else {
      const grid = node('table', 'fx-grid');
      const thead = node('thead');
      const hrow = node('tr');
      tbl.columns.forEach(cn => hrow.append(node('th', null, cn)));
      thead.append(hrow);
      grid.append(thead);

      const tbody = node('tbody');
      tbl.rows.forEach(row => {
        const rtr = node('tr');
        tbl.columns.forEach(cn => {
          const cell = row.values[cn];
          rtr.append(node('td', cell?.focus ? 'focus' : null, cell?.plain ?? ''));
        });
        tbody.append(rtr);
      });
      grid.append(tbody);
      box.append(grid);
    }
    wrap.append(box);
  });

  secRows.append(wrap);
  if (fixture.tables.some(tb => tb.rows.some(r => Object.values(r.values).some(v => v.focus)))) {
    secRows.append(node('div', 'fx-note', t('dg.focusHint')));
  }
  body.append(secRows);

  // --- requirements no row can express ---
  if (fixture.requirements.length) {
    const secReq = node('div', 'fx-sec');
    secReq.append(node('div', 'fx-label', t('dg.requirements')));
    fixture.requirements.forEach(r => {
      const req = node('div', 'fx-req');
      req.append(node('span', 'b', '◆'));
      req.append(node('span', null, r.text));
      secReq.append(req);
    });
    body.append(secReq);
  }

  // --- the query to run afterwards ---
  const v = verifyFor(activeSql(), testCase);
  const secSql = node('div', 'fx-sec');
  secSql.append(node('div', 'fx-label', t('dg.verify')));
  const pre = node('pre', 'fx-sql');
  pre.append(sqlHighlight(v.sql));
  secSql.append(pre);
  const vexp = node('div', 'fx-exp');
  vexp.append(node('b', null, `${t('dg.expected')}:`));
  vexp.append(node('span', null, v.expectation));
  secSql.append(vexp);
  body.append(secSql);

  el.inspInner.append(body);
}
