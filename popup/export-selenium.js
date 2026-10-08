import { showToast, getUsedVarNames, commentText } from './utils.js';
import { initExportModal } from './export-modal.js';
import { getSwitchLayout, hasBlock, blockEnd, conditionSkipTarget, conditionSkip } from '../shared/switch-blocks.js';
import { normalizeVarName, writtenVarNames } from '../shared/var-name.js';
import { patternVarNames, patternRegexSource } from '../shared/text-pattern.js';
import { activeValue, parseRandomSpec, parsePickSpec } from '../shared/var-spec.js';
import { CHILD_COND_KEYS } from '../shared/child-cond.js';

function msToSec(ms) {
  return parseFloat((ms / 1000).toFixed(3));
}

// Picks the best available selector and returns { type, value }.
// ID is the most stable selector — prioritised over generic CSS.
function getBestSelInfo(action) {
  const s = action.selectors || {};
  if (s.id)        return { type: 'id',        value: s.id };
  if (s.name)      return { type: 'name',      value: s.name };
  if (s.css)       return { type: 'css',       value: s.css };
  if (s.text)      return { type: 'text',      value: s.text };
  if (s.xpath)     return { type: 'xpath',     value: s.xpath };
  if (s.fullXpath) return { type: 'fullXpath', value: s.fullXpath };
  return { type: action.selectorType || 'css', value: action.selector || '' };
}

function getBestTargetSelInfo(action) {
  const s = action.targetSelectors || {};
  if (s.css)       return { type: 'css',   value: s.css };
  if (s.xpath)     return { type: 'xpath', value: s.xpath };
  if (s.id)        return { type: 'id',    value: s.id };
  if (s.name)      return { type: 'name',  value: s.name };
  return { type: action.targetSelectorType || 'css', value: action.targetSelector || '' };
}

// Returns a Python (By.*, "selector") tuple string. Selectors can hold
// ${var} references, so they go through valueToPy() like any other value.
function selToPy(selInfo) {
  const { type, value } = selInfo;
  switch (type) {
    case 'css':
      return `By.CSS_SELECTOR, ${valueToPy(value)}`;
    case 'id':
      return `By.ID, ${valueToPy(value)}`;
    case 'name':
      return `By.NAME, ${valueToPy(value)}`;
    case 'xpath':
    case 'fullXpath':
      return `By.XPATH, ${valueToPy(value)}`;
    case 'text': {
      // Build XPath using single-quotes when safe, else use concat()
      if (!value.includes("'")) {
        return `By.XPATH, ${valueToPy(`//*[contains(text(), '${value}')]`)}`;
      }
      const parts = value.split("'").map(p => `'${p}'`).join(", \"'\", ");
      return `By.XPATH, ${valueToPy(`//*[contains(text(), concat(${parts}))]`)}`;
    }
    default:
      return `By.CSS_SELECTOR, ${valueToPy(value)}`;
  }
}

// Converts a value that may contain ${varName} to a Python string/f-string.
// Sanitizes variable names to valid Python identifiers (${var-name} → {var_name}).
//
// Escaping order matters and the braces are the subtle part: in an f-string a
// literal { or } has to be doubled, so a value like `{"id":1} for ${host}` used
// to emit `f"{\"id\":1} for {host}"` — Python reads `{\"id\":1}` as a replacement
// field and raises SyntaxError (a backslash inside one is illegal before 3.12).
// Braces are doubled first, then the placeholders are written in, so the names we
// insert are never themselves doubled.
function valueToPy(val) {
  if (val == null) return '""';
  const s = String(val);
  const escapeText = (t) => t
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');

  if (/\$\{/.test(s)) {
    const inner = s
      .split(/(\$\{[^}]+\})/g)
      .map(part => {
        const m = part.match(/^\$\{([^}]+)\}$/);
        // A placeholder becomes a replacement field; everything else is literal
        // text and gets its braces doubled so Python keeps them as characters.
        return m ? `{${safeVarName(m[1])}}` : escapeText(part).replace(/([{}])/g, '$1$1');
      })
      .join('');
    return `f"${inner}"`;
  }
  return JSON.stringify(s);
}

// Names the generated script binds for itself, plus the Python keywords. A
// variable called `driver` or `class` would otherwise overwrite the WebDriver or
// fail to parse, so those get a `_v` suffix.
const _RESERVED_PY = new Set([
  'driver', 'time', 'random', 'string', 'datetime', 'By', 'EC', 'WebDriverWait', '_pick_item', '_pick_index',
  'Select', 'ActionChains', 'NoSuchElementException', 'webdriver', 'e', 'print',
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import',
  'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
  'True', 'try', 'while', 'with', 'yield',
]);

