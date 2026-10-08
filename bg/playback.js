/**
 * playback.js — playing scenarios: playActionsOnTab (the loop over the actions),
 * single runs, resume from a checkpoint, sequences, CSV runs.
 *
 * Each action type is a step in bg/playback/steps/; the keep-alive is
 * bg/playback/keepalive.js, a failed action's prompt bg/playback/failure-prompt.js.
 */

import { state, persistCsvState, clearCsvState } from './state.js';
import { getScenarios, getVariables } from './storage.js';
import { updateBadge } from './badge.js';
import { sendCompletionNotification, sendAlertNotification } from './notify.js';
import { resolveRandomVars, interpolateAction } from './interpolate.js';
import { getActiveTabId } from './tabs.js';
// The steps load bg/screenshot.js, whose listeners have always registered at this point.
import { STEPS, runOnPage, STOP } from './playback/steps/index.js';
import { ssWrite, ssClear, csvResultWrite, csvResultClear } from './idb-screenshots.js';
import { beginDbGuard, endDbGuard } from './dbguard.js';
import { anyBlocks, getSwitchLayout, hasBlock, blockEnd, continueIndex, resumeSegments } from '../shared/switch-blocks.js';
import { normalizeVarName, normalizeVarRef, selectorStrings, writtenVarNames } from '../shared/var-name.js';
import { pickStrings } from '../shared/dropdown-pick.js';
import { CHILD_COND_KEYS } from '../shared/child-cond.js';
import { isAnyPlaybackActive, runClaimed } from './run-state.js';
import { startKeepalive, stopKeepalive } from './playback/keepalive.js';
import { notifyActionFailed, onActionFailed, FAIL_RETRY, FAIL_STOP } from './playback/failure-prompt.js';
import { closeOpenSessions } from './cdp/session.js';

/* ── Concurrency Guard ──────────────────────────────────────────────────────── */

function _notifyAlreadyRunning() {
  chrome.runtime.sendMessage({ type: 'PLAYBACK_ALREADY_RUNNING' }).catch(() => {});
  sendAlertNotification('⚠ Already Running', 'Playback is already running — stop it first', 'already_running');
}

/* ── Recording ⇄ Playback mutual exclusion ──────────────────────────────────────
 * Recording and playback drive the same tab, and the recorder cannot tell a
 * synthesized event from a human one. Whichever mode started first wins; the
 * second request is refused rather than queued, because the two cannot be
 * interleaved without corrupting the scenario being recorded.
 *
 * Both refusals notify as well as return, because most callers cannot surface a
 * rejection themselves: the popup closes its own window right after dispatching,
 * the hotkey path in content.js sends without a callback, and scheduled playback
 * fires from an alarm with no response channel at all.
 * ────────────────────────────────────────────────────────────────────────────── */

/**
 * Refuse to start playback while a recording is in progress. Called from every
 * playback entry point, not just the message router, so the scheduled-alarm path
 * is covered too.
 *
 * @returns {boolean} true if the request was refused — the caller must return.
 */
export function refuseIfRecording() {
  if (!state.recording) return false;
  chrome.runtime.sendMessage({ type: 'PLAYBACK_BLOCKED_RECORDING' }).catch(() => {});
  sendAlertNotification(
    '⚠ Recording Active',
    'Cannot start playback while recording — stop recording first',
    'blocked_recording',
  );
  return true;
}

/**
 * Refuse to start recording while any playback is running — the mirror of
 * refuseIfRecording(). Lives in this module because it owns the playback-active
 * state; the START_RECORD handler calls it.
 *
 * @returns {boolean} true if the request was refused — the caller must return.
 */
export function refuseRecordingIfPlaying() {
  if (!isAnyPlaybackActive()) return false;
  chrome.runtime.sendMessage({ type: 'RECORD_BLOCKED_PLAYBACK' }).catch(() => {});
  sendAlertNotification(
    '⚠ Playback Active',
    'Cannot start recording while playback is running — stop it first',
    'blocked_playback',
  );
  return true;
}

