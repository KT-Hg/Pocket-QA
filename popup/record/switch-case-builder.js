/**
 * record/switch-case-builder.js — the Switch form: its cases, ranges of this
 * scenario a case runs, Continue at, and validation.
 */

import { CASE_COLORS, SWITCH_SELF, caseRange, continueIndex, getConditionLayout, getSwitchLayout, isBlockCase, validateExternalCase, validateSwitch } from '../../shared/switch-blocks.js';
import { scenarioList } from '../dom.js';
import { ui } from '../ui-state.js';
import { escHtml, showToast } from '../utils.js';
import { debouncedSaveDraft } from './draft.js';
import { setSwitchMode, switchMode } from './form-fields.js';
import { getActionDisplayValue } from './preview.js';

// Index of the case loaded into the case editor, -1 while it describes a new case.
let _switchEditIdx = -1;

// A case targeting SWITCH_SELF (shared/switch-blocks.js) stays in the scenario being
// played: with an end action it owns that block of actions, without one it
// jumps and plays on (the original behaviour).
const SWITCH_SELF_LABEL = "↻ This scenario (jump)";

/* The scenario on screen and its Switch layout. The form lists actions by the
   numbers the preview shows (1.2.1 …), so it reads the list the preview read. */
export let swCtx = { scenarioId: null, actions: [], layout: [], condLayout: [] };

export function setSwitchContext(scenarioId, actions) {
  const list = Array.isArray(actions) ? actions.filter(a => a != null) : [];
  const layout = getSwitchLayout(list);
  swCtx = { scenarioId, actions: list, layout, condLayout: getConditionLayout(list, layout) };
}

/** Reload the scenario the form edits into swCtx, then run `done`. */
export function refreshSwitchContext(done) {
  const scenarioId = ui.editing ? ui.editing.scenarioId : (scenarioList.value || null);
  chrome.runtime.sendMessage({ type: "GET_PREVIEW_ACTIONS", scenarioId }, (res) => {
    setSwitchContext(scenarioId, res?.actions || []);
    done?.();
  });
}

/** Index the Switch in the form has — or will have once added at the end. */
export function switchSelfIdx() {
  return ui.editing && ui.editing.scenarioId === swCtx.scenarioId ? ui.editing.index : swCtx.actions.length;
}

/** The Switch as the form currently describes it. */
function _candidateSwitch() {
  const sw = {
    type: "switch",
    switchVar: document.getElementById("switchVar")?.value?.trim() || "",
    cases: ui._switchCases.map(c => ({ ...c })),
  };
  if (ui._switchContinueAt != null && sw.cases.some(isBlockCase)) sw.continueAt = ui._switchContinueAt;
  return sw;
}

/** The scenario's actions with the form's Switch in place (or appended). */
export function candidateActions(sw = _candidateSwitch()) {
  const list = [...swCtx.actions];
  const self = switchSelfIdx();
  if (self < list.length) list[self] = sw; else list.push(sw);
  return list;
}

/** Display number of action `idx` (0-based), e.g. "1.2.1". */
export function noOf(idx, layout = swCtx.layout) {
  return layout?.[idx]?.displayNo ?? `#${idx + 1}`;
}

/** Layout of another scenario, for the numbers of a case that runs part of it. */
function _layoutOfScenario(id) {
  const acts = ui.scenariosCache?.[id]?.actions;
  return Array.isArray(acts) ? getSwitchLayout(acts) : null;
}

/** " 1.1.1–1.1.2" / " @3" / " (nothing)" — where a case goes, in display numbers. */
export function switchStartSuffix(c, layout = swCtx.layout) {
  if (c.scenarioId === SWITCH_SELF) {
    if (isBlockCase(c)) {
      if (c.empty) return " (nothing)";
      const r = caseRange(c);
      return r.start === r.end
        ? ` ${noOf(r.start, layout)}`
        : ` ${noOf(r.start, layout)}–${noOf(r.end, layout)}`;
    }
    return ` @${noOf((parseInt(c.startAt, 10) || 1) - 1, layout)}`;
  }
  const n = parseInt(c.startAt, 10) || 1;
  const e = parseInt(c.endAt, 10);
  const tl = _layoutOfScenario(c.scenarioId);
  const no = (k) => tl?.[k - 1]?.displayNo ?? `#${k}`;
  if (Number.isFinite(e)) return ` @${no(n)}–${no(e)}`;
  return n > 1 ? ` @${no(n)}` : "";
}

