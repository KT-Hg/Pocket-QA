/**
 * time-format.js — the `YYYY-MM-DD_HH-MM-SS` stamp in local time.
 *
 * One spelling for every place that writes it at run time: the `datetime` random
 * variable, its preview in the export dialogs, screenshot file names and the CSV
 * result file names. The bookmarklet export emits the same format as generated
 * code (see makeRandomFn in popup/export-bookmarklet.js), which stays a string.
 *
 * Pure — no chrome.*.
 */

const pad2 = (n) => String(n).padStart(2, '0');

/** `2026-01-15_09-05-07` for the given Date, in local time. */
export function formatStamp(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + `_${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`;
}
