/**
 * handlers/capture.js — messages about captures started by message: the image
 * editor and crop, image diff, segment capture, the element-screenshot hotkey.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { idleSegmentCapture, state } from '../state.js';
import { updateBadge } from '../badge.js';
import { takeFullPageScreenshot, compareScreenshots, downloadDataUrl, openCropUI, buildScreenshotFilename, getPendingCrop, reportCaptureResult } from '../screenshot.js';
import { ignoreLastError } from '../last-error.js';
import { readCaptureSettings } from '../screenshot/settings.js';

// After a zoom reset, the page gets this long to reflow before the selection starts.
const ZOOM_SETTLE_MS = 300;
// A saved crop whose download never reports back stops being waited for after this.
const SAVE_TIMEOUT_MS = 60_000;

/**
 * Start a segment-capture session on a tab, from the hotkey or from the popup.
 *
 * Browser zoom is reset to 100% for the WHOLE session before the on-page
 * selection starts. The selection rect is recorded from scrollX/Y + innerWidth/Height
 * (CSS px at the current zoom), so it must be selected AND captured at the same zoom.
 * Resetting up-front means both happen at 100% — the segment image then matches the
 * Full/Scroll/Element captures. origZoom is restored when the session ends.
 *
 * fromHotkey rides along in the session state because the capture itself is
 * triggered later by a second message (CAPTURE_SEGMENT), which has no way of
 * knowing whether the session started from a hotkey or from the popup.
 */
function beginSegmentSession(tabId, dir, { crop, fromHotkey }) {
  chrome.tabs.getZoom(tabId, (origZoom) => {
    void chrome.runtime.lastError;
    const needReset = typeof origZoom === 'number' && Math.abs(origZoom - 1) > 0.01;
    state.segmentCapture = { active: true, tabId, dir, crop, origZoom: needReset ? origZoom : null, fromHotkey };
    const startSelection = () => chrome.tabs.sendMessage(tabId, { type: "START_SEGMENT_TAB", dir });
    if (needReset) chrome.tabs.setZoom(tabId, 1, () => { void chrome.runtime.lastError; setTimeout(startSelection, ZOOM_SETTLE_MS); });
    else startSelection();
  });
}