// Python identifiers cannot start with a digit — a variable named `2fa` used to
// emit `2fa = "999"`, a SyntaxError that takes the whole script down.
function safeVarName(name) {
  const safe = String(name == null ? 'var' : name)
    .replace(/^\$\{|\}$/g, '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^\d/, '_') || 'var';
  return _RESERVED_PY.has(safe) ? safe + '_v' : safe;
}

// True when a `script` action's source references a variable, which decides
// whether the generated file needs the _js() escaping helper.
function scriptUsesVars(action) {
  return /\$\{[^}]+\}/.test(String(action.code || action.value || ''));
}

/**
 * Emits the driver.execute_script(...) call for a `script` action.
 *
 * The source used to be passed through verbatim, so a `${q}` sitting inside a JS
 * string literal stayed literal text and never picked up the value — playback
 * substitutes it via _applyVarsToCode() in bg/interpolate.js. Emitting an f-string lets
 * Python do the same substitution at run time, which works for random and readdom
 * values too, and _js() applies the same escaping so a quote in a value cannot
 * terminate the surrounding JS literal.
 *
 * Literal braces are doubled — JS code is mostly braces, so without that every
 * block would read as an f-string replacement field.
 */
function _scriptToPy(rawCode) {
  const code    = String(rawCode);
  const hasVars = /\$\{[^}]+\}/.test(code);

  // Escape for a triple-quoted Python literal: backslashes first, then any run
  // that could close the literal early.
  let body = code.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  if (hasVars) {
    body = body
      .split(/(\$\{[^}]+\})/g)
      .map(part => {
        const m = part.match(/^\$\{([^}]+)\}$/);
        return m ? `{_js(${safeVarName(m[1])})}` : part.replace(/([{}])/g, '$1$1');
      })
      .join('');
  }

  const prefix = hasVars ? 'f' : '';
  if (!body.includes('\n')) return [`driver.execute_script(${prefix}"""${body}""")`];

  // The closing delimiter goes on its own line so a source ending in `"` cannot
  // run into it.
  return [`driver.execute_script(${prefix}"""`, ...body.split('\n'), `""")`];
}

// The _js() runtime helper — same escaping as _applyVarsToCode() in bg/interpolate.js.
function _jsEscapeHelperPy() {
  return [
    'def _js(v):',
    '    """Escape a value for inlining into JS source (mirrors the extension\'s playback)."""',
    '    return (str(v).replace("\\\\", "\\\\\\\\").replace(\'"\', \'\\\\"\').replace("\'", "\\\\\'")',
    '            .replace("`", "\\\\`").replace("${", "\\\\${")',
    '            .replace("\\n", "\\\\n").replace("\\r", "\\\\r"))',
  ];
}

// Generates the Python if-condition expression for a condition action
function condExprPy(action, selPy) {
  const exp = valueToPy(action.expectedValue);
  switch (action.conditionType) {
    case 'elementExists':
      return `len(driver.find_elements(${selPy})) > 0`;
    case 'elementNotExists':
      return `len(driver.find_elements(${selPy})) == 0`;
    case 'elementVisible':
      return `(lambda _e: bool(_e) and _e[0].is_displayed())(driver.find_elements(${selPy}))`;
    case 'elementHidden':
      return `(lambda _e: not _e or not _e[0].is_displayed())(driver.find_elements(${selPy}))`;
    case 'textContains':
      return `(driver.find_element(${selPy}).text if driver.find_elements(${selPy}) else '') and ${exp} in driver.find_element(${selPy}).text`;
    case 'textEquals':
      return `(driver.find_element(${selPy}).text.strip() if driver.find_elements(${selPy}) else '') == ${exp}`;
    case 'valueEquals':
      return `(driver.find_element(${selPy}).get_attribute('value') or '' if driver.find_elements(${selPy}) else '') == ${exp}`;
    case 'valueContains':
      return `${exp} in (driver.find_element(${selPy}).get_attribute('value') or '' if driver.find_elements(${selPy}) else '')`;
    case 'urlContains':
      return `${exp} in driver.current_url`;
    case 'urlEquals':
      return `driver.current_url == ${exp}`;
    case 'hasClass':
      return `${exp} in (driver.find_element(${selPy}).get_attribute('class') or '' if driver.find_elements(${selPy}) else '')`;
    case 'hasAttribute': {
      // If expectedValue is "attr=value", split on the first '=' and generate
      // a proper attribute-value comparison (get_attribute("attr=value") always returns None).
      const rawExp = String(action.expectedValue || '');
      const eqIdx  = rawExp.indexOf('=');
      if (eqIdx > 0) {
        // Both halves go through valueToPy: JSON.stringify used to freeze a
        // `data-id=${host}` into the literal string "${host}".
        const attrNamePy = valueToPy(rawExp.slice(0, eqIdx));
        const attrValPy  = valueToPy(rawExp.slice(eqIdx + 1));
        return `(driver.find_element(${selPy}).get_attribute(${attrNamePy}) == ${attrValPy}) if driver.find_elements(${selPy}) else False`;
      }
      // No '=' — check that the attribute exists (non-null, non-empty)
      return `bool(driver.find_element(${selPy}).get_attribute(${exp})) if driver.find_elements(${selPy}) else False`;
    }
    default:
      // A type this version does not know. Not "True  # unknown …": the comment
      // took the `:` of the `if` with it and the script did not parse.
      return null;
  }
}

