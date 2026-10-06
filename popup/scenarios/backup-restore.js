/**
 * scenarios/backup-restore.js — backup and restore of all data.
 */

import { downloadBlob } from '../lib/download.js';
import { showConfirm, showToast } from '../utils.js';

let backupAllBtn;
let restoreAllBtn;
let restoreFileInput;

function _doRestore(file) {
  if (!file || !file.name.endsWith('.json')) {
    showToast("Please select a .json backup file", "error");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      showConfirm(
        "This overwrites ALL current data — scenarios, folders, variables, schedules, " +
        "highlights and settings. It cannot be undone, so run \"Backup All Data\" first " +
        "if you have anything you want to keep. Continue?",
        () => {
          chrome.runtime.sendMessage({ type: "RESTORE_ALL_DATA", data }, (res) => {
            if (chrome.runtime.lastError) {
              showToast("Restore failed: " + chrome.runtime.lastError.message, "error");
              return;
            }
            if (res?.success) {
              // A sync-settings failure still leaves a usable restore, so it is a
              // warning rather than an error — but it must not be silent.
              if (res.warning) showToast(res.warning, "warn");
              else showToast("Data restored — reloading…", "success");
              setTimeout(() => location.reload(), res.warning ? 3500 : 1200);
            } else {
              showToast("Restore failed: " + (res?.error || "unknown"), "error");
            }
          });
        },
        { title: "Restore All Data", okLabel: "Restore", danger: true }
      );
    } catch {
      showToast("Invalid backup file", "error");
    }
  };
  reader.readAsText(file);
}

export function initBackupRestore() {
  /* === BACKUP / RESTORE ALL DATA === */

  backupAllBtn = document.getElementById("backupAll");
  restoreAllBtn = document.getElementById("restoreAll");
  restoreFileInput = document.getElementById("restoreFile");
  if (backupAllBtn) {
    backupAllBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: "GET_ALL_DATA" }, (res) => {
        if (chrome.runtime.lastError || !res?.data) {
          showToast("Backup failed", "error");
          return;
        }
        // chrome.storage.sync settings (hotkeys, screenshot save mode + prefix,
        // segment scroll speed, completion notification) go under __sync. Restore
        // splits them back out; older files without the key still load.
        const payload = { ...res.data, __sync: res.sync || {} };
        downloadBlob(
          new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
          `pocket-qa-backup-${new Date().toISOString().slice(0, 10)}.json`,
        );
        showToast("Backup downloaded", "success");
      });
    };
  }
  if (restoreAllBtn && restoreFileInput) {
    restoreAllBtn.onclick = () => {
      const file = restoreFileInput.files[0];
      if (!file) { showToast("Please choose a backup file first", "error"); return; }
      _doRestore(file);
    };
  }
}