/** " — n action(s) failed", or nothing at all for a clean run. */
function _failSuffix(failedActions) {
  const n = failedActions?.length || 0;
  return n ? ` — ${n} action${n === 1 ? '' : 's'} failed` : '';
}

/* ── Screenshot settings cache ──────────────────────────────────────────────── */

// Cached per playback run so repeated screenshot actions don't each issue a
// storage read.  Reset at the start of each public entry point.
let _ssSettings = null;

async function _getSsSettings() {
  if (!_ssSettings) {
    _ssSettings = await new Promise(r => chrome.storage.sync.get(['screenshotSaveMode', 'screenshotPrefix'], r));
  }
  return _ssSettings;
}

/* ── Playback Core ──────────────────────────────────────────────────────────── */

/**
 * The checkpoint the popup offers to resume from (startPlaybackFromCheckpoint).
 * Inside another scenario a Switch went into, actionIndex stays on that Switch
 * and `nested` says where in the other scenario(s) the run is.
 */
function _saveCheckpoint(frames, tabId) {
  if (!state.playback.scenarioId) return;
  const [root, ...nested] = frames;
  chrome.storage.local.set({
    playbackCheckpoint: {
      scenarioId: state.playback.scenarioId,
      actionIndex: root.actionIndex, tabId,
      timestamp: Date.now(),
      ...(nested.length ? { nested: nested.map((f) => ({ ...f })) } : {}),
    },
  });
}

/**
 * Play `actions` from `startFromIndex`. `endAtIndex` (0-based, inclusive) stops
 * the run early — a Switch block case plays only its own range this way, then
 * the caller moves on to the block's continueAt (see shared/switch-blocks.js).
 */