export const captureHandlers = {
  /* --- Image Editor (from clipboard / file in popup) --- */
  OPEN_IMAGE_EDITOR(request, sender, sendResponse) {
    const { dataUrl, sourceFileName } = request;
    let downloadPath;
    if (sourceFileName) {
      // Uploaded / dropped file: "{baseName}_edited_YYYY-MM-DD_HH-MM-SS.png"
      const baseName = sourceFileName.replace(/\.[^.]+$/, '');
      downloadPath = buildScreenshotFilename(baseName + '_edited', null);
    } else {
      // Paste / clipboard: use same configurable prefix as auto screenshots
      chrome.storage.sync.get(["screenshotPrefix"], (settings) => {
        const prefix = settings.screenshotPrefix || "screenshot";
        const path = buildScreenshotFilename(prefix, null);
        openCropUI(dataUrl, path, false);
      });
      sendResponse({ ok: true });
      return;
    }
    openCropUI(dataUrl, downloadPath, false);
    sendResponse({ ok: true });
    return;
  },

  /* --- Crop UI ---
   * Keyed by the token in the editor window's URL, and deliberately NOT consumed
   * on read: the entry lives until that window closes, so reloading the editor
   * re-loads the same image instead of finding an empty slot and closing. */
  GET_PENDING_CROP(request, sender, sendResponse) {
    sendResponse({ crop: getPendingCrop(request.token) });
    return;
  },

  SAVE_CROPPED(request, sender, sendResponse) {
    downloadDataUrl(request.dataUrl, request.downloadPath, request.saveAs).then((dl) => {
      if (dl.cancelled) { sendResponse({ cancelled: true }); return; }
      if (dl.error) { sendResponse({ error: dl.error }); return; }
      const id = dl.id;
      let responded = false;
      const respond = (r) => { if (!responded) { responded = true; sendResponse(r); } };

      // Cleanup removes listener AND clears timeout to prevent leaks.
      const cleanup = (result) => {
        clearTimeout(timeoutHandle);
        chrome.downloads.onChanged.removeListener(onChanged);
        respond(result);
      };

      const onChanged = (delta) => {
        if (delta.id !== id) return;
        const st = delta.state?.current;
        if (st === 'complete')         cleanup({ success: true });
        else if (st === 'interrupted') cleanup({ error: 'Cancelled' });
      };

      // 60 s hard timeout removes the listener even on hung/stalled downloads,
      // preventing a permanent listener leak in the service worker.
      const timeoutHandle = setTimeout(() => cleanup({ error: 'Download timeout' }), SAVE_TIMEOUT_MS);

      chrome.downloads.onChanged.addListener(onChanged);
      // Race guard: the download may have already completed between the download()
      // call and the listener registration.  Poll current state to catch that window.
      chrome.downloads.search({ id }, (items) => {
        if (!items?.length) return;
        const st = items[0].state;
        if (st === 'complete')         cleanup({ success: true });
        else if (st === 'interrupted') cleanup({ error: 'Cancelled' });
      });
    });
    return true;
  },

  /* --- Image diff --- */
  COMPARE_SCREENSHOTS(request, sender, sendResponse) {
    compareScreenshots(request.dataUrlA, request.dataUrlB, request.threshold ?? 10)
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  },

  /* --- Hotkey: start segment capture from content script --- */
  HOTKEY_SEG_START(request, sender, sendResponse) {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    beginSegmentSession(tabId, request.dir, { crop: false, fromHotkey: true });
    sendResponse({ ok: true });
    return;
  },

  /* --- Hotkey: element screenshot — start pick mode --- */
  HOTKEY_SCREENSHOT_ELEMENT(request, sender, sendResponse) {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    chrome.storage.local.set({ elemShotPickPending: true, elemShotPickCrop: false });
    state.pickMode = true;
    updateBadge();
    chrome.tabs.sendMessage(tabId, { type: "START_PICK_MODE" });
    sendResponse({ ok: true });
    return;
  },

  /* --- Segment capture: start --- */
  START_SEGMENT_CAPTURE(request, sender, sendResponse) {
    beginSegmentSession(request.tabId, request.dir, { crop: !!request.crop, fromHotkey: false });
    sendResponse({ ok: true });
    return;
  },

  /* --- Segment capture: stop & capture --- */
  CAPTURE_SEGMENT(request, sender, sendResponse) {
    const { tabId, dir, crop, origZoom, fromHotkey } = state.segmentCapture;
    state.segmentCapture = idleSegmentCapture();
    // Restore the user's zoom once the capture settles (success or error).
    const restoreZoom = () => { if (origZoom != null && tabId != null) chrome.tabs.setZoom(tabId, origZoom, ignoreLastError); };
    readCaptureSettings(({ saveMode, prefix }) => {
      const { yStart, yEnd, xStart, xEnd } = request;
      const segClip = { x: xStart, y: yStart, width: xEnd - xStart, height: yEnd - yStart };
      takeFullPageScreenshot(tabId, {
        saveMode, prefix, requestedFilename: null, crop, scrollDir: 'full', returnBase64: false,
        skipDownload: false, segmentClip: segClip, segmentDir: dir,
      })
        .then(result => {
          reportCaptureResult(result, { fromHotkey, label: "Segment screenshot" });
        })
        .catch(e => {
          reportCaptureResult({ error: e.message }, { fromHotkey, label: "Segment screenshot" });
        })
        .finally(restoreZoom);
    });
    sendResponse({ ok: true });
    return;
  },

  /* --- Segment capture: cancel --- */
  CANCEL_SEGMENT_CAPTURE(request, sender, sendResponse) {
    const { tabId, origZoom } = state.segmentCapture;
    if (origZoom != null && tabId != null) chrome.tabs.setZoom(tabId, origZoom, ignoreLastError);
    state.segmentCapture = idleSegmentCapture();
    sendResponse({ ok: true });
    return;
  },
};
