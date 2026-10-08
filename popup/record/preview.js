/**
 * record/preview.js — the action list preview: rows, Switch blocks and
 * Conditions with their numbering, collapsing, drag & drop and row buttons.
 */

import { CASE_COLORS, SWITCH_SELF, anyBlocks, anyConditions, caseLabel, conditionChoices, conditionSkip, getConditionLayout, getSwitchLayout, isAlwaysSwitch, isBlockCase, planDrop, validateExternalCase, validateSwitch } from '../../shared/switch-blocks.js';
import { normalizeVarName, normalizeVarRef } from '../../shared/var-name.js';
import { actionCount, actionsEl, conditionSkipCount, preview, runListDisplay, scenarioList } from '../dom.js';
import { updateRunListDisplay } from '../run/playback-controls.js';
import { ui } from '../ui-state.js';
import { escHtml, getActionIcon, getDragAfterElement, showConfirm, showToast } from '../utils.js';
import { startEdit } from './action-form.js';
import { debouncedSaveDraft } from './draft.js';
import { noOf, setSwitchContext, swCtx, switchSelfIdx, switchStartSuffix } from './switch-case-builder.js';
import { updateUndoRedoState } from './undo-redo.js';

export function getActionDisplayValue(a) {
  const value = a.selector || a.url || a.value || a.code || "";
  if (a.type === "wait") {
    const dur = a.delay || a.value;
    return dur ? `${dur}ms` : "(no duration)";
  }
  if (a.type === "condition") {
    return `${a.conditionType || 'elementExists'}: ${a.selector || a.expectedValue || ''} [skip ${conditionSkip(a)}]`;
  }
  if (a.type === "dragdrop") {
    return `${a.selector || "(no source)"} → ${a.targetSelector || "(no target)"}`;
  }
  if (a.type === "dropdown") {
    const pick = a.pick ? ` → item #${a.pick.index ?? "?"}` : "";
    return (a.selector || "(no selector)") + pick;
  }
  if (a.type === "screenshot_element") {
    return a.selector || "(no selector)";
  }
  if (a.type === "screenshot_tovar") {
    let tgt;
    if (a.target === "element") tgt = a.selector || "?";
    else if (a.target === "full") tgt = "full-page";
    else tgt = "visible";
    return `${tgt} → $\{${normalizeVarName(a.varName) || a.varName || "?"}}`;
  }
  if (a.type === "switch") {
    if (isAlwaysSwitch(a)) {
      const c = a.cases[0];
      return `always → ${c.scenarioName || c.scenarioId}${switchStartSuffix(c)}`;
    }
    const caseLabels = (a.cases || []).map(c =>
      `${c.value === "__default__" ? "default" : c.value}→${c.scenarioId === SWITCH_SELF ? "this" : (c.scenarioName || c.scenarioId || "?")}${switchStartSuffix(c)}`
    ).join(" | ");
    return `${normalizeVarRef(a.switchVar) || "?"}: ${caseLabels || "(no cases)"}`;
  }
  if (a.type === "readdom") {
    const from = a.readFrom === "attr" ? `attr:${a.attrName || "?"}` : (a.readFrom || "text");
    const vn = normalizeVarName(a.varName) || a.varName;
    // With an Extract pattern, the pattern shows which ${name}s the step fills.
    const to = [vn && `$\{${vn}}`, a.pattern && String(a.pattern).trim()].filter(Boolean).join(" · ") || "${?}";
    return `${a.selector || "(no selector)"} → ${from} → ${to}`;
  }
  return value;
}

/* === Switch blocks in the preview ===
 * Numbers come from getSwitchLayout (1, 1.2.1 …); the absolute #N is in the
 * tooltip. Cases get a header row and their own colour; a collapsed Switch
 * hides its case chips and its block, a collapsed case hides that case's rows.
 * Collapsed state is per scenario, in localStorage.
 */
let _previewCollapsed = new Set();      // Switch indexes

let _previewCaseCollapsed = new Set();  // "switchIdx:caseIdx"

const _collapseKey = (scenarioId) => `pqa.switchCollapsed.${scenarioId || "current"}`;

const _caseCollapseKey = (scenarioId) => `pqa.switchCaseCollapsed.${scenarioId || "current"}`;

function _loadCollapsed(scenarioId) {
  try {
    const raw = JSON.parse(localStorage.getItem(_collapseKey(scenarioId)) || "[]");
    return new Set(Array.isArray(raw) ? raw.map(Number) : []);
  } catch (_) { return new Set(); }
}

function _saveCollapsed(scenarioId, set) {
  try { localStorage.setItem(_collapseKey(scenarioId), JSON.stringify([...set])); } catch (_) { /* storage blocked or full: collapse state just isn't remembered */ }
}

function _loadCaseCollapsed(scenarioId) {
  try {
    const raw = JSON.parse(localStorage.getItem(_caseCollapseKey(scenarioId)) || "[]");
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch (_) { return new Set(); }
}

function _saveCaseCollapsed(scenarioId, set) {
  try { localStorage.setItem(_caseCollapseKey(scenarioId), JSON.stringify([...set])); } catch (_) { /* storage blocked or full: collapse state just isn't remembered */ }
}

/** Enter / Space on a role="button" span acts like a click. */
function _onActivate(el, fn) {
  el.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    ev.stopPropagation();
    fn();
  });
}

