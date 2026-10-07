/**
 * handlers/folders.js — messages about folder CRUD and moving a scenario into a
 * folder.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { getScenarios, setScenarios, getFolders, setFolders, generateId, runExclusive } from '../storage.js';

export const foldersHandlers = {
  MOVE_TO_FOLDER(request, sender, sendResponse) {
    runExclusive(async () => {
      const scenarios = await getScenarios();
      if (scenarios[request.scenarioId]) {
        scenarios[request.scenarioId].folderId = request.folderId || null;
        await setScenarios(scenarios);
      }
      sendResponse({ success: true });
    });
    return true;
  },

  /* --- Folder CRUD --- */
  GET_FOLDERS(request, sender, sendResponse) {
    getFolders().then((folders) => sendResponse({ folders }));
    return true;
  },

  CREATE_FOLDER(request, sender, sendResponse) {
    runExclusive(async () => {
      const folders = await getFolders();
      const id = generateId();
      folders[id] = { name: request.name, createdAt: Date.now() };
      await setFolders(folders);
      sendResponse({ success: true, id });
    });
    return true;
  },

  RENAME_FOLDER(request, sender, sendResponse) {
    runExclusive(async () => {
      const folders = await getFolders();
      if (folders[request.folderId]) {
        folders[request.folderId].name = request.name;
        await setFolders(folders);
      }
      sendResponse({ success: true });
    });
    return true;
  },

  DELETE_FOLDER(request, sender, sendResponse) {
    runExclusive(async () => {
      const [folders, scenarios] = await Promise.all([getFolders(), getScenarios()]);
      delete folders[request.folderId];
      Object.values(scenarios).forEach((s) => {
        if (s.folderId === request.folderId) s.folderId = null;
      });
      await Promise.all([setFolders(folders), setScenarios(scenarios)]);
      sendResponse({ success: true });
    });
    return true;
  },
};
