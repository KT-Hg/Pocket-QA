/**
 * ui/json-view.js — a JSON body laid out exactly as JSON.stringify(v, null, 2)
 * lays it out, with every key a button. Clicking one hands its path segments
 * and value to `onKey`, which offers a menu (showMenu): add a check on it, or
 * save it into a variable. Someone who does not write code builds a check by
 * clicking, not by typing `data.items[0].id`.
 */

import { h } from './dom.js';

// Past this many values the body stays plain text: thousands of buttons would slow the page.
export const MAX_NODES = 5000;

const TOO_BIG = Symbol('too big');

function literal(v) {
  if (typeof v === 'string') return h('span', { class: 'ac-jstr' }, JSON.stringify(v));
  if (typeof v === 'number') return h('span', { class: 'ac-jnum' }, JSON.stringify(v));
  return h('span', { class: 'ac-jlit' }, JSON.stringify(v));
}

/**
 * A <pre> of `value` with its keys clickable, or null when it holds more than
 * MAX_NODES values. `onKey(segs, value, button)`.
 */
export function jsonView(value, onKey) {
  const out = [];
  let nodes = 0;
  const pad = (n) => '  '.repeat(n);

  function each(entries, open, close, depth, keyed) {
    if (!entries.length) { out.push(open + close); return; }
    out.push(`${open}\n`);
    entries.forEach(([seg, v, segs], i) => {
      out.push(pad(depth + 1));
      if (keyed) {
        out.push(h('button', { type: 'button', class: 'ac-jkey', title: 'Check it, or save it into a variable',
          onclick: (e) => onKey(segs, v, e.currentTarget) }, JSON.stringify(seg)), ': ');
      }
      walk(v, segs, depth + 1);
      out.push(i < entries.length - 1 ? ',\n' : '\n');
    });
    out.push(pad(depth) + close);
  }

  function walk(v, segs, depth) {
    if (++nodes > MAX_NODES) throw TOO_BIG;
    if (Array.isArray(v)) each(v.map((x, i) => [i, x, [...segs, i]]), '[', ']', depth, false);
    else if (v !== null && typeof v === 'object') each(Object.keys(v).map((k) => [k, v[k], [...segs, k]]), '{', '}', depth, true);
    else out.push(literal(v));
  }

  try {
    walk(value, [], 0);
  } catch (e) {
    if (e === TOO_BIG) return null;
    throw e;
  }
  return h('pre', { class: 'ac-pre ac-json' }, ...out);
}

let openMenu = null;

function closeMenu() {
  openMenu?.remove();
  openMenu = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onMenuKey, true);
  removeEventListener('scroll', closeMenu, true);
}
function onOutside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
function onMenuKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }

/** A small menu under `anchor`: [{ label, run }]. One at a time; closes on a pick, a click outside, Escape or scrolling. */
export function showMenu(anchor, items) {
  closeMenu();
  const r = anchor.getBoundingClientRect();
  openMenu = h('div', { class: 'ac-keymenu', role: 'menu' },
    ...items.map((it) => h('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); it.run(); } }, it.label)));
  openMenu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 260))}px`;
  openMenu.style.top = `${r.bottom + 4}px`;
  document.body.append(openMenu);
  openMenu.querySelector('button')?.focus({ preventScroll: true });
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onMenuKey, true);
  addEventListener('scroll', closeMenu, true);
}
