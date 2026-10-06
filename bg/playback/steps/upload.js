/**
 * playback/steps/upload.js — Upload File: set the files through CDP (DOM.setFileInputFiles,
 * or a drop on a drop zone).
 */

import { cssEscape } from '../../../shared/css-escape.js';
import { setFileInputViaCdp, setFileDropZoneViaCdp } from '../../cdp/upload.js';
import { FAIL_RETRY, FAIL_STOP } from '../failure-prompt.js';
import { STOP } from './flow.js';

export async function runUploadFile(ctx, i, action) {
  const { tabId, fail } = ctx;
  const cssSel = action.selectors?.css
    || (action.selectors?.id ? `#${cssEscape(action.selectors.id)}` : null)
    || action.selector || '';
  const folder = (action.folderPath || '').replace(/[/\\]+$/, '');
  // backward-compat: old actions store a single fileName string
  let rawNames;
  if (Array.isArray(action.fileNames) && action.fileNames.length) rawNames = action.fileNames;
  else if (action.fileName) rawNames = [action.fileName];
  else rawNames = [];

  if (!cssSel || !folder || !rawNames.length) {
    const next = await fail(i, action, 'uploadFile: missing selector, folderPath, or file name(s)');
    if (next === FAIL_RETRY) return i - 1;
    if (next === FAIL_STOP) return STOP;
  } else {
    const sep       = folder.includes('\\') ? '\\' : '/';
    const filePaths = rawNames.map(n => `${folder}${sep}${n}`);
    try {
      if (action.uploadMode === 'dropzone') {
        await setFileDropZoneViaCdp(tabId, cssSel, filePaths);
      } else {
        await setFileInputViaCdp(tabId, cssSel, filePaths);
      }
    } catch (e) {
      const next = await fail(i, action, e.message);
      if (next === FAIL_RETRY) return i - 1;
      if (next === FAIL_STOP) return STOP;
    }
  }
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}
