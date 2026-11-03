/**
 * record/insert-point.js — where Add Action and Paste put the next action.
 *
 * The "+" in the gap under a row (or a case header) picks the place. A dummy row
 * stands there — what the form holds, faded, indented into the case / If it will
 * join — and the Add card says where it goes. The place is kept as a drop anchor
 * of the drag code (anchorOf), so the action lands exactly where a row dropped
 * there would (insertActions, in the worker as in the form).
 *
 * The place is dropped (back to "last") when the list changes under it: another
 * scenario, a Delete, a drag, Undo / Redo, or Edit on a row.
 */

import { isBlockCase, insertActions } from '../../shared/switch-blocks.js';
import { actionsEl, conditionType, manualActionType, manualSelector, manualValue, scenarioList } from '../dom.js';
import { setCardOpen } from '../ui/collapsible.js';
import { ui } from '../ui-state.js';
import { debounce, escHtml, getActionIcon, showToast } from '../utils.js';
import { anchorOf, applyPlacement, getActionDisplayValue, placeText, renderConditionRunTo } from './preview.js';
import { swCtx } from './switch-case-builder.js';

let ghost = null;   // the dummy row, made on first use (tests import this module without a DOM)

function _ghostRow() {
  if (ghost) return ghost;
  ghost = document.createElement("li");
  ghost.className = "action-ghost";
  ghost.setAttribute("aria-label", "Where the new action goes");
  ghost.addEventListener("click", (e) => {
    const g = e.target.closest("[data-g]")?.dataset.g;
    if (g === "up") _nudge(-1);
    else if (g === "down") _nudge(1);
    else if (g === "end") setInsertPoint(null);
  });
  return ghost;
}

/** The place for the list on screen, or null: the next action goes last. */
export function insertAnchor() {
  const p = ui.insertPoint;
  const sid = scenarioList.value || null;
  return p && p.scenarioId === sid && swCtx.scenarioId === sid ? p.anchor : null;
}

export function setInsertPoint(anchor) {
  ui.insertPoint = anchor ? { scenarioId: scenarioList.value || null, anchor } : null;
  renderInsertPoint();
  // "Then run" counts the actions after the place the Condition goes.
  if (manualActionType.value === "condition") renderConditionRunTo();
}

export function clearInsertPoint() {
  if (ui.insertPoint) setInsertPoint(null);
}

/** The place after an add, in the list about to be drawn — previewActions shows it. */
export function moveInsertPoint(anchor) {
  ui.insertPoint = { scenarioId: scenarioList.value || null, anchor };
}

/** Where the place is after Paste: past the whole unit, so the next paste follows it. */
export function anchorAfterUnit(index, unit) {
  if (unit.length < 2) return { kind: "after", index };
  return unit[0].type === "switch" ? { kind: "outside", switchIdx: index } : { kind: "outsideCond", condIdx: index };
}

const _isOpenBlockSwitch = (el) => el.matches("li.action.action-switch") && !!el.querySelector(".sw-type-toggle")
  && !el.classList.contains("sw-collapsed");

/** "+" under row or header `el`: the next action goes right below it. */
export function pickInsertAfter(el) {
  if (ui.editing) {
    showToast("Save or cancel the edit first — then pick where the new action goes", "info");
    return;
  }
  // Right under an open Switch is the start of its first case: below its header.
  if (_isOpenBlockSwitch(el) && el.nextElementSibling?.matches("li.sw-case-head:not(.sw-case-other)")) el = el.nextElementSibling;
  setInsertPoint(anchorOf(el));
  const card = document.getElementById("addManualActionCard");
  if (card?.classList.contains("collapsed")) setCardOpen(card, true);
  card?.querySelector("h3")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  if (!manualActionType.value) manualActionType.focus({ preventScroll: true });
  const row = _ghostRow();
  row.classList.remove("sw-flash");
  void row.offsetWidth;
  row.classList.add("sw-flash");
}

/** The element the dummy row follows for `anchor`: null = the top, undefined = gone. */
function _elementOf(anchor) {
  const q = (sel) => actionsEl.querySelector(sel) || undefined;
  switch (anchor.kind) {
    case "top": return null;
    case "after": return q(`li.action[data-index="${anchor.index}"]`);
    case "caseHead": return q(`li.sw-case-head[data-switch="${anchor.switchIdx}"][data-case="${anchor.caseIdx}"]:not(.sw-case-other)`);
    // A Switch / If opened since: "after its block" is its "move out" zone.
    case "outside": case "afterCollapsed": return q(`li.sw-outside[data-switch="${anchor.switchIdx}"]`);
    case "outsideCond": case "afterCollapsedCond": return q(`li.cond-outside[data-cond="${anchor.condIdx}"]`);
  }
  return undefined;
}

