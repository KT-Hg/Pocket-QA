import { getUsedVarNames } from './utils.js';
import { initExportModal } from './export-modal.js';
import { getSwitchLayout, hasBlock, blockEnd, conditionSkipTarget, conditionSkip } from '../shared/switch-blocks.js';
import { normalizeVarName, writtenVarNames } from '../shared/var-name.js';
import { patternVarNames, patternRegexSource } from '../shared/text-pattern.js';
import { activeValue, parseRandomSpec, parsePickSpec } from '../shared/var-spec.js';

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
  'sleep', 'getEl', 'setInput', '_qsel', '_findChild', '_readVal', '_pickIdx', '_pickItem', 'err', 'res', 'rej', 'obs',
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

function getBestSel(action) {
  const s = action.selectors || {};
  return s.css
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
  const strFields = ['valueEquals', 'textContains', 'idContains', 'classContains', 'typeEquals'];
  const FALLBACK_RE = /^\{fallback:(.+)\}$/;
  for (const f of strFields) {
    if (cond[f] != null && cond[f] !== '') {
      const v = String(cond[f]);
      // {fallback:...} is passed as a plain string literal — _findChild iterates at runtime.
      // ${varName} references are interpolated via template literals as usual.
      parts.push(`${f}: ${FALLBACK_RE.test(v) ? JSON.stringify(v) : valueToJS(v)}`);
    }
  }
  return `{${parts.join(', ')}}`;
}

// Generates the "if (condExpr) {" header for a condition action
function condHeader(action, stepNum) {
  const sel = getBestSel(action);
  const s = valueToJS(sel);
  const exp = valueToJS(action.expectedValue);
  const lbl = action.label ? ` — ${action.label}` : '';

  const exprMap = {
    elementExists:    `_qsel(${s}) !== null`,
    elementNotExists: `_qsel(${s}) === null`,
    elementVisible:   `(() => { const _e=_qsel(${s}); return !!_e && _e.offsetParent!==null; })()`,
    elementHidden:    `(() => { const _e=_qsel(${s}); return !_e || _e.offsetParent===null; })()`,
    textContains:     `(_qsel(${s})?.textContent||'').includes(${exp})`,
    textEquals:       `(_qsel(${s})?.textContent||'').trim()===${exp}`,
    valueEquals:      `(_qsel(${s})?.value||'')===${exp}`,
    valueContains:    `(_qsel(${s})?.value||'').includes(${exp})`,
    urlContains:      `window.location.href.includes(${exp})`,
    urlEquals:        `window.location.href===${exp}`,
    hasClass:         `(_qsel(${s})?.classList.contains(${exp})??false)`,
    hasAttribute:     `(_qsel(${s})?.hasAttribute(${exp})??false)`,
  };

  const expr = exprMap[action.conditionType] || `true /* unknown: ${action.conditionType} */`;
  return [
    `// Step ${stepNum}: condition — ${action.conditionType}${lbl}`,
    `if (${expr}) {`
  ];
}

