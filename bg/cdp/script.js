/**
 * cdp/script.js — running a Script action through CDP (bypasses the page CSP).
 */

export async function runScriptViaCdp(tabId, code) {
  const expression = code.replace(/^javascript:/i, '').trim();
  return new Promise((resolve) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        // Already attached from a previous operation — reuse the session.
        chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression, awaitPromise: false,
        }, () => { void chrome.runtime.lastError; resolve(); });
        return;
      }
      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression, awaitPromise: false,
      }, () => {
        void chrome.runtime.lastError;
        chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); });
      });
    });
  });
}
