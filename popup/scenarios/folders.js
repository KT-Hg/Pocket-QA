/**
 * scenarios/folders.js — folders: the folder selects, filter, move and the
 * manage folders card.
 */

import { createFolderAction, createFolderBtn, doMoveToFolder, exportFolder, exportFolderSelect, exportScenario, exportScenarioSelect, filterFolder, foldersList, manageFoldersCard, moveToFolderSelect, newFolderInput, scenarioFolder, scenarioList } from '../dom.js';
import { clearEditState } from '../record/action-form.js';
import { showFieldError } from '../record/picked-selectors.js';
import { previewActions } from '../record/preview.js';
import { ui } from '../ui-state.js';
import { showConfirm, showToast } from '../utils.js';
import { toggleScenarioActions } from './scenario-actions.js';
import { loadScenarios } from './scenario-list.js';

/* === FOLDERS === */

export function renderFolderOptions() {
  // Render folder options for Save Scenario
  scenarioFolder.innerHTML = '<option value="">No Folder</option>';

  // Render folder options for Filter
  filterFolder.innerHTML = '<option value="">All Folders</option><option value="__none__">No Folder</option>';

  Object.entries(ui.foldersCache)
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .forEach(([id, folder]) => {
      const option1 = document.createElement("option");
      option1.value = id;
      option1.textContent = folder.name;
      scenarioFolder.appendChild(option1);

      const option2 = document.createElement("option");
      option2.value = id;
      option2.textContent = folder.name;
      filterFolder.appendChild(option2);
    });

  // Render options for Export Folder select
  if (exportFolderSelect) {
    exportFolderSelect.innerHTML = '<option value="">-- Select folder --</option>';
    const folderEntries = Object.entries(ui.foldersCache);
    folderEntries
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .forEach(([id, folder]) => {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = folder.name;
        exportFolderSelect.appendChild(opt);
      });

    // Disable export button if no folders exist or none selected
    if (exportFolder) {
      exportFolder.disabled = folderEntries.length === 0 || !exportFolderSelect.value;
    }
  }
}

// Populate Export Scenario select
export function renderExportScenarioSelect() {
  if (!exportScenarioSelect) return;
  exportScenarioSelect.innerHTML = '<option value="">-- Select scenario --</option>';

  const list = Object.entries(ui.scenariosCache).map(([id, s]) => ({
    id,
    name: s.name,
    folderId: s.folderId || null,
  }));

  // Group by folder
  const grouped = {};
  list.forEach((item) => {
    const key = item.folderId || "__none__";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  });

  const folderKeys = Object.keys(grouped).sort((a, b) => {
    if (a === "__none__") return 1;
    if (b === "__none__") return -1;
    const nameA = ui.foldersCache[a]?.name || "";
    const nameB = ui.foldersCache[b]?.name || "";
    return nameA.localeCompare(nameB);
  });

  folderKeys.forEach((folderId) => {
    const items = grouped[folderId];
    const folderName = folderId === "__none__" ? "No Folder" : ui.foldersCache[folderId]?.name || "Unknown";

    const optgroup = document.createElement("optgroup");
    optgroup.label = folderName;
    exportScenarioSelect.appendChild(optgroup);

    items.sort((a, b) => a.name.localeCompare(b.name)).forEach((item) => {
      const o = document.createElement("option");
      o.value = item.id;
      o.textContent = item.name;
      optgroup.appendChild(o);
    });
  });

  // Disable export button if no scenarios exist or none selected
  if (exportScenario) {
    exportScenario.disabled = list.length === 0 || !exportScenarioSelect.value;
  }
}

// Populate Move to Folder select when needed
export function renderMoveToFolderSelect() {
  moveToFolderSelect.innerHTML = '<option value="">No Folder</option>';
  const sortedFolders = Object.entries(ui.foldersCache)
    .sort((a, b) => a[1].name.localeCompare(b[1].name));

  sortedFolders.forEach(([folderId, folder]) => {
    const option = document.createElement("option");
    option.value = folderId;
    option.textContent = folder.name;
    moveToFolderSelect.appendChild(option);
  });
}

