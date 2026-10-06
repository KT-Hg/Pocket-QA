/**
 * screenshot/filename.js — the file name and date folder a screenshot is saved under.
 */

import { formatStamp } from '../../shared/time-format.js';

/* ── Filename Builder ───────────────────────────────────────────────────────── */

/** Returns today's date as "YYYY-MM-DD" for use as a subfolder name. */
export function buildDateFolder() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Whether auto-generated names carry the capture-type tag ("_full", "_elem", ...).
 *
 * Defaults to on, so an install that has never opened Settings keeps the names it
 * has always produced. Only an explicit `false` drops the tag — every capture mode
 * then saves as plain `{prefix}_{timestamp}.png`. Same-second captures of different
 * modes can then collide on a name; Chrome's downloader disambiguates with " (1)".
 */
export async function typeTagEnabled() {
  const res = await chrome.storage.sync.get(['screenshotTypeInName']);
  return res.screenshotTypeInName !== false;
}

/**
 * Resolve the final .png filename for a screenshot.
 * If `requestedName` is provided it is used as-is (`.png` appended if absent).
 * Otherwise a timestamped name is generated: `{prefix}{typeTag}_YYYY-MM-DD_HH-MM-SS.png`.
 *
 * @param {string} prefix        - Fallback prefix (e.g. "screenshot").
 * @param {string|null} requestedName - Caller-supplied override, or null for auto-name.
 * @param {string} typeTag       - Capture-type tag (e.g. "_full", "_elem"); pass "" to omit.
 * @returns {string} Resolved filename.
 */
export function buildScreenshotFilename(prefix, requestedName, typeTag = '') {
  if (requestedName) return requestedName.endsWith('.png') ? requestedName : `${requestedName}.png`;
  return `${prefix}${typeTag}_${formatStamp(new Date())}.png`;
}
