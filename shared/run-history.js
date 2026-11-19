/**
 * run-history.js — the last runs of each scenario (RUN_HISTORY_KEY in storage:
 * { [scenarioId]: [entry, …] }, oldest first), and what they say together.
 *
 * bg/playback.js adds an entry when a Play, a scheduled run, a Resume, a
 * scenario of a Sequence or a CSV run ends; the Last run card shows them as dots
 * (popup/run/run-history.js). Two of them read the runs together:
 *   flaky — failing after a pass, and passing again after a failure, while the
 *           steps stayed the same (`fp`, the fingerprint of the actions played);
 *   broke — failing every time since a given run, after passing before it.
 * A CSV run fails on its data as much as on the page: it is shown, never read
 * together with the others.
 *
 * Pure — no chrome.*.
 */

// The runs kept per scenario.
export const HISTORY_MAX = 20;
// The runs the card shows, and reads together.
export const HISTORY_WINDOW = 10;
const LABEL_MAX = 60;
const REASON_MAX = 200;

/** A short fingerprint of a scenario's actions: two runs with the same one played the same steps. */
export function actionsPrint(actions) {
  const s = JSON.stringify(actions || []);
  let h = 0x811c9dc5; // FNV-1a, 32 bits
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/**
 * One run as the history keeps it, ~200 bytes. `how`: 'play' | 'schedule' |
 * 'resume' | 'sequence' | 'csv'; `verdict` as shared/verdict.js gives it (and
 * `checks` when known); `failures` the run's, the first one kept; `actions` the
 * scenario's as played; `rows` a CSV run's tally.
 */
export function historyEntry({ how, startedAt, endedAt, verdict, failures = [], actions, rows = null }) {
  const f = failures[0];
  return {
    how, startedAt, endedAt, status: verdict.status,
    ...(verdict.asserts ? { asserts: verdict.asserts } : {}),
    ...(verdict.broken ? { broken: verdict.broken } : {}),
    ...(typeof verdict.checks === 'number' ? { checks: verdict.checks } : {}),
    ...(f ? {
      first: {
        index: f.index, kind: f.kind === 'assert' ? 'assert' : 'broken',
        label: String(f.label || f.type || '').slice(0, LABEL_MAX), reason: String(f.reason || '').slice(0, REASON_MAX),
        ...(f.scenarioId ? { scenarioId: f.scenarioId } : {}),
        ...(f.row != null ? { row: f.row } : {}),
      },
    } : {}),
    fp: actionsPrint(actions),
    ...(rows ? { rows } : {}),
  };
}

/**
 * `all` with `entry` added to `scenarioId`'s runs (the last HISTORY_MAX kept);
 * the runs of a scenario not in `liveIds` (deleted) are dropped on the way.
 */
export function pushHistory(all, scenarioId, entry, liveIds = null) {
  const out = {};
  for (const [id, list] of Object.entries(all || {})) {
    if (Array.isArray(list) && (!liveIds || liveIds.has(id))) out[id] = list;
  }
  out[scenarioId] = [...(out[scenarioId] || []), entry].slice(-HISTORY_MAX);
  return out;
}

const _bad = (e) => e.status === 'failed' || e.status === 'broken';

/** The step most of `runs` failed on first: { index, label, count }, or null. */
function _usualStep(runs) {
  const counts = new Map();
  for (const e of runs) {
    if (!_bad(e) || !e.first) continue;
    const key = `${e.first.scenarioId || ''}#${e.first.index}`;
    const c = counts.get(key) || { index: e.first.index, label: e.first.label, count: 0 };
    c.count++;
    counts.set(key, c);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0] || null;
}

/**
 * What the last HISTORY_WINDOW runs say together. Stopped runs are left out (a
 * Stop says nothing of the page), and so are CSV runs (see the top of the file).
 * { kind: 'flaky' | 'broke' | null, runs, failed } and, for flaky, `step` (the
 * step it fails on most, with how often), for broke, `since` (the first failing
 * run's end), `inRow` and `passedBefore`.
 */
export function historyVerdict(entries) {
  const runs = (entries || []).filter((e) => e.status !== 'stopped' && !e.rows).slice(-HISTORY_WINDOW);
  const failed = runs.filter(_bad).length;
  const base = { runs: runs.length, failed };
  if (runs.length < 3 || !failed) return { ...base, kind: null };
  // Flaky: a run failed after one that passed, and one passed again after one that
  // failed, both with the same steps — a pass that needed no edit.
  let falls = 0, recoveries = 0;
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].fp !== runs[i - 1].fp) continue;
    if (_bad(runs[i]) && !_bad(runs[i - 1])) falls++;
    if (!_bad(runs[i]) && _bad(runs[i - 1])) recoveries++;
  }
  if (falls && recoveries) return { ...base, kind: 'flaky', step: _usualStep(runs) };
  let inRow = 0;
  while (inRow < runs.length && _bad(runs[runs.length - 1 - inRow])) inRow++;
  let passedBefore = 0;
  for (let i = runs.length - 1 - inRow; i >= 0 && !_bad(runs[i]); i--) passedBefore++;
  if (inRow >= 2 && passedBefore >= 2) {
    return { ...base, kind: 'broke', since: runs[runs.length - inRow].endedAt, inRow, passedBefore };
  }
  return { ...base, kind: null };
}
