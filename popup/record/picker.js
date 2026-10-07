/**
 * record/picker.js — picking an element on the page for the form.
 */

import { manualSelector, pickElement, scenarioList, selectorType } from '../dom.js';
import { setCardOpen } from '../ui/collapsible.js';
import { ui } from '../ui-state.js';
import { isEligibleTab, safeSendTabMessage, showToast } from '../utils.js';
import { restoreDraft } from './draft.js';
import { applyManualFormState, collectManualFormState, setEditing } from './form-state.js';
import { updateFrameNote, displayPickedDragdropTargetSelectors, displayPickedSelectors } from './picked-selectors.js';

export function initPicker() {
  /* === LISTEN FOR ELEMENT PICKED (EARLY REGISTER) === */
  // Register early so ELEMENT_PICKED is caught even if popup opens later
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "ELEMENT_PICKED") {
      // If pick was triggered by element screenshot, don't populate the form
      chrome.storage.local.get(["elemShotPickPending"], (flags) => {
        if (flags.elemShotPickPending) {
          ui.pickerMode = false;
          pickElement.textContent = "🎯";
          pickElement.classList.remove('picker-active');
          document.getElementById('pickerInstructionBar')?.classList.remove('show');
          return;
        }
        manualSelector.value = msg.selector || "";
        ui.currentPickedSelectors = msg.selectors || { css: msg.selector };
        ui.currentPickedFrameId = msg.frameId ?? null;
        displayPickedSelectors(ui.currentPickedSelectors);
        updateFrameNote();
        selectorType.value = 'css';
        ui.pickerMode = false;
        pickElement.textContent = "🎯";
        pickElement.classList.remove('picker-active');
        document.getElementById('pickerInstructionBar')?.classList.remove('show');
      });
      sendResponse({ success: true });
    }
  });
  // If popup opens after picking, restore the cached selector from storage
  chrome.storage.local.get(["lastPickedSelector", "lastPickedSelectors", "lastPickedFrameId", "pendingEdit", "dragdropTargetPickPending", "dragdropTargetPickState", "elemShotPickPending", "manualFormDraft"], (res) => {
    // Restore pending edit/add state (saved before pick mode opens)
    if (res?.pendingEdit) {
      const pe = res.pendingEdit;
      // Only restore as edit if it was an existing action (has index)
      if (!pe.isNew && pe.index != null) setEditing({ scenarioId: pe.scenarioId, index: pe.index });
      // Restores every field + all wrapper visibility (also handles the legacy
      // actionValue/actionDelay shape written by older versions).
      applyManualFormState(pe);

      setCardOpen(document.getElementById("addManualActionCard"), true);

      chrome.storage.local.remove("pendingEdit");
    }

    // Restore dragdrop target pick
    if (res?.dragdropTargetPickPending && (res?.lastPickedSelector || res?.lastPickedSelectors)) {
      chrome.storage.local.remove(["dragdropTargetPickPending", "dragdropTargetPickState", "lastPickedSelector", "lastPickedSelectors"]);
      const picked = res.lastPickedSelectors?.css || res.lastPickedSelector || "";
      const st = res.dragdropTargetPickState || {};
      // Restore the whole form, then lay the freshly picked target on top.
      // `sourceSelector`/`existingTarget`/`targetSelectorType` = legacy key names.
      const targetType = st.dragdropTargetSelectorType || st.targetSelectorType || "css";
      applyManualFormState({
        ...st,
        actionType:     "dragdrop",
        selector:       st.selector       ?? st.sourceSelector  ?? "",
        pickedSelectors: st.pickedSelectors ?? st.sourceSelectors ?? null,
        dragdropTarget: st.dragdropTarget ?? st.existingTarget ?? "",
        dragdropTargetSelectorType: targetType,
      });
      // Restore target selector with full selector display
      const ddPickedSelectors = res.lastPickedSelectors || (picked ? { css: picked } : null);
      const dtSelectorType = document.getElementById("dragdropTargetSelectorType");
      if (ddPickedSelectors) {
        displayPickedDragdropTargetSelectors(ddPickedSelectors);
        if (dtSelectorType) dtSelectorType.value = targetType;
        const ddTarget = document.getElementById("dragdropTarget");
        if (ddTarget) ddTarget.value = ddPickedSelectors[targetType] || picked;
      }
      if (st.editingIndex != null) setEditing({ scenarioId: st.scenarioId, index: st.editingIndex });
      setCardOpen(document.getElementById("addManualActionCard"), true);
      return;
    }

    // Then restore picked selectors — only if NOT from element screenshot pick
    if (!res?.elemShotPickPending) {
      if (res?.lastPickedSelectors) {
        try {
          ui.currentPickedSelectors = res.lastPickedSelectors;
          ui.currentPickedFrameId = res.lastPickedFrameId ?? null;
          displayPickedSelectors(ui.currentPickedSelectors);
          updateFrameNote();
          if (res.lastPickedSelector) {
            manualSelector.value = res.lastPickedSelector;
          }
          chrome.storage.local.remove(["lastPickedSelector", "lastPickedSelectors", "lastPickedFrameId"]);
        } catch (e) { /* ignore */ }
      } else if (res?.lastPickedSelector) {
        try {
          manualSelector.value = res.lastPickedSelector;
          chrome.storage.local.remove("lastPickedSelector");
        } catch (e) { /* ignore */ }
      }

      // Restore draft (only if not coming from any pick mode)
      if (!res?.pendingEdit && !res?.dragdropTargetPickPending && res?.manualFormDraft) {
        restoreDraft(res.manualFormDraft);
      }
    }
  });

  // Dragdrop target pick mode
  document.getElementById("dragdropTargetPick")?.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id || !isEligibleTab(tab)) { showToast("Invalid tab for pick mode", "error"); return; }
      // Save current form state so we can restore after pick
      chrome.storage.local.remove(["elemShotPickPending", "elemShotPickCrop"]);
      chrome.storage.local.set({
        dragdropTargetPickPending: true,
        // Full snapshot — the popup closes below, so a partial save would drop
        // everything outside the dragdrop fields.
        dragdropTargetPickState: {
          ...collectManualFormState(),
          scenarioId: scenarioList.value || null,
          editingIndex: ui.editing ? ui.editing.index : null,
        }
      });
      safeSendTabMessage(tab.id, { type: "START_PICK_MODE" });
      chrome.runtime.sendMessage({ type: "START_PICK_MODE", tabId: tab.id });
      window.close();
    });
  });
}
