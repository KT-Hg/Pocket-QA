/**
 * export-robot.js — the Robot Framework export: a scenario as a <name>.robot test
 * that `robot` runs with SeleniumLibrary. The steps read as keywords a QA can
 * follow and change; the variables are Robot's own ${name}.
 *
 * It does what playback does, as the Selenium export does: each step's locators
 * in playback's order (shared/locator-order.js), tried in turn by Find Element,
 * and the extension's own in-page code (popup/export/page-js.js) where a keyword
 * would act otherwise. That code is kept in base64, decoded when the suite starts:
 * Robot reads the spaces, \ , # and ${ of plain text as its own syntax.
 */

import { commentText } from './utils.js';
import { DRIVER_TYPES, initExportModal } from './export-modal.js';
import { getSwitchLayout } from '../shared/switch-blocks.js';
import { normalizeVarRef, writtenVarNames } from '../shared/var-name.js';
import { patternRegexSource } from '../shared/text-pattern.js';
import { CHILD_COND_KEYS } from '../shared/child-cond.js';
import { cssEscape } from '../shared/css-escape.js';
import { waitMs, stepDelayMs } from '../shared/wait-ms.js';
import { mark } from './export/steps.js';
import {
  ASSERT_POLL_MS, ASSERT_WAIT_MS, assertExpected, assertType, exportVariables, inFrame, locatorsFor, pickLabel, readTargets,
  undefinedVarNames, uploadPaths, walkActions, warnUndefinedVars,
} from './export/walk.js';
import { CONDITION_TYPES, PAGE_CALLS } from './export/page-js.js';
import { csvRowsPy } from './export-selenium.js';

// Robot reads a variable's name ignoring case, spaces and underscores: two names are one when these match.
const robotKey = (name) => String(name).toLowerCase().replace(/[\s_]/g, '');

// Robot's own variables (${EMPTY}, ${TRUE}, ${TEST NAME}…), by robotKey.
const ROBOT_VARS = new Set(['empty', 'space', 'true', 'false', 'none', 'null', 'tempdir', 'execdir', 'curdir', 'outputdir',
  'outputfile', 'logfile', 'reportfile', 'debugfile', 'testname', 'testdocumentation', 'testtags', 'teststatus', 'testmessage',
  'suitename', 'suitesource', 'suitedocumentation', 'suitemetadata', 'suitestatus', 'suitemessage', 'keywordstatus',
  'keywordmessage', 'prevtestname', 'prevteststatus', 'prevtestmessage', 'loglevel', 'options']);

/**
 * (name) → the Robot variable for a Pocket QA variable: letters, digits and _, a
 * leading digit made `_`. A name Robot or the test uses itself — Robot's own, the
 * test's PQA_… and the steps' el3 / sw4 / ok5 — gets `_v`; one Robot would read
 * as a number, a leading `v_`.
 */
export function robotIdent(name) {
  const safe = String(name == null ? 'var' : name).replace(/^\$\{|\}$/g, '').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^\d/, '_') || 'var';
  const key = robotKey(safe);
  if (key === '' || /^\d/.test(key)) return `v_${safe}`;
  return ROBOT_VARS.has(key) || key.startsWith('pqa') || /^(el|sw|ok)\d/.test(key) ? `${safe}_v` : safe;
}

/**
 * Text as one Robot argument, exactly: \ doubled; $ @ & % before { escaped (they
 * open a variable); a # or * that starts it (a comment, a settings/section marker
 * or a templated name) and the = after a leading name (a named argument) escaped;
 * a line break, CR and tab as \n \r \t, any other
 * control or space character as \uXXXX (Robot splits on two of them); a space
 * that starts or ends it, or follows another, as ${SPACE}. Empty: ${EMPTY}.
 */
