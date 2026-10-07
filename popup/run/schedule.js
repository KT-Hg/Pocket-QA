/**
 * run/schedule.js — scheduled runs: the list, add and edit.
 */

import { setCardOpen } from '../ui/collapsible.js';
import { ui } from '../ui-state.js';
import { escHtml, getDragAfterElement, showToast } from '../utils.js';
import { resetScheduleTimePicker } from './time-picker.js';

/* === NOTIFICATION SETTING === */

/* === Schedule & CSV === */
/* === SCHEDULED PLAYBACK === */

export function renderScheduleScenarioSelect() {
  const sel = document.getElementById("scheduleScenarioSelect");
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Select scenario --</option>';
  Object.entries(ui.scenariosCache)
    .sort(([, a], [, b]) => (a.name || "").localeCompare(b.name || ""))
    .forEach(([id, s]) => {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = s.name;
      sel.appendChild(o);
    });
}

let currentSchedules = [];

function _setScheduleTimePicker(timeStr) {
  const stHour = document.getElementById("stHour");
  const stMin  = document.getElementById("stMin");
  const stAmPm = document.getElementById("stAmPm");
  const hidden = document.getElementById("scheduleTime");
  if (!stHour || !stMin || !stAmPm || !hidden) return;
  const [h24, m] = timeStr.split(":").map(Number);
  let h12, ampm;
  if (h24 === 0)       { h12 = 12; ampm = "AM"; }
  else if (h24 < 12)   { h12 = h24; ampm = "AM"; }
  else if (h24 === 12) { h12 = 12;  ampm = "PM"; }
  else                 { h12 = h24 - 12; ampm = "PM"; }
  stHour.value = h12;
  stMin.value  = m;
  stAmPm.textContent = ampm;
  hidden.value = timeStr;
}

function formatTime12h(timeStr) {
  const [h24, m] = timeStr.split(":").map(Number);
  let h12, ampm;
  if (h24 === 0)       { h12 = 12; ampm = "AM"; }
  else if (h24 < 12)   { h12 = h24; ampm = "AM"; }
  else if (h24 === 12) { h12 = 12;  ampm = "PM"; }
  else                 { h12 = h24 - 12; ampm = "PM"; }
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** The host of a start URL, for the list; the text as it is when it does not parse. */
function _hostOf(url) {
  try { return new URL(url).host; } catch (_) { return url; } // not a URL: show what was saved
}

function renderScheduleList(schedules) {
  currentSchedules = schedules;
  const container = document.getElementById("scheduleList");
  if (!container) return;
  if (!schedules.length) {
    container.innerHTML = '<li class="empty">No schedules yet.</li>';
    return;
  }
  container.innerHTML = "";
  schedules.forEach((s, index) => {
    const li = document.createElement("li");
    li.classList.add("action", "action-navigate");
    if (!s.enabled) li.classList.add("action-disabled");
    li.dataset.index = index;
    li.draggable = true;

    const scheduledName = ui.scenariosCache[s.scenarioId]?.name || s.scenarioId;
    const timeDisplay = formatTime12h(s.time);
    const repeatText = s.repeat ? " 🔁" : "";
    const labelText = s.label ? ` · ${s.label}` : "";
    // Where the run plays: its start URL's host, or (saved before there was one)
    // whatever tab is active — say so, it is worth an Edit.
    const whereText = s.url ? ` · ${_hostOf(s.url)}` : " · ⚠ active tab";
    const whereTitle = s.url || "No start URL: each run plays on whatever tab is active. Edit to add one.";

    li.innerHTML = `
      <span class="index">${index + 1}.</span>
      <span class="type" title="${escHtml(scheduledName)}" style="text-transform:none;">${escHtml(scheduledName)}</span>
      <span class="value" title="${escHtml(whereTitle)}">${escHtml(timeDisplay)}${repeatText}${escHtml(labelText)}${escHtml(whereText)}</span>
    `;

    li.addEventListener("dragstart", (e) => {
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      container.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
    });

    const btnRow = document.createElement("div");
    btnRow.className = "btn-row";

    const disableBtn = document.createElement("button");
    disableBtn.textContent = s.enabled ? "Disable" : "Enable";
    disableBtn.className = "secondary";
    disableBtn.onclick = () => {
      s.enabled = !s.enabled;
      chrome.runtime.sendMessage({ type: "SAVE_SCHEDULE", schedule: s }, loadSchedules);
    };

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy";
    copyBtn.className = "secondary";
    copyBtn.onclick = () => {
      const copy = { ...s, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5) };
      chrome.runtime.sendMessage({ type: "SAVE_SCHEDULE", schedule: copy }, () => {
        loadSchedules();
        showToast("Schedule duplicated", "success");
      });
    };

    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.className = "secondary";
    editBtn.onclick = () => {
      ui.editingScheduleId = s.id;
      document.getElementById("scheduleScenarioSelect").value = s.scenarioId;
      _setScheduleTimePicker(s.time);
      document.getElementById("scheduleLabel").value = s.label || "";
      document.getElementById("scheduleUrl").value = s.url || "";
      document.getElementById("scheduleRepeat").checked = !!s.repeat;
      document.getElementById("addSchedule").textContent = "✔ Save";
      setCardOpen(document.getElementById("scheduledPlaybackCard"), true);
    };

    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.className = "danger";
    delBtn.onclick = () => {
      if (ui.editingScheduleId === s.id) {
        ui.editingScheduleId = null;
        document.getElementById("addSchedule").textContent = "+ Add";
        resetScheduleTimePicker?.();
      }
      chrome.runtime.sendMessage({ type: "DELETE_SCHEDULE", id: s.id }, loadSchedules);
    };

    btnRow.appendChild(disableBtn);
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(editBtn);
    btnRow.appendChild(delBtn);
    li.appendChild(btnRow);
    container.appendChild(li);
  });
}

export function loadSchedules() {
  chrome.runtime.sendMessage({ type: "GET_SCHEDULES" }, (res) => {
    renderScheduleList(res?.schedules || []);
  });
}

export function initSchedule() {
  (function () {
    const el = document.getElementById("scheduleList");
    if (!el) return;
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      const dragging = el.querySelector(".dragging");
      if (!dragging) return;
      const after = getDragAfterElement(el, e.clientY);
      el.querySelectorAll(".drag-over").forEach(x => x.classList.remove("drag-over"));
      if (after == null) el.appendChild(dragging);
      else { after.classList.add("drag-over"); el.insertBefore(dragging, after); }
    });
    el.addEventListener("drop", () => {
      el.querySelectorAll(".drag-over").forEach(x => x.classList.remove("drag-over"));
      const newOrder = [...el.querySelectorAll("li[data-index]")].map(li => Number(li.dataset.index));
      const reordered = newOrder.map(i => currentSchedules[i]);
      renderScheduleList(reordered);
    });
  })();
}