function _readValHelperPy() {
  return [
    '# Same reader as the extension (content.js readElementValue).',
    '_READ_VAL_JS = """',
    'const el = arguments[0], from = arguments[1], attr = arguments[2];',
    'const tag = String(el.tagName || \'\').toUpperCase(), fld = tag === \'INPUT\' || tag === \'TEXTAREA\';',
    'const txt = () => (typeof el.innerText === \'string\' ? el.innerText : (el.textContent || \'\'));',
    'const ws = (s) => String(s == null ? \'\' : s).replace(/\\s+/g, \' \').trim();',
    'if (from === \'attr\') return el.getAttribute(attr) ?? \'\';',
    'if (from === \'value\') {',
    '  if (tag === \'SELECT\' && el.multiple) return Array.from(el.selectedOptions).map(o => o.value).join(\', \');',
    '  if (fld || tag === \'SELECT\') return el.value ?? \'\';',
    '  if (el.isContentEditable) return txt().trim();',
    '  if (typeof el.value === \'string\' && el.value !== \'\') return el.value;',
    '  if (typeof el.value === \'number\' && tag !== \'LI\') return String(el.value);',
    '  return txt().trim();',
    '}',
    'if (from === \'visible\') {',
    '  if (tag === \'SELECT\') return Array.from(el.selectedOptions).map(o => ws(o.text)).join(\', \');',
    '  if (fld) return el.value ?? \'\';',
    '  return ws(txt());',
    '}',
    'return (el.textContent || \'\').trim();',
    '"""',
    '',
    '',
    'def _read_val(el, read_from, attr=""):',
    '    return driver.execute_script(_READ_VAL_JS, el, read_from, attr) or ""',
  ];
}

/**
 * The _pick_item() runtime helper: a Dropdown's "Choose item #", mirroring
 * _pickItem in the bookmarklet export. _pick_index is pickItemIndex of
 * shared/dropdown-pick.js.
 */
function _pickItemHelperPy() {
  return String.raw`
def _pick_index(raw, count, ok):
    s = str(raw).strip()
    if s.lower() == "random":
        pool = [k for k in range(count) if ok(k)]
        if not pool:
            raise Exception(f"Dropdown: no item to choose at random ({count} found)")
        return random.choice(pool)
    if not re.fullmatch(r"-?[0-9]+", s) or int(s) == 0:
        raise Exception(f'Dropdown: "{s}" is not an item number')
    n = int(s)
    k = n - 1 if n > 0 else count + n
    if k < 0 or k >= count:
        raise Exception(f"Dropdown: there is no item #{n} ({count} found)")
    return k


def _pick_item(el, raw, item_sel, timeout):
    if el.tag_name == "select":
        opts = el.find_elements(By.TAG_NAME, "option")
        k = _pick_index(raw, len(opts), lambda i: opts[i].is_enabled() and opts[i].get_attribute("value") != "")
        if not opts[k].is_enabled():
            raise Exception(f"Dropdown: item #{k + 1} is disabled")
        Select(el).select_by_index(k)
        return
    el.click()
    end = time.time() + timeout
    while True:
        items = [e for e in driver.find_elements(By.CSS_SELECTOR, item_sel or '[role="option"]') if e.is_displayed()]
        try:
            k = _pick_index(raw, len(items), lambda i: items[i].get_attribute("aria-disabled") != "true" and items[i].text.strip() != "")
            break
        except Exception:
            if time.time() >= end:
                raise
            time.sleep(0.1)
    if items[k].get_attribute("aria-disabled") == "true":
        raise Exception(f"Dropdown: item #{k + 1} is disabled")
    items[k].click()`.split('\n').slice(1);
}


/**
 * The _find_child() runtime helper, mirroring _findChild in the JS bookmarklet
 * export and findElementByCondition in content.js.
 *
 * Each `lambda el, n=...` binds its needle as a default argument on purpose:
 * Python closures capture the variable, not the value, so a plain `lambda el: n
 * in ...` would make every check see the last needle assigned.
 */
