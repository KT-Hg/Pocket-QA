/**
 * screenshot/capture-tab.js — captureVisibleTab: the target tab's window, the retry, the
 * double capture.
 */

// captureVisibleTab allows about one call a second; a rate-limited call is tried
// once more after just over that.
const RATE_LIMIT_RETRY_MS = 1100;
// Between the discarded first frame and the one kept (see captureTabDouble).
const DOUBLE_CAPTURE_GAP_MS = 80;

/* ── Tab Capture ────────────────────────────────────────────────────────────── */

/**
 * Capture the visible area of `windowId` with a one-shot rate-limit retry.
 * Chrome throttles captureVisibleTab to ~1 call/second.
 *
 * `windowId` must be the window owning the tab being captured. Passing null (the
 * previous behaviour) means "the current window", which during a background CSV
 * run is whatever window the user happens to be looking at — producing a whole
 * export full of screenshots of an unrelated page, watermarked with the target
 * page's URL because the watermark reads it from the real tabId.
 */
function captureTab(windowId = null, _retried = false) {
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message || '';
        if (!_retried && /rate/i.test(msg)) {
          setTimeout(() => resolve(captureTab(windowId, true)), RATE_LIMIT_RETRY_MS);
        } else {
          resolve(null);
        }
      } else {
        resolve(dataUrl);
      }
    });
  });
}

/**
 * Capture the tab twice and return only the second frame.
 *
 * When CSS transitions or compositor animations are in-flight, the first
 * `captureVisibleTab` call may catch a partial composite pass — the result
 * looks like a torn or half-rendered frame. Discarding the first capture and
 * waiting ~80 ms (roughly five 60 Hz vsync cycles) lets the compositor finish
 * before the second — stable — frame is taken.
 */
export async function captureTabDouble(windowId = null) {
  await captureTab(windowId);
  await new Promise(r => setTimeout(r, DOUBLE_CAPTURE_GAP_MS));
  return captureTab(windowId);
}

/**
 * Resolve the window a tab lives in, and whether that tab is the active one there.
 *
 * captureVisibleTab can only ever photograph the active tab of a window, so a
 * request aimed at a background tab cannot be satisfied — better to say so than
 * to silently return a picture of a different page.
 */
export function resolveCaptureTarget(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) { resolve(null); return; }
      resolve({ windowId: tab.windowId, isActive: !!tab.active });
    });
  });
}
