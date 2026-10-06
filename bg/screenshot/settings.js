/**
 * screenshot/settings.js — the save mode and file-name prefix a capture uses.
 *
 * Callback form on purpose: every caller ran its capture inside the
 * chrome.storage.sync.get callback, and still does, at the same moment.
 * bg/playback.js keeps its own copy of these settings, cached for a run, and
 * the window capture reads one more key (screenshotTypeInName) itself.
 */

export function readCaptureSettings(cb) {
  chrome.storage.sync.get(['screenshotSaveMode', 'screenshotPrefix'], (settings) => {
    cb({
      saveMode: settings.screenshotSaveMode || 'auto',
      prefix:   settings.screenshotPrefix   || 'screenshot',
    });
  });
}
