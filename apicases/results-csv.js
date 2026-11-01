/**
 * results-csv.js — the last result of each case of a folder (or of all) as a
 * CSV file for a report: one row per case, in list order, written for Excel
 * (shared/file-export.js). The URL is the one sent, its secret query values
 * masked as the kept result has them; a case not run yet shows its URL as
 * written, masked the same way.
 *
 * Pure — no chrome.*, no DOM.
 */

import { maskUrl } from '../shared/api-request.js';
import { csvText } from '../shared/file-export.js';
import { ALL } from './model.js';

const HEAD = ['Folder', 'Name', 'Method', 'URL', 'Result', 'Status', 'Time (ms)', 'Failed checks', 'Ran at'];
const RESULT = { passed: 'Passed', failed: 'Failed', broken: 'Broken' };

const pad = (n) => String(n).padStart(2, '0');
/** "2026-11-01 17:38:05", local time: what Excel reads as a date and time. */
export function localTime(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function row(c, folderName) {
  const l = c.last;
  if (!l) return [folderName, c.name, c.method, maskUrl(c.url), 'Not run', '', '', '', ''];
  return [
    folderName, c.name, l.sent?.method || c.method, l.sent?.url || maskUrl(c.url), RESULT[l.verdict],
    l.status ?? '', l.ms ?? '', l.failures.map((f) => f.reason).join('\n'), localTime(l.at),
  ];
}

/** The CSV of the folder `folderId` (or of every case, for ALL). */
export function resultsCsv(state, folderId = ALL) {
  const names = Object.fromEntries(state.folders.map((f) => [f.id, f.name]));
  const cases = state.cases.filter((c) => folderId === ALL || c.folderId === folderId);
  return csvText([HEAD, ...cases.map((c) => row(c, names[c.folderId] || ''))]);
}

/** `Shop results 2026-11-01.csv`. */
export function resultsFileName(state, folderId = ALL, now = Date.now()) {
  const name = folderId === ALL ? 'API Tests' : state.folders.find((f) => f.id === folderId)?.name || 'API Tests';
  return `${name.replace(/[\\/:*?"<>|]+/g, '_').trim()} results ${localTime(now).slice(0, 10)}.csv`;
}