export async function playActionsOnTab(tabId, actions, {
  vars = null, screenshotsResult = null, forceAutoSave = false, skipDownload = false,
  startFromIndex = 0, failedActions = null, depth = 0, endAtIndex = null, frames = null,
} = {}) {
  if (depth > 10) {
    console.error('[PLAYBACK] Max switch/nested-scenario depth (10) exceeded — aborting branch');
    notifyActionFailed(startFromIndex, null, 'Max nested scenario depth exceeded (possible infinite loop in switch)');
    return vars || {};
  }

  const resolvedVars = resolveRandomVars(vars !== null ? vars : await getVariables());

  // Where the run is, for the checkpoint: the scenario it started from, then each
  // other scenario a Switch case went into, innermost last. A block case plays
  // in its own scenario, so it shares its caller's frames.
  const _frames = frames || [{ actionIndex: startFromIndex }];
  const _frame = _frames[_frames.length - 1];

  // The run, as every step sees it (bg/playback/steps/). tabClosed and selfJumps
  // (Switch → "this scenario" hops taken in this run) change as it goes.
  const ctx = {
    tabId, actions, resolvedVars, screenshotsResult, forceAutoSave, skipDownload,
    tabClosed: false, selfJumps: 0,
  };
  const _onTabRemoved = (removedTabId) => {
    if (removedTabId === tabId) { ctx.tabClosed = true; state.playback.active = false; }
  };
  chrome.tabs.onRemoved.addListener(_onTabRemoved);

  // Only scenarios that use Switch blocks pay for the layout; without one every
  // Switch and Condition step takes exactly its old path.
  const _layout = anyBlocks(actions) ? getSwitchLayout(actions) : null;
  const _last = endAtIndex == null
    ? actions.length - 1
    : Math.min(endAtIndex, actions.length - 1);

  // Pauses on the in-page prompt. Each call site steps i back on FAIL_RETRY and
  // stops the run on FAIL_STOP; FAIL_SKIP falls through to the action's usual tail.
  const fail = (i, action, reason, record) =>
    onActionFailed({ tabId, i, actions, action, reason, failedActions, record });

  // Sticky fallback resolution: if the content script resolved a {fallback:...}
  // variable, persist the winning value into resolvedVars so every subsequent
  // action in this run uses the same value (not A→B→C again from scratch).
  const _stickFallbacks = (result) => {
    if (!result?.resolvedFallbacks || typeof result.resolvedFallbacks !== 'object') return;
    for (const [spec, resolvedVal] of Object.entries(result.resolvedFallbacks)) {
      for (const varName of Object.keys(resolvedVars)) {
        if (resolvedVars[varName] === spec) resolvedVars[varName] = resolvedVal;
      }
    }
  };

  Object.assign(ctx, {
    layout: _layout, fail, stickFallbacks: _stickFallbacks, getSsSettings: _getSsSettings,
    // A Switch case played as a run of its own, one level deeper. It shares this
    // run's screenshots, save options and failure list; its variables are a copy.
    // `scenarioId`: the case plays another scenario (a new checkpoint frame).
    playNested: (acts, nestedVars, start, end, scenarioId = null) => playActionsOnTab(tabId, acts, {
      vars: nestedVars, screenshotsResult, forceAutoSave, skipDownload, startFromIndex: start,
      failedActions, depth: depth + 1, endAtIndex: end,
      frames: scenarioId ? [..._frames, { scenarioId, actionIndex: start, endAtIndex: end }] : _frames,
    }),
  });

  try {
    for (let i = startFromIndex; i <= _last; i++) {
      if (!state.playback.active || ctx.tabClosed) break;

      state.playback.actionIndex = i;
      updateBadge();

      // Persist a checkpoint after every action so the popup can offer resume
      // if the tab reloads mid-playback (e.g. from a navigate action).
      _frame.actionIndex = i;
      _saveCheckpoint(_frames, tabId);

      try {
        const action = interpolateAction(actions[i], resolvedVars);
        if (action.disabled) {
          // A disabled block Switch takes its block with it; a disabled Switch
          // without one still lets playback run on into the next action as before.
          if (_layout && hasBlock(action)) i = blockEnd(actions, i);
          continue;
        }

        // Each action type is a step in bg/playback/steps/; any other is played by
        // the content script.
        const step = STEPS.get(action.type) || runOnPage;
        const next = await step(ctx, i, action);
        if (next === STOP) break;
        i = next;
      } catch (err) {
        console.error(`[PLAYBACK] Action ${i} failed:`, err);
        const next = await fail(i, actions[i], err?.message || null, err?.message || 'unknown error');
        if (next === FAIL_RETRY) { i--; continue; }
        if (next === FAIL_STOP) break;
      }
    }
  } finally {
    chrome.tabs.onRemoved.removeListener(_onTabRemoved);
    if (ctx.tabClosed) {
      chrome.runtime.sendMessage({ type: 'PLAYBACK_TAB_CLOSED', tabId }).catch(() => {});
      sendAlertNotification('⚠ Playback Stopped', 'Tab was closed — playback stopped', 'tab_closed');
    }
  }
  return resolvedVars;
}

/* ── Single Scenario Playback ───────────────────────────────────────────────── */

/**
 * Resume a scenario from a saved checkpoint after a tab reload mid-playback.
 * `fromIndex` is the checkpoint's actionIndex + 1; `nested` its other scenarios
 * a Switch went into, when the run was inside one.
 */
export async function startPlaybackFromCheckpoint(scenarioId, fromIndex, tabId, nested = null) {
  if (refuseIfRecording()) return;
  // Guard: never start a checkpoint resume while CSV (or any other) playback is
  // active.  CSV has its own per-row resume path; running startPlaybackFromCheckpoint
  // on top of an active CSV run would bypass forceAutoSave/skipDownload and cause
  // screenshot save-as dialogs instead of accumulating results for the zip.
  if (!(await runClaimed(() => _resumeScenario(scenarioId, fromIndex, tabId, nested)))) _notifyAlreadyRunning();
}

// Where playback goes on once the Switch at `i` has played another scenario:
// the next action, or a block Switch's continueAt (as steps/switch.js does).
function _afterSwitch(actions, i) {
  return hasBlock(actions[i]) ? continueIndex(actions, i) : i + 1;
}

/**
 * Resume inside the other scenarios a Switch went into (`nested`, innermost
 * last): the innermost from the action after its checkpoint, then each outer
 * one after the Switch that entered the next. Variables carry over.
 */
