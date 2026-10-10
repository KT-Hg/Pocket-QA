import { showToast, getUsedVarNames, commentText } from './utils.js';
import { initExportModal } from './export-modal.js';
import { getSwitchLayout, hasBlock, blockEnd, conditionSkipTarget, conditionSkip } from '../shared/switch-blocks.js';
import { normalizeVarName, writtenVarNames } from '../shared/var-name.js';
import { patternVarNames, patternRegexSource } from '../shared/text-pattern.js';
import { activeValue, parseRandomSpec, parsePickSpec } from '../shared/var-spec.js';
import { CHILD_COND_KEYS } from '../shared/child-cond.js';
import { mark, newStep, blockSteps } from './export/steps.js';
import {
  FIND_CHILD_JS, READ_VAL_JS, CHECK_COND_JS, CONDITION_TYPES, SET_INPUT_JS, FIND_TEXT_JS,
} from './export/page-js.js';
import { locatorsOf } from '../shared/locator-order.js';
import { cssEscape } from '../shared/css-escape.js';
import { waitMs } from '../shared/wait-ms.js';

function msToSec(ms) {
  return parseFloat((ms / 1000).toFixed(3));
}

/**
 * The locators of the element an action acts on — of its drop target with
 * `target` — in the order playback tries them (shared/locator-order.js), the
 * selector type chosen in the form first. Never empty: an action without any
 * keeps the empty CSS selector it always exported.
 */
function locatorsFor(action, target = false) {
  const locs = target
    ? locatorsOf(action.targetSelectors, action.targetSelector, action.targetSelectorType)
    : locatorsOf(action.selectors, action.selector, action.selectorType);
  return locs.length ? locs : [{ type: 'css', value: '' }];
}

// One locator as Python: a (By…, value) pair, or ("text", value[, tag]) for
// _locate's Text search. Values may hold ${var}, so they go through valueToPy().
function locToPy({ type, value, tag }) {
  switch (type) {
    case 'id':        return `(By.ID, ${valueToPy(value)})`;
    case 'name':      return `(By.NAME, ${valueToPy(value)})`;
    case 'xpath':
    case 'fullXpath': return `(By.XPATH, ${valueToPy(value)})`;
    case 'testId':    return `(By.CSS_SELECTOR, ${valueToPy(`[data-testid="${cssEscape(value)}"]`)})`;
    case 'dataId':    return `(By.CSS_SELECTOR, ${valueToPy(`[data-id="${cssEscape(value)}"]`)})`;
    case 'text':      return `("text", ${valueToPy(value)}${tag ? `, ${JSON.stringify(tag)}` : ''})`;
    default:          return `(By.CSS_SELECTOR, ${valueToPy(value)})`;
  }
}

const locsPy = (locs) => `[${locs.map(locToPy).join(', ')}]`;

/**
 * The expression that waits for an element: WebDriverWait on its one By locator,
 * as the export always wrote it, else _find over all its locators in order.
 */
function waitPy(locs, tout, clickable = false) {
  if (locs.length === 1 && locs[0].type !== 'text') {
    return `WebDriverWait(driver, ${tout}).until(EC.${clickable ? 'element_to_be_clickable' : 'presence_of_element_located'}(${locToPy(locs[0])}))`;
  }
  return `_find(${locsPy(locs)}, ${tout}${clickable ? ', clickable=True' : ''})`;
}

/**
 * The _locate() / _find() runtime helpers: findElementWithFallback of content.js,
 * each locator in turn until one finds the element, a selector the browser
 * cannot parse passed over as playback passes it over.
 */
