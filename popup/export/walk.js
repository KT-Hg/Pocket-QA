/**
 * walk.js — the walk every code export makes through a scenario's actions, as
 * playback walks them: a Switch block left out whole (its cases are the
 * extension's to choose), a disabled action left out, a Condition guarding the
 * span playback skips when it fails, a step record (export/steps.js) for each
 * enabled action. Each export gives only its own lines.
 */

import {
  blockEnd, caseRange, conditionSkip, conditionSkipTarget, hasBlock, isBlockCase, validateSwitch,
} from '../../shared/switch-blocks.js';
import { locatorsOf } from '../../shared/locator-order.js';
import { normalizeVarName, writtenVarNames } from '../../shared/var-name.js';
import { patternVarNames } from '../../shared/text-pattern.js';
import { activeValue, parseRandomSpec, parsePickSpec } from '../../shared/var-spec.js';
import { commentText, getUsedVarNames } from '../utils.js';
import { blockSteps, newStep } from './steps.js';

/**
 * The item a Dropdown step chose, for the "dropdown → item #…" comment every
 * export writes: the pick index on one line (commentText, so a newline or control
 * character in it cannot break the comment), or ? when there is none.
 */
export const pickLabel = (action) => commentText(String(action.pick?.index ?? '?').replace(/\s+/g, ' '));

/**
 * The paths an Upload File action hands the page, as playback joins them
 * (bg/playback/steps/upload.js): the folder (its trailing separators dropped)
 * joined to each file name with the folder's own separator. null when there is no
 * folder or no name. Each export escapes them its own way.
 */
export function uploadPaths(action) {
  const folder = String(action.folderPath || '').replace(/[/\\]+$/, '');
  let names = [];
  if (Array.isArray(action.fileNames) && action.fileNames.length) names = action.fileNames;
  else if (action.fileName) names = [action.fileName];
  if (!folder || !names.length) return null;
  const sep = folder.includes('\\') ? '\\' : '/';
  return names.map((name) => `${folder}${sep}${name}`);
}

/**
 * What a Read DOM step writes: `whole` is its "Save to var" name through `ident`
 * (the export's identifier rule), or dom_var when it has neither a save name nor a
 * pattern; `slots` are the raw ${name}s of its pattern.
 */
export function readTargets(action, ident) {
  const slots = action.pattern ? patternVarNames(action.pattern) : [];
  const vn = normalizeVarName(action.varName);
  const whole = vn ? ident(vn) : (slots.length ? null : 'dom_var');
  return { whole, slots };
}

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
 *   switchLines(action, step, branches) → optional: the lines of a Switch block written
 *                                 as branches (switchAsBranches): branches are
 *                                 [{ value, isDefault, body }] in the cases' order
 *   at(title)                   → optional: the line that records which step runs
 *                                 ("Step 3: click — Sign in"), for the error to name it
 *   top(n, lines)               → optional: the lines of step n of the top level (a whole
 *                                 Condition or Switch block with what it holds)
 * step() gets a third argument: whether the action is of the top level.
 * Each step's lines are followed by an empty one. ctx: { all, layout, steps, warnings, frames }
 * (frames: newStep's, where the export looks for an element recorded in a frame).
 */
export function walkActions(ctx, gen) {
  return walk(ctx, gen, 0, ctx.all.length, true);
}

/**
 * The 0-based indices of the actions a walk meets at its top level: outside any
 * Condition's body and any Switch block (its Switch itself is one of them).
 */
export function topLevelIndices(all, layout) {
  const out = [];
  for (let i = 0; i < all.length;) {
    const a = all[i];
    out.push(i);
    if (hasBlock(a)) i = blockEnd(all, i) + 1;
    else if (a.type === 'condition' && !a.disabled) i = Math.max(i + 1, conditionSkipTarget(all, i, conditionSkip(a), layout));
    else i++;
  }
  return out;
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

/**
 * Whether the Switch at `i` can be written as branches on its variable's value:
 * a block whose every case is a range of this scenario (or emptied), resuming
 * right after it (no "Continue at" of its own), that validateSwitch finds no error
 * in — what playback then does is only "run the matching case's actions". A case
 * that jumps or plays another scenario needs the extension.
 */
export function switchAsBranches(all, i, layout) {
  const a = all[i];
  return hasBlock(a) && !a.disabled && a.cases.every(isBlockCase)
    && (a.continueAt == null || String(a.continueAt).trim() === '')
    && validateSwitch(all, i, layout).errors.length === 0;
}

/**
 * The Switch at `i` as gen.switchLines' branches: each case's range walked as its
 * own body (in the order of the ranges, so the step records keep the scenario's
 * order); an action of the block in no case never runs (a skipped record).
 */
function switchBranches(ctx, gen, i, step) {
  const action = ctx.all[i];
  const end = blockEnd(ctx.all, i);
  const first = ctx.steps.length;
  const bodies = new Map();
  const ranged = action.cases.map((c, k) => ({ k, range: caseRange(c) })).filter((x) => x.range)
    .sort((p, q) => p.range.start - q.range.start);
  for (const { k, range } of ranged) bodies.set(k, walk(ctx, gen, range.start, range.end + 1));
  for (let j = i + 1; j <= end; j++) {
    if (ctx.all[j].disabled || ranged.some(({ range }) => j >= range.start && j <= range.end)) continue;
    ctx.steps.push({ n: j + 1, type: ctx.all[j].type, status: 'skip', reason: `in the Switch block at step ${i + 1}, in none of its cases: it never runs` });
  }
  ctx.steps.splice(first, Infinity, ...ctx.steps.slice(first).sort((p, q) => p.n - q.n));
  const branches = action.cases.map((c, k) => ({ value: c.value, isDefault: c.value === '__default__', body: bodies.get(k) || [] }));
  return withAt(gen, step, gen.switchLines(action, step, branches));
}

function walk(ctx, gen, from, to, top = false) {
  const out = [];
  // Step n's lines and the empty line after them, through gen.top at the top level.
  const put = (n, lines) => out.push(...(top && gen.top ? gen.top(n, lines) : lines), '');
  let i = from;
  while (i < to) {
    const action = ctx.all[i];
    // A Switch block runs the case its variable picks: branches on the value where the
    // export can write them (switchAsBranches), else left out whole — emitted as it
    // is, it would run every case in a row.
    if (hasBlock(action) && gen.switchLines && switchAsBranches(ctx.all, i, ctx.layout)) {
      const step = newStep(action, i + 1, ctx.frames);
      ctx.steps.push(step);
      put(i + 1, switchBranches(ctx, gen, i, step));
      i = blockEnd(ctx.all, i) + 1;
      continue;
    }
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
      put(i + 1, withAt(gen, step, gen.step(action, step, top)));
      i++;
      continue;
    }
    // The same span playback skips (0 actions for an emptied Condition): a Switch
    // and its block count as one action, and it ends where the enclosing body ends.
    const bodyEnd = conditionSkipTarget(ctx.all, i, conditionSkip(action), ctx.layout);
    put(i + 1, [...withAt(gen, step, gen.conditionHead(action, step)), ...gen.conditionBody(walk(ctx, gen, i + 1, Math.min(bodyEnd, to)))]);
    i = Math.max(i + 1, bodyEnd);
  }
  return out;
}