async function _resumeNested(tabId, scenarios, rootSwitchIdx, nested, failedActions) {
  let vars = null;
  for (let k = nested.length - 1; k >= 0; k--) {
    const { scenarioId, actionIndex, endAtIndex = null } = nested[k];
    const acts = scenarios[scenarioId]?.actions;
    if (!acts?.length) continue;
    const from = k === nested.length - 1 ? actionIndex + 1 : _afterSwitch(acts, actionIndex);
    const outer = [{ actionIndex: rootSwitchIdx }, ...nested.slice(0, k).map((f) => ({ ...f }))];
    for (const seg of resumeSegments(acts, from)) {
      const end = endAtIndex == null ? seg.end : Math.min(seg.end ?? endAtIndex, endAtIndex);
      if (!state.playback.active || seg.start >= acts.length || (end != null && seg.start > end)) break;
      vars = await playActionsOnTab(tabId, acts, {
        vars, screenshotsResult: null, forceAutoSave: false, skipDownload: false,
        startFromIndex: seg.start, failedActions, depth: k + 1, endAtIndex: end,
        frames: [...outer, { scenarioId, actionIndex: seg.start, endAtIndex }],
      });
    }
  }
  return vars;
}

async function _resumeScenario(scenarioId, fromIndex, tabId, nested) {
  _ssSettings = null; // read again, like every other entry point: they may have changed since
  const scenarios = await getScenarios();
  const scenario  = scenarios[scenarioId];
  if (!scenario) return;
  const actions = scenario.actions || [];
  state.playback = {
    active: true, tabId, scenarioId, scenarioName: scenario.name || scenarioId,
    originalScenarioName: scenario.name || scenarioId,
    actionIndex: fromIndex, totalActions: actions.length, loopCurrent: 1, loopTotal: 1,
  };
  updateBadge();
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  await startKeepalive();
  // Collected so the completion notification can say whether "finished" means
  // "finished cleanly". Sequence and CSV runs already reported their failure
  // counts; single and resumed runs claimed success no matter how many actions
  // had failed along the way — playback does not stop at the first one.
  const failedActions = [];
  try {
    // Resuming inside a Switch block case: finish that case, then go on at the
    // block's continueAt (and each enclosing block's) rather than running the
    // other cases. Without blocks this is a single segment from fromIndex.
    let vars = null;
    // Stopped inside another scenario a Switch went into: finish that first,
    // then go on here where the Switch (at the checkpoint's actionIndex) would.
    if (nested?.length) {
      vars = await _resumeNested(tabId, scenarios, fromIndex - 1, nested, failedActions);
      fromIndex = _afterSwitch(actions, fromIndex - 1);
    }
    for (const seg of resumeSegments(actions, fromIndex)) {
      if (!state.playback.active || seg.start >= actions.length) break;
      vars = await playActionsOnTab(tabId, actions, {
        vars, screenshotsResult: null, forceAutoSave: false, skipDownload: false,
        startFromIndex: seg.start, failedActions, depth: 0, endAtIndex: seg.end,
      });
    }
  } finally {
    await stopKeepalive();
    await closeOpenSessions();
    chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
    state.playback.active = false;
    updateBadge();
    chrome.storage.local.remove('playbackCheckpoint');
    await sendCompletionNotification(
      'Playback complete',
      `"${scenario.name}" resumed & finished${_failSuffix(failedActions)}`,
    );
  }
}

/** `tabId`: play on that tab (a scheduled run's own); otherwise on the active tab. */
export async function startPlayback(scenarioId, loopCount = 1, loopDelay = 0, tabId = null) {
  if (refuseIfRecording()) return;
  if (!(await runClaimed(() => _playScenario(scenarioId, loopCount, loopDelay, tabId)))) _notifyAlreadyRunning();
}

