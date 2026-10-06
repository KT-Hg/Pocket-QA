/**
 * run/playback-controls.js — play / stop a scenario, the run list and sequences.
 */

import { addToRunList, csvDelayBetweenPreset, delayAfterScenario, delayPreset, playScenario, runListDisplay, saveSequenceAsScenario, scenarioList, sequenceName, sequenceScenarioList, startSequence, stopPlay, stopSequence } from '../dom.js';
import { showFieldError } from '../record/picked-selectors.js';
import { loadScenarios } from '../scenarios/scenario-list.js';
import { ui } from '../ui-state.js';
import { escHtml, showPrompt, showToast } from '../utils.js';

export function updateRunListDisplay() {
  runListDisplay.innerHTML = "";

  // Toggle sequence buttons based on runList
  const hasItems = ui.runList.length > 0;
  if (startSequence) startSequence.disabled = !hasItems;
  if (saveSequenceAsScenario) saveSequenceAsScenario.disabled = !hasItems;

  if (!ui.runList.length) {
    runListDisplay.innerHTML = `<li class="empty">No scenarios in run list</li>`;
    return;
  }

  ui.runList.forEach((scenarioItem, index) => {
    const li = document.createElement("li");
    li.classList.add("action", "action-navigate");
    if (scenarioItem.disabled) li.classList.add("action-disabled");
    li.dataset.index = index;
    li.draggable = true;

    const delayText = scenarioItem.delay ? `${scenarioItem.delay}ms` : "0ms";
    li.innerHTML = `
      <span class="index">${index + 1}.</span>
      <span class="type" title="${escHtml(scenarioItem.name)}" style="text-transform:none;">${escHtml(scenarioItem.name)}</span>
      <span class="value">${escHtml(delayText)}</span>
    `;

    li.addEventListener("dragstart", (e) => {
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      runListDisplay.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
    });

    const btnRow = document.createElement("div");
    btnRow.className = "btn-row";

    const disableBtn = document.createElement("button");
    disableBtn.textContent = scenarioItem.disabled ? "Enable" : "Disable";
    disableBtn.className = "secondary";
    disableBtn.onclick = () => { scenarioItem.disabled = !scenarioItem.disabled; updateRunListDisplay(); };

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy";
    copyBtn.className = "secondary";
    copyBtn.onclick = () => {
      ui.sequenceClipboard = { id: scenarioItem.id, name: scenarioItem.name, delay: scenarioItem.delay };
      showToast("Item copied", "success");
      updateRunListDisplay();
    };

    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.className = "secondary";
    editBtn.onclick = () => {
      showPrompt("Delay before this scenario runs, in milliseconds.", (newDelay) => {
        const v = parseInt(newDelay, 10);
        if (isNaN(v) || v < 0) {
          showToast("Enter a delay of 0 or more", "error");
          return;
        }
        scenarioItem.delay = v;
        updateRunListDisplay();
      }, { title: "Edit Delay", value: String(scenarioItem.delay), type: "number" });
    };

    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.className = "danger";
    delBtn.onclick = () => { ui.runList.splice(index, 1); updateRunListDisplay(); };

    btnRow.appendChild(disableBtn);
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(editBtn);
    btnRow.appendChild(delBtn);
    li.appendChild(btnRow);
    runListDisplay.appendChild(li);
  });

  if (ui.sequenceClipboard) {
    const pasteLi = document.createElement("li");
    pasteLi.className = "action-navigate action-paste-li";
    const pasteBtn = document.createElement("button");
    pasteBtn.textContent = `Paste: ${ui.sequenceClipboard.name} (${ui.sequenceClipboard.delay}ms)`;
    pasteBtn.className = "secondary action-paste-btn";
    pasteBtn.addEventListener("click", () => {
      ui.runList.push({ ...ui.sequenceClipboard });
      showToast("Item pasted", "success");
      updateRunListDisplay();
    });
    pasteLi.appendChild(pasteBtn);
    runListDisplay.appendChild(pasteLi);
  }
}

