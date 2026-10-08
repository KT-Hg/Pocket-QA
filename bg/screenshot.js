/**
 * screenshot.js — screen capture in the worker: the public functions, and the
 * listener for the capture messages (TAKE_SCREENSHOT, …_FULL, …_SCROLL_V / H,
 * …_ELEMENT).
 *
 * The work is in bg/screenshot/:
 *   visible.js  full-page.js  element.js   the three ways a tab is captured
 *   capture-tab.js  page-scripts.js        captureVisibleTab; what runs in the page
 *   queue.js  cancel.js                    one capture per tab at a time; ESC / detach
 *   watermark.js  diff.js  base64.js       image work
 *   filename.js  download.js  crop.js      naming, saving, the crop editor hand-off
 *   report.js  countdown.js                the result toast / notification; the countdown
 *   settings.js                            save mode and file-name prefix
 *   window.js                              window capture (own listener, loaded by background.js)
 *
 * All three capture functions go through queueScreenshot(tabId, fn) so
 * concurrent requests on the same tab are serialized — preventing debugger-session
 * corruption when two captures race on the same tab.
 *
 * The parts are imported below in the order their code always ran: queue.js,
 * cancel.js and crop.js register listeners as they load, and the capture-message
 * listener here comes after them — listener order is dispatch order.
 */

import { tabMsg } from './tabs.js';
import { fromExtensionPage } from './sender.js';
import { ensureLockState, notifyLocked } from './update-check.js';
import { readCaptureSettings } from './screenshot/settings.js';
import { reportCaptureResult } from './screenshot/report.js';
import './screenshot/queue.js';
import './screenshot/cancel.js';
import { compareScreenshots } from './screenshot/diff.js';
import { applyWatermark } from './screenshot/watermark.js';
import { buildDateFolder, buildScreenshotFilename } from './screenshot/filename.js';
import { downloadDataUrl } from './screenshot/download.js';
import { getPendingCrop, openCropUI } from './screenshot/crop.js';
import { takeVisibleScreenshot } from './screenshot/visible.js';
import { takeFullPageScreenshot } from './screenshot/full-page.js';
import { takeElementScreenshot } from './screenshot/element.js';
import { runCountdown } from './screenshot/countdown.js';

export {
  takeVisibleScreenshot, takeFullPageScreenshot, takeElementScreenshot,
  compareScreenshots, applyWatermark, downloadDataUrl, openCropUI,
  getPendingCrop, buildScreenshotFilename, buildDateFolder, reportCaptureResult,
};

/* ── Screenshot Message Handler ─────────────────────────────────────────────── */

const FULL_TYPES   = ['TAKE_SCREENSHOT_FULL', 'TAKE_SCREENSHOT_SCROLL_V', 'TAKE_SCREENSHOT_SCROLL_H'];
const ALL_SS_TYPES = [...FULL_TYPES, 'TAKE_SCREENSHOT', 'TAKE_SCREENSHOT_ELEMENT'];

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!ALL_SS_TYPES.includes(request.type)) return;

  // Capture is one of the features the update lock disables. Awaited rather than
  // read from cache because a hotkey capture is often what wakes the worker.
  ensureLockState().then((lock) => {
    if (lock.locked) {
      notifyLocked(lock.message);
      sendResponse({ error: lock.message, locked: true });
      return;
    }
    handleScreenshotRequest(request, sender, sendResponse);
  });
  return true;
});

function handleScreenshotRequest(request, sender, sendResponse) {
  // A web page's content script captures its own tab; only an extension page
  // (the popup) names another — a compromised renderer could otherwise have any
  // open tab captured to disk.
  const tabId = (fromExtensionPage(sender) && request.tabId) || sender.tab?.id;
  if (!tabId) { sendResponse({ error: 'No tab ID' }); return; }

  if (request.type === 'TAKE_SCREENSHOT' && request.countdown > 0) {
    // Answered now rather than in `seconds` time: the popup closes the moment it
    // asks for a countdown, so nothing is waiting for the capture's own result.
    sendResponse({ countdown: request.countdown });
    runCountdown(tabId, request.countdown, !!request.crop).then((owed) => {
      if (!owed) return; // the page is running the count and will fire the shot
      // fromHotkey, because it means the same thing here: the popup is gone, so
      // a notification is the only feedback the badge countdown can leave behind.
      handleScreenshotRequest(
        { ...request, countdown: 0, fromHotkey: true }, sender, () => {},
      );
    });
    return;
  }

  if (request.type === 'TAKE_SCREENSHOT_ELEMENT') {
    readCaptureSettings(({ saveMode, prefix }) => {
      takeElementScreenshot(tabId, {
        selector: request.selector, saveMode, prefix, crop: !!request.crop, returnBase64: false,
        skipDownload: false, selectors: request.selectors, selectorType: request.selectorType,
      })
        .then((result) => {
          sendResponse(result);
          reportCaptureResult(result, { fromHotkey: !!request.fromHotkey, label: 'Element screenshot' });
        }).catch(e => sendResponse({ error: e.message }));
    });
    return;
  }

  readCaptureSettings(({ saveMode, prefix }) => {
    const crop     = !!request.crop;
    const dirMap   = {
      TAKE_SCREENSHOT_FULL:     'full',
      TAKE_SCREENSHOT_SCROLL_V: 'vertical',
      TAKE_SCREENSHOT_SCROLL_H: 'horizontal',
    };
    // Named per capture kind so a hotkey notification says which shortcut fired.
    const LABELS = {
      TAKE_SCREENSHOT:          'Screenshot',
      TAKE_SCREENSHOT_FULL:     'Full-page screenshot',
      TAKE_SCREENSHOT_SCROLL_V: 'Vertical scroll screenshot',
      TAKE_SCREENSHOT_SCROLL_H: 'Horizontal scroll screenshot',
    };
    const isFull = FULL_TYPES.includes(request.type);
    // Tell the page a cancellable capture is running so ESC can abort it. Toggled
    // off when the task settles — done at this single choke point so every exit
    // path (success, error, cancel) clears it.
    if (isFull) tabMsg(tabId, { type: 'FULL_CAPTURE_STATE', active: true }).catch(() => {});
    const task = isFull
      ? takeFullPageScreenshot(tabId, {
        saveMode, prefix, requestedFilename: request.filename, crop,
        scrollDir: dirMap[request.type],
      })
      : takeVisibleScreenshot(tabId, { saveMode, prefix, requestedFilename: request.filename, crop });
    task.then((result) => {
      sendResponse(result);
      reportCaptureResult(result, { fromHotkey: !!request.fromHotkey, label: LABELS[request.type] || 'Screenshot' });
    }).catch(e => sendResponse({ error: e.message }))
      .finally(() => { if (isFull) tabMsg(tabId, { type: 'FULL_CAPTURE_STATE', active: false }).catch(() => {}); });
  });
}
