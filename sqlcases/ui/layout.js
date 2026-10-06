/**
 * ui/layout.js — the three-column layout: rail and insight tabs, open / shut
 * panes, density, the command bar height.
 */

import { t } from '../i18n.js';
import { INSIGHT_PANES, RAIL_PANES, el, node } from './dom.js';
import { renderTriage } from './filters.js';
import { renderInspector } from './inspector.js';
import { renderList } from './list.js';
import { insight, view } from './state.js';
import { UI_KEY, storageSet } from './storage.js';
import { valueCount } from './values-panel.js';

export function saveUi() {
  storageSet({ [UI_KEY]: { railTab: view.railTab, railOpen: view.railOpen, inspOpen: view.inspOpen, insightTab: view.insightTab, insightOpen: view.insightOpen, density: view.density } });
}

export function applyUiState(state) {
  if (!state) return;
  if (RAIL_PANES[state.railTab]) view.railTab = state.railTab;
  if (typeof state.railOpen === 'boolean') view.railOpen = state.railOpen;
  if (typeof state.inspOpen === 'boolean') view.inspOpen = state.inspOpen;
  if (INSIGHT_PANES[state.insightTab]) view.insightTab = state.insightTab;
  if (typeof state.insightOpen === 'boolean') view.insightOpen = state.insightOpen;
  if (state.density === 'dense' || state.density === 'full') view.density = state.density;
}

// ---- rendering: the tabbed shells ------------------------------------

export function renderRail() {
  const enabledTechs = [...el.techList.querySelectorAll('input[data-tech]')].filter(b => b.checked).length;
  el.railTechCount.textContent = enabledTechs || '';
  el.railValuesCount.textContent = valueCount || '';
  el.railSchemaCount.textContent = view.data?.schema.tables.length || '';

  // A tab with nothing behind it is not shown at all: an empty Schema pane
  // teaches nothing, and the two that come and go are exactly the two that
  // depend on a successful run.
  const has = { sql: true, tech: true, values: valueCount > 0, schema: !!view.data?.schema.tables.length };
  // Resolved before anything is marked active: a run that empties the pane you
  // were on has to move you off it, and marking the old tab active first would
  // leave the row with no active tab at all.
  if (!has[view.railTab]) view.railTab = 'sql';

  el.railTabs.querySelectorAll('.rtab').forEach(btn => {
    const key = btn.dataset.rt;
    btn.hidden = !has[key];
    btn.classList.toggle('active', key === view.railTab);
  });

  Object.entries(RAIL_PANES).forEach(([key, pane]) => {
    if (pane) pane.hidden = key !== view.railTab;
  });
}

export function renderInsight() {
  const tabs = el.insightTabs.querySelectorAll('.itab');
  let anyAvailable = false;

  tabs.forEach(btn => {
    const key = btn.dataset.it;
    const state = insight[key];
    const available = !!state?.available;
    btn.hidden = !available;
    if (available) anyAvailable = true;
  });

  el.itabDiffN.textContent = insight.diff.count || '';
  el.itabFindingsN.textContent = insight.findings.count || '';
  el.itabCoverageN.textContent = insight.coverage.count || '';
  el.itabStaleN.textContent = insight.stale.count || '';
  el.findingsDot.className = `dot${insight.findings.level ? ' dot-' + insight.findings.level : ''}`;

  if (!anyAvailable) {
    el.insight.hidden = true;
    return;
  }
  el.insight.hidden = false;

  // Fall back to the first tab that has something, so a run that removes the
  // panel you were reading lands somewhere real rather than on a blank body.
  // Never mid-run, though: see insightSettling.
  if (!view.insightSettling && !insight[view.insightTab]?.available) {
    const first = [...tabs].find(b => !b.hidden);
    view.insightTab = first ? first.dataset.it : '';
  }

  tabs.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.it === view.insightTab && view.insightOpen);
  });
  Object.entries(INSIGHT_PANES).forEach(([key, pane]) => {
    if (pane) pane.hidden = key !== view.insightTab;
  });
  el.insight.classList.toggle('collapsed', !view.insightOpen);
  el.insightToggle.textContent = view.insightOpen ? '▴' : '▾';
}

/**
 * Apply the two column toggles.
 *
 * `insp-open` is separate from `insp-off` because below 1240px the inspector
 * stops being a column and becomes an overlay: there it must slide in only
 * when there is a case to show, or it would cover the list it was opened from.
 */
