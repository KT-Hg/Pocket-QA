/**
 * cdp/upload.js — Upload File through CDP: DOM.setFileInputFiles on a file input, or
 * on a hidden input whose files are then dropped on a drop zone.
 */

import { ignoreLastError } from '../last-error.js';

// How long an upload may take before it is given up (and the session detached).
// The error messages say the same number of seconds.
const DROPZONE_TIMEOUT_MS   = 20_000;
const FILE_INPUT_TIMEOUT_MS = 15_000;

export function setFileDropZoneViaCdp(tabId, dropSelector, filePaths) {
  return new Promise((resolve, reject) => {
    // Set once the attach callback has run and knows whether the session is ours
    // to close. The timeout path calls it too: it used to reject without
    // detaching, so a CDP command that never came back left the debugger attached
    // and Chrome's "is debugging this browser" bar on the tab for good.
    let detachIfOurs = () => {};
    const _safetyTimer = setTimeout(() => {
      detachIfOurs();
      reject(new Error('dropzone upload: timed out after 20 s'));
    }, DROPZONE_TIMEOUT_MS);
    const _safeResolve = () => { clearTimeout(_safetyTimer); resolve(); };
    const _safeReject  = (msg) => { clearTimeout(_safetyTimer); reject(new Error(msg)); };

    chrome.debugger.attach({ tabId }, '1.3', () => {
      const alreadyAttached = !!chrome.runtime.lastError;

      const detach = () => {
        if (!alreadyAttached) {
          chrome.debugger.detach({ tabId }, ignoreLastError);
        }
      };
      detachIfOurs = detach;
      const done = ()    => { detach(); _safeResolve(); };
      const fail = (msg) => { detach(); _safeReject(msg); };

      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `(function(){
          const inp = document.createElement('input');
          inp.type = 'file';
          inp.multiple = true;
          inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
          inp.setAttribute('data-cdp-dz-bridge','1');
          document.documentElement.appendChild(inp);
          return 'ok';
        })()`,
        returnByValue: true,
      }, (injectRes) => {
        if (chrome.runtime.lastError || injectRes?.result?.value !== 'ok') {
          fail('dropzone: failed to inject bridge input — ' + (chrome.runtime.lastError?.message || 'unknown'));
          return;
        }

        chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', {}, (docResult) => {
          if (chrome.runtime.lastError || !docResult?.root?.nodeId) {
            fail('dropzone: DOM.getDocument failed');
            return;
          }

          chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
            nodeId: docResult.root.nodeId,
            selector: 'input[data-cdp-dz-bridge="1"]',
          }, (bridgeRes) => {
            if (chrome.runtime.lastError || !bridgeRes?.nodeId) {
              fail('dropzone: could not find bridge input after injection');
              return;
            }

            chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
              files:  filePaths,
              nodeId: bridgeRes.nodeId,
            }, () => {
              if (chrome.runtime.lastError) {
                fail('dropzone: DOM.setFileInputFiles on bridge failed — ' + chrome.runtime.lastError.message);
                return;
              }

              const sel = JSON.stringify(dropSelector);
              chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
                expression: `(function(){
                  try {
                    const inp = document.querySelector('input[data-cdp-dz-bridge="1"]');
                    const dz  = document.querySelector(${sel});
                    if (!inp)              return 'no bridge input';
                    if (!dz)               return 'dropzone element not found for selector: '+${sel};
                    if (!inp.files.length) return 'no files loaded in bridge';
                    const dt = new DataTransfer();
                    Array.from(inp.files).forEach(f => dt.items.add(f));
                    ['dragenter','dragover','drop'].forEach(t =>
                      dz.dispatchEvent(new DragEvent(t,{bubbles:true,cancelable:true,dataTransfer:dt}))
                    );
                    inp.remove();
                    return 'ok';
                  } catch(e) {
                    return 'error:'+e.message;
                  }
                })()`,
                returnByValue: true,
              }, (dropRes) => {
                if (chrome.runtime.lastError) {
                  fail('dropzone: drop simulation CDP error — ' + chrome.runtime.lastError.message);
                  return;
                }
                const val = dropRes?.result?.value;
                if (val !== 'ok') {
                  fail('dropzone: drop simulation failed — ' + (val || 'unknown'));
                } else {
                  done();
                }
              });
            });
          });
        });
      });
    });
  });
}

/* ── Upload File via CDP ────────────────────────────────────────────────────── */

// Uses CDP DOM.setFileInputFiles — same mechanism as Selenium/Playwright, bypasses the OS file-picker.
export function setFileInputViaCdp(tabId, selector, filePaths) {
  return new Promise((resolve, reject) => {
    // See setFileDropZoneViaCdp: the timeout must detach too, or a hung CDP call
    // strands the debugger session on the tab.
    let detachIfOurs = () => {};
    const _safetyTimer = setTimeout(() => {
      detachIfOurs();
      reject(new Error('uploadFile: timed out after 15 s'));
    }, FILE_INPUT_TIMEOUT_MS);
    const _safeResolve = () => { clearTimeout(_safetyTimer); resolve(); };
    const _safeReject  = (msg) => { clearTimeout(_safetyTimer); reject(new Error(msg)); };

    chrome.debugger.attach({ tabId }, '1.3', () => {
      const alreadyAttached = !!chrome.runtime.lastError;

      const detach = () => {
        if (!alreadyAttached) {
          chrome.debugger.detach({ tabId }, ignoreLastError);
        }
      };
      detachIfOurs = detach;
      const done = ()    => { detach(); _safeResolve(); };
      const fail = (msg) => { detach(); _safeReject(msg); };

      // Step 1: get document root node
      chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', {}, (docResult) => {
        if (chrome.runtime.lastError || !docResult?.root?.nodeId) {
          fail('uploadFile: DOM.getDocument failed — ' + (chrome.runtime.lastError?.message || 'no root node'));
          return;
        }

        // Step 2: find the file input by selector
        chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
          nodeId: docResult.root.nodeId,
          selector,
        }, (queryResult) => {
          if (chrome.runtime.lastError || !queryResult?.nodeId) {
            fail('uploadFile: selector not found — ' + selector);
            return;
          }

          // Step 3: set the files — browser fires the change event automatically
          chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
            files:  filePaths,
            nodeId: queryResult.nodeId,
          }, () => {
            if (chrome.runtime.lastError) {
              fail('uploadFile: DOM.setFileInputFiles failed — ' + chrome.runtime.lastError.message +
                   ' (selector is not a file input? Try DropZone mode)');
              return;
            }
            done();
          });
        });
      });
    });
  });
}
