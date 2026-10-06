/**
 * screenshot/crop.js — handing a capture to the crop editor window.
 */

import { ignoreLastError } from '../last-error.js';

/* ── Pending crops ──────────────────────────────────────────────────────────────
 * Each crop editor window gets its own token, passed in the editor URL and kept
 * here until that window closes.
 *
 * This replaced a single `state.pendingCrop` slot that was cleared the moment the
 * editor read it, which broke two ordinary cases: reloading the editor window
 * (F5) found an empty slot and closed itself, losing the capture; and firing two
 * crop captures in quick succession had the second overwrite the first, so one of
 * the two windows showed the wrong image or none at all.
 *
 * Held in memory rather than chrome.storage.session on purpose — a full-page PNG
 * data URL runs to several MB and would eat the session quota. The editor reads
 * its token immediately on load, so the window of exposure to a worker suspend is
 * very short; if it does happen the editor reports it instead of closing silently.
 * ────────────────────────────────────────────────────────────────────────────── */

const _pendingCrops = new Map(); // token   -> { dataUrl, downloadPath, saveAs }
const _cropWindows  = new Map(); // windowId -> token

/** Read a pending crop without consuming it, so a reload of the editor still works. */
export function getPendingCrop(token) {
  return (token && _pendingCrops.get(token)) || null;
}

chrome.windows.onRemoved.addListener((windowId) => {
  const token = _cropWindows.get(windowId);
  if (!token) return;
  _pendingCrops.delete(token);
  _cropWindows.delete(windowId);
});

/**
 * Open the crop editor window with the image attached to a fresh token.
 * The entry is written before the window is created, so the editor's very first
 * message can never arrive ahead of the data.
 */
export async function openCropUI(dataUrl, downloadPath, saveAs) {
  const token = crypto.randomUUID();
  _pendingCrops.set(token, { dataUrl, downloadPath, saveAs });
  const url = chrome.runtime.getURL(`editor.html?crop=${token}`);
  chrome.windows.create({ url, type: 'popup' }, (win) => {
    if (chrome.runtime.lastError || !win?.id) {
      _pendingCrops.delete(token); // window never opened — do not leak the image
      return;
    }
    _cropWindows.set(win.id, token);
    chrome.windows.update(win.id, { state: 'maximized' }, ignoreLastError);
  });
  return { success: true, cropping: true };
}
