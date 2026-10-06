/**
 * ui-state.js — state of the Record & Play and Data tabs that more than one of
 * their modules writes: caches of scenarios and folders, the action being
 * edited, picked selectors, clipboards, the Switch being built, the run list,
 * the schedule being edited and the CSV run.
 *
 * One object so every module reads and writes the same values (ES module
 * bindings cannot be assigned from outside). Separate from popup/state.js:
 * `connectionCheckInterval` here is this UI's own copy, not
 * state.connectionCheckInterval, which popup/connection.js uses.
 */

export const ui = {
  scenariosCache: {},
  foldersCache: {},
  editing: null,
  dragFromIndex: null,
  // True from an action row's dragstart until its dragend; set by the list's drop.
  _actionDragActive: false,
  _actionDropped: false,
  currentPickedSelectors: null,
  // Frame the picked element lives in (0 = top page). Carried onto the action
  // while the selector is still the picked one, so it plays in that iframe.
  currentPickedFrameId: null,
  currentPickedDragdropTargetSelectors: null,
  actionClipboard: null,
  pickerMode: false,
  // Connection check state
  connectionCheckInterval: null,
  _switchCases: [], // [{ value, scenarioId, scenarioName, startAt?, endAt?, empty? }]
  // continueAt of the Switch in the form: null = automatic (right after its block).
  _switchContinueAt: null,
  // The variable's cases and continueAt, kept while the form is in Always mode,
  // so switching back gets them again. null outside that.
  _switchVarStash: null,
  sequenceClipboard: null, // Copy/paste clipboard for sequence items
  previewRequestId: 0, // Guard against race conditions
  // Sequence scenario execution (run list)
  // - `runList` stores queued scenarios with per-item delay
  // - Inline editor allows per-item delay editing
  runList: [], // Array<{ id, name, delay }>
  editingScheduleId: null,
  csvParsed: null,
  _csvDelayBetween: 500,
  _csvRunScenarioName: "",
};