/** Everything wrong with a Switch row: validateSwitch + ranges into other scenarios. */
function _switchIssues(actions, i, layout) {
  const { errors, warnings } = validateSwitch(actions, i, layout);
  for (const c of (actions[i]?.cases || [])) {
    const err = validateExternalCase(c, ui.scenariosCache?.[c.scenarioId]?.actions);
    if (err) errors.push(err);
  }
  return { errors, warnings };
}

/** "2" for an action index, or "end" past the last action. */
function _contNo(idx, layout) {
  return idx < layout.length ? layout[idx].displayNo : "end";
}

/** The colour of a block's stripe: a Condition's, a case colour, or none. */
function _stripeColor(color) {
  if (color === "cond") return "var(--sw-cond)";
  if (color != null) return `var(--sw-c${color})`;
  return "var(--muted)";
}

function _applyBlockStyle(el, depth, color) {
  if (!depth) return;
  el.classList.add("sw-in-block");
  el.style.setProperty("--sw-depth", depth);
  el.style.setProperty("--sw-color", _stripeColor(color));
}

/** Conditions guarding action `i` (outermost first) — see getConditionLayout. */
function _condsOf(i) {
  return swCtx.condLayout?.[i]?.conds || [];
}

/** Add Condition indices to a row's data-blocks, so collapsing one hides the row. */
function _withConds(blocks, conds) {
  return [blocks, ...conds].filter(x => x !== "" && x != null).join(" ");
}

/** Everything wrong with a Condition's range, for its ⚠. */
function _conditionIssues(i, layout) {
  const r = swCtx.condLayout?.[i]?.range;
  if (!r) return [];
  const out = [];
  if (r.skip === 0) return ["Guards no action — a false result skips nothing. Drop an action right below it, or pick one in its form"];
  if (r.end < r.start) return ["Nothing follows this Condition — it guards no action"];
  const acts = (n) => `${n} action${n === 1 ? "" : "s"}`;
  if (r.short) out.push(`Skips ${acts(r.skip)} when false, but only ${r.units} follow`);
  if (r.cut) {
    const inner = layout[i]?.chain?.[layout[i].chain.length - 1];
    const sw = inner ? layout[inner.switchIdx]?.displayNo : "?";
    out.push(`Skipping ${acts(r.skip)} when false runs past the end of its case in Switch ${sw} — playback then continues after that Switch`);
  }
  if (r.past != null) out.push(`Guards actions past the end of the Condition at ${noOf(r.past, layout)}`);
  return out;
}

/**
 * "Then run" in the Condition form: one option per possible skipCount, counted
 * in actions, with the actions it guards listed below (_renderConditionGuarded).
 * The hidden #conditionSkipCount keeps the number that is saved, so drafts and
 * older code paths read it as before.
 */
export function renderConditionRunTo() {
  const sel = document.getElementById("conditionRunTo");
  if (!sel || !conditionSkipCount) return;
  const self = switchSelfIdx();
  // "0" is the emptied state (guards nothing); anything else reads like playback does.
  const cur  = conditionSkipCount.value === "0" ? 0 : conditionSkip({ skipCount: conditionSkipCount.value });
  const list = [...swCtx.actions];
  const cand = { ...(self < list.length ? list[self] : {}), type: "condition", skipCount: Math.max(1, cur) };
  if (cur === 0) cand.empty = true; else delete cand.empty;
  if (self < list.length) list[self] = cand; else list.push(cand);
  const layout = getSwitchLayout(list);
  const ends = conditionChoices(list, self, layout);
  // Counted in actions; a Switch's block is in its unit, so counts can jump.
  let html = `<option value="0">No actions — guards nothing</option>`;
  ends.forEach((end, k) => {
    const count = end - self;
    html += `<option value="${k + 1}">${count === 1 ? "Only the next action" : `The next ${count} actions`}</option>`;
  });
  if (!ends.length) {
    html += `<option value="1">The next action</option>`;
  } else if (cur > ends.length) {
    html += `<option value="${cur}">${cur} actions — more than follow (saved)</option>`;
  }
  sel.innerHTML = html;
  sel.value = String(cur);
  if (!sel.value) { sel.value = "1"; conditionSkipCount.value = "1"; }
  _renderConditionGuarded(list, layout, self, ends, parseInt(sel.value, 10) || 0);
}

