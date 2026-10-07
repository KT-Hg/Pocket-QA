/**
 * handlers/data-io.js — messages about import / export of scenarios and folders,
 * and the full backup / restore.
 *
 * Each handler is (request, sender, sendResponse) and returns what the
 * onMessage listener returns: `true` while sendResponse is still to come.
 */

import { state } from '../state.js';
import { getScenarios, setScenarios, getFolders, setFolders, generateId, runExclusive } from '../storage.js';
import { broadcastRecordingState } from './recording.js';

/**
 * Shape check shared by both import paths. Previously anything JSON-shaped was
 * accepted, so a folder export (or any unrelated .json) became a scenario with
 * no actions — see IMPORT_FOLDER.
 */
const _isScenarioShaped = (s) =>
  !!s && typeof s === 'object' && !Array.isArray(s) && Array.isArray(s.actions);

export const dataIoHandlers = {
  EXPORT_SCENARIO(request, sender, sendResponse) {
    getScenarios().then((scenarios) => {
      sendResponse({ scenario: scenarios[request.scenarioId] || null });
    });
    return true;
  },

  IMPORT_SCENARIO(request, sender, sendResponse) {
    if (!_isScenarioShaped(request.scenario)) {
      sendResponse({ success: false, error: 'Not a scenario: expected an object with an "actions" array' });
      return true;
    }
    runExclusive(async () => {
      const scenarios = await getScenarios();
      const id = generateId();
      // folderId is dropped: it refers to a folder id from the exporting profile
      // that almost certainly does not exist here, which would hide the scenario
      // behind a folder filter that matches nothing.
      const { folderId: _ignored, ...rest } = request.scenario;
      scenarios[id] = { ...rest, folderId: null, createdAt: Date.now() };
      await setScenarios(scenarios);
      // Flag script actions in imported scenarios so the popup can warn the user —
      // imported code runs with the extension's elevated CSP privileges.
      const hasScriptActions = (request.scenario.actions || []).some(a => a?.type === 'script');
      sendResponse({ success: true, id, hasScriptActions });
    });
    return true;
  },

  /**
   * Import a file produced by EXPORT_FOLDER: { name, createdAt, scenarios: {…} }.
   *
   * That shape was never importable — the popup treated the whole object as one
   * scenario, producing an empty entry named after the folder while the real
   * scenarios were discarded. Recreating the folder here keeps the export
   * meaningful and preserves the grouping the user set up.
   */
  IMPORT_FOLDER(request, sender, sendResponse) {
    const payload = request.folder;
    const allEntries = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.entries(payload.scenarios || {})
      : [];
    const valid = allEntries.filter(([, s]) => _isScenarioShaped(s));
    if (!valid.length) {
      sendResponse({ success: false, error: 'Folder export contains no valid scenarios' });
      return true;
    }
    runExclusive(async () => {
      const [folders, scenarios] = await Promise.all([getFolders(), getScenarios()]);
      const folderId = generateId();
      folders[folderId] = { name: payload.name || 'Imported folder', createdAt: Date.now() };
      // Every scenario gets a fresh id, which used to break `switch` actions that
      // branch to a sibling in the same folder: their cases still named ids from
      // the exporting profile, so the branch failed with "scenario not found".
      // Allocate the new ids up front and rewrite the cases as they are imported.
      const idMap = new Map(valid.map(([oldId]) => [oldId, generateId()]));
      let hasScriptActions = false;
      for (const [oldId, src] of valid) {
        const { folderId: _ignored, ...rest } = src;
        const actions = (src.actions || []).map((a) => {
          if (a?.type !== 'switch' || !Array.isArray(a.cases)) return a;
          return {
            ...a,
            cases: a.cases.map(c =>
              c && idMap.has(c.scenarioId) ? { ...c, scenarioId: idMap.get(c.scenarioId) } : c),
          };
        });
        scenarios[idMap.get(oldId)] = { ...rest, actions, folderId, createdAt: Date.now() };
        if (actions.some(a => a?.type === 'script')) hasScriptActions = true;
      }
      await Promise.all([setFolders(folders), setScenarios(scenarios)]);
      sendResponse({
        success: true, folderId, count: valid.length,
        skipped: allEntries.length - valid.length,
        folderName: folders[folderId].name,
        hasScriptActions,
      });
    });
    return true;
  },

  EXPORT_FOLDER(request, sender, sendResponse) {
    Promise.all([getFolders(), getScenarios()]).then(([folders, scenarios]) => {
      const folder = folders[request.folderId];
      if (!folder) { sendResponse({ folder: null }); return; }
      const folderScenarios = Object.entries(scenarios)
        .filter(([, s]) => s.folderId === request.folderId)
        .reduce((acc, [id, s]) => { acc[id] = s; return acc; }, {});
      sendResponse({ folder: { ...folder, scenarios: folderScenarios } });
    });
    return true;
  },

  /* --- Backup / Restore All Data ---
   *
   * The backup file is the whole chrome.storage.local snapshot with the
   * chrome.storage.sync settings nested under BACKUP_SYNC_KEY. Both areas are
   * needed: scenarios, folders, variables and highlights live in `local`, while
   * hotkeys, screenshot save mode/prefix, segment scroll speed and the completion
   * notification toggle live in `sync`. Backing up only `local` silently lost the
   * whole second half.
   *
   * Restore filters by *deny*list rather than allowlist. The old allowlist had to
   * be extended by hand for every new feature and had fallen behind: highlights
   * (hl_v1), highlight URL patterns, the highlight on/off toggle, the tab order
   * and the screenshot countdown settings were all written by the app, captured
   * in the backup file, and then dropped on the way back in — while the toast
   * still said "Data restored". A denylist only has to name things that are
   * genuinely not portable, and those change far less often.
   */
  GET_ALL_DATA(request, sender, sendResponse) {
    Promise.all([
      new Promise(r => chrome.storage.local.get(null, r)),
      new Promise(r => chrome.storage.sync.get(null, r)),
    ]).then(([local, sync]) => {
      sendResponse({ data: local || {}, sync: sync || {} });
    });
    return true;
  },

  RESTORE_ALL_DATA(request, sender, sendResponse) {
    const data = request.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      sendResponse({ success: false, error: "Invalid backup format: expected an object" });
      return true;
    }

    // Keys deliberately NOT carried across a restore.
    const DENIED_KEYS = new Set([
      // Machine-local and session-local: tab ids from another profile point at
      // unrelated tabs, and a stale checkpoint pops a false "resume?" banner.
      "activatedTabs", "playbackCheckpoint",
      // Bulk transient run data — large, and meaningless once the run is over.
      "_csvRows", "csvSessionData", "csvRunResults", "csvSsVarOrder",
      // Half-finished popup interactions.
      "pendingEdit", "manualFormDraft", "pendingRecordScenarioId",
      "elemShotPickPending", "elemShotPickCrop",
      "lastPickedSelector", "lastPickedSelectors", "lastPickedFrameId",
      "dragdropTargetPickPending", "dragdropTargetPickState",
      // Update bookkeeping belongs to this install, not to the backup. Importing
      // another machine's grace-period anchors could lock this one out.
      "updateStatus", "updateAvailableSince", "lastUpdateAt", "remoteConfig",
      "autoApplyAt", "autoApplyTries", "updateBannerDismissed",
      // Dead key from builds that wrote an unreadable rollback snapshot.
      "_preRestoreBackup",
    ]);

    const BACKUP_SYNC_KEY = "__sync";
    const syncPayload = data[BACKUP_SYNC_KEY];
    const sanitized = {};
    for (const [k, v] of Object.entries(data)) {
      if (k === BACKUP_SYNC_KEY || DENIED_KEYS.has(k)) continue;
      sanitized[k] = v;
    }

    const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
    if (sanitized.scenarios !== undefined && !isPlainObject(sanitized.scenarios)) {
      sendResponse({ success: false, error: "Invalid backup: scenarios must be an object" }); return true;
    }
    if (sanitized.folders !== undefined && !isPlainObject(sanitized.folders)) {
      sendResponse({ success: false, error: "Invalid backup: folders must be an object" }); return true;
    }
    if (sanitized.schedules !== undefined && !Array.isArray(sanitized.schedules)) {
      sendResponse({ success: false, error: "Invalid backup: schedules must be an array" }); return true;
    }

    // Merge (not clear+set) to avoid data loss if the browser crashes mid-write.
    // No rollback snapshot is stored: the one this used to write was never read
    // by anything, and it doubled storage usage on every restore. The popup warns
    // to take a backup first instead.
    // Queued behind any import or edit still writing, which would otherwise put
    // its own copy of `scenarios` back over the restored one.
    runExclusive(() => {
      const writeLocal = new Promise((resolve) => {
        chrome.storage.local.set(sanitized, () => resolve(chrome.runtime.lastError?.message || null));
      });
      // Backups made before sync settings were included simply have no __sync block.
      const writeSync = isPlainObject(syncPayload)
        ? new Promise((resolve) => {
            chrome.storage.sync.set(syncPayload, () => resolve(chrome.runtime.lastError?.message || null));
          })
        : Promise.resolve(null);
      return Promise.all([writeLocal, writeSync]);
    }).then(([localErr, syncErr]) => {
      if (localErr) { sendResponse({ success: false, error: localErr }); return; }
      state.recording = false;
      state.currentActions = [];
      broadcastRecordingState(false);
      // A sync failure (quota, sync disabled) must not fail the whole restore —
      // the scenarios are already in. Report it so the user can redo the settings.
      sendResponse({
        success: true,
        restoredSync: !!isPlainObject(syncPayload) && !syncErr,
        warning: syncErr ? `Settings could not be restored: ${syncErr}` : null,
      });
    });
    return true;
  },
};
