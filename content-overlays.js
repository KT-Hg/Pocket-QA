/**
 * content-overlays.js — the in-page overlays content.js needs only now and then:
 * the countdown pill before a visible capture (START_VISIBLE_COUNTDOWN), the
 * failed-action prompt of playback (ACTION_FAILED_PROMPT) and the segment
 * capture bar (START_SEGMENT_TAB).
 *
 * A classic script, not in the manifest: the worker injects it (loadOverlays,
 * bg/tabs.js) right before it sends one of those messages, so a page that never
 * takes a screenshot or fails an action never runs it. It runs in content.js's
 * isolated world, and what it uses from content.js comes through
 * window.__pqaContent (see HIGHLIGHT ENGINE LOADING there). Its own guard makes
 * a second injection do nothing; a frame without content.js is left alone.
 */

if (!window.__pqaOverlaysInjected && window.__pqaContent) {
  window.__pqaOverlaysInjected = true;

const { safeSend, _extOverlay, _extSpan, _EXT_DANGER } = window.__pqaContent;

/* ─────────────────────────────────────────────────────────────────────────────
   VISIBLE SCREENSHOT COUNTDOWN
───────────────────────────────────────────────────────────────────────────── */

let _countdownTimer   = null;
// Module-scoped because the countdown is torn down from three entry points
// (timer expiry, cancel button, ESC) — all of which go through the overlay
// handle, or the theme registry would leak a closure over a removed node.
let _countdownOverlay = null;

// `fromHotkey` is carried all the way to the background so the capture result
// can be reported as a notification. A hotkey capture happens with the popup
// closed, so the SCREENSHOT_RESULT toast has nobody to show it to.
// One count of the countdown.
const COUNTDOWN_TICK_MS = 1000;

function _startVisibleCountdown(seconds, crop, fromHotkey = false) {
  if (_countdownOverlay) return;
  let remaining = seconds;

  const numEl = _extSpan(String(remaining), [
    'font-weight:700', 'font-size:20px', 'min-width:18px', 'text-align:center',
  ]);

  // A pill rather than a bar: the countdown exists so you can open a menu before
  // the shot, and a full-width bar would cover the very chrome you are about to
  // capture. Same surface, same type, same spacing — smaller footprint.
  _countdownOverlay = _extOverlay({
    id: '__screenshot_countdown',
    variant: 'pill',
    label: '📸 Screenshot in…',
    trail: numEl,
    compactCancel: true,
    // Routed through the teardown so the ✕, ESC and a fired capture all leave
    // the same state behind — otherwise a cancelled countdown could never restart.
    onCancel: () => _teardownCountdown(),
  }).mount();

  const tick = () => {
    remaining--;
    if (remaining <= 0) { _fireVisibleCapture(crop, fromHotkey); return; }
    numEl.textContent = remaining;
    _countdownTimer = setTimeout(tick, COUNTDOWN_TICK_MS);
  };
  _countdownTimer = setTimeout(tick, COUNTDOWN_TICK_MS);
}

function _teardownCountdown() {
  _countdownOverlay?.destroy();
  _countdownOverlay = null;
  clearTimeout(_countdownTimer);
  _countdownTimer = null;
}

function _fireVisibleCapture(crop, fromHotkey = false) {
  _teardownCountdown();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    safeSend({ type: 'TAKE_SCREENSHOT', crop: !!crop, fromHotkey });
  }));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_VISIBLE_COUNTDOWN') {
    _startVisibleCountdown(msg.seconds || 3, !!msg.crop, !!msg.fromHotkey);
    // The ack is what tells the worker the pill is up and this frame owns the
    // count — without an answer it counts down on the toolbar badge instead and
    // takes the shot itself, which is what has to happen on every tab this
    // script is not injected into.
    sendResponse({ ok: true });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   FAILED-ACTION PROMPT

   Playback pauses on a failed action and asks here, on the page being played,
   whether to retry it, skip it or stop the run. The worker holds its message
   open and the click goes back as the response. Only the top frame is asked
   (the worker sends to frameId 0). The page stays usable underneath, so the
   user can put it right by hand before pressing Retry.
───────────────────────────────────────────────────────────────────────────── */

let _failPrompt = null; // { handle, respond }

function _closeFailPrompt(choice) {
  if (!_failPrompt) return;
  const { handle, respond } = _failPrompt;
  _failPrompt = null;
  handle.destroy();
  try { respond(choice ? { choice } : { closed: true }); } catch (_) { /* the waiting side already gave up: nothing to answer */ }
}

function _failPromptLine(text, extra = []) {
  return _extSpan(text, [
    'display:block', 'font-size:12px', 'white-space:pre-wrap', 'word-break:break-word', ...extra,
  ]);
}

