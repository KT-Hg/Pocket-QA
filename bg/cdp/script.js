/**
 * cdp/script.js — running a Script action through CDP (bypasses the page CSP).
 */

/**
 * Resolves to `{ error }` when the script could not run or threw, else `{}`.
 * awaitPromise is off, so a promise the script leaves rejected is not seen.
 */
export async function runScriptViaCdp(tabId, code) {
  const expression = code.replace(/^javascript:/i, '').trim();
  // The command's own error (no session, page gone), or what the script threw.
  const outcome = (res) => {
    const err = chrome.runtime.lastError?.message;
    if (err) return { error: err };
    const ex = res?.exceptionDetails;
    if (ex) return { error: String(ex.exception?.description || ex.text || 'Script threw').split('\n')[0] };
    return {};
  };
  return new Promise((resolve) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        // Already attached from a previous operation — reuse the session. Any
        // other refusal makes the command below fail, and that is reported.
        chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression, awaitPromise: false,
        }, (res) => resolve(outcome(res)));
        return;
      }
      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression, awaitPromise: false,
      }, (res) => {
        const result = outcome(res);
        chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(result); });
      });
    });
  });
}