export function initPlaybackControls() {
  /* === PLAYBACK === */

  playScenario.onclick = () => {
    const scenarioId = scenarioList.value;
    if (!scenarioId) return;
    const loopCount = Math.max(1, parseInt(document.getElementById("loopCount")?.value || "1", 10));
    const loopDelayPreset = document.getElementById("loopDelayPreset");
    const loopDelayCustom = document.getElementById("loopDelay");
    const loopDelayRaw = loopDelayPreset?.value === "custom"
      ? parseInt(loopDelayCustom?.value || "500", 10)
      : parseInt(loopDelayPreset?.value || "500", 10);
    const loopDelay = Math.max(500, isNaN(loopDelayRaw) ? 500 : loopDelayRaw);
    chrome.runtime.sendMessage({ type: "START_PLAYBACK_SCENARIO", scenarioId, loopCount, loopDelay });
    window.close();
  };
  stopPlay.onclick = () => chrome.runtime.sendMessage({ type: "STOP_PLAYBACK" });
  // Initialize sequence buttons state (disabled when runList is empty)
  if (startSequence) startSequence.disabled = true;
  if (saveSequenceAsScenario) saveSequenceAsScenario.disabled = true;
  delayPreset?.addEventListener("change", () => {
    const isCustom = delayPreset.value === "custom";
    delayAfterScenario.style.display = isCustom ? "" : "none";
    if (!isCustom) delayAfterScenario.value = "";
  });
  document.getElementById("loopDelayPreset")?.addEventListener("change", function () {
    const isCustom = this.value === "custom";
    const customEl = document.getElementById("loopDelay");
    if (customEl) { customEl.style.display = isCustom ? "" : "none"; if (!isCustom) customEl.value = ""; }
  });
  document.getElementById("manualDelayPreset")?.addEventListener("change", function () {
    const isCustom = this.value === "custom";
    const customEl = document.getElementById("manualDelay");
    if (customEl) { customEl.style.display = isCustom ? "" : "none"; if (!isCustom) customEl.value = ""; }
  });
  csvDelayBetweenPreset?.addEventListener("change", () => {
    const isCustom = csvDelayBetweenPreset.value === "custom";
    const customEl = document.getElementById("csvDelayBetween");
    if (customEl) { customEl.style.display = isCustom ? "" : "none"; if (!isCustom) customEl.value = ""; }
  });
  addToRunList.onclick = () => {
    const scenarioId = sequenceScenarioList.value;
    if (!scenarioId) return;

    let finalDelay;
    if (delayPreset?.value === "custom") {
      const v = parseInt(delayAfterScenario.value, 10);
      finalDelay = !isNaN(v) && v >= 500 ? v : 500;
    } else {
      finalDelay = parseInt(delayPreset?.value ?? "500", 10) || 500;
    }

    const runName = ui.scenariosCache[scenarioId]?.name || "Unknown";
    ui.runList.push({ id: scenarioId, name: runName, delay: finalDelay });
    updateRunListDisplay();
    sequenceScenarioList.value = "";
    if (delayPreset) { delayPreset.value = "500"; }
    delayAfterScenario.value = "";
    delayAfterScenario.style.display = "none";
  };
  startSequence.onclick = () => {
    if (!ui.runList.length) return;

    chrome.runtime.sendMessage({
      type: "START_SEQUENCE_PLAYBACK",
      runList: ui.runList,
    });
  };
  stopSequence.onclick = () => {
    chrome.runtime.sendMessage({ type: "STOP_SEQUENCE_PLAYBACK" });
  };
  saveSequenceAsScenario.onclick = () => {
    if (!ui.runList.length) return;

    const name = sequenceName.value?.trim();
    if (!name) {
      showFieldError(sequenceName, "Sequence name is required");
      return;
    }

    chrome.runtime.sendMessage(
      {
        type: "SAVE_SEQUENCE_AS_SCENARIO",
        name,
        runList: ui.runList,
      },
      (res) => {
        sequenceName.value = "";
        ui.runList = [];
        updateRunListDisplay();
        loadScenarios();
        if (res?.success) showToast("Saved as scenario", "success");
        else showToast("Save failed", "error");
      }
    );
  };
}
