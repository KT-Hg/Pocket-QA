/**
 * playback/steps/upload.js — Upload File: set the files through CDP (DOM.setFileInputFiles,
 * or a drop on a drop zone).
 */

import { cssEscape } from '../../../shared/css-escape.js';
import { setFileInputViaCdp, setFileDropZoneViaCdp } from '../../cdp/upload.js';
import { afterFailure } from './flow.js';
import { inFrame, markTarget, unmarkTarget, OTHER_ORIGIN_FRAME } from './page-target.js';
import { strictFor } from './click-through.js';

// Tagged in its frame, yet not found from the page: a frame of another origin.
const _cdpError = (e, target, action) => (target.css && inFrame(action) && /not found/.test(e.message)
  ? `Upload File: ${OTHER_ORIGIN_FRAME}` : e.message);

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
    // The element the page found (page-target.js), in the action's frame; with
    // no page to ask, the action's own selector as before.
    // "Click through" off: a drop zone is checked like any element, a file input
    // only for being disabled — pages hide it on purpose.
    const strict  = strictFor(ctx, action);
    const check   = strict.strict && action.uploadMode !== 'dropzone' ? { ...strict, disabledOnly: true } : strict;
    const target  = await markTarget(tabId, action, check);
    let error = target.error || target.blocked || null;
    if (!error) {
      try {
        if (action.uploadMode === 'dropzone') {
          await setFileDropZoneViaCdp(tabId, target.css || cssSel, filePaths);
        } else {
          await setFileInputViaCdp(tabId, target.css || cssSel, filePaths);
        }
      } catch (e) {
        error = _cdpError(e, target, action);
      } finally {
        if (target.css) await unmarkTarget(tabId, action.frameId);
      }
    }
    if (error) {
      const back = afterFailure(await fail(i, action, error), i);
      if (back !== null) return back;
    }
  }
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}
