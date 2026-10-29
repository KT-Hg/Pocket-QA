/**
 * record/undo-redo.js — undo / redo of the action list.
 */

import { redoAction, scenarioList, undoAction } from '../dom.js';
import { ui } from '../ui-state.js';
import { showToast } from '../utils.js';
import { previewActions } from './preview.js';

/* === UNDO/REDO === */

/**
 * Undo / Redo put back a whole earlier list. An open edit follows its action
 * through a drag or a Delete (followListEdit), not through that: Save would
 * write to whatever is in its place, so the edit is finished first.
 */
function _editOpen(scenarioId) {
  if (ui.editing?.scenarioId !== scenarioId) return false;
  showToast("Save or cancel the action being edited first", "info");
  return true;
}

export function updateUndoRedoState() {
  const scenarioId = scenarioList?.value || null;
  chrome.runtime.sendMessage({ type: "GET_UNDO_REDO_STATE", scenarioId }, (res) => {
    if (chrome.runtime.lastError) return; // popup may have lost connection briefly
    if (undoAction) undoAction.disabled = !res?.canUndo;
    if (redoAction) redoAction.disabled = !res?.canRedo;
  });
}

export function initUndoRedo() {
  if (undoAction) {
    undoAction.addEventListener('click', () => {
      const scenarioId = scenarioList?.value || null;
      if (_editOpen(scenarioId)) return;
      chrome.runtime.sendMessage({ type: "UNDO_ACTION", scenarioId }, (res) => {
        if (res?.success) { previewActions(); updateUndoRedoState(); }
      });
    });
  }
  if (redoAction) {
    redoAction.addEventListener('click', () => {
      const scenarioId = scenarioList?.value || null;
      if (_editOpen(scenarioId)) return;
      chrome.runtime.sendMessage({ type: "REDO_ACTION", scenarioId }, (res) => {
        if (res?.success) { previewActions(); updateUndoRedoState(); }
      });
    });
  }
}