function _locateHelperPy() {
  return [
    '# How the extension finds an element (content.js _locators): each locator in turn',
    '# until one finds it; ("text", t[, tag]) is its Text search, run in the page.',
    ...pyPageJs('_FIND_TEXT_JS', FIND_TEXT_JS),
    '',
    '',
    'def _locate(locators):',
    '    for how, what, *tag in locators:',
    '        try:',
    '            if how == "text":',
    '                el = driver.execute_script(_FIND_TEXT_JS, what, tag[0] if tag else "")',
    '            else:',
    '                found = driver.find_elements(how, what)',
    '                el = found[0] if found else None',
    '        except InvalidSelectorException:',
    '            continue',
    '        if el is not None:',
    '            return el',
    '    return None',
    '',
    '',
    'def _find(locators, timeout, clickable=False):',
    '    def ready(_):',
    '        el = _locate(locators)',
    '        if el is None or (clickable and not (el.is_displayed() and el.is_enabled())):',
    '            return False',
    '        return el',
    '    wait = WebDriverWait(driver, timeout, ignored_exceptions=(StaleElementReferenceException,))',
    '    return wait.until(ready, f"no element found by {locators}")',
  ];
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
  'driver', 'time', 'random', 'string', 'datetime', 'By', 'EC', 'WebDriverWait', '_pick_item', '_pick_index', '_check_cond', '_CHECK_COND_JS',
  '_SCRIPT_INPUT_TYPES', '_SET_INPUT_JS', '_locate', '_find', '_FIND_TEXT_JS',
  'InvalidSelectorException', 'StaleElementReferenceException', '_save_full_page', 'base64', '_options',
  'pytest', 'browser',
  'Select', 'ActionChains', 'webdriver', 'e', 'print',
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

/**
 * The `if` test of a condition action: the in-page check (_check_cond, the
 * CHECK_COND_JS of popup/export/page-js.js) on the element found now — the
 * Selenium expressions it replaces matched `.text` (what Selenium shows) where
 * playback reads textContent, and compared textEquals untrimmed. null for a
 * type this version does not know.
 */
function condExprPy(action, locs) {
  const type = action.conditionType;
  if (!CONDITION_TYPES.has(type)) return null;
  const locator = type.startsWith('url') ? 'None' : locsPy(locs);
  return `_check_cond(${JSON.stringify(type)}, ${locator}, ${valueToPy(action.expectedValue)})`;
}

// The _check_cond() runtime helper: content.js CHECK_CONDITION, run in the page.
function _checkCondHelperPy() {
  return [
    '# Same check as the extension (content.js CHECK_CONDITION), on the element found now.',
    ...pyPageJs('_CHECK_COND_JS', CHECK_COND_JS),
    '',
    '',
    'def _check_cond(cond_type, locators, expected):',
    '    el = _locate(locators) if locators else None',
    '    return driver.execute_script(_CHECK_COND_JS, cond_type, el, expected)',
  ];
}

/**
 * A page-js.js function as a Python string that driver.execute_script() runs
 * with its arguments. Raw, so the JS source's backslashes (\s, \{) reach the page
 * as written: in a plain string they were invalid escapes — a SyntaxWarning on
 * every run, and an error in a later Python.
 */
function pyPageJs(name, src) {
  return `${name} = r"""return (${src}).apply(null, arguments)"""`.split('\n');
}

/**
 * What an Input step needs besides send_keys: the field types it fills through
 * playback's own Input (SET_INPUT_JS) instead. A date's typed format follows the
 * browser's locale — "2026-10-10" became year 61010 in Edge — and a color or a
 * range takes no typing at all.
 */
function _setInputHelperPy() {
  return [
    '# Fields typing cannot fill the same way everywhere: set as the extension sets them.',
    '_SCRIPT_INPUT_TYPES = ("date", "time", "datetime-local", "month", "week", "color", "range")',
    ...pyPageJs('_SET_INPUT_JS', SET_INPUT_JS),
  ];
}

// The drivers the Settings tab offers.
const DRIVER_TYPES = new Set(['Chrome', 'Edge', 'Firefox', 'Safari']);

/**
 * The lines that start the browser: `driver = webdriver.<driverType>()`, or, with
 * `headless`, with the options that run it without a window (Firefox's flag is
 * its own; Safari has none, which is a warning). Headless is what CI needs.
 */
function driverPy(driverType, headless, warnings) {
  if (!headless) return [`driver = webdriver.${driverType}()`];
  if (driverType === 'Safari') {
    warnings.add('Safari has no headless mode — the script opens a window');
    return ['driver = webdriver.Safari()'];
  }
  return [
    `_options = webdriver.${driverType}Options()`,
    `_options.add_argument("${driverType === 'Firefox' ? '-headless' : '--headless=new'}")`,
    `driver = webdriver.${driverType}(options=_options)`,
  ];
}

/**
 * A pytest test of the scenario. The helpers and the steps use the module's
 * `driver`, which the `browser` fixture starts and quits — after a failed step
 * too. The start page, the variables and the steps are the test's body: a step
 * that writes a variable makes it a local of the function, so a seed of it has to
 * be there as well, not at module level.
 */
function pytestLines(driverLines, testName, body) {
  return [
    'driver = None',
    '',
    '',
    '@pytest.fixture',
    'def browser():',
    '    """The browser of the test: the module\'s `driver`, quit even when a step fails."""',
    '    global driver',
    ...driverLines.map((l) => `    ${l}`),
    '    yield driver',
    '    driver.quit()',
    '',
    '',
    `def ${testName}(browser):`,
    ...body.map((l) => (l === '' ? '' : `    ${l}`)),
  ];
}

/**
 * The test function's name: "test_" and the scenario name in lower-case ASCII
 * words — letters of any language folded ("Đăng nhập" → test_dang_nhap) —
 * joined by underscores.
 */
function testFunctionName(scenarioName) {
  const ascii = String(scenarioName ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D');
  return `test_${ascii.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'scenario'}`;
}

/**
 * The line that saves the whole page to `file` (a Python expression), as the
 * driver can: Chrome and Edge through CDP (_save_full_page), Firefox with its own
 * save_full_page_screenshot, Safari only the window (and the step says so).
 * save_screenshot alone saves the window everywhere.
 */
function fullPagePy(file, driverType, step) {
  if (driverType === 'Firefox') return `driver.save_full_page_screenshot(${file})`;
  if (driverType === 'Safari') {
    mark(step, 'verify', 'Safari saves only the visible part of the page');
    return `driver.save_screenshot(${file})`;
  }
  return `_save_full_page(${file})`;
}

// The _save_full_page() runtime helper: the page at its full size, through CDP.
function _saveFullPageHelperPy() {
  return [
    'def _save_full_page(path):',
    '    """The whole page, not just the window (Chrome / Edge, through CDP)."""',
    '    size = driver.execute_cdp_cmd("Page.getLayoutMetrics", {})["cssContentSize"]',
    '    clip = {"x": 0, "y": 0, "width": size["width"], "height": size["height"], "scale": 1}',
    '    shot = driver.execute_cdp_cmd("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True, "clip": clip})',
    '    with open(path, "wb") as f:',
    '        f.write(base64.b64decode(shot["data"]))',
  ];
}

function _readValHelperPy() {
  return [
    '# Same reader as the extension (content.js readElementValue), run in the page.',
    ...pyPageJs('_READ_VAL_JS', READ_VAL_JS),
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
 * The _find_child() runtime helper: findElementByCondition of content.js, run in
 * the page as the bookmarklet runs it (popup/export/page-js.js). One
 * execute_script call; the Python walk it replaces made a WebDriver call per
 * element and check, and matched what Selenium shows (.text), not textContent:
 * a text the page hides was never found.
 */
function _findChildHelperPy() {
  return [
    '# Same search as the extension (content.js findElementByCondition), run in the page.',
    ...pyPageJs('_FIND_CHILD_JS', FIND_CHILD_JS),
    '',
    '',
    'def _find_child(parent, cond):',
    '    return driver.execute_script(_FIND_CHILD_JS, parent, cond)',
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
 * The dict reaches the page's _findChild as an object, matchMode included.
 */
function _buildChildCondPy(conditions, elVar, tout, locs, stepNum) {
  const cond  = conditions;
  const lines = [];

  const parts = cond.matchMode ? [`"matchMode": ${JSON.stringify(cond.matchMode)}`] : [];
  for (const f of CHILD_COND_KEYS) {
    if (cond[f] != null && String(cond[f]) !== '') {
      parts.push(`"${f}": ${valueToPy(String(cond[f]))}`);
    }
  }

  lines.push(`${elVar}_p = ${waitPy(locs, tout)}`);
  lines.push(`${elVar} = _find_child(${elVar}_p, {${parts.join(', ')}})`);
  lines.push(`if ${elVar} is None:`);
  lines.push(`    raise Exception("Child condition not matched (step ${stepNum})")`);
  return lines;
}

// Generates Python lines for a single non-condition action, and marks `step`
// (export/steps.js) when the action is not exported as is.
function actionLines(action, step, stepDelay, elTimeout, ctx) {
  const stepNum = step.n;
  const lbl    = action.label ? ` — ${commentText(action.label)}` : '';
  const delay  = msToSec(action.delay != null ? Number(action.delay) : stepDelay);
  const tout   = msToSec(elTimeout);
  const locs   = locatorsFor(action);
  const elVar  = `el${stepNum}`;
  const out    = [];

  switch (action.type) {
    case 'click':
      out.push(`# Step ${stepNum}: click${lbl}`);
      if (action.conditions) {
        out.push(..._buildChildCondPy(action.conditions, elVar, tout, locs, stepNum));
      } else {
        out.push(`${elVar} = ${waitPy(locs, tout, true)}`);
      }
      out.push(`${elVar}.click()`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'input': {
      const val = valueToPy(action.value);
      out.push(`# Step ${stepNum}: input${lbl}`);
      if (action.conditions) {
        out.push(..._buildChildCondPy(action.conditions, elVar, tout, locs, stepNum));
      } else {
        out.push(`${elVar} = ${waitPy(locs, tout)}`);
      }
      out.push(`if ${elVar}.tag_name == 'select':`);
      out.push(`    try:`);
      out.push(`        Select(${elVar}).select_by_value(${val})`);
      out.push(`    except Exception:`);
      out.push(`        Select(${elVar}).select_by_visible_text(${val})`);
      out.push(`elif ${elVar}.get_attribute("type") in _SCRIPT_INPUT_TYPES:`);
      out.push(`    driver.execute_script(_SET_INPUT_JS, ${elVar}, ${val})`);
      out.push(`else:`);
      out.push(`    ${elVar}.clear()`);
      out.push(`    ${elVar}.send_keys(${val})`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;
    }

    case 'hover':
      out.push(`# Step ${stepNum}: hover${lbl}`);
      if (action.conditions) {
        out.push(..._buildChildCondPy(action.conditions, elVar, tout, locs, stepNum));
      } else {
        out.push(`${elVar} = ${waitPy(locs, tout)}`);
      }
      out.push(`ActionChains(driver).move_to_element(${elVar}).perform()`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'dropdown':
      if (action.pick) {
        out.push(`# Step ${stepNum}: dropdown → item #${String(action.pick.index ?? '?').replace(/\s+/g, ' ')}${lbl}`);
        out.push(`${elVar} = ${waitPy(locs, tout, true)}`);
        out.push(`_pick_item(${elVar}, ${valueToPy(action.pick.index)}, ${valueToPy(action.pick.itemSelector || '')}, ${tout})`);
        if (delay > 0) out.push(`time.sleep(${delay})`);
        break;
      }
      out.push(`# Step ${stepNum}: open dropdown (freeze)${lbl}`);
      out.push(`${elVar} = ${waitPy(locs, tout, true)}`);
      out.push(`${elVar}.click()`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'dragdrop': {
      out.push(`# Step ${stepNum}: drag & drop${lbl}`);
      out.push(`${elVar}_src = ${waitPy(locs, tout)}`);
      out.push(`${elVar}_tgt = ${waitPy(locatorsFor(action, true), tout)}`);
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
      const ms = msToSec(waitMs(action));
      out.push(`# Step ${stepNum}: wait${lbl}`);
      out.push(`time.sleep(${ms})`);
      break;
    }

    case 'script': {
      const code = (action.code || action.value || '').trim();
      out.push(`# Step ${stepNum}: execute script${lbl}`);
      out.push(`# ⚠ Original JS — verify logic works via execute_script()`);
      mark(step, 'verify', 'custom JS run through driver.execute_script() — check it');
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
        out.push(..._buildChildCondPy(action.conditions, elVar, tout, locs, stepNum));
      } else {
        out.push(`${elVar} = ${waitPy(locs, tout)}`);
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
      out.push(fullPagePy(`f"screenshot_full_step${stepNum}.png"`, ctx.driverType, step));
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'screenshot_element':
      out.push(`# Step ${stepNum}: screenshot element${lbl}`);
      out.push(`${elVar} = ${waitPy(locs, tout)}`);
      out.push(`${elVar}.screenshot(f"screenshot_element_step${stepNum}.png")`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'screenshot_tovar': {
      const varName = safeVarName(action.varName || 'screenshot');
      out.push(`# Step ${stepNum}: screenshot → variable "${varName}"${lbl}`);
      out.push(`_ss_file${stepNum} = f"screenshot_${varName}_step${stepNum}.png"`);
      if (action.target === 'element' && locs[0].value) {
        out.push(`${elVar} = ${waitPy(locs, tout)}`);
        out.push(`${elVar}.screenshot(_ss_file${stepNum})`);
      } else if (action.target === 'full') {
        out.push(fullPagePy(`_ss_file${stepNum}`, ctx.driverType, step));
      } else {
        out.push(`driver.save_screenshot(_ss_file${stepNum})`);
      }
      out.push(`${varName} = _ss_file${stepNum}`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;
    }

    case 'switch':
      out.push(`# Step ${stepNum}: switch [SKIPPED] — requires extension scenario routing`);
      mark(step, 'skip', 'a Switch needs the extension to choose what plays');
      break;

    case 'uploadFile': {
      // The paths playback hands the file input (bg/playback/steps/upload.js): the
      // folder without its trailing separators, joined to each name with the
      // folder's own kind of separator. An older action holds one fileName.
      const folder = String(action.folderPath || '').replace(/[/\\]+$/, '');
      let names = [];
      if (Array.isArray(action.fileNames) && action.fileNames.length) names = action.fileNames;
      else if (action.fileName) names = [action.fileName];
      if (action.uploadMode === 'dropzone') {
        out.push(`# Step ${stepNum}: upload to a drop zone${lbl} — [SKIPPED] needs the extension`);
        mark(step, 'skip', 'an upload to a drop zone needs the extension');
        break;
      }
      out.push(`# Step ${stepNum}: upload file${names.length > 1 ? 's' : ''}${lbl}`);
      if (!folder || !names.length) {
        out.push(`raise Exception("Upload File (step ${stepNum}): missing folder or file name(s)")`);
        mark(step, 'verify', 'no folder or file name — the exported code stops there, as a run does');
        break;
      }
      const sep   = folder.includes('\\') ? '\\' : '/';
      const paths = names.map((n) => valueToPy(`${folder}${sep}${n}`));
      // Present is enough: pages hide their file inputs, and send_keys still fills one.
      out.push(`${elVar} = ${waitPy(locs, tout)}`);
      out.push(`${elVar}.send_keys(${paths.length === 1 ? paths[0] : `"\\n".join([${paths.join(', ')}])`})`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;
    }

    default:
      out.push(`# Step ${stepNum}: ${commentText(action.type)}${lbl} — [unsupported, skipped]`);
      mark(step, 'skip', 'not an action type this version knows');
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
      ctx.steps?.push(...blockSteps(ctx.all, abs, end));
      i = end - baseIdx + 1;
      continue;
    }

    if (action.disabled) {
      i++;
      continue;
    }

    const stepNum = baseIdx + i + 1;
    const step    = newStep(action, stepNum);
    ctx.steps?.push(step);

    if (action.type === 'condition') {
      const skipCount = conditionSkip(action); // 0 for an emptied Condition: empty body
      const lbl  = action.label ? ` — ${commentText(action.label)}` : '';

      out.push(`# Step ${stepNum}: condition — ${commentText(action.conditionType)}${lbl}`);
      const condPy = condExprPy(action, locatorsFor(action));
      if (condPy === null) {
        // As a run does: it stops there. The name stays in the comment above, never
        // in code; the block is kept for a check put in by hand.
        ctx.warnings?.add(`Condition step ${stepNum}: type "${action.conditionType}" is unknown — the exported code stops there, as a run does`);
        mark(step, 'verify', 'unknown condition type — the exported code stops there, as a run does');
        out.push(`raise Exception(${JSON.stringify(`Condition step ${stepNum}: unknown condition type, named in the comment above`)})`);
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
      out.push(...actionLines(action, step, stepDelay, elTimeout, ctx));
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
 * @param {string}   opts.driverType   - Chrome (default), Edge, Firefox or Safari; anything else is Chrome.
 * @param {boolean}  opts.headless     - run the browser without a window (not Safari, which has no such mode).
 * @param {string}   opts.output       - 'script' (default), or 'pytest': a test with a fixture for the browser.
 * @param {string}   opts.startUrl     - Initial `driver.get()` URL when first action is not navigate.
 * @returns {{ code: string, stats: { total, supported, skipped }, steps: object[], warnings: string[] }}
 *   steps: what became of each enabled action (popup/export/steps.js).
 */
export function generateSeleniumPy(scenarioName, actions, variables, opts = {}) {
  const { stepDelay = 500, elTimeout = 10000, startUrl = '', headless = false } = opts;
  const pytest = opts.output === 'pytest';
  // Written into `webdriver.<driverType>()`: only a class the script can call, never code.
  const driverType = DRIVER_TYPES.has(opts.driverType) ? opts.driverType : 'Chrome';

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
  const steps  = [];

  const needsRandom       = Object.keys(randomSpecs).length > 0 || Object.keys(pickSpecs).length > 0;
  const needsDatetime     = Object.values(randomSpecs).some(s => s.type === 'datetime');
  const needsActionChains = enabled.some(a => ['hover', 'dragdrop'].includes(a.type));
  const needsCondition    = enabled.some(a => a.type === 'condition');
  const needsChildCond    = enabled.some(a => a.conditions && typeof a.conditions === 'object');
  const needsExtract      = enabled.some(a => a.type === 'readdom' && patternVarNames(a.pattern).length);
  const needsJsEscape     = enabled.some(a => a.type === 'script' && scriptUsesVars(a));
  const needsDropdownPick = enabled.some(a => a.type === 'dropdown' && a.pick);

  // The steps first: whether a step looks an element up by several locators (or
  // by text) decides which helpers and imports the script needs.
  const bodyLines   = processActions(all, 0, stepDelay, elTimeout, { all, layout, warnings, steps, driverType });
  const needsLocate = needsCondition || bodyLines.some(l => l.includes('_find(['));
  const needsFullPage = bodyLines.some(l => l.includes('_save_full_page('));

  const out = [];

  // ── Imports ──
  if (needsFullPage) out.push('import base64');
  if (!pytest) out.push('import sys');
  out.push('import time');
  if (needsRandom)   { out.push('import random'); out.push('import string'); }
  else if (needsDropdownPick) out.push('import random');
  if (needsExtract || needsDropdownPick) out.push('import re');
  if (needsDatetime)  out.push('from datetime import datetime');
  if (pytest) out.push('import pytest');
  out.push('from selenium import webdriver');
  out.push('from selenium.webdriver.common.by import By');
  out.push('from selenium.webdriver.support.ui import WebDriverWait, Select');
  out.push('from selenium.webdriver.support import expected_conditions as EC');
  if (needsActionChains) out.push('from selenium.webdriver.common.action_chains import ActionChains');
  if (needsLocate)       out.push('from selenium.common.exceptions import InvalidSelectorException, StaleElementReferenceException');
  out.push('');
  out.push('');

  // A redirected stdout (a pipe, `> log`, CI) on Windows is cp1252: the ✅ / ❌
  // printed at the end — and most scenario names — raised UnicodeEncodeError, so
  // a run that passed exited 1 and its except branch crashed too.
  if (!pytest) {
    out.push('# Print in UTF-8 whatever stdout is (a redirected one on Windows is cp1252).');
    out.push('if hasattr(sys.stdout, "reconfigure"):');
    out.push('    sys.stdout.reconfigure(encoding="utf-8")');
    out.push('');
    out.push('');
  }

  // ── Runtime helpers ──
  if (needsFullPage) {
    out.push(..._saveFullPageHelperPy());
    out.push('');
    out.push('');
  }
  if (needsLocate) {
    out.push(..._locateHelperPy());
    out.push('');
    out.push('');
  }
  if (needsCondition) {
    out.push(..._checkCondHelperPy());
    out.push('');
    out.push('');
  }
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
  if (enabled.some(a => a.type === 'input')) {
    out.push(..._setInputHelperPy());
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

  // If no navigate action exists as the first real step, emit a driver.get() line.
  // Use the user-supplied startUrl if provided, otherwise a TODO placeholder.
  const startLines = [];
  const firstAction = enabled.find(a => a.type !== 'wait');
  if (!firstAction || firstAction.type !== 'navigate') {
    if (startUrl) {
      startLines.push(`driver.get(${JSON.stringify(startUrl)})`);
    } else {
      startLines.push('# ⚠ TODO: Set the starting URL (go to Settings tab to configure)');
      startLines.push('driver.get("https://your-url-here.com")');
    }
    startLines.push('');
  }

  // ── Variables ──
  const hasVars = Object.keys(staticVars).length > 0 || needsRandom || writtenVars.size > 0;
  const varLines = [];
  if (hasVars) {
    varLines.push('# --- VARIABLES ---');
    const declared = new Set();

    for (const [k, v] of Object.entries(staticVars)) {
      const safe = safeVarName(k);
      if (declared.has(safe)) continue;
      declared.add(safe);
      varLines.push(`${safe} = ${JSON.stringify(v)}`);
    }
    for (const [k, spec] of Object.entries(randomSpecs)) {
      const safe = safeVarName(k);
      if (declared.has(safe)) continue;
      declared.add(safe);
      // "datetime" is a type the Variables modal offers and resolveRandomVars()
      // in bg/interpolate.js implements; it used to fall through to the alphanumeric
      // charset here and produce random junk instead of the run's timestamp.
      if (spec.type === 'datetime') {
        varLines.push(`${safe} = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")`);
        continue;
      }
      let charset;
      if (spec.type === 'alpha') charset = 'string.ascii_letters';
      else if (spec.type === 'numeric') charset = 'string.digits';
      else charset = 'string.ascii_letters + string.digits';
      varLines.push(`${safe} = ''.join(random.choices(${charset}, k=${spec.length}))`);
    }
    for (const [k, vals] of Object.entries(pickSpecs)) {
      const safe = safeVarName(k);
      if (declared.has(safe)) continue;
      declared.add(safe);
      const pyList = '[' + vals.map(v => JSON.stringify(v)).join(', ') + ']';
      varLines.push(`${safe} = random.choice(${pyList})`);
    }
    // Only the written names nothing above already seeded. This loop used to run
    // unconditionally, so `seed = "INIT"` from the Variables tab was immediately
    // followed by `seed = ''` and the seed never reached the first step.
    for (const k of writtenVars) {
      if (declared.has(k)) continue;
      declared.add(k);
      varLines.push(`${k} = ''`);
    }
    varLines.push('');
  }

  if (pytest) {
    out.push(...pytestLines(driverPy(driverType, headless, warnings), testFunctionName(scenarioName),
      [...startLines, ...varLines, ...bodyLines]));
  } else {
    out.push(...driverPy(driverType, headless, warnings));
    // implicitly_wait is intentionally omitted — it conflicts with WebDriverWait/EC.
    out.push('');
    out.push(...startLines, ...varLines);

    // ── Main flow ──
    out.push('# --- MAIN FLOW ---');
    out.push('try:');
    out.push('');

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
  }

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

  const skipped = steps.filter((s) => s.status === 'skip').length;
  return {
    code: out.join('\n'),
    stats: { total: enabled.length, supported: steps.length - skipped, skipped },
    steps,
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
    format: 'py',
    badge: 'PY',
    title: 'Export Python',
    downloadLabel: '⬇ .py',
    // The driver before Headless, which Safari turns off. The start URL follows the tab instead.
    remember: ['exportSeleniumDriver', 'exportSeleniumHeadless', 'exportSeleniumOutput', 'exportSeleniumStepDelay', 'exportSeleniumElTimeout'],
    fileName: (base, o) => (o?.output === 'pytest' ? `test_${base}.py` : `${base}_selenium.py`),
    readOptions: _getOpts,
    generate: generateSeleniumPy,
    copyText: (code) => code,
    file: (code) => ({ text: code, type: 'text/x-python' }),
    beforeOpen: _autoFillStartUrl,
    wire: () => {
      document.getElementById('exportSeleniumGetUrl')?.addEventListener('click', _fillCurrentUrl);
      document.getElementById('exportSeleniumDriver')?.addEventListener('change', _syncHeadless);
    },
  });
}

function _getOpts() {
  return {
    stepDelay:  parseInt(document.getElementById('exportSeleniumStepDelay')?.value) || 500,
    elTimeout:  parseInt(document.getElementById('exportSeleniumElTimeout')?.value)  || 10000,
    driverType: document.getElementById('exportSeleniumDriver')?.value || 'Chrome',
    startUrl:   document.getElementById('exportSeleniumStartUrl')?.value.trim() || '',
    headless:   !!document.getElementById('exportSeleniumHeadless')?.checked,
    output:     document.getElementById('exportSeleniumOutput')?.value === 'pytest' ? 'pytest' : 'script',
  };
}

// Safari has no headless mode: with it chosen, Headless is off and cannot be turned on.
function _syncHeadless() {
  const safari = document.getElementById('exportSeleniumDriver')?.value === 'Safari';
  const box = document.getElementById('exportSeleniumHeadless');
  if (!box) return;
  if (safari) box.checked = false;
  box.disabled = safari;
  document.getElementById('exportSeleniumHeadlessRow').title = safari ? 'Safari has no headless mode' : '';
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