/** The actions "Then run" guards, one row per unit (a Switch stands for its block). */
function _renderConditionGuarded(list, layout, self, ends, units) {
  const ol   = document.getElementById("conditionGuarded");
  const hint = document.getElementById("conditionRunHint");
  if (!ol) return;
  ol.textContent = "";
  if (hint) {
    if (units === 0) hint.textContent = "Nothing is guarded — this Condition has no effect.";
    else if (!ends.length) hint.textContent = "No action follows yet — the next one added after this Condition is guarded.";
    else hint.textContent = "If the condition is false, these are skipped.";
  }
  const MAX_ROWS = 6;
  const shown = Math.min(units, ends.length);
  for (let k = 0; k < shown; k++) {
    const li = document.createElement("li");
    if (k === MAX_ROWS) {
      li.className = "cg-more";
      li.textContent = `+ ${ends[shown - 1] - ends[k - 1]} more`;
      ol.appendChild(li);
      break;
    }
    const start = k === 0 ? self + 1 : ends[k - 1] + 1;
    const a = list[start] || {};
    const inBlock = ends[k] - start;
    const no = document.createElement("span");
    no.className = "cg-no";
    no.textContent = noOf(start, layout);
    const type = document.createElement("span");
    type.className = "cg-type";
    type.textContent = `${getActionIcon(a.type)} ${a.type || ""}`.trim();
    const val = document.createElement("span");
    val.className = "cg-val";
    val.textContent = (a.label || getActionDisplayValue(a) || "") + (inBlock > 0 ? `  + ${inBlock} in its block` : "");
    val.title = val.textContent;
    li.append(no, type, val);
    ol.appendChild(li);
  }
}

/** "Drop here to move out of If N" zone, shown while dragging. */
function _condOutsideLi(c, layout) {
  const li = document.createElement("li");
  li.className = "sw-outside cond-outside";
  li.dataset.cond = c;
  const conds = _condsOf(c);
  _applyBlockStyle(li, (layout[c]?.depth || 0) + conds.length, conds.length ? "cond" : layout[c]?.color);
  li.dataset.blocks = _withConds(_blockKeys(layout[c]?.chain || []).blocks, conds);
  li.textContent = `⤓ Drop here to move out of If ${noOf(c, layout)}`;
  return li;
}

/** Space-separated keys used to find a block's / a case's rows. */
function _blockKeys(chain) {
  return {
    blocks: chain.map(c => c.switchIdx).join(" "),
    cases: chain.filter(c => c.caseIdx != null).map(c => `${c.switchIdx}:${c.caseIdx}`).join(" "),
  };
}

function _caseHeadLi(s, k, actions, layout, empty) {
  const li = document.createElement("li");
  li.className = "sw-case-head";
  li.dataset.switch = s;
  li.dataset.case = k;
  const sw = layout[s];
  _applyBlockStyle(li, sw.depth + 1 + _condsOf(s).length, k % CASE_COLORS);
  const keys = _blockKeys(sw.chain);
  li.dataset.blocks = _withConds(`${keys.blocks} ${s}`.trim(), _condsOf(s));
  // Cases this header sits inside, so collapsing an outer case hides it too.
  if (keys.cases) li.dataset.cases = keys.cases;
  const c = actions[s].cases[k];
  const toggle = empty ? ""
    : `<span class="sw-toggle sw-case-toggle" role="button" tabindex="0" data-switch="${s}" data-case="${k}" aria-label="Collapse or expand case ${escHtml(caseLabel(c))}" aria-expanded="true"><span class="chev" aria-hidden="true">▸</span></span>`;
  li.innerHTML = `<span class="sw-case-head-label">case ${escHtml(caseLabel(c))}</span>`
    + toggle
    + (empty ? `<span class="sw-case-empty" title="This case has no actions — it does nothing">(empty) ⚠</span>` : "")
    + `<span class="sw-case-count"></span>`
    + `<span class="sw-case-head-rule"></span>`;
  li.title = "Drop an action here to put it first in this case";
  if (!empty) {
    const onToggle = () => _toggleCaseCollapsed(s, k);
    _onActivate(li.querySelector(".sw-case-toggle"), onToggle);
    // The whole header row is the target, not just the arrow or the label.
    li.classList.add("sw-case-head-click");
    li.title = "Click to collapse / expand this case · drop an action here to put it first in the case";
    li.addEventListener("click", onToggle);
  }
  return li;
}

function _outsideLi(s, layout) {
  const li = document.createElement("li");
  li.className = "sw-outside";
  li.dataset.switch = s;
  const sw = layout[s];
  const conds = _condsOf(s);
  _applyBlockStyle(li, sw.depth + conds.length, conds.length && conds[conds.length - 1] > (sw.chain[sw.chain.length - 1]?.switchIdx ?? -1) ? "cond" : sw.color);
  li.dataset.blocks = _withConds(_blockKeys(sw.chain).blocks, conds);
  li.textContent = `⤓ Drop here to move out of Switch ${sw.displayNo}`;
  return li;
}

function _toggleCollapsed(s) {
  const scenarioId = swCtx.scenarioId;
  if (_previewCollapsed.has(s)) _previewCollapsed.delete(s); else _previewCollapsed.add(s);
  _saveCollapsed(scenarioId, _previewCollapsed);
  _applyCollapsed();
}

function _toggleCaseCollapsed(s, k) {
  const key = `${s}:${k}`;
  if (_previewCaseCollapsed.has(key)) _previewCaseCollapsed.delete(key); else _previewCaseCollapsed.add(key);
  _saveCaseCollapsed(swCtx.scenarioId, _previewCaseCollapsed);
  _applyCollapsed();
}

/**
 * A block Switch's cases in one short line for the row ("3 cases · else → 5"),
 * and in full, one per line, for its tooltip. The value column is too narrow for
 * a chip per case, and the block's cases already have headers of their own.
 */