async function _playScenario(scenarioId, loopCount, loopDelay, givenTabId) {
  _ssSettings = null; // reset screenshot settings cache for this run

  const scenarios = await getScenarios();
  const scenario  = scenarios[scenarioId];
  if (!scenario) return;

  const tabId = givenTabId ?? await getActiveTabId();
  if (!tabId) {
    chrome.runtime.sendMessage({ type: 'PLAYBACK_NO_TAB' }).catch(() => {});
    sendAlertNotification('⚠ No Active Tab', 'No active tab found — open a tab and try again', 'no_tab');
    return;
  }

  // Wrapped in a DB test session when that is switched on — see bg/dbguard.js.
  const dbGuard = await beginDbGuard(scenario.name || scenarioId);
  if (dbGuard && dbGuard.refused) return;

  const actions = scenario.actions || [];
  const loops   = Math.max(1, Math.floor(loopCount));
  state.playback = {
    active: true, tabId, scenarioId, scenarioName: scenario.name || scenarioId,
    originalScenarioName: scenario.name || scenarioId,
    actionIndex: 0, totalActions: actions.length, loopCurrent: 1, loopTotal: loops,
  };
  updateBadge();
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  await startKeepalive();

  // Accumulates across every loop iteration, so a 10-loop run reports the total.
  const failedActions = [];
  try {
    // Pass resolved vars from one loop to the next so readdom variables
    // accumulate across loop iterations.
    let loopVars = null;
    for (let loop = 0; loop < loops; loop++) {
      if (!state.playback.active) break;
      state.playback.loopCurrent = loop + 1;
      state.playback.actionIndex = 0;
      updateBadge();
      loopVars = await playActionsOnTab(tabId, actions, {
        vars: loopVars, screenshotsResult: null, forceAutoSave: false, skipDownload: false,
        startFromIndex: 0, failedActions,
      });
      if (loop < loops - 1 && loopDelay > 0) await new Promise(r => setTimeout(r, loopDelay));
    }
  } finally {
    await stopKeepalive();
    await closeOpenSessions();
    chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
    state.playback.active = false;
    updateBadge();
    chrome.storage.local.remove('playbackCheckpoint');
    await sendCompletionNotification(
      'Playback complete',
      `"${scenario.name}" finished${loops > 1 ? ` (${loops} loops)` : ''}${_failSuffix(failedActions)}`,
    );
    await endDbGuard(dbGuard);
  }
}

/* ── Sequence Playback ──────────────────────────────────────────────────────── */

export async function startSequence(runList) {
  if (refuseIfRecording()) return;
  if (!(await runClaimed(() => _playSequence(runList)))) _notifyAlreadyRunning();
}

async function _playSequence(runList) {
  _ssSettings = null;

  state.sequencePlayback = { active: true, runList, currentIndex: 0 };
  updateBadge();
  const tabId = await getActiveTabId();
  if (!tabId) {
    state.sequencePlayback.active = false;
    updateBadge();
    chrome.runtime.sendMessage({ type: 'PLAYBACK_NO_TAB' }).catch(() => {});
    sendAlertNotification('⚠ No Active Tab', 'No active tab found — open a tab and try again', 'no_tab');
    return;
  }

  const scenarios = await getScenarios();

  const dbGuard = await beginDbGuard(`Sequence · ${runList.length}`);
  if (dbGuard && dbGuard.refused) {
    state.sequencePlayback.active = false;
    updateBadge();
    return;
  }

  let _seqTabClosed = false;
  const _onSeqTabRemoved = (removedId) => {
    if (removedId === tabId) { _seqTabClosed = true; state.sequencePlayback.active = false; }
  };
  chrome.tabs.onRemoved.addListener(_onSeqTabRemoved);
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  await startKeepalive();

  let _seqCompleted = 0, _seqFailed = 0;

  try {
    for (let i = 0; i < runList.length; i++) {
      if (!state.sequencePlayback.active || _seqTabClosed) break;
      state.sequencePlayback.currentIndex = i;
      updateBadge();

      const item     = runList[i];
      if (item.disabled) continue;
      const scenario = scenarios[item.id];
      if (!scenario) continue;

      const actions = scenario.actions || [];
      state.playback = {
        active: true, tabId, scenarioId: item.id,
        scenarioName: scenario.name || item.id,
        originalScenarioName: scenario.name || item.id,
        actionIndex: 0, totalActions: actions.length,
      };
      const _seqItemFailed = [];
      await playActionsOnTab(tabId, actions, {
        vars: null, screenshotsResult: null, forceAutoSave: false, skipDownload: false,
        startFromIndex: 0, failedActions: _seqItemFailed,
      });
      state.playback.active = false;
      _seqCompleted++;
      if (_seqItemFailed.length > 0) _seqFailed++;

      if (i < runList.length - 1 && item.delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, item.delay));
      }
    }
    if (_seqTabClosed) {
      chrome.runtime.sendMessage({ type: 'PLAYBACK_TAB_CLOSED', tabId }).catch(() => {});
      sendAlertNotification('⚠ Sequence Stopped', 'Tab was closed — sequence playback stopped', 'tab_closed');
    } else {
      const _seqMsg = _seqFailed > 0
        ? `${_seqCompleted - _seqFailed} ✓ · ${_seqFailed} ✗ of ${_seqCompleted} scenarios`
        : `${_seqCompleted} scenario(s) done`;
      await sendCompletionNotification('Sequence complete', _seqMsg);
    }
  } catch (err) {
    console.error('[SEQUENCE] Error during sequence playback:', err);
  } finally {
    chrome.tabs.onRemoved.removeListener(_onSeqTabRemoved);
    await stopKeepalive();
    await closeOpenSessions();
    chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
    state.sequencePlayback.active = false;
    state.playback.active = false;
    updateBadge();
    await endDbGuard(dbGuard);
  }
}

