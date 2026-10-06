/**
 * ui/list.js — the case list: grouping, technique badges, case cards.
 */

import { t } from '../i18n.js';
import { el, node } from './dom.js';
import { columnMatches } from './filters.js';
import { renderInspector } from './inspector.js';
import { applyLayout, saveUi } from './layout.js';
import { collapsedGroups, view } from './state.js';

/**
 * CSS-safe suffix for a technique badge class.
 *
 * Letters and digits, so "NULL / 3VL" keeps its 3 and stays distinguishable
 * from a future "NULLVL"; the codes are a short fixed enum, so there is no
 * length to guard against. The selectors are in sqlcases.css under
 * `.tech-badge`, and a code with no rule there degrades to the neutral badge.
 */
function techClass(technique) {
  return 'tech-' + technique.replace(/[^A-Za-z0-9]/g, '');
}

/**
 * A case's `technique` is usually one code ('EP'), but can be several joined
 * with '+' when two techniques converged on the exact same case (e.g.
 * 'EP+BVA' — see mergeOverlaps() in ep-bva.js). Filtering by 'EP' alone must
 * still surface that merged case — it genuinely is an EP case, just also a
 * BVA one — so this checks membership rather than exact equality.
 */
export function techniqueMatches(caseTechnique, filterValue) {
  return caseTechnique === filterValue || caseTechnique.split('+').includes(filterValue);
}

/**
 * The technique badge shown on a case card and in the inspector header.
 *
 * A plain technique renders as the usual single-colour pill. A merged one
 * ('EP+BVA' — see mergeOverlaps() in ep-bva.js) renders as one pill with a
 * smooth gradient between the two techniques' own soft backgrounds, and
 * "EP"/"BVA" each kept in that technique's own text colour (see
 * `.tech-badge-split` in sqlcases.css) — the two original badges' colours
 * combined into one, rather than a third colour belonging to neither.
 */
export function techBadge(technique) {
  const codes = technique.split('+');
  if (codes.length === 1) {
    return node('span', `tech-badge ${techClass(technique)}`, t('tech.code.' + technique));
  }
  const badge = node('span', `tech-badge tech-badge-split ${techClass(technique)}`);
  codes.forEach((code, i) => {
    if (i > 0) badge.append(node('span', 'tech-badge-sep', '+'));
    badge.append(node('span', `tech-badge-part ${techClass(code)}`, t('tech.code.' + code)));
  });
  return badge;
}

/** Line and column of a character offset, for parse-error messages. */
export function positionOf(sql, pos) {
  const upto = sql.slice(0, Math.max(0, pos));
  const line = upto.split('\n').length;
  const col = pos - upto.lastIndexOf('\n');
  return { line, col };
}

/**
 * The heading a case belongs under.
 *
 * Every technique tags its cases with a group, but the heading is the only
 * thing separating one block from the next — an untagged case would open a
 * section with no name at all rather than joining a catch-all.
 */
export function groupKeyOf(testCase) {
  return testCase.group || t('ui.groupOther');
}

export function visibleCases() {
  if (!view.current) return [];
  const q = el.search.value.trim().toLowerCase();
  const prio = el.prioFilter.value;
  return view.current.cases.filter(c => {
    if (view.activeTechnique && !techniqueMatches(c.technique, view.activeTechnique)) return false;
    if (prio && c.priority !== prio) return false;
    if (view.activeClause && c.clause !== view.activeClause) return false;
    if (view.activeImpact && c.impact !== view.activeImpact) return false;
    if (view.activeColumn && !columnMatches(c.columns, view.activeColumn)) return false;
    if (view.onlyWithFixture && !view.data?.fixtures.get(c.id)) return false;
    if (!q) return true;
    return [c.id, c.technique, c.group, c.target, c.title, c.data, c.expected, c.notes]
      .join(' ').toLowerCase().includes(q);
  });
}

// ---- rendering: the case list ----------------------------------------

/**
 * One case card.
 *
 * A button rather than a row: selecting a case is the only thing it does, and
 * a button gets keyboard focus, Enter and Space without any of it being
 * reimplemented here.
 */
function caseCard(testCase) {
  const card = node('button', 'case');
  card.type = 'button';
  card.dataset.id = testCase.id;
  if (testCase.notes) card.classList.add('has-note');
  if (testCase.id === view.selectedId) card.classList.add('selected');
  if (testCase.impact === 'changed' || testCase.impact === 'unrelated') {
    card.classList.add(`impact-${testCase.impact}`);
  }

  const l1 = node('span', 'l1');
  l1.append(node('span', 'cid', testCase.id));
  l1.append(techBadge(testCase.technique));
  l1.append(node('span', 'tgt', testCase.target));
  if (view.data?.fixtures.get(testCase.id)) {
    const fx = node('span', 'grpname', '🗃');
    fx.title = t('dg.fixture');
    l1.append(fx);
  }
  card.append(l1);

  const sp = node('span', 'sp');
  if (testCase.impact === 'changed') {
    sp.append(node('span', 'imp imp-changed', t('ui.impactChangedShort')));
  }
  sp.append(node('span', `prio prio-${testCase.priority}`, t('prio.' + testCase.priority)));
  card.append(sp);

  card.append(node('span', 'ttl', testCase.title));

  const l3 = node('span', 'l3');
  l3.append(node('span', 'dv', testCase.data));
  l3.append(node('span', 'arr', '→'));
  const ex = node('span', 'ex');
  ex.append(node('span', 'exv', testCase.expected));
  l3.append(ex);
  // The note goes on its own line across the whole card rather than under the
  // expected result. Sharing that column with a long value left it forty
  // pixels wide — "⚠ Type…" — which is not a warning, it is a rumour of one.
  if (testCase.notes) l3.append(node('span', 'note', `⚠ ${testCase.notes}`));
  card.append(l3);

  card.addEventListener('click', () => {
    view.selectedId = view.selectedId === testCase.id ? null : testCase.id;
    if (view.selectedId) view.inspOpen = true;
    saveUi();
    renderList();
    renderInspector();
    applyLayout();
  });
  return card;
}

