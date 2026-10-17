/**
 * tabs.js — tabs: the active one, its URL, waiting for it to load, and sending
 * it a message with a timeout.
 */

// Defaults: how long a tab gets to finish loading, and to answer a message.
const TAB_LOAD_TIMEOUT_MS = 15_000;
const TAB_MESSAGE_TIMEOUT_MS = 10_000;

/* ── Tab Helpers ────────────────────────────────────────────────────────────── */

// Three-layer fallback: focused window → any eligible tab → session-stored last-known tab.
// The session fallback handles popups opened via keyboard shortcut (no focused window).
export function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs?.[0]?.id) {
        const id = tabs[0].id;
        chrome.storage.session?.set({ _lastActiveTabId: id }).catch?.(() => {});
        return resolve(id);
      }

      chrome.tabs.query({ active: true }, (allTabs) => {
        const eligible = (allTabs || []).filter(t =>
          t.id && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'),
        );
        if (eligible[0]?.id) {
          const id = eligible[0].id;
          chrome.storage.session?.set({ _lastActiveTabId: id }).catch?.(() => {});
          return resolve(id);
        }

        if (chrome.storage.session) {
          chrome.storage.session.get(['_lastActiveTabId'], (res) => {
            const id = res?._lastActiveTabId || null;
            if (id) console.warn('[UTILS] getActiveTabId: using last-known tab', id);
            resolve(id);
          });
        } else {
          resolve(null);
        }
      });
    });
  });
}

export function getTabUrl(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) { resolve(null); return; }
      resolve(tab.url || null);
    });
  });
}

export function waitForTabLoad(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (ok) => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      resolve(ok);
    };

    // Handle the case where the tab has already completed loading.
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) { finish(false); return; }
      if (tab?.status === 'complete') { finish(true); return; }
    });

    const onUpdated = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === 'complete') finish(true);
    };
    const onRemoved = (removedId) => {
      if (removedId === tabId) finish(false);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * content-overlays.js into the tab's top frame, or into every frame: the
 * countdown pill, the failed-action prompt and the segment capture bar, which
 * content.js does not carry. Sent before the message that needs one; a second
 * injection does nothing, and a frame it cannot reach (no content.js, a page
 * scripts may not run on) is left as it was — the message then goes unanswered
 * there, as before.
 */
export function loadOverlays(tabId, allFrames = false) {
  const target = allFrames ? { tabId, allFrames: true } : { tabId, frameIds: [0] };
  return chrome.scripting.executeScript({ target, files: ['content-overlays.js'] }).catch(() => {});
}

// Returns a failure object on timeout so callers can distinguish "no content script" from real failures.
export function tabMsg(tabId, msg, timeout = TAB_MESSAGE_TIMEOUT_MS, frameId = undefined) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    const timer = setTimeout(() => {
      settle({ failed: true, _noContentScript: true, error: 'tabMsg timeout' });
    }, timeout);

    // Default to main frame (0) when no frameId specified — prevents sub-frame
    // content scripts (all_frames: true) from racing to respond before the main frame.
    const opts = { frameId: frameId ?? 0 };

    chrome.tabs.sendMessage(tabId, msg, opts, (res) => {
      if (chrome.runtime.lastError) {
        settle({ failed: true, _noContentScript: true, error: chrome.runtime.lastError.message });
      } else {
        settle(res);
      }
    });
  });
}
