/**
 * run/run-history.js — the last runs of the Last run card's scenario, as dots
 * (RUN_HISTORY_KEY, kept by bg/playback.js), what they say together (Flaky? or
 * failing since a run — shared/run-history.js), one run's line when its dot is
 * clicked, and the All runs window.
 */

import { HISTORY_WINDOW, historyVerdict } from '../../shared/run-history.js';
import { tallyText, verdictLabel } from '../../shared/verdict.js';
import { attachModalKeyHandlers, closeModal, openModal } from '../ui/modal.js';

const MODAL = 'runHistoryModal';
const HOW = { play: '▶ Play', schedule: '⏰ Schedule', resume: '↻ Resume', sequence: '⏭ Sequence', csv: '▦ CSV' };

/** "Thu 16 Nov, 09:00". */
const _when = (t) => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
/** "12.4 s", "2 min 5 s". */
function _took(e) {
  const s = Math.max(0, (e.endedAt - e.startedAt) / 1000);
  return s < 60 ? `${Math.round(s * 10) / 10} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}
const _how = (e) => (e.how === 'csv' && e.rows ? `${HOW.csv} · ${tallyText(e.rows)}` : HOW[e.how] || e.how || '');
const _result = (e) => verdictLabel(e.status, e);
/** "✗ #4 Toast — Expected …", with the CSV row it was in. */
const _first = (e) => (e.first
  ? `${e.first.kind === 'assert' ? '✗' : '⚠'} #${e.first.index}${e.first.row ? ` (row ${e.first.row})` : ''} ${e.first.label} — ${e.first.reason}`
  : '');
const _bad = (e) => e.status === 'failed' || e.status === 'broken';

function _summary(shown) {
  const bad = shown.filter(_bad).length;
  if (bad) return `${bad} of the last ${shown.length} failed`;
  return shown.every((e) => e.status === 'passed') ? `Passed the last ${shown.length}` : `None of the last ${shown.length} failed`;
}

function _flag(entries) {
  const v = historyVerdict(entries);
  if (v.kind === 'flaky') {
    const what = v.step ? `#${v.step.index} ${v.step.label} failed ${v.step.count}` : `It failed ${v.failed}`;
    return `〰 Flaky? ${what} of the last ${v.runs} runs, and passed again with the same steps.`;
  }
  if (v.kind === 'broke') {
    return `⤵ Failing since ${_when(v.since)}: ${v.inRow} runs in a row, after ${v.passedBefore} passes.`;
  }
  return '';
}

/** The card's dots and lines for the runs of its scenario (`entries`, oldest first). */
export function renderHistory(entries) {
  const strip = document.getElementById('lastRunHistory');
  const flag = document.getElementById('lastRunHistFlag');
  const detail = document.getElementById('lastRunHistDetail');
  if (!strip || !flag || !detail) return;
  const shown = (entries || []).slice(-HISTORY_WINDOW);
  // One run is the card itself: dots begin with the second.
  strip.hidden = shown.length < 2;
  detail.hidden = true;
  const said = strip.hidden ? '' : _flag(entries);
  flag.hidden = !said;
  flag.textContent = said;
  if (strip.hidden) return;
  const dots = shown.map((e, k) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lr-dot';
    b.dataset.status = e.status;
    b.title = `${_result(e)} · ${_how(e)} · ${_when(e.endedAt)}`;
    b.setAttribute('aria-label', `Run ${k + 1} of ${shown.length}: ${b.title}`);
    b.addEventListener('click', () => {
      for (const d of strip.querySelectorAll('.lr-dot')) d.classList.toggle('sel', d === b);
      const head = document.createElement('b');
      head.textContent = `Run ${k + 1} of ${shown.length}`;
      // textContent: a failure's reason holds text read from the page.
      detail.replaceChildren(head, ` · ${_how(e)} · ${_when(e.endedAt)} · ${_took(e)} — ${_result(e)}${e.first ? `\n${_first(e)}` : ''}`);
      detail.dataset.status = e.status;
      detail.hidden = false;
    });
    return b;
  });
  document.getElementById('lastRunDots').replaceChildren(...dots);
  document.getElementById('lastRunHistSum').textContent = _summary(shown);
}

/** The All runs window of the runs `getRuns()` gives: { name, entries }. */
export function initRunHistory(getRuns) {
  const button = document.getElementById('lastRunHistAll');
  const table = document.getElementById('runHistoryTable');
  if (!button || !table) return;
  let opener = null;
  const close = () => closeModal(MODAL, opener);
  attachModalKeyHandlers(MODAL, close);
  document.getElementById('runHistoryClose')?.addEventListener('click', close);
  button.addEventListener('click', (e) => {
    opener = e.currentTarget;
    const { name, entries } = getRuns();
    document.getElementById('runHistoryName').textContent = `${name} · last ${entries.length} runs`;
    const row = (cells, tag = 'td') => {
      const tr = document.createElement('tr');
      for (const [text, cls, title] of cells) {
        const c = document.createElement(tag);
        c.textContent = text;
        if (cls) c.className = cls;
        if (title) c.title = title;
        tr.append(c);
      }
      return tr;
    };
    table.replaceChildren(
      row([['When'], ['How'], ['Result'], ['First failure']], 'th'),
      // Newest first.
      ...[...entries].reverse().map((x) => row([
        [_when(x.endedAt), null, `took ${_took(x)}`], [_how(x)], [_result(x), `rh-${x.status}`], [_first(x)],
      ])),
    );
    openModal(MODAL, '#runHistoryClose');
  });
}
