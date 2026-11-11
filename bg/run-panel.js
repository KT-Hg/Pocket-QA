/**
 * run-panel.js — the panel on the page a run plays on (content.js RUN PANEL):
 * which scenario, which step, how far through the whole run, and a Stop — as the
 * recording pill does while recording. The popup closes once a run starts, and
 * the badge alone said little.
 *
 * updateBadge() calls updateRunPanel(), so the panel follows every change the
 * badge does (a step, a CSV row, a sequence item, a failed action's pause);
 * runClaimed() ends it; REGISTER_FRAME hands it to a page that just loaded.
 * GET_EXTENSION_STATUS hands the same state to the popup, whose run line says
 * what the panel says.
 */

import { state } from './state.js';
import { tabMsg } from './tabs.js';

// How long a screenshot waits for the page to say the panel is off the screen.
const HIDE_TIMEOUT_MS = 1500;

let _shownOn = null; // the tab the panel was last sent to
let _last = '';      // what was sent there, so an unchanged state is not sent again

/** How far through the whole run, 0–1: loops, sequence items and CSV rows count as parts. */
export function runFraction(run) {
  const inScenario = run.steps > 0 ? Math.min(1, run.step / run.steps) : 0;
  if (run.kind === 'scenario') return run.loops > 1 ? ((run.loop - 1) + inScenario) / run.loops : inScenario;
  if (!run.items) return 0;
  return Math.min(1, ((run.item - 1) + (run.waiting ? 1 : inScenario)) / run.items);
}

/** The run in words — what plays (`head`) and the step counter (`counter`) — as the page panel and the popup both show it. */
export function runWords(run) {
  let head = (run.from ? `${run.from} → ${run.scenario}` : run.scenario) || 'Scenario';
  if (run.kind === 'sequence') head = `Sequence ${run.item}/${run.items} · ${head}`;
  else if (run.kind === 'csv') head = `CSV row ${run.item}/${run.items} · ${head}`;
  else if (run.loops > 1) head = `${head} · loop ${run.loop}/${run.loops}`;
  let counter = run.steps ? `step ${run.step}/${run.steps}` : '';
  if (run.waiting) counter = 'next…';
  else if (run.paused) counter = `step ${run.step} failed`;
  return { head, counter };
}

/** What the panel shows now, with its words and whole-run percentage, or null when no run is going. */
export function runPanelState() {
  const p = state.playback;
  const csv = state.csvPlayback.active, seq = state.sequencePlayback.active;
  if (!(p.active || csv || seq) || p.tabId == null) return null;
  const run = {
    kind: 'scenario',
    scenario: p.scenarioName || '',
    // A Switch case playing another scenario: the one it came from.
    from: p.originalScenarioName && p.originalScenarioName !== p.scenarioName ? p.originalScenarioName : '',
    step: (p.actionIndex ?? 0) + 1,
    steps: p.totalActions || 0,
    loop: p.loopCurrent || 1,
    loops: p.loopTotal || 1,
    paused: !!p.failPrompt,
    // Between two CSV rows or sequence items: the next one has not started.
    waiting: !p.active,
  };
  if (csv) Object.assign(run, { kind: 'csv', item: (state.csvPlayback.currentRow ?? 0) + 1, items: state.csvPlayback.rows.length });
  else if (seq) Object.assign(run, { kind: 'sequence', item: (state.sequencePlayback.currentIndex ?? 0) + 1, items: state.sequencePlayback.runList.length });
  return { ...run, ...runWords(run), pct: Math.round(runFraction(run) * 100) };
}

function _send(tabId, run) {
  chrome.tabs.sendMessage(tabId, { type: 'RUN_PANEL', run }, { frameId: 0 }, () => void chrome.runtime.lastError);
}

/** The panel as the run is now: shown, moved on, or taken off its tab. */
export function updateRunPanel() {
  const run = runPanelState();
  const tabId = run ? state.playback.tabId : null;
  if (_shownOn != null && _shownOn !== tabId) _send(_shownOn, null);
  if (tabId == null) { _shownOn = null; _last = ''; return; }
  const key = JSON.stringify(run);
  if (tabId === _shownOn && key === _last) return;
  _shownOn = tabId;
  _last = key;
  _send(tabId, run);
}

/** The run is over (runClaimed): the panel goes, whatever the flags still say. */
export function endRunPanel() {
  if (_shownOn != null) _send(_shownOn, null);
  _shownOn = null;
  _last = '';
}

/**
 * `capture()` with the panel off the page: a screenshot step, or a failed
 * action's picture, shows the page and not Pocket QA. The page answers once the
 * panel is gone from the screen; a page that does not answer is captured as it is.
 */
export async function withRunPanelHidden(tabId, capture) {
  await tabMsg(tabId, { type: 'RUN_PANEL_HIDE', hidden: true }, HIDE_TIMEOUT_MS, 0);
  try {
    return await capture();
  } finally {
    tabMsg(tabId, { type: 'RUN_PANEL_HIDE', hidden: false }, HIDE_TIMEOUT_MS, 0);
  }
}
