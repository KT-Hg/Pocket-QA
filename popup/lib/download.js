/**
 * lib/download.js — downloads started from the popup, and a safe file name for them.
 */

// Revoking the object URL right after click() can beat the browser to the blob.
const REVOKE_DELAY_MS = 1000;

export function downloadCsvText(text, filename) {
  // Prepend UTF-8 BOM (\uFEFF) so Excel/spreadsheet apps detect encoding correctly
  const blob = new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/**
 * Strip path separators and characters Windows rejects from a user-supplied
 * name before it becomes a download filename. Scenario and folder names are
 * free text, so one containing "/" or ":" produced a silently renamed or
 * failed download. Spaces and hyphens are kept — callers that want them
 * collapsed do that themselves.
 */
export function safeFileName(name) {
  return String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120) || 'export';
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
