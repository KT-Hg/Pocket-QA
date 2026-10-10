/**
 * walk.js — the walk every code export makes through a scenario's actions, as
 * playback walks them: a Switch block left out whole (its cases are the
 * extension's to choose), a disabled action left out, a Condition guarding the
 * span playback skips when it fails, a step record (export/steps.js) for each
 * enabled action. Each export gives only its own lines.
 */

import { blockEnd, conditionSkip, conditionSkipTarget, hasBlock } from '../../shared/switch-blocks.js';
import { locatorsOf } from '../../shared/locator-order.js';
import { writtenVarNames } from '../../shared/var-name.js';
import { activeValue, parseRandomSpec, parsePickSpec } from '../../shared/var-spec.js';
import { getUsedVarNames } from '../utils.js';
import { blockSteps, newStep } from './steps.js';

/**
 * A scenario's variables as an export declares them, and what to warn about,
 * the same for every export:
 *   staticVars, randomSpecs, pickSpecs — by name, by what the Variables tab holds
 *   written — the identifiers (`ident`) the steps assign to
 * Into `warnings`: two names that become one `lang` identifier (one would be lost),
 * a name that is not one, and a Fallback variable, which only a Child Condition
 * resolves — anywhere else its literal spec is what reaches the page, as in a run.
 */
export function exportVariables(variables, enabled, ident, lang, warnings) {
  const staticVars = {}, randomSpecs = {}, pickSpecs = {};
  for (const [k, v] of Object.entries(variables || {})) {
    const str = activeValue(v);
    const spec = parseRandomSpec(str);
    const pick = parsePickSpec(str);
    if (spec) randomSpecs[k] = spec;
    else if (pick) pickSpecs[k] = pick;
    else staticVars[k] = str;
  }
  const written = new Set(enabled.flatMap((a) => writtenVarNames(a)).map(ident));

  const byIdent = new Map();
  for (const k of [...Object.keys(staticVars), ...Object.keys(randomSpecs), ...Object.keys(pickSpecs)]) {
    const id = ident(k);
    if (byIdent.has(id) && byIdent.get(id) !== k) {
      warnings.add(`"${byIdent.get(id)}" and "${k}" both become the ${lang} identifier \`${id}\` — rename one`);
    } else {
      byIdent.set(id, k);
    }
    if (id !== k) warnings.add(`"${k}" is not a valid ${lang} identifier — exported as \`${id}\``);
  }
  for (const [k, v] of Object.entries(staticVars)) {
    if (/^\{fallback:.+\}$/.test(v)) {
      warnings.add(`"${k}" is a Fallback variable — resolved only inside Child Conditions, literal everywhere else`);
    }
  }
  return { staticVars, randomSpecs, pickSpecs, written };
}

/**
 * Each `${name}` a step uses that neither the Variables tab (`variables`) nor a
 * step defines, in order.
 */
export function undefinedVarNames(enabled, variables) {
  const known = new Set([...Object.keys(variables || {}), ...enabled.flatMap((a) => writtenVarNames(a))]);
  return [...getUsedVarNames(enabled)].filter((name) => !known.has(name));
}

/**
 * Into `warnings`: each undefinedVarNames — the exported code fails on it when the
 * step runs, with no clue where it came from; with a `dataFile`, it is that file's
 * column of the name, and the code fails without one.
 */
export function warnUndefinedVars(enabled, variables, warnings, dataFile = '') {
  for (const name of undefinedVarNames(enabled, variables)) {
    warnings.add(dataFile
      ? `\${${name}} is not in the Variables tab: it comes from the column "${name}" of ${dataFile}`
      : `\${${name}} is used by a step but not defined in the Variables tab`);
  }
}

/** Whether `action` was recorded inside a frame: its frameId (the recording's) is not the page's, 0. */
export const inFrame = (action) => action.frameId != null && action.frameId !== 0;

/**
 * The locators of the element an action acts on — of its drop target with
 * `target` — in the order playback tries them (shared/locator-order.js), the
 * selector type chosen in the form first. Never empty: an action without any
 * keeps the empty CSS selector it always exported.
 */
export function locatorsFor(action, target = false) {
  const locs = target
    ? locatorsOf(action.targetSelectors, action.targetSelector, action.targetSelectorType)
    : locatorsOf(action.selectors, action.selector, action.selectorType);
  return locs.length ? locs : [{ type: 'css', value: '' }];
}

/**
 * The lines of the steps of `ctx.all`, from `gen`:
 *   step(action, step)          → the lines of an action that is not a Condition
 *   conditionHead(action, step) → the lines that open a Condition's block
 *   conditionBody(lines)        → its body's lines, indented, and what closes it
 *   skippedBlock(start, end)    → the lines left for a Switch block (0-based, inclusive)
 *   at(title)                   → optional: the line that records which step runs
 *                                 ("Step 3: click — Sign in"), for the error to name it
 * Each step's lines are followed by an empty one. ctx: { all, layout, steps, warnings, frames }
 * (frames: newStep's, where the export looks for an element recorded in a frame).
 */
export function walkActions(ctx, gen) {
  return walk(ctx, gen, 0, ctx.all.length);
}

// The comment that opens a step's lines: "// Step 3: click — Sign in", "# Step 3: …".
const STEP_COMMENT = /^(?:\/\/|#) (Step \d+: .*)$/;

/**
 * `lines` with gen.at's line after the step's opening comment — for a step whose
 * code runs: a skipped one has none.
 */
function withAt(gen, step, lines) {
  const title = STEP_COMMENT.exec(lines[0] ?? '')?.[1];
  if (!gen.at || !title || step.status === 'skip') return lines;
  return [lines[0], gen.at(title), ...lines.slice(1)];
}

function walk(ctx, gen, from, to) {
  const out = [];
  let i = from;
  while (i < to) {
    const action = ctx.all[i];
    // A Switch block only ever runs one of its cases; emitting it would run every case in a row.
    if (hasBlock(action)) {
      const end = blockEnd(ctx.all, i);
      out.push(...gen.skippedBlock(i, end), '');
      ctx.warnings.add(`Switch block at step ${i + 1} skipped together with its ${end - i} action(s)`);
      ctx.steps.push(...blockSteps(ctx.all, i, end));
      i = end + 1;
      continue;
    }
    if (action.disabled) {
      i++;
      continue;
    }
    const step = newStep(action, i + 1, ctx.frames);
    ctx.steps.push(step);
    if (action.type !== 'condition') {
      out.push(...withAt(gen, step, gen.step(action, step)), '');
      i++;
      continue;
    }
    // The same span playback skips (0 actions for an emptied Condition): a Switch
    // and its block count as one action, and it ends where the enclosing body ends.
    const bodyEnd = conditionSkipTarget(ctx.all, i, conditionSkip(action), ctx.layout);
    out.push(...withAt(gen, step, gen.conditionHead(action, step)));
    out.push(...gen.conditionBody(walk(ctx, gen, i + 1, Math.min(bodyEnd, to))), '');
    i = Math.max(i + 1, bodyEnd);
  }
  return out;
}