/**
 * The case list, grouped by the `group` each technique tags its cases with.
 *
 * Grouping is not decoration: six boundary cases on one column are one idea,
 * and reading them as one block is what makes a list of forty cases reviewable
 * instead of merely long.
 */
export function renderList() {
  const rows = visibleCases();
  syncSearchCollapse();
  el.caseList.replaceChildren();
  el.caseList.classList.toggle('dense', view.density === 'dense');

  if (!rows.length) {
    el.empty.hidden = false;
    el.caseList.hidden = true;

    const hasQuery = !!view.current;
    const filtered = hasQuery && view.current.cases.length > 0;
    let titleKey, subKey;
    if (filtered) { titleKey = 'ui.noMatchTitle'; subKey = 'ui.noMatchSub'; }
    else if (hasQuery) { titleKey = 'ui.nothingTitle'; subKey = 'ui.nothingSub'; }
    else { titleKey = 'ui.emptyTitle'; subKey = 'ui.emptySub'; }
    el.empty.querySelector('.empty-title').textContent = t(titleKey);
    el.empty.querySelector('.empty-sub').textContent = t(subKey);
    // The three steps are an answer to "what do I do here", so they belong on
    // the blank page and nowhere else; a filtered-to-nothing list gets the one
    // button that undoes it instead.
    el.emptySteps.hidden = hasQuery;
    el.emptyClear.hidden = !filtered;
    return;
  }

  el.empty.hidden = true;
  el.caseList.hidden = false;

  const groups = [];
  const byName = new Map();
  rows.forEach(c => {
    const name = groupKeyOf(c);
    let g = byName.get(name);
    if (!g) { g = { name, items: [] }; byName.set(name, g); groups.push(g); }
    g.items.push(c);
  });

  // Heading and body are siblings, not parent and child — see the note on
  // .case-sect-head in the stylesheet: it is what keeps the band under the
  // command bar showing one whole heading instead of a sliced one.
  const frag = document.createDocumentFragment();
  groups.forEach((g, i) => {
    const open = !collapsedGroups.has(g.name);
    const bodyId = `case-group-${i}`;

    const head = node('button', 'case-sect-head');
    head.type = 'button';
    head.dataset.group = g.name;
    head.setAttribute('aria-expanded', String(open));
    head.setAttribute('aria-controls', bodyId);
    head.title = t(open ? 'ui.groupCollapse' : 'ui.groupExpand');
    head.append(node('span', 'caret', '▾'));
    head.append(node('span', 't', g.name));
    head.append(node('span', 'n', g.items.length));
    head.append(node('span', 'line'));
    head.addEventListener('click', (e) => toggleGroup(g.name, groups, e.shiftKey));

    const body = node('div', 'case-sect-body');
    body.id = bodyId;
    body.hidden = !open;
    g.items.forEach(c => body.append(caseCard(c)));

    frag.append(head, body);
  });
  el.caseList.append(frag);
}

/**
 * Shut or open one group — or, with Shift held, every group at once.
 *
 * Collapsing a block that sits above the pointer would otherwise haul the rest
 * of the list up under it, so the heading that was clicked is put back on the
 * pixel it was clicked on and the scroll offset absorbs the difference.
 */
function toggleGroup(name, groups, all) {
  const scroller = el.caseList.closest('.main');
  const wasAt = headOf(name)?.getBoundingClientRect().top;

  if (all) {
    const anyOpen = groups.some(g => !collapsedGroups.has(g.name));
    groups.forEach(g => (anyOpen ? collapsedGroups.add(g.name) : collapsedGroups.delete(g.name)));
  } else if (collapsedGroups.has(name)) {
    collapsedGroups.delete(name);
  } else {
    collapsedGroups.add(name);
  }

  renderList();

  const nowAt = headOf(name)?.getBoundingClientRect().top;
  if (scroller && wasAt !== undefined && nowAt !== undefined) scroller.scrollTop += nowAt - wasAt;
}

/** Open every group for the duration of a search; put them back afterwards. */
function syncSearchCollapse() {
  const searching = !!el.search.value.trim();
  if (searching && !view.collapsedBeforeSearch) {
    view.collapsedBeforeSearch = new Set(collapsedGroups);
    collapsedGroups.clear();
  } else if (!searching && view.collapsedBeforeSearch) {
    collapsedGroups.clear();
    view.collapsedBeforeSearch.forEach(name => collapsedGroups.add(name));
    view.collapsedBeforeSearch = null;
  }
}

function headOf(name) {
  return el.caseList.querySelector(`.case-sect-head[data-group="${CSS.escape(name)}"]`);
}