function _findChildHelperPy() {
  return [
    '_FALLBACK_RE = re.compile(r"^\\{fallback:(.+)\\}$")',
    '',
    '',
    'def _find_child(parent, cond, mode="any"):',
    '    """First descendant of `parent` matching `cond`.',
    '',
    '    A field may hold a {fallback:A|B|C} spec — Fallback variables only expand',
    '    into one at run time — and each candidate is then tried in order. An',
    '    empty candidate is a Blank: it matches a child whose field is empty.',
    '    """',
    '    fb_field, fb_values = None, None',
    `    for _f in (${CHILD_COND_KEYS.map((k) => `"${k}"`).join(', ')}):`,
    '        _m = _FALLBACK_RE.match(str(cond.get(_f, "")))',
    '        if _m:',
    '            fb_field = _f',
    '            fb_values = [v.strip() for v in _m.group(1).split("|")]',
    '            break',
    '',
    '    def norm(s):',
    '        return "" if s is None else str(s).strip().lower()',
    '',
    '    def is_blank(el, field):',
    '        if field == "valueEquals":',
    '            return (el.get_attribute("value") or "") == ""',
    '        if field == "textContains":',
    '            return norm(el.text) == ""',
    '        attr = {"idContains": "id", "classContains": "class"}.get(field, "type")',
    '        return norm(el.get_attribute(attr)) == ""',
    '',
    '    def try_find(c, blank_field=None):',
    '        checks = []',
    '        if blank_field:',
    '            checks.append(lambda el, f=blank_field: is_blank(el, f))',
    '        if c.get("valueEquals"):',
    '            checks.append(lambda el, v=str(c["valueEquals"]): (el.get_attribute("value") or "") == v)',
    '        if c.get("textContains"):',
    '            checks.append(lambda el, n=norm(c["textContains"]): n in norm(el.text))',
    '        if c.get("idContains"):',
    '            checks.append(lambda el, n=norm(c["idContains"]): n in norm(el.get_attribute("id")))',
    '        if c.get("classContains"):',
    '            checks.append(lambda el, n=norm(c["classContains"]): n in norm(el.get_attribute("class")))',
    '        if c.get("typeEquals") == "select":',
    '            checks.append(lambda el: el.tag_name.lower() == "select")',
    '        elif c.get("typeEquals"):',
    '            checks.append(lambda el, v=str(c["typeEquals"]): (el.get_attribute("type") or "") == v)',
    '        if not checks:',
    '            return None',
    '        test = all if mode == "all" else any',
    '',
    '        def first(root):',
    '            for el in root.find_elements(By.XPATH, ".//*"):',
    '                if test(fn(el) for fn in checks):',
    '                    return el',
    '            return None',
    '',
    '        # Every wrapper holds the text too: go down to the innermost match.',
    '        hit = first(parent)',
    '        if hit is not None and c.get("textContains"):',
    '            inner = first(hit)',
    '            while inner is not None:',
    '                hit, inner = inner, first(inner)',
    '        return hit',
    '',
    '    if fb_field and fb_values is not None:',
    '        for fv in fb_values:',
    '            el = try_find({**cond, fb_field: fv}, fb_field if fv == "" else None)',
    '            if el is not None:',
    '                return el',
    '        return None',
    '    return try_find(cond)',
  ];
}

/**
 * Builds Python lines to locate a child element matching action.conditions.
 *
 * The criteria are handed to the generated _find_child() helper as a dict rather
 * than being unrolled into loops here. That is what makes Fallback variables work:
 * a `{fallback:A|B|C}` spec reaching a field through `${city}` only exists once
 * the f-string has been evaluated, so deciding at export time — as the old
 * unrolled version did — compared against the literal spec text and never matched.
 * The JS bookmarklet's _findChild has always resolved this at run time.
 */
function _buildChildCondPy(conditions, elVar, tout, selPy, stepNum) {
  const cond  = conditions;
  const mode  = cond.matchMode || 'any';
  const lines = [];

  const parts = [];
  for (const f of CHILD_COND_KEYS) {
    if (cond[f] != null && String(cond[f]) !== '') {
      parts.push(`"${f}": ${valueToPy(String(cond[f]))}`);
    }
  }

  lines.push(`${elVar}_p = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${selPy})))`);
  lines.push(`${elVar} = _find_child(${elVar}_p, {${parts.join(', ')}}, ${JSON.stringify(mode)})`);
  lines.push(`if ${elVar} is None:`);
  lines.push(`    raise Exception("Child condition not matched (step ${stepNum})")`);
  return lines;
}