/** Case fields for a target that is another scenario: 1-based start (omitted when 1), optional end. */
function _switchCaseTarget(scenarioId, targetName, startRaw, endRaw) {
  const startAt = Math.max(1, parseInt(startRaw, 10) || 1);
  const endAt   = parseInt(endRaw, 10);
  return {
    scenarioId, scenarioName: targetName,
    ...(startAt > 1 ? { startAt } : {}),
    ...(endAt >= 1 ? { endAt } : {}),
  };
}

/** Case fields for SWITCH_SELF from the From / To dropdowns. */
function _switchSelfTarget(fromVal, toVal) {
  const base = { scenarioId: SWITCH_SELF, scenarioName: SWITCH_SELF_LABEL };
  if (fromVal === "none" || fromVal === "" || fromVal == null) return { ...base, empty: true };
  const startAt = Number(fromVal) + 1;
  if (toVal === "tail") return { ...base, startAt };
  if (toVal === "only" || toVal === "" || toVal == null) return { ...base, startAt, endAt: startAt };
  return { ...base, startAt, endAt: Number(toVal) + 1 };
}

/** Same destination? Used to keep an untouched case byte-for-byte as it was saved. */
function _sameCaseTarget(a, b) {
  const n = (v) => (v == null || v === "" ? null : parseInt(v, 10));
  return a.value === b.value && a.scenarioId === b.scenarioId &&
    n(a.startAt) === n(b.startAt) && n(a.endAt) === n(b.endAt) && !!a.empty === !!b.empty;
}

/** <option>s listing the scenario's actions (display number + summary). */
function _actionOptions(selected, layout, { from = 0, skip = -1 } = {}) {
  const list = candidateActions();
  let html = "";
  for (let i = from; i < list.length; i++) {
    if (i === skip) continue;
    const a = list[i];
    const txt = `${noOf(i, layout)}  ${a.type} ${a.label || getActionDisplayValue(a) || ""}`.slice(0, 60);
    html += `<option value="${i}"${i === selected ? " selected" : ""}>${escHtml(txt)}</option>`;
  }
  return html;
}

/**
 * Fill a From / To dropdown pair for a SWITCH_SELF case. `c` is the case being
 * edited (null for a new one): an old jump case opens on "To the end", a new
 * case on "Only this action".
 */
function _fillRangeSelects(fromEl, toEl, c) {
  const layout = getSwitchLayout(candidateActions());
  const self   = switchSelfIdx();
  let from = "none", to = "only";
  if (c && c.scenarioId === SWITCH_SELF) {
    if (isBlockCase(c)) {
      const r = caseRange(c);
      if (r) { from = r.start; to = r.end === r.start ? "only" : r.end; }
    } else {
      from = (parseInt(c.startAt, 10) || 1) - 1;
      to = "tail";
    }
  } else if (self + 1 < candidateActions().length) {
    from = self + 1;
  }
  let fromHtml = `<option value="none">— nothing —</option>` + _actionOptions(from, layout, { skip: self });
  if (typeof from === "number" && from >= candidateActions().length) {
    fromHtml += `<option value="${from}" selected>#${from + 1} (missing)</option>`;
  }
  fromEl.innerHTML = fromHtml;
  fromEl.value = String(from);

  const renderTo = (want) => {
    const f = fromEl.value;
    if (f === "none" || f === "") { toEl.innerHTML = ""; toEl.disabled = true; return; }
    toEl.disabled = false;
    const fi = Number(f);
    toEl.innerHTML = `<option value="only">Only this action</option>`
      + _actionOptions(-1, layout, { from: fi + 1, skip: self })
      + `<option value="tail">To the end (old-style jump)</option>`;
    toEl.value = [...toEl.options].some(o => o.value === String(want)) ? String(want) : "only";
  };
  renderTo(to);
  fromEl.onchange = () => renderTo(toEl.value || "only");
}

