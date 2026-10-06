/**
 * state.js — Shared mutable state across popup modules.
 *
 * A single plain object exported as a named reference so all modules share
 * the same instance. No store pattern — mutate fields directly, load functions
 * read from background storage and write back here.
 *
 * Only connection.js uses it today. The Record & Play / Data state (scenario and
 * folder caches, the action being edited, clipboards, the CSV run, schedules…)
 * is `ui` in ui-state.js. That UI keeps its own `activatedTabs`
 * (tab-activation.js) and `ui.connectionCheckInterval`, separate from the fields
 * below, and nothing assigns to `currentTabId` here — so
 * checkContentScriptConnection() returns early.
 */

export const state = {
  currentTabId: null,
  activatedTabs: new Set(),
  connectionRetryCount: 0,
  connectionCheckInterval: null,
};
