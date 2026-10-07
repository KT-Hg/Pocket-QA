/**
 * playback/steps/upload.js — Upload File: set the files through CDP (DOM.setFileInputFiles,
 * or a drop on a drop zone).
 */

import { cssEscape } from '../../../shared/css-escape.js';
import { setFileInputViaCdp, setFileDropZoneViaCdp } from '../../cdp/upload.js';
import { afterFailure } from './flow.js';

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
    const back = afterFailure(await fail(i, action, 'uploadFile: missing selector, folderPath, or file name(s)'), i);
    if (back !== null) return back;
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
      const back = afterFailure(await fail(i, action, e.message), i);
      if (back !== null) return back;
    }
  }
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}