export function renderFoldersManagementUI() {
  foldersList.innerHTML = "";
  const sortedFolders = Object.entries(ui.foldersCache)
    .sort((a, b) => a[1].name.localeCompare(b[1].name));

  if (sortedFolders.length === 0) {
    foldersList.innerHTML = '<div style="color: var(--muted); padding: 10px 0; text-align: center;">No folders yet</div>';
    return;
  }

  sortedFolders.forEach(([folderId, folder]) => {
    const count = Object.values(ui.scenariosCache).filter(s => s.folderId === folderId).length;
    const folderDiv = document.createElement("div");
    folderDiv.className = "list-item";

    const contentDiv = document.createElement("div");
    contentDiv.className = "list-item-content";
    contentDiv.textContent = `${folder.name} (${count})`;

    const actionsDiv = document.createElement("div");
    actionsDiv.className = "list-item-actions";

    const renameBtn = document.createElement("button");
    renameBtn.textContent = "Rename";
    renameBtn.className = "list-item-btn secondary";
    renameBtn.dataset.folderId = folderId;
    renameBtn.onclick = (e) => {
      e.stopPropagation();
      const btn = e.target;
      const currentFolderId = btn.dataset.folderId;

      if (btn.dataset.editing) {
        // Save mode
        const input = contentDiv.querySelector("input");
        const newName = input.value.trim();
        if (!newName) {
          showFieldError(input, "Folder name is required");
          return;
        }
        chrome.runtime.sendMessage({ type: "RENAME_FOLDER", folderId: currentFolderId, name: newName }, () => {
          loadScenarios(); // Refresh caches and all folder-dependent UI immediately
          showToast("Folder renamed", "success");
        });
      } else {
        // Edit mode
        const input = document.createElement("input");
        input.type = "text";
        input.value = ui.foldersCache[currentFolderId].name;
        input.style.cssText = "flex: 1; padding: 4px 6px; font-size: 11px; border: 2px solid var(--primary); border-radius: 4px; background: var(--card); color: var(--text); margin: 0;";

        contentDiv.innerHTML = "";
        contentDiv.appendChild(input);
        btn.textContent = "Save";
        btn.dataset.editing = "true";
        input.focus();
        input.select();
      }
    };

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.className = "list-item-btn danger";
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      showConfirm(`Delete folder "${folder.name}"? Scenarios will be moved to "No Folder"`, () => {
        chrome.runtime.sendMessage({ type: "DELETE_FOLDER", folderId }, () => {
          loadScenarios(); // Refresh caches after delete so lists update instantly
          showToast("Folder deleted", "success");
        });
      }, { title: 'Delete Folder', danger: true });
    };

    actionsDiv.appendChild(renameBtn);
    actionsDiv.appendChild(deleteBtn);
    folderDiv.appendChild(contentDiv);
    folderDiv.appendChild(actionsDiv);
    foldersList.appendChild(folderDiv);
  });
}

export function initFolders() {
  if (createFolderBtn) {
    createFolderBtn.onclick = () => {
      // Open and scroll to Manage Folders section
      if (manageFoldersCard) {
        manageFoldersCard.classList.remove("collapsed");
        manageFoldersCard.scrollIntoView({ behavior: "smooth", block: "start" });

        // Focus on the input field after scrolling
        const AFTER_SCROLL_MS = 300;
        setTimeout(() => {
          if (newFolderInput) {
            newFolderInput.focus();
          }
        }, AFTER_SCROLL_MS);
      }
    };
  }
  if (doMoveToFolder) {
    doMoveToFolder.onclick = () => {
      const scenarioId = scenarioList.value;
      if (!scenarioId) return;

      const folderId = moveToFolderSelect.value || null;

      chrome.runtime.sendMessage({ type: "MOVE_TO_FOLDER", scenarioId, folderId }, () => {
        moveToFolderSelect.value = "";
        loadScenarios();
      });
    };
  }
  if (createFolderAction) {
    createFolderAction.onclick = () => {
      const name = newFolderInput.value.trim();
      if (!name) {
        showFieldError(newFolderInput, "Folder name is required");
        return;
      }

      chrome.runtime.sendMessage({ type: "CREATE_FOLDER", name }, () => {
        newFolderInput.value = "";
        loadScenarios(); // Reload to reflect new folder everywhere without reopening popup
        showToast("Folder created", "success");
      });
    };
  }
  scenarioList.onchange = () => {
    // If editing an action that belongs to a different scenario, clear the form
    // to prevent stale edit state from leaking across scenarios.
    if (ui.editing && ui.editing.scenarioId !== (scenarioList.value || null)) {
      clearEditState();
      chrome.storage.local.remove("manualFormDraft");
    }
    // Enable scenario actions only when a real scenario is selected
    const hasSelection = !!scenarioList.value;
    toggleScenarioActions(hasSelection);
    previewActions();
    // Persist selection so it remains when popup is closed and reopened
    if (hasSelection) {
      chrome.storage.local.set({ lastSelectedScenario: scenarioList.value });
    } else {
      chrome.storage.local.remove("lastSelectedScenario");
    }
  };
}
