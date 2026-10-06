/**
 * playback/keepalive.js — keeping the service worker alive while a playback runs.
 */

import { ignoreLastError } from '../last-error.js';

/* ── SW keep-alive ──────────────────────────────────────────────────────────── */

// Chrome MV3 terminates idle Service Workers after ~30 s. A playback that sits in
// a long wait() action makes no extension API calls, so nothing resets that timer
// and the run would be killed mid-flight.
//
// Two mechanisms, because neither is sufficient alone:
//
//   - The alarm survives a worker that has already been torn down, and is what
//     brings it back. It asks for 20 s but Chrome clamps alarms to a 30 s floor,
//     landing exactly on the idle deadline — too close to rely on by itself.
//   - The interval below makes a cheap API call every 20 s. Each one resets the
//     idle timer from inside, so the worker never reaches the deadline in the
//     first place. It dies with the worker, which is why the alarm is still needed.

export const KEEPALIVE_ALARM = 'playback-keepalive';
export const KEEPALIVE_MS    = 20_000;

let _keepaliveTimer = null;

export function startKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { when: Date.now() + KEEPALIVE_MS });
  if (_keepaliveTimer) clearInterval(_keepaliveTimer);
  _keepaliveTimer = setInterval(() => {
    // Any extension API call resets the idle countdown; this is among the cheapest.
    chrome.runtime.getPlatformInfo(ignoreLastError);
  }, KEEPALIVE_MS);
}

export function stopKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
  if (_keepaliveTimer) { clearInterval(_keepaliveTimer); _keepaliveTimer = null; }
}