function _switchSummary(a, i, layout) {
  const e = layout[i];
  const cases = a.cases || [];
  const lines = cases.map((c, k) => {
    let where;
    if (isBlockCase(c)) {
      const cc = e.block?.cases?.[k];
      if (c.empty || cc?.start == null) where = "nothing";
      else if (cc.start === cc.end) where = layout[cc.start].displayNo;
      else where = `${layout[cc.start].displayNo}–${layout[cc.end].displayNo}`;
    } else if (c.scenarioId === SWITCH_SELF) {
      where = `jump${switchStartSuffix(c, layout)}`;
    } else {
      where = `→ ${c.scenarioName || c.scenarioId}${switchStartSuffix(c, layout)}`;
    }
    return `${caseLabel(c)}  ${where}`;
  });
  let short = `${cases.length} case${cases.length === 1 ? "" : "s"}`;
  if (!cases.some(c => c.value === "__default__")) {
    const other = `else → ${_contNo(e.block.continueIdx, layout)}`;
    lines.push(other);
    short += ` · ${other}`;
  }
  return { short, full: lines.join("\n") };
}

/** Hide every row inside a collapsed Switch's block or a collapsed case. */
function _applyCollapsed() {
  actionsEl.querySelectorAll("[data-blocks], [data-cases]").forEach(el => {
    const blocks = (el.dataset.blocks || "").split(" ").filter(Boolean).map(Number);
    const cases  = (el.dataset.cases || "").split(" ").filter(Boolean);
    el.classList.toggle("sw-hidden",
      blocks.some(k => _previewCollapsed.has(k)) || cases.some(c => _previewCaseCollapsed.has(c)));
  });
  actionsEl.querySelectorAll("li.action[data-index]").forEach(li => {
    li.classList.toggle("sw-collapsed", _previewCollapsed.has(Number(li.dataset.index)));
  });
  actionsEl.querySelectorAll(".sw-toggle").forEach(t => {
    const s = Number(t.dataset.switch);
    const open = t.dataset.case != null
      ? !_previewCaseCollapsed.has(`${s}:${t.dataset.case}`)
      : !_previewCollapsed.has(s);
    t.setAttribute("aria-expanded", String(open));
  });
  // A collapsed Switch / Condition says how many actions it hides.
  actionsEl.querySelectorAll("li.action[data-index] .sw-hidden-count").forEach(out => {
    const s = Number(out.closest("li").dataset.index);
    if (!_previewCollapsed.has(s)) { out.textContent = ""; return; }
    const n = actionsEl.querySelectorAll(`li.action[data-blocks~="${s}"]`).length;
    out.textContent = `${n} action${n === 1 ? "" : "s"} hidden`;
  });
  // A collapsed case says how many rows it hides.
  actionsEl.querySelectorAll(".sw-case-head[data-case]").forEach(h => {
    const key = `${h.dataset.switch}:${h.dataset.case}`;
    const out = h.querySelector(".sw-case-count");
    if (!out) return;
    if (!_previewCaseCollapsed.has(key)) { out.textContent = ""; return; }
    const n = actionsEl.querySelectorAll(`li.action[data-cases~="${key}"]`).length;
    out.textContent = `${n} action${n === 1 ? "" : "s"} hidden`;
  });
}