export function robotText(s) {
  const text = String(s ?? '');
  if (text === '') return '${EMPTY}';
  const SHORT = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  return text.replace(/\\/g, '\\\\').replace(/([$@&%])\{/g, '\\$1{')
    .replace(/[\x00-\x1f\x7f-\x9f]|(?! )\s/g, (c) => SHORT[c] || `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/^([#*])/, '\\$1').replace(/^(\w+)=/, '$1\\=')
    .replace(/ (?= )/g, '${SPACE}').replace(/^ /, '${SPACE}').replace(/ $/, '${SPACE}');
}

/** A Pocket QA value as one Robot argument: each ${name} its Robot variable, the rest text. */
function valueRobot(val) {
  const parts = String(val ?? '').split(/(\$\{[^}]+\})/g).filter((p) => p !== '');
  if (!parts.length) return '${EMPTY}';
  return parts.map((p) => {
    const m = p.match(/^\$\{([^}]+)\}$/);
    return m ? `\${${robotIdent(m[1].trim())}}` : robotText(p);
  }).join('');
}

// Text as a Python string literal in an expression (IF, Evaluate): a JSON string is one.
const pyText = (s) => robotText(JSON.stringify(String(s ?? '')));

// One locator as Find Element takes it: SeleniumLibrary's strategy:value, or text:<tag>:<text>.
function locRobot({ type, value, tag }) {
  switch (type) {
    case 'id':        return valueRobot(`id:${value}`);
    case 'name':      return valueRobot(`name:${value}`);
    case 'xpath':
    case 'fullXpath': return valueRobot(`xpath:${value}`);
    case 'testId':    return valueRobot(`css:[data-testid="${cssEscape(value)}"]`);
    case 'dataId':    return valueRobot(`css:[data-id="${cssEscape(value)}"]`);
    case 'text':      return valueRobot(`text:${tag || ''}:${value}`);
    default:          return valueRobot(`css:${value}`);
  }
}

const locsRobot = (locs) => locs.map(locRobot).join('    ');


// UTF-8 text as base64, in the popup and in Node alike.
const base64 = (s) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(''));

const secs = (ms) => parseFloat((Number(ms) / 1000).toFixed(3));

// The keywords every test has: its end, the page code, the browser, the site, finding an element as the extension does.
const BASE_KEYWORDS = `End Test
    [Documentation]    A failed test: a screenshot of the page as the step left it (<this file's name>_failure.png), and its message led by the step.
    IF    $TEST_STATUS == 'FAIL'
        \${file}=    Evaluate    pathlib.Path($SUITE_SOURCE).stem + '_failure.png'
        Run Keyword And Ignore Error    Capture Page Screenshot    \${file}
        IF    $PQA_AT    Set Test Message    \${PQA_AT}: \${TEST MESSAGE}
    END
    Close All Browsers

Decode Page Helpers
    [Documentation]    The extension's in-page code (popup/export/page-js.js), kept in base64: as plain text Robot would read its spaces, \\ and # as syntax.
    FOR    \${name}    \${b64}    IN    &{PQA_B64}
        \${code}=    Evaluate    base64.b64decode($b64).decode('utf-8')
        Set Suite Variable    \\\${PQA_\${name}}    \${code}
    END

Start Browser
    [Documentation]    PQA_BROWSER (Chrome, Edge, Firefox or Safari), else the exported one; PQA_HEADLESS=1: no window, at a desktop size.
    \${name}=    Set Variable    %{PQA_BROWSER=\${PQA_BROWSER}}
    \${headless}=    Set Variable    %{PQA_HEADLESS=\${PQA_HEADLESS}}
    IF    $name not in ('Chrome', 'Edge', 'Firefox', 'Safari')    Fail    PQA_BROWSER\\=\${name}: not Chrome, Edge, Firefox or Safari
    IF    $name == 'Safari'
        Open Browser    browser=safari
    ELSE IF    $headless == '1' and $name == 'Firefox'
        Open Browser    browser=firefox    options=add_argument("-headless");add_argument("--width=1920");add_argument("--height=1080")
    ELSE IF    $headless == '1'
        Open Browser    browser=\${name}    options=add_argument("--headless=new");add_argument("--window-size=1920,1080")
    ELSE
        Open Browser    browser=\${name}
    END
    # Longer than a step waits for its items: Choose Item reports what it found first.
    Set Selenium Timeout    \${{ $PQA_TIMEOUT + 5 }}

Site URL
    [Documentation]    The URL — or, with PQA_BASE_URL set and the URL on the site of the first page opened, the same page there.
    [Arguments]    \${url}
    \${parts}=    Evaluate    urllib.parse.urlsplit($url)
    \${origin}=    Evaluate    ($parts.scheme, $parts.netloc)
    IF    $PQA_FIRST_ORIGIN is None    Set Suite Variable    \\\${PQA_FIRST_ORIGIN}    \${origin}
    \${base}=    Set Variable    %{PQA_BASE_URL=}
    IF    not $base or $origin != $PQA_FIRST_ORIGIN    RETURN    \${url}
    \${moved}=    Evaluate    $base.rstrip('/') + urllib.parse.urlunsplit(('', '', $parts.path, $parts.query, $parts.fragment))
    RETURN    \${moved}

Locate
    [Documentation]    The first element the locators find now, in their order, or None: css:, xpath:, id:, name: as Selenium finds them (a CSS one in open shadow roots too), text:<tag>:<text> as the extension's Text search.
    [Arguments]    @{locators}
    FOR    \${loc}    IN    @{locators}
        IF    $loc.startswith('text:')
            \${tag}    \${text}=    Evaluate    $loc[5:].split(':', 1)
            \${el}=    Execute Javascript    \${PQA_FIND_TEXT_JS}    ARGUMENTS    \${text}    \${tag}
        ELSE
            \${status}    \${found}=    Run Keyword And Ignore Error    Get WebElements    \${loc}
            \${el}=    Evaluate    $found[0] if $status == 'PASS' and $found else None
            IF    $el is None and $loc.startswith('css:')
                \${el}=    Execute Javascript    \${PQA_QUERY_DEEP_JS}    ARGUMENTS    \${{ $loc[4:] }}
            END
        END
        IF    $el is not None    RETURN    \${el}
    END
    RETURN    \${None}`;

// Find Element, which looks in the frames too in a scenario with a step recorded in one.
const findElementKeyword = (frames) => `Find Element
    [Documentation]    A step's element, waited for up to the export's timeout, displayed and enabled too with clickable${frames ? ': in the page, then in its frames' : ''}.
    [Arguments]    @{locators}    \${clickable}=\${False}
    \${end}=    Evaluate    time.time() + $PQA_TIMEOUT
    WHILE    True
        \${el}=    ${frames ? 'Locate In Frames' : 'Locate'}    @{locators}
        IF    $el is not None and (not $clickable or ($el.is_displayed() and $el.is_enabled()))    RETURN    \${el}
        IF    time.time() > $end    Fail    no element found by \${locators}
        Sleep    0.1
    END`;

// With a step recorded in a frame: looking in the page, then in its frames.
const FRAMES_KEYWORDS = `Locate In Frames
    [Documentation]    The element in the page or in one of its frames, frames in frames too; the browser is left in the frame that holds it.
    [Arguments]    @{locators}
    Unselect Frame
    \${el}=    Locate In This Frame    @{locators}
    RETURN    \${el}

Locate In This Frame
    [Arguments]    @{locators}
    \${el}=    Locate    @{locators}
    IF    $el is not None    RETURN    \${el}
    \${frames}=    Get WebElements    css:iframe, frame
    FOR    \${frame}    IN    @{frames}
        \${status}    \${msg}=    Run Keyword And Ignore Error    Select Frame    \${frame}
        IF    $status != 'PASS'    CONTINUE
        \${el}=    Locate In This Frame    @{locators}
        IF    $el is not None    RETURN    \${el}
        \${lib}=    Get Library Instance    SeleniumLibrary
        Evaluate    $lib.driver.switch_to.parent_frame()
    END
    RETURN    \${None}`;

// The keywords of the steps that use them, written out only then.
const STEP_KEYWORDS = {
  input: `Set Input
    [Documentation]    An Input as the extension makes it: a <select> chooses the option of that value, else of that text; a date, time, color or range field gets the value as the extension sets it; any other field is typed into.
    [Arguments]    \${el}    \${value}
    \${kind}=    Evaluate    'select' if $el.tag_name == 'select' else $el.get_attribute('type')
    IF    $kind == 'select'
        \${status}    \${msg}=    Run Keyword And Ignore Error    Select From List By Value    \${el}    \${value}
        IF    $status != 'PASS'    Select From List By Label    \${el}    \${value}
    ELSE IF    $kind in ('date', 'time', 'datetime-local', 'month', 'week', 'color', 'range')
        Execute Javascript    \${PQA_SET_INPUT_JS}    ARGUMENTS    \${el}    \${value}
    ELSE
        Input Text    \${el}    \${value}
    END`,
  condition: `Check Condition
    [Documentation]    A Condition as the extension checks it (content.js CHECK_CONDITION), on the element found now, without waiting.
    [Arguments]    \${type}    \${expected}    @{locators}
    \${el}=    Set Variable    \${None}
    IF    $locators
        \${el}=    Locate    @{locators}
    END
    \${ok}=    Execute Javascript    \${PQA_CHECK_COND_JS}    ARGUMENTS    \${type}    \${el}    \${expected}
    RETURN    \${ok}`,
  assert: `Assert Holds
    [Documentation]    An Assert's check (Check Condition), failing with the step and what it expected when it does not hold. A step runs it as the extension does (bg/playback/steps/assert.js): again until it holds, for up to ${ASSERT_WAIT_MS / 1000} s; one still false lets the test go on, and fails it at its end.
    [Arguments]    \${type}    \${expected}    \${want}    @{locators}
    \${ok}=    Check Condition    \${type}    \${expected}    @{locators}
    IF    not $ok    Fail    \${PQA_AT}: \${want}`,
  child: `Find Child
    [Documentation]    The child a Child Condition picks in its parent (content.js findElementByCondition); none: the step fails.
    [Arguments]    \${parent}    \${cond}    \${step}
    \${el}=    Execute Javascript    \${PQA_FIND_CHILD_JS}    ARGUMENTS    \${parent}    \${cond}
    IF    $el is None    Fail    Child condition not matched (step \${step})
    RETURN    \${el}`,
  read: `Read Value
    [Documentation]    What Read DOM reads (content.js readElementValue).
    [Arguments]    \${el}    \${from}    \${attr}=\${EMPTY}
    \${value}=    Execute Javascript    \${PQA_READ_VAL_JS}    ARGUMENTS    \${el}    \${from}    \${attr}
    RETURN    \${{ $value or '' }}`,
  pick: `Choose Item
    [Documentation]    A Dropdown's "Choose item #", as the extension chooses it, in the page.
    [Arguments]    \${el}    \${raw}    \${items}
    \${error}=    Execute Async Javascript    \${PQA_PICK_ITEM_JS}    ARGUMENTS    \${el}    \${raw}    \${items}    \${{ int($PQA_TIMEOUT * 1000) }}
    IF    $error is not None    Fail    \${error}`,
  drop: `Drop Files
    [Documentation]    An upload to a drop zone as the extension makes it (bg/cdp/upload.js): the files set on a hidden file input, then dropped on the zone.
    [Arguments]    \${zone}    \${files}
    \${bridge}=    Execute Javascript    \${PQA_DROP_BRIDGE_JS}
    Choose File    \${bridge}    \${files}
    Execute Javascript    \${PQA_DROP_FILES_JS}    ARGUMENTS    \${zone}    \${bridge}`,
  full: `Save Full Page
    [Documentation]    The whole page, not just the window, as the browser can: Firefox its own way, Chrome and Edge through CDP, Safari only the window. In the output folder, as Capture Page Screenshot saves.
    [Arguments]    \${file}
    \${path}=    Evaluate    os.path.join($OUTPUT_DIR, $file)
    \${lib}=    Get Library Instance    SeleniumLibrary
    \${driver}=    Set Variable    \${lib.driver}
    IF    hasattr($driver, 'save_full_page_screenshot')
        Evaluate    $driver.save_full_page_screenshot($path)
    ELSE IF    hasattr($driver, 'execute_cdp_cmd')
        \${size}=    Evaluate    $driver.execute_cdp_cmd('Page.getLayoutMetrics', {})['cssContentSize']
        \${shot}=    Evaluate    $driver.execute_cdp_cmd('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': True, 'clip': {'x': 0, 'y': 0, 'width': $size['width'], 'height': $size['height'], 'scale': 1}})
        Evaluate    pathlib.Path($path).write_bytes(base64.b64decode($shot['data']))
    ELSE
        Evaluate    $driver.save_screenshot($path)
    END`,
  // The escaping of _applyVarsToCode (bg/interpolate.js), chr(92) for each \ : Robot reads a \ itself.
  js: `Js Text
    [Documentation]    A value put into a Script step's code, escaped as the extension escapes it.
    [Arguments]    \${v}
    \${out}=    Evaluate    str($v).replace(chr(92), chr(92) * 2).replace('"', chr(92) + '"').replace("'", chr(92) + "'").replace('\`', chr(92) + '\`').replace('$' + '{', chr(92) + '$' + '{').replace(chr(10), chr(92) + 'n').replace(chr(13), chr(92) + 'r')
    RETURN    \${out}`,
};

/**
 * A Script step: each ${name} of its code first escaped for JS as the extension
 * escapes it (Js Text), then put in; the code a line per argument, which
 * Execute Javascript joins.
 */
function scriptLines(code, n) {
  const names = [...new Set([...code.matchAll(/\$\{([^}]+)\}/g)].map((m) => robotIdent(m[1].trim())))];
  const out = names.map((v) => `\${PQA_JS${n}_${v}}=    Js Text    \${${v}}`);
  const cell = (line) => line.split(/(\$\{[^}]+\})/g).filter((p) => p !== '').map((p) => {
    const m = p.match(/^\$\{([^}]+)\}$/);
    return m ? `\${PQA_JS${n}_${robotIdent(m[1].trim())}}` : robotText(p);
  }).join('') || '${EMPTY}';
  const lines = code.split('\n');
  if (lines.length === 1) return [...out, `Execute Javascript    ${cell(code)}`];
  return [...out, 'Execute Javascript', ...lines.map((l, k) => `...    ${cell(k < lines.length - 1 ? `${l}\n` : l)}`)];
}

// The lines finding a step's element into ${elN}: through Find Child with a Child Condition.
function findLines(action, el, ctx, clickable = false) {
  const locs = locsRobot(locatorsFor(action));
  if (!action.conditions || !['click', 'input', 'hover', 'readdom'].includes(action.type)) {
    return [`\${${el}}=    Find Element    ${locs}${clickable ? '    clickable=${True}' : ''}`];
  }
  ctx.uses.add('child');
  const cond = action.conditions;
  const items = [...(cond.matchMode ? [`matchMode=${robotText(cond.matchMode)}`] : []),
    ...CHILD_COND_KEYS.filter((f) => cond[f] != null && String(cond[f]) !== '').map((f) => `${f}=${valueRobot(String(cond[f]))}`)];
  return [`\${${el}_p}=    Find Element    ${locs}`,
    `\${${el}_c}=    Create Dictionary    ${items.join('    ')}`,
    `\${${el}}=    Find Child    \${${el}_p}    \${${el}_c}    ${ctx.n}`];
}

// The upload paths (export/walk.js uploadPaths) as one Robot argument, a line each; null without a folder or a name.
function uploadFiles(a) {
  const paths = uploadPaths(a);
  return paths ? valueRobot(paths.join('\n')) : null;
}

// Read DOM: each ${name} of the pattern takes its part of the text, "Save to var" the whole.
function readdomLines(a, s) {
  s.ctx.uses.add('read');
  const { whole, slots } = readTargets(a, robotIdent);
  const read = `Read Value    \${${s.el}}    ${robotText(a.readFrom || 'text')}    ${valueRobot(a.attrName || '')}`;
  const out = s.find();
  if (!slots.length) return [...out, `\${${whole}}=    ${read}`];
  out.push(`\${${s.el}_t}=    ${read}`);
  if (whole) out.push(`\${${whole}}=    Set Variable    \${${s.el}_t}`);
  out.push(`\${${s.el}_m}=    Evaluate    re.search(${pyText(patternRegexSource(a.pattern))}, $${s.el}_t${a.matchCase ? '' : ', re.I'})`);
  out.push(`IF    $${s.el}_m is None    Fail    ${robotText(`Read DOM (step ${s.n}): text does not match ${String(a.pattern).trim()}: `)}\${${s.el}_t}`);
  slots.forEach((name, k) => out.push(`\${${robotIdent(name)}}=    Evaluate    $${s.el}_m.group(${k + 1}).strip()`));
  return out;
}

/**
 * Per action type: (action, s) → its lines after the step's comment, null when it
 * is not exported; s = { n, el, step, ctx, find(clickable) }, find giving the
 * lines that find the step's element.
 */
const STEP_LINES = {
  click: (a, s) => [...s.find(true), `Click Element    \${${s.el}}`],
  hover: (a, s) => [...s.find(), `Mouse Over    \${${s.el}}`],
  input: (a, s) => {
    s.ctx.uses.add('input');
    return [...s.find(), `Set Input    \${${s.el}}    ${valueRobot(a.value)}`];
  },
  dropdown: (a, s) => {
    if (!a.pick) return [...s.find(true), `Click Element    \${${s.el}}`];
    s.ctx.uses.add('pick');
    return [...s.find(true), `Choose Item    \${${s.el}}    ${valueRobot(a.pick.index)}    ${valueRobot(a.pick.itemSelector || '')}`];
  },
  dragdrop: (a, s) => [`\${${s.el}_s}=    Find Element    ${locsRobot(locatorsFor(a))}`,
    `\${${s.el}_t}=    Find Element    ${locsRobot(locatorsFor(a, true))}`,
    `Drag And Drop    \${${s.el}_s}    \${${s.el}_t}`],
  navigate: (a) => [`\${PQA_URL}=    Site URL    ${valueRobot(a.value || a.url)}`, 'Go To    ${PQA_URL}'],
  wait: (a) => [`Sleep    ${secs(waitMs(a))}`],
  script: (a, s) => {
    const code = String(a.code || a.value || '').trim();
    if (/\$\{[^}]+\}/.test(code)) s.ctx.uses.add('js');
    mark(s.step, 'verify', 'custom JS run through Execute Javascript — check it');
    return [...(s.ctx.frames === 'all' ? ['Unselect Frame'] : []), ...scriptLines(code, s.n)];
  },
  readdom: readdomLines,
  screenshot: (a, s) => [`Capture Page Screenshot    screenshot_step${s.n}.png`],
  screenshot_full: (a, s) => {
    s.ctx.uses.add('full');
    if (s.ctx.driverType === 'Safari') mark(s.step, 'verify', 'Safari saves only the visible part of the page');
    return [`Save Full Page    screenshot_full_step${s.n}.png`];
  },
  screenshot_element: (a, s) => [...s.find(), `Capture Element Screenshot    \${${s.el}}    screenshot_element_step${s.n}.png`],
  screenshot_tovar: (a, s) => {
    const name = robotIdent(a.varName || 'screenshot');
    const out = [`\${${name}}=    Set Variable    screenshot_${name}_step${s.n}.png`];
    if (a.target === 'element' && locatorsFor(a)[0].value) out.push(...s.find(), `Capture Element Screenshot    \${${s.el}}    \${${name}}`);
    else if (a.target === 'full') {
      s.ctx.uses.add('full');
      out.push(`Save Full Page    \${${name}}`);
    } else out.push(`Capture Page Screenshot    \${${name}}`);
    return out;
  },
  switch: (a, s) => {
    mark(s.step, 'skip', 'a Switch needs the extension to choose what plays');
    return null;
  },
  assert: (a, s) => {
    const type = assertType(a, s.step, s.ctx.warnings);
    if (!type) return [`Fail    Assert step ${s.n}: unknown condition type, named in the comment above`];
    s.ctx.uses.add('condition').add('assert');
    const locs = type.startsWith('url') ? '' : `    ${locsRobot(locatorsFor(a))}`;
    return [...(s.ctx.frames === 'all' ? ['Unselect Frame'] : []),
      `Run Keyword And Continue On Failure    Wait Until Keyword Succeeds    ${ASSERT_WAIT_MS / 1000}s    ${ASSERT_POLL_MS}ms    Assert Holds    ${type}    ${valueRobot(a.expectedValue)}    ${valueRobot(assertExpected(type, a))}${locs}`];
  },
  uploadFile: (a, s) => {
    const files = uploadFiles(a);
    if (!files) {
      mark(s.step, 'verify', 'no folder or file name — the exported code stops there, as a run does');
      return [`Fail    Upload File (step ${s.n}): missing folder or file name(s)`];
    }
    // Present is enough: pages hide their file inputs, and Choose File still fills one.
    if (a.uploadMode !== 'dropzone') return [...s.find(), `Choose File    \${${s.el}}    ${files}`];
    s.ctx.uses.add('drop');
    return [...s.find(), `Drop Files    \${${s.el}}    ${files}`];
  },
};

// What a step's comment calls it — as the Selenium export does, so a failure reads the same in both.
// Raw text: actionLines passes the whole return through commentText once, at the comment line.
function stepWhat(a) {
  switch (a.type) {
    case 'dropdown': return a.pick ? `dropdown → item #${pickLabel(a)}` : 'open dropdown (freeze)';
    case 'dragdrop': return 'drag & drop';
    case 'script': return 'execute script';
    case 'assert': return `assert — ${a.conditionType || 'elementExists'}`;
    case 'screenshot': return 'screenshot (visible)';
    case 'screenshot_full': return 'screenshot (full page)';
    case 'screenshot_element': return 'screenshot element';
    case 'screenshot_tovar': return `screenshot → variable "${robotIdent(a.varName || 'screenshot')}"`;
    case 'uploadFile': {
      const many = Array.isArray(a.fileNames) && a.fileNames.length > 1;
      return `upload file${many ? 's' : ''}${a.uploadMode === 'dropzone' ? ' to a drop zone' : ''}`;
    }
    case 'readdom': {
      const { whole, slots } = readTargets(a, robotIdent);
      return `read DOM → ${[whole, ...slots.map(robotIdent)].filter(Boolean).map((t) => `"${t}"`).join(', ')}`;
    }
    default: return a.type;
  }
}

// Lines for one step that is not a Condition; marks `step` when it is not exported as is.
function actionLines(action, step, ctx) {
  const n = step.n;
  const el = `el${n}`;
  const lbl = action.label ? ` — ${commentText(action.label)}` : '';
  if (!Object.hasOwn(STEP_LINES, action.type)) {
    mark(step, 'skip', 'not an action type this version knows');
    return [`# Step ${n}: ${commentText(action.type)}${lbl} — [unsupported, skipped]`];
  }
  const s = { n, el, step, ctx, find: (clickable) => findLines(action, el, { ...ctx, n }, clickable) };
  const lines = STEP_LINES[action.type](action, s);
  if (!lines) return [`# Step ${n}: switch [SKIPPED] — requires extension scenario routing`];
  // The pause after a step, as in a run: none after a wait, or where the step stops the test.
  const delay = secs(stepDelayMs(action.delay != null ? action.delay : ctx.stepDelay));
  if (delay > 0 && action.type !== 'wait' && !lines[0].startsWith('Fail')) lines.push(`Sleep    ${delay}`);
  return [`# Step ${n}: ${commentText(stepWhat(action))}${lbl}`, ...lines];
}

/**
 * The lines opening a Condition's block: IF on the in-page check of the element
 * found now (none for the URL types). A type this version does not know stops
 * the test there, as a run does; its name stays in the comment, never in code.
 */
function conditionHead(action, step, ctx) {
  const type = action.conditionType;
  const out = [`# Step ${step.n}: condition — ${commentText(type)}${action.label ? ` — ${commentText(action.label)}` : ''}`];
  if (!CONDITION_TYPES.has(type)) {
    mark(step, 'verify', 'unknown condition type — the exported code stops there, as a run does');
    ctx.warnings.add(`Condition step ${step.n}: type "${type}" is unknown — the exported code stops there, as a run does`);
    return [...out, `Fail    Condition step ${step.n}: unknown condition type, named in the comment above`, 'IF    True'];
  }
  ctx.uses.add('condition');
  const locs = type.startsWith('url') ? '' : `    ${locsRobot(locatorsFor(action))}`;
  return [...out, ...(ctx.frames === 'all' ? ['Unselect Frame'] : []),
    `\${ok${step.n}}=    Check Condition    ${type}    ${valueRobot(action.expectedValue)}${locs}`, `IF    $ok${step.n}`];
}

const indent = (lines) => lines.map((l) => (l === '' ? '' : `    ${l}`));
// A block's body: Robot wants a keyword in each, and a comment is none.
const body = (lines) => (lines.every((l) => l === '' || l.startsWith('#')) ? [...indent(lines), '    No Operation'] : indent(lines));

/**
 * A Switch block as IF / ELSE IF / ELSE on its variable's value now: the first
 * case whose value it is, else the default case (none: nothing runs), as a run picks.
 */
function switchLines(action, step, branches) {
  const n = step.n;
  const cases = branches.filter((b) => !b.isDefault);
  const fallback = branches.find((b) => b.isDefault);
  const out = [`# Step ${n}: switch on ${commentText(normalizeVarRef(action.switchVar))}${action.label ? ` — ${commentText(action.label)}` : ''}`,
    `\${sw${n}}=    Set Variable    ${valueRobot(normalizeVarRef(action.switchVar))}`];
  cases.forEach((b, k) => out.push(`${k ? 'ELSE IF' : 'IF'}    $sw${n} == ${pyText(b.value)}`, ...body(b.body)));
  if (fallback) out.push(cases.length ? 'ELSE' : 'IF    True', ...body(fallback.body));
  if (cases.length || fallback) out.push('END');
  const delay = secs(stepDelayMs(action.delay));
  if (delay > 0) out.push(`Sleep    ${delay}`);
  return out;
}

// The steps, walked as playback walks them (export/walk.js).
const stepLines = (ctx) => walkActions(ctx, {
  step: (action, step) => actionLines(action, step, ctx),
  conditionHead: (action, step) => conditionHead(action, step, ctx),
  conditionBody: (lines) => [...body(lines), 'END'],
  switchLines,
  skippedBlock: (start, end) => [`# Step ${start + 1}: switch block [SKIPPED] — steps ${start + 2}–${end + 1} not exported (requires extension scenario routing)`],
  // The step running now, which a failure names.
  at: (title) => `Set Test Variable    \\\${PQA_AT}    ${robotText(title)}`,
});

// The environment variable of a Pocket QA variable, as the other exports read it.
const envName = (k) => `PQA_${/^[\w-]+$/.test(k) ? k : robotIdent(k)}`;

/**
 * The scenario's variables: their values in the Variables table, and the test's
 * first lines taking each PQA_<name> from the environment when it is set — a
 * random or a pick value drawn first.
 */
function variableLines({ staticVars, randomSpecs, pickSpecs, written }, csv = null) {
  const table = [];
  const setup = [];
  const declared = new Set();
  const fresh = (k) => !declared.has(robotIdent(k)) && declared.add(robotIdent(k));
  // With a data file (`csv`), the row's column of the variable's name wins, as in a CSV run.
  const fromEnv = (k) => [`\${${robotIdent(k)}}=    Set Variable    %{${envName(k)}=\${${robotIdent(k)}}}`,
    ...(csv ? [`\${${robotIdent(k)}}=    Row Value    ${robotText(k)}    \${${robotIdent(k)}}`] : [])].join('\n');
  for (const [k, v] of Object.entries(staticVars)) {
    if (!fresh(k)) continue;
    table.push(`\${${robotIdent(k)}}    ${robotText(v)}`);
    setup.push(fromEnv(k));
  }
  for (const [k, spec] of Object.entries(randomSpecs)) {
    if (!fresh(k)) continue;
    let expr;
    if (spec.type === 'datetime') expr = "datetime.datetime.now().strftime('%Y-%m-%d_%H-%M-%S')";
    else {
      const charset = { alpha: 'string.ascii_letters', numeric: 'string.digits' }[spec.type] || 'string.ascii_letters + string.digits';
      expr = `''.join(random.choices(${charset}, k=${spec.length}))`;
    }
    setup.push(`\${${robotIdent(k)}}=    Evaluate    ${expr}`, fromEnv(k));
  }
  for (const [k, vals] of Object.entries(pickSpecs)) {
    if (!fresh(k)) continue;
    table.push(`@{PQA_CHOICES_${robotIdent(k)}}${vals.map((v) => `    ${robotText(v)}`).join('')}`);
    setup.push(`\${${robotIdent(k)}}=    Evaluate    random.choice($PQA_CHOICES_${robotIdent(k)})`, fromEnv(k));
  }
  if (csv) {
    // A name only the data file gives: its column, which every row must have; one a step
    // writes: seeded by its column when the row has one.
    for (const k of csv.fromColumns) if (fresh(k)) setup.push(`\${${robotIdent(k)}}=    Row Column    ${robotText(k)}`);
    for (const k of csv.written) if (fresh(k)) setup.push(`\${${robotIdent(k)}}=    Row Value    ${robotText(k)}    \${EMPTY}`);
  }
  // A name only a step writes: empty until it does, as in a run.
  for (const k of written) if (!declared.has(k)) table.push(`\${${k}}    \${EMPTY}`);
  return { table, setup: setup.flatMap((l) => l.split('\n')) };
}

/** The file DataDriver reads a data file through, downloaded beside the test. */
export const ROBOT_READER_FILE = 'pqa_csv_reader.py';

/**
 * pqa_csv_reader.py: a DataDriver reader that reads the data file as the CSV run
 * does — the _rows() of the pytest export — where DataDriver's own CSV readers
 * take only columns headed ${name}. A test per row, Row 1, Row 2, …; the row's
 * columns by name in ${DataDriver_TEST_DATA}[arguments].
 */
export function robotReaderPy() {
  return [
    '"'.repeat(3),
    `${ROBOT_READER_FILE} — DataDriver's reader for a Pocket QA Robot test's data file: keep it beside the`,
    '.robot file. It reads the CSV as the Pocket QA CSV run does: the separator its header uses most (comma,',
    'semicolon or Tab), quotes, line breaks inside them, a BOM. A test per row: Row 1, Row 2, …',
    '"'.repeat(3),
    'import os',
    '',
    'from DataDriver.AbstractReaderClass import AbstractReaderClass',
    'from DataDriver.ReaderConfig import TestCaseData',
    '',
    ...csvRowsPy(),
    '',
    '',
    'class pqa_csv_reader(AbstractReaderClass):',
    '    def get_data_from_source(self):',
    '        return [TestCaseData(f"Row {k + 1}", row) for k, row in enumerate(_rows(self.file))]',
    '',
  ].join('\n');
}

// With a data file: the test DataDriver makes a test of for each row, and what reads the row.
const DATA_KEYWORDS = `Row Value
    [Documentation]    The row's column of that name, else the value given: a column wins over the variable of its name.
    [Arguments]    \${name}    \${value}
    \${got}=    Evaluate    $PQA_ROW.get($name, $value)
    RETURN    \${got}

Row Column
    [Documentation]    The row's column of that name, for a name only the data file gives: every row must have it.
    [Arguments]    \${name}
    IF    $name not in $PQA_ROW    Fail    the data file has no column "\${name}"
    RETURN    \${PQA_ROW}[\${name}]`;

// Into `warnings`: two names that differ but are one variable to Robot, `user_name` and `UserName`.
function warnOneToRobot(variables, warnings) {
  const byKey = new Map();
  for (const k of Object.keys(variables || {})) {
    const key = robotKey(robotIdent(k));
    if (byKey.has(key) && robotIdent(byKey.get(key)) !== robotIdent(k)) {
      warnings.add(`"${byKey.get(key)}" and "${k}" are one variable to Robot, which ignores case and _ — rename one`);
    } else byKey.set(key, k);
  }
}

// The start page, unless the scenario opens one first (waits aside).
function startLines(enabled, startUrl) {
  if (enabled.find((a) => a.type !== 'wait')?.type === 'navigate') return [];
  return [...(startUrl ? [] : ['# ⚠ TODO: Set the starting URL (go to Settings tab to configure)']),
    `\${PQA_URL}=    Site URL    ${robotText(startUrl || 'https://your-url-here.com')}`, 'Go To    ${PQA_URL}', ''];
}

// The in-page code a test needs besides Locate's, by what its steps use.
const HELPERS_OF = [['input', 'SET_INPUT_JS'], ['condition', 'CHECK_COND_JS'], ['child', 'FIND_CHILD_JS'], ['read', 'READ_VAL_JS'],
  ['pick', 'PICK_ITEM_JS'], ['drop', 'DROP_BRIDGE_JS'], ['drop', 'DROP_FILES_JS']];

/**
 * What a data file changes: the variables the row's columns give (`csv`, for
 * variableLines), the test (only the template DataDriver copies) and the keywords
 * that hold the steps and read the row. Without one, the test holds the steps.
 */
function dataParts(dataFile, enabled, variables, warnings) {
  if (!dataFile) return { csv: null, test: (steps) => indent(steps), keywords: () => [] };
  warnings.add(`Download saves ${ROBOT_READER_FILE} too (the browser may ask you to keep a .py file): keep it beside the .robot file — DataDriver reads ${dataFile} through it`);
  return {
    csv: { fromColumns: undefinedVarNames(enabled, variables), written: enabled.flatMap((a) => writtenVarNames(a)) },
    test: () => ['    [Documentation]    A test per row of the data file, made by DataDriver from Pocket QA Row.'],
    keywords: (steps) => [['Pocket QA Row',
      `    [Documentation]    One row of ${robotText(dataFile)}: DataDriver makes a test of it, its columns by name in \${PQA_ROW}.`,
      '    Set Test Variable    ${PQA_ROW}    ${DataDriver_TEST_DATA}[arguments]',
      ...indent(steps)].join('\n'), DATA_KEYWORDS],
  };
}

// The Settings: how to run the test, what the environment can change, the library, the setup and teardown.
function settingsLines(name, envVars, dataFile) {
  return [
    '*** Settings ***',
    `Documentation       ${robotText(`${name} — a Pocket QA scenario.`)}`,
    '...                 How to run: pip install robotframework robotframework-seleniumlibrary, then: robot <this file>',
    '...                 Without exporting again, the environment can set PQA_BASE_URL (a site to open instead of the',
    "...                 first page's: its steps go there), PQA_BROWSER (Chrome, Edge, Firefox or Safari), PQA_HEADLESS",
    `...                 (1: no browser window) and ${envVars.length ? robotText(`a variable's value: ${envVars.join(', ')}.`) : 'PQA_<name>, the value of a variable.'}`,
    '...                 A failed test keeps a screenshot of the page and names the step that failed.',
    ...(dataFile ? [
      `...                 ${robotText(`A test per row of the data file ${dataFile}: pip install robotframework-datadriver, and ${ROBOT_READER_FILE} (downloaded with this file) beside it.`)}`,
    ] : []),
    'Library             SeleniumLibrary    run_on_failure=Nothing',
    ...(dataFile ? [`Library             DataDriver    file=${robotText(dataFile)}    reader_class=${ROBOT_READER_FILE}`, 'Test Template       Pocket QA Row'] : []),
    'Suite Setup         Decode Page Helpers',
    'Test Teardown       End Test',
  ];
}

/**
 * The scenario as a Robot Framework test (SeleniumLibrary).
 *
 * @param {object}  opts
 * @param {number}  opts.stepDelay  - ms waited after each step (default 500)
 * @param {number}  opts.elTimeout  - ms a step waits for its element (default 10000)
 * @param {string}  opts.driverType - Chrome (default), Edge, Firefox or Safari
 * @param {boolean} opts.headless   - no browser window (not Safari)
 * @param {string}  opts.startUrl   - opened first when the scenario does not start with a Navigate
 * @param {string}  opts.dataFile   - a CSV file: a test per row (DataDriver, through ROBOT_READER_FILE)
 * @returns {{ code: string, stats: { total, supported, skipped }, steps: object[], warnings: string[] }}
 */
export function generateRobot(scenarioName, actions, variables, opts = {}) {
  const { stepDelay = 500, elTimeout = 10000, startUrl = '', headless = false } = opts;
  const dataFile = String(opts.dataFile || '').trim();
  const driverType = DRIVER_TYPES.has(opts.driverType) ? opts.driverType : 'Chrome';
  const all = actions || [];
  const enabled = all.filter((a) => !a.disabled);
  const warnings = new Set();
  const steps = [];
  const vars = exportVariables(variables, enabled, robotIdent, 'Robot', warnings);
  warnOneToRobot(variables, warnings);
  if (headless && driverType === 'Safari') warnings.add('Safari has no headless mode — the test opens a window');
  const frames = enabled.some(inFrame) ? 'all' : 'none';
  const ctx = { all, layout: getSwitchLayout(all), warnings, steps, stepDelay, uses: new Set(), frames, driverType };
  const bodyLines = stepLines(ctx);
  // The step a failure names is the last one to run: once they all ran, a failure is an Assert's, which names its own.
  if (ctx.uses.has('assert')) {
    bodyLines.push('# A false Assert did not stop the test: it fails at its end, with each one.', 'Set Test Variable    \\${PQA_AT}    ${EMPTY}', '');
  }
  const data = dataParts(dataFile, enabled, variables, warnings);
  const { table, setup } = variableLines(vars, data.csv);

  const helpers = ['FIND_TEXT_JS', 'QUERY_DEEP_JS', ...HELPERS_OF.filter(([use]) => ctx.uses.has(use)).map(([, h]) => h)];
  // With frames, a Condition's element is looked for in them too, and checked in the one that holds it.
  const stepKeyword = (u) => (u === 'condition' && frames === 'all'
    ? STEP_KEYWORDS[u].replace('${el}=    Locate    @{locators}', '${el}=    Locate In Frames    @{locators}') : STEP_KEYWORDS[u]);
  const name = String(scenarioName ?? '').trim();
  const testBody = ['Start Browser', ...[...setup, ...(setup.length ? [''] : []), ...startLines(enabled, startUrl), ...bodyLines]];
  const keywords = [...data.keywords(testBody), BASE_KEYWORDS, findElementKeyword(frames === 'all'), ...(frames === 'all' ? [FRAMES_KEYWORDS] : []),
    ...Object.keys(STEP_KEYWORDS).filter((u) => ctx.uses.has(u)).map(stepKeyword)];

  const out = [
    ...settingsLines(name, Object.keys(variables || {}).map(envName), dataFile),
    '',
    '',
    '*** Variables ***',
    `\${PQA_TIMEOUT}      \${${secs(elTimeout)}}`,
    `\${PQA_BROWSER}      ${driverType}`,
    `\${PQA_HEADLESS}     ${headless ? 1 : 0}`,
    '${PQA_AT}           ${EMPTY}',
    '${PQA_FIRST_ORIGIN}    ${None}',
    ...helpers.map((h, k) => `${k ? '...' : '&{PQA_B64}'}${' '.repeat(k ? 17 : 10)}${h}=${base64(PAGE_CALLS[h])}`),
    ...table,
    '',
    '',
    '*** Test Cases ***',
    name ? robotText(name) : 'Scenario',
    ...data.test(testBody),
    '',
    '*** Keywords ***',
    keywords.join('\n\n'),
  ];

  warnUndefinedVars(enabled, variables, warnings, dataFile);
  const skipped = steps.filter((st) => st.status === 'skip').length;
  return {
    code: `${out.join('\n').replace(/\n{3,}(?=\*\*\* Keywords)/, '\n\n\n')}\n`,
    stats: { total: enabled.length, supported: steps.length - skipped, skipped },
    steps,
    warnings: [...warnings],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// UI MODULE — the modal is popup/export-modal.js; what is particular to this export
// ─────────────────────────────────────────────────────────────────────────────

/** Wire the Robot Framework export. */
export function initExportRobot() {
  const number = (id, fallback) => parseInt(document.getElementById(id)?.value) || fallback;
  initExportModal({
    triggerId: 'exportRobot',
    format: 'rf',
    badge: 'RF',
    title: 'Export Robot Framework',
    // The browser before Headless, which Safari turns off. The start URL follows the tab instead.
    remember: ['exportRfBrowser', 'exportRfHeadless', 'exportRfStepDelay', 'exportRfElTimeout'],
    fileName: (base) => `${base}.robot`,
    readOptions: () => ({
      stepDelay: number('exportRfStepDelay', 500),
      elTimeout: number('exportRfElTimeout', 10000),
      driverType: document.getElementById('exportRfBrowser')?.value || 'Chrome',
      headless: !!document.getElementById('exportRfHeadless')?.checked,
      startUrl: document.getElementById('exportRfStartUrl')?.value.trim() || '',
      dataFile: document.getElementById('exportRfData')?.value.trim() || '',
    }),
    generate: generateRobot,
    copyText: (code) => code,
    file: (code) => ({ text: code, type: 'text/plain' }),
    // With a data file, the reader DataDriver needs goes with it.
    extraFiles: (options) => (options.dataFile ? [{ name: ROBOT_READER_FILE, text: robotReaderPy(), type: 'text/x-python' }] : []),
    startUrl: { field: 'exportRfStartUrl', button: 'exportRfGetUrl', badge: 'exportRfUrlFromTab' },
    headless: { driver: 'exportRfBrowser', box: 'exportRfHeadless', row: 'exportRfHeadlessRow' },
  });
}
