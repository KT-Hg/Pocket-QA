/**
 * recent.js — Recent captures in the Capture tab: the last captures taken
 * (shared/recent-captures.js), newest first, and what a click on one offers:
 * Copy, Edit, Save again, Compare with…, Remove.
 *
 * The worker adds every capture the user takes (bg/screenshot/after-capture.js);
 * this module only reads, copies, removes and clears. The popup is a focused,
 * secure page, so its Copy always works — the way out when a page could not
 * copy a capture itself.
 */

import { listRecent, getRecent, removeRecent, clearRecent, blobToDataUrl } from '../../shared/recent-captures.js';
import { buildDateFolder } from '../../bg/screenshot/filename.js';
import { showToast, showConfirm } from '../utils.js';
import { openDiffWith } from './diff.js';

// Two rows of three until Show all.
const SHOWN = 6;
const MB = 1024 * 1024;

let _showAll = false;
let _comparing = null;   // the id picked first for Compare with…
let _menu = null;
let _urls = [];          // thumbnail object URLs, revoked on the next render

/** Put a kept capture on the clipboard; rejects with a reason. */
export async function copyRecentToClipboard(id) {
  const shot = await getRecent(id);
  if (!shot) throw new Error('that capture is no longer kept');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': shot.blob })]);
}

const time = (at) => new Date(at).toTimeString().slice(0, 5);
const label = (s) => `${s.kind} · ${time(s.at)}`;

async function render() {
  const box = document.getElementById('recentCaptures');
  const grid = document.getElementById('recentGrid');
  if (!box || !grid) return;
  const shots = await listRecent().catch(() => []);
  _urls.forEach((u) => URL.revokeObjectURL(u));
  _urls = [];
  box.hidden = !shots.length;
  if (!shots.length) { _comparing = null; return; }
  const bytes = shots.reduce((n, s) => n + s.size, 0);
  document.getElementById('recentStats').textContent = `${shots.length} · ${(bytes / MB).toFixed(1)} MB`;
  grid.replaceChildren(...(_showAll ? shots : shots.slice(0, SHOWN)).map((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'recent-shot' + (s.id === _comparing ? ' picked' : '');
    b.dataset.id = s.id;
    b.title = `${s.name || label(s)} — ${s.w}×${s.h}`;
    const img = document.createElement('img');
    const url = URL.createObjectURL(s.thumb);
    _urls.push(url);
    img.src = url;
    img.alt = '';
    const cap = document.createElement('span');
    cap.textContent = label(s);
    b.append(img, cap);
    return b;
  }));
  const more = document.getElementById('recentMore');
  more.hidden = shots.length <= SHOWN;
  more.textContent = _showAll ? 'Show fewer' : `Show all ${shots.length}`;
  _hint(_comparing != null ? 'Pick the capture to compare it with — Esc to stop' : '');
}

function _hint(text) {
  const h = document.getElementById('recentHint');
  h.textContent = text;
  h.hidden = !text;
}

function _closeMenu() {
  _menu?.remove();
  _menu = null;
}

function _openMenu(btn, shot) {
  _closeMenu();
  const menu = document.createElement('div');
  menu.className = 'pr-menu recent-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label(shot));
  const head = document.createElement('div');
  head.className = 'pr-hint';
  head.textContent = `${label(shot)} · ${shot.w}×${shot.h}`;
  menu.append(head);
  const item = (text, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = text;
    b.addEventListener('click', () => { _closeMenu(); fn(); });
    menu.append(b);
  };
  const id = shot.id;
  item('📋 Copy', () => copyRecentToClipboard(id).then(() => showToast('Copied to clipboard', 'success'), (e) => showToast(`Not copied: ${e.message}`, 'error')));
  item('✂ Edit', () => _edit(id));
  item('⬇ Save again', () => _saveAgain(id));
  item('🔍 Compare with…', () => { _comparing = id; render(); });
  item('🗑 Remove', () => removeRecent(id).then(render));
  document.body.append(menu);
  const r = btn.getBoundingClientRect();
  const left = Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${r.bottom + window.scrollY + 4}px`;
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button')];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); _closeMenu(); btn.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
  });
  _menu = menu;
  menu.querySelector('button').focus();
}

async function _edit(id) {
  const shot = await getRecent(id);
  if (!shot) { showToast('That capture is no longer kept', 'error'); return; }
  chrome.runtime.sendMessage({ type: 'OPEN_IMAGE_EDITOR', dataUrl: await blobToDataUrl(shot.blob), sourceFileName: shot.name || `${shot.kind}.png` });
}

/** Download it again, the way the Settings say captures are saved. */
async function _saveAgain(id) {
  const shot = await getRecent(id);
  if (!shot) { showToast('That capture is no longer kept', 'error'); return; }
  const { screenshotSaveMode } = await chrome.storage.sync.get('screenshotSaveMode');
  const ask = screenshotSaveMode === 'ask';
  const name = shot.name || `screenshot_${shot.kind.toLowerCase()}.png`;
  chrome.downloads.download({
    url: await blobToDataUrl(shot.blob), saveAs: ask,
    filename: ask ? name : `screenshots/${buildDateFolder()}/${name}`,
  }, (dl) => {
    if (dl == null) showToast(/cancel/i.test(chrome.runtime.lastError?.message || '') ? 'Save cancelled' : 'Save failed', 'warn');
    else showToast(`Saved again: ${name}`, 'success');
  });
}

async function _compare(idA, idB) {
  _comparing = null;
  render();
  const [a, b] = await Promise.all([getRecent(idA), getRecent(idB)]);
  if (!a || !b) { showToast('That capture is no longer kept', 'error'); return; }
  openDiffWith(
    { dataUrl: await blobToDataUrl(a.blob), name: label(a) },
    { dataUrl: await blobToDataUrl(b.blob), name: label(b) },
  );
}

export function initRecent() {
  const box = document.getElementById('recentCaptures');
  if (!box) return;
  render();
  // A capture taken while the popup is open joins the strip at once.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'SCREENSHOT_RESULT' && msg.result?.recentId != null) render();
  });
  box.addEventListener('click', async (e) => {
    if (e.target.closest('#recentMore')) { _showAll = !_showAll; render(); return; }
    if (e.target.closest('#recentClear')) {
      showConfirm('Forget every recent capture? The saved files stay where they are.', () => clearRecent().then(render),
        { title: 'Clear recent captures', danger: true, okLabel: 'Clear' });
      return;
    }
    const btn = e.target.closest('.recent-shot');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (_comparing != null && _comparing !== id) { _compare(_comparing, id); return; }
    if (_comparing === id) { _comparing = null; render(); return; }
    const shot = (await listRecent()).find((s) => s.id === id);
    if (shot) _openMenu(btn, shot);
  });
  document.addEventListener('pointerdown', (e) => {
    if (_menu && !_menu.contains(e.target) && !e.target.closest('.recent-shot')) _closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _comparing != null && !_menu) { _comparing = null; render(); }
  });
}
