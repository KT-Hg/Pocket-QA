/* === DB tools ═══════════════════════════════════════════════════════════════
 * The Adminer integration lives entirely in its own content script and its own
 * page; the only thing it needs from here is a tab. Kept as a separate listener
 * so it stays out of the playback router's lock handling — none of its locks
 * apply to it.
 * ═══════════════════════════════════════════════════════════════════════════ */

// "View" on the panel, or a recorded line clicked in its log. An open manager tab
// is brought forward and pointed at the session (and change) through its hash —
// a new tab on every press left a test run with half a dozen copies of the page.
// The hash carries a timestamp so pressing it again for the same session still
// lands, after the page has been moved on to another one by hand.
export function openDbtoolsManager(request, _sender, sendResponse) {
  if (request?.type !== "dbtools-open-manager") return;
  const base = chrome.runtime.getURL("dbtools.html");
  const target = [
    request.sessionId ? `session=${encodeURIComponent(request.sessionId)}` : "",
    request.changeId ? `change=${encodeURIComponent(request.changeId)}` : "",
  ].filter(Boolean).join("&");
  const done = () => { void chrome.runtime.lastError; sendResponse({ ok: true }); };

  chrome.tabs.query({}, (tabs) => {
    void chrome.runtime.lastError;
    const existing = (tabs || []).find((t) => t.url && t.url.split(/[?#]/)[0] === base);
    if (!existing) {
      chrome.tabs.create({ url: target ? `${base}?${target}` : base }, done);
      return;
    }
    const update = { active: true };
    if (target) update.url = `${existing.url.split("#")[0]}#${target}&at=${Date.now()}`;
    chrome.tabs.update(existing.id, update, () => {
      chrome.windows.update(existing.windowId, { focused: true }, done);
    });
  });
  return true;
}