/* ── CSV Playback ───────────────────────────────────────────────────────────── */

/**
 * Variable names a scenario actually touches. Only these are kept in the per-row
 * IndexedDB record, which is what the CSV/XLSX/HTML export turns into columns.
 *
 * The field list must stay in step with interpolateAction() in bg/interpolate.js
 * (selectors, targetSelectors and attrName included) — a
 * field that gets variables substituted but is not scanned here silently loses
 * its column. folderPath, fileName, fileNames and the idContains/classContains
 * conditions were missing, so a scenario uploading `${docFolder}/${invoiceFile}`
 * ran correctly but exported neither value.
 */
function collectRelevantKeys(actions) {
  const keys   = new Set();
  const VAR_RE = /\$\{([^}]+)\}/g;
  const FIELDS = [
    'selector', 'value', 'url', 'code', 'expectedValue',
    'folderPath', 'fileName',
  ];

  const scan = (v) => {
    if (typeof v !== 'string') return;
    let m; VAR_RE.lastIndex = 0;
    while ((m = VAR_RE.exec(v)) !== null) keys.add(m[1]);
  };

  for (const a of actions) {
    for (const f of FIELDS) scan(a[f]);
    // A bare Switch name reads `${name}` at run time — see normalizeVarRef.
    scan(normalizeVarRef(a.switchVar));
    selectorStrings(a).forEach(scan);
    scan(a.attrName);
    if (Array.isArray(a.fileNames)) a.fileNames.forEach(scan);
    pickStrings(a).forEach(scan);
    if (a.conditions && typeof a.conditions === 'object') {
      for (const f of CHILD_COND_KEYS) scan(a.conditions[f]);
    }
    // readdom and screenshot_tovar produce variables that are also "relevant".
    for (const vn of writtenVarNames(a)) keys.add(vn);
  }
  return keys;
}

// Results go to IndexedDB one row at a time (O(1)/row vs the previous O(n²) array-rewrite approach).
export async function startCsvPlayback(scenarioId, rows, delayBetween, exportFormat = 'csv', startRowIndex = 0) {
  if (refuseIfRecording()) return;
  if (!(await runClaimed(() => _playCsv(scenarioId, rows, delayBetween, exportFormat, startRowIndex)))) _notifyAlreadyRunning();
}

