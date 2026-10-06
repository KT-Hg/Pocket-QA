/**
 * ui/collapsible.js — collapsible cards and sub-cards, and their saved state.
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

function _toggleCollapsibleCard(h3) {
  const card = h3.closest(".card.collapsible");
  card.classList.toggle("collapsed");
  const isExpanded = !card.classList.contains("collapsed");
  h3.setAttribute("aria-expanded", String(isExpanded));

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

    // Apply saved states to main cards
    document.querySelectorAll(".card.collapsible").forEach((card) => {
      const cardId = card.id;
      if (cardId && states[cardId] === "open") {
        card.classList.remove("collapsed");

        // Trigger specific logic for opened cards
        if (card.querySelector("#manualActionType")) {
          setTimeout(() => manualActionType?.dispatchEvent(new Event("change")), AFTER_OPEN_MS);
        }
      }
    });

    // Apply saved states to sub-cards
    document.querySelectorAll(".sub-card").forEach((subCard) => {
      const subCardId = subCard.querySelector("h4")?.textContent?.trim() || "";
      if (subCardId && states[`sub-${subCardId}`] === "open") {
        subCard.classList.remove("collapsed");
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
  // Handle nested sub-card collapsible (Variables sub-card)
  document.querySelectorAll(".sub-card h4").forEach((h4) => {
    if (!h4.hasAttribute("tabindex")) h4.setAttribute("tabindex", "0");
    h4.setAttribute("role", "button");
    const subCard = h4.closest(".sub-card");
    h4.setAttribute("aria-expanded", String(!subCard.classList.contains("collapsed")));

    function _toggleSubCard() {
      subCard.classList.toggle("collapsed");
      const isExpanded = !subCard.classList.contains("collapsed");
      h4.setAttribute("aria-expanded", String(isExpanded));
      const subCardId = `sub-${h4.textContent?.trim() || ""}`;
      saveCollapsibleState(subCardId, isExpanded);
    }

    h4.addEventListener("click", (e) => {
      if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT") return;
      _toggleSubCard();
    });

    h4.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        _toggleSubCard();
      }
    });
  });
}