function createActionListItem(a, i, scenarioId, view = null) {
  const li = document.createElement("li");
  li.classList.add("action", `action-${a.type}`);
  if (a.disabled) li.classList.add("action-disabled");
  li.dataset.index = i;
  li.draggable = true;

  const layout = view?.layout;
  const e = layout?.[i];
  const blocksOn = !!view?.blocksOn;
  const no = e?.displayNo ?? String(i + 1);
  const isBlockSwitch = !!e?.block;
  const condRange = swCtx.condLayout?.[i]?.range;
  const isCondBlock = !!condRange && condRange.end >= condRange.start;
  const hasToggle = isBlockSwitch || isCondBlock;

  // A block Switch lists its cases in the summary, so the line itself only names
  // the variable; a Condition's "[skip N]" is shown as its block instead.
  let value;
  if (isBlockSwitch) value = normalizeVarRef(a.switchVar) || "?";
  else if (a.type === "condition") value = getActionDisplayValue(a).replace(/ \[skip \d+\]$/, "");
  else value = getActionDisplayValue(a);
  const delayText = (a.delay && a.type !== "wait") ? ` (${a.delay}ms)` : "";
  const labelHtml = a.label
    ? `<span class="value-label">${escHtml(a.label)}</span>`
    : "";
  const clickThroughHtml = a.clickThrough === false
    ? `<span class="ct-off" title="Click through off: fails when its element is disabled, read-only, not visible or covered">⊘</span>`
    : "";

  // Switch blocks: nesting, problems, where playback goes next.
  let warnHtml = "", notesHtml = "", summaryHtml = "";
  if (e) {
    // Conditions guarding this row nest like Switch blocks; the innermost
    // structure (the later-starting one) gives the colour.
    const conds = _condsOf(i);
    const innerCond = conds.length ? conds[conds.length - 1] : -1;
    const innerSw = e.chain.length ? e.chain[e.chain.length - 1].switchIdx : -1;
    _applyBlockStyle(li, e.depth + conds.length, innerCond > innerSw ? "cond" : e.color);
    const keys = _blockKeys(e.chain);
    const blocks = _withConds(keys.blocks, conds);
    if (blocks) li.dataset.blocks = blocks;
    if (keys.cases) li.dataset.cases = keys.cases;
    if (a.type === "condition") {
      const issues = _conditionIssues(i, layout);
      if (issues.length) warnHtml = `<span class="sw-warn" title="${escHtml(issues.join("\n"))}">⚠</span>`;
      if (isCondBlock) {
        const n = condRange.end - condRange.start + 1;
        const full = `If true: runs ${noOf(condRange.start, layout)}${n > 1 ? `–${noOf(condRange.end, layout)}` : ""}\nIf false: skips them`;
        summaryHtml = `<span class="sw-summary" title="${escHtml(full)}">if true → runs ${n} action${n === 1 ? "" : "s"}</span>`
          + `<span class="sw-hidden-count"></span>`;
      }
    }
    if (a.type === "switch") {
      const { errors, warnings } = _switchIssues(view.actions, i, layout);
      if (errors.length) li.classList.add("sw-invalid");
      const msgs = [...errors, ...warnings];
      if (msgs.length) warnHtml = `<span class="sw-warn" title="${escHtml(msgs.join("\n"))}">⚠</span>`;
      if (isBlockSwitch) {
        const { short, full } = _switchSummary(a, i, layout);
        // The hidden count takes the summary's place while the Switch is collapsed.
        summaryHtml = `<span class="sw-summary" title="${escHtml(full)}">${escHtml(short)}</span>`
          + `<span class="sw-hidden-count"></span>`;
      }
    }
    if (e.role === "orphan") {
      li.classList.add("sw-orphan");
      warnHtml = `<span class="sw-warn" title="Inside the block of Switch ${escHtml(layout[e.parent.switchIdx].displayNo)} but in no case — it never runs">⚠</span>`;
    }
    if (e.blockLast.length) {
      const inner = Math.max(...e.blockLast);
      notesHtml += `<span class="sw-note">↳ then go to ${escHtml(_contNo(layout[inner].block.continueIdx, layout))}</span>`;
    }
    if (e.continueOf.length) {
      notesHtml += `<span class="sw-note">⤴ continues after Switch ${e.continueOf.map(s => escHtml(layout[s].displayNo)).join(", ")}</span>`;
    }
  }

  // One line under the value for everything else — the label, the Switch-block
  // notes and a block Switch's case summary (or "N actions hidden" once
  // collapsed) — so a row is always two lines tall, whatever it carries.
  const subHtml = labelHtml || notesHtml || summaryHtml
    ? `<span class="value-sub">${labelHtml}${notesHtml}${summaryHtml}</span>`
    : "";

  const toggleHtml = hasToggle
    ? `<span class="sw-toggle" role="button" tabindex="0" data-switch="${i}" aria-label="Collapse or expand the ${isBlockSwitch ? "Switch cases and block" : "actions this Condition guards"}" aria-expanded="true"><span class="chev" aria-hidden="true">▸</span></span>`
    : "";

  li.innerHTML = `
    <span class="index" title="#${i + 1}">${escHtml(blocksOn ? no : `${i + 1}.`)}</span>
    <span class="type">${getActionIcon(a.type)}${escHtml(a.type)}${toggleHtml}</span>
    <span class="value" title="${escHtml(value)}${escHtml(delayText)}">
      <span class="value-main">${warnHtml}${clickThroughHtml}${escHtml(value)}${escHtml(delayText)}</span>
      ${subHtml}
    </span>
  `;

  if (hasToggle) {
    _onActivate(li.querySelector(".sw-toggle"), () => _toggleCollapsed(i));
    // Bigger target: a click anywhere on "🔀 SWITCH ▾" / "❓ CONDITION ▾" collapses too.
    const typeCell = li.querySelector(".type");
    typeCell.classList.add("sw-type-toggle");
    typeCell.title = isBlockSwitch ? "Collapse / expand the Switch" : "Collapse / expand what this Condition guards";
    typeCell.addEventListener("click", (ev) => { ev.stopPropagation(); _toggleCollapsed(i); });
  }

  li.addEventListener("dragstart", (dragEvent) => {
    ui.dragFromIndex = Number(li.dataset.index);
    ui._actionDragActive = true;
    ui._actionDropped = false;
    _dragAnchorKey = null;
    li.classList.add("dragging");
    dragEvent.dataTransfer.effectAllowed = "move";
    // Chrome ends a drag at once when dragstart moves the dragged row out from
    // under the pointer. Showing the "move out of …" drop zones inserts rows
    // above every row that comes after a Switch / If block — the last action of
    // a list scrolled to the bottom most of all — so the zones come in once
    // dragstart has returned, with the list scrolled to keep the dragged row
    // where it was.
    setTimeout(() => {
      if (!ui._actionDragActive || !li.isConnected) return;
      const before = li.getBoundingClientRect().top;
      actionsEl.classList.add("sw-dragging");
      actionsEl.scrollTop += li.getBoundingClientRect().top - before;
      // The row's own "move out of …" zones sit right below it; at the bottom
      // of the list that is past the visible area, so scroll just enough to
      // show them.
      let lastZone = null;
      for (let n = li.nextElementSibling; n && n.classList.contains("sw-outside"); n = n.nextElementSibling) {
        if (n.getClientRects().length) lastZone = n;
      }
      if (lastZone) {
        const over = lastZone.getBoundingClientRect().bottom - actionsEl.getBoundingClientRect().bottom;
        if (over > 0) actionsEl.scrollTop += over + 2;
      }
    }, 0);
  });
  li.addEventListener("dragend", () => {
    ui._actionDragActive = false;
    _dragAnchorKey = null;
    li.classList.remove("dragging");
    actionsEl.classList.remove("sw-dragging");
    actionsEl.querySelectorAll(".drop-target").forEach(el => el.classList.remove("drop-target"));
    // Released outside the list (e.g. just below its last row): no drop fired,
    // so nothing was saved — put the rows back instead of leaving the row
    // where the last dragover moved it.
    if (!ui._actionDropped) previewActions();
    document.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
  });

  const btnRow = document.createElement("div");
  btnRow.className = "btn-row";

  const actionLabel = a.label ? `"${a.label}"` : `${a.type} ${no}`;

  const toggleBtn = document.createElement("button");
  const toggleVerb = a.disabled ? "Enable" : "Disable";
  toggleBtn.textContent = toggleVerb;
  toggleBtn.className = "secondary";
  // A block Switch / Condition switches the actions under it too (toggleDisabled
  // in shared/switch-blocks.js); each of those can still be switched on its own.
  let nested;
  if (isBlockSwitch) nested = Math.max(0, e.block.end - i);
  else if (isCondBlock) nested = condRange.end - condRange.start + 1;
  else nested = 0;
  const nestedText = nested ? ` and the ${nested} action${nested === 1 ? "" : "s"} under it` : "";
  toggleBtn.setAttribute("aria-label", `${toggleVerb} action ${no}: ${actionLabel}${nestedText}`);
  if (nested) toggleBtn.title = `${toggleVerb} this ${a.type === "switch" ? "Switch" : "Condition"}${nestedText} — each can still be switched on its own`;
  toggleBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage(
      { type: "TOGGLE_ACTION_DISABLED", scenarioId, index: i },
      (res) => {
        previewActions(); updateUndoRedoState();
        if (res?.success && res.children > 0) {
          const n = res.children;
          showToast(`${res.disabled ? "Disabled" : "Enabled"} ${actionLabel} and the ${n} action${n === 1 ? "" : "s"} under it`, "info");
        }
      }
    );
  });

  const editBtn = document.createElement("button");
  editBtn.textContent = "Edit";
  editBtn.className = "secondary";
  editBtn.setAttribute("aria-label", `Edit action ${no}: ${actionLabel}`);
  editBtn.addEventListener("click", () => startEdit(i, a));

  const delBtn = document.createElement("button");
  delBtn.textContent = "Delete";
  delBtn.className = "danger";
  delBtn.setAttribute("aria-label", `Delete action ${no}: ${actionLabel}`);
  delBtn.addEventListener("click", () => {
    // A block Switch's actions stay where they are and become regular actions.
    const inBlock = isBlockSwitch ? e.block.end - i : 0;
    const msg = inBlock > 0
      ? `Delete this Switch? The ${inBlock} action${inBlock === 1 ? "" : "s"} in its block stay and become regular actions.`
      : "Delete this action?";
    showConfirm(msg, () => {
      chrome.runtime.sendMessage(
        { type: "REMOVE_ACTION", scenarioId, index: i },
        () => { previewActions(); updateUndoRedoState(); }
      );
    }, { title: isBlockSwitch ? 'Delete Switch' : 'Delete Action', danger: true });
  });

  const copyBtn = document.createElement("button");
  copyBtn.textContent = "Copy";
  copyBtn.className = "secondary";
  copyBtn.setAttribute("aria-label", `Copy action ${no}: ${actionLabel}`);
  copyBtn.addEventListener("click", () => {
    ui.actionClipboard = JSON.parse(JSON.stringify(a));
    showToast("Action copied", "success");
    previewActions();
  });

  btnRow.appendChild(toggleBtn);
  btnRow.appendChild(copyBtn);
  btnRow.appendChild(editBtn);
  btnRow.appendChild(delBtn);
  li.appendChild(btnRow);
  return li;
}

