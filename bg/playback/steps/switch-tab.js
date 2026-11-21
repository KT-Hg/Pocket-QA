/**
 * playback/steps/switch-tab.js — ↗ Switch tab: play on in the tab the page just
 * opened (a link with target=_blank, window.open, a sign-in popup), or go back to
 * the tab that opened this one.
 *
 * The run's tab is `ctx.tab` (bg/playback.js playActionsOnTab): `id` the tab it
 * plays on now, `stack` the tabs it came from, `opened` the tabs opened from the
 * run's tabs since it began (tabs.onCreated, openerTabId), `used` those a step
 * already went to, `closedBack` how many times the page itself closed the tab the
 * run was on — the run went back by itself then, and the ↩ step after it has
 * nothing left to do.
 *
 *   { type: 'switchTab', tabTarget: 'new', timeout? }   wait up to `timeout` ms (10 s) for it
 *   { type: 'switchTab', tabTarget: 'back', closeTab? } back to the opener, closing this tab first
 */

import { state } from '../../state.js';
import { tabMsg, waitForTabLoad } from '../../tabs.js';
import { updateBadge } from '../../badge.js';
import { afterFailure } from './flow.js';
import { runPause } from '../../run-state.js';

export const SWITCH_TAB_TIMEOUT_MS = 10_000;
const POLL_MS = 150;
// A new tab's page: how long it gets to load, and its content script to answer.
const LOAD_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 5_000;

/** Make `tabId` the tab the run plays on, and show it in its window. */
export async function moveRunTo(tab, tabId) {
  tab.id = tabId;
  state.playback.tabId = tabId;
  updateBadge(); // the run panel moves with the run (bg/run-panel.js)
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
}

/** The tab opened from the run's current tab that no step has gone to yet, waited for up to `ms`. */
async function _newTab(tab, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const found = tab.opened.find((o) => o.opener === tab.id && !tab.used.has(o.id));
    if (found) return found.id;
    if (Date.now() >= end || !state.playback.active) return null;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Until the content script of `tabId` answers (its page loaded), for up to READY_TIMEOUT_MS. */
async function _ready(tabId) {
  await waitForTabLoad(tabId, LOAD_TIMEOUT_MS);
  const end = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < end && state.playback.active) {
    const pong = await tabMsg(tabId, { type: 'PING' }, 1_000);
    if (pong?.ready) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export async function runSwitchTab(ctx, i, action) {
  const { tab, fail } = ctx;
  if (action.tabTarget === 'back') {
    if (tab.closedBack > 0) {
      tab.closedBack--;
    } else if (!tab.stack.length) {
      const back = afterFailure(await fail(i, action, 'No tab to go back to: the run is on the tab it started on'), i);
      if (back !== null) return back;
    } else {
      const leaving = tab.id;
      await moveRunTo(tab, tab.stack.pop());
      if (action.closeTab) await chrome.tabs.remove(leaving).catch(() => {});
    }
  } else {
    const ms = Number(action.timeout) > 0 ? Number(action.timeout) : SWITCH_TAB_TIMEOUT_MS;
    const found = await _newTab(tab, ms);
    if (found == null) {
      if (!state.playback.active) return i;
      const back = afterFailure(await fail(i, action, `No new tab opened by this one within ${Math.round(ms / 100) / 10} s`), i);
      if (back !== null) return back;
    } else {
      tab.used.add(found);
      tab.stack.push(tab.id);
      await moveRunTo(tab, found);
      await _ready(found);
    }
  }
  if (action.delay && action.delay > 0) await runPause(action.delay);
  return i;
}
