/**
 * handlers/actions.js — messages about the action list being edited — the current
 * recording or a stored scenario: preview, undo/redo, add, update, remove,
 * disable, reorder.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { state } from '../state.js';
import { getScenarios, setScenarios, getStack, pushUndo, mutateScenarioActions } from '../storage.js';
import { remapAfterRemove, remapAfterReorder, toggleDisabled } from '../../shared/switch-blocks.js';

/**
 * Index sanity check for the action-mutation handlers.
 *
 * These indices come from list positions the popup captured before an async
 * round-trip, so a fast second click or a concurrent edit could deliver one
 * that no longer exists. Writing past the end produced a sparse array holding
 * `undefined`, which then rendered as a shorter list for no visible reason and
 * threw during playback at interpolateAction(undefined).
 */
const _validIndex = (i, len) => Number.isInteger(i) && i >= 0 && i < len;

export const actionsHandlers = {
  /* --- Preview / undo-redo --- */
  GET_PREVIEW_ACTIONS(request, sender, sendResponse) {
    if (request.scenarioId) {
      getScenarios().then((scenarios) => {
        sendResponse({ actions: scenarios[request.scenarioId]?.actions || [] });
      });
      return true;
    }
    sendResponse({ actions: state.currentActions });
    return;
  },

  GET_UNDO_REDO_STATE(request, sender, sendResponse) {
    const key = request.scenarioId || "current";
    const s = getStack(key);
    sendResponse({ canUndo: s.undo.length > 0, canRedo: s.redo.length > 0 });
    return;
  },

  UNDO_ACTION(request, sender, sendResponse) {
    const key = request.scenarioId || "current";
    const s = getStack(key);
    if (!s.undo.length) { sendResponse({ success: false }); return; }
    if (request.scenarioId) {
      getScenarios().then(async (scenarios) => {
        const current = scenarios[request.scenarioId]?.actions || [];
        s.redo.push(JSON.parse(JSON.stringify(current)));
        scenarios[request.scenarioId].actions = s.undo.pop();
        await setScenarios(scenarios);
        sendResponse({ success: true });
      });
      return true;
    } else {
      s.redo.push(JSON.parse(JSON.stringify(state.currentActions)));
      state.currentActions = s.undo.pop();
      sendResponse({ success: true });
      return;
    }
  },

  REDO_ACTION(request, sender, sendResponse) {
    const key = request.scenarioId || "current";
    const s = getStack(key);
    if (!s.redo.length) { sendResponse({ success: false }); return; }
    if (request.scenarioId) {
      getScenarios().then(async (scenarios) => {
        const current = scenarios[request.scenarioId]?.actions || [];
        s.undo.push(JSON.parse(JSON.stringify(current)));
        scenarios[request.scenarioId].actions = s.redo.pop();
        await setScenarios(scenarios);
        sendResponse({ success: true });
      });
      return true;
    } else {
      s.undo.push(JSON.parse(JSON.stringify(state.currentActions)));
      state.currentActions = s.redo.pop();
      sendResponse({ success: true });
      return;
    }
  },

  /* --- Manual action editing --- */
  ADD_MANUAL_ACTION(request, sender, sendResponse) {
    if (!request.action || typeof request.action !== 'object') {
      sendResponse({ success: false });
      return;
    }
    if (request.scenarioId) {
      mutateScenarioActions(request.scenarioId, (a) => [...a, request.action])
        .then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }
    pushUndo("current", [...state.currentActions]);
    state.currentActions.push(request.action);
    sendResponse({ success: true });
    return;
  },

  UPDATE_ACTION(request, sender, sendResponse) {
    if (request.scenarioId) {
      mutateScenarioActions(request.scenarioId, (a) => {
        if (!_validIndex(request.index, a.length)) throw new Error("index out of range");
        const next = [...a];
        next[request.index] = request.action;
        return next;
      }).then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }
    if (!_validIndex(request.index, state.currentActions.length)) { sendResponse({ success: false }); return; }
    pushUndo("current", [...state.currentActions]);
    state.currentActions[request.index] = request.action;
    sendResponse({ success: true });
    return;
  },

  // Removing or reordering shifts absolute indices, so Switch case ranges,
  // old-style jump targets and continueAt are rewritten in the same step (see
  // shared/switch-blocks.js) — the undo snapshot then restores both together.
  REMOVE_ACTION(request, sender, sendResponse) {
    if (request.scenarioId) {
      mutateScenarioActions(request.scenarioId, (a) => {
        if (!_validIndex(request.index, a.length)) throw new Error("index out of range");
        return remapAfterRemove(a, request.index);
      }).then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }
    if (!_validIndex(request.index, state.currentActions.length)) { sendResponse({ success: false }); return; }
    pushUndo("current", [...state.currentActions]);
    state.currentActions = remapAfterRemove(state.currentActions, request.index);
    sendResponse({ success: true });
    return;
  },

  TOGGLE_ACTION_DISABLED(request, sender, sendResponse) {
    // A Switch or Condition takes the actions under it along (toggleDisabled);
    // `children` tells the popup how many followed.
    if (request.scenarioId) {
      let result = null;
      mutateScenarioActions(request.scenarioId, (a) => {
        if (request.index < 0 || request.index >= a.length) throw new Error("out of range");
        result = toggleDisabled(a, request.index);
        return result.actions;
      }).then(() => sendResponse({ success: true, disabled: result.disabled, children: result.children }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }
    if (request.index < 0 || request.index >= state.currentActions.length) { sendResponse({ success: false }); return; }
    pushUndo("current", [...state.currentActions]);
    // New action objects, so the undo snapshot above keeps the old states; the
    // array itself is updated in place for everything else holding it.
    const result = toggleDisabled(state.currentActions, request.index);
    state.currentActions.splice(0, state.currentActions.length, ...result.actions);
    sendResponse({ success: true, disabled: result.disabled, children: result.children });
    return;
  },

  REORDER_ACTIONS(request, sender, sendResponse) {
    // A reorder must be a permutation of the existing indices. Anything else —
    // a duplicate, a gap, a stale index from a racing drag — silently dropped or
    // cloned actions, so it is refused outright rather than half-applied.
    const _isPermutation = (order, len) =>
      Array.isArray(order) && order.length === len &&
      new Set(order).size === len &&
      order.every((i) => _validIndex(i, len));

    // `move` (optional) says which unit was dragged and which case it was
    // dropped into; without it every action keeps its case.
    const _move = (len) => {
      const m = request.move;
      if (!m || !Array.isArray(m.items) || !m.items.every((i) => _validIndex(i, len))) return null;
      const t = m.target;
      if (t && !_validIndex(t.switchIdx, len)) return null;
      return m;
    };

    if (request.scenarioId) {
      mutateScenarioActions(request.scenarioId, (a) => {
        if (!_isPermutation(request.newOrder, a.length)) throw new Error("invalid reorder");
        return remapAfterReorder(a, request.newOrder, _move(a.length));
      }).then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }
    if (!_isPermutation(request.newOrder, state.currentActions.length)) { sendResponse({ success: false }); return; }
    pushUndo("current", [...state.currentActions]);
    state.currentActions = remapAfterReorder(state.currentActions, request.newOrder, _move(state.currentActions.length));
    sendResponse({ success: true });
    return;
  },
};
