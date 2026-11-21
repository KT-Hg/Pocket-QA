/**
 * diff.js — Image Diff in the Capture tab.
 *
 * Two pictures — two files, or two Recent captures (openDiffWith) — compared in
 * the worker (COMPARE_SCREENSHOTS, bg/screenshot/diff.js) and shown four ways:
 *   Pink           the diff picture: changed pixels magenta, the rest dimmed
 *   Drag           B under A, A cut at a line moved by dragging on the picture
 *                  (or ← / →): no slider of its own
 *   Blink          A and B in turn
 *   Side by side
 * Pictures of two sizes are compared over the area they share, and a line says so.
 * Boxes drawn on the Pink picture (a clock, an ad) are left out of the comparison
 * and remembered for that pair of sizes: two shots of one page put the clock in
 * the same place.
 */

import { showToast } from '../utils.js';
import { updateRangeFill } from '../settings.js';

const IGNORE_KEY = 'diffIgnore_v1';
const IGNORE_KEEP = 20;      // pairs of sizes remembered
const BLINK_MS = 600;
const DRAG_STEP = 5;         // percent per arrow key
const MIN_BOX_PX = 4;        // a smaller drag is a click, not a box

let _a = null;               // { dataUrl, name, w, h }
let _b = null;
let _res = null;
let _view = 'pink';
let _boxes = [];
let _boxMode = false;
let _blink = 0;
let _split = 50;
const $ = (id) => document.getElementById(id);

const sizeKey = () => `${_a.w}x${_a.h}|${_b.w}x${_b.h}`;

async function _withSize(src) {
  const bmp = await createImageBitmap(await (await fetch(src.dataUrl)).blob());
  const out = { ...src, w: bmp.width, h: bmp.height };
  bmp.close();
  return out;
}

async function _loadBoxes() {
  const all = (await chrome.storage.local.get(IGNORE_KEY))[IGNORE_KEY] || {};
  return all[sizeKey()]?.boxes || [];
}

async function _saveBoxes() {
  const all = (await chrome.storage.local.get(IGNORE_KEY))[IGNORE_KEY] || {};
  if (_boxes.length) all[sizeKey()] = { boxes: _boxes, at: Date.now() };
  else delete all[sizeKey()];
  const keep = Object.entries(all).sort((x, y) => y[1].at - x[1].at).slice(0, IGNORE_KEEP);
  await chrome.storage.local.set({ [IGNORE_KEY]: Object.fromEntries(keep) });
}

function _readFile(input) {
  return new Promise((resolve, reject) => {
    const f = input?.files?.[0];
    if (!f) { reject(new Error('Pick two images first')); return; }
    const r = new FileReader();
    r.onload = () => resolve({ dataUrl: r.result, name: f.name });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

/** Open Image Diff on two pictures ({ dataUrl, name }) and compare them at once. */
export async function openDiffWith(a, b) {
  _open();
  $('diffFiles').hidden = true;
  $('diffSources').hidden = false;
  $('diffNameA').textContent = a.name;
  $('diffNameB').textContent = b.name;
  [_a, _b] = await Promise.all([_withSize(a), _withSize(b)]);
  _boxes = await _loadBoxes();
  _compare();
}

function _open() {
  _a = _b = _res = null;
  _boxes = [];
  _boxMode = false;
  _view = 'pink';
  $('diffFiles').hidden = false;
  $('diffSources').hidden = true;
  $('diffResult').style.display = 'none';
  $('diffModal').classList.add('show');
}

function _close() {
  clearInterval(_blink);
  $('diffModal').classList.remove('show');
}

async function _compare() {
  const run = $('diffRun');
  run.disabled = true; run.textContent = 'Comparing…';
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'COMPARE_SCREENSHOTS', dataUrlA: _a.dataUrl, dataUrlB: _b.dataUrl,
      threshold: parseInt($('diffThreshold').value || '10', 10), ignore: _boxes, sharedOnly: $('diffShared').checked,
    });
    if (res?.error) { showToast(res.error, 'error'); return; }
    _res = res;
    _show();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    run.disabled = false; run.textContent = '▶ Compare';
  }
}