// Generates JS lines for a single non-condition action
function actionLines(action, stepNum, stepDelay, elTimeout, ctx) {
  const lbl = action.label ? ` — ${action.label}` : '';
  const delay = action.delay != null ? action.delay : stepDelay;
  const sel = getBestSel(action);
  const v = `_el${stepNum}`;

  if (SKIPPED_TYPES.has(action.type)) {
    return [`// Step ${stepNum}: [SKIPPED] ${action.type} — requires Chrome Extension API`];
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
      out.push(`${v}.click();`);
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
      out.push(`setInput(${v}, ${valueToJS(action.value)});`);
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
      out.push(`${v}.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));`);
      out.push(`${v}.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));`);
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
      const tgt = action.targetSelectors?.css || action.targetSelector || '';
      out.push(`// Step ${stepNum}: dragdrop${lbl}`);
      out.push(`const ${v}_s = await getEl(${valueToJS(sel)}, ${elTimeout});`);
      out.push(`const ${v}_t = await getEl(${valueToJS(tgt)}, ${elTimeout});`);
      out.push(`const _sr${stepNum} = ${v}_s.getBoundingClientRect(), _tr${stepNum} = ${v}_t.getBoundingClientRect();`);
      out.push(`${v}_s.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, clientX:_sr${stepNum}.x+_sr${stepNum}.width/2, clientY:_sr${stepNum}.y+_sr${stepNum}.height/2 }));`);
      out.push(`await sleep(50);`);
      out.push(`${v}_t.dispatchEvent(new MouseEvent('mousemove', { bubbles:true, clientX:_tr${stepNum}.x+_tr${stepNum}.width/2, clientY:_tr${stepNum}.y+_tr${stepNum}.height/2 }));`);
      out.push(`${v}_s.dispatchEvent(new MouseEvent('mouseup',   { bubbles:true, clientX:_tr${stepNum}.x+_tr${stepNum}.width/2, clientY:_tr${stepNum}.y+_tr${stepNum}.height/2 }));`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;
    }

    case 'navigate':
      out.push(`// Step ${stepNum}: navigate${lbl}`);
      out.push(`// ⚠ Page will reload — steps after this will not execute unless injected on next load`);
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
      if (unresolved.length) {
        out.push(`// ⚠ Not substituted below: ${unresolved.map(n => '${' + n + '}').join(', ')}`);
        out.push(`//   Only static variables can be inlined into script code. These are`);
        out.push(`//   declared above as real JS variables — reference them bare, e.g.`);
        out.push(`//   \`${_sanitizeVarName(unresolved[0])}\` instead of \`\${${unresolved[0]}}\`.`);
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
      out.push(`// Step ${stepNum}: ${action.type}${lbl} — [unsupported type, skipped]`);
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
      i = end - baseIdx + 1;
      continue;
    }

    if (action.disabled) {
      i++;
      continue;
    }

    const stepNum = baseIdx + i + 1;

    if (action.type === 'condition') {
      const skipCount = conditionSkip(action); // 0 for an emptied Condition: empty body
      out.push(...condHeader(action, stepNum));
      // Same span playback skips: a Switch and its block count as one action.
      const bodyEnd = ctx.all ? conditionSkipTarget(ctx.all, abs, skipCount, ctx.layout) - baseIdx : i + 1 + skipCount;
      const body = actions.slice(i + 1, bodyEnd);
      const bodyLines = processActions(body, baseIdx + i + 1, stepDelay, elTimeout, ctx);
      out.push(...indentLines(bodyLines, '  '));
      out.push('}');
      out.push('');
      i = Math.max(i + 1, bodyEnd);
    } else {
      out.push(...actionLines(action, stepNum, stepDelay, elTimeout, ctx));
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
 * @returns {{ code: string, stats: { total, supported, skipped, hasNavigate, staticVarCount, randomVarCount } }}
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
  const ctx = { staticVars, warnings, all, layout };

  // A Switch block is skipped with everything in it (see processActions).
  let skipped = 0, supported = 0, hasNavigate = false;
  all.forEach((a, j) => {
    if (!a || a.disabled) return;
    if (SKIPPED_TYPES.has(a.type) || layout[j]?.chain?.length) skipped++;
    else supported++;
    if (a.type === 'navigate') hasNavigate = true;
  });

  const out = [];

  out.push('javascript:(async () => {');
  out.push(`  // ============================`);
  out.push(`  // BOOKMARKLET: ${scenarioName}`);
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
  out.push('  const setInput = (el, value) => {');
  out.push('    el.focus();');
  out.push('    let nv = null, p = Object.getPrototypeOf(el);');
  out.push('    while (p && p !== Object.prototype) {');
  out.push("      const d = Object.getOwnPropertyDescriptor(p, 'value');");
  out.push('      if (d?.set) { nv = d.set; break; }');
  out.push('      p = Object.getPrototypeOf(p);');
  out.push('    }');
  out.push('    if (nv) nv.call(el, value); else el.value = value;');
  out.push("    el.dispatchEvent(new Event('input', { bubbles: true }));");
  out.push("    el.dispatchEvent(new Event('change', { bubbles: true }));");
  out.push('  };');
  out.push('');
  // _findChild supports {fallback:A|B|C} in condition fields — tries each value
  // in order and returns the first matching child element. An empty segment is
  // a Blank: it matches a child whose field is empty (see content.js).
  out.push('  const _findChild = (parent, cond) => {');
  out.push("    const _fbRe = /^\\{fallback:(.+)\\}$/;");
  out.push("    const _fbField = ['valueEquals','textContains','idContains','classContains','typeEquals'].find(f => cond[f] != null && _fbRe.test(String(cond[f])));");
  out.push("    const _fbVals  = _fbField ? String(cond[_fbField]).match(_fbRe)[1].split('|').map(s=>s.trim()) : null;");
  out.push("    const _tryFind = (c, blankField) => {");
  out.push("      const mode = c.matchMode || 'any';");
  out.push("      const norm = s => (s == null ? '' : String(s).trim().toLowerCase());");
  out.push('      const checks = [];');
  out.push("      if (c.valueEquals   != null && c.valueEquals   !== '') checks.push(el => el.value !== undefined && String(el.value) === String(c.valueEquals));");
  out.push("      if (c.textContains  != null && c.textContains  !== '') { const n = norm(c.textContains);  checks.push(el => norm(el.textContent).includes(n)); }");
  out.push("      if (c.idContains    != null && c.idContains    !== '') { const n = norm(c.idContains);    checks.push(el => norm(el.id).includes(n)); }");
  out.push("      if (c.classContains != null && c.classContains !== '') { const n = norm(c.classContains); checks.push(el => norm(el.className).includes(n)); }");
  out.push("      if (c.typeEquals    != null && c.typeEquals    !== '') checks.push(el => el.type === c.typeEquals);");
  out.push("      if (blankField) checks.push(el => {");
  out.push("        if (blankField === 'valueEquals')   return el.value !== undefined && String(el.value) === '';");
  out.push("        if (blankField === 'textContains')  return norm(el.textContent) === '';");
  out.push("        if (blankField === 'idContains')    return !el.id;");
  out.push("        if (blankField === 'classContains') return norm(el.getAttribute('class')) === '';");
  out.push("        return !el.getAttribute('type');");
  out.push("      });");
  out.push("      if (!checks.length) return null;");
  out.push("      const test = mode === 'all' ? el => checks.every(fn => fn(el)) : el => checks.some(fn => fn(el));");
  out.push('      const walker = document.createTreeWalker(parent, NodeFilter.SHOW_ELEMENT);');
  out.push('      let node = walker.nextNode();');
  out.push('      while (node) { if (test(node)) return node; node = walker.nextNode(); }');
  out.push('      return null;');
  out.push('    };');
  out.push("    if (_fbField && _fbVals) {");
  out.push("      for (const _fv of _fbVals) { const el = _tryFind({...cond, [_fbField]: _fv}, _fv === '' ? _fbField : null); if (el) return el; }");
  out.push("      return null;");
  out.push("    }");
  out.push('    return _tryFind(cond);');
  out.push('  };');
  if (enabled.some(a => a.type === 'readdom')) {
    out.push('');
  out.push('  const _readVal = (el, from, attr) => {');
  out.push('    const tag = String(el.tagName || \'\').toUpperCase(), fld = tag === \'INPUT\' || tag === \'TEXTAREA\';');
  out.push('    const txt = () => (typeof el.innerText === \'string\' ? el.innerText : (el.textContent || \'\'));');
  out.push('    const ws = (s) => String(s == null ? \'\' : s).replace(/\\s+/g, \' \').trim();');
  out.push('    if (from === \'attr\') return el.getAttribute(attr) ?? \'\';');
  out.push('    if (from === \'value\') {');
  out.push('      if (tag === \'SELECT\' && el.multiple) return Array.from(el.selectedOptions).map(o => o.value).join(\', \');');
  out.push('      if (fld || tag === \'SELECT\') return el.value ?? \'\';');
  out.push('      if (el.isContentEditable) return txt().trim();');
  out.push('      if (typeof el.value === \'string\' && el.value !== \'\') return el.value;');
  out.push('      if (typeof el.value === \'number\' && tag !== \'LI\') return String(el.value);');
  out.push('      return txt().trim();');
  out.push('    }');
  out.push('    if (from === \'visible\') {');
  out.push('      if (tag === \'SELECT\') return Array.from(el.selectedOptions).map(o => ws(o.text)).join(\', \');');
  out.push('      if (fld) return el.value ?? \'\';');
  out.push('      return ws(txt());');
  out.push('    }');
  out.push('    return (el.textContent || \'\').trim();');
  out.push('  };');
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

  return {
    code: out.join('\n'),
    stats: {
      total: enabled.length, supported, skipped, hasNavigate,
      staticVarCount: Object.keys(staticVars).length,
      randomVarCount: Object.keys(randomSpecs).length
    },
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
    noticeLines: (stats) => (stats.skipped > 0
      ? [`${stats.skipped} action(s) skipped (screenshot/switch — requires Extension API)`]
      : []),
    isSkipped: (a) => SKIPPED_TYPES.has(a.type),
    copyText: _toBookmarkletUrl,
    // .js file: pretty-printed, without javascript: prefix
    file: (code) => ({ text: _toJsFile(code), type: 'application/javascript' }),
  });
}

// Produce a single-line bookmark URL: drop // comment lines, collapse whitespace.
// Keeps the javascript: prefix so it's ready to paste into a bookmark URL field.
function _toBookmarkletUrl(code) {
  return code
    .split('\n')
    .map(line => {
      const t = line.trim();
      return t.startsWith('//') ? '' : t;
    })
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
