/**
 * handlers/scenarios.js — messages about scenario CRUD.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { state } from '../state.js';
import { getScenarios, setScenarios, generateId, getStack, runExclusive } from '../storage.js';

export const scenariosHandlers = {
  /* --- Scenario CRUD --- */
  GET_SCENARIOS(request, sender, sendResponse) {
    getScenarios().then((scenarios) => sendResponse({ scenarios }));
    return true;
  },

  SAVE_SCENARIO(request, sender, sendResponse) {
    runExclusive(async () => {
      const scenarios = await getScenarios();
      const id = generateId();
      const now = Date.now();
      scenarios[id] = {
        name: request.name,
        actions: [...state.currentActions],
        folderId: request.folderId || null,
        createdAt: request.originalCreatedAt || now,
        updatedAt: now,
      };
      state.currentActions = [];
      getStack("current").undo = [];
      getStack("current").redo = [];
      await setScenarios(scenarios);
      sendResponse({ success: true, id });
    });
    return true;
  },

  // An empty scenario made up front by "New" with a name typed: the popup
  // selects it, so what is recorded or added next saves straight into it.
  CREATE_SCENARIO(request, sender, sendResponse) {
    const name = String(request.name || "").trim();
    if (!name) { sendResponse({ success: false }); return; }
    runExclusive(async () => {
      const scenarios = await getScenarios();
      const id = generateId();
      const now = Date.now();
      scenarios[id] = { name, actions: [], folderId: request.folderId || null, createdAt: now, updatedAt: now };
      await setScenarios(scenarios);
      sendResponse({ success: true, id });
    });
    return true;
  },

  START_NEW_SCENARIO(request, sender, sendResponse) {
    state.currentActions = [];
    getStack("current").undo = [];
    getStack("current").redo = [];
    sendResponse({ success: true });
    return;
  },

  DELETE_SCENARIO(request, sender, sendResponse) {
    runExclusive(async () => {
      const scenarios = await getScenarios();
      delete scenarios[request.scenarioId];
      await setScenarios(scenarios);
      sendResponse({ success: true });
    });
    return true;
  },

  RENAME_SCENARIO(request, sender, sendResponse) {
    runExclusive(async () => {
      const scenarios = await getScenarios();
      if (scenarios[request.scenarioId]) {
        scenarios[request.scenarioId].name = request.newName;
        await setScenarios(scenarios);
      }
      sendResponse({ success: true });
    });
    return true;
  },

  /**
   * The scenario's own "Click through" (shared/click-through.js). Only the
   * scenario is written: its actions keep their own settings, so turning it
   * back on leaves the ones turned off on their own as they were.
   */
  SET_SCENARIO_CLICK_THROUGH(request, sender, sendResponse) {
    runExclusive(async () => {
      const scenarios = await getScenarios();
      const scenario = scenarios[request.scenarioId];
      if (!scenario) { sendResponse({ success: false }); return; }
      if (request.allowed) delete scenario.clickThrough;
      else scenario.clickThrough = false;
      await setScenarios(scenarios);
      sendResponse({ success: true, clickThrough: scenario.clickThrough !== false });
    });
    return true;
  },

  DUPLICATE_SCENARIO(request, sender, sendResponse) {
    runExclusive(async () => {
      const scenarios = await getScenarios();
      const original = scenarios[request.scenarioId];
      if (!original) { sendResponse({ success: false }); return; }
      const id = generateId();
      scenarios[id] = {
        ...original,
        name: original.name + " (copy)",
        actions: JSON.parse(JSON.stringify(original.actions || [])),
        createdAt: Date.now(),
      };
      await setScenarios(scenarios);
      sendResponse({ success: true, id });
    });
    return true;
  },

  SAVE_SEQUENCE_AS_SCENARIO(request, sender, sendResponse) {
    runExclusive(async () => {
      const scenarios = await getScenarios();
      const allActions = [];
      for (let i = 0; i < request.runList.length; i++) {
        const item = request.runList[i];
        const s = scenarios[item.id];
        if (s?.actions) allActions.push(...s.actions);
        if (i < request.runList.length - 1 && item.delay > 0) {
          allActions.push({ type: "wait", value: String(item.delay) });
        }
      }
      const id = generateId();
      scenarios[id] = { name: request.name, actions: allActions, folderId: null, createdAt: Date.now() };
      await setScenarios(scenarios);
      sendResponse({ success: true, id });
    });
    return true;
  },
};
