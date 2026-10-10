import { commentText } from './utils.js';
import { initExportModal } from './export-modal.js';
import { getSwitchLayout } from '../shared/switch-blocks.js';
import { normalizeVarName } from '../shared/var-name.js';
import { patternVarNames, patternRegexSource } from '../shared/text-pattern.js';
import { cssEscape } from '../shared/css-escape.js';
import { waitMs } from '../shared/wait-ms.js';
import { mark } from './export/steps.js';
import { exportVariables, locatorsFor, walkActions, warnUndefinedVars } from './export/walk.js';
import {
  CLICK_JS, HOVER_JS, SET_INPUT_JS, DRAG_DROP_JS, FIND_CHILD_JS, READ_VAL_JS, CHECK_COND_JS, CONDITION_TYPES, FIND_TEXT_JS,
  PICK_ITEM_JS,
} from './export/page-js.js';
import { JS_RESERVED, jsIdentifier, jsValue, jsConditions, randomFnJS } from './export/js-code.js';

const SKIPPED_TYPES = new Set([
  'screenshot', 'screenshot_full', 'screenshot_element', 'screenshot_tovar', 'switch'
]);

// Identifiers the generated bookmarklet declares for itself, plus the JS reserved
// words (js-code.js).
const _RESERVED_JS = new Set([
  'sleep', 'getEl', '_qsel', '_first', '_findText', '_click', '_hover', '_setInput', '_dragDrop', '_findChild', '_readVal', '_checkCond', '_pickIdx', '_pickItem', 'err', 'res', 'rej', 'obs',
  'domVar', '_at',
  ...JS_RESERVED,
]);

// The names of the steps' own values (_el3, _el3_t, _nav1, _at1) and of the Random generators.
const _sanitizeVarName = jsIdentifier(_RESERVED_JS, /^_(el|nav|at)\d+(_|$)|^_gen_/);

// One locator as _qsel takes it: a CSS or XPath string (XPath when it starts with
// / or (), or { text, tag } for the Text search.
function locToJS({ type, value, tag }) {
  switch (type) {
    case 'id':     return valueToJS('#' + cssEscape(value));
    case 'name':   return valueToJS(`[name="${cssEscape(value)}"]`);
    case 'testId': return valueToJS(`[data-testid="${cssEscape(value)}"]`);
    case 'dataId': return valueToJS(`[data-id="${cssEscape(value)}"]`);
    case 'text':   return `{ text: ${valueToJS(value)}${tag ? `, tag: ${JSON.stringify(tag)}` : ''} }`;
    default:       return valueToJS(value); // css, xpath, fullXpath
  }
}

// What getEl and _first take: the one locator as it always was, else all of them
// in order — each once: an id and the CSS "#id" are the same selector here.
function locsJS(locs) {
  const js = [...new Set(locs.map(locToJS))];
  return js.length === 1 ? js[0] : `[${js.join(', ')}]`;
}

const valueToJS = jsValue(_sanitizeVarName);

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
  const el = type.startsWith('url') ? 'null' : `_first(${locsJS(locatorsFor(action))})`;
  return [head, `if (_checkCond(${JSON.stringify(type)}, ${el}, ${valueToJS(action.expectedValue)})) {`];
}

