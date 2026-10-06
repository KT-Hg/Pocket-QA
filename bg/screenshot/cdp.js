/**
 * screenshot/cdp.js — the debugger session a full-page or element capture runs
 * in: attach it, wait for the page to paint, read the real viewport.
 */

import { isSessionOpen, markSessionClosed } from '../cdp/session.js';

// A detach is given this long to finish before anything else touches the tab.
export const DETACH_SETTLE_MS = 300;
// How long Runtime.evaluate may wait for the page's animation frames.
export const RAF_TIMEOUT_MS = 5000;
// After shifting the page for a tile: a beat before it is captured.
export const TILE_SETTLE_MS = 30;

/**
 * Attach the debugger to the tab; rejects when Chrome refuses.
 *
 * Always detach before attaching — Chrome rejects a second attach with
 * "Another debugger is already attached" even for a session from a prior
 * capture that ended normally. If our own session tracker says it is open,
 * update the tracker; otherwise probe silently (stale external session).
 */
export async function attachDebugger(tabId) {
  if (isSessionOpen(tabId)) {
    await new Promise(r => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; r(); }));
    markSessionClosed(tabId);
    await new Promise(r => setTimeout(r, DETACH_SETTLE_MS));
  } else {
    let staleCleaned = false;
    await new Promise(r => chrome.debugger.detach({ tabId }, () => {
      staleCleaned = !chrome.runtime.lastError; void chrome.runtime.lastError; r();
    }));
    if (staleCleaned) await new Promise(r => setTimeout(r, DETACH_SETTLE_MS));
  }

  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/** Two animation frames in the page. Resolves either way, error or not. */
export function cdpRaf(tabId, timeout = RAF_TIMEOUT_MS) {
  return new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
      awaitPromise: true, timeout,
    }, () => resolve());
  });
}

/**
 * The visible box and the page's content size, from Page.getLayoutMetrics.
 * `vpW` / `vpH` come back unchanged, and `content` null, when the command fails
 * or reports nothing usable.
 */
export async function measureViewport(tabId, vpW, vpH) {
  let content = null;
  try {
    const lm = await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics', {}, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    });
    const vv = lm?.cssVisualViewport || lm?.visualViewport;
    if (vv && vv.clientWidth > 0 && vv.clientHeight > 0) {
      vpW = Math.floor(vv.clientWidth);
      vpH = Math.floor(vv.clientHeight);
    }
    const cs = lm?.cssContentSize || lm?.contentSize;
    if (cs && cs.width > 0 && cs.height > 0) content = { width: Math.ceil(cs.width), height: Math.ceil(cs.height) };
  } catch (_) { /* keep the page-reported viewport */ }
  return { vpW, vpH, content };
}
