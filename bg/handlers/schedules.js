/**
 * handlers/schedules.js — messages about scheduled runs (their alarms are in
 * bg/schedule-alarms.js).
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { registerScheduleAlarm, unregisterScheduleAlarm } from '../schedule-alarms.js';
import { getSchedules, setSchedules, runExclusive } from '../storage.js';

export const schedulesHandlers = {
  /* --- Schedules --- */
  GET_SCHEDULES(request, sender, sendResponse) {
    chrome.storage.local.get(["schedules"], (res) => {
      sendResponse({ schedules: res.schedules || [] });
    });
    return true;
  },

  SAVE_SCHEDULE(request, sender, sendResponse) {
    runExclusive(async () => {
      const schedules = await getSchedules();
      const idx = schedules.findIndex((s) => s.id === request.schedule.id);
      if (idx >= 0) schedules[idx] = request.schedule;
      else schedules.push(request.schedule);
      await setSchedules(schedules);
      // Always unregister first — ensures a time change takes effect immediately
      // rather than firing at the old time.
      unregisterScheduleAlarm(request.schedule.id);
      const armed = registerScheduleAlarm(request.schedule);
      // Reported so the popup can tell the user their schedule will not run,
      // instead of showing it as enabled with no alarm behind it.
      sendResponse({ success: true, armed, invalidTime: request.schedule.enabled && !armed });
    });
    return true;
  },

  DELETE_SCHEDULE(request, sender, sendResponse) {
    runExclusive(async () => {
      const schedules = (await getSchedules()).filter((s) => s.id !== request.id);
      await setSchedules(schedules);
      unregisterScheduleAlarm(request.id);
      sendResponse({ success: true });
    });
    return true;
  },
};
