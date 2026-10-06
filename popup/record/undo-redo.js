/**
 * record/undo-redo.js — undo / redo of the action list.
 */

import { redoAction, scenarioList, undoAction } from '../dom.js';
import { previewActions } from './preview.js';

/* === UNDO/REDO === */

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
      chrome.runtime.sendMessage({ type: "UNDO_ACTION", scenarioId }, (res) => {
        if (res?.success) { previewActions(); updateUndoRedoState(); }
      });
    });
  }
  if (redoAction) {
    redoAction.addEventListener('click', () => {
      const scenarioId = scenarioList?.value || null;
      chrome.runtime.sendMessage({ type: "REDO_ACTION", scenarioId }, (res) => {
        if (res?.success) { previewActions(); updateUndoRedoState(); }
      });
    });
  }
}
