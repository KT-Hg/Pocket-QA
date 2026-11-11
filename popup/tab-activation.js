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
// Settings → Allow on all tabs (storage.local allowAllTabs): every web page counts as on.
let allowAllTabs = false;

/**
 * content.js in the tab: a tab opened before the install (or before an update)
 * has none. A page that refuses it is reported by what then runs there.
 */
function _injectContent(tabId) {
  return chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES }).catch(() => {});
}

/**
 * Turn Pocket QA on for the active tab — content.js injected, the tab remembered
 * as activated — and redraw the bar. The status bar's Turn on does it, and the
 * "Off on this tab" question (askToTurnOn). False on a tab that cannot be used.
 */
export async function activateCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isEligibleTab(tab)) return false;
  await _injectContent(tab.id);
  if (!activatedTabs.has(tab.id)) {
    activatedTabs.add(tab.id);
    await chrome.storage.local.set({ activatedTabs: Array.from(activatedTabs) });
  }
  checkTabActivation();
  return true;
}

/**
 * What every "this tab is off" moment says — Record, Play, a Sequence, a CSV run,
 * 🎯 Pick — in one place, so they read alike; anything else that acts on the page
 * asks with askToTurnOn / whenTabOn and says the same.
 */
export const TAB_OFF = {
  title: 'Off on this tab',
  message: 'Pocket QA is off on this tab. Turn it on to record, play or pick elements here — it stays on for this tab until you turn it off or close the tab.',
  ok: 'Turn on',
};

/** The "Off on this tab" question; Turn on turns the tab on (remembered), then `onTurnedOn`. Cancel leaves it off. */
export function askToTurnOn(onTurnedOn) {
  showConfirm(TAB_OFF.message, async () => { if (await activateCurrentTab()) onTurnedOn?.(); },
    { title: TAB_OFF.title, okLabel: TAB_OFF.ok, link: { label: 'Not ask again: Allow on all tabs in Settings →', onClick: openAllTabsSetting } });
}

/**
 * What acts on the page — recording, a run, picking an element — runs only on a
 * tab Pocket QA is on (or with Allow on all tabs). On a tab it is off on nothing
 * starts: askToTurnOn, and `then` once the user turned it on.
 */
export function whenTabOn(then) {
  chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
    // A browser page (New Tab, Settings) has Record & Play locked: nothing to ask there.
    if (!tab || !isEligibleTab(tab)) { then(); return; }
    if (!allowAllTabs && !activatedTabs.has(tab.id)) { askToTurnOn(then); return; }
    await _injectContent(tab.id);
    then();
  });
}

/** Settings, at Allow on all tabs (flashed), from the "Off on this tab" question. */
export function openAllTabsSetting() {
  document.querySelector('.tab-btn[data-tab="tabSettings"]')?.click();
  const card = document.getElementById('allowAllTabsCard');
  if (!card) return;
  card.scrollIntoView({ block: 'center' });
  card.classList.remove('setting-flash');
  void card.offsetWidth; // restart the flash when it is shown twice in a row
  card.classList.add('setting-flash');
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
 * Settings. An eligible tab never gets it: recording, a run and picking ask to
 * turn it on (whenTabOn). The Tools tab reads storage only.
 */
function _setLock(locked) {
  document.getElementById('lockOverlayRecord')?.classList.toggle('is-visible', locked);
  _recordOverlayWanted = locked;
  _syncOverlayScrollLock();
}

/**
 * The dot for the tab's own state, kept on it (data-idle-class) so the status
 * poll can put it back once a recording or a run ends (connection.js).
 */
function _setIdleDot(statusDot, cls) {
  if (!statusDot) return;
  statusDot.dataset.idleClass = cls;
  statusDot.className = cls;
}

function checkTabActivation() {
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    if (!tab) return;

    const statusDot = document.getElementById("statusDot");

    if (!isEligibleTab(tab)) {
      activationStatus.textContent = "Not available";
      activationStatus.style.color = "var(--muted)";
      _setIdleDot(statusDot, "status-dot");
      activateTab.style.display = "none";
      deactivateTab.style.display = "none";
      _setLock(true);
      document.body.dataset.activation = 'not-eligible';
      return;
    }

    const isActivated = allowAllTabs || activatedTabs.has(tab.id);

    if (isActivated) {
      activationStatus.textContent = allowAllTabs ? "Active · all tabs" : "Active";
      activationStatus.title = allowAllTabs ? "Allow on all tabs is on (Settings): Pocket QA works on every web page." : "";
      activationStatus.style.color = "var(--success)";
      _setIdleDot(statusDot, "status-dot active");
      activateTab.style.display = "none";
      // One tab cannot be turned off while every tab is allowed: that is the Settings toggle.
      deactivateTab.style.display = allowAllTabs ? "none" : "block";
      _setLock(false);
      document.body.dataset.activation = 'active';
    } else {
      // No lock over the cards: Start Recording, Play, a Sequence, a CSV run and
      // 🎯 Pick say the tab is off and ask to turn it on (whenTabOn); the record
      // hotkeys do nothing until it is.
      activationStatus.textContent = "Off on this tab";
      activationStatus.title = "Turn Pocket QA on here to record, play or pick elements (Turn on). Its hotkeys work once it is on.";
      activationStatus.style.color = "var(--muted)";
      _setIdleDot(statusDot, "status-dot"); // grey: nothing wrong, just not on yet
      activateTab.style.display = "block";
      deactivateTab.style.display = "none";
      _setLock(false);
      document.body.dataset.activation = 'inactive';
    }
  });
}

export function initTabActivation() {
  chrome.storage.local.get(["activatedTabs", "allowAllTabs"], (res) => {
    if (res?.activatedTabs) {
      activatedTabs = new Set(res.activatedTabs);
    }
    allowAllTabs = !!res?.allowAllTabs;
    checkTabActivation();
  });
  // The Settings toggle, flipped while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.allowAllTabs) return;
    allowAllTabs = !!changes.allowAllTabs.newValue;
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
      activationStatus.textContent = "Turned on";
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
      showConfirm("Turn Pocket QA off on this tab? The page reloads, its hotkeys stop working here, and recording, playing or picking here asks to turn it on again. Your scenarios are kept.", () => {
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
