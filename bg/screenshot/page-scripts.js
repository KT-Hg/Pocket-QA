/**
 * screenshot/page-scripts.js — what a capture runs in the page: hide / show the scrollbar
 * and our overlays, pin sticky elements in the flow, load lazy images and frames, find
 * the frames, undo the tiling transform, through chrome.scripting or CDP.
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
export async function restorePageDom(tabId) {
  await scriptingExec(tabId, _restoreDomFn);
  await scriptingExec(tabId, unpinStickyFn);
  await scriptingExec(tabId, restoreLazyFn);
}

/* ── Sticky, lazy and framed content (run in the page, by CDP or scripting) ──
   Each function below is serialised on its own (chrome.scripting, or `(${fn})()`
   through CDP), so it closes over nothing and walks the open shadow roots itself. */

/**
 * Lay out every element that sticks to the page's own scroll (the viewport) as an
 * ordinary in-flow element for the capture: position relative, no offsets.
 *
 * A capture renders the page from scroll 0 (one shot past the viewport, or the
 * tiles shifted with a transform), and at scroll 0 a `position: sticky; bottom: 0`
 * bar further down the page is stuck to the bottom of the FIRST viewport: it was
 * drawn over the content there, and the place it holds in the flow, further down,
 * came out as a white band — one per sticky footer on the page. Relative with no
 * offsets keeps the box exactly where the flow puts it (sticky keeps its space, so
 * nothing moves), and keeps it a containing block and its z-index.
 *
 * Sticky elements inside another scroll container (a table's header in a scrolling
 * box) stick to that container, which the capture does not scroll: left as they are.
 * The inline values replaced are kept in `data-pqa-sticky`, for unpinStickyFn.
 * Returns the number of elements pinned.
 */
export const pinStickyFn = () => {
  const ATTR = 'data-pqa-sticky';
  const SIDES = ['position', 'top', 'right', 'bottom', 'left'];
  const html = document.documentElement;
  const body = document.body;
  const all = [];
  const visit = (root) => {
    for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) visit(el.shadowRoot); }
  };
  visit(document);
  const htmlCs = getComputedStyle(html);
  // The body's overflow belongs to the viewport unless the root sets its own.
  const bodyIsViewport = htmlCs.overflowX === 'visible' && htmlCs.overflowY === 'visible';
  const SCROLLS = /^(auto|scroll|hidden|overlay)$/;
  const parentOf = (el) => el.assignedSlot || el.parentElement || el.getRootNode?.()?.host || null;
  const sticksToViewport = (el) => {
    for (let p = parentOf(el); p && p !== html; p = parentOf(p)) {
      if (p === body && bodyIsViewport) continue;
      const cs = getComputedStyle(p);
      if (SCROLLS.test(cs.overflowX) || SCROLLS.test(cs.overflowY)) return false;
    }
    return true;
  };
  let pinned = 0;
  for (const el of all) {
    if (el.hasAttribute(ATTR)) continue; // left by an interrupted capture: its originals are kept
    const pos = getComputedStyle(el).position;
    if ((pos !== 'sticky' && pos !== '-webkit-sticky') || !sticksToViewport(el)) continue;
    const keep = {};
    for (const p of SIDES) keep[p] = [el.style.getPropertyValue(p), el.style.getPropertyPriority(p)];
    el.setAttribute(ATTR, JSON.stringify(keep));
    el.style.setProperty('position', 'relative', 'important');
    for (const p of SIDES.slice(1)) el.style.setProperty(p, 'auto', 'important');
    pinned++;
  }
  return pinned;
};

/** Undo pinStickyFn: the inline position and offsets as they were. */
export const unpinStickyFn = () => {
  const ATTR = 'data-pqa-sticky';
  const visit = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.hasAttribute(ATTR)) {
        let keep = {};
        try { keep = JSON.parse(el.getAttribute(ATTR)) || {}; } catch (_) { /* unreadable: clear what we set */ }
        for (const p of ['position', 'top', 'right', 'bottom', 'left']) {
          const [value, priority] = keep[p] || ['', ''];
          if (value) el.style.setProperty(p, value, priority); else el.style.removeProperty(p);
        }
        el.removeAttribute(ATTR);
      }
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(document);
};

