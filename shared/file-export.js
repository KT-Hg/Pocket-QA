/**
 * file-export.js — writing a file for the user: CSV text Excel opens as it
 * should, and handing text over as a download.
 *
 * CSV is written for Excel: a UTF-8 BOM so accented text survives a
 * double-click open on Windows, CRLF line endings, and every field quoted so a
 * comma or newline inside a value cannot shift the columns.
 *
 * Used by the SQL page (sqlcases/export.js) and the API Tests page.
 */

/** One CSV cell, always quoted; null and undefined are empty. */
export function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

/** CSV text of `rows` (arrays of cells), with a BOM unless `bom` is false. */
export function csvText(rows, { bom } = {}) {
  const body = rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
  return bom === false ? body : '﻿' + body;
}

/**
 * Hand a generated file to the user.
 *
 * `chrome.downloads` is used where it exists (the extension page) so the file
 * lands in the browser's download folder with a proper name; the anchor
 * fallback keeps the module usable when loaded outside the extension.
 */
export function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const REVOKE_DELAY_MS = 60_000; // the save dialog may stay open a while
  const revoke = () => setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);

  if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
    chrome.downloads.download({ url, filename, saveAs: true }, () => revoke());
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  revoke();
}
