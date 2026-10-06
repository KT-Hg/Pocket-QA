/**
 * screenshot/download.js — saving a capture, telling a cancelled Save As apart from a
 * failure.
 */

/* ── Download & Crop ────────────────────────────────────────────────────────── */

/**
 * Download a data URL, telling a cancelled Save As dialog apart from a real failure.
 *
 * Resolves `{ id }` on success, `{ cancelled: true }` when the user dismissed the
 * dialog, or `{ error }` otherwise. It used to collapse all three into `null`,
 * which was fine while an in-popup toast was the only consumer of the outcome.
 * Hotkey captures now report through a notification, and telling someone their
 * capture "failed" because they closed the Save dialog themselves is worse than
 * saying nothing — `cancelled` is a result shape the popup already understands.
 *
 * @returns {Promise<{id?: number, cancelled?: boolean, error?: string}>}
 */
export function downloadDataUrl(dataUrl, filename, saveAs) {
  return new Promise((resolve) => {
    chrome.downloads.download({ url: dataUrl, filename, saveAs }, (id) => {
      const err = chrome.runtime.lastError?.message || '';
      if (id != null) { resolve({ id }); return; }
      resolve(/cancel/i.test(err) ? { cancelled: true } : { error: err || 'Download failed' });
    });
  });
}
