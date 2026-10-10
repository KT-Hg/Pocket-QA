import { getUsedVarNames, commentText } from './utils.js';
import { initExportModal } from './export-modal.js';
import { getSwitchLayout, hasBlock, blockEnd, conditionSkipTarget, conditionSkip } from '../shared/switch-blocks.js';
import { normalizeVarName, writtenVarNames } from '../shared/var-name.js';
import { patternVarNames, patternRegexSource } from '../shared/text-pattern.js';
import { activeValue, parseRandomSpec, parsePickSpec } from '../shared/var-spec.js';
import { CHILD_COND_KEYS } from '../shared/child-cond.js';
import { cssEscape } from '../shared/css-escape.js';
import { mark, newStep, blockSteps } from './export/steps.js';
import {
  CLICK_JS, HOVER_JS, SET_INPUT_JS, DRAG_DROP_JS, FIND_CHILD_JS, READ_VAL_JS, CHECK_COND_JS, CONDITION_TYPES,
} from './export/page-js.js';

const SKIPPED_TYPES = new Set([
  'screenshot', 'screenshot_full', 'screenshot_element', 'screenshot_tovar', 'switch'
]);

function makeRandomFn(type, length) {
  // Must mirror resolveRandomVars() in bg/interpolate.js. The Variables modal offers a
  // "datetime" type that used to fall through to the alphanumeric branch here, so
  // an exported ${stamp} produced random junk instead of the run's timestamp.
  if (type === 'datetime')
    return "() => { const d = new Date(), p = n => String(n).padStart(2, '0'); "
         + "return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + '_' "
         + "+ p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds()); }";
  if (type === 'alpha')
    return `() => Array.from({length:${length}},()=>'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random()*52)]).join('')`;
  if (type === 'numeric')
    return `() => Array.from({length:${length}},()=>String(Math.floor(Math.random()*10))).join('')`;
  return `() => Array.from({length:${length}},()=>'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random()*62)]).join('')`;
}

// Identifiers the generated bookmarklet declares for itself, plus the JS reserved
// words. Variable names are free-form in the Variables modal, so one called
// `sleep` would shadow a helper and one called `class` is a SyntaxError — those
// get a `_v` suffix instead.
const _RESERVED_JS = new Set([
  'sleep', 'getEl', '_qsel', '_click', '_hover', '_setInput', '_dragDrop', '_findChild', '_readVal', '_checkCond', '_pickIdx', '_pickItem', 'err', 'res', 'rej', 'obs',
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'let', 'static', 'yield', 'await',
  'document', 'window', 'undefined', 'NaN', 'Infinity',
]);

/**
 * Sanitize a string into a valid JS identifier.
 * Prevents code injection when variable names from user input are embedded in generated code.
 *
 * Every site that emits *or references* a variable name has to go through this.
 * The declaration used to be sanitized while valueToJS() passed `${mã đơn}`
 * through verbatim — a SyntaxError that takes the whole bookmarklet down.
 */
function _sanitizeVarName(name) {
  const safe = String(name == null ? 'var' : name)
    .replace(/[^a-zA-Z0-9_$]/g, '_')
    .replace(/^\d/, '_') || 'var';
  return _RESERVED_JS.has(safe) ? safe + '_v' : safe;
}

// An XPath string literal. XPath 1.0 has no escapes, so a text holding both
// kinds of quote is put together with concat().
function _xpathLiteral(s) {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat(${s.split("'").map((p) => `'${p}'`).join(`, "'", `)})`;
}

/**
 * The locator of `sels` named by `type` (the selector type chosen in the form)
 * as a selector _qsel takes — CSS, or XPath when it starts with / or ( — or ''
 * when there is none. Playback tries the chosen type first (content.js).
 */
function _chosenSel(sels, type) {
  const v = sels?.[type];
  if (!type || typeof v !== 'string' || !v) return '';
  switch (type) {
    case 'css': case 'xpath': case 'fullXpath': return v;
    case 'id':   return '#' + cssEscape(v);
    case 'name': return `[name="${cssEscape(v)}"]`;
    case 'text': return `//*[contains(text(), ${_xpathLiteral(v)})]`;
    default:     return '';
  }
}