// Generates JS lines for a single non-condition action, and marks `step`
// (export/steps.js) when the action is not exported as is.
function actionLines(action, step, stepDelay, elTimeout, ctx) {
  const stepNum = step.n;
  const lbl = action.label ? ` — ${commentText(action.label)}` : '';
  // A number, whatever an imported scenario holds: it is written into the code.
  const delay = action.delay != null ? Number(action.delay) : stepDelay;
  const sel = locsJS(locatorsFor(action));
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
        out.push(`const ${v}_p = await getEl(${sel}, ${elTimeout});`);
        out.push(`const ${v} = _findChild(${v}_p, ${jsConditions(action.conditions, valueToJS)});`);
        out.push(`if (!${v}) throw new Error('Child condition not matched (step ${stepNum})');`);
      } else {
        out.push(`const ${v} = await getEl(${sel}, ${elTimeout});`);
      }
      out.push(`_click(${v});`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;

    case 'input':
      out.push(`// Step ${stepNum}: input${lbl}`);
      if (action.conditions) {
        out.push(`const ${v}_p = await getEl(${sel}, ${elTimeout});`);
        out.push(`const ${v} = _findChild(${v}_p, ${jsConditions(action.conditions, valueToJS)});`);
        out.push(`if (!${v}) throw new Error('Child condition not matched (step ${stepNum})');`);
      } else {
        out.push(`const ${v} = await getEl(${sel}, ${elTimeout});`);
      }
      out.push(`_setInput(${v}, ${valueToJS(action.value)});`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;

    case 'hover':
      out.push(`// Step ${stepNum}: hover${lbl}`);
      if (action.conditions) {
        out.push(`const ${v}_p = await getEl(${sel}, ${elTimeout});`);
        out.push(`const ${v} = _findChild(${v}_p, ${jsConditions(action.conditions, valueToJS)});`);
        out.push(`if (!${v}) throw new Error('Child condition not matched (step ${stepNum})');`);
      } else {
        out.push(`const ${v} = await getEl(${sel}, ${elTimeout});`);
      }
      out.push(`_hover(${v});`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;

    case 'dropdown':
      if (action.pick) {
        out.push(`// Step ${stepNum}: dropdown → item #${_pickLabel(action)}${lbl}`);
        out.push(`const ${v} = await getEl(${sel}, ${elTimeout});`);
        out.push(`await _pickItem(${v}, ${valueToJS(action.pick.index)}, ${valueToJS(action.pick.itemSelector || '')}, ${elTimeout});`);
        if (delay > 0) out.push(`await sleep(${delay});`);
        break;
      }
      out.push(`// Step ${stepNum}: open dropdown (freeze)${lbl}`);
      out.push(`const ${v} = await getEl(${sel}, ${elTimeout});`);
      out.push(`${v}.click();`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;

    case 'dragdrop': {
      const tgt = locsJS(locatorsFor(action, true));
      out.push(`// Step ${stepNum}: dragdrop${lbl}`);
      out.push(`const ${v}_s = await getEl(${sel}, ${elTimeout});`);
      out.push(`const ${v}_t = await getEl(${tgt}, ${elTimeout});`);
      out.push(`_dragDrop(${v}_s, ${v}_t);`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;
    }

    case 'navigate': {
      // The action editor writes navigate targets to .url; imported/older scenarios
      // sometimes carry .value instead — the Python export already accepted both.
      const url = valueToJS(action.url || action.value);
      out.push(`// Step ${stepNum}: navigate${lbl}`);
      if (stepNum === ctx.firstNavigate) {
        // A bookmarklet ends with its page. Clicked elsewhere, it opens this one and
        // stops; clicked again there, it finds itself on it and plays the rest. The
        // page is the same one whatever its #fragment or trailing slash.
        mark(step, 'verify', 'opens the page and stops: run the bookmark again on it to play the rest');
        out.push(`const _nav${stepNum} = ${url};`);
        out.push(`const _at${stepNum} = (u) => { const x = new URL(u, location.href); return x.origin + x.pathname.replace(/\\/+$/, '') + x.search; };`);
        out.push(`if (_at${stepNum}(_nav${stepNum}) !== _at${stepNum}(location.href)) {`);
        out.push(`  alert('Opening ' + _nav${stepNum} + '. Run the bookmark again once it has loaded.');`);
        out.push(`  location.href = _nav${stepNum};`);
        out.push(`  return;`);
        out.push(`}`);
        break;
      }
      out.push(`// ⚠ Page will reload — steps after this will not execute unless injected on next load`);
      mark(step, 'verify', 'the page reloads: steps after it do not run in a bookmarklet');
      out.push(`window.location.href = ${url};`);
      out.push(`await sleep(1000);`);
      break;
    }

    case 'wait': {
      out.push(`// Step ${stepNum}: wait${lbl}`);
      out.push(`await sleep(${waitMs(action)});`);
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
        out.push(`const ${v}_p = await getEl(${sel}, ${elTimeout});`);
        out.push(`const ${v} = _findChild(${v}_p, ${jsConditions(action.conditions, valueToJS)});`);
        out.push(`if (!${v}) throw new Error('Child condition not matched (step ${stepNum})');`);
      } else {
        out.push(`const ${v} = await getEl(${sel}, ${elTimeout});`);
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

// The steps, walked as playback walks them (export/walk.js).
function stepLines(stepDelay, elTimeout, ctx) {
  return walkActions(ctx, {
    step: (action, step) => actionLines(action, step, stepDelay, elTimeout, ctx),
    conditionHead: (action, step) => condHeader(action, step.n, step, ctx),
    conditionBody: (lines) => [...indentLines(lines, '  '), '}'],
    // A bookmarklet cannot choose a case.
    skippedBlock: (start, end) => [`// Step ${start + 1}: [SKIPPED] switch block — steps ${start + 2}–${end + 1} not exported (requires Chrome Extension API)`],
    // The step running now, which an error names.
    at: (title) => `_at = ${JSON.stringify(title)};`,
  });
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
  const enabled = (actions || []).filter(a => !a.disabled);
  // writtenVars: the names a step assigns to. screenshot_tovar's too, though the
  // step itself is skipped: without a declaration a later `${shot}` is a
  // ReferenceError that takes down the whole run.
  const { staticVars, randomSpecs, pickSpecs, written: writtenVars } = exportVariables(variables, enabled, _sanitizeVarName, 'JS', warnings);

  const all    = actions || [];
  const layout = getSwitchLayout(all);
  const steps  = [];
  // The step number of a Navigate that comes first (waits aside), else 0.
  const first = enabled.find(a => a.type !== 'wait');
  const firstNavigate = first?.type === 'navigate' ? all.indexOf(first) + 1 : 0;
  const ctx = { staticVars, warnings, all, layout, steps, firstNavigate };
  // The steps first: the helpers declared below depend on what they use.
  const bodyLines = stepLines(stepDelay, elTimeout, ctx);

  const out = [];

  out.push('javascript:(async () => {');
  out.push(`  // ============================`);
  out.push(`  // BOOKMARKLET: ${commentText(scenarioName)}`);
  out.push(`  // ============================`);
  out.push('');
  out.push('  // --- HELPER FUNCTIONS ---');
  out.push('  const sleep = ms => new Promise(r => setTimeout(r, ms));');
  out.push('');
  // A locator is a CSS or XPath string, or { text, tag } for the Text search; a
  // step may give several, tried in order as playback tries them, and one the
  // page cannot parse is passed over as playback passes it over.
  out.push("  const _qsel = sel => (typeof sel === 'object' ? _findText(sel.text, sel.tag || '')");
  out.push("    : (sel.startsWith('/') || sel.startsWith('('))");
  out.push('      ? document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue');
  out.push('      : document.querySelector(sel));');
  out.push('');
  out.push('  const _first = sels => {');
  out.push('    for (const sel of [].concat(sels)) {');
  out.push('      try { const el = _qsel(sel); if (el) return el; } catch (e) { /* a selector this page cannot parse */ }');
  out.push('    }');
  out.push('    return null;');
  out.push('  };');
  out.push('');
  out.push(`  const getEl = (sels, timeout = ${elTimeout}) => new Promise((res, rej) => {`);
  out.push('    const el = _first(sels);');
  out.push('    if (el) return res(el);');
  out.push('    const obs = new MutationObserver(() => {');
  out.push('      const found = _first(sels);');
  out.push('      if (found) { obs.disconnect(); res(found); }');
  out.push('    });');
  out.push('    obs.observe(document.body, { childList: true, subtree: true });');
  // Single-quoted, so the generator leaves `${...}` for the bookmarklet's own template literal.
  out.push('    setTimeout(() => { obs.disconnect(); rej(new Error(`No element found by ${JSON.stringify(sels)}`)); }, timeout);');
  out.push('  });');
  if (bodyLines.some(l => l.includes('{ text: '))) {
    out.push('');
    out.push(...declarePageJs('_findText', FIND_TEXT_JS));
  }
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
  // One empty line between two parts, whichever of them are there.
  const blank = () => { if (out[out.length - 1] !== '') out.push(''); };
  // Only for a step with a Child Condition: it is the longest helper, and the
  // bookmark's URL grows with it.
  if (bodyLines.some((l) => l.includes('_findChild('))) out.push(...declarePageJs('_findChild', FIND_CHILD_JS));
  if (enabled.some(a => a.type === 'condition')) {
    blank();
    out.push(...declarePageJs('_checkCond', CHECK_COND_JS));
  }
  if (enabled.some(a => a.type === 'readdom')) {
    blank();
    out.push(...declarePageJs('_readVal', READ_VAL_JS));
  }

  if (enabled.some(a => a.type === 'dropdown' && a.pick)) {
    blank();
    out.push(...PICK_ITEM_JS.split('\n').map((l) => `  ${l}`));
  }

  if (Object.keys(randomSpecs).length > 0) {
    blank();
    out.push('  // --- RANDOM VARIABLE GENERATORS ---');
    for (const [k, spec] of Object.entries(randomSpecs)) {
      const safe = _sanitizeVarName(k);
      out.push(`  const _gen_${safe} = ${randomFnJS(spec.type, spec.length)};`);
    }
  }

  const hasVars = Object.keys(staticVars).length > 0
    || Object.keys(randomSpecs).length > 0
    || Object.keys(pickSpecs).length > 0
    || writtenVars.size > 0;

  if (hasVars) {
    blank();
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

  blank();
  out.push('  // --- MAIN FLOW ---');
  out.push("  let _at = '';");
  out.push('  try {');
  out.push('');

  for (const line of bodyLines) {
    out.push(line === '' ? '' : '    ' + line);
  }

  out.push("    console.log('✅ Bookmarklet completed successfully.');");
  out.push('');
  out.push('  } catch (err) {');
  out.push("    console.error('❌ Bookmarklet error' + (_at ? ' at ' + _at : '') + ':', err);");
  out.push("    alert('Error' + (_at ? ' at ' + _at : '') + ': ' + err.message);");
  out.push('  }');
  out.push('');
  out.push('})();');

  warnUndefinedVars(enabled, variables, warnings);

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
    format: 'js',
    badge: 'JS',
    title: 'Export JS',
    remember: ['exportBmStepDelay', 'exportBmElTimeout'],
    fileName: (base) => `${base}_bookmarklet.js`,
    readOptions: () => ({
      stepDelay: parseInt(document.getElementById('exportBmStepDelay')?.value) || 300,
      elTimeout: parseInt(document.getElementById('exportBmElTimeout')?.value)  || 5000,
    }),
    generate: generateBookmarklet,
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
