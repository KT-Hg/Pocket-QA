/**
 * playback/steps/screenshot.js — the screenshot actions: element, to a variable (CSV),
 * visible / full page.
 */

import { normalizeVarName } from '../../../shared/var-name.js';
import { takeVisibleScreenshot, takeFullPageScreenshot, takeElementScreenshot } from '../../screenshot.js';
import { FAIL_RETRY, FAIL_STOP } from '../failure-prompt.js';
import { STOP } from './flow.js';

/** Element screenshot. */
export async function runElementScreenshot(ctx, i, action) {
  const { tabId, fail, forceAutoSave, skipDownload, getSsSettings: _getSsSettings } = ctx;
  const settings = await _getSsSettings();
  const saveMode = forceAutoSave ? 'auto' : (settings.screenshotSaveMode || 'auto');
  const prefix   = settings.screenshotPrefix || 'screenshot';
  const result   = await takeElementScreenshot(tabId, {
    selector: action.selector, saveMode, prefix, crop: false, returnBase64: false, skipDownload,
    selectors: action.selectors,
  })
    .catch(e => ({ error: e.message }));
  if (result?.error) {
    const next = await fail(i, action, result.error);
    if (next === FAIL_RETRY) return i - 1;
    if (next === FAIL_STOP) return STOP;
  }
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}

/** Screenshot → variable (CSV mode). */
export async function runScreenshotToVar(ctx, i, action) {
  const { tabId, fail, forceAutoSave, skipDownload, getSsSettings: _getSsSettings, resolvedVars, screenshotsResult } = ctx;
  const settings = await _getSsSettings();
  try {
    const saveMode = forceAutoSave ? 'auto' : (settings.screenshotSaveMode || 'auto');
    const prefix   = settings.screenshotPrefix || 'screenshot';
    let res;
    if (action.target === 'element' && action.selector) {
      res = await takeElementScreenshot(tabId, {
        selector: action.selector, saveMode, prefix, crop: false, returnBase64: true, skipDownload,
      });
    } else if (action.target === 'full') {
      res = await takeFullPageScreenshot(tabId, {
        saveMode, prefix, requestedFilename: null, crop: false, scrollDir: 'full',
        returnBase64: true, skipDownload,
      });
    } else {
      res = await takeVisibleScreenshot(tabId, {
        saveMode, prefix, requestedFilename: null, crop: false, returnBase64: true, skipDownload,
      });
    }
    if (res?.error) throw new Error(res.error);
    const ssVar = normalizeVarName(action.varName);
    if (res && ssVar) {
      resolvedVars[ssVar] = res.filename || '';
      if (screenshotsResult && res.base64) screenshotsResult[ssVar] = res.base64;
    }
  } catch (e) {
    console.error('[PLAYBACK] screenshot_tovar failed:', e);
    const next = await fail(i, action, e.message);
    if (next === FAIL_RETRY) return i - 1;
    if (next === FAIL_STOP) return STOP;
  }
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}

/** Screenshot (visible / full). */
export async function runScreenshot(ctx, i, action) {
  const { tabId, fail, forceAutoSave, skipDownload, getSsSettings: _getSsSettings } = ctx;
  const settings = await _getSsSettings();
  const saveMode = forceAutoSave ? 'auto' : (settings.screenshotSaveMode || 'auto');
  const prefix   = settings.screenshotPrefix || 'screenshot';
  const task     = action.type === 'screenshot_full'
    ? takeFullPageScreenshot(tabId, {
      saveMode, prefix, requestedFilename: action.value || null, crop: false, scrollDir: 'full',
      returnBase64: false, skipDownload,
    })
    : takeVisibleScreenshot(tabId, {
      saveMode, prefix, requestedFilename: action.value || null, crop: false, returnBase64: false,
      skipDownload,
    });
  const result = await task.catch(e => ({ error: e.message }));
  if (result?.error) {
    const next = await fail(i, action, result.error);
    if (next === FAIL_RETRY) return i - 1;
    if (next === FAIL_STOP) return STOP;
  }
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}
