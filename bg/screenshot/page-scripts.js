/**
 * screenshot/page-scripts.js — what a capture runs in the page: hide / show the scrollbar
 * and our overlays, undo the tiling transform, through chrome.scripting or CDP.
 */

/* ── DOM Helper Functions (injected via scripting) ──────────────────────────── */

export const hideScrollbarFn = () => {
  if (document.getElementById('__ext_no_scroll')) return;
  const s = document.createElement('style');
  s.id = '__ext_no_scroll';
  s.textContent = '::-webkit-scrollbar{display:none!important}*:not(textarea):not(input):not(select){scrollbar-width:none!important}';
  document.documentElement.appendChild(s);
};

export const showScrollbarFn = () => { document.getElementById('__ext_no_scroll')?.remove(); };

/**
 * Undo every DOM mutation a CDP capture applies to the page — hidden scrollbar,
 * documentElement/body transforms (tile-stitch shift), and hidden fixed/sticky
 * elements. Runs via chrome.scripting, so it works even after the debugger has
 * detached (when cdpEval can no longer reach the page). See restorePageDom.
 */
const _restoreDomFn = () => {
  document.getElementById('__ext_no_scroll')?.remove();
  document.documentElement.style.transform = '';
  document.documentElement.style.transformOrigin = '';
  document.body.style.transform = '';
  document.body.style.transformOrigin = '';
  document.querySelectorAll('[data-fxhide]').forEach((el) => {
    el.style.visibility = el.getAttribute('data-fxhide') || '';
    el.removeAttribute('data-fxhide');
  });
  document.querySelectorAll('[data-exthide]').forEach((el) => {
    el.style.visibility = el.getAttribute('data-exthide') || '';
    el.removeAttribute('data-exthide');
  });
};

/**
 * Restore the page to its pre-capture state via the Scripting API.
 *
 * Unlike the cdpEval-based restore in the capture functions, this does NOT need
 * an attached debugger — essential when the user presses ESC (or clicks Cancel
 * on Chrome's "is debugging this browser" banner) mid-capture, which force-detaches
 * the session and would otherwise leave the page transformed / unscrollable.
 */
export function restorePageDom(tabId) {
  return scriptingExec(tabId, _restoreDomFn);
}

/**
 * Inject and run `fn` in the tab's main-frame context via the Scripting API.
 * `fn` is serialised, so it cannot close over anything — pass values it needs via
 * `args`. Errors are swallowed — callers that need the result should use `tabMsg`.
 */
export function scriptingExec(tabId, fn, args) {
  return new Promise((resolve) => {
    const opts = { target: { tabId }, func: fn };
    if (args) opts.args = args;
    chrome.scripting.executeScript(opts, () => { void chrome.runtime.lastError; resolve(); });
  });
}

/* ── CDP Helpers ────────────────────────────────────────────────────────────── */

/**
 * Fire-and-forget `Runtime.evaluate` via the CDP debugger.
 * Used during an already-attached CDP session to run DOM manipulation scripts
 * (hide scrollbars, reset transforms, etc.) without needing the return value.
 */
export function cdpEval(tabId, expression) {
  return new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression, awaitPromise: false,
    }, () => resolve());
  });
}

export const CDP_HIDE_SCROLLBAR = `(function(){
  if(!document.getElementById('__ext_no_scroll')){
    const s=document.createElement('style');
    s.id='__ext_no_scroll';
    s.textContent='::-webkit-scrollbar{display:none!important}*:not(textarea):not(input):not(select){scrollbar-width:none!important}';
    document.documentElement.appendChild(s);
  }
})()`;

export const CDP_SHOW_SCROLLBAR = `document.getElementById('__ext_no_scroll')?.remove()`;

// Restores fixed/sticky elements tagged `data-fxhide`. Neither capture path hides
// anything any more — both shift the page with a transform instead, which renders
// fixed/sticky correctly on its own (see either tiling loop). Kept as a safety net so
// a page left tagged by an older build or an interrupted run still recovers.
export const CDP_SHOW_FIXED = `document.querySelectorAll('[data-fxhide]').forEach(el=>{
  el.style.visibility=el.getAttribute('data-fxhide');
  el.removeAttribute('data-fxhide');
})`;

// Our own injected chrome (picker bar, segment bar, countdown pill, highlight
// tooltip) is tagged `data-ext-overlay` in the content script. Hide the whole
// family for the duration of a capture: the tiling path deliberately leaves
// fixed elements visible so a site's header renders once, which would otherwise
// bake our bars into the image too. Restored on every exit path, including
// _restoreDomFn for the case where the debugger is already gone.
export const CDP_HIDE_EXT_OVERLAYS = `document.querySelectorAll('[data-ext-overlay]').forEach(el=>{
  if(!el.hasAttribute('data-exthide')){
    el.setAttribute('data-exthide',el.style.visibility);
    el.style.visibility='hidden';
  }
})`;

export const CDP_SHOW_EXT_OVERLAYS = `document.querySelectorAll('[data-exthide]').forEach(el=>{
  el.style.visibility=el.getAttribute('data-exthide');
  el.removeAttribute('data-exthide');
})`;
