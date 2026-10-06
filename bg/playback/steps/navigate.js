/**
 * playback/steps/navigate.js — Navigate: load the URL in the tab, wait for it to finish.
 */

import { state } from '../../state.js';
import { FAIL_RETRY, FAIL_STOP } from '../failure-prompt.js';
import { STOP } from './flow.js';

// After the page reports complete, a moment for it to settle.
const NAV_SETTLE_MS = 500;
// Single-page apps may never report complete: how often the tab URL is polled.
const SPA_POLL_MS = 200;
// Give up on the navigation after this long.
const NAV_TIMEOUT_MS = 30_000;

export async function runNavigate(ctx, i, action) {
  const { tabId, fail } = ctx;
  let navSuccess = true;
  const targetUrl = action.value || action.url;
  let initialTabUrl = null;
  try {
    const t = await new Promise(r => chrome.tabs.get(tabId, r));
    initialTabUrl = t?.url || null;
  } catch (_) { /* tab already gone: initialTabUrl stays null */ }
  await new Promise((resolve) => {
    let resolved = false;
    const done = (success = true) => {
      if (resolved) return;
      resolved = true;
      navSuccess = success;
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      clearInterval(spaPoller);
      clearTimeout(navTimeout);
      setTimeout(resolve, NAV_SETTLE_MS); // brief settle time after status=complete
    };

    const listener = (updatedTabId, changeInfo) => {
      if (!state.playback.active) { done(false); return; }
      if (updatedTabId === tabId && changeInfo.status === 'complete') done(true);
    };
    const removedListener = (removedTabId) => { if (removedTabId === tabId) done(false); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);

    try { chrome.tabs.update(tabId, { url: targetUrl }); }
    catch (e) { done(false); return; }

    // SPA fallback: some single-page apps never fire status='complete' on
    // in-app navigation.  Poll the tab URL every 200 ms instead.
    // Only accept an exact or prefix match in the target→current direction
    // to avoid false-positives when the current URL is a prefix of the
    // target (e.g. current="/", target="/checkout").
    const spaPoller = setInterval(async () => {
      if (resolved) { clearInterval(spaPoller); return; }
      try {
        const tab = await new Promise(r => chrome.tabs.get(tabId, r));
        if (tab?.url && targetUrl && tab.url !== initialTabUrl && (
          tab.url === targetUrl ||
          tab.url.startsWith(targetUrl)
        )) done(true);
      } catch (_) { /* tab closed between polls: onRemoved or the timeout ends the wait */ }
    }, SPA_POLL_MS);

    const navTimeout = setTimeout(() => done(false), NAV_TIMEOUT_MS);
  });

  if (!navSuccess) {
    const next = await fail(i, action, 'Navigation timed out or tab was closed', 'Navigation timed out');
    if (next === FAIL_RETRY) return i - 1;
    if (next === FAIL_STOP) return STOP;
  }
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}