/** "self" (run actions of this scenario) or "other" (play another scenario). */
function _caseMode() {
  return document.querySelector('input[name="switchCaseMode"]:checked')?.value === "other" ? "other" : "self";
}

function _setCaseMode(mode) {
  document.querySelectorAll('input[name="switchCaseMode"]').forEach(r => { r.checked = r.value === mode; });
}

/**
 * Always mode keeps exactly one case — the default, playing another scenario —
 * and edits it in place in the editor's Scenario row. This puts that case in
 * the row; with none yet, the row's scenario becomes the case.
 */
function _loadAlwaysCase() {
  _setCaseMode("other");
  const c = ui._switchCases[0];
  if (!c) { _syncAlwaysCase(); return; }
  const sel = document.getElementById("switchCaseScenario");
  // A deleted scenario is not in the list: nothing is selected, the case stays as saved.
  if (sel) sel.value = [...sel.options].some(o => o.value === c.scenarioId) ? c.scenarioId : "";
  document.getElementById("switchCaseStart").value = parseInt(c.startAt, 10) > 1 ? parseInt(c.startAt, 10) : "";
  const end = parseInt(c.endAt, 10);
  document.getElementById("switchCaseEnd").value = Number.isFinite(end) ? end : "";
}

/** Always mode: the case is what the Scenario row shows. */
function _syncAlwaysCase() {
  const sel = document.getElementById("switchCaseScenario");
  if (!sel?.value) { ui._switchCases = []; return; }
  const old  = ui._switchCases[0];
  const next = {
    value: "__default__",
    ..._switchCaseTarget(sel.value, sel.options[sel.selectedIndex]?.textContent || sel.value,
      document.getElementById("switchCaseStart")?.value, document.getElementById("switchCaseEnd")?.value),
  };
  // Unchanged → keep the saved case as it was (same JSON on save).
  ui._switchCases = [old && _sameCaseTarget(old, next) ? old : next];
  ui._switchContinueAt = null;
}

/** The scenario the form's action belongs to. */
function _formScenarioId() {
  return ui.editing ? ui.editing.scenarioId : (scenarioList.value || null);
}

/** Why the Always Switch in the form cannot be saved, or null. */
export function alwaysSwitchError() {
  if (switchMode() !== "always") return null;
  const c = ui._switchCases[0];
  if (!c) return "Pick the scenario this Switch always plays";
  const own = _formScenarioId();
  if (own && c.scenarioId === own) return "This Switch would always play its own scenario, again and again — pick another one";
  return null;
}

/** The user flips On a variable ↔ Always; flipping back brings the variable's cases back. */
function _onSwitchModeChange() {
  const mode = switchMode();
  setSwitchMode(mode);
  if (mode === "always") {
    ui._switchVarStash = { cases: ui._switchCases, continueAt: ui._switchContinueAt };
    // A default case that already plays another scenario is where Always starts.
    const keep = ui._switchCases.find(c => c.value === "__default__" && c.scenarioId && c.scenarioId !== SWITCH_SELF);
    ui._switchCases = keep ? [keep] : [];
    ui._switchContinueAt = null;
  } else if (ui._switchVarStash) {
    ui._switchCases = ui._switchVarStash.cases;
    ui._switchContinueAt = ui._switchVarStash.continueAt;
    ui._switchVarStash = null;
  }
  resetCaseEditor();
  refreshSwitchForm();
  debouncedSaveDraft?.();
}

/** Show the Actions from / to pair for "Run actions here", the scenario and numbers otherwise. */
function _syncAddRowMode() {
  if (switchMode() === "always") _loadAlwaysCase();
  const isSelf = _caseMode() === "self";
  const range  = document.getElementById("switchCaseRangeRow");
  const other  = document.getElementById("switchCaseOtherRow");
  if (range) range.style.display = isSelf ? "" : "none";
  if (other) other.style.display = isSelf ? "none" : "";
  if (isSelf) {
    const c = ui._switchCases[_switchEditIdx];
    _fillRangeSelects(document.getElementById("switchCaseFrom"), document.getElementById("switchCaseTo"),
      c && c.scenarioId === SWITCH_SELF ? c : null);
  }
}

