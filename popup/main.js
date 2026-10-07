// popup/main.js — the Record & Play and Data tabs.
//
// This was one initMain() closure; its parts now live in popup/{record,scenarios,
// run,csv,help,ui}/ and a few files beside this one. Shared mutable state of
// those parts is popup/ui-state.js. initMain() still runs everything in the
// original order, after the DOM is ready.

import { initHelpModals } from './help/help-modals.js';
import { initDom } from './dom.js';
import { initFormFields } from './record/form-fields.js';
import { initSwitchCaseBuilder } from './record/switch-case-builder.js';
import { initCollapsible } from './ui/collapsible.js';
import { initNotices } from './notices.js';
import { initCsvListeners } from './csv/csv-listeners.js';
import { initResumeBanners } from './run/resume-banners.js';
import { initPickedSelectors } from './record/picked-selectors.js';
import { initSelectorTypeMenus } from './record/selector-type-menu.js';
import { initPicker } from './record/picker.js';
import { initTabActivation } from './tab-activation.js';
import { initRecorder } from './record/recorder.js';
import { initUndoRedo } from './record/undo-redo.js';
import { initPreview } from './record/preview.js';
import { initValueMemory } from './record/value-memory.js';
import { initActionForm } from './record/action-form.js';
import { initDraft } from './record/draft.js';
import { initVarSuggestions } from './record/var-suggestions.js';
import { initSave } from './scenarios/save.js';
import { initScenarioList } from './scenarios/scenario-list.js';
import { initFolders } from './scenarios/folders.js';
import { initScenarioActions } from './scenarios/scenario-actions.js';
import { initImportExport } from './scenarios/import-export.js';
import { initBackupRestore } from './scenarios/backup-restore.js';
import { initPlaybackControls } from './run/playback-controls.js';
import { initSchedule } from './run/schedule.js';
import { initTimePicker } from './run/time-picker.js';
import { initCsvRun } from './csv/csv-run.js';
import { initCsvState } from './csv/csv-state.js';
import { initCsvRestore } from './csv/csv-restore.js';

/* === Init Main === */

/**
 * Run every part of the Record & Play / Data UI in the order the single
 * closure used to: each init registers its listeners and kicks off its reads
 * exactly where that code sat before.
 */
export function initMain() {
  initHelpModals();
  initDom();
  initFormFields();
  initSwitchCaseBuilder();
  initCollapsible();
  initNotices();
  initCsvListeners();
  initResumeBanners();
  initPickedSelectors();
  initSelectorTypeMenus();
  initPicker();
  initTabActivation();
  initRecorder();
  initUndoRedo();
  initPreview();
  initValueMemory();
  initActionForm();
  initDraft();
  initVarSuggestions();
  initSave();
  initScenarioList();
  initFolders();
  initScenarioActions();
  initImportExport();
  initBackupRestore();
  initPlaybackControls();
  initSchedule();
  initTimePicker();
  initCsvRun();
  initCsvState();
  initCsvRestore();
}
