/**
 * last-error.js — the callback for a chrome.* call whose failure needs no handling.
 *
 * Reading chrome.runtime.lastError in the callback is what tells Chrome the error
 * was looked at; without it Chrome logs "Unchecked runtime.lastError". Used where
 * the outcome does not matter: closing a window that may already be gone,
 * detaching a debugger that may not be attached, a best-effort notification…
 *
 * Imported by the service worker and the popup. content.js is a classic script
 * and cannot import; it reads lastError inline.
 */

export function ignoreLastError() {
  void chrome.runtime.lastError;
}
