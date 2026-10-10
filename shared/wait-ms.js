/**
 * wait-ms.js — how long a Wait action pauses, in ms.
 *
 * `delay` first, the same order the popup's preview and editor read it in. Only
 * old actions (and "save sequence as scenario" ones) keep the duration in
 * `value`; one carrying both used to show one duration and wait another.
 *
 * Pure — no chrome.*.
 */

export function waitMs(action) {
  const ms = parseInt(action.delay || action.value || 500, 10);
  return isNaN(ms) ? 500 : ms;
}