export function applyLayout() {
  el.app.classList.toggle('rail-off', !view.railOpen);
  el.app.classList.toggle('insp-off', !view.inspOpen);
  el.app.classList.toggle('insp-open', view.inspOpen && !!view.selectedId);
  // Mirrored onto <body> too: the topbar sits above .app, not inside it, and
  // needs the same closed-panel gutter (see .topbar rules in sqlcases.css).
  document.body.classList.toggle('rail-off', !view.railOpen);
  document.body.classList.toggle('insp-off', !view.inspOpen);

  const existing = el.app.querySelector('.rail-reopen');
  if (existing) existing.remove();
  if (!view.railOpen) {
    const b = node('button', 'rail-reopen');
    b.type = 'button';
    b.textContent = t('ui.railReopen');
    b.addEventListener('click', () => { view.railOpen = true; saveUi(); applyLayout(); });
    el.app.append(b);
  }

  // Opening a column narrows the middle one, which is what wraps the technique
  // pills onto another line. Saying so here rather than waiting to be told is
  // the difference between the group headings parking under the command bar
  // and parking a pill row's worth of empty band below it.
  scheduleCmdHeight();
}

export function initLayoutControls() {
  const toggleRail = () => { view.railOpen = !view.railOpen; saveUi(); applyLayout(); };
  el.railToggle.addEventListener('click', toggleRail);
  el.railClose.addEventListener('click', toggleRail);

  el.inspToggle.addEventListener('click', () => {
    view.inspOpen = !view.inspOpen;
    saveUi();
    applyLayout();
  });

  el.railTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.rtab');
    if (!btn) return;
    view.railTab = btn.dataset.rt;
    saveUi();
    renderRail();
  });

  el.insightTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.itab');
    if (btn) {
      // Clicking the tab you are already reading closes the block: it is the
      // same gesture the accordions had, and the one that gets the height back.
      if (btn.dataset.it === view.insightTab && view.insightOpen) view.insightOpen = false;
      else { view.insightTab = btn.dataset.it; view.insightOpen = true; }
      saveUi();
      renderInsight();
      renderTriage();
      return;
    }
    if (e.target.closest('#btnInsight')) {
      view.insightOpen = !view.insightOpen;
      saveUi();
      renderInsight();
      renderTriage();
    }
  });

  el.triage.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tri]');
    if (!btn) return;
    const key = btn.dataset.tri;
    if (key === 'stale') {
      // Stale cases are not in the list, so this box opens the only panel that
      // holds them rather than filtering a list they were never part of.
      view.insightTab = 'stale';
      view.insightOpen = true;
      renderInsight();
    } else {
      view.activeImpact = view.activeImpact === key ? '' : key;
      view.selectedId = null;
      renderList();
      renderInspector();
    }
    saveUi();
    renderTriage();
  });

  el.density.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-d]');
    if (!btn) return;
    view.density = btn.dataset.d;
    el.density.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    saveUi();
    renderList();
  });
}

/**
 * Keep --cmd-h in step with the docked command bar's real height.
 *
 * The group headings in the list park directly under the bar, and the bar is
 * not a fixed height: the technique pills wrap onto a second line on a narrow
 * window, and onto a third in Vietnamese. Every pixel this number is wrong by
 * is a pixel of the list showing in the band between the bar and the headings,
 * or a pixel of heading hidden behind the bar, so it has to be exact — no
 * rounding, and no waiting for the next thing to happen before it catches up.
 *
 * One ResizeObserver is not enough on its own. When a rewrap is set off by a
 * width change elsewhere in the shell — opening the inspector, dragging the
 * window narrower — the observation that arrives can still describe the bar as
 * it was, leaving the number a full pill row (20-30px) short until something
 * else disturbs it. So every trigger re-measures twice, once now and once on
 * the next frame when layout has certainly settled, and a scroll re-measures
 * as well: the band is only ever looked at while the list is moving, which
 * makes a scroll the last chance to notice and the cheapest place to check.
 */
function publishCmdHeight() {
  const h = el.cmdbarDock.hidden ? 0 : el.cmdbarDock.getBoundingClientRect().height;
  const shell = el.cmdbarDock.parentElement;
  const next = `${h.toFixed(2)}px`;
  if (shell.style.getPropertyValue('--cmd-h') !== next) shell.style.setProperty('--cmd-h', next);
}

let cmdHeightFrame = 0;

/** Measure now, and again next frame in case this one caught layout mid-flight. */
export function scheduleCmdHeight() {
  publishCmdHeight();
  cancelAnimationFrame(cmdHeightFrame);
  cmdHeightFrame = requestAnimationFrame(publishCmdHeight);
}

export function trackCmdbarHeight() {
  scheduleCmdHeight();
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(scheduleCmdHeight);
    observer.observe(el.cmdbarDock);
    observer.observe(el.cmdbar);
  }
  window.addEventListener('resize', scheduleCmdHeight);
  // Measured on the spot rather than deferred to the next frame: a scroll
  // handler runs before the frame it belongs to is painted, so correcting the
  // number here means the band is right in the very frame the reader sees. It
  // is one rect read per scrolled frame, and it writes only when the number
  // has actually moved.
  el.cmdbarDock.parentElement.addEventListener('scroll', publishCmdHeight, { passive: true });
}