/** Put the case editor back to "+ New case". */
export function resetCaseEditor() {
  _switchEditIdx = -1;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set("switchCaseValue", "");
  set("switchCaseStart", "");
  set("switchCaseEnd", "");
  _setCaseMode("self");
  const title  = document.getElementById("switchCaseEditorTitle");
  const add    = document.getElementById("switchAddCase");
  const cancel = document.getElementById("switchCaseCancel");
  if (title)  title.textContent = "+ New case";
  if (add)    add.textContent = "+ Add case";
  if (cancel) cancel.style.display = "none";
  document.getElementById("switchCaseEditor")?.classList.remove("is-editing");
}

/** Load case `idx` into the editor. */
function _editCase(idx) {
  const c = ui._switchCases[idx];
  if (!c) return;
  _switchEditIdx = idx;
  const isSelf = c.scenarioId === SWITCH_SELF;
  document.getElementById("switchCaseValue").value = c.value === "__default__" ? "" : c.value;
  _setCaseMode(isSelf ? "self" : "other");
  if (!isSelf) {
    const sel = document.getElementById("switchCaseScenario");
    // A deleted scenario is not in the list: the select keeps its first option.
    if (sel && [...sel.options].some(o => o.value === c.scenarioId)) sel.value = c.scenarioId;
    document.getElementById("switchCaseStart").value = parseInt(c.startAt, 10) > 1 ? parseInt(c.startAt, 10) : "";
    const end = parseInt(c.endAt, 10);
    document.getElementById("switchCaseEnd").value = Number.isFinite(end) ? end : "";
  }
  document.getElementById("switchCaseEditorTitle").textContent = `✎ Edit case ${idx + 1}`;
  document.getElementById("switchAddCase").textContent = "✓ Save case";
  document.getElementById("switchCaseCancel").style.display = "";
  document.getElementById("switchCaseEditor")?.classList.add("is-editing");
  refreshSwitchForm();
  document.getElementById("switchCaseEditor")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/** "Continue at" dropdown — only for a Switch that owns a block. */
function _renderSwitchContinue() {
  const row = document.getElementById("switchContinueRow");
  const sel = document.getElementById("switchContinueAt");
  if (!row || !sel) return;
  const block = ui._switchCases.some(isBlockCase);
  row.style.display = block ? "flex" : "none";
  if (!block) return;
  const list   = candidateActions();
  const self   = switchSelfIdx();
  const layout = getSwitchLayout(list);
  const autoSw = { ..._candidateSwitch() };
  delete autoSw.continueAt;
  const autoIdx = continueIndex(candidateActions(autoSw), self);
  const autoNo  = autoIdx < list.length ? noOf(autoIdx, layout) : "end of scenario";
  let html = `<option value="auto">Auto: ${escHtml(autoNo)}</option>`;
  // Only actions after the block: inside it is an error, and before the Switch a loop.
  html += _actionOptions(-1, layout, { from: autoIdx });
  html += `<option value="${list.length}">End of scenario</option>`;
  // A saved continueAt outside that range (a backward loop) stays selectable.
  const saved = ui._switchContinueAt != null ? ui._switchContinueAt - 1 : null;
  if (saved != null && (saved < autoIdx || saved > list.length)) {
    html += `<option value="${saved}">${escHtml(saved < list.length ? noOf(saved, layout) : `#${saved + 1}`)} (saved)</option>`;
  }
  sel.innerHTML = html;
  sel.value = ui._switchContinueAt == null ? "auto" : String(ui._switchContinueAt - 1);
  if (!sel.value) sel.value = "auto";
}

/** Errors / warnings for the Switch as the form describes it. */
function _renderSwitchValidation() {
  const box = document.getElementById("switchValidation");
  if (!box) return;
  const list = candidateActions();
  const self = switchSelfIdx();
  const { errors, warnings } = validateSwitch(list, self);
  // An Always Switch with no scenario picked yet is not an error until it is saved.
  const alwaysErr = ui._switchCases.length ? alwaysSwitchError() : null;
  if (alwaysErr) errors.push(alwaysErr);
  for (const c of ui._switchCases) {
    const err = validateExternalCase(c, ui.scenariosCache?.[c.scenarioId]?.actions);
    if (err) errors.push(err);
  }
  box.innerHTML = [
    ...errors.map(m => `<div class="sw-val-error">⚠ ${escHtml(m)}</div>`),
    ...warnings.map(m => `<div class="sw-val-warn">⚠ ${escHtml(m)}</div>`),
  ].join("");
  box.style.display = errors.length || warnings.length ? "block" : "none";
}

export function populateSwitchScenarioSelect() {
  const sel = document.getElementById("switchCaseScenario");
  if (!sel) return;
  // Nothing picked to start with: a scenario is a choice, and the first one in
  // the list (often this very scenario) is not a sensible default.
  sel.innerHTML = `<option value="">— choose a scenario —</option>`;
  const scenarios = ui.scenariosCache || {};
  const folders = ui.foldersCache || {};
  Object.entries(scenarios)
    .sort(([, a], [, b]) => (a.name || "").localeCompare(b.name || ""))
    .forEach(([id, s]) => {
      const opt = document.createElement("option");
      opt.value = id;
      const folderName = s.folderId && folders[s.folderId] ? `[${folders[s.folderId].name}] ` : "";
      opt.textContent = folderName + (s.name || id);
      sel.appendChild(opt);
    });
  // "This scenario" is the "Run actions here" choice, not an entry of this list.
  _syncAddRowMode();
}

/**
 * The scenarios have (re)loaded. A list filled before they arrived — a draft
 * restored as the popup opens — is still empty, so fill it now. An Always
 * Switch's case is the scenario its list shows: that list is refilled every time.
 * A filled list on a variable is left alone, so a scenario picked for the case
 * being added stays picked.
 */
export function refreshSwitchScenarioSelect() {
  const sel = document.getElementById("switchCaseScenario");
  if (!sel) return;
  const emptyButLoaded = sel.options.length <= 1 && Object.keys(ui.scenariosCache || {}).length > 0;
  if (switchMode() === "always" || emptyButLoaded) populateSwitchScenarioSelect();
}

/** Re-render everything in the Switch form that depends on the cases. */
export function refreshSwitchForm() {
  renderSwitchCaseList();
  _syncAddRowMode();
  _renderSwitchContinue();
  _renderSwitchValidation();
}

/** What a case does, in words: "Run 1.1.1–1.1.2", "Play "Guest flow" @2", … */
function _caseTargetText(c, layout) {
  if (c.scenarioId === SWITCH_SELF) {
    if (isBlockCase(c)) return c.empty ? "Do nothing" : `Run${switchStartSuffix(c, layout)}`;
    return `Jump to${switchStartSuffix(c, layout).replace(" @", " ")}, play to the end`;
  }
  return `Play "${c.scenarioName || c.scenarioId}"${switchStartSuffix(c, layout)}`;
}

export function renderSwitchCaseList() {
  const list = document.getElementById("switchCaseList");
  if (!list) return;
  list.innerHTML = "";
  const layout = getSwitchLayout(candidateActions());
  if (!ui._switchCases.length) {
    list.innerHTML = `<div class="sw-case-empty-list">No cases yet — add the first one below.</div>`;
    return;
  }
  ui._switchCases.forEach((c, idx) => {
    const row = document.createElement("div");
    row.className = "sw-case-row-view";
    if (idx === _switchEditIdx) row.classList.add("is-editing");
    if (isBlockCase(c)) row.style.setProperty("--sw-color", `var(--sw-c${idx % CASE_COLORS})`);
    const isDefault = c.value === "__default__";
    // c.value and c.scenarioName are user-authored — escape before inserting into innerHTML.
    row.innerHTML = `
      <span class="sw-case-no">${idx + 1}</span>
      <span class="sw-case-label${isDefault ? " sw-case-default" : ""}${isBlockCase(c) ? " sw-case-label-block" : ""}">${isDefault ? "default" : `"${escHtml(c.value)}"`}</span>
      <span class="sw-case-target" title="${escHtml(_caseTargetText(c, layout))}">${escHtml(_caseTargetText(c, layout))}</span>
      <button data-idx="${idx}" class="sw-case-edit secondary sw-case-btn" type="button" title="Edit case" aria-label="Edit case ${idx + 1}">✎</button>
      <button data-idx="${idx}" class="sw-case-del secondary sw-case-btn" type="button" title="Delete case" aria-label="Delete case ${idx + 1}">🗑</button>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll(".sw-case-edit").forEach(btn => {
    btn.addEventListener("click", () => _editCase(Number(btn.dataset.idx)));
  });
  list.querySelectorAll(".sw-case-del").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      ui._switchCases.splice(idx, 1);
      if (idx === _switchEditIdx) resetCaseEditor();
      else if (idx < _switchEditIdx) _switchEditIdx--;
      refreshSwitchForm();
      debouncedSaveDraft?.();
    });
  });
}

/** Add the case in the editor, or save the one being edited. False (after a toast) when it cannot be. */
function _commitCase() {
  const valEl  = document.getElementById("switchCaseValue");
  const selEl  = document.getElementById("switchCaseScenario");
  const isSelf = _caseMode() === "self";
  if (!isSelf && !selEl?.value) { showToast("Select a scenario for this case", "error"); return false; }
  const rawVal  = valEl?.value?.trim();
  const caseVal = rawVal === "" ? "__default__" : rawVal;
  if (ui._switchCases.some((c, i) => i !== _switchEditIdx && c.value === caseVal)) {
    showToast(`Case "${caseVal === "__default__" ? "default" : caseVal}" already exists`, "error"); return false;
  }
  const target = isSelf
    ? _switchSelfTarget(document.getElementById("switchCaseFrom")?.value, document.getElementById("switchCaseTo")?.value)
    : _switchCaseTarget(selEl.value, selEl.options[selEl.selectedIndex]?.textContent || selEl.value,
        document.getElementById("switchCaseStart")?.value, document.getElementById("switchCaseEnd")?.value);
  const next = { value: caseVal, ...target };
  if (_switchEditIdx >= 0) {
    const old = ui._switchCases[_switchEditIdx];
    // Unchanged → keep the saved case as it was (same JSON on save).
    ui._switchCases[_switchEditIdx] = _sameCaseTarget(old, next) ? old : next;
  } else {
    ui._switchCases.push(next);
  }
  resetCaseEditor();
  refreshSwitchForm();
  debouncedSaveDraft?.();
  return true;
}

/**
 * Add Action on a Switch: a case left in the editor — one being edited, a value
 * typed, or another scenario picked — is added first rather than dropped.
 * False when that case cannot be added (the toast says why).
 */
export function commitPendingCase() {
  const typed  = document.getElementById("switchCaseValue")?.value?.trim();
  const picked = _caseMode() === "other" && document.getElementById("switchCaseScenario")?.value;
  if (_switchEditIdx < 0 && !typed && !picked) return true;
  return _commitCase();
}

export function initSwitchCaseBuilder() {
  document.querySelectorAll('input[name="switchCaseMode"]').forEach(r => r.addEventListener("change", _syncAddRowMode));
  document.getElementById("switchContinueAt")?.addEventListener("change", (e) => {
    const v = e.target.value;
    ui._switchContinueAt = v === "auto" || v === "" ? null : Number(v) + 1;
    _renderSwitchValidation();
    debouncedSaveDraft?.();
  });
  document.getElementById("switchAddCase")?.addEventListener("click", _commitCase);
  document.getElementById("switchCaseCancel")?.addEventListener("click", () => {
    resetCaseEditor();
    refreshSwitchForm();
  });
  document.getElementById("switchVar")?.addEventListener("input", () => _renderSwitchValidation());
  document.querySelectorAll('input[name="switchMode"]').forEach(r => r.addEventListener("change", _onSwitchModeChange));
  // Always mode edits its one case in place.
  const onAlwaysEdit = () => {
    if (switchMode() !== "always") return;
    _syncAlwaysCase();
    _renderSwitchValidation();
    debouncedSaveDraft?.();
  };
  document.getElementById("switchCaseScenario")?.addEventListener("change", onAlwaysEdit);
  ["switchCaseStart", "switchCaseEnd"].forEach(id => document.getElementById(id)?.addEventListener("input", onAlwaysEdit));
}
