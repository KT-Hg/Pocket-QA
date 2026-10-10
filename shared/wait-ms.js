/**
 * wait-ms.js — how long a Wait action pauses, in ms.
 *
 * `delay` first, the same order the popup's preview and editor read it in. Only
 * old actions (and "save sequence as scenario" ones) keep the duration in
 * `value`; one carrying both used to show one duration and wait another.
 *
 * Always a whole number of ms, never below 0, since setTimeout waits no less: the
 * exports write it into code, and an imported scenario can hold anything there.
 *
 * Pure — no chrome.*.
 */

export function waitMs(action) {
  const ms = parseInt(action.delay || action.value || 500, 10);
  return isNaN(ms) ? 500 : Math.max(0, ms);
}
