/**
 * router.js — the service worker's main chrome.runtime.onMessage listener.
 *
 * routeMessage() holds back the messages the update lock refuses until the lock
 * state has been read; handleMessage() lets the screenshot messages through to
 * their own listeners, refuses playback while recording, and hands every other
 * type to its handler in bg/handlers/. An unknown type gets no answer
 * (undefined), so another listener may take it.
 */

import { refuseIfRecording } from './playback.js';
import { ensureLockState, notifyLocked } from './update-check.js';
import { recordingHandlers } from './handlers/recording.js';
import { actionsHandlers } from './handlers/actions.js';
import { scenariosHandlers } from './handlers/scenarios.js';
import { foldersHandlers } from './handlers/folders.js';
import { dataIoHandlers } from './handlers/data-io.js';
import { variablesHandlers } from './handlers/variables.js';
import { playbackHandlers } from './handlers/playback.js';
import { csvHandlers } from './handlers/csv.js';
import { schedulesHandlers } from './handlers/schedules.js';
import { captureHandlers } from './handlers/capture.js';
import { pickerHandlers } from './handlers/picker.js';
import { updateHandlers } from './handlers/update.js';
import { highlightHandlers } from './handlers/highlight.js';

/* === MAIN MESSAGE HANDLER === */

/**
 * Actions refused while the update lock is on: anything that *starts* capture,
 * recording or playback. Deliberately absent — every GET_*, every STOP_*, and the
 * export/backup paths, so a locked user can still watch a run finish, stop it, and
 * get their scenarios out. Screenshot messages are guarded in bg/screenshot.js and
 * bg/screenshot/window.js, which own their own listeners.
 */
const LOCKED_MESSAGE_TYPES = new Set([
  'START_RECORD',
  'START_PLAYBACK_SCENARIO', 'START_SEQUENCE_PLAYBACK',
  'START_CSV_PLAYBACK', 'RESUME_CSV_PLAYBACK', 'RESUME_PLAYBACK',
  'HOTKEY_SEG_START', 'HOTKEY_SCREENSHOT_ELEMENT',
  'START_SEGMENT_CAPTURE', 'CAPTURE_SEGMENT',
  'COMPARE_SCREENSHOTS',
]);

/**
 * Message types that start playback. Refused while a recording is in progress —
 * see the mutual-exclusion block in bg/playback.js for why the two modes cannot
 * overlap. Listed here so the router can answer with an error instead of letting
 * the request fall through and report `started: true` for a run that never began.
 */
const PLAYBACK_START_TYPES = new Set([
  'START_PLAYBACK_SCENARIO', 'START_SEQUENCE_PLAYBACK',
  'START_CSV_PLAYBACK', 'RESUME_CSV_PLAYBACK', 'RESUME_PLAYBACK',
]);

/**
 * What a content script sends. It runs in its page's renderer, which a hostile
 * page could compromise, so a message from a web page is only taken when it is
 * one of these — Chrome's advice is to treat content-script messages as
 * untrusted. Without it, a page could ask for GET_ALL_DATA, RESTORE_ALL_DATA or
 * IMPORT_SCENARIO (whose script actions run through CDP). The popup and the
 * other extension pages are not limited. dbtools' content script, on Adminer
 * pages, sends its own kebab-case `dbtools-…` messages.
 */
const CONTENT_SCRIPT_TYPES = new Set([
  'REGISTER_FRAME', 'CONTENT_READY', 'IS_TAB_ACTIVATED', 'RECORDED_ACTION',
  'START_RECORD', 'STOP_RECORD', 'ELEMENT_PICKED', 'STOP_PICK_MODE', 'HL_UPDATED', 'HL_SAVE_PAGE', 'HL_LOAD',
  'TAKE_SCREENSHOT', 'TAKE_SCREENSHOT_FULL', 'TAKE_SCREENSHOT_SCROLL_V', 'TAKE_SCREENSHOT_SCROLL_H',
  'HOTKEY_SCREENSHOT_ELEMENT', 'HOTKEY_SEG_START', 'CAPTURE_SEGMENT',
  'CANCEL_FULL_SCREENSHOT', 'CANCEL_SEGMENT_CAPTURE',
]);

/** Sent from a web page, and not something its content script sends. */
function _refusedFromPage(type, sender) {
  if (String(sender?.url || '').startsWith(chrome.runtime.getURL(''))) return false;
  return !CONTENT_SCRIPT_TYPES.has(type) && !(typeof type === 'string' && type.startsWith('dbtools-'));
}

/** Message type → handler. A Map, so a type like "toString" finds nothing. */
const HANDLERS = new Map(Object.entries({
  ...recordingHandlers,
  ...actionsHandlers,
  ...scenariosHandlers,
  ...foldersHandlers,
  ...dataIoHandlers,
  ...variablesHandlers,
  ...playbackHandlers,
  ...csvHandlers,
  ...schedulesHandlers,
  ...captureHandlers,
  ...pickerHandlers,
  ...updateHandlers,
  ...highlightHandlers,
}));

export function routeMessage(request, sender, sendResponse) {
  // Not answered, like an unknown type.
  if (_refusedFromPage(request?.type, sender)) return;
  if (!LOCKED_MESSAGE_TYPES.has(request?.type)) {
    return handleMessage(request, sender, sendResponse);
  }
  // Must await: a hotkey wakes the service worker and its message can arrive
  // before the cached lock state has been read back from storage.
  ensureLockState().then((lock) => {
    if (lock.locked) {
      notifyLocked(lock.message);
      sendResponse({ locked: true, started: false, error: lock.message });
      return;
    }
    handleMessage(request, sender, sendResponse);
  });
  return true; // keep the channel open across the storage read
}

export function handleMessage(request, sender, sendResponse) {
  const { type } = request;

  // Screenshot messages have their own dedicated listeners in bg/screenshot.js
  // and bg/screenshot/window.js. Returning undefined here (not `true`) tells
  // Chrome this handler did not handle the message, so they can take over.
  if (["TAKE_SCREENSHOT", "TAKE_SCREENSHOT_FULL",
       "TAKE_SCREENSHOT_SCROLL_V", "TAKE_SCREENSHOT_SCROLL_H",
       "TAKE_SCREENSHOT_ELEMENT",
       "OPEN_WINDOW_CAPTURE", "WINDOW_CAPTURE_RESULT", "RESTORE_BADGE"].includes(type)) return;

  // Refuse before dispatch so the caller is told the run did not start. The
  // guard is repeated inside each playback entry point for the callers that
  // never reach this router (scheduled alarms).
  if (PLAYBACK_START_TYPES.has(type) && refuseIfRecording()) {
    sendResponse({ started: false, error: 'Cannot start playback while recording is active' });
    return;
  }

  const handler = HANDLERS.get(type);
  if (handler) return handler(request, sender, sendResponse);
}
