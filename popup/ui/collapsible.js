/**
 * ui/collapsible.js — collapsible cards and their saved state.
 */

import { manualActionType } from '../dom.js';

// The card is open before the form redraws for it.
const AFTER_OPEN_MS = 50;

/* === COLLAPSIBLE CARDS === */
export const COLLAPSIBLE_STATE_KEY = "collapsibleStates";

// Save collapsible state
function saveCollapsibleState(cardId, isOpen) {
  chrome.storage.local.get([COLLAPSIBLE_STATE_KEY], (res) => {
    const states = res?.[COLLAPSIBLE_STATE_KEY] || {};
    states[cardId] = isOpen ? "open" : "closed";
    chrome.storage.local.set({ [COLLAPSIBLE_STATE_KEY]: states });
  });
}

/**
 * Open or close a card. Its header's aria-expanded turns the chevron (.chev),
 * so code that opens a card (a restored draft, a pick) goes through here too.
 */
export function setCardOpen(card, open) {
  if (!card) return;
  card.classList.toggle("collapsed", !open);
  card.querySelector("h3")?.setAttribute("aria-expanded", String(open));
}

function _toggleCollapsibleCard(h3) {
  const card = h3.closest(".card.collapsible");
  const isExpanded = card.classList.contains("collapsed");
  setCardOpen(card, isExpanded);

  if (card.id) {
    saveCollapsibleState(card.id, isExpanded);
  }

  if (isExpanded && card.querySelector("#manualActionType")) {
    setTimeout(() => { manualActionType.dispatchEvent(new Event("change")); }, AFTER_OPEN_MS);
  }
}

export function initCollapsible() {
  // Load saved collapsible states
  chrome.storage.local.get([COLLAPSIBLE_STATE_KEY], (res) => {
    const states = res?.[COLLAPSIBLE_STATE_KEY] || {};

    // Apply saved states to main cards — "closed" too: a card that starts open
    // (Add Manual Action) would otherwise reopen every time the popup does.
    document.querySelectorAll(".card.collapsible").forEach((card) => {
      const saved = card.id ? states[card.id] : undefined;
      if (saved !== "open" && saved !== "closed") return;
      setCardOpen(card, saved === "open");

      // Trigger specific logic for opened cards
      if (saved === "open" && card.querySelector("#manualActionType")) {
        setTimeout(() => manualActionType?.dispatchEvent(new Event("change")), AFTER_OPEN_MS);
      }
    });
  });
  document.querySelectorAll(".card.collapsible h3").forEach((h3) => {
    // Ensure all collapsible headers are keyboard-focusable
    if (!h3.hasAttribute("tabindex")) h3.setAttribute("tabindex", "0");
    // Sync aria-expanded with initial CSS state
    const card = h3.closest(".card.collapsible");
    h3.setAttribute("aria-expanded", String(!card.classList.contains("collapsed")));
    h3.setAttribute("role", "button");

    h3.addEventListener("click", (e) => {
      if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT") return;
      _toggleCollapsibleCard(h3);
    });

    h3.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        _toggleCollapsibleCard(h3);
      }
    });
  });
}
