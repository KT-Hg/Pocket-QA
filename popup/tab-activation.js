/**
 * tab-activation.js — activating the current tab (injecting content.js), the
 * lock overlay on tabs that cannot be used, and the cards gated by activation.
 */

import { activateTab, activationStatus, deactivateTab } from './dom.js';
import { COLLAPSIBLE_STATE_KEY } from './ui/collapsible.js';
import { CONTENT_SCRIPT_FILES, isEligibleTab, lockScroll, showConfirm, unlockScroll } from './utils.js';

/* === TAB ACTIVATION === */

// Scheduled Playback and CSV Data-Driven Run both need a live activated tab
// (see #dataGatedZone above). While the tab is locked, force these two cards
// collapsed regardless of what's saved in COLLAPSIBLE_STATE_KEY — the lock
// overlay's row layout assumes both start collapsed (see .lock-overlay-zone
// .lock-overlay-card in css/popup/10-motion-export-lock.css) and an expanded card left underneath
// it just looks broken since clicks on it are blocked anyway. The moment the
// tab activates, restore whichever state the user actually had saved.
const GATED_COLLAPSIBLE_IDS = ["scheduledPlaybackCard", "csvRunCard"];
// After activating, check again once the injected script has had time to answer.
const RECHECK_AFTER_ACTIVATION_MS = 1500;

function syncGatedCardCollapse(isActive) {
  chrome.storage.local.get([COLLAPSIBLE_STATE_KEY], (res) => {
    const states = res?.[COLLAPSIBLE_STATE_KEY] || {};
    GATED_COLLAPSIBLE_IDS.forEach((id) => {
      const card = document.getElementById(id);
      if (!card) return;
      const shouldBeOpen = isActive && states[id] === "open";
      card.classList.toggle("collapsed", !shouldBeOpen);
      card.querySelector("h3")?.setAttribute("aria-expanded", String(shouldBeOpen));
    });
  });
}

export let activatedTabs = new Set();

// Only the Record overlay locks scrolling now. The Data one covers just the two
// cards inside #dataGatedZone, so the rest of that tab has to stay scrollable —
// otherwise the SQL Test Case Designer sits below a fold nobody can reach.
//
// The lock still has to be scoped to the tab on screen: the overlay only renders
// while its own popup tab is active (see body[data-active-tab="..."] in the CSS),
// and without the same scoping here a locked Record tab strands *other* tabs
// (e.g. Settings) unscrollable any time the page tab isn't activated.
let _recordOverlayWanted = false;

function _syncOverlayScrollLock() {
  const shouldLock = document.body.dataset.activeTab === 'tabRecord' && _recordOverlayWanted;
  if (shouldLock) lockScroll(); else unlockScroll();
}

function showLockOverlay(which, type) {
  const id = which === 'record' ? 'Record' : 'Data';
  const overlay = document.getElementById('lockOverlay' + id);
  const titleEl = document.getElementById('lockOverlay' + id + 'Title');
  const subEl = document.getElementById('lockOverlay' + id + 'Sub');
  const btn = document.getElementById('lockOverlay' + id + 'Btn');
  if (!overlay) return;
  if (type === 'not-eligible') {
    if (titleEl) titleEl.textContent = 'Not Available';
    if (subEl) subEl.textContent = 'Recording and playback are not supported on this page (e.g. Chrome settings, extension pages).';
    if (btn) btn.hidden = true;
  } else {
    if (titleEl) titleEl.textContent = 'Activate on Tab';
    if (subEl) subEl.textContent = 'Click Activate to enable recording and playback on the current tab.';
    if (btn) btn.hidden = false;
  }
  overlay.classList.add('is-visible');
  if (which === 'record') _recordOverlayWanted = true;
  _syncOverlayScrollLock();
}

function hideLockOverlay() {
  const r = document.getElementById('lockOverlayRecord');
  const d = document.getElementById('lockOverlayData');
  if (r) r.classList.remove('is-visible');
  if (d) d.classList.remove('is-visible');
  _recordOverlayWanted = false;
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
      showLockOverlay('record', 'not-eligible');
      showLockOverlay('data', 'not-eligible');
      document.body.dataset.activation = 'not-eligible';
      syncGatedCardCollapse(false);
      return;
    }

    const isActivated = activatedTabs.has(tab.id);

    if (isActivated) {
      activationStatus.textContent = "Active";
      activationStatus.style.color = "var(--success)";
      if (statusDot) { statusDot.className = "status-dot active"; }
      activateTab.style.display = "none";
      deactivateTab.style.display = "block";
      hideLockOverlay();
      document.body.dataset.activation = 'active';
      syncGatedCardCollapse(true);
    } else {
      activationStatus.textContent = "Inactive";
      activationStatus.style.color = "var(--danger)";
      if (statusDot) { statusDot.className = "status-dot inactive"; }
      activateTab.style.display = "block";
      deactivateTab.style.display = "none";
      showLockOverlay('record', 'inactive');
      showLockOverlay('data', 'inactive');
      document.body.dataset.activation = 'inactive';
      syncGatedCardCollapse(false);
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
  // showLockOverlay/hideLockOverlay run independently of tab switches.
  new MutationObserver(_syncOverlayScrollLock).observe(document.body, {
    attributeFilter: ['data-active-tab'],
  });
  if (activateTab) {
    activateTab.addEventListener('click', async () => {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || !isEligibleTab(tab)) return;

        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: CONTENT_SCRIPT_FILES
          });

          activatedTabs.add(tab.id);
          chrome.storage.local.set({ activatedTabs: Array.from(activatedTabs) });

          checkTabActivation();

          activationStatus.textContent = "Activated successfully";
          activationStatus.style.color = "var(--success)";
          setTimeout(() => checkTabActivation(), RECHECK_AFTER_ACTIVATION_MS);
        } catch (err) {
          // Reported inline only — the success path does the same, and a toast on
          // top of it would announce the same failure twice.
          activationStatus.textContent = "Activation failed";
          activationStatus.style.color = "var(--danger)";
        }
      });
    });
  }
  ['lockOverlayRecordBtn', 'lockOverlayDataBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => activateTab && activateTab.click());
  });
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
      showConfirm("Remove extension from this tab? You'll need to reactivate to use it again.", () => {
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
      }, { title: 'Remove Extension' });
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