// Generates Python lines for a single non-condition action
function actionLines(action, stepNum, stepDelay, elTimeout) {
  const lbl    = action.label ? ` — ${commentText(action.label)}` : '';
  const delay  = msToSec(action.delay != null ? action.delay : stepDelay);
  const tout   = msToSec(elTimeout);
  const sel    = getBestSelInfo(action);
  const selPy  = selToPy(sel);
  const elVar  = `el${stepNum}`;
  const out    = [];

  switch (action.type) {
    case 'click':
      out.push(`# Step ${stepNum}: click${lbl}`);
      if (action.conditions) {
        out.push(..._buildChildCondPy(action.conditions, elVar, tout, selPy, stepNum));
      } else {
        out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.element_to_be_clickable((${selPy})))`);
      }
      out.push(`${elVar}.click()`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'input': {
      const val = valueToPy(action.value);
      out.push(`# Step ${stepNum}: input${lbl}`);
      if (action.conditions) {
        out.push(..._buildChildCondPy(action.conditions, elVar, tout, selPy, stepNum));
      } else {
        out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${selPy})))`);
      }
      out.push(`if ${elVar}.tag_name == 'select':`);
      out.push(`    try:`);
      out.push(`        Select(${elVar}).select_by_value(${val})`);
      out.push(`    except Exception:`);
      out.push(`        Select(${elVar}).select_by_visible_text(${val})`);
      out.push(`else:`);
      out.push(`    ${elVar}.clear()`);
      out.push(`    ${elVar}.send_keys(${val})`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;
    }

    case 'hover':
      out.push(`# Step ${stepNum}: hover${lbl}`);
      if (action.conditions) {
        out.push(..._buildChildCondPy(action.conditions, elVar, tout, selPy, stepNum));
      } else {
        out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${selPy})))`);
      }
      out.push(`ActionChains(driver).move_to_element(${elVar}).perform()`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'dropdown':
      if (action.pick) {
        out.push(`# Step ${stepNum}: dropdown → item #${String(action.pick.index ?? '?').replace(/\s+/g, ' ')}${lbl}`);
        out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.element_to_be_clickable((${selPy})))`);
        out.push(`_pick_item(${elVar}, ${valueToPy(action.pick.index)}, ${valueToPy(action.pick.itemSelector || '')}, ${tout})`);
        if (delay > 0) out.push(`time.sleep(${delay})`);
        break;
      }
      out.push(`# Step ${stepNum}: open dropdown (freeze)${lbl}`);
      out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.element_to_be_clickable((${selPy})))`);
      out.push(`${elVar}.click()`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'dragdrop': {
      const tgt   = getBestTargetSelInfo(action);
      const tgtPy = selToPy(tgt);
      out.push(`# Step ${stepNum}: drag & drop${lbl}`);
      out.push(`${elVar}_src = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${selPy})))`);
      out.push(`${elVar}_tgt = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${tgtPy})))`);
      out.push(`ActionChains(driver).drag_and_drop(${elVar}_src, ${elVar}_tgt).perform()`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;
    }

    case 'navigate': {
      const url = valueToPy(action.value || action.url);
      out.push(`# Step ${stepNum}: navigate${lbl}`);
      out.push(`driver.get(${url})`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;
    }

    case 'wait': {
      const ms = msToSec(action.delay != null ? action.delay : (parseInt(action.value) || 1000));
      out.push(`# Step ${stepNum}: wait${lbl}`);
      out.push(`time.sleep(${ms})`);
      break;
    }

    case 'script': {
      const code = (action.code || action.value || '').trim();
      out.push(`# Step ${stepNum}: execute script${lbl}`);
      out.push(`# ⚠ Original JS — verify logic works via execute_script()`);
      out.push(..._scriptToPy(code));
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;
    }

    case 'readdom': {
      // Extract: each ${name} of the pattern takes its part of the text, and
      // "Save to var" (optional then) keeps the whole text — shared/text-pattern.js.
      const slots   = action.pattern ? patternVarNames(action.pattern) : [];
      const vn      = normalizeVarName(action.varName);
      let varName;
      if (vn) varName = safeVarName(vn);
      else varName = slots.length ? null : 'dom_var';
      const targets = [varName, ...slots.map(safeVarName)].filter(Boolean);
      out.push(`# Step ${stepNum}: read DOM → ${targets.map(t => `"${t}"`).join(', ')}${lbl}`);
      if (action.conditions) {
        out.push(..._buildChildCondPy(action.conditions, elVar, tout, selPy, stepNum));
      } else {
        out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${selPy})))`);
      }
      // _read_val runs the extension's own reader in the page, so "Text content"
      // (textContent) and "Visible text" (innerText) match playback exactly.
      const readExpr = `_read_val(${elVar}, ${JSON.stringify(action.readFrom || 'text')}, ${valueToPy(action.attrName || '')})`;
      if (!slots.length) {
        out.push(`${varName} = ${readExpr}`);
      } else {
        // The regex source only uses syntax JS and Python's re read alike, and a
        // JSON string is a valid Python string literal.
        out.push(`${elVar}_t = ${readExpr}`);
        if (varName) out.push(`${varName} = ${elVar}_t`);
        out.push(`${elVar}_m = re.search(${JSON.stringify(patternRegexSource(action.pattern))}, ${elVar}_t${action.matchCase ? '' : ', re.I'})`);
        out.push(`if not ${elVar}_m:`);
        out.push(`    raise Exception(${JSON.stringify(`Read DOM (step ${stepNum}): text does not match ${String(action.pattern).trim()}: `)} + ${elVar}_t)`);
        slots.forEach((n, k) => out.push(`${safeVarName(n)} = ${elVar}_m.group(${k + 1}).strip()`));
      }
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;
    }

    case 'screenshot':
      out.push(`# Step ${stepNum}: screenshot (visible)${lbl}`);
      out.push(`driver.save_screenshot(f"screenshot_step${stepNum}.png")`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'screenshot_full':
      out.push(`# Step ${stepNum}: screenshot (full page)${lbl}`);
      out.push(`# Note: full-page screenshot requires a compatible driver (e.g. Firefox)`);
      out.push(`driver.save_screenshot(f"screenshot_full_step${stepNum}.png")`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'screenshot_element':
      out.push(`# Step ${stepNum}: screenshot element${lbl}`);
      out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${selPy})))`);
      out.push(`${elVar}.screenshot(f"screenshot_element_step${stepNum}.png")`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'screenshot_tovar': {
      const varName = safeVarName(action.varName || 'screenshot');
      out.push(`# Step ${stepNum}: screenshot → variable "${varName}"${lbl}`);
      out.push(`_ss_file${stepNum} = f"screenshot_${varName}_step${stepNum}.png"`);
      if (action.target === 'element' && sel.value) {
        out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${selPy})))`);
        out.push(`${elVar}.screenshot(_ss_file${stepNum})`);
      } else {
        out.push(`driver.save_screenshot(_ss_file${stepNum})`);
      }
      out.push(`${varName} = _ss_file${stepNum}`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;
    }

    case 'switch':
      out.push(`# Step ${stepNum}: switch [SKIPPED] — requires extension scenario routing`);
      break;

    default:
      out.push(`# Step ${stepNum}: ${commentText(action.type)}${lbl} — [unsupported, skipped]`);
  }

  return out;
}

