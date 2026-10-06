/**
 * screenshot/queue.js — captures on the same tab run one after another.
 */

/* ── Per-tab screenshot serialization queue ─────────────────────────────────────
 * Chrome's CDP debugger is attached/detached around every CDP capture. If two
 * captures race on the same tab, the second attach fires while the first session
 * is still open, producing "Another debugger is already attached" errors and
 * leaving the debugger in an indeterminate state. Serializing per-tab prevents
 * this without blocking captures on different tabs.
 * ────────────────────────────────────────────────────────────────────────────── */

const _screenshotQueues = new Map();

/**
 * Run fn() only after any in-progress screenshot on the same tab resolves.
 * Uses a promise chain so failures in fn() still allow the next queued call
 * to run — the queue never deadlocks even if a capture throws.
 */
export function queueScreenshot(tabId, fn) {
  const prev = _screenshotQueues.get(tabId) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  _screenshotQueues.set(tabId, next.catch(() => {}));
  return next;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  _screenshotQueues.delete(tabId);
});
