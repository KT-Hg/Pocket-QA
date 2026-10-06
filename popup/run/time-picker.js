/**
 * run/time-picker.js — the schedule's time picker.
 */

import { ui } from '../ui-state.js';
import { showToast } from '../utils.js';
import { loadSchedules } from './schedule.js';

/* === Custom Schedule Time Picker === */
export let resetScheduleTimePicker = null;

/** A 12-hour clock hour as 24-hour: 12 AM is hour 0, 12 PM hour 12, other PM hours add 12. */
function to24h(h12, pm) {
  if (pm) return h12 === 12 ? 12 : h12 + 12;
  return h12 === 12 ? 0 : h12;
}

export function initTimePicker() {
  (function () {
    const stHour = document.getElementById("stHour");
    const stMin  = document.getElementById("stMin");
    const stAmPm = document.getElementById("stAmPm");
    const hidden = document.getElementById("scheduleTime");
    if (!stHour || !stMin || !stAmPm || !hidden) return;

    function clamp(val, min, max) {
      const n = parseInt(val, 10);
      if (isNaN(n)) return min;
      return Math.min(max, Math.max(min, n));
    }

    function syncHidden() {
      const h12 = clamp(stHour.value, 1, 12);
      const m   = clamp(stMin.value, 0, 59);
      const pm  = stAmPm.textContent === "PM";
      const h24 = to24h(h12, pm);
      hidden.value = `${String(h24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }

    stHour.addEventListener("input", syncHidden);
    stHour.addEventListener("change", () => { stHour.value = clamp(stHour.value, 1, 12); syncHidden(); });
    stMin.addEventListener("input", syncHidden);
    stMin.addEventListener("change", () => { stMin.value = clamp(stMin.value, 0, 59); syncHidden(); });
    stAmPm.addEventListener("click", () => {
      stAmPm.textContent = stAmPm.textContent === "AM" ? "PM" : "AM";
      syncHidden();
    });

    resetScheduleTimePicker = () => {
      stHour.value = 12;
      stMin.value  = 0;
      stAmPm.textContent = "AM";
      syncHidden(); // keep hidden populated (12 AM = "00:00")
    };

    syncHidden(); // init hidden value
  })();
  document.getElementById("addSchedule")?.addEventListener("click", () => {
    const scenarioId = document.getElementById("scheduleScenarioSelect")?.value;
    const time = document.getElementById("scheduleTime")?.value;
    const label = document.getElementById("scheduleLabel")?.value?.trim() || "";
    const repeat = document.getElementById("scheduleRepeat")?.checked || false;

    if (!scenarioId) {
      showToast("Select a scenario first", "error");
      return;
    }
    if (!time) {
      showToast("Select a time first", "error");
      return;
    }

    const schedule = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      scenarioId,
      time,
      label,
      repeat,
      enabled: true,
    };

    const isEditing = !!ui.editingScheduleId;
    const saveAction = () => {
      chrome.runtime.sendMessage({ type: "SAVE_SCHEDULE", schedule }, (res) => {
        ui.editingScheduleId = null;
        document.getElementById("addSchedule").textContent = "+ Add";
        resetScheduleTimePicker?.();
        document.getElementById("scheduleLabel").value = "";
        document.getElementById("scheduleRepeat").checked = false;
        loadSchedules();
        // The row is saved either way, but without an alarm it will never fire —
        // say so rather than let it sit in the list looking armed.
        if (res?.invalidTime) {
          showToast(`Saved, but "${schedule.time}" is not a valid time — this schedule will not run`, "warn");
        } else {
          showToast(isEditing ? "Schedule updated" : "Schedule added", "success");
        }
      });
    };

    if (isEditing) {
      chrome.runtime.sendMessage({ type: "DELETE_SCHEDULE", id: ui.editingScheduleId }, saveAction);
    } else {
      saveAction();
    }
  });
  loadSchedules();
}