/** Render the action rows, case headers and "out of the block" drop zones. */
function _renderActionRows(actions, scenarioId) {
  const layout = swCtx.layout;
  const blocksOn = anyBlocks(actions);
  // Numbering only nests for Switch blocks; Conditions keep flat numbers but
  // still collapse and indent.
  const structOn = blocksOn || anyConditions(actions);
  _previewCollapsed = structOn ? _loadCollapsed(scenarioId) : new Set();
  _previewCaseCollapsed = blocksOn ? _loadCaseCollapsed(scenarioId) : new Set();
  actionsEl.classList.toggle("has-blocks", blocksOn);
  const widest = layout.reduce((m, e) => Math.max(m, e.displayNo.length), 2);
  actionsEl.style.setProperty("--idx-w", `${Math.max(18, widest * 6 + 4)}px`);
  const view = { layout, actions, blocksOn };

  actions.forEach((a, i) => {
    if (a == null) return;
    const e = layout[i];
    if (e?.caseStart) {
      actionsEl.appendChild(_caseHeadLi(e.caseStart.switchIdx, e.caseStart.caseIdx, actions, layout, false));
    }
    actionsEl.appendChild(createActionListItem(a, i, scenarioId, view));
    if (!structOn || !e) return;
    // Blocks and Conditions ending on this row, innermost (latest start) first:
    // a block's empty cases, then each one's "move out" drop zone.
    const ending = [...e.blockLast];
    if (e.block && e.block.end === i) ending.push(i);
    const condEnding = [];
    (swCtx.condLayout || []).forEach((cl, c) => {
      if (cl.range && cl.range.end >= cl.range.start && cl.range.end === i) condEnding.push(c);
    });
    [...ending.map(s => ({ s })), ...condEnding.map(c => ({ c }))]
      .sort((x, y) => (y.s ?? y.c) - (x.s ?? x.c))
      .forEach(({ s, c }) => {
        if (c != null) { actionsEl.appendChild(_condOutsideLi(c, layout)); return; }
        layout[s].block.cases.forEach((cc) => {
          if (cc.isBlock && cc.start == null) actionsEl.appendChild(_caseHeadLi(s, cc.caseIdx, actions, layout, true));
        });
        actionsEl.appendChild(_outsideLi(s, layout));
      });
  });
  if (structOn) _applyCollapsed();
}

