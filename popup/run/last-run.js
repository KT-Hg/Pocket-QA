/**
 * run/last-run.js — the Last run card: how the last Play or Resume came out
 * (bg/playback.js keeps it as lastRun), its failures, each leading to its action
 * in the list, and its bug report (shared/bug-report.js) to copy into an issue.
 */

import { buildBugReport } from '../../shared/bug-report.js';
import { LAST_RUN_KEY, LAST_RUN_SHOT_KEY } from '../../shared/storage-keys.js';
import { formatStamp } from '../../shared/time-format.js';
import { activeValueText } from '../../shared/var-spec.js';
import { verdictLabel } from '../../shared/verdict.js';
import { scenarioList } from '../dom.js';
import { downloadBlob, safeFileName } from '../lib/download.js';
import { previewActions } from '../record/preview.js';
import { attachModalKeyHandlers, closeModal, openModal } from '../ui/modal.js';
import { ui } from '../ui-state.js';
import { showToast } from '../utils.js';

// The endedAt of the run whose card × hid: the card comes back with the next run.
const DISMISSED_KEY = 'lastRunDismissed';
// How long a failure waits for its scenario's actions to be listed.
const ROW_WAIT_MS = 3_000;
const ROW_POLL_MS = 50;

const _relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "just now", "3 minutes ago", "yesterday". */
function _ago(endedAt) {
  const minutes = Math.round((Date.now() - endedAt) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return _relative.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  return hours < 24 ? _relative.format(-hours, 'hour') : _relative.format(-Math.round(hours / 24), 'day');
}

/** Mark the action at `index` once the list shows it (previewActions answers later). */
function _markRow(index) {
  const deadline = Date.now() + ROW_WAIT_MS;
  const find = () => {
    const li = document.querySelector(`#actions li.action[data-index="${index}"]`);
    if (!li) {
      if (Date.now() < deadline) setTimeout(find, ROW_POLL_MS);
      return;
    }
    li.classList.add('lr-target');
    li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  find();
}

/** The failed action in the list: its scenario selected, its row marked. */
function _showAction(scenarioId, index) {
  if (!ui.scenariosCache?.[scenarioId]) { showToast('That scenario no longer exists', 'warn'); return; }
  if (![...scenarioList.options].some((o) => o.value === scenarioId)) {
    showToast('Clear the scenario search or folder filter to show it', 'warn');
    return;
  }
  scenarioList.value = scenarioId;
  scenarioList.dispatchEvent(new Event('change', { bubbles: true }));
  previewActions();
  _markRow(index);
}

function _failureButton(run, f) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'lr-failure';
  button.dataset.kind = f.kind === 'assert' ? 'assert' : 'broken';
  // textContent: the reason holds text read from the page under test.
  button.textContent = `${f.kind === 'assert' ? '✗' : '⚠'} #${f.index} ${f.label || f.type} — ${f.reason}`;
  // In full: the line is cut to the card's width.
  button.title = `${button.textContent}\nClick to show this action in the list`;
  button.addEventListener('click', () => _showAction(run.scenarioId, f.index - 1));
  const li = document.createElement('li');
  li.append(button);
  return li;
}

function _render(card, run, dismissedAt) {
  card.hidden = !run?.endedAt || run.endedAt === dismissedAt;
  if (card.hidden) return;
  const status = run.verdict?.status || 'stopped';
  card.dataset.status = status;
  card.querySelector('.lr-verdict').textContent = verdictLabel(status);
  const name = card.querySelector('.lr-name');
  name.textContent = run.scenarioName || run.scenarioId || '';
  name.title = name.textContent;
  const how = [run.resumed && 'resumed', run.loops > 1 && `${run.loops} loops`].filter(Boolean);
  card.querySelector('.lr-when').textContent = [...how, _ago(run.endedAt)].join(' · ');
  card.querySelector('.lr-failures').replaceChildren(...(run.failures || []).map((f) => _failureButton(run, f)));
  // A report tells a failure: a run that passed, or stopped with none, has nothing to report.
  const report = document.getElementById('lastRunBugReport');
  if (report) report.hidden = status !== 'failed' && status !== 'broken';
}

/** The browser, the OS and Pocket QA's version, for the report. */
function _env() {
  const ua = navigator.userAgentData;
  // Chromium names itself next to the branded browser; "Not A Brand" is a decoy.
  const brands = (ua?.brands || []).filter((b) => !/not.?a.?brand/i.test(b.brand));
  const brand = brands.find((b) => b.brand !== 'Chromium') || brands[0];
  const browser = brand ? `${brand.brand} ${brand.version}` : (/Chrome\/(\d+)/.exec(navigator.userAgent)?.[0] || '');
  return { browser, os: ua?.platform || navigator.platform, version: chrome.runtime.getManifest().version };
}

/** "pocketqa-bug-Checkout-2026-10-18_14-03-05.jpg": the run's screenshot when downloaded. */
function _shotName(run) {
  return `pocketqa-bug-${safeFileName(run.scenarioName || run.scenarioId)}-${formatStamp(new Date(run.endedAt))}.jpg`;
}

async function _copy(textarea) {
  try {
    await navigator.clipboard.writeText(textarea.value);
  } catch {
    // The clipboard API wants the document focused; a selection copies without it.
    textarea.select();
    if (!document.execCommand('copy')) { showToast('Could not copy — select the text and copy it', 'error'); return; }
  }
  showToast('Bug report copied — paste it into the issue', 'success');
}

/**
 * The Bug report window of the run `getRun()` gives: the Markdown, typed values
 * hidden until "Include typed values" (never remembered), Copy, and the
 * screenshot to download and attach.
 */
function _initBugReport(getRun) {
  const MODAL = 'bugReportModal';
  const text = document.getElementById('bugReportText');
  const showValues = document.getElementById('bugReportShowValues');
  const shotButton = document.getElementById('bugReportShot');
  if (!text || !showValues || !shotButton) return;
  let shot = null, vars = null, opener = null;
  const render = () => {
    const run = getRun();
    text.value = run ? buildBugReport(run, {
      showValues: showValues.checked, env: _env(), shotName: shot ? _shotName(run) : null, vars,
    }) : '';
  };
  const close = () => closeModal(MODAL, opener);
  attachModalKeyHandlers(MODAL, close);
  document.getElementById('lastRunBugReport')?.addEventListener('click', (e) => {
    opener = e.currentTarget;
    showValues.checked = false;
    // The run kept no variable values: the saved ones, which the report says may differ.
    chrome.storage.local.get([LAST_RUN_SHOT_KEY, 'variables'], (x) => {
      shot = x[LAST_RUN_SHOT_KEY] || null;
      vars = Object.fromEntries(Object.entries(x.variables || {}).map(([k, v]) => [k, activeValueText(v)]));
      shotButton.style.display = shot ? '' : 'none';
      render();
      openModal(MODAL, '#bugReportCopy');
    });
  });
  showValues.addEventListener('change', render);
  document.getElementById('bugReportCopy')?.addEventListener('click', () => _copy(text));
  shotButton.addEventListener('click', async () => {
    const run = getRun();
    if (shot && run) downloadBlob(await (await fetch(shot)).blob(), _shotName(run));
  });
  document.getElementById('bugReportClose')?.addEventListener('click', close);
}

export function initLastRun() {
  const card = document.getElementById('lastRunCard');
  if (!card) return;
  let shown = null;
  const load = () => chrome.storage.local.get([LAST_RUN_KEY, DISMISSED_KEY], (x) => {
    shown = x[LAST_RUN_KEY] || null;
    _render(card, shown, x[DISMISSED_KEY]);
  });
  // The card tells the verdict now; the badge stops telling it.
  const clearBadge = () => chrome.runtime.sendMessage({ type: 'CLEAR_RUN_VERDICT' }, () => void chrome.runtime.lastError);
  document.getElementById('lastRunDismiss')?.addEventListener('click', () => {
    card.hidden = true;
    if (shown?.endedAt) chrome.storage.local.set({ [DISMISSED_KEY]: shown.endedAt });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[LAST_RUN_KEY]) return;
    load();
    clearBadge(); // a run that ended while the popup was open
  });
  _initBugReport(() => shown);
  load();
  clearBadge();
}
