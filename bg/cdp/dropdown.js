/**
 * cdp/dropdown.js — opening a dropdown with a trusted CDP click.
 */

import { ignoreLastError } from '../last-error.js';
import { markSessionClosed, markSessionOpen } from './session.js';

// Resolve after this long anyway, so a crashed renderer cannot hang the run.
const SAFETY_TIMEOUT_MS = 10_000;
// A freshly attached session gets this long to settle before the click; a reused
// one none, to avoid a visible flicker.
const FRESH_ATTACH_SETTLE_MS = 700;

/* ── CDP Script Execution ───────────────────────────────────────────────────── */

// Native <select>: mousePressed only — mouseReleased/detach closes the OS popup before user can interact.
// Custom dropdowns: full press+release then detach. 10-second safety timeout guards crashed renderers.
export function openDropdownViaCdp(tabId, selector) {
  return new Promise((resolve) => {
    const _safetyTimer = setTimeout(resolve, SAFETY_TIMEOUT_MS);
    const _safeResolve = () => { clearTimeout(_safetyTimer); resolve(); };

    chrome.tabs.get(tabId, (tab) => {
      // Do NOT call chrome.windows.update({ focused: true }) here.
      // Focusing the window would interrupt the user if they are on another tab
      // while CSV runs in the background.  CDP mousePressed works without focus
      // for most custom dropdowns; native <select> OS pickers may not open but
      // the element still receives the trusted click event.
      void tab; // tab retained for potential future use (e.g. windowId checks)
      const focusAndOpen = () => {
        chrome.debugger.attach({ tabId }, '1.3', () => {
          const alreadyAttached = !!chrome.runtime.lastError;

          let _doneCalled = false;
          const done = () => {
            if (_doneCalled) return;
            _doneCalled = true;
            if (!alreadyAttached) {
              chrome.debugger.detach({ tabId }, ignoreLastError);
            }
            _safeResolve();
          };

          // Allow a brief stabilisation period when attaching fresh; skip
          // if a session was already open to avoid visible flicker.
          const delay = alreadyAttached ? 0 : FRESH_ATTACH_SETTLE_MS;

          setTimeout(() => {
            try {
              chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
                expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' }); const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width/2, y: r.top + r.height/2, isSelect: el.tagName === 'SELECT' }); })()`,
                returnByValue: true,
              }, (rectRes) => {
                void chrome.runtime.lastError;
                try {
                  let info = null;
                  try { info = JSON.parse(rectRes?.result?.value); } catch (_) { /* not JSON: info stays null, handled just below */ }
                  if (!info) { done(); return; }

                  const x = Math.round(info.x);
                  const y = Math.round(info.y);

                  if (info.isSelect) {
                    // Native <select>: send only mousePressed — do NOT detach here.
                    // Detaching would synthesize mouseReleased and close the popup.
                    chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
                      { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers: 0 },
                      () => {
                        if (chrome.runtime.lastError) { done(); return; }
                        markSessionOpen(tabId);
                        _safeResolve();
                        _doneCalled = true;
                      },
                    );
                  } else {
                    // Custom dropdown: full click sequence then detach.
                    markSessionClosed(tabId);
                    chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
                      { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers: 0 },
                      () => {
                        if (chrome.runtime.lastError) { done(); return; }
                        chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
                          { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers: 0 },
                          () => { void chrome.runtime.lastError; done(); },
                        );
                      },
                    );
                  }
                } catch (innerErr) {
                  console.error('[CDP] openDropdownViaCdp inner error:', innerErr);
                  done();
                }
              });
            } catch (outerErr) {
              console.error('[CDP] openDropdownViaCdp outer error:', outerErr);
              done();
            }
          }, delay);
        });
      };

      focusAndOpen();
    });
  });
}