export function previewActions() {
  const scenarioId = scenarioList.value || null;
  const savedScroll = actionsEl.scrollTop;
  // Increment before the async call; if another call starts before this response
  // arrives, currentRequestId will be stale and we discard the late response.
  const currentRequestId = ++ui.previewRequestId;

  actionsEl.innerHTML = '<li class="action-loading">Loading…</li>';

  chrome.runtime.sendMessage(
    { type: "GET_PREVIEW_ACTIONS", scenarioId },
    (res) => {
      if (currentRequestId !== ui.previewRequestId) return;

      actionsEl.innerHTML = "";

      if (!res?.actions?.length) {
        setSwitchContext(scenarioId, []);
        actionsEl.innerHTML = `<li class="empty">No actions recorded — use the Add Manual Action card above to add one</li>`;
        if (actionCount) actionCount.style.display = "none";
        updateUndoRedoState();
        return;
      }

      setSwitchContext(scenarioId, res.actions);
      _renderActionRows(res.actions, scenarioId);

      // Paste button — shown when clipboard has data
      if (ui.actionClipboard) {
        const pasteLi = document.createElement("li");
        pasteLi.className = "action-navigate action-paste-li";
        const pasteBtn = document.createElement("button");
        pasteBtn.textContent = `📋 Paste: ${ui.actionClipboard.type}${ui.actionClipboard.label ? ` (${ui.actionClipboard.label})` : ""}`;
        pasteBtn.className = "secondary action-paste-btn";
        pasteBtn.addEventListener("click", () => {
          const newAction = JSON.parse(JSON.stringify(ui.actionClipboard));
          delete newAction.disabled;
          const sid = scenarioList.value || null;
          chrome.runtime.sendMessage({ type: "ADD_MANUAL_ACTION", action: newAction, scenarioId: sid }, () => {
            showToast("Action pasted", "success");
            previewActions();
            updateUndoRedoState();
          });
        });
        const clearClipboardBtn = document.createElement("button");
        clearClipboardBtn.textContent = "✕";
        clearClipboardBtn.className = "secondary action-paste-btn";
        clearClipboardBtn.title = "Clear clipboard";
        clearClipboardBtn.style.opacity = "0.65";
        clearClipboardBtn.addEventListener("click", () => { ui.actionClipboard = null; previewActions(); });
        pasteLi.appendChild(pasteBtn);
        pasteLi.appendChild(clearClipboardBtn);
        actionsEl.appendChild(pasteLi);
      }

      const count = res.actions?.length || 0;
      if (actionCount) {
        actionCount.textContent = count;
        actionCount.style.display = count > 0 ? "inline-block" : "none";
      }

      actionsEl.scrollTop = savedScroll;
      updateUndoRedoState();
    }
  );
}

/**
 * While dragging, show the dragged row where it would land: indented and
 * coloured for the Switch case / If it would join (worked out by planDrop, so
 * it matches what the drop does), and the "move out" zone or case header it
 * sits under highlighted.
 */
let _dragAnchorKey = null;