// Recursively processes an action array, grouping condition blocks
// Disabled actions are skipped inline so skipCount stays aligned with the original array.
function processActions(actions, baseIdx, stepDelay, elTimeout, ctx = {}) {
  const out = [];
  let i = 0;

  while (i < actions.length) {
    const action  = actions[i];
    const abs     = baseIdx + i;

    // A Switch block only ever runs one of its cases; the script cannot pick
    // one, and emitting the block would run every case in a row.
    if (ctx.all && hasBlock(ctx.all[abs])) {
      const end = blockEnd(ctx.all, abs);
      out.push(`# Step ${abs + 1}: switch block [SKIPPED] — steps ${abs + 2}–${end + 1} not exported (requires extension scenario routing)`);
      out.push('');
      ctx.warnings?.add(`Switch block at step ${abs + 1} skipped together with its ${end - abs} action(s)`);
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
      const lbl  = action.label ? ` — ${commentText(action.label)}` : '';
      const sel  = getBestSelInfo(action);
      const selPy = selToPy(sel);

      out.push(`# Step ${stepNum}: condition — ${commentText(action.conditionType)}${lbl}`);
      const condPy = condExprPy(action, selPy);
      if (condPy === null) {
        ctx.warnings?.add(`Condition step ${stepNum}: type "${action.conditionType}" is unknown — exported as always true`);
      }
      out.push(`if ${condPy ?? 'True'}:`);

      // Same span playback skips: a Switch and its block count as one action.
      const bodyEnd   = ctx.all ? conditionSkipTarget(ctx.all, abs, skipCount, ctx.layout) - baseIdx : i + 1 + skipCount;
      const body      = actions.slice(i + 1, bodyEnd);
      const bodyLines = processActions(body, baseIdx + i + 1, stepDelay, elTimeout, ctx);
      if (bodyLines.length === 0 || bodyLines.every(l => l === '')) {
        out.push('    pass');
      } else {
        for (const line of bodyLines) {
          out.push(line === '' ? '' : '    ' + line);
        }
      }
      out.push('');
      i = Math.max(i + 1, bodyEnd);
    } else {
      out.push(...actionLines(action, stepNum, stepDelay, elTimeout));
      out.push('');
      i++;
    }
  }

  return out;
}

/**
 * Generate a complete Selenium Python script for the given scenario.
 *
 * @param {string}   scenarioName      - Human-readable name used in comments/print.
 * @param {object[]} actions           - Scenario action array; disabled actions are skipped.
 * @param {object}   variables         - Key/value pairs; random specs expand at run time.
 * @param {object}   opts
 * @param {number}   opts.stepDelay    - Default inter-step `time.sleep()` in ms (default 500).
 * @param {number}   opts.elTimeout    - `WebDriverWait` timeout in ms (default 10000).
 * @param {string}   opts.driverType   - Selenium driver class name, e.g. "Chrome" (default).
 * @param {string}   opts.startUrl     - Initial `driver.get()` URL when first action is not navigate.
 * @returns {{ code: string, stats: { total, supported, skipped, hasScript, hasScreenshot } }}
 */
