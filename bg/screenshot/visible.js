/**
 * screenshot/visible.js — Visible capture: the viewport, no debugger.
 */

import { resolveCaptureTarget, captureTabDouble } from './capture-tab.js';
import { openCropUI } from './crop.js';
import { downloadDataUrl } from './download.js';
import { buildDateFolder, buildScreenshotFilename } from './filename.js';
import { hideScrollbarFn, showScrollbarFn, scriptingExec } from './page-scripts.js';
import { queueScreenshot } from './queue.js';
import { applyWatermark } from './watermark.js';

/* ── Visible Screenshot ─────────────────────────────────────────────────────── */

/**
 * Capture the current viewport of a tab (no scrolling, no CDP attachment).
 *
 * @param {number}  tabId             - Target tab.
 * @param {object}  options
 * @param {string}  options.saveMode          - "auto" (downloads folder) | "ask" (Save As dialog).
 * @param {string}  options.prefix            - Filename prefix when auto-naming.
 * @param {string|null} options.requestedFilename - Override filename, or null for auto.
 * @param {boolean} options.crop              - Open crop UI instead of saving directly.
 * @param {boolean} options.returnBase64      - Include raw base64 in the result object.
 * @param {boolean} options.skipDownload      - Capture without saving (e.g. for CSV tovar).
 * @returns {Promise<{success?: boolean, filename?: string, base64?: string, error?: string}>}
 */
export function takeVisibleScreenshot(tabId, options = {}) {
  return queueScreenshot(tabId, () => _takeVisibleScreenshot(tabId, options));
}

async function _takeVisibleScreenshot(tabId, {
  saveMode, prefix, requestedFilename, crop = false, returnBase64 = false, skipDownload = false,
}) {
  const filename = buildScreenshotFilename(prefix, requestedFilename);

  // Pin the capture to the target tab's own window, and refuse rather than
  // photograph the wrong page when that tab is not the one on screen.
  const target = await resolveCaptureTarget(tabId);
  if (!target) return { error: 'Target tab is gone' };
  if (!target.isActive) {
    return { error: 'Visible-area capture needs the target tab in the foreground — ' +
                    'switch to it, or use Full Page / Element capture instead' };
  }

  await scriptingExec(tabId, hideScrollbarFn);
  let dataUrl = await captureTabDouble(target.windowId);
  await scriptingExec(tabId, showScrollbarFn);
  if (!dataUrl) return { error: 'Capture failed' };
  dataUrl = await applyWatermark(dataUrl, tabId);
  if (crop) {
    const downloadPath = saveMode === 'auto' ? `screenshots/${buildDateFolder()}/${filename}` : filename;
    return openCropUI(dataUrl, downloadPath, saveMode === 'ask');
  }
  if (!skipDownload) {
    const downloadPath = saveMode === 'auto' ? `screenshots/${buildDateFolder()}/${filename}` : filename;
    const dl = await downloadDataUrl(dataUrl, downloadPath, saveMode === 'ask');
    if (dl.cancelled) return { cancelled: true };
    if (dl.error) return { error: dl.error };
  }
  const r = { success: true, filename };
  if (returnBase64) r.base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
  return r;
}
