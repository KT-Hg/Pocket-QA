/**
 * tab-activation.js — activating the current tab (injecting content.js) and the
 * lock over Record & Play on tabs that cannot be used.
 */

import { activateTab, activationStatus, deactivateTab } from './dom.js';
import { CONTENT_SCRIPT_FILES, isEligibleTab, lockScroll, showConfirm, unlockScroll } from './utils.js';

/* === TAB ACTIVATION === */

// After activating, check again once the injected script has had time to answer.
const RECHECK_AFTER_ACTIVATION_MS = 1500;

export let activatedTabs = new Set();

/**
 * Turn Pocket QA on for the active tab — content.js injected (a tab opened before
 * the install has none), the tab remembered as activated — and redraw the bar.
 * What starts a recording or a run calls it first. False on a tab that cannot be
 * used, or when the injection failed.
 */
export async function activateCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isEligibleTab(tab)) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPT_FILES });
  } catch (_) {
    // Already injected (the manifest's content script), or a page that refuses it:
    // the run reports the latter itself.
  }
  if (!activatedTabs.has(tab.id)) {
    activatedTabs.add(tab.id);
    await chrome.storage.local.set({ activatedTabs: Array.from(activatedTabs) });
  }
  checkTabActivation();
  return true;
}

// The scroll lock is scoped to the tab on screen: the overlay only renders while
// Record & Play is the popup tab shown (see body[data-active-tab="..."] in the
// CSS), and without the same scoping here a locked Record tab strands *other*
// tabs (e.g. Settings) unscrollable on a page Pocket QA cannot use.
let _recordOverlayWanted = false;

function _syncOverlayScrollLock() {
  const shouldLock = document.body.dataset.activeTab === 'tabRecord' && _recordOverlayWanted;
  if (shouldLock) lockScroll(); else unlockScroll();
}

/**
 * The lock over Record & Play, on a page Pocket QA cannot use — the New Tab page,
 * Settings. An eligible tab never gets it: what starts a recording or a run
 * turns the tab on (activateCurrentTab). The Tools tab reads storage only.
 */
function _setLock(locked) {
  document.getElementById('lockOverlayRecord')?.classList.toggle('is-visible', locked);
  _recordOverlayWanted = locked;
  _syncOverlayScrollLock();
}

function checkTabActivation() {
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    if (!tab) return;

    const statusDot = document.getElementById("statusDot");

    if (!isEligibleTab(tab)) {
      activationStatus.textContent = "Not available";
      activationStatus.style.color = "var(--muted)";
      if (statusDot) { statusDot.className = "status-dot"; }
      activateTab.style.display = "none";
      deactivateTab.style.display = "none";
      _setLock(true);
      document.body.dataset.activation = 'not-eligible';
      return;
    }

    const isActivated = activatedTabs.has(tab.id);

    if (isActivated) {
      activationStatus.textContent = "Active";
      activationStatus.title = "";
      activationStatus.style.color = "var(--success)";
      if (statusDot) { statusDot.className = "status-dot active"; }
      activateTab.style.display = "none";
      deactivateTab.style.display = "block";
      _setLock(false);
      document.body.dataset.activation = 'active';
    } else {
      // No lock over the cards: Start Recording, Play, a Sequence and a CSV run
      // turn the tab on themselves (activateCurrentTab). A newcomer met a lock and
      // an "Activate" nobody explained before the first recording; only the
      // hotkeys still wait for the tab to be on.
      activationStatus.textContent = "Off on this tab";
      activationStatus.title = "Pocket QA turns on for this tab when you record or play here. Its hotkeys work once it is on.";
      activationStatus.style.color = "var(--muted)";
      if (statusDot) { statusDot.className = "status-dot inactive"; }
      activateTab.style.display = "block";
      deactivateTab.style.display = "none";
      _setLock(false);
      document.body.dataset.activation = 'inactive';
    }
  });
}

export function initTabActivation() {
  chrome.storage.local.get(["activatedTabs"], (res) => {
    if (res?.activatedTabs) {
      activatedTabs = new Set(res.activatedTabs);
    }
    checkTabActivation();
  });
  // Re-check the lock whenever init.js's switchTab() flips data-active-tab, since
  // _setLock runs independently of tab switches.
  new MutationObserver(_syncOverlayScrollLock).observe(document.body, {
    attributeFilter: ['data-active-tab'],
  });
  if (activateTab) {
    activateTab.addEventListener('click', async () => {
      if (!(await activateCurrentTab())) return;
      activationStatus.textContent = "Activated successfully";
      activationStatus.style.color = "var(--success)";
      setTimeout(() => checkTabActivation(), RECHECK_AFTER_ACTIVATION_MS);
    });
  }
  // Record only. Swallowing the wheel over the Data overlay would trap the popup
  // scroll whenever the pointer happened to be over the two gated cards.
  ['lockOverlayRecord'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('wheel', e => e.preventDefault(), { passive: false });
    el.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
  });
  if (deactivateTab) {
    deactivateTab.addEventListener('click', () => {
      // "Remove" in red read as deleting something: nothing is deleted, the tab reloads.
      showConfirm("Turn Pocket QA off on this tab? The page reloads and its hotkeys stop working here; recording or playing on this tab turns it on again. Your scenarios are kept.", () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab) return;

        activatedTabs.delete(tab.id);
        chrome.storage.local.set({ activatedTabs: Array.from(activatedTabs) });

        // Reload the tab to unload the content script.
        chrome.tabs.reload(tab.id, () => {
          checkTabActivation();
        });
      });
      }, { title: 'Turn off on this tab', okLabel: 'Turn off' });
    });
  }
  // Remove tab from activated list when closed
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (activatedTabs.has(tabId)) {
      activatedTabs.delete(tabId);
      chrome.storage.local.set({ activatedTabs: Array.from(activatedTabs) });
    }
  });
}