export function generateSeleniumPy(scenarioName, actions, variables, opts = {}) {
  const { stepDelay = 500, elTimeout = 10000, driverType = 'Chrome', startUrl = '' } = opts;

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

  // Names a step assigns to. screenshot_tovar belongs here too: it writes inside
  // the flow, so a run where its branch never executes leaves a later reference
  // with nothing bound (NameError).
  for (const a of enabled) {
    for (const vn of writtenVarNames(a)) writtenVars.add(safeVarName(vn));
  }

  // Two different names can sanitize to the same Python identifier, which
  // silently drops one of them.
  const _byIdent = new Map();
  for (const k of [...Object.keys(staticVars), ...Object.keys(randomSpecs), ...Object.keys(pickSpecs)]) {
    const ident = safeVarName(k);
    if (_byIdent.has(ident) && _byIdent.get(ident) !== k) {
      warnings.add(`"${_byIdent.get(ident)}" and "${k}" both become the Python identifier \`${ident}\` — rename one`);
    } else {
      _byIdent.set(ident, k);
    }
    if (ident !== k) {
      warnings.add(`"${k}" is not a valid Python identifier — exported as \`${ident}\``);
    }
  }

  const all    = actions || [];
  const layout = getSwitchLayout(all);
  // A Switch block is skipped with everything in it (see processActions).
  let skipped = 0, supported = 0, hasScript = false, hasScreenshot = false;
  all.forEach((a, j) => {
    if (!a || a.disabled) return;
    if (a.type === 'switch' || layout[j]?.chain?.length) skipped++;
    else supported++;
    if (a.type === 'script') hasScript = true;
    if (['screenshot', 'screenshot_full', 'screenshot_element', 'screenshot_tovar'].includes(a.type)) hasScreenshot = true;
  });

  const needsRandom       = Object.keys(randomSpecs).length > 0 || Object.keys(pickSpecs).length > 0;
  const needsDatetime     = Object.values(randomSpecs).some(s => s.type === 'datetime');
  const needsActionChains = enabled.some(a => ['hover', 'dragdrop'].includes(a.type));
  const needsCondition    = enabled.some(a => a.type === 'condition');
  const needsChildCond    = enabled.some(a => a.conditions && typeof a.conditions === 'object');
  const needsExtract      = enabled.some(a => a.type === 'readdom' && patternVarNames(a.pattern).length);
  const needsJsEscape     = enabled.some(a => a.type === 'script' && scriptUsesVars(a));
  const needsDropdownPick = enabled.some(a => a.type === 'dropdown' && a.pick);

  const out = [];

  // ── Imports ──
  out.push('import time');
  if (needsRandom)   { out.push('import random'); out.push('import string'); }
  else if (needsDropdownPick) out.push('import random');
  if (needsChildCond || needsExtract || needsDropdownPick) out.push('import re');
  if (needsDatetime)  out.push('from datetime import datetime');
  out.push('from selenium import webdriver');
  out.push('from selenium.webdriver.common.by import By');
  out.push('from selenium.webdriver.support.ui import WebDriverWait, Select');
  out.push('from selenium.webdriver.support import expected_conditions as EC');
  if (needsActionChains) out.push('from selenium.webdriver.common.action_chains import ActionChains');
  if (needsCondition)    out.push('from selenium.common.exceptions import NoSuchElementException');
  out.push('');
  out.push('');

  // ── Runtime helpers ──
  if (needsChildCond) {
    out.push(..._findChildHelperPy());
    out.push('');
    out.push('');
  }
  if (needsJsEscape) {
    out.push(..._jsEscapeHelperPy());
    out.push('');
    out.push('');
  }
  if (enabled.some(a => a.type === 'readdom')) {
    out.push(..._readValHelperPy());
    out.push('');
    out.push('');
  }
  if (needsDropdownPick) {
    out.push(..._pickItemHelperPy());
    out.push('');
    out.push('');
  }

  // ── Header ──
  out.push(`# ============================`);
  out.push(`# SCENARIO: ${commentText(scenarioName)}`);
  out.push(`# ============================`);
  out.push('');
  out.push(`driver = webdriver.${driverType}()`);
  // implicitly_wait is intentionally omitted — it conflicts with WebDriverWait/EC.
  out.push('');

  // If no navigate action exists as the first real step, emit a driver.get() line.
  // Use the user-supplied startUrl if provided, otherwise a TODO placeholder.
  const firstAction = enabled.find(a => a.type !== 'wait');
  if (!firstAction || firstAction.type !== 'navigate') {
    if (startUrl) {
      out.push(`driver.get(${JSON.stringify(startUrl)})`);
    } else {
      out.push('# ⚠ TODO: Set the starting URL (go to Settings tab to configure)');
      out.push('driver.get("https://your-url-here.com")');
    }
    out.push('');
  }

  // ── Variables ──
  const hasVars = Object.keys(staticVars).length > 0 || needsRandom || writtenVars.size > 0;
  if (hasVars) {
    out.push('# --- VARIABLES ---');
    const declared = new Set();

    for (const [k, v] of Object.entries(staticVars)) {
      const safe = safeVarName(k);
      if (declared.has(safe)) continue;
      declared.add(safe);
      out.push(`${safe} = ${JSON.stringify(v)}`);
    }
    for (const [k, spec] of Object.entries(randomSpecs)) {
      const safe = safeVarName(k);
      if (declared.has(safe)) continue;
      declared.add(safe);
      // "datetime" is a type the Variables modal offers and resolveRandomVars()
      // in bg/interpolate.js implements; it used to fall through to the alphanumeric
      // charset here and produce random junk instead of the run's timestamp.
      if (spec.type === 'datetime') {
        out.push(`${safe} = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")`);
        continue;
      }
      let charset;
      if (spec.type === 'alpha') charset = 'string.ascii_letters';
      else if (spec.type === 'numeric') charset = 'string.digits';
      else charset = 'string.ascii_letters + string.digits';
      out.push(`${safe} = ''.join(random.choices(${charset}, k=${spec.length}))`);
    }
    for (const [k, vals] of Object.entries(pickSpecs)) {
      const safe = safeVarName(k);
      if (declared.has(safe)) continue;
      declared.add(safe);
      const pyList = '[' + vals.map(v => JSON.stringify(v)).join(', ') + ']';
      out.push(`${safe} = random.choice(${pyList})`);
    }
    // Only the written names nothing above already seeded. This loop used to run
    // unconditionally, so `seed = "INIT"` from the Variables tab was immediately
    // followed by `seed = ''` and the seed never reached the first step.
    for (const k of writtenVars) {
      if (declared.has(k)) continue;
      declared.add(k);
      out.push(`${k} = ''`);
    }
    out.push('');
  }

  // ── Main flow ──
  out.push('# --- MAIN FLOW ---');
  out.push('try:');
  out.push('');

  const bodyLines = processActions(all, 0, stepDelay, elTimeout, { all, layout, warnings });
  for (const line of bodyLines) {
    out.push(line === '' ? '' : '    ' + line);
  }

  out.push(`    print(${JSON.stringify(`✅ Scenario '${scenarioName}' completed successfully.`)})`);
  out.push('');
  out.push('except Exception as e:');
  out.push('    print(f"❌ Error: {e}")');
  out.push('    raise');
  out.push('');
  out.push('finally:');
  out.push('    driver.quit()');

  // A `${name}` with nothing behind it becomes a NameError the moment the step
  // runs, and the generated file gives no clue where it came from — flag it while
  // the scenario is still on screen.
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
    stats: { total: enabled.length, supported, skipped, hasScript, hasScreenshot },
    warnings: [...warnings],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// UI MODULE — the modal is popup/export-modal.js; what is particular to this export
// ─────────────────────────────────────────────────────────────────────────────

/** Wire the export-Selenium modal trigger and all modal-internal buttons. */
export function initExportSelenium() {
  initExportModal({
    triggerId: 'exportSelenium',
    prefix: 'exportSelenium',
    tabClass: 'export-py-tab',
    title: 'Export Python',
    fileSuffix: '_selenium.py',
    readOptions: _getOpts,
    generate: generateSeleniumPy,
    regenerateFromStorage: false,
    noticeLines: (stats) => {
      const msgs = [];
      if (stats.skipped > 0)  msgs.push(`${stats.skipped} action(s) skipped (switch)`);
      if (stats.hasScript)    msgs.push('script → driver.execute_script() — please review');
      return msgs;
    },
    // Selenium: only 'switch' is skipped; 'script' needs manual verification
    isSkipped: (a) => a.type === 'switch',
    copyText: (code) => code,
    file: (code) => ({ text: code, type: 'text/x-python' }),
    beforeOpen: _autoFillStartUrl,
    wire: () => document.getElementById('exportSeleniumGetUrl')?.addEventListener('click', _fillCurrentUrl),
  });
}

function _getOpts() {
  return {
    stepDelay:  parseInt(document.getElementById('exportSeleniumStepDelay')?.value) || 500,
    elTimeout:  parseInt(document.getElementById('exportSeleniumElTimeout')?.value)  || 10000,
    driverType: document.getElementById('exportSeleniumDriver')?.value || 'Chrome',
    startUrl:   document.getElementById('exportSeleniumStartUrl')?.value.trim() || '',
  };
}

// Auto-fill Starting URL from current tab (if input is still empty)
function _autoFillStartUrl() {
  const urlInput = document.getElementById('exportSeleniumStartUrl');
  if (urlInput && !urlInput.value.trim()) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const url = tabs?.[0]?.url || '';
      if (url && !url.startsWith('chrome://') && !url.startsWith('chrome-extension://')) {
        urlInput.value = url;
        urlInput.dispatchEvent(new Event('input'));
        const badge = document.getElementById('exportSeleniumUrlFromTab');
        if (badge) badge.style.display = '';
      }
    });
  }
}

function _fillCurrentUrl() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const url = tabs?.[0]?.url || '';
    if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
      showToast('Could not get URL from this tab', 'error');
      return;
    }
    const input = document.getElementById('exportSeleniumStartUrl');
    if (input) {
      input.value = url;
      input.dispatchEvent(new Event('input'));
      const badge = document.getElementById('exportSeleniumUrlFromTab');
      if (badge) badge.style.display = '';
    }
  });
}
