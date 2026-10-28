/**
 * cdp/upload.js — Upload File through CDP: DOM.setFileInputFiles on a file input, or
 * on a hidden input whose files are then dropped on a drop zone (the code exports
 * do the same with DROP_BRIDGE_JS and DROP_FILES_JS of popup/export/page-js.js).
 * The element is looked for in the page and its same-origin frames (deep-find.js).
 */

import { ignoreLastError } from '../last-error.js';
import { deepFindExpr } from './deep-find.js';

// How long an upload may take before it is given up (and the session detached).
// The error messages say the same number of seconds.
const DROPZONE_TIMEOUT_MS   = 20_000;
const FILE_INPUT_TIMEOUT_MS = 15_000;

// DOM.setFileInputFiles takes a path that is not there without a word: the input
// then holds an empty File the page cannot read, and the form sends no file. A
// page function on the input: the indexes of its files that cannot be read (one
// with a size is there; an empty one is read to tell).
const MISSING_FILES_FN = `async function () {
  const missing = [];
  for (const [i, f] of Array.from(this.files).entries()) {
    if (!f.size) await f.arrayBuffer().catch(() => missing.push(i));
  }
  return missing;
}`;

/** The error for the files at `indexes` (MISSING_FILES_FN) of `filePaths`. */
const notFound = (filePaths, indexes) => 'file not found — ' + indexes.map((i) => filePaths[i]).join(', ');

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
                expression: `(async function(){
                  try {
                    const inp = document.querySelector('input[data-cdp-dz-bridge="1"]');
                    const dz  = ${deepFindExpr(dropSelector)};
                    if (!inp)              return 'no bridge input';
                    if (!dz)               return 'dropzone element not found for selector: '+${sel};
                    if (!inp.files.length) return 'no files loaded in bridge';
                    const missing = await (${MISSING_FILES_FN}).call(inp);
                    if (missing.length) { inp.remove(); return missing; }
                    // The zone's own window: in a frame, its events come from there.
                    const win = dz.ownerDocument.defaultView;
                    const dt = new win.DataTransfer();
                    Array.from(inp.files).forEach(f => dt.items.add(f));
                    ['dragenter','dragover','drop'].forEach(t =>
                      dz.dispatchEvent(new win.DragEvent(t,{bubbles:true,cancelable:true,dataTransfer:dt}))
                    );
                    inp.remove();
                    return 'ok';
                  } catch(e) {
                    return 'error:'+e.message;
                  }
                })()`,
                awaitPromise: true,
                returnByValue: true,
              }, (dropRes) => {
                if (chrome.runtime.lastError) {
                  fail('dropzone: drop simulation CDP error — ' + chrome.runtime.lastError.message);
                  return;
                }
                const val = dropRes?.result?.value;
                if (Array.isArray(val)) {
                  fail('dropzone: ' + notFound(filePaths, val));
                } else if (val !== 'ok') {
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

        // Step 2: find the file input by selector, in the page or a same-origin frame
        chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: deepFindExpr(selector),
          returnByValue: false,
        }, (queryResult) => {
          const objectId = queryResult?.result?.objectId;
          if (chrome.runtime.lastError || !objectId) {
            fail('uploadFile: selector not found — ' + selector);
            return;
          }

          // Step 3: set the files — browser fires the change event automatically
          chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
            files: filePaths,
            objectId,
          }, () => {
            if (chrome.runtime.lastError) {
              fail('uploadFile: DOM.setFileInputFiles failed — ' + chrome.runtime.lastError.message +
                   ' (selector is not a file input? Try DropZone mode)');
              return;
            }

            // Step 4: every file is on disk — a missing one is set without an error
            chrome.debugger.sendCommand({ tabId }, 'Runtime.callFunctionOn', {
              objectId, functionDeclaration: MISSING_FILES_FN, awaitPromise: true, returnByValue: true,
            }, (checkRes) => {
              const missing = (!chrome.runtime.lastError && checkRes?.result?.value) || [];
              if (missing.length) fail('uploadFile: ' + notFound(filePaths, missing));
              else done();
            });
          });
        });
      });
    });
  });
}