function _previewDropPlacement(dragging) {
  if (ui.dragFromIndex == null) return;
  const anchor = _dropAnchor(dragging);
  const key = JSON.stringify(anchor);
  if (key === _dragAnchorKey) return;
  _dragAnchorKey = key;

  const plan = planDrop(swCtx.actions, ui.dragFromIndex, anchor);
  const list = plan ? plan.actions : swCtx.actions;
  const at   = plan ? plan.newOrder.indexOf(ui.dragFromIndex) : ui.dragFromIndex;
  const lay  = getSwitchLayout(list);
  const e    = lay[at];
  const conds = getConditionLayout(list, lay)[at]?.conds || [];
  const innerCond = conds.length ? conds[conds.length - 1] : -1;
  const innerSw = e?.chain?.length ? e.chain[e.chain.length - 1].switchIdx : -1;

  dragging.classList.remove("sw-in-block");
  dragging.style.removeProperty("--sw-depth");
  dragging.style.removeProperty("--sw-color");
  if (e) _applyBlockStyle(dragging, e.depth + conds.length, innerCond > innerSw ? "cond" : e.color);

  actionsEl.querySelectorAll(".drop-target").forEach(el => el.classList.remove("drop-target"));
  const prev = dragging.previousElementSibling;
  if (prev && (prev.classList.contains("sw-outside") || prev.classList.contains("sw-case-head"))) {
    prev.classList.add("drop-target");
  }
}

/**
 * Where the dragged row landed, from the visible row right above it — see
 * planDrop in shared/switch-blocks.js for what each kind means.
 */
function _dropAnchor(dragging) {
  let prev = dragging.previousElementSibling;
  while (prev && (prev.getClientRects().length === 0 || prev.classList.contains("action-paste-li")
    || prev.classList.contains("action-loading"))) {
    prev = prev.previousElementSibling;
  }
  if (!prev) return { kind: "top" };
  if (prev.classList.contains("sw-case-head")) {
    return { kind: "caseHead", switchIdx: Number(prev.dataset.switch), caseIdx: Number(prev.dataset.case) };
  }
  if (prev.classList.contains("cond-outside")) return { kind: "outsideCond", condIdx: Number(prev.dataset.cond) };
  if (prev.classList.contains("sw-outside")) return { kind: "outside", switchIdx: Number(prev.dataset.switch) };
  const j = Number(prev.dataset.index);
  if (!Number.isInteger(j)) return { kind: "top" };
  if (swCtx.layout[j]?.block && _previewCollapsed.has(j)) return { kind: "afterCollapsed", switchIdx: j };
  if (swCtx.condLayout?.[j]?.range && _previewCollapsed.has(j)) return { kind: "afterCollapsedCond", condIdx: j };
  return { kind: "after", index: j };
}

function updateActionOrderFromDOM() {
  const scenarioId = scenarioList.value || null;
  const dragging = actionsEl.querySelector("li.dragging");
  // Read the anchor while the "move out of …" drop zones are still shown:
  // _dropAnchor skips hidden rows, so once sw-dragging is gone a drop on one of
  // those zones read as a drop after the block's last action.
  const anchor = dragging ? _dropAnchor(dragging) : null;
  actionsEl.classList.remove("sw-dragging");
  if (!dragging || ui.dragFromIndex == null || swCtx.scenarioId !== scenarioId) { previewActions(); return; }

  // A dragged Switch / Condition takes its block along, and where a row lands
  // decides which case and which Conditions it joins — worked out by planDrop.
  const plan = planDrop(swCtx.actions, ui.dragFromIndex, anchor);
  if (!plan) { previewActions(); return; }

  chrome.runtime.sendMessage(
    {
      type: "REORDER_ACTIONS",
      scenarioId,
      newOrder: plan.newOrder,
      move: plan.move,
    },
    () => {
      // Refresh preview to update STT immediately after reorder
      previewActions();
      updateUndoRedoState();
    }
  );
}

export function initPreview() {
  document.getElementById("conditionRunTo")?.addEventListener("change", (e) => {
    if (conditionSkipCount) conditionSkipCount.value = e.target.value;
    renderConditionRunTo();
    debouncedSaveDraft?.();
  });
  actionsEl.addEventListener("dragover", (e) => {
    e.preventDefault();

    const dragging = document.querySelector(".dragging");
    if (!dragging) return;

    const afterElement = getDragAfterElement(actionsEl, e.clientY);

    // Move only when the spot changes: every move re-lays the list out.
    const moved = afterElement == null
      ? dragging !== actionsEl.lastElementChild && (actionsEl.appendChild(dragging), true)
      : dragging.nextElementSibling !== afterElement && (actionsEl.insertBefore(dragging, afterElement), true);
    if (moved || _dragAnchorKey == null) _previewDropPlacement(dragging);
  });
  actionsEl.addEventListener("drop", (e) => {
    e.preventDefault();
    ui._actionDropped = true;
    updateActionOrderFromDOM();
  });
  // Drag & drop for runListDisplay
  runListDisplay.addEventListener("dragover", (e) => {
    e.preventDefault();
    const dragging = runListDisplay.querySelector(".dragging");
    if (!dragging) return;
    const after = getDragAfterElement(runListDisplay, e.clientY);
    runListDisplay.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
    if (after == null) runListDisplay.appendChild(dragging);
    else { after.classList.add("drag-over"); runListDisplay.insertBefore(dragging, after); }
  });
  runListDisplay.addEventListener("drop", () => {
    runListDisplay.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
    const newOrder = [...runListDisplay.querySelectorAll("li[data-index]")].map(li => Number(li.dataset.index));
    ui.runList = newOrder.map(i => ui.runList[i]);
    updateRunListDisplay();
  });
  preview.addEventListener('click', previewActions);
}
