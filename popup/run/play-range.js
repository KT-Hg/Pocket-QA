/**
 * run/play-range.js — ▶ on the action list's row numbers: play the scenario from
 * a step, up to a step, only that step, or (Shift+click a second number) the
 * steps between the two — on the page as it is, without the steps before.
 *
 * The worker plays the part (PLAY_RANGE, bg/playback.js startPlayRange). A Read
 * DOM or Screenshot → Variable step left out sets its variable only in a run, so
 * a part using that variable would find it empty: the user is asked, and may have
 * those steps played first (`prelude`).
 */

import { writtenVarNames } from '../../shared/var-name.js';
import { partSpan } from '../../shared/verdict.js';
import { actionsEl, scenarioList } from '../dom.js';
import { whenTabOn } from '../tab-activation.js';
import { getReadVarNames, showConfirm, showToast } from '../utils.js';

let _anchor = null; // the row number clicked first: Shift+click another plays the steps between
let _menu = null;

const _span = (from, to) => partSpan({ from, to });

function _closeMenu({ refocus = false } = {}) {
  if (!_menu) return;
  const opener = _menu.opener;
  _menu.remove();
  _menu = null;
  document.removeEventListener('pointerdown', _outside, true);
  if (refocus) opener?.focus();
}

function _outside(e) {
  if (_menu && !_menu.contains(e.target) && !e.target.closest?.('#actions li.action .index')) _closeMenu();
}

/**
 * The steps before `from` (1-based) that set a variable the part #from–#to
 * reads: { indices (0-based), names }.
 */
export function preludeFor(actions, from, to) {
  const reads = getReadVarNames(actions.slice(from - 1, to).filter((a) => !a.disabled));
  const indices = [], names = new Set();
  actions.slice(0, from - 1).forEach((a, i) => {
    if (a.disabled) return;
    const set = writtenVarNames(a).filter((n) => reads.has(n));
    if (!set.length) return;
    indices.push(i);
    set.forEach((n) => names.add(n));
  });
  return { indices, names: [...names] };
}

function _send(scenarioId, from, to, prelude) {
  whenTabOn(() => {
    chrome.runtime.sendMessage({ type: 'PLAY_RANGE', scenarioId, from, to, prelude });
    window.close();
  });
}

/** Play #from–#to of the selected scenario, asking first when it needs variables the steps before set. */
export function playRange(from, to) {
  _closeMenu();
  const scenarioId = scenarioList?.value;
  if (!scenarioId) { showToast('Select a saved scenario to play part of it', 'warn'); return; }
  chrome.runtime.sendMessage({ type: 'GET_PREVIEW_ACTIONS', scenarioId }, (res) => {
    const actions = res?.actions || [];
    if (!actions.length || to > actions.length) return;
    const { indices, names } = preludeFor(actions, from, to);
    if (!indices.length) { _send(scenarioId, from, to, []); return; }
    const steps = indices.map((i) => `#${i + 1}`).join(', ');
    const vars = names.map((n) => `\${${n}}`).join(', ');
    showConfirm(
      `Steps #1–#${from - 1} are left out, so the page must already be where #${from} expects it. `
      + `${steps} set ${vars} only in a run: left out, ${names.length === 1 ? 'it is' : 'they are'} empty.`,
      (first) => _send(scenarioId, from, to, first ? indices : []),
      { title: `Play ${_span(from, to)}?`, okLabel: `▶ Play ${_span(from, to)}`, check: { label: `Play ${steps} first (${indices.length === 1 ? 'it only reads' : 'they only read'} the page)`, checked: true } },
    );
  });
}

function _openMenu(li, indexEl) {
  _closeMenu();
  const n = Number(li.dataset.index) + 1;
  const total = actionsEl.querySelectorAll('li.action').length;
  const menu = document.createElement('div');
  menu.className = 'pr-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', `Play action ${n}`);
  const item = (text, title, from, to) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', () => playRange(from, to));
    return b;
  };
  const hint = document.createElement('div');
  hint.className = 'pr-hint';
  hint.textContent = `Shift+click another number: play #${n}–#…`;
  menu.append(
    item(`▶ Play from #${n}`, `Play #${n} to the end, on the page as it is now`, n, total),
    item(`▶ Play #1–#${n}`, `Play from the start up to #${n}, then stop — the page stays as #${n} left it`, 1, n),
    item(`▶ Play only #${n}`, `Play #${n} alone`, n, n),
    hint,
  );
  menu.opener = indexEl;
  document.body.append(menu);
  const r = indexEl.getBoundingClientRect();
  const left = Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${r.bottom + window.scrollY + 4}px`;
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button')];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); _closeMenu({ refocus: true }); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
  });
  _menu = menu;
  document.addEventListener('pointerdown', _outside, true);
  menu.querySelector('button').focus();
}

function _activate(indexEl, shift) {
  const li = indexEl.closest('li.action');
  if (!li || !actionsEl.contains(li)) return;
  const n = Number(li.dataset.index) + 1;
  if (shift && _anchor && _anchor !== n) {
    const [from, to] = _anchor < n ? [_anchor, n] : [n, _anchor];
    _clearAnchor();
    playRange(from, to);
    return;
  }
  _clearAnchor();
  _anchor = n;
  li.classList.add('pr-anchor');
  _openMenu(li, indexEl);
}

function _clearAnchor() {
  _anchor = null;
  actionsEl?.querySelectorAll('li.pr-anchor').forEach((el) => el.classList.remove('pr-anchor'));
}

export function initPlayRange() {
  if (!actionsEl) return;
  actionsEl.addEventListener('click', (e) => {
    const indexEl = e.target.closest('li.action > .index');
    if (!indexEl || !scenarioList?.value) return;
    e.stopPropagation();
    _activate(indexEl, e.shiftKey);
  });
  actionsEl.addEventListener('keydown', (e) => {
    const indexEl = e.target.closest?.('li.action > .index');
    if (!indexEl || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    if (scenarioList?.value) _activate(indexEl, e.shiftKey);
  });
}
