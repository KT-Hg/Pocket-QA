/**
 * playback/steps/assert.js — Assert: a Condition's check that must hold. It is
 * checked again until it does, for up to ASSERT_WAIT_MS — a page that is still
 * loading what it checks is not a failure. A false one is recorded and the run
 * goes on, with no prompt, so a CSV or scheduled run never waits for a click.
 */

import { state } from '../../state.js';
import { tabMsg } from '../../tabs.js';
import { afterFailure } from './flow.js';

// The same wait an action gives its element (content.js findElementWithFallback).
const ASSERT_WAIT_MS = 5_000;
const ASSERT_POLL_MS = 250;
// How long the page gets to evaluate one check, as for a Condition.
const CHECK_TIMEOUT_MS = 10_000;

// Checks that pass or fail on whether the element is there: one not found is the
// answer, not a test that could not run.
const PRESENCE_TYPES = new Set(['elementExists', 'elementNotExists', 'elementVisible', 'elementHidden']);

// What each type expected, for the failure line.
const EXPECTED = {
  elementExists:    () => 'element to exist',
  elementNotExists: () => 'element not to exist',
  elementVisible:   () => 'element to be visible',
  elementHidden:    () => 'element to be hidden',
  textContains:     (v) => `text containing "${v}"`,
  textEquals:       (v) => `text "${v}"`,
  valueContains:    (v) => `value containing "${v}"`,
  valueEquals:      (v) => `value "${v}"`,
  urlContains:      (v) => `URL containing "${v}"`,
  urlEquals:        (v) => `URL "${v}"`,
  hasClass:         (v) => `class "${v}"`,
  hasAttribute:     (v) => `attribute ${v}`,
};

/**
 * The page's answer once the check holds, the page gave an error, or the wait
 * is over; null when the run was stopped meanwhile.
 */
async function _checkUntilHeld(ctx, msg, frameId) {
  const deadline = Date.now() + ASSERT_WAIT_MS;
  for (;;) {
    const res = (await tabMsg(ctx.tabId, msg, CHECK_TIMEOUT_MS, frameId)) || {};
    if (!state.playback.active || ctx.tabClosed) return null;
    // An error the page gave (an unknown type, an exception) will not go away by
    // waiting; a page between documents may still come back.
    if (res.result || (res.error && !res._noContentScript) || Date.now() >= deadline) return res;
    await new Promise((r) => setTimeout(r, ASSERT_POLL_MS));
  }
}

/** A false check as [reason, facts] for its failure record (facts.kind: shared/verdict.js). */
function _falseCheck(type, expected, res) {
  if (res.found === false && !PRESENCE_TYPES.has(type)) return ['Element not found — could not check', { kind: 'broken' }];
  if (res.secret) return ['Expected the value of a password field to match', { kind: 'assert' }];
  if (res.actual === undefined) return [`Expected ${EXPECTED[type](expected)}`, { kind: 'assert', expected }];
  return [`Expected ${EXPECTED[type](expected)}, got "${res.actual}"`, { kind: 'assert', expected, actual: res.actual }];
}

export async function runAssert(ctx, i, action) {
  const type = action.conditionType || 'elementExists';
  const msg = {
    type: 'CHECK_CONDITION', conditionType: type,
    selector: action.selector || '', selectors: action.selectors || null, expectedValue: action.expectedValue || '',
    ...(action.selectorType ? { selectorType: action.selectorType } : {}),
  };
  const res = await _checkUntilHeld(ctx, msg, action.frameId);
  if (res === null) return i;
  if (res.error) {
    const reason = res._noContentScript ? 'Content script not reachable' : `Assert: ${res.error}`;
    const back = afterFailure(await ctx.fail(i, action, reason), i);
    if (back !== null) return back;
  } else if (!res.result) {
    ctx.recordFail(i, action, ..._falseCheck(type, msg.expectedValue, res));
  }
  if (action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  return i;
}
