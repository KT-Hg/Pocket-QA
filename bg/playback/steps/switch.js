/**
 * playback/steps/switch.js — Switch: a variable picks the case — a block of this scenario,
 * a jump within it, or another scenario.
 */

import {
  hasBlock, isBlockCase, caseRange, blockEnd, continueIndex, validateSwitch,
} from '../../../shared/switch-blocks.js';
import { state } from '../../state.js';
import { getScenarios } from '../../storage.js';
import { sendAlertNotification } from '../../notify.js';
import { FAIL_RETRY, FAIL_STOP } from '../failure-prompt.js';
import { STOP } from './flow.js';

// Switch case target meaning "the scenario currently playing": the case jumps to
// its startAt action in place instead of running a nested scenario.
const SWITCH_SELF    = '__self__';
const MAX_SELF_JUMPS = 1000;

export async function runSwitch(ctx, i, action) {
  const { actions, fail, resolvedVars, layout: _layout } = ctx;
  // A block Switch owns the actions after it: only the matched case's
  // range runs, then playback goes on at continueAt. Without a block
  // every path below is the old one.
  const block = !!_layout && hasBlock(action);
  if (block) {
    const { errors } = validateSwitch(actions, i, _layout);
    if (errors.length) {
      const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
      const next = await fail(i, action, `Switch: ${errors[0]}${more}`, 'Invalid Switch block');
      if (next === FAIL_RETRY) return i - 1;
      if (next === FAIL_STOP) return STOP;
      i = blockEnd(actions, i); // skipped: leave the block without running any of it
      return i;
    }
  }
  const contIdx = block ? continueIndex(actions, i) : null;

  const switchVal = action.switchVar || '';
  const cases     = action.cases || [];
  let matched     = cases.find(c => c.value === switchVal);
  if (!matched) matched = cases.find(c => c.value === '__default__');
  // 1-based "start at action #N" on the case; absent on older cases = 1.
  const startIdx  = Math.max(0, (parseInt(matched?.startAt, 10) || 1) - 1);
  // 1-based last action of the case's range; absent = play on to the end.
  const endRaw    = parseInt(matched?.endAt, 10);
  const endIdx    = Number.isFinite(endRaw) ? endRaw - 1 : null;
  if (matched && isBlockCase(matched)) {
    // Play just this case's actions. A nested Switch at the end of the
    // range that jumps past it simply ends this run; this Switch's
    // continueAt then applies.
    const range = caseRange(matched);
    if (range) {
      const nestedVars = await ctx.playNested(actions, { ...resolvedVars }, range.start, range.end);
      Object.assign(resolvedVars, nestedVars);
      if (!state.playback.active || ctx.tabClosed) return STOP;
    }
  } else if (matched?.scenarioId === SWITCH_SELF) {
    // Jump within the scenario being played: no nested run, just move i.
    // A backward jump is a loop, so cap the hops — a case that always
    // matches would otherwise spin forever.
    if (startIdx >= actions.length) {
      const next = await fail(i, action, `Switch: action #${startIdx + 1} does not exist (scenario has ${actions.length})`, 'Jump target out of range');
      if (next === FAIL_RETRY) return i - 1;
      if (next === FAIL_STOP) return STOP;
    } else if (++ctx.selfJumps > MAX_SELF_JUMPS) {
      const next = await fail(i, action, `Switch: more than ${MAX_SELF_JUMPS} jumps — possible infinite loop, continuing without jumping`, 'Jump limit exceeded');
      if (next === FAIL_RETRY) return i - 1;
      if (next === FAIL_STOP) return STOP;
    } else {
      if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
      i = startIdx - 1; // the loop's i++ lands on startIdx
      return i;
    }
  } else if (matched?.scenarioId) {
    const scenarios      = await getScenarios();
    const targetScenario = scenarios[matched.scenarioId];
    const targetLen      = targetScenario?.actions?.length || 0;
    if (targetLen && startIdx >= targetLen) {
      const next = await fail(i, action, `Switch: "${targetScenario.name || matched.scenarioId}" has no action #${startIdx + 1} (only ${targetLen})`, 'Switch start action out of range');
      if (next === FAIL_RETRY) return i - 1;
      if (next === FAIL_STOP) return STOP;
    } else if (targetLen && endIdx != null && (endIdx >= targetLen || endIdx < startIdx)) {
      const next = await fail(i, action, `Switch: "${targetScenario.name || matched.scenarioId}" has no range #${startIdx + 1}–#${endIdx + 1} (only ${targetLen})`, 'Switch range out of range');
      if (next === FAIL_RETRY) return i - 1;
      if (next === FAIL_STOP) return STOP;
    } else if (targetLen) {
      const caseLabel    = matched.value === '__default__' ? 'default' : matched.value;
      const switchedName = targetScenario.name || matched.scenarioId;
      const parentName   = state.playback.scenarioName;
      const parentTotal  = state.playback.totalActions;
      state.playback.scenarioName  = switchedName;
      state.playback.actionIndex   = startIdx;
      state.playback.totalActions  = targetScenario.actions.length;
      chrome.runtime.sendMessage({ type: 'SWITCH_SCENARIO', scenarioName: switchedName, caseLabel }).catch(() => {});
      if (!state.csvPlayback.active) {
        // Same reasoning as action_failed: a scenario can switch many times
        // in one run, and only the most recent hop is worth showing.
        sendAlertNotification('🔀 Scenario Switched', `[${caseLabel}] → "${switchedName}"`, 'scenario_switched');
      }
      // Pass a copy of vars so the nested scenario cannot mutate the parent's
      // variable map; merge returned vars back after completion.
      //
      // failedActions, by contrast, is shared with the nested run rather than
      // dropped: a failure is a failure whichever scenario it happened in.
      // Passing null here meant a switch branch could fail every one of its
      // actions and still be reported as a clean run — a CSV row with only
      // nested failures counted as passed, and its exported `failures` list
      // came back empty.
      //
      // endIdx limits the branch to a range of the target when the case has one.
      const nestedVars = await ctx.playNested(targetScenario.actions, { ...resolvedVars }, startIdx, endIdx, matched.scenarioId);
      Object.assign(resolvedVars, nestedVars);
      // Back in this scenario: progress counts its actions again, not the branch's.
      state.playback.scenarioName = parentName;
      state.playback.totalActions = parentTotal;
    } else {
      const next = await fail(i, action, `Switch: scenario "${matched.scenarioName || matched.scenarioId}" not found or has no actions`);
      if (next === FAIL_RETRY) return i - 1;
      if (next === FAIL_STOP) return STOP;
    }
  } else if (!block) {
    // A block Switch with no matching case simply runs none of its cases.
    const next = await fail(i, action, `Switch: no case matched value "${switchVal}" and no default case set`);
    if (next === FAIL_RETRY) return i - 1;
    if (next === FAIL_STOP) return STOP;
  }
  if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
  if (block) {
    // Leave the block — whatever ran (or failed and was skipped) above,
    // the other cases' actions must not run. A backward continueAt is a
    // loop and shares the jump cap.
    if (contIdx <= i && ++ctx.selfJumps > MAX_SELF_JUMPS) {
      const next = await fail(i, action, `Switch: more than ${MAX_SELF_JUMPS} jumps — possible infinite loop, leaving the block`, 'Jump limit exceeded');
      if (next === FAIL_STOP) return STOP;
      i = blockEnd(actions, i);
    } else {
      i = contIdx - 1; // the loop's i++ lands on continueAt
    }
  }
  return i;
}
