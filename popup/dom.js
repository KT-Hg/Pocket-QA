/**
 * dom.js — elements of the Record & Play and Data tabs that several parts
 * use, looked up once when the popup starts.
 */

export let actionsEl;
export let activationStatus;
export let activateTab;
export let deactivateTab;
export let scenarioSearch;
export let scenarioSort;
export let duplicateScenarioBtn;
export let scenarioFolder;
export let createFolderBtn;
export let filterFolder;
export let moveToFolderSelect;
export let doMoveToFolder;
export let manageFoldersCard;
export let newFolderInput;
export let createFolderAction;
export let foldersList;
export let scenarioList;
export let sequenceScenarioList;
export let preview;
export let startRecord;
export let stopRecord;
export let manualSelector;
export let selectorType;
export let pickedSelectorsInfo;
export let pickedSelectorsWrap;
export let manualActionType;
export let manualValue;
export let manualDelay;
export let addManualAction;
export let cancelEdit;
export let pickElement;
export let newFlow;
export let saveFlow;
export let scenarioName;
export let autoSaveNotice;
export let renameScenario;
export let renameInput;
export let deleteScenario;
export let exportScenario;
export let exportScenarioSelect;
export let exportFolder;
export let exportFolderSelect;
export let importFile;
export let importScenario;
export let playScenario;
export let stopPlay;
export let delayAfterScenario;
export let delayPreset;
export let addToRunList;
export let runListDisplay;
export let csvDelayBetweenPreset;
export let sequenceName;
export let startSequence;
export let stopSequence;
export let saveSequenceAsScenario;
export let undoAction;
export let redoAction;
export let actionCount;
export let conditionWrapper;
export let conditionType;
export let conditionExpectedValue;
export let conditionExpectedValueWrapper;
export let conditionSkipCount;

export function initDom() {
  actionsEl = document.getElementById("actions");
  // Announce list updates to screen readers
  if (actionsEl) {
    actionsEl.setAttribute("aria-live", "polite");
    actionsEl.setAttribute("aria-label", "Recorded action list");
  }
  activationStatus = document.getElementById("activationStatus");
  activateTab = document.getElementById("activateTab");
  deactivateTab = document.getElementById("deactivateTab");
  scenarioSearch = document.getElementById("scenarioSearch");
  scenarioSort = document.getElementById("scenarioSort");
  duplicateScenarioBtn = document.getElementById("duplicateScenario");
  scenarioFolder = document.getElementById("scenarioFolder");
  createFolderBtn = document.getElementById("createFolder");
  filterFolder = document.getElementById("filterFolder");
  moveToFolderSelect = document.getElementById("moveToFolderSelect");
  doMoveToFolder = document.getElementById("doMoveToFolder");
  manageFoldersCard = document.getElementById("manageFoldersCard");
  newFolderInput = document.getElementById("newFolderInput");
  createFolderAction = document.getElementById("createFolderAction");
  foldersList = document.getElementById("foldersList");
  scenarioList = document.getElementById("scenarioList");
  sequenceScenarioList = document.getElementById("sequenceScenarioList");
  preview = document.getElementById("preview");
  startRecord = document.getElementById("startRecord");
  stopRecord = document.getElementById("stopRecord");
  manualSelector = document.getElementById("manualSelector");
  selectorType = document.getElementById("selectorType");
  pickedSelectorsInfo = document.getElementById("pickedSelectorsInfo");
  pickedSelectorsWrap = document.getElementById("pickedSelectorsWrap");
  // Hide on startup — will be shown later if there are picked selectors
  if (pickedSelectorsWrap && !manualSelector?.value?.trim()) {
    pickedSelectorsWrap.style.display = "none";
  }
  // Clear pick-done badge only — do not clobber playback badges (CSV/▶/REC/SEQ)
  chrome.action.getBadgeText({}, (text) => {
    if (text === "✓") chrome.action.setBadgeText({ text: "" });
  });
  manualActionType = document.getElementById("manualActionType");
  manualValue = document.getElementById("manualValue");
  manualDelay = document.getElementById("manualDelay");
  addManualAction = document.getElementById("addManualAction");
  cancelEdit = document.getElementById("cancelEdit");
  pickElement = document.getElementById("pickElement");
  newFlow = document.getElementById("newFlow");
  saveFlow = document.getElementById("saveFlow");
  scenarioName = document.getElementById("scenarioName");
  autoSaveNotice = document.getElementById("autoSaveNotice");
  renameScenario = document.getElementById("renameScenario");
  renameInput = document.getElementById("renameInput");
  deleteScenario = document.getElementById("deleteScenario");
  exportScenario = document.getElementById("exportScenario");
  exportScenarioSelect = document.getElementById("exportScenarioSelect");
  exportFolder = document.getElementById("exportFolder");
  exportFolderSelect = document.getElementById("exportFolderSelect");
  importFile = document.getElementById("importFile");
  importScenario = document.getElementById("importScenario");
  playScenario = document.getElementById("playScenario");
  stopPlay = document.getElementById("stopPlay");
  delayAfterScenario = document.getElementById("delayAfterScenario");
  delayPreset = document.getElementById("delayPreset");
  addToRunList = document.getElementById("addToRunList");
  runListDisplay = document.getElementById("runListDisplay");
  csvDelayBetweenPreset = document.getElementById("csvDelayBetweenPreset");
  sequenceName = document.getElementById("sequenceName");
  startSequence = document.getElementById("startSequence");
  stopSequence = document.getElementById("stopSequence");
  saveSequenceAsScenario = document.getElementById("saveSequenceAsScenario");
  // (Compact mode was removed — the tab-based UI replaced it. Its elements lived in
  //  a display:none block in popup.html purely to keep this file's queries alive.)

  // Undo/Redo elements
  undoAction = document.getElementById("undoAction");
  redoAction = document.getElementById("redoAction");
  // v2 elements
  actionCount = document.getElementById("actionCount");
  // Condition elements
  conditionWrapper = document.getElementById("conditionWrapper");
  conditionType = document.getElementById("conditionType");
  conditionExpectedValue = document.getElementById("conditionExpectedValue");
  conditionExpectedValueWrapper = document.getElementById("conditionExpectedValueWrapper");
  conditionSkipCount = document.getElementById("conditionSkipCount");
}