function _showFailPrompt(msg, respond) {
  // A newer prompt replaces an older one; the worker is no longer waiting on it.
  _closeFailPrompt(null);

  const head = document.createElement('div');
  head.style.cssText = [
    'all:initial', 'display:flex', 'align-items:center', 'gap:6px',
    'font-family:inherit', 'font-size:13px', 'line-height:1.4', 'color:inherit',
  ].join(';');
  head.append(
    _extSpan('⚠', [`color:${_EXT_DANGER}`, 'font-size:15px', 'flex:0 0 auto']),
    _extSpan(`Action ${msg.index + 1}${msg.total ? ` of ${msg.total}` : ''} failed`, ['font-weight:700']),
  );

  const what  = [msg.actionType, msg.label && `"${msg.label}"`].filter(Boolean).join(' · ');
  const where = [msg.scenarioName, msg.row ? `row ${msg.row} of ${msg.rows}` : ''].filter(Boolean).join(' · ');

  const row = document.createElement('div');
  row.style.cssText = [
    'all:initial', 'display:flex', 'justify-content:flex-end', 'gap:6px', 'margin-top:4px',
  ].join(';');

  const handle = _extOverlay({
    id: '__action_failed_prompt',
    variant: 'panel',
    hint: null,
    buttons: [
      { key: 'retry', label: '↻ Retry', onClick: () => _closeFailPrompt('retry') },
      { key: 'skip',  label: '⏭ Skip',  onClick: () => _closeFailPrompt('skip') },
      { key: 'stop',  label: '■ Stop', tone: 'danger', onClick: () => _closeFailPrompt('stop') },
    ],
    content: [
      head,
      what  ? _failPromptLine(what, ['opacity:0.75']) : null,
      _failPromptLine(msg.reason || 'Action failed', ['max-height:120px', 'overflow:auto']),
      where ? _failPromptLine(where, ['font-size:11px', 'opacity:0.6']) : null,
      row,
    ],
    extra: [
      'display:flex', 'top:16px', 'left:50%', 'transform:translateX(-50%)',
      'width:min(420px, calc(100vw - 32px))',
    ],
  });

  // The template appends buttons straight onto the panel's column; they belong
  // on one row under the text. Moving the nodes keeps their theme repaint.
  const { retry, skip, stop } = handle.buttons;
  retry.title = 'Run this action again';
  skip.title  = 'Record it as failed and go on to the next action';
  stop.title  = 'Record it as failed and end the run';
  row.append(retry, skip, stop);

  _failPrompt = { handle, respond };
  handle.mount();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ACTION_FAILED_PROMPT') {
    _showFailPrompt(msg, sendResponse);
    return true; // answered when a button is clicked
  }
  if (msg.type === 'ACTION_FAILED_PROMPT_CLOSE') {
    _closeFailPrompt(null);
    sendResponse({ ok: true });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   SEGMENT CAPTURE OVERLAY
───────────────────────────────────────────────────────────────────────────── */

let _segCapture = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'START_SEGMENT_TAB') return;

  if (_segCapture) _segCapture.cleanup();

  const dir    = msg.dir;
  const isVert = dir === 'vertical';
  const startX = window.scrollX;
  const startY = window.scrollY;

  // Declared before the overlay so the button handlers can close over it; the
  // template calls back into these, never the other way round.
  // eslint-disable-next-line prefer-const -- assigned below, after the overlay exists
  let cleanup, capture;

  const bar = _extOverlay({
    variant: 'bar',
    label:  `📍 Start: X=${Math.round(startX)}px, Y=${Math.round(startY)}px`,
    detail: '',
    onCancel: () => { cleanup(); safeSend({ type: 'CANCEL_SEGMENT_CAPTURE' }); },
    buttons: [
      { key: 'stop', label: '⏹ Stop & Capture', tone: 'danger', onClick: () => capture() },
    ],
  }).mount();

  // Rounded for display only: on a zoomed page scrollY is fractional, and the
  // raw value printed 15 decimals next to an integer start coordinate.
  const updateLbl = () => {
    const endX = Math.round(window.scrollX + window.innerWidth);
    const endY = Math.round(window.scrollY + window.innerHeight);
    bar.setDetail(`To: X=${endX}px, Y=${endY}px (W=${Math.abs(endX - startX)}px, H=${Math.abs(endY - startY)}px)`);
  };
  updateLbl();

  let rafId = null, scrollStopped = false, scrollStep = 2;
  const speedKey = isVert ? 'segScrollSpeedV' : 'segScrollSpeedH';
  try {
    chrome.storage.sync.get([speedKey], (res) => {
      try { void chrome.runtime.lastError; scrollStep = Math.min(10, Math.max(0.1, parseFloat(res?.[speedKey]) || 2)); } catch (_) { /* context invalidated mid-callback: keep the default speed */ }
    });
  } catch (_) { /* extension context invalidated: keep the default speed */ }

  const scrollLoop = () => {
    if (scrollStopped) return;
    const before = isVert ? window.scrollY : window.scrollX;
    if (isVert) window.scrollBy(0, scrollStep); else window.scrollBy(scrollStep, 0);
    const after = isVert ? window.scrollY : window.scrollX;
    updateLbl();
    if (after === before) { scrollStopped = true; bar.buttons.stop.textContent = '⏹ Capture (end of page)'; return; }
    rafId = requestAnimationFrame(scrollLoop);
  };
  rafId = requestAnimationFrame(scrollLoop);

  cleanup = () => {
    scrollStopped = true;
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
    bar.destroy();
    _segCapture = window.__pqaSegCapture = null;
  };

  capture = () => {
    const endX = window.scrollX + window.innerWidth;
    const endY = window.scrollY + window.innerHeight;
    cleanup();
    window.scrollTo(startX, startY);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      safeSend({
        type: 'CAPTURE_SEGMENT',
        xStart: Math.min(startX, endX), yStart: Math.min(startY, endY),
        xEnd:   Math.max(startX, endX), yEnd:   Math.max(startY, endY),
      });
    }));
  };

  // The segment-stop hotkey of content.js calls it through window.
  _segCapture = window.__pqaSegCapture = { cleanup, capture };
  sendResponse({ ok: true });
  return true;
});

} // End of injection guard
