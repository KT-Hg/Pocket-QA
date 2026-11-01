/**
 * ui/run-bar.js — running many requests: the line over the list with
 * ▶ Run folder (Run all under All requests, Run N shown when filtered), the
 * delay between requests and how the last results of the listed cases add up;
 * while a run goes on, ⏹ Stop and how far it got. ▶ Run selected in the list's
 * bulk bar runs through here too.
 *
 * A run sends one request at a time (apicases/run.js runAll) and asks first
 * when some of them can change data (POST, PUT, PATCH, DELETE). Each result is
 * taken in as a Send's is (recordResult): kept as the case's `last`, its saved
 * values written into the environment before the next request is sent.
 */

import { tallyText } from '../../shared/verdict.js';
import { ALL, findCase, requestOf, visibleCases } from '../model.js';
import { runAll, runTally, writePlan } from '../run.js';
import { varsFor } from '../vars.js';
import { ask, el, h, toast, whenText } from './dom.js';
import { recordResult } from './response.js';

const MAX_DELAY_MS = 10_000;

/** The run going on: { stop, done, total, tally }, or null. */
let run = null;
/** Between two requests of a run, this visit only. */
let delayMs = 0;

export const isRunning = () => run !== null;

/** "3 passed · 1 failed · 2 not run". */
function countsText(t) {
  return [tallyText({ ...t, stopped: 0 }), t.notRun && `${t.notRun} not run`].filter(Boolean).join(' · ');
}

/** Asks before requests that write: true to go on. */
async function confirmWrites(cases, vars) {
  const question = writePlan(cases, vars);
  return !question || ask([h('p', null, h('b', null, question)),
    h('p', { class: 'helper' }, 'They can change or delete data on that server. The requests are sent one at a time; ⏹ Stop sends no more.')],
  { ok: 'Send', danger: true });
}

function endToast({ done, total, tally }) {
  if (done < total) toast(`Stopped after ${done} of ${total} — the others keep their last result`, 'warn', { ms: 4000 });
  else toast(`Ran ${done}: ${tallyText({ ...tally, stopped: 0 })}`, tally.failed || tally.broken ? 'warn' : 'success', { ms: 4000 });
}

/** Run the cases `ids`, in that order. `redraw()` draws the list again (this bar with it). */
export async function runCases(app, ids, redraw) {
  if (run) return;
  const cases = ids.map((id) => findCase(app.state, id)).filter(Boolean).map((c) => requestOf(app.state, c));
  if (!cases.length) return;
  run = { stop: false, done: 0, total: cases.length, tally: { passed: 0, failed: 0, broken: 0 } };
  let started = false;
  try {
    if (!(await confirmWrites(cases, await varsFor(app.state)))) return;
    started = true;
    redraw();
    await runAll(cases, {
      getVars: () => varsFor(app.state),
      delayMs,
      shouldStop: () => run.stop,
      onResult: (c, result) => {
        run.done++;
        run.tally[result.verdict]++;
        recordResult(app, c.id, result);
      },
    });
  } finally {
    const ended = run;
    run = null;
    if (started) { redraw(); endToast(ended); }
  }
}

function runningBar(redraw) {
  const now = Math.min(run.done + 1, run.total);
  return [
    h('button', { class: 't-btn t-btn-sm ac-stop', disabled: run.stop, title: 'Send no more requests once the one on its way is back',
      onclick: () => { run.stop = true; redraw(); } }, run.stop ? 'Stopping…' : '⏹ Stop'),
    h('span', { class: 'ac-run-text', role: 'status' },
      `Running ${now} of ${run.total}`, run.done ? ` · ${tallyText({ ...run.tally, stopped: 0 })}` : ''),
  ];
}

function idleBar(app, redraw) {
  const s = app.state;
  const all = visibleCases(s);
  const shown = visibleCases(s, app.view);
  let label = s.folderId === ALL ? '▶ Run all' : '▶ Run folder';
  if (shown.length < all.length) label = `▶ Run ${shown.length} shown`;
  const delay = h('input', { type: 'number', class: 'ac-num-input', min: 0, max: MAX_DELAY_MS, step: 100, value: delayMs,
    'aria-label': 'Delay between requests, in milliseconds',
    onchange: () => {
      delayMs = Math.min(Math.max(Math.round(Number(delay.value) || 0), 0), MAX_DELAY_MS);
      delay.value = delayMs;
    } });
  const t = runTally(all);
  return [
    h('button', { class: 't-btn t-btn-sm', disabled: !shown.length, title: 'Send the requests listed, one after another',
      onclick: () => runCases(app, shown.map((c) => c.id), redraw) }, label),
    h('label', { class: 'ac-inline ac-delay', title: 'Wait this long between two requests' }, 'Delay', delay, 'ms'),
    h('span', { class: 'ac-run-text' }, t.at ? `Last run ${whenText(t.at)} · ${countsText(t)}` : 'Not run yet'),
  ];
}

export function renderRunBar(app, redraw) {
  // A run stays stoppable from a folder with nothing in it.
  const shown = run !== null || visibleCases(app.state).length > 0;
  el.runBar.hidden = !shown;
  if (!shown) el.runBar.replaceChildren();
  else el.runBar.replaceChildren(...(run ? runningBar(redraw) : idleBar(app, redraw)));
}
