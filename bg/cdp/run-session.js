/**
 * cdp/run-session.js — the debugger session a run holds while it plays as a
 * device or on a network other than the browser's own (📱 Run as, shared/run-as.js).
 *
 * The emulation lives as long as the session: detaching ends it. So while a run
 * holds one, the other CDP users of that tab — a Script, a Dropdown, Upload File,
 * a full-page or element capture — use the run's session and leave it attached
 * (runHolds / detachUnlessHeld); a capture that changed the page's metrics gets
 * the device back. Chrome shows its "started debugging this browser" bar for as
 * long as the run lasts.
 */

import { DEVICES, NETWORKS, runAsOf } from '../../shared/run-as.js';

let _held = null; // { tabId, runAs }

/** Whether a run holds the debugger session of `tabId`. */
export const runHolds = (tabId) => _held != null && _held.tabId === tabId;

const _send = (tabId, method, params = {}) => new Promise((resolve) => {
  chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
    const err = chrome.runtime.lastError?.message;
    resolve(err ? { error: err } : res || {});
  });
});

/** The device and network of `runAs` on `tabId`, whose session is attached. */
async function _apply(tabId, runAs) {
  const device = DEVICES[runAs.device];
  if (device) {
    await _send(tabId, 'Emulation.setDeviceMetricsOverride', {
      width: device.width, height: device.height, deviceScaleFactor: device.dpr, mobile: true,
      screenWidth: device.width, screenHeight: device.height,
    });
    await _send(tabId, 'Emulation.setUserAgentOverride', { userAgent: device.ua });
    await _send(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  const net = NETWORKS[runAs.network];
  if (net) {
    await _send(tabId, 'Network.enable');
    await _send(tabId, 'Network.emulateNetworkConditions', {
      offline: !!net.offline, latency: net.latency, downloadThroughput: net.download, uploadThroughput: net.upload,
    });
  }
}

/**
 * Attach to `tabId` and play the rest of the run as `runAs` says. Nothing to do
 * (as the browser is): null. Refused (DevTools open on the tab, a page Chrome
 * keeps to itself): { error }. Held: { held: runAs }.
 */
export async function holdRunSession(tabId, runAs) {
  const r = runAsOf(runAs);
  if (!r) return null;
  if (_held) await releaseRunSession();
  // A session an earlier capture or dropdown left: ours, and in the way.
  await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); }));
  const err = await new Promise((resolve) => chrome.debugger.attach({ tabId }, '1.3', () => resolve(chrome.runtime.lastError?.message || null)));
  if (err) return { error: err };
  _held = { tabId, runAs: r };
  await _apply(tabId, r);
  return { held: r };
}

/** The run's device again after something changed the page's metrics (a full-page capture). */
export async function reapplyRunSession(tabId) {
  if (runHolds(tabId)) await _apply(tabId, _held.runAs);
}

/** End the run's session: the tab is as the browser has it again. */
export async function releaseRunSession() {
  const held = _held;
  _held = null;
  if (!held) return;
  await new Promise((resolve) => chrome.debugger.detach({ tabId: held.tabId }, () => { void chrome.runtime.lastError; resolve(); }));
}

/**
 * Attach to `tabId` for a CDP step, or use the session a run holds there:
 * `then(alreadyAttached)` — true when the session was there before (the step
 * then leaves it attached), false when this attach made it.
 */
export function attachOrReuse(tabId, then) {
  if (runHolds(tabId)) { then(true); return; }
  chrome.debugger.attach({ tabId }, '1.3', () => then(!!chrome.runtime.lastError));
}

/** Detach from `tabId` after a CDP step — unless the run holds it: then give the run's device back. */
export async function detachUnlessHeld(tabId) {
  if (runHolds(tabId)) { await reapplyRunSession(tabId); return; }
  await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); }));
}

// The tab closed, or the user cancelled Chrome's debugging bar: the session is gone.
chrome.debugger?.onDetach?.addListener?.((source) => {
  if (_held && source.tabId === _held.tabId) _held = null;
});
