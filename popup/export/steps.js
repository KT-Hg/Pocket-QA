/**
 * steps.js — what a code export reports for each enabled action it was given:
 * exported as is ('ok'), exported but to be checked by hand ('verify'), or left
 * out ('skip'), with the reason. The export modal's Actions tab, its counts and
 * its warning bar read these records, so none of them can say "✓ OK" for a step
 * the generated code left out.
 *
 * A record is { n, type, status, reason }: n is the action's 1-based position in
 * the scenario, the number the generated code's "Step n" comments use.
 */

const RANK = { ok: 0, verify: 1, skip: 2 };

/**
 * Raise `step` to `status` for `reason`. A lower status never replaces a higher
 * one; a second reason for the same status is added to the first.
 */
export function mark(step, status, reason) {
  if (RANK[status] > RANK[step.status]) Object.assign(step, { status, reason });
  else if (status === step.status && reason && !step.reason.includes(reason)) step.reason = `${step.reason}; ${reason}`;
}

/**
 * The record for `action` at 1-based `n`, before the generator marks it.
 * `frames`: where the export looks for an element of an action recorded inside a
 * frame (action.frameId, a number of the recording, of no use to the export):
 * 'all' (the page and its frames: Selenium, Playwright), 'same-origin' (the page
 * and the frames a script of it may read: the bookmarklet), or 'none' (the page
 * only). A Condition's or an Assert's element is looked for the same way; a URL one
 * is checked on the top page's URL, where playback checks its frame's.
 */
export function newStep(action, n, frames = 'none') {
  const step = { n, type: action.type, status: 'ok', reason: '' };
  const urlCondition = (action.type === 'condition' || action.type === 'assert') && String(action.conditionType || '').startsWith('url');
  if (action.frameId == null || action.frameId === 0 || (frames === 'all' && !urlCondition)) return step;
  let why = 'recorded inside an iframe — the export looks in the top page';
  if (urlCondition) why = "recorded inside an iframe — the export checks the top page's URL, not the frame's";
  else if (frames === 'same-origin') why = 'recorded inside an iframe — a bookmarklet reaches only the frames of its own site (same origin)';
  mark(step, 'verify', why);
  return step;
}

/** Skipped records for a Switch block at `start` and the enabled actions in it, up to `end` (0-based). */
export function blockSteps(all, start, end) {
  const out = [];
  for (let j = start; j <= end; j++) {
    if (!all[j] || all[j].disabled) continue;
    out.push({
      n: j + 1, type: all[j].type, status: 'skip',
      reason: j === start
        ? 'a Switch block plays one case, which only the extension can choose'
        : `inside the Switch block at step ${start + 1}`,
    });
  }
  return out;
}
