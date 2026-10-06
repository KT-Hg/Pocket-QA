/**
 * handlers/variables.js — messages about the variable table.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { getVariableTable, setVariables } from '../storage.js';

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
};
