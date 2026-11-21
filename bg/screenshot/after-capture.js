/**
 * screenshot/after-capture.js — what every capture the user took does once it is
 * saved: it goes into Recent captures and onto the clipboard.
 *
 * Only captures the user started come here (popup buttons, hotkeys, segment and
 * element pick); a run's Screenshot steps, CSV shots and failure pictures do not.
 * Their callers ask for `returnBase64` and hand the result over before reporting it.
 *
 * The clipboard can only be written from a focused page in a secure context:
 *  - the popup, when it is open (a Full or Scroll capture keeps it open): the
 *    result says `copyBy: 'popup'` and the popup copies the Recent entry itself;
 *  - otherwise the captured page, through its content script (COPY_IMAGE).
 * A page that cannot (http:// that is not localhost, no focus, no content script)
 * leaves `copyError`, and the toast or notification says so.
 */

import { addRecent } from '../../shared/recent-captures.js';
import { tabMsg } from '../tabs.js';
import { popupOpen } from './report.js';

// A large picture takes a moment to decode and write on the page.
const COPY_TIMEOUT_MS = 15_000;

/**
 * @param {number|null} tabId  the captured tab (its top frame copies)
 * @param {object} result      a capture result; `base64` is taken out of it
 * @param {string} kind        how Recent names it: Page, Full, Down, Across, Segment, Element
 * @param {{fromHotkey?: boolean}} [opts]
 * @returns {Promise<object>}  the result with `recentId` and `copied` / `copyBy` / `copyError`
 */
export async function afterCapture(tabId, result, kind, { fromHotkey = false } = {}) {
  if (!result) return result;
  const { base64, ...out } = result;
  if (!out.success || !base64) return out;
  const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
  const recentId = await addRecent({ blob, kind, name: out.filename }).catch(() => null);
  // The popup copies from Recent, so only a capture Recent kept can be left to it.
  if (recentId != null) out.recentId = recentId;
  if (recentId != null && await popupOpen(fromHotkey)) {
    out.copyBy = 'popup';
    return out;
  }
  const r = tabId == null ? null : await tabMsg(tabId, { type: 'COPY_IMAGE', base64 }, COPY_TIMEOUT_MS, 0);
  if (r?.ok) out.copied = true;
  else out.copyError = r?.error && !r._noContentScript ? r.error : 'this page cannot write to the clipboard';
  return out;
}
