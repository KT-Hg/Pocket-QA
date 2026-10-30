/**
 * handlers/variables.js — messages about the variable table.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { normalizeVarName, renameVarRefs } from '../../shared/var-name.js';
import { isAnyPlaybackActive } from '../run-state.js';
import { state } from '../state.js';
import { getScenarios, getVariableTable, mapUndoSnapshots, runExclusive, setScenarios, setVariables } from '../storage.js';

// Scenarios named when a new name is refused as already used; the rest are "…".
const USED_IN_SHOWN = 3;

export const variablesHandlers = {
  /* --- Variables --- */
  GET_VARIABLES(request, sender, sendResponse) {
    getVariableTable().then(({ variables, order, sort }) => sendResponse({ variables, order, sort }));
    return true;
  },

  SAVE_VARIABLES(request, sender, sendResponse) {
    setVariables(request.variables || {}, request.order).then(() => {
      sendResponse({ success: true });
    });
    return true;
  },

  /**
   * Renames a variable in the table and in every scenario that uses it
   * (renameVarRefs) — their undo / redo snapshots and the unsaved recorded
   * actions too — in one queued task so no other scenario edit lands in
   * between. Refused whole, nothing written, when the new name is already the
   * table's or a scenario's (a Read DOM target, a CSV column…) — two variables
   * would become one for good — and while a run plays, its variables resolved
   * under the old name.
   */
  RENAME_VARIABLE(request, sender, sendResponse) {
    const { from, to } = request;
    runExclusive(async () => {
      const refuse = (error) => sendResponse({ success: false, error });
      if (isAnyPlaybackActive()) return refuse('Stop the run before renaming a variable');
      if (normalizeVarName(to) !== to) return refuse('A variable name cannot start with "${" or contain "}"');
      const [{ variables, order }, scenarios] = await Promise.all([getVariableTable(), getScenarios()]);
      if (!Object.hasOwn(variables, from)) return refuse(`No variable "${from}"`);
      if (Object.hasOwn(variables, to)) return refuse(`"${to}" already exists`);
      const usedIn = Object.values(scenarios)
        .filter(s => (s.actions || []).some(a => renameVarRefs(a, to, to).count))
        .map(s => `"${s.name}"`);
      if (usedIn.length) {
        const names = usedIn.slice(0, USED_IN_SHOWN).join(', ') + (usedIn.length > USED_IN_SHOWN ? '…' : '');
        return refuse(`"${to}" is already used in ${names}`);
      }

      let changed = 0, refs = 0;
      for (const s of Object.values(scenarios)) {
        let n = 0;
        const actions = (s.actions || []).map((a) => {
          const r = renameVarRefs(a, from, to);
          n += r.count;
          return r.action;
        });
        if (n) { s.actions = actions; changed++; refs += n; }
      }
      if (changed) await setScenarios(scenarios);
      // Undo / Redo would otherwise bring the old name back, and the actions
      // recorded with no scenario chosen are saved later as they are.
      const renameAll = (actions) => (Array.isArray(actions) ? actions.map(a => renameVarRefs(a, from, to).action) : actions);
      mapUndoSnapshots(renameAll);
      state.currentActions = renameAll(state.currentActions);
      const renamed = {};
      for (const [k, v] of Object.entries(variables)) renamed[k === from ? to : k] = v;
      await setVariables(renamed, order.map(n => (n === from ? to : n)));
      sendResponse({ success: true, scenarios: changed, refs });
    });
    return true;
  },
};