/** Every place the dummy row can step to with ↑ ↓, in list order: null = the top. */
function _slots() {
  const out = [null];
  for (const el of actionsEl.children) {
    if (el === ghost || el.classList.contains("sw-hidden") || el.classList.contains("sw-case-other")
      || el.matches(".action-paste-li, .action-loading, .empty")) continue;
    if (_isOpenBlockSwitch(el)) continue;   // the same place as its first case header
    if (el.matches("li.action, li.sw-case-head, li.sw-outside")) out.push(el);
  }
  return out;
}

function _nudge(dir) {
  const slots = _slots();
  const at = insertAnchor() ? slots.indexOf(ghost.previousElementSibling) : -1;
  const cur = at < 0 ? slots.length - 1 : at;
  const next = Math.max(0, Math.min(slots.length - 1, cur + dir));
  // One step down from the last place is "last": no place kept.
  if (dir > 0 && next === slots.length - 1) setInsertPoint(null);
  else setInsertPoint(anchorOf(slots[next]));
}

/** The form's action, enough to show it in the dummy row and to place it. */
function _formAction(type) {
  const a = {
    type,
    selector: manualSelector.value.trim(),
    value: manualValue.value.trim(),
    label: document.getElementById("manualLabel")?.value.trim() || "",
  };
  if (type === "condition" || type === "assert") a.conditionType = conditionType?.value || "";
  return a;
}

function _note(text) {
  const note = document.getElementById("insertPointNote");
  if (!note) return;
  note.hidden = !text;
  if (!text) { note.textContent = ""; return; }
  note.innerHTML = `<span>${escHtml(text)}</span>`
    + `<button type="button" class="insert-point-x" title="Add at the end instead" aria-label="Add at the end instead">✕</button>`;
}

/** The dummy row and the Add card's line, as the form and the place are now. */
export function renderInsertPoint() {
  const ghost = _ghostRow();
  ghost.remove();
  const type = manualActionType.value;
  const point = insertAnchor();
  const sid = scenarioList.value || null;
  if (ui.editing || (!type && !point) || swCtx.scenarioId !== sid) { _note(null); return; }
  // A Switch whose cases run actions of the list goes in front of them, wherever the place is.
  if (type === "switch" && (ui._switchCases || []).some(isBlockCase)) {
    _note(point ? "↳ A new Switch goes in front of the actions its cases run" : null);
    return;
  }
  const el = point ? _elementOf(point) : undefined;
  if (point && el === undefined) { ui.insertPoint = null; renderInsertPoint(); return; }
  if (!point) {
    const paste = actionsEl.querySelector("li.action-paste-li");
    if (paste) paste.before(ghost); else actionsEl.appendChild(ghost);
  } else if (el === null) actionsEl.prepend(ghost);
  else el.after(ghost);

  const action = _formAction(type);
  const { actions: list, index: at } = insertActions(swCtx.actions, [action], point);
  applyPlacement(ghost, list, at);
  const place = placeText(list, at);
  let value = type ? getActionDisplayValue(action).replace(/ \[skip \d+\]$/, "") : "";
  if (!value || /^\(no /.test(value)) value = action.label || value;
  const btn = (g, text, title) => `<button type="button" class="secondary" data-g="${g}" title="${title}" aria-label="${title}">${text}</button>`;
  ghost.innerHTML = `<span class="index">＋</span>`
    + `<span class="type">${getActionIcon(type)}${escHtml(type || "new")}</span>`
    + `<span class="value"><span class="value-main">${escHtml(type ? value || "(nothing filled in yet)" : "Choose an action type below")}</span>`
    + `<span class="value-sub">New action goes in at #${at + 1}${place ? ` · ${escHtml(place)}` : ""}</span></span>`
    + `<div class="btn-row">${btn("up", "↑", "Move the insertion point up")}${btn("down", "↓", "Move the insertion point down")}`
    + `${btn("end", "✕", "Add at the end instead")}</div>`;
  _note(point ? `↳ Insert at #${at + 1}${place ? ` · ${place}` : ""}` : null);
}

export function initInsertPoint() {
  document.getElementById("insertPointNote")?.addEventListener("click", (e) => {
    if (e.target.closest(".insert-point-x")) setInsertPoint(null);
  });
  // The dummy row follows what is being filled in.
  const card = document.getElementById("addManualActionCard");
  const follow = debounce(renderInsertPoint, 150);
  card?.addEventListener("input", follow);
  card?.addEventListener("change", follow);
}
