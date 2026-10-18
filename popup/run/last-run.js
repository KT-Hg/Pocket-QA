/**
 * run/last-run.js — the Last run card: how the last Play or Resume came out
 * (bg/playback.js keeps it as lastRun), and its failures, each leading to its
 * action in the list.
 */

import { LAST_RUN_KEY } from '../../shared/storage-keys.js';
import { verdictLabel } from '../../shared/verdict.js';
import { scenarioList } from '../dom.js';
import { previewActions } from '../record/preview.js';
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
  load();
  clearBadge();
}