async function _playCsv(scenarioId, rows, delayBetween, exportFormat, startRowIndex) {
  _ssSettings = null;

  // xlsx/html/zip formats post-process screenshots client-side — skip downloading
  // individual files during the run to avoid the browser download dialog.
  const skipDownload = exportFormat === 'xlsx' || exportFormat === 'html' || exportFormat === 'zip';
  // A run picking up from a checkpoint must keep everything the earlier rows wrote.
  const isResume = startRowIndex > 0;
  state.csvPlayback = {
    active: true, rows, currentRow: startRowIndex, scenarioId, delayBetween,
    stopAfterRow: false,
  };
  state.csvInterrupted = null;
  updateBadge();

  let tabId         = null;
  let scenario      = null;
  let completedRows = 0;
  let failedRows    = 0;
  let runError      = null;
  let keepaliveOn   = false;
  let dbGuard       = null;

  // The whole run lives inside try/catch/finally, matching startPlayback and
  // startSequence. A throw anywhere — an IndexedDB quota error while writing a
  // row, a rejected CDP command, a tab closing mid-action — otherwise leaves
  // csvPlayback.active stuck true: the keep-alive alarm then re-arms itself every
  // 20 s for the life of the worker, and every later Play is refused with
  // "already running" for a run that is not running. The only escape was
  // disabling the extension.
  try {
    // Rows are not re-saved here: the popup wrote them to csvSessionData before
    // dispatching START_CSV_PLAYBACK, and restoreCsvState() reads that record.
    await persistCsvState(scenarioId, startRowIndex, delayBetween, exportFormat);

    const [scenarios, baseVars] = await Promise.all([getScenarios(), getVariables()]);
    scenario = scenarios[scenarioId];
    if (!scenario) return;

    tabId = await getActiveTabId();
    if (!tabId) {
      chrome.runtime.sendMessage({ type: 'PLAYBACK_NO_TAB' }).catch(() => {});
      sendAlertNotification('⚠ No Active Tab', 'No active tab found — open a tab and try again', 'no_tab');
      return;
    }

    dbGuard = await beginDbGuard(`${scenario.name || scenarioId} · CSV`);
    if (dbGuard && dbGuard.refused) return;

    const actions      = scenario.actions || [];
    const relevantKeys = collectRelevantKeys(actions);

    // Collect screenshot varNames in action order, including nested scenarios
    // reached via Switch, so XLSX/HTML column headers match the full action sequence.
    function _collectSsVars(acts, visited) {
      const out = [];
      for (const a of acts) {
        const vn = a.type === 'screenshot_tovar' ? normalizeVarName(a.varName) : null;
        if (vn && !visited.has('var:' + vn)) {
          visited.add('var:' + vn);
          out.push(vn);
        }
        if (a.type === 'switch' && a.cases) {
          for (const c of a.cases) {
            if (c.scenarioId && !visited.has('sc:' + c.scenarioId)) {
              visited.add('sc:' + c.scenarioId);
              const nested = scenarios[c.scenarioId];
              if (nested?.actions) out.push(..._collectSsVars(nested.actions, visited));
            }
          }
        }
      }
      return out;
    }
    const ssVarOrder = _collectSsVars(actions, new Set(['sc:' + scenarioId]));
    chrome.storage.local.set({ csvSsVarOrder: ssVarOrder });

    // Clear the previous run's results and screenshots — a fresh run must never
    // show stale data from the prior one.
    //
    // Skipped on resume. startRowIndex > 0 means rows 0..startRowIndex-1 already
    // ran and their results are the entire point of resuming; clearing here wiped
    // them, so a run resumed at row 120 of 200 exported only the last 80 rows.
    if (!isResume) {
      await Promise.all([
        new Promise(r => chrome.storage.local.remove('csvRunResults', r)),
        ssClear(),
        csvResultClear(),
      ]);
    }
    // Always dropped: a leftover single-scenario checkpoint would trigger a false
    // OFFER_RESUME on top of the CSV run.
    await new Promise(r => chrome.storage.local.remove('playbackCheckpoint', r));

    chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
    await startKeepalive();
    keepaliveOn = true;

    for (let i = startRowIndex; i < rows.length; i++) {
      if (!state.csvPlayback.active) break;
      state.csvPlayback.currentRow = i;
      updateBadge();

      await persistCsvState(scenarioId, i, delayBetween, exportFormat);

      // Merge base variables with row data; CSV columns override base vars when
      // names collide so per-row data always takes precedence.
      const rowVars = { ...baseVars, ...rows[i] };
      state.playback = {
        active: true, tabId, scenarioId,
        scenarioName: scenario.name || scenarioId,
        originalScenarioName: scenario.name || scenarioId,
        actionIndex: 0, totalActions: actions.length,
      };
      const screenshotsResult = {};
      const failedActions     = [];
      const finalVars = await playActionsOnTab(
        tabId, actions, {
          vars: rowVars, screenshotsResult, forceAutoSave: true, skipDownload, startFromIndex: 0,
          failedActions,
        },
      );
      state.playback.active = false;

      completedRows++;
      if (failedActions.length > 0) failedRows++;

      // Only store variables that are actually referenced by the scenario to
      // keep IDB records lean.
      // Screenshot vars are placed last in action-capture order so that XLSX/HTML
      // column headers match the scenario's action sequence rather than the order
      // the vars were defined (CSV column order or baseVars order).
      const filteredVarsRaw = Object.fromEntries(
        Object.entries(finalVars).filter(([k]) => relevantKeys.has(k)),
      );
      const ssKeys = new Set(Object.keys(screenshotsResult));
      const filteredVars = {};
      for (const [k, v] of Object.entries(filteredVarsRaw)) {
        if (!ssKeys.has(k)) filteredVars[k] = v;
      }
      for (const k of Object.keys(screenshotsResult)) {
        if (k in filteredVarsRaw) filteredVars[k] = filteredVarsRaw[k];
      }

      await csvResultWrite(i, { rowIndex: i, vars: filteredVars, failures: failedActions });

      for (const [vn, b64] of Object.entries(screenshotsResult)) {
        await ssWrite(i, vn, b64);
      }

      // "Stop after this row" was requested while this row was running. The row
      // is complete and its result is written, so leaving now is the graceful
      // exit the button promises — as opposed to STOP_CSV_PLAYBACK, which clears
      // `active` and abandons the row mid-action.
      const gracefulStop = state.csvPlayback.stopAfterRow === true;
      const isLast = gracefulStop || i === rows.length - 1;
      chrome.runtime.sendMessage({
        type: 'CSV_ROW_DONE', rowIndex: i, total: rows.length,
        failRows: failedRows, isLast, delayBetween,
      }).catch(() => {});

      if (gracefulStop) break;

      if (!isLast && delayBetween > 0) {
        await new Promise((r) => setTimeout(r, delayBetween));
      }
    }
  } catch (err) {
    runError = err;
    console.error('[CSV] Run aborted by an unexpected error:', err);
  } finally {
    if (keepaliveOn) stopKeepalive();
    await closeOpenSessions();
    if (tabId != null) chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
    state.csvPlayback.active = false;
    state.playback.active    = false;
    await Promise.all([
      clearCsvState(),
      new Promise(r => chrome.storage.local.remove('playbackCheckpoint', r)),
    ]).catch(() => {});
    updateBadge();
    await endDbGuard(dbGuard);
  }

  // Report the crash rather than letting the run end in silence. Results written
  // before the throw stay in IndexedDB, so the export button still works.
  if (runError) {
    const msg = runError?.message || String(runError);
    sendAlertNotification('⚠ CSV Run Failed', `Stopped after ${completedRows} row(s): ${msg}`, 'csv_error');
    chrome.runtime.sendMessage({
      type: 'CSV_RUN_ERROR', error: msg, total: completedRows, failRows: failedRows,
    }).catch(() => {});
    return;
  }

  // Nothing ran: missing scenario or no eligible tab, both already reported above.
  if (!scenario || tabId == null) return;

  const _csvMsg = failedRows > 0
    ? `${completedRows - failedRows} ✓ · ${failedRows} ✗ of ${completedRows} rows — "${scenario.name}"`
    : `${completedRows} rows done — "${scenario.name}"`;
  await sendCompletionNotification('CSV Run complete', _csvMsg);
  chrome.runtime.sendMessage({
    type: 'CSV_RUN_DONE',
    total: completedRows,
    failRows: failedRows,
    scenarioName: scenario.name || scenarioId,
  }).catch(() => {});
}