function _show() {
  const { sizeA, sizeB } = _res;
  $('diffResult').style.display = '';
  const differ = sizeA.w !== sizeB.w || sizeA.h !== sizeB.h;
  const warn = $('diffSizeWarn');
  warn.hidden = !differ;
  if (differ) {
    const shared = $('diffShared').checked;
    warn.textContent = `⚠ Sizes differ: A ${sizeA.w}×${sizeA.h}, B ${sizeB.w}×${sizeB.h} — `
      + (shared ? `only the shared ${Math.min(sizeA.w, sizeB.w)}×${Math.min(sizeA.h, sizeB.h)} is compared` : 'the part only one has counts as changed');
  }
  $('diffShared').closest('label').hidden = !differ;
  const ignored = _boxes.length ? ` · ${_boxes.length} box${_boxes.length > 1 ? 'es' : ''} left out` : '';
  $('diffStats').textContent = `Diff: ${_res.changed.toLocaleString()} px (${_res.pct}% of the area compared)${ignored}`;
  $('diffIgnoreList').replaceChildren(..._boxes.map((b, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'diff-box-chip';
    chip.dataset.box = i;
    chip.title = 'Compare this box again';
    chip.textContent = `${b.w}×${b.h} at ${b.x},${b.y} ✕`;
    return chip;
  }));
  $('diffIgnoreBtn').classList.toggle('on', _boxMode);
  $('diffIgnoreBtn').textContent = _boxMode ? 'Drag a box on the picture…' : '▭ Leave a box out';
  document.querySelectorAll('#diffViews [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === _view)));
  _paintStage();
}

function _img(src, cls = '') {
  const i = document.createElement('img');
  i.src = src;
  i.alt = '';
  i.draggable = false;
  if (cls) i.className = cls;
  return i;
}

function _paintStage() {
  clearInterval(_blink);
  const stage = $('diffStage');
  stage.className = `diff-stage view-${_view}${_boxMode ? ' drawing' : ''}`;
  stage.replaceChildren();
  // B drawn to A's scale, so the two line up whatever their sizes.
  const bWidth = `${(_b.w / _a.w) * 100}%`;
  if (_view === 'pink') {
    const pic = document.createElement('div');
    pic.className = 'diff-pic';
    pic.append(_img(_res.diffUrl));
    // The diff picture is A's size (or the shared part): boxes are A's pixels.
    const dw = $('diffShared').checked ? Math.min(_a.w, _b.w) : Math.max(_a.w, _b.w);
    const dh = $('diffShared').checked ? Math.min(_a.h, _b.h) : Math.max(_a.h, _b.h);
    pic.dataset.w = dw;
    pic.dataset.h = dh;
    for (const b of _boxes) pic.append(_boxEl(b, dw, dh));
    stage.append(pic);
  } else if (_view === 'side') {
    for (const [s, l] of [[_a, 'A'], [_b, 'B']]) {
      const f = document.createElement('figure');
      f.append(_img(s.dataUrl), Object.assign(document.createElement('figcaption'), { textContent: `${l} · ${s.name}` }));
      stage.append(f);
    }
  } else {
    const pic = document.createElement('div');
    pic.className = 'diff-pic';
    const under = _img(_b.dataUrl);
    under.style.width = bWidth;
    const over = _img(_a.dataUrl, 'diff-over');
    pic.append(under, over);
    if (_view === 'drag') {
      const line = document.createElement('span');
      line.className = 'diff-line';
      pic.append(line, Object.assign(document.createElement('span'), { className: 'diff-tag a', textContent: 'A' }),
        Object.assign(document.createElement('span'), { className: 'diff-tag b', textContent: 'B' }));
      _setSplit(_split, pic);
    } else {
      const tag = Object.assign(document.createElement('span'), { className: 'diff-tag a', textContent: 'A' });
      pic.append(tag);
      let showA = true;
      _blink = setInterval(() => {
        showA = !showA;
        over.style.visibility = showA ? '' : 'hidden';
        tag.textContent = showA ? 'A' : 'B';
      }, BLINK_MS);
    }
    stage.append(pic);
  }
}

function _boxEl(b, dw, dh) {
  const el = document.createElement('span');
  el.className = 'diff-box';
  Object.assign(el.style, { left: `${(b.x / dw) * 100}%`, top: `${(b.y / dh) * 100}%`, width: `${(b.w / dw) * 100}%`, height: `${(b.h / dh) * 100}%` });
  return el;
}

function _setSplit(pct, pic = $('diffStage').querySelector('.diff-pic')) {
  _split = Math.max(0, Math.min(100, pct));
  if (!pic) return;
  pic.querySelector('.diff-over').style.clipPath = `inset(0 ${100 - _split}% 0 0)`;
  pic.querySelector('.diff-line').style.left = `${_split}%`;
}

/** Pointer position on the picture as a fraction of it, clamped. */
function _at(e, pic) {
  const r = pic.getBoundingClientRect();
  return { fx: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), fy: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
}

function _wireStage() {
  const stage = $('diffStage');
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    const pic = stage.querySelector('.diff-pic');
    if (!pic || e.button !== 0) return;
    if (_view === 'drag') {
      drag = { pic, kind: 'split' };
      _setSplit(_at(e, pic).fx * 100, pic);
    } else if (_view === 'pink' && _boxMode) {
      const p = _at(e, pic);
      const ghost = document.createElement('span');
      ghost.className = 'diff-box ghost';
      pic.append(ghost);
      drag = { pic, kind: 'box', p, ghost };
    } else return;
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const q = _at(e, drag.pic);
    if (drag.kind === 'split') { _setSplit(q.fx * 100, drag.pic); return; }
    const { p, ghost } = drag;
    Object.assign(ghost.style, {
      left: `${Math.min(p.fx, q.fx) * 100}%`, top: `${Math.min(p.fy, q.fy) * 100}%`,
      width: `${Math.abs(q.fx - p.fx) * 100}%`, height: `${Math.abs(q.fy - p.fy) * 100}%`,
    });
    drag.q = q;
  });
  stage.addEventListener('pointerup', () => {
    const d = drag;
    drag = null;
    if (!d || d.kind !== 'box') return;
    d.ghost.remove();
    if (!d.q) return;
    const dw = +d.pic.dataset.w, dh = +d.pic.dataset.h;
    const box = {
      x: Math.round(Math.min(d.p.fx, d.q.fx) * dw), y: Math.round(Math.min(d.p.fy, d.q.fy) * dh),
      w: Math.round(Math.abs(d.q.fx - d.p.fx) * dw), h: Math.round(Math.abs(d.q.fy - d.p.fy) * dh),
    };
    if (box.w < MIN_BOX_PX || box.h < MIN_BOX_PX) return;
    _boxes.push(box);
    _boxMode = false;
    _saveBoxes();
    _compare();
  });
  stage.addEventListener('keydown', (e) => {
    if (_view !== 'drag' || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    _setSplit(_split + (e.key === 'ArrowRight' ? DRAG_STEP : -DRAG_STEP));
  });
}