function getBestSel(action) {
  const s = action.selectors || {};
  return _chosenSel(s, action.selectorType)
    || s.css
    || action.selector
    || (s.id ? '#' + s.id : '')
    || s.xpath
    || s.fullXpath
    || '';
}

// Returns a JS expression string representing the value.
// ${varName} references are intentionally left unescaped so they interpolate
// the declared JS variables (static consts or random generators) at run time.
function valueToJS(val) {
  if (val == null) return "''";
  const s = String(val);
  if (/\$\{/.test(s)) {
    const escaped = s
      .replace(/\\/g, '\\\\')   // backslash first
      .replace(/`/g, '\\`')     // backtick — ${varName} is kept to reference declared vars
      // The reference must be sanitized exactly like the declaration: `${user-name}`
      // otherwise reads as subtraction and `${mã đơn}` is a SyntaxError.
      .replace(/\$\{([^}]+)\}/g, (_m, name) => '${' + _sanitizeVarName(name.trim()) + '}');
    return '`' + escaped + '`';
  }
  return JSON.stringify(s);
}

/**
 * Substitute variables into a `script` action's source.
 *
 * A script action's code is emitted verbatim, so a `${name}` sitting inside a
 * string literal — `console.log("${q}")` — is just text and never picked up the
 * value, even though playback substitutes it via _applyVarsToCode() in bg/interpolate.js.
 *
 * Static values are known at export time and are inlined the same way playback
 * escapes them. Random/pick/fallback/readdom values only exist at run time and a
 * textual placeholder cannot stand in for them, so those are reported back to the
 * caller: the generated code carries a comment pointing at the declared variable,
 * which is in scope and can be referenced bare.
 */
function _scriptCodeWithVars(rawCode, ctx) {
  const unresolved = [];
  const code = String(rawCode).replace(/\$\{([^}]+)\}/g, (match, rawName) => {
    const name = rawName.trim();
    if (!(name in (ctx?.staticVars || {}))) {
      if (!unresolved.includes(name)) unresolved.push(name);
      return match;
    }
    // Same escaping as _applyVarsToCode() — keeps the value a value no matter
    // which kind of string literal it landed in.
    return String(ctx.staticVars[name])
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/'/g, "\\'")
      .replace(/`/g, '\\`')
      .replace(/\$\{/g, '\\${')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
  });
  return { code, unresolved };
}

/**
 * _pickIdx / _pickItem: a Dropdown's "Choose item #" in the bookmarklet. _pickIdx
 * is pickItemIndex of shared/dropdown-pick.js (tests/dropdown-pick.test.mjs
 * compares the two). A <select> gets its option set; anything else is clicked
 * open and the item clicked once the list shows it.
 */
const PICK_ITEM_HELPER_JS = String.raw`
  const _pickIdx = (raw, count, ok) => {
    const s = String(raw == null ? '' : raw).trim();
    if (/^random$/i.test(s)) {
      const pool = [];
      for (let k = 0; k < count; k++) if (ok(k)) pool.push(k);
      if (!pool.length) throw new Error('Dropdown: no item to choose at random (' + count + ' found)');
      return pool[Math.floor(Math.random() * pool.length)];
    }
    if (!/^-?\d+$/.test(s) || Number(s) === 0) throw new Error('Dropdown: "' + s + '" is not an item number');
    const n = Number(s), k = n > 0 ? n - 1 : count + n;
    if (k < 0 || k >= count) throw new Error('Dropdown: there is no item #' + n + ' (' + count + ' found)');
    return k;
  };
  const _pickItem = async (el, raw, itemSel, timeout) => {
    if (el.tagName === 'SELECT') {
      const o = Array.from(el.options);
      const k = _pickIdx(raw, o.length, i => !o[i].disabled && o[i].value !== '');
      if (o[k].disabled) throw new Error('Dropdown: item #' + (k + 1) + ' is disabled');
      el.selectedIndex = k;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    el.click();
    const shown = e => e.getClientRects().length > 0 && (e.checkVisibility ? e.checkVisibility({ visibilityProperty: true }) : getComputedStyle(e).visibility !== 'hidden');
    const off = e => e.getAttribute('aria-disabled') === 'true' || e.hasAttribute('disabled');
    const end = Date.now() + timeout;
    for (;;) {
      const items = Array.from(document.querySelectorAll(itemSel || '[role="option"]')).filter(shown);
      let k;
      try { k = _pickIdx(raw, items.length, i => !off(items[i]) && items[i].textContent.trim() !== ''); }
      catch (e) { if (Date.now() >= end) throw e; await sleep(100); continue; }
      if (off(items[k])) throw new Error('Dropdown: item #' + (k + 1) + ' is disabled');
      items[k].click();
      return;
    }
  };`.split('\n').slice(1);

/** A page-js.js function, declared in the bookmarklet at the indent of its body. */
function declarePageJs(name, src) {
  return `const ${name} = ${src};`.split('\n').map((l) => `  ${l}`);
}

/** One line for a step comment: the item number as written, whitespace folded. */
function _pickLabel(action) {
  return String(action.pick?.index ?? '?').replace(/\s+/g, ' ');
}

function indentLines(lines, spaces) {
  return lines.map(l => (l === '' ? '' : spaces + l));
}

// Serializes a conditions object into a JS object literal, interpolating
// ${varName} references via valueToJS(). {fallback:...} specs are passed as
// JSON string literals — the runtime _findChild handles iteration.
function _conditionsToJS(cond) {
  if (!cond) return '{}';
  const parts = [];
  if (cond.matchMode) parts.push(`matchMode: ${JSON.stringify(cond.matchMode)}`);
  const FALLBACK_RE = /^\{fallback:(.+)\}$/;
  for (const f of CHILD_COND_KEYS) {
    if (cond[f] != null && cond[f] !== '') {
      const v = String(cond[f]);
      // {fallback:...} is passed as a plain string literal — _findChild iterates at runtime.
      // ${varName} references are interpolated via template literals as usual.
      parts.push(`${f}: ${FALLBACK_RE.test(v) ? JSON.stringify(v) : valueToJS(v)}`);
    }
  }
  return `{${parts.join(', ')}}`;
}

/**
 * The "if (…) {" that opens a condition action's block: the in-page check
 * (_checkCond, popup/export/page-js.js) on the element found now. A type this
 * version does not know stops the run there, as playback does; its name stays in
 * the comment, never in code, and the block is kept for a check put in by hand.
 */
function condHeader(action, stepNum, step, ctx) {
  const type = action.conditionType;
  const lbl = action.label ? ` — ${commentText(action.label)}` : '';
  const head = `// Step ${stepNum}: condition — ${commentText(type)}${lbl}`;
  if (!CONDITION_TYPES.has(type)) {
    mark(step, 'verify', 'unknown condition type — the exported code stops there, as a run does');
    ctx.warnings.add(`Condition step ${stepNum}: type "${type}" is unknown — the exported code stops there, as a run does`);
    return [head, `throw new Error(${JSON.stringify(`Condition step ${stepNum}: unknown condition type, named in the comment above`)});`, 'if (true) {'];
  }
  const el = type.startsWith('url') ? 'null' : `_qsel(${valueToJS(getBestSel(action))})`;
  return [head, `if (_checkCond(${JSON.stringify(type)}, ${el}, ${valueToJS(action.expectedValue)})) {`];
}

// Generates JS lines for a single non-condition action, and marks `step`
// (export/steps.js) when the action is not exported as is.
function actionLines(action, step, stepDelay, elTimeout, ctx) {
  const stepNum = step.n;
  const lbl = action.label ? ` — ${commentText(action.label)}` : '';
  const delay = action.delay != null ? action.delay : stepDelay;
  const sel = getBestSel(action);
  const v = `_el${stepNum}`;

  if (SKIPPED_TYPES.has(action.type)) {
    mark(step, 'skip', action.type === 'switch'
      ? 'a Switch needs the extension to choose what plays'
      : 'screenshots need the extension');
    return [`// Step ${stepNum}: [SKIPPED] ${commentText(action.type)} — requires Chrome Extension API`];
  }

  const out = [];
  switch (action.type) {
    case 'click':
      out.push(`// Step ${stepNum}: click${lbl}`);
      if (action.conditions) {
        out.push(`const ${v}_p = await getEl(${valueToJS(sel)}, ${elTimeout});`);
        out.push(`const ${v} = _findChild(${v}_p, ${_conditionsToJS(action.conditions)});`);
        out.push(`if (!${v}) throw new Error('Child condition not matched (step ${stepNum})');`);
      } else {
        out.push(`const ${v} = await getEl(${valueToJS(sel)}, ${elTimeout});`);
      }
      out.push(`_click(${v});`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;

    case 'input':
      out.push(`// Step ${stepNum}: input${lbl}`);
      if (action.conditions) {
        out.push(`const ${v}_p = await getEl(${valueToJS(sel)}, ${elTimeout});`);
        out.push(`const ${v} = _findChild(${v}_p, ${_conditionsToJS(action.conditions)});`);
        out.push(`if (!${v}) throw new Error('Child condition not matched (step ${stepNum})');`);
      } else {
        out.push(`const ${v} = await getEl(${valueToJS(sel)}, ${elTimeout});`);
      }
      out.push(`_setInput(${v}, ${valueToJS(action.value)});`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;

    case 'hover':
      out.push(`// Step ${stepNum}: hover${lbl}`);
      if (action.conditions) {
        out.push(`const ${v}_p = await getEl(${valueToJS(sel)}, ${elTimeout});`);
        out.push(`const ${v} = _findChild(${v}_p, ${_conditionsToJS(action.conditions)});`);
        out.push(`if (!${v}) throw new Error('Child condition not matched (step ${stepNum})');`);
      } else {
        out.push(`const ${v} = await getEl(${valueToJS(sel)}, ${elTimeout});`);
      }
      out.push(`_hover(${v});`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;

    case 'dropdown':
      if (action.pick) {
        out.push(`// Step ${stepNum}: dropdown → item #${_pickLabel(action)}${lbl}`);
        out.push(`const ${v} = await getEl(${valueToJS(sel)}, ${elTimeout});`);
        out.push(`await _pickItem(${v}, ${valueToJS(action.pick.index)}, ${valueToJS(action.pick.itemSelector || '')}, ${elTimeout});`);
        if (delay > 0) out.push(`await sleep(${delay});`);
        break;
      }
      out.push(`// Step ${stepNum}: open dropdown (freeze)${lbl}`);
      out.push(`const ${v} = await getEl(${valueToJS(sel)}, ${elTimeout});`);
      out.push(`${v}.click();`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;

    case 'dragdrop': {
      const tgt = _chosenSel(action.targetSelectors, action.targetSelectorType)
        || action.targetSelectors?.css || action.targetSelector || '';
      out.push(`// Step ${stepNum}: dragdrop${lbl}`);
      out.push(`const ${v}_s = await getEl(${valueToJS(sel)}, ${elTimeout});`);
      out.push(`const ${v}_t = await getEl(${valueToJS(tgt)}, ${elTimeout});`);
      out.push(`_dragDrop(${v}_s, ${v}_t);`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;
    }

    case 'navigate':
      out.push(`// Step ${stepNum}: navigate${lbl}`);
      out.push(`// ⚠ Page will reload — steps after this will not execute unless injected on next load`);
      mark(step, 'verify', 'the page reloads: steps after it do not run in a bookmarklet');
      // The action editor writes navigate targets to .url; imported/older scenarios
      // sometimes carry .value instead — the Python export already accepted both.
      out.push(`window.location.href = ${valueToJS(action.url || action.value)};`);
      out.push(`await sleep(1000);`);
      break;

    case 'wait': {
      const ms = action.delay != null ? action.delay : (parseInt(action.value) || 1000);
      out.push(`// Step ${stepNum}: wait${lbl}`);
      out.push(`await sleep(${ms});`);
      break;
    }

    case 'script': {
      // Wrap in async IIFE so the user's code cannot leak variables or
      // 'return' statements into the outer bookmarklet closure, and so that
      // top-level 'await' works inside the script without syntax errors.
      const { code, unresolved } = _scriptCodeWithVars(action.code || action.value || '', ctx);
      out.push(`// Step ${stepNum}: script${lbl}`);
      mark(step, 'verify', 'custom JS, pasted in as is — check it');
      if (unresolved.length) {
        out.push(`// ⚠ Not substituted below: ${commentText(unresolved.map(n => '${' + n + '}').join(', '))}`);
        out.push(`//   Only static variables can be inlined into script code. These are`);
        out.push(`//   declared above as real JS variables — reference them bare, e.g.`);
        out.push(`//   \`${_sanitizeVarName(unresolved[0])}\` instead of \`\${${commentText(unresolved[0])}}\`.`);
        ctx.warnings.add(`Script step ${stepNum}: ${unresolved.map(n => '${' + n + '}').join(', ')} left as-is (only static variables inline into script code)`);
      }
      out.push(`await (async () => {`);
      out.push(`  // [USER SCRIPT BEGIN]`);
      for (const line of code.split('\n')) out.push(`  ${line}`);
      out.push(`  // [USER SCRIPT END]`);
      out.push(`})();`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;
    }

    case 'readdom': {
      // Extract: each ${name} of the pattern takes its part of the text, and
      // "Save to var" (optional then) keeps the whole text — shared/text-pattern.js.
      const slots   = action.pattern ? patternVarNames(action.pattern) : [];
      const vn      = normalizeVarName(action.varName);
      let varName;
      if (vn) varName = _sanitizeVarName(vn);
      else varName = slots.length ? null : 'domVar';
      const targets = [varName, ...slots.map(_sanitizeVarName)].filter(Boolean);
      out.push(`// Step ${stepNum}: readdom → ${targets.map(t => `"${t}"`).join(', ')}${lbl}`);
      if (action.conditions) {
        out.push(`const ${v}_p = await getEl(${valueToJS(sel)}, ${elTimeout});`);
        out.push(`const ${v} = _findChild(${v}_p, ${_conditionsToJS(action.conditions)});`);
        out.push(`if (!${v}) throw new Error('Child condition not matched (step ${stepNum})');`);
      } else {
        out.push(`const ${v} = await getEl(${valueToJS(sel)}, ${elTimeout});`);
      }
      // _readVal mirrors what the extension reads for each "Read from" choice.
      const readExpr = `_readVal(${v}, ${JSON.stringify(action.readFrom || 'text')}, ${valueToJS(action.attrName || '')})`;
      if (!slots.length) {
        out.push(`${varName} = ${readExpr};`);
      } else {
        out.push(`const ${v}_t = ${readExpr};`);
        if (varName) out.push(`${varName} = ${v}_t;`);
        out.push(`const ${v}_m = new RegExp(${JSON.stringify(patternRegexSource(action.pattern))}, ${JSON.stringify(action.matchCase ? '' : 'i')}).exec(${v}_t);`);
        out.push(`if (!${v}_m) throw new Error(${JSON.stringify(`Read DOM (step ${stepNum}): text does not match ${String(action.pattern).trim()}: `)} + ${v}_t);`);
        slots.forEach((n, k) => out.push(`${_sanitizeVarName(n)} = ${v}_m[${k + 1}].trim();`));
      }
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;
    }

    default:
      out.push(`// Step ${stepNum}: ${commentText(action.type)}${lbl} — [unsupported type, skipped]`);
      mark(step, 'skip', action.type === 'uploadFile'
        ? 'a bookmarklet cannot read local files'
        : 'not an action type this version knows');
  }

  return out;
}

// Recursively processes an action array, grouping condition blocks
// Disabled actions are skipped inline so skipCount stays aligned with the original array.
function processActions(actions, baseIdx, stepDelay, elTimeout, ctx) {
  const out = [];
  let i = 0;

  while (i < actions.length) {
    const action = actions[i];
    const abs    = baseIdx + i;

    // A Switch block only ever runs one of its cases, which a bookmarklet
    // cannot choose — emitting the block would run every case in a row.
    if (ctx.all && hasBlock(ctx.all[abs])) {
      const end = blockEnd(ctx.all, abs);
      out.push(`// Step ${abs + 1}: [SKIPPED] switch block — steps ${abs + 2}–${end + 1} not exported (requires Chrome Extension API)`);
      out.push('');
      ctx.warnings.add(`Switch block at step ${abs + 1} skipped together with its ${end - abs} action(s)`);
      ctx.steps.push(...blockSteps(ctx.all, abs, end));
      i = end - baseIdx + 1;
      continue;
    }

    if (action.disabled) {
      i++;
      continue;
    }

    const stepNum = baseIdx + i + 1;
    const step    = newStep(action, stepNum);
    ctx.steps.push(step);

    if (action.type === 'condition') {
      const skipCount = conditionSkip(action); // 0 for an emptied Condition: empty body
      out.push(...condHeader(action, stepNum, step, ctx));
      // Same span playback skips: a Switch and its block count as one action.
      const bodyEnd = ctx.all ? conditionSkipTarget(ctx.all, abs, skipCount, ctx.layout) - baseIdx : i + 1 + skipCount;
      const body = actions.slice(i + 1, bodyEnd);
      const bodyLines = processActions(body, baseIdx + i + 1, stepDelay, elTimeout, ctx);
      out.push(...indentLines(bodyLines, '  '));
      out.push('}');
      out.push('');
      i = Math.max(i + 1, bodyEnd);
    } else {
      out.push(...actionLines(action, step, stepDelay, elTimeout, ctx));
      out.push('');
      i++;
    }
  }

  return out;
}

/**
 * Generate a self-contained JS bookmarklet string for the given scenario.
 *
 * @param {string}   scenarioName - Human-readable name embedded as a comment.
 * @param {object[]} actions      - Scenario action array (disabled actions are skipped).
 * @param {object}   variables    - Key/value pairs; random specs are expanded inline.
 * @param {object}   opts
 * @param {number}   opts.stepDelay  - Default inter-step delay in ms (default 300).
 * @param {number}   opts.elTimeout  - Element wait timeout in ms (default 5000).
 * @returns {{ code: string, stats: { total, supported, skipped, staticVarCount, randomVarCount }, steps: object[], warnings: string[] }}
 *   steps: what became of each enabled action (popup/export/steps.js).
 */
export function generateBookmarklet(scenarioName, actions, variables, opts = {}) {
  const { stepDelay = 300, elTimeout = 5000 } = opts;

  const warnings = new Set();
  const staticVars = {}, randomSpecs = {}, pickSpecs = {}, writtenVars = new Set();

  for (const [k, v] of Object.entries(variables || {})) {
    const str  = activeValue(v);
    const spec = parseRandomSpec(str);
    const pick = parsePickSpec(str);
    if (spec)      randomSpecs[k] = spec;
    else if (pick) pickSpecs[k]   = pick;
    else           staticVars[k]  = str;
  }

  const enabled = (actions || []).filter(a => !a.disabled);

  // Names a step assigns to. screenshot_tovar belongs here even though the step
  // itself is skipped: without a declaration a later `${shot}` is a ReferenceError
  // that takes down the whole run.
  for (const a of enabled) {
    for (const vn of writtenVarNames(a)) writtenVars.add(_sanitizeVarName(vn));
  }

  // Two different variable names can sanitize to the same identifier
  // (`mã đơn` and `m-a-b-n` both become `m____n`), which silently drops one.
  const _byIdent = new Map();
  for (const k of [...Object.keys(staticVars), ...Object.keys(randomSpecs), ...Object.keys(pickSpecs)]) {
    const ident = _sanitizeVarName(k);
    if (_byIdent.has(ident) && _byIdent.get(ident) !== k) {
      warnings.add(`"${_byIdent.get(ident)}" and "${k}" both become the JS identifier \`${ident}\` — rename one`);
    } else {
      _byIdent.set(ident, k);
    }
    if (ident !== k) {
      warnings.add(`"${k}" is not a valid JS identifier — exported as \`${ident}\``);
    }
  }

  // Fallback variables only mean something inside a Child Condition; anywhere
  // else the literal spec is what lands in the page, exactly as in playback.
  for (const [k, v] of Object.entries(staticVars)) {
    if (/^\{fallback:.+\}$/.test(v)) {
      warnings.add(`"${k}" is a Fallback variable — resolved only inside Child Conditions, literal everywhere else`);
    }
  }

  const all    = actions || [];
  const layout = getSwitchLayout(all);
  const steps  = [];
  const ctx = { staticVars, warnings, all, layout, steps };

  const out = [];

  out.push('javascript:(async () => {');
  out.push(`  // ============================`);
  out.push(`  // BOOKMARKLET: ${commentText(scenarioName)}`);
  out.push(`  // ============================`);
  out.push('');
  out.push('  // --- HELPER FUNCTIONS ---');
  out.push('  const sleep = ms => new Promise(r => setTimeout(r, ms));');
  out.push('');
  out.push('  const _qsel = sel => (sel.startsWith(\'/\') || sel.startsWith(\'(\'))');
  out.push('    ? document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue');
  out.push('    : document.querySelector(sel);');
  out.push('');
  out.push(`  const getEl = (sel, timeout = ${elTimeout}) => new Promise((res, rej) => {`);
  out.push('    const el = _qsel(sel);');
  out.push('    if (el) return res(el);');
  out.push('    const obs = new MutationObserver(() => {');
  out.push('      const found = _qsel(sel);');
  out.push('      if (found) { obs.disconnect(); res(found); }');
  out.push('    });');
  out.push('    obs.observe(document.body, { childList: true, subtree: true });');
  // This string is single-quoted so `${sel}` is NOT template-interpolated by our
  // generator — it is emitted verbatim. In the generated bookmarklet, `sel` will be
  // a real JS variable, and the backtick template literal will work correctly at run time.
  out.push('    setTimeout(() => { obs.disconnect(); rej(new Error(`Timeout: ${sel}`)); }, timeout);');
  out.push('  });');
  out.push('');
  // The action helpers playback's own events come from (page-js.js), each only when a step uses it.
  for (const [name, src, used] of [
    ['_click', CLICK_JS, (a) => a.type === 'click'],
    ['_hover', HOVER_JS, (a) => a.type === 'hover'],
    ['_setInput', SET_INPUT_JS, (a) => a.type === 'input'],
    ['_dragDrop', DRAG_DROP_JS, (a) => a.type === 'dragdrop'],
  ]) {
    if (!enabled.some(used)) continue;
    out.push(...declarePageJs(name, src));
    out.push('');
  }
  out.push(...declarePageJs('_findChild', FIND_CHILD_JS));
  if (enabled.some(a => a.type === 'condition')) {
    out.push('');
    out.push(...declarePageJs('_checkCond', CHECK_COND_JS));
  }
  if (enabled.some(a => a.type === 'readdom')) {
    out.push('');
    out.push(...declarePageJs('_readVal', READ_VAL_JS));
  }

  if (enabled.some(a => a.type === 'dropdown' && a.pick)) {
    out.push('');
    out.push(...PICK_ITEM_HELPER_JS);
  }

  if (Object.keys(randomSpecs).length > 0) {
    out.push('');
    out.push('  // --- RANDOM VARIABLE GENERATORS ---');
    for (const [k, spec] of Object.entries(randomSpecs)) {
      const safe = _sanitizeVarName(k);
      out.push(`  const _gen_${safe} = ${makeRandomFn(spec.type, spec.length)};`);
    }
  }

  const hasVars = Object.keys(staticVars).length > 0
    || Object.keys(randomSpecs).length > 0
    || Object.keys(pickSpecs).length > 0
    || writtenVars.size > 0;

  if (hasVars) {
    out.push('');
    out.push('  // --- VARIABLES ---');
    // A name a step writes to has to be `let`, and must not also be declared by
    // the writtenVars pass below: `const result = "seed"` followed by
    // `let result = ''` is a SyntaxError that kills the entire bookmarklet.
    const declared = new Set();
    const kw = (ident) => (writtenVars.has(ident) ? 'let' : 'const');

    for (const [k, v] of Object.entries(staticVars)) {
      const safe = _sanitizeVarName(k);
      if (declared.has(safe)) continue;
      declared.add(safe);
      out.push(`  ${kw(safe)} ${safe} = ${JSON.stringify(v)};`);
    }
    for (const k of Object.keys(randomSpecs)) {
      const safe = _sanitizeVarName(k);
      if (declared.has(safe)) continue;
      declared.add(safe);
      out.push(`  ${kw(safe)} ${safe} = _gen_${safe}();`);
    }
    for (const [k, vals] of Object.entries(pickSpecs)) {
      const safe    = _sanitizeVarName(k);
      if (declared.has(safe)) continue;
      declared.add(safe);
      const jsArray = '[' + vals.map(v => JSON.stringify(v)).join(', ') + ']';
      out.push(`  ${kw(safe)} ${safe} = ${jsArray}[Math.floor(Math.random() * ${vals.length})];`);
    }
    // Only the written names nothing above already seeded — otherwise this would
    // wipe the seed the Variables tab supplied.
    for (const k of writtenVars) {
      if (declared.has(k)) continue;
      declared.add(k);
      out.push(`  let ${k} = '';`);
    }
  }

  out.push('');
  out.push('  // --- MAIN FLOW ---');
  out.push('  try {');
  out.push('');

  for (const line of processActions(actions || [], 0, stepDelay, elTimeout, ctx)) {
    out.push(line === '' ? '' : '    ' + line);
  }

  out.push("    console.log('✅ Bookmarklet completed successfully.');");
  out.push('');
  out.push('  } catch (err) {');
  out.push("    console.error('❌ Bookmarklet error:', err);");
  out.push("    alert('Error: ' + err.message);");
  out.push('  }');
  out.push('');
  out.push('})();');

  // A `${name}` with nothing behind it is a ReferenceError at run time, and the
  // generated code gives no clue where it came from — flag it while the scenario
  // is still on screen.
  const knownNames = new Set([
    ...Object.keys(staticVars), ...Object.keys(randomSpecs), ...Object.keys(pickSpecs),
  ]);
  for (const a of enabled) {
    for (const vn of writtenVarNames(a)) knownNames.add(vn);
  }
  for (const name of getUsedVarNames(enabled)) {
    if (!knownNames.has(name)) {
      warnings.add(`\${${name}} is used by a step but not defined in the Variables tab`);
    }
  }

  const skipped = steps.filter((s) => s.status === 'skip').length;
  return {
    code: out.join('\n'),
    stats: {
      total: enabled.length, supported: steps.length - skipped, skipped,
      staticVarCount: Object.keys(staticVars).length,
      randomVarCount: Object.keys(randomSpecs).length
    },
    steps,
    warnings: [...warnings]
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// UI MODULE — the modal is popup/export-modal.js; what is particular to this export
// ─────────────────────────────────────────────────────────────────────────────

/** Wire the export-bookmarklet modal trigger and all modal-internal buttons. */
export function initExportBookmarklet() {
  initExportModal({
    triggerId: 'exportBookmarklet',
    prefix: 'exportBm',
    tabClass: 'export-bm-tab',
    title: 'Export JS',
    fileSuffix: '_bookmarklet.js',
    readOptions: () => ({
      stepDelay: parseInt(document.getElementById('exportBmStepDelay')?.value) || 300,
      elTimeout: parseInt(document.getElementById('exportBmElTimeout')?.value)  || 5000,
    }),
    generate: generateBookmarklet,
    regenerateFromStorage: true,
    copyText: toBookmarkletUrl,
    // .js file: pretty-printed, without javascript: prefix
    file: (code) => ({ text: _toJsFile(code), type: 'application/javascript' }),
  });
}

/**
 * The code as a bookmark URL, ready to paste into a bookmark's URL field: the
 * code exactly as written, with what a URL would lose encoded. The URL parser
 * drops every tab and line break, and a javascript: URL is percent-decoded
 * before it runs, so "%" is encoded first, then tab, CR and LF.
 *
 * It used to join the lines with spaces and squeeze runs of spaces instead,
 * which broke a script that needs its line breaks (no semicolons, a trailing
 * // comment that then swallowed the rest) and changed any value holding two
 * spaces in a row.
 */
export function toBookmarkletUrl(code) {
  const body = code.startsWith('javascript:') ? code.slice('javascript:'.length) : code;
  return 'javascript:' + body.trim()
    .replace(/%/g, '%25')
    .replace(/\t/g, '%09')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

/**
 * Strip the `javascript:` URI prefix for saving as a .js file.
 * `trimStart()` removes the leading newline that follows `javascript:` in the
 * multi-line pretty-printed template.
 */
function _toJsFile(code) {
  const body = code.startsWith('javascript:') ? code.slice('javascript:'.length) : code;
  return body.trimStart();
}
