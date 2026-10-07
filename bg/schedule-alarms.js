/**
 * schedule-alarms.js — one chrome.alarms entry per enabled schedule.
 *
 * A schedule fires at a wall-clock "HH:MM", once or every day. Its alarm is named
 * "sched_<id>"; background.js keeps the single onAlarm listener and hands those
 * alarms to runScheduleAlarm(), so the order in which alarm kinds are handled
 * stays in one place.
 */

import { startPlayback } from './playback.js';
import { sendScheduleNotification } from './notify.js';
import { waitForTabLoad } from './tabs.js';
import { ensureLockState, notifyLocked } from './update-check.js';

/* === SCHEDULING (per-schedule chrome.alarms) === */

const ALARM_PREFIX = "sched_";
const MINUTE_MS = 60_000;
// How long a scheduled run's new tab gets to load its start URL.
const SCHEDULE_TAB_LOAD_MS = 30_000;

/**
 * Compute milliseconds until the next wall-clock occurrence of a "HH:MM" string.
 * If the time has already passed today, the result is for tomorrow's occurrence.
 *
 * Returns null for anything that is not a real time of day. A malformed value
 * used to produce NaN, which chrome.alarms.create rejects — leaving a schedule
 * that showed as "enabled" in the list but had no alarm behind it and never fired.
 */
function _msUntilTime(timeStr) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr ?? '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  const now = new Date();
  const next = new Date(now);
  next.setHours(hh, mm, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function registerScheduleAlarm(schedule) {
  if (!schedule?.enabled) return false;
  const ms = _msUntilTime(schedule.time);
  if (ms === null) {
    console.warn(`[SCHEDULE] Ignoring schedule ${schedule.id}: invalid time "${schedule.time}"`);
    return false;
  }
  const name = ALARM_PREFIX + schedule.id;
  const delayInMinutes = ms / MINUTE_MS;
  if (schedule.repeat) {
    chrome.alarms.create(name, { delayInMinutes, periodInMinutes: 24 * 60 });
  } else {
    chrome.alarms.create(name, { delayInMinutes });
  }
  return true;
}

export function unregisterScheduleAlarm(id) {
  chrome.alarms.clear(ALARM_PREFIX + id);
}

// On worker start: register every enabled schedule's alarm again. Chrome keeps
// alarms while the worker sleeps, but may drop them on a browser restart or an
// extension update; creating one again under the same name just replaces it.
export function reregisterScheduleAlarms() {
  chrome.storage.local.get(["schedules"], (res) => {
    const schedules = res.schedules || [];
    schedules.forEach((s) => {
      if (s.enabled) registerScheduleAlarm(s);
    });
  });
}

/**
 * Play the schedule's scenario in a new tab on its start URL. Unattended, the
 * active tab could be any page at all: a run on it would click, type and run
 * scripts there.
 */
function _playInNewTab(s, schedName) {
  chrome.tabs.create({ url: s.url, active: true }, async (tab) => {
    const failed = chrome.runtime.lastError?.message || (tab?.id == null ? 'no tab' : null);
    const loaded = !failed && await waitForTabLoad(tab.id, SCHEDULE_TAB_LOAD_MS);
    if (!loaded) {
      sendScheduleNotification('⚠ Scheduled run not started', `"${schedName}": could not open ${s.url}`, 'schedule_start');
      return;
    }
    startPlayback(s.scenarioId, 1, 0, tab.id);
  });
}

/** A "sched_<id>" alarm: start that schedule's scenario. Other alarms are ignored. */
export function runScheduleAlarm(alarm) {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const id = alarm.name.slice(ALARM_PREFIX.length);
  chrome.storage.local.get(["schedules", "scenarios"], (res) => {
    const schedules = res.schedules || [];
    const s = schedules.find((x) => x.id === id);
    if (!s || !s.enabled) return;
    // A locked extension must not run unattended either — skip the slot and say
    // why, but leave the schedule enabled so it resumes after the update.
    ensureLockState().then((lock) => {
      if (lock.locked) { notifyLocked(); return; }
      // Announced before the call, not after: startPlayback() resolves only once
      // the entire run has finished, which is far too late to say "started", and
      // an unattended run is exactly the one the user cannot see beginning. If it
      // is refused (recording in progress, no open tab) startPlayback raises its
      // own alert immediately after this one, which reads correctly in sequence.
      const schedName = res.scenarios?.[s.scenarioId]?.name || s.scenarioId;
      sendScheduleNotification(
        "⏰ Scheduled run started",
        s.label ? `${s.label} — "${schedName}"` : `"${schedName}"`,
        "schedule_start",
      );
      if (s.url) _playInNewTab(s, schedName);
      // Saved before schedules had a start URL: the active tab, as it always was.
      else startPlayback(s.scenarioId);
      // A one-shot schedule burns itself only when it actually ran; a slot skipped
      // by the lock stays armed for the next occurrence.
      if (!s.repeat) {
        s.enabled = false;
        chrome.storage.local.set({ schedules });
        unregisterScheduleAlarm(id);
      }
    });
  });
}