export function initDiff() {
  const modal = $('diffModal');
  if (!modal) return;
  const slider = $('diffThreshold');
  slider?.addEventListener('input', () => { $('diffThresholdVal').textContent = slider.value; updateRangeFill(slider); });
  if (slider) updateRangeFill(slider);

  $('diffScreenshots')?.addEventListener('click', _open);
  $('diffClose')?.addEventListener('click', _close);
  $('diffPickFiles')?.addEventListener('click', () => { $('diffFiles').hidden = false; $('diffSources').hidden = true; _a = _b = null; });
  $('diffRun')?.addEventListener('click', async () => {
    try {
      if (!$('diffFiles').hidden || !_a) {
        const [a, b] = await Promise.all([_readFile($('diffFileA')), _readFile($('diffFileB'))]);
        [_a, _b] = await Promise.all([_withSize(a), _withSize(b)]);
        _boxes = await _loadBoxes();
      }
      _compare();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
  $('diffShared')?.addEventListener('change', () => { if (_res) _compare(); });
  $('diffViews')?.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]')?.dataset.view;
    if (!v || !_res) return;
    _view = v;
    if (v !== 'pink') _boxMode = false;
    _show();
  });
  $('diffIgnoreBtn')?.addEventListener('click', () => {
    if (!_res) return;
    _boxMode = !_boxMode;
    _view = 'pink';
    _show();
  });
  $('diffIgnoreList')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-box]');
    if (!chip) return;
    _boxes.splice(Number(chip.dataset.box), 1);
    _saveBoxes();
    _compare();
  });
  $('diffDownload')?.addEventListener('click', () => {
    if (!_res) return;
    const link = document.createElement('a');
    link.href = _res.diffUrl; link.download = `diff_${Date.now()}.png`; link.click();
  });
  _wireStage();
}