/**
 * Load what the page defers with `loading="lazy"` — images and iframes (a YouTube
 * embed usually is one) — before the capture, and wait for them, up to `maxMs`.
 *
 * Neither capture path scrolls, so a lazy image or frame below the first viewport
 * was never asked for: it came out blank, or as a box with no height where the
 * frame's script sizes it after it loads. Switching the attribute to eager loads
 * it now, the way scrolling to it would. The attribute goes back afterwards
 * (restoreLazyFn), which does not unload anything. Resolves with how many were
 * still loading.
 */
export const loadLazyFn = (maxMs) => {
  const ATTR = 'data-pqa-lazy';
  const lazy = [];
  const visit = (root) => {
    for (const el of root.querySelectorAll('img, iframe')) {
      if ((el.getAttribute('loading') || '').toLowerCase() === 'lazy') lazy.push(el);
    }
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) visit(host.shadowRoot);
  };
  visit(document);
  // A frame still on its initial about:blank has not loaded its src; a frame of
  // another origin that has loaded cannot be read at all.
  const frameLoading = (f) => {
    const src = f.getAttribute('src');
    if (!src || src === 'about:blank') return false;
    try { return f.contentWindow?.location.href === 'about:blank'; } catch (_) { return false; }
  };
  const waits = [];
  for (const el of lazy) {
    const loading = el.tagName === 'IMG' ? !el.complete : frameLoading(el);
    el.setAttribute(ATTR, el.getAttribute('loading'));
    el.setAttribute('loading', 'eager');
    if (loading) {
      waits.push(new Promise((done) => {
        el.addEventListener('load', done, { once: true });
        el.addEventListener('error', done, { once: true });
      }));
    }
  }
  if (!waits.length) return 0;
  return Promise.race([Promise.all(waits), new Promise((done) => setTimeout(done, maxMs))]).then(() => waits.length);
};

/** Undo loadLazyFn's attribute change (what loaded stays loaded). */
export const restoreLazyFn = () => {
  const ATTR = 'data-pqa-lazy';
  const visit = (root) => {
    for (const el of root.querySelectorAll(`[${ATTR}]`)) {
      el.setAttribute('loading', el.getAttribute(ATTR) || 'lazy');
      el.removeAttribute(ATTR);
    }
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) visit(host.shadowRoot);
  };
  visit(document);
};

/**
 * The page-coordinate boxes of the visible frames (iframe, frame, embed, object) —
 * the parts of a page another renderer may draw. Page.captureScreenshot with
 * captureBeyondViewport leaves a frame of another origin that lies outside the
 * viewport blank (a YouTube embed below the fold came out white): such a frame only
 * paints while it is on screen, and the one-shot capture never puts it there.
 *
 * Measured with the root shifted by nothing, as both capture paths render it: a
 * fixed frame (a chat widget) is then where the capture draws it, at the bottom
 * of the page rather than of the first viewport.
 */
export const frameRectsFn = () => {
  const out = [];
  const visit = (root) => {
    for (const el of root.querySelectorAll('iframe, frame, embed, object')) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || getComputedStyle(el).visibility === 'hidden') continue;
      out.push({ x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height });
    }
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) visit(host.shadowRoot);
  };
  const html = document.documentElement;
  const transform = html.style.transform;
  html.style.transform = 'translate(0px, 0px)';
  try { visit(document); } finally { html.style.transform = transform; }
  return out;
};

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

/**
 * `Runtime.evaluate` through the attached debugger, awaited, for its value;
 * `fallback` when it throws, times out or the session is gone.
 */
export function cdpValue(tabId, expression, fallback = null, timeout = 10_000) {
  return new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, timeout,
    }, (res) => {
      if (chrome.runtime.lastError || !res || res.exceptionDetails) { resolve(fallback); return; }
      resolve(res.result?.value ?? fallback);
    });
  });
}

// A function's source keeps the file's line endings (CRLF in a Windows checkout):
// send LF so the expression is the same on every checkout.
const src = (fn) => String(fn).replace(/\r\n/g, '\n');
export const CDP_PIN_STICKY = `(${src(pinStickyFn)})()`;
export const CDP_UNPIN_STICKY = `(${src(unpinStickyFn)})()`;
export const cdpLoadLazy = (maxMs) => `(${src(loadLazyFn)})(${Number(maxMs) || 0})`;
export const CDP_RESTORE_LAZY = `(${src(restoreLazyFn)})()`;
export const CDP_FRAME_RECTS = `(${src(frameRectsFn)})()`;

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
