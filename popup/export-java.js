/**
 * export-java.js — the Selenium Java export: a scenario as a TestNG test class,
 * <Name>Test.java, for a Maven or Gradle project with selenium-java 4 and testng.
 *
 * It does what playback does, as the Selenium Python export does: each step's
 * locators in playback's order (shared/locator-order.js), tried in turn by find(),
 * and the extension's own in-page code (popup/export/page-js.js) where a WebDriver
 * call would act otherwise. The file is UTF-8; a value's \ and " are escaped, and
 * a \ in a comment doubled, so no \u in the scenario's text is read by javac.
 */

import { commentText } from './utils.js';
import { exportFileBase, initExportModal } from './export-modal.js';
import { getSwitchLayout } from '../shared/switch-blocks.js';
import { normalizeVarRef } from '../shared/var-name.js';
import { patternRegexSource } from '../shared/text-pattern.js';
import { CHILD_COND_KEYS } from '../shared/child-cond.js';
import { cssEscape } from '../shared/css-escape.js';
import { waitMs, stepDelayMs } from '../shared/wait-ms.js';
import { mark } from './export/steps.js';
import { exportVariables, inFrame, locatorsFor, pickLabel, readTargets, undefinedVarNames, uploadPaths, walkActions, warnUndefinedVars } from './export/walk.js';
import { CONDITION_TYPES, PAGE_CALLS, PICK_ITEM_ASYNC_JS } from './export/page-js.js';

/**
 * The class a scenario's file holds, from the file name's base (export-modal.js
 * exportFileBase), so the class and its file always match: each run of identifier
 * characters capitalised, then Test — "đăng_nhập" → ĐăngNhậpTest.
 *
 * Only the characters Character.isJavaIdentifierPart accepts are kept: letters,
 * decimal and letter numbers (Nd, Nl) and combining marks (Mn, Mc). Other numbers
 * (½, ² — No) and enclosing marks (Me) are dropped, so the class name compiles.
 */
export function javaClassName(scenarioName) {
  const parts = exportFileBase(scenarioName).normalize('NFC').split(/[^\p{L}\p{Nd}\p{Nl}\p{Mn}\p{Mc}]+/u).filter(Boolean);
  const name = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join('');
  if (!name) return 'ScenarioTest';
  return `${/^\p{L}/u.test(name) ? '' : 'Scenario'}${name}Test`;
}

// Java's keywords, the class's fields, and the types the test method names: a variable so named would hide them.
const RESERVED = new Set(['abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if',
  'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected',
  'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
  'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null', 'var', 'record', 'yield', 'sealed', 'permits',
  '_', 'e', 'driver', 'at', 'firstOrigin', 'TIMEOUT', 'LETTERS', 'DIGITS', 'By', 'Actions', 'Pattern', 'Matcher',
  'OutputType', 'WebElement', 'String', 'Thread', 'Object', 'System', 'Math', 'Exception', 'AssertionError']);

/**
 * (name) → the Java variable for a Pocket QA variable: letters, digits and _, a
 * leading digit made `_`; a keyword, a name the class uses or a step's own (el3,
 * sw4) gets `_v`.
 */
export function javaIdent(name) {
  const safe = String(name == null ? 'var' : name).replace(/^\$\{|\}$/g, '').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^\d/, '_') || 'var';
  return RESERVED.has(safe) || /^(el|sw)\d/.test(safe) ? `${safe}_v` : safe;
}

// The escapes of a Java string literal; a control character as a three-digit octal escape.
const ESCAPES = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };

/** Text as a Java string literal. Never a \u escape: javac reads those before the literal. */
export function javaText(s) {
  return `"${String(s ?? '').replace(/[\\"\x00-\x1f\x7f]/g, (c) => ESCAPES[c] || `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`)}"`;
}

// A comment's text on one line, its \ doubled: a \u in it would be read by javac.
const javaComment = (s) => commentText(s).replace(/\\/g, '\\\\');

/** A Pocket QA value as a Java expression: each ${name} its variable, the rest literals, joined with +. */
function valueJava(val) {
  const parts = String(val ?? '').split(/(\$\{[^}]+\})/g).filter((p) => p !== '');
  if (!parts.length) return '""';
  return parts.map((p) => {
    const m = p.match(/^\$\{([^}]+)\}$/);
    return m ? javaIdent(m[1].trim()) : javaText(p);
  }).join(' + ');
}

// One locator as find() takes it: a By of Selenium's, or css() / text() of the class.
function locJava({ type, value, tag }) {
  switch (type) {
    case 'id':        return `By.id(${valueJava(value)})`;
    case 'name':      return `By.name(${valueJava(value)})`;
    case 'xpath':
    case 'fullXpath': return `By.xpath(${valueJava(value)})`;
    case 'testId':    return `css(${valueJava(`[data-testid="${cssEscape(value)}"]`)})`;
    case 'dataId':    return `css(${valueJava(`[data-id="${cssEscape(value)}"]`)})`;
    case 'text':      return `text(${valueJava(value)}, ${javaText(tag || '')})`;
    default:          return `css(${valueJava(value)})`;
  }
}

const locsJava = (locs) => locs.map(locJava).join(', ');

// JS source as a Java constant: a literal per line, joined.
function jsConstant(name, src) {
  const lines = src.split('\n');
  return [`    static final String ${name} = String.join("\\n",`,
    ...lines.map((l, k) => `        ${javaText(l)}${k < lines.length - 1 ? ',' : ');'}`)];
}

// The class's own code every test has: the browser, the site, finding an element as the extension does.
const BASE_HELPERS = String.raw`    /** PQA_BROWSER (Chrome, Edge, Firefox or Safari), else the exported one; PQA_HEADLESS=1: no window, at a desktop size. */
    static WebDriver startBrowser() {
        String name = System.getenv().getOrDefault("PQA_BROWSER", BROWSER);
        boolean headless = "1".equals(System.getenv().getOrDefault("PQA_HEADLESS", HEADLESS));
        switch (name) {
            case "Safari":
                return new SafariDriver();
            case "Firefox": {
                FirefoxOptions options = new FirefoxOptions();
                if (headless) options.addArguments("-headless", "--width=1920", "--height=1080");
                return new FirefoxDriver(options);
            }
            case "Edge": {
                EdgeOptions options = new EdgeOptions();
                if (headless) options.addArguments("--headless=new", "--window-size=1920,1080");
                return new EdgeDriver(options);
            }
            case "Chrome": {
                ChromeOptions options = new ChromeOptions();
                if (headless) options.addArguments("--headless=new", "--window-size=1920,1080");
                return new ChromeDriver(options);
            }
            default:
                throw new IllegalArgumentException("PQA_BROWSER=" + name + ": not Chrome, Edge, Firefox or Safari");
        }
    }

    /** A variable's value: PQA_<name> from the environment when it is set, else the exported one. */
    static String var(String name, String value) {
        String set = System.getenv("PQA_" + name);
        return set != null ? set : value;
    }

    static final Pattern URL_PARTS = Pattern.compile("^([A-Za-z][A-Za-z0-9+.-]*):(//[^/?#]*)?(.*)$", Pattern.DOTALL);

    /** The URL — or, with PQA_BASE_URL set and the URL on the site of the first page opened, the same page there. */
    String url(String u) {
        Matcher m = URL_PARTS.matcher(u);
        if (!m.matches()) return u;
        String origin = m.group(1).toLowerCase() + ":" + (m.group(2) == null ? "" : m.group(2));
        if (firstOrigin == null) firstOrigin = origin;
        String base = System.getenv("PQA_BASE_URL");
        if (base == null || base.isEmpty() || !origin.equals(firstOrigin)) return u;
        return base.replaceAll("/+$", "") + m.group(3);
    }

    Object exec(String script, Object... args) {
        return ((JavascriptExecutor) driver).executeScript(script, args);
    }

    /** A CSS selector, looked for inside open shadow roots too when the page has no match. */
    static By css(String selector) {
        return new By() {
            @Override
            public List<WebElement> findElements(SearchContext context) {
                List<WebElement> found = context.findElements(By.cssSelector(selector));
                if (!found.isEmpty()) return found;
                Object el = ((JavascriptExecutor) context).executeScript(QUERY_DEEP_JS, selector);
                return el instanceof WebElement ? List.of((WebElement) el) : List.of();
            }

            @Override
            public String toString() {
                return "css: " + selector;
            }
        };
    }

    /** The extension's Text search: the innermost element whose trimmed text is the text, of the tag when given. */
    static By text(String text, String tag) {
        return new By() {
            @Override
            public List<WebElement> findElements(SearchContext context) {
                Object el = ((JavascriptExecutor) context).executeScript(FIND_TEXT_JS, text, tag);
                return el instanceof WebElement ? List.of((WebElement) el) : List.of();
            }

            @Override
            public String toString() {
                return "text: " + text;
            }
        };
    }

    /** The first element the locators find now, in their order, or null; a selector the browser cannot parse is passed over. */
    WebElement locate(By... locators) {
        for (By by : locators) {
            try {
                List<WebElement> found = driver.findElements(by);
                if (!found.isEmpty()) return found.get(0);
            } catch (InvalidSelectorException e) {
                // as playback passes it over
            }
        }
        return null;
    }

    /** A step's element, waited for up to TIMEOUT. */
    WebElement find(By... locators) {
        return waitFor(false, locators);
    }

    /** A step's element to click: displayed and enabled too. */
    WebElement findClickable(By... locators) {
        return waitFor(true, locators);
    }

    WebElement waitFor(boolean clickable, By... locators) {
        return new WebDriverWait(driver, TIMEOUT)
            .ignoring(StaleElementReferenceException.class)
            .withMessage("no element found by " + Arrays.toString(locators))
            .until(d -> {
                WebElement el = LOCATE(locators);
                return el != null && (!clickable || (el.isDisplayed() && el.isEnabled())) ? el : null;
            });
    }

    byte[] pageShot() {
        return ((TakesScreenshot) driver).getScreenshotAs(OutputType.BYTES);
    }

    static void save(String file, byte[] png) throws IOException {
        Files.write(Paths.get(file), png);
    }`;

// With a step recorded in a frame: looking in the page, then in its frames.
const FRAMES_HELPERS = String.raw`    /** The element in the page or in one of its frames, frames in frames too; the driver is left in the frame that holds it. */
    WebElement locateInFrames(By... locators) {
        driver.switchTo().defaultContent();
        return searchFrames(locators);
    }

    WebElement searchFrames(By... locators) {
        WebElement el = locate(locators);
        if (el != null) return el;
        for (WebElement frame : driver.findElements(By.cssSelector("iframe, frame"))) {
            try {
                driver.switchTo().frame(frame);
            } catch (WebDriverException e) {
                continue;
            }
            el = searchFrames(locators);
            if (el != null) return el;
            driver.switchTo().parentFrame();
        }
        return null;
    }`;

// The class's code for the steps that use it, written out only then: [its page code, its Java].
const STEP_HELPERS = {
  input: [['SET_INPUT_JS'], String.raw`    static final Set<String> SCRIPT_INPUT_TYPES = Set.of("date", "time", "datetime-local", "month", "week", "color", "range");

    /**
     * An Input as the extension makes it: a <select> chooses the option of that value, else of that text; a date, time,
     * color or range field gets the value as the extension sets it; any other field is typed into.
     */
    void input(WebElement el, String value) {
        if (el.getTagName().equalsIgnoreCase("select")) {
            Select select = new Select(el);
            try {
                select.selectByValue(value);
            } catch (RuntimeException e) {
                select.selectByVisibleText(value);
            }
        } else if (SCRIPT_INPUT_TYPES.contains(String.valueOf(el.getDomProperty("type")))) {
            exec(SET_INPUT_JS, el, value);
        } else {
            el.clear();
            el.sendKeys(value);
        }
    }`],
  condition: [['CHECK_COND_JS'], String.raw`    /** A Condition as the extension checks it (content.js CHECK_CONDITION), on the element found now, without waiting. */
    boolean checkCond(String type, String expected, By... locators) {
        TOP_PAGE
        WebElement el = locators.length > 0 ? locate(locators) : null;
        return Boolean.TRUE.equals(exec(CHECK_COND_JS, type, el, expected));
    }`],
  child: [['FIND_CHILD_JS'], String.raw`    /** The child a Child Condition picks in its parent (content.js findElementByCondition): criteria as name, value pairs. */
    WebElement findChild(WebElement parent, int step, String... criteria) {
        Map<String, String> cond = new LinkedHashMap<>();
        for (int k = 0; k + 1 < criteria.length; k += 2) cond.put(criteria[k], criteria[k + 1]);
        Object el = exec(FIND_CHILD_JS, parent, cond);
        if (!(el instanceof WebElement)) throw new IllegalStateException("Child condition not matched (step " + step + ")");
        return (WebElement) el;
    }`],
  read: [['READ_VAL_JS'], String.raw`    /** What Read DOM reads (content.js readElementValue). */
    String readVal(WebElement el, String from, String attr) {
        Object value = exec(READ_VAL_JS, el, from, attr);
        return value == null ? "" : value.toString();
    }`],
  pick: [['PICK_ITEM_JS'], String.raw`    /** A Dropdown's "Choose item #", as the extension chooses it, in the page. */
    void chooseItem(WebElement el, String raw, String items) {
        Object error = ((JavascriptExecutor) driver).executeAsyncScript(PICK_ITEM_JS, el, raw, items, TIMEOUT.toMillis());
        if (error != null) throw new IllegalStateException(error.toString());
    }`],
  drop: [['DROP_BRIDGE_JS', 'DROP_FILES_JS'], String.raw`    /** An upload to a drop zone as the extension makes it (bg/cdp/upload.js): set on a hidden file input, then dropped. */
    void dropFiles(WebElement zone, String files) {
        WebElement bridge = (WebElement) exec(DROP_BRIDGE_JS);
        bridge.sendKeys(files);
        exec(DROP_FILES_JS, zone, bridge);
    }`],
  full: [[], String.raw`    /** The whole page, not just the window, as the browser can: Firefox its own way, Chrome and Edge through CDP, Safari only the window. */
    @SuppressWarnings("unchecked")
    byte[] fullPageShot() {
        if (driver instanceof HasFullPageScreenshot) return ((HasFullPageScreenshot) driver).getFullPageScreenshotAs(OutputType.BYTES);
        if (!(driver instanceof HasCdp)) return pageShot();
        HasCdp cdp = (HasCdp) driver;
        Map<String, Object> size = (Map<String, Object>) cdp.executeCdpCommand("Page.getLayoutMetrics", Map.of()).get("cssContentSize");
        Map<String, Object> clip = Map.of("x", 0, "y", 0, "width", size.get("width"), "height", size.get("height"), "scale", 1);
        Map<String, Object> shot = cdp.executeCdpCommand("Page.captureScreenshot", Map.of("format", "png", "captureBeyondViewport", true, "clip", clip));
        return Base64.getDecoder().decode((String) shot.get("data"));
    }`],
  // The escaping of _applyVarsToCode (bg/interpolate.js).
  js: [[], String.raw`    /** A value put into a Script step's code, escaped as the extension escapes it. */
    static String js(String v) {
        return v.replace("\\", "\\\\").replace("\"", "\\\"").replace("'", "\\'").replace("` + '`' + String.raw`", "\\` + '`' + String.raw`")
            .replace("$" + "{", "\\$" + "{").replace("\n", "\\n").replace("\r", "\\r");
    }`],
  random: [[], String.raw`    static final String LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    static final String DIGITS = "0123456789";

    /** A Random variable's value: length characters of chars. */
    static String random(String chars, int length) {
        StringBuilder out = new StringBuilder();
        for (int k = 0; k < length; k++) out.append(chars.charAt(ThreadLocalRandom.current().nextInt(chars.length())));
        return out.toString();
    }`],
  now: [[], String.raw`    /** A Random datetime variable's value, as the extension makes it. */
    static String now() {
        return LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd_HH-mm-ss"));
    }`],
  pickVar: [[], String.raw`    /** A Pick variable's value: one of them, at random. */
    static String pick(String... values) {
        return values[ThreadLocalRandom.current().nextInt(values.length)];
    }`],
  stop: [[], String.raw`    /** Stops the test where a run stops, with its message; as a boolean, it can open a block a step would. */
    static boolean stop(String message) {
        throw new IllegalStateException(message);
    }`],
};

/**
 * A Script step: the code as a Java string, each ${name} put in through js() as
 * the extension escapes it; a line per literal.
 */
function scriptLines(code, ctx) {
  const lines = code.split('\n');
  const pieces = lines.map((line, k) => (k < lines.length - 1 ? `${line}\n` : line).split(/(\$\{[^}]+\})/g).filter((p) => p !== '')
    .map((p) => {
      const m = p.match(/^\$\{([^}]+)\}$/);
      if (!m) return javaText(p);
      ctx.uses.add('js');
      return `js(${javaIdent(m[1].trim())})`;
    }).join(' + ') || '""');
  if (pieces.length === 1) return [`exec(${pieces[0]});`];
  return ['exec(', ...pieces.map((p, k) => `        ${k ? '+ ' : ''}${p}${k === pieces.length - 1 ? ');' : ''}`)];
}

// The lines finding a step's element into elN: through findChild with a Child Condition.
function findLines(action, el, ctx, clickable = false) {
  const locs = locsJava(locatorsFor(action));
  if (!action.conditions || !['click', 'input', 'hover', 'readdom'].includes(action.type)) {
    return [`WebElement ${el} = ${clickable ? 'findClickable' : 'find'}(${locs});`];
  }
  ctx.uses.add('child');
  const cond = action.conditions;
  const pairs = [...(cond.matchMode ? [`"matchMode", ${javaText(cond.matchMode)}`] : []),
    ...CHILD_COND_KEYS.filter((f) => cond[f] != null && String(cond[f]) !== '').map((f) => `"${f}", ${valueJava(String(cond[f]))}`)];
  return [`WebElement ${el}p = find(${locs});`, `WebElement ${el} = findChild(${el}p, ${ctx.n}${pairs.map((p) => `, ${p}`).join('')});`];
}

// The upload paths (export/walk.js uploadPaths) as one Java string, a line each; null without a folder or a name.
function uploadFiles(a) {
  const paths = uploadPaths(a);
  return paths ? valueJava(paths.join('\n')) : null;
}

// Read DOM: each ${name} of the pattern takes its part of the text, "Save to var" the whole.
function readdomLines(a, s) {
  s.ctx.uses.add('read');
  const { whole, slots } = readTargets(a, javaIdent);
  const read = `readVal(${s.el}, ${javaText(a.readFrom || 'text')}, ${valueJava(a.attrName || '')})`;
  const out = s.find();
  if (!slots.length) return [...out, `${whole} = ${read};`];
  s.ctx.uses.add('stop');
  out.push(`String ${s.el}t = ${read};`);
  if (whole) out.push(`${whole} = ${s.el}t;`);
  // The pattern's regex only uses syntax JS and java.util.regex read alike; \s as wide as JS's.
  const flags = `Pattern.UNICODE_CHARACTER_CLASS${a.matchCase ? '' : ' | Pattern.CASE_INSENSITIVE'}`;
  out.push(`Matcher ${s.el}m = Pattern.compile(${javaText(patternRegexSource(a.pattern))}, ${flags}).matcher(${s.el}t);`);
  out.push(`if (!${s.el}m.find()) stop(${javaText(`Read DOM (step ${s.n}): text does not match ${String(a.pattern).trim()}: `)} + ${s.el}t);`);
  slots.forEach((name, k) => out.push(`${javaIdent(name)} = ${s.el}m.group(${k + 1}).strip();`));
  return out;
}

/**
 * Per action type: (action, s) → its lines after the step's comment, null when it
 * is not exported; s = { n, el, step, ctx, find(clickable) }.
 */
const STEP_LINES = {
  click: (a, s) => [...s.find(true), `${s.el}.click();`],
  hover: (a, s) => [...s.find(), `new Actions(driver).moveToElement(${s.el}).perform();`],
  input: (a, s) => {
    s.ctx.uses.add('input');
    return [...s.find(), `input(${s.el}, ${valueJava(a.value)});`];
  },
  dropdown: (a, s) => {
    if (!a.pick) return [...s.find(true), `${s.el}.click();`];
    s.ctx.uses.add('pick');
    return [...s.find(true), `chooseItem(${s.el}, ${valueJava(a.pick.index)}, ${valueJava(a.pick.itemSelector || '')});`];
  },
  dragdrop: (a, s) => [`WebElement ${s.el}s = find(${locsJava(locatorsFor(a))});`,
    `WebElement ${s.el}t = find(${locsJava(locatorsFor(a, true))});`,
    `new Actions(driver).dragAndDrop(${s.el}s, ${s.el}t).perform();`],
  navigate: (a) => [`driver.get(url(${valueJava(a.value || a.url)}));`],
  wait: (a) => [`Thread.sleep(${Math.round(waitMs(a))});`],
  script: (a, s) => {
    const code = String(a.code || a.value || '').trim();
    mark(s.step, 'verify', 'custom JS run through executeScript() — check it');
    return [...(s.ctx.frames === 'all' ? ['driver.switchTo().defaultContent();'] : []), ...scriptLines(code, s.ctx)];
  },
  readdom: readdomLines,
  screenshot: (a, s) => [`save("screenshot_step${s.n}.png", pageShot());`],
  screenshot_full: (a, s) => {
    s.ctx.uses.add('full');
    if (s.ctx.driverType === 'Safari') mark(s.step, 'verify', 'Safari saves only the visible part of the page');
    return [`save("screenshot_full_step${s.n}.png", fullPageShot());`];
  },
  screenshot_element: (a, s) => [...s.find(), `save("screenshot_element_step${s.n}.png", ${s.el}.getScreenshotAs(OutputType.BYTES));`],
  screenshot_tovar: (a, s) => {
    const name = javaIdent(a.varName || 'screenshot');
    const out = [`${name} = "screenshot_${name}_step${s.n}.png";`];
    if (a.target === 'element' && locatorsFor(a)[0].value) out.push(...s.find(), `save(${name}, ${s.el}.getScreenshotAs(OutputType.BYTES));`);
    else if (a.target === 'full') {
      s.ctx.uses.add('full');
      out.push(`save(${name}, fullPageShot());`);
    } else out.push(`save(${name}, pageShot());`);
    return out;
  },
  switch: (a, s) => {
    mark(s.step, 'skip', 'a Switch needs the extension to choose what plays');
    return null;
  },
  uploadFile: (a, s) => {
    const files = uploadFiles(a);
    if (!files) {
      mark(s.step, 'verify', 'no folder or file name — the exported code stops there, as a run does');
      s.ctx.uses.add('stop');
      return [`stop("Upload File (step ${s.n}): missing folder or file name(s)");`];
    }
    // Present is enough: pages hide their file inputs, and sendKeys still fills one.
    if (a.uploadMode !== 'dropzone') return [...s.find(), `${s.el}.sendKeys(${files});`];
    s.ctx.uses.add('drop');
    return [...s.find(), `dropFiles(${s.el}, ${files});`];
  },
};

// What a step's comment calls it — as the Selenium Python export does, so a failure reads the same in both.
// Raw text: actionLines escapes the whole return through javaComment once, at the comment line.
function stepWhat(a) {
  switch (a.type) {
    case 'dropdown': return a.pick ? `dropdown → item #${pickLabel(a)}` : 'open dropdown (freeze)';
    case 'dragdrop': return 'drag & drop';
    case 'script': return 'execute script';
    case 'screenshot': return 'screenshot (visible)';
    case 'screenshot_full': return 'screenshot (full page)';
    case 'screenshot_element': return 'screenshot element';
    case 'screenshot_tovar': return `screenshot → variable "${javaIdent(a.varName || 'screenshot')}"`;
    case 'uploadFile': {
      const many = Array.isArray(a.fileNames) && a.fileNames.length > 1;
      return `upload file${many ? 's' : ''}${a.uploadMode === 'dropzone' ? ' to a drop zone' : ''}`;
    }
    case 'readdom': {
      const { whole, slots } = readTargets(a, javaIdent);
      return `read DOM → ${[whole, ...slots.map(javaIdent)].filter(Boolean).map((t) => `"${t}"`).join(', ')}`;
    }
    default: return a.type;
  }
}

// Lines for one step that is not a Condition; marks `step` when it is not exported as is.
function actionLines(action, step, ctx) {
  const n = step.n;
  const el = `el${n}`;
  const lbl = action.label ? ` — ${javaComment(action.label)}` : '';
  if (!Object.hasOwn(STEP_LINES, action.type)) {
    mark(step, 'skip', 'not an action type this version knows');
    return [`// Step ${n}: ${javaComment(action.type)}${lbl} — [unsupported, skipped]`];
  }
  const s = { n, el, step, ctx, find: (clickable) => findLines(action, el, { ...ctx, n }, clickable) };
  const lines = STEP_LINES[action.type](action, s);
  if (!lines) return [`// Step ${n}: switch [SKIPPED] — requires extension scenario routing`];
  // The pause after a step, as in a run: none after a wait, or where the step stops the test.
  const delay = Math.round(stepDelayMs(action.delay != null ? action.delay : ctx.stepDelay));
  if (delay > 0 && action.type !== 'wait' && !lines[0].startsWith('stop(')) lines.push(`Thread.sleep(${delay});`);
  return [`// Step ${n}: ${javaComment(stepWhat(action))}${lbl}`, ...lines];
}

/**
 * The lines opening a Condition's block: if on the in-page check of the element
 * found now (none for the URL types). A type this version does not know stops
 * the test there, as a run does; its name stays in the comment, never in code.
 */
function conditionHead(action, step, ctx) {
  const type = action.conditionType;
  const out = [`// Step ${step.n}: condition — ${javaComment(type)}${action.label ? ` — ${javaComment(action.label)}` : ''}`];
  if (!CONDITION_TYPES.has(type)) {
    mark(step, 'verify', 'unknown condition type — the exported code stops there, as a run does');
    ctx.warnings.add(`Condition step ${step.n}: type "${type}" is unknown — the exported code stops there, as a run does`);
    ctx.uses.add('stop');
    return [...out, `if (stop("Condition step ${step.n}: unknown condition type, named in the comment above")) {`];
  }
  ctx.uses.add('condition');
  const locs = type.startsWith('url') ? '' : `, ${locsJava(locatorsFor(action))}`;
  return [...out, `if (checkCond("${type}", ${valueJava(action.expectedValue)}${locs})) {`];
}

const indent = (lines) => lines.map((l) => (l === '' ? '' : `    ${l}`));

/**
 * A Switch block as if / else if / else on its variable's value now: the first
 * case whose value it is, else the default case (none: nothing runs), as a run picks.
 */
function switchLines(action, step, branches) {
  const n = step.n;
  const cases = branches.filter((b) => !b.isDefault);
  const fallback = branches.find((b) => b.isDefault);
  const out = [`// Step ${n}: switch on ${javaComment(normalizeVarRef(action.switchVar))}${action.label ? ` — ${javaComment(action.label)}` : ''}`,
    `String sw${n} = ${valueJava(normalizeVarRef(action.switchVar))};`];
  cases.forEach((b, k) => out.push(`${k ? '} else if' : 'if'} (sw${n}.equals(${javaText(String(b.value ?? ''))})) {`, ...indent(b.body)));
  if (fallback) out.push(cases.length ? '} else {' : 'if (true) {', ...indent(fallback.body));
  if (cases.length || fallback) out.push('}');
  const delay = Math.round(stepDelayMs(action.delay));
  if (delay > 0) out.push(`Thread.sleep(${delay});`);
  return out;
}

// The steps, walked as playback walks them (export/walk.js).
const stepLines = (ctx) => walkActions(ctx, {
  step: (action, step) => actionLines(action, step, ctx),
  conditionHead: (action, step) => conditionHead(action, step, ctx),
  conditionBody: (lines) => [...indent(lines), '}'],
  switchLines,
  skippedBlock: (start, end) => [`// Step ${start + 1}: switch block [SKIPPED] — steps ${start + 2}–${end + 1} not exported (requires extension scenario routing)`],
  // The step running now, which a failure names.
  at: (title) => `at = ${javaText(title)};`,
});

/**
 * The test's variables, each from PQA_<name> when it is set: the Variables tab's,
 * a name a step writes (empty until it does), and one a step uses that nothing
 * defines — its ${name} text, as a run leaves it.
 */
function variableLines(enabled, variables, { staticVars, randomSpecs, pickSpecs, written }, uses) {
  const out = [];
  const declared = new Set();
  const declare = (k, expr) => {
    const id = javaIdent(k);
    if (declared.has(id)) return;
    declared.add(id);
    out.push(`String ${id} = ${expr};`);
  };
  for (const [k, v] of Object.entries(staticVars)) declare(k, `var(${javaText(k)}, ${javaText(v)})`);
  for (const [k, spec] of Object.entries(randomSpecs)) {
    if (spec.type === 'datetime') {
      uses.add('now');
      declare(k, `var(${javaText(k)}, now())`);
      continue;
    }
    uses.add('random');
    const chars = { alpha: 'LETTERS', numeric: 'DIGITS' }[spec.type] || 'LETTERS + DIGITS';
    declare(k, `var(${javaText(k)}, random(${chars}, ${Number(spec.length) || 0}))`);
  }
  for (const [k, vals] of Object.entries(pickSpecs)) {
    uses.add('pickVar');
    declare(k, `var(${javaText(k)}, pick(${vals.map(javaText).join(', ')}))`);
  }
  // What the steps write, as identifiers already: the names of `written`, and a Read DOM's or a screenshot's
  // without a name of its own.
  for (const id of [...written, ...enabled.flatMap(assignedIdents)]) {
    if (declared.has(id)) continue;
    declared.add(id);
    out.push(`String ${id} = "";`);
  }
  for (const k of undefinedVarNames(enabled, variables)) declare(k, `var(${javaText(k)}, ${javaText(`\${${k}}`)})`);
  return out;
}

// The variables a step assigns to, as the steps name them (readTargets, screenshot_tovar).
function assignedIdents(a) {
  if (a.type === 'readdom') {
    const { whole, slots } = readTargets(a, javaIdent);
    return [whole, ...slots.map(javaIdent)].filter(Boolean);
  }
  return a.type === 'screenshot_tovar' ? [javaIdent(a.varName || 'screenshot')] : [];
}

// What the file opens with: how to run it, and what the environment can change.
function runNotes(driverType, headless, varNames) {
  return [
    '// How to run: in a Maven or Gradle project with org.seleniumhq.selenium:selenium-java 4 and org.testng:testng 7,',
    '// this file in src/test/java, then: mvn test (Gradle: test { useTestNG() }). The file is UTF-8 (javac -encoding UTF-8).',
    '// Without exporting again, the environment can set:',
    "//   PQA_BASE_URL  a site to open instead of the first page's (staging, production): its steps go there",
    `//   PQA_BROWSER   Chrome, Edge, Firefox or Safari (exported: ${driverType})`,
    `//   PQA_HEADLESS  1: no browser window, 0: a window (exported: ${headless ? 1 : 0})`,
    ...(varNames.length ? [`//   PQA_<name>    a variable's value: ${javaComment(varNames.map((k) => `PQA_${k}`).join(', '))}`] : []),
    '// A failed test names its step and leaves <class>_failure.png where it runs.',
  ];
}

const IMPORTS = ['java.io.IOException', 'java.nio.file.Files', 'java.nio.file.Paths', 'java.time.Duration', 'java.time.LocalDateTime',
  'java.time.format.DateTimeFormatter', 'java.util.Arrays', 'java.util.Base64', 'java.util.LinkedHashMap', 'java.util.List',
  'java.util.Map', 'java.util.Set', 'java.util.concurrent.ThreadLocalRandom', 'java.util.regex.Matcher', 'java.util.regex.Pattern',
  'org.openqa.selenium.By', 'org.openqa.selenium.InvalidSelectorException', 'org.openqa.selenium.JavascriptExecutor',
  'org.openqa.selenium.OutputType', 'org.openqa.selenium.SearchContext', 'org.openqa.selenium.StaleElementReferenceException',
  'org.openqa.selenium.TakesScreenshot', 'org.openqa.selenium.WebDriver', 'org.openqa.selenium.WebDriverException',
  'org.openqa.selenium.WebElement', 'org.openqa.selenium.chrome.ChromeDriver', 'org.openqa.selenium.chrome.ChromeOptions',
  'org.openqa.selenium.chromium.HasCdp', 'org.openqa.selenium.edge.EdgeDriver', 'org.openqa.selenium.edge.EdgeOptions',
  'org.openqa.selenium.firefox.FirefoxDriver', 'org.openqa.selenium.firefox.FirefoxOptions',
  'org.openqa.selenium.firefox.HasFullPageScreenshot', 'org.openqa.selenium.interactions.Actions',
  'org.openqa.selenium.safari.SafariDriver', 'org.openqa.selenium.support.ui.Select', 'org.openqa.selenium.support.ui.WebDriverWait',
  'org.testng.ITestResult', 'org.testng.annotations.AfterMethod', 'org.testng.annotations.BeforeMethod', 'org.testng.annotations.Test'];

// The page code and helpers a test needs, by what its steps use; with frames, every look goes through them.
function helperLines(uses, frames) {
  const pageJs = ['FIND_TEXT_JS', 'QUERY_DEEP_JS', ...Object.keys(STEP_HELPERS).filter((u) => uses.has(u)).flatMap((u) => STEP_HELPERS[u][0])];
  const blocks = [BASE_HELPERS.replace('LOCATE(', frames ? 'locateInFrames(' : 'locate('),
    ...(frames ? [FRAMES_HELPERS] : []),
    ...Object.keys(STEP_HELPERS).filter((u) => uses.has(u))
      .map((u) => STEP_HELPERS[u][1].replace('        TOP_PAGE\n', frames ? '        driver.switchTo().defaultContent();\n' : ''))];
  return [
    "    // The extension's own in-page code (popup/export/page-js.js), run through executeScript.",
    ...pageJs.flatMap((h) => [...jsConstant(h, PAGE_CALLS[h]), '']),
    ...blocks.join('\n\n').split('\n'),
  ];
}

// The drivers the Settings tab offers.
const DRIVER_TYPES = new Set(['Chrome', 'Edge', 'Firefox', 'Safari']);

/**
 * The scenario as a TestNG test class (Selenium Java).
 *
 * @param {object}  opts
 * @param {number}  opts.stepDelay  - ms waited after each step (default 500)
 * @param {number}  opts.elTimeout  - ms a step waits for its element (default 10000)
 * @param {string}  opts.driverType - Chrome (default), Edge, Firefox or Safari
 * @param {boolean} opts.headless   - no browser window (not Safari)
 * @param {string}  opts.startUrl   - opened first when the scenario does not start with a Navigate
 * @returns {{ code: string, stats: { total, supported, skipped }, steps: object[], warnings: string[] }}
 */
export function generateJava(scenarioName, actions, variables, opts = {}) {
  const { stepDelay = 500, elTimeout = 10000, startUrl = '', headless = false } = opts;
  const driverType = DRIVER_TYPES.has(opts.driverType) ? opts.driverType : 'Chrome';
  const all = actions || [];
  const enabled = all.filter((a) => !a.disabled);
  const warnings = new Set();
  const steps = [];
  const vars = exportVariables(variables, enabled, javaIdent, 'Java', warnings);
  if (headless && driverType === 'Safari') warnings.add('Safari has no headless mode — the test opens a window');
  const frames = enabled.some((a) => inFrame(a) && a.type !== 'condition') ? 'all' : 'none';
  const ctx = { all, layout: getSwitchLayout(all), warnings, steps, stepDelay, uses: new Set(), frames, driverType };
  const body = stepLines(ctx);
  const varLines = variableLines(enabled, variables, vars, ctx.uses);

  // The start page, unless the scenario opens one first (waits aside).
  const first = enabled.find((a) => a.type !== 'wait');
  const start = first?.type === 'navigate' ? []
    : [...(startUrl ? [] : ['// ⚠ TODO: Set the starting URL (go to Settings tab to configure)']),
      `driver.get(url(${javaText(startUrl || 'https://your-url-here.com')}));`, ''];
  const className = javaClassName(scenarioName);
  // test<Name>: never a keyword, nor a method of the class.
  const method = `test${className.replace(/Test$/, '')}`;

  const out = [
    ...runNotes(driverType, headless, Object.keys(variables || {})),
    '',
    ...IMPORTS.map((i) => `import ${i};`),
    '',
    `/** ${javaComment(scenarioName)} — a Pocket QA scenario. */`,
    `public class ${className} {`,
    `    static final Duration TIMEOUT = Duration.ofMillis(${Math.round(Number(elTimeout)) || 10000});`,
    `    static final String BROWSER = "${driverType}";`,
    `    static final String HEADLESS = "${headless ? 1 : 0}";`,
    '',
    '    WebDriver driver;',
    '    String firstOrigin;',
    '    // The step running now, which a failure names.',
    '    String at = "";',
    '',
    ...helperLines(ctx.uses, frames === 'all'),
    '',
    '    @BeforeMethod',
    '    public void setUp() {',
    '        driver = startBrowser();',
    '        driver.manage().timeouts().scriptTimeout(TIMEOUT.plusSeconds(5));',
    '    }',
    '',
    '    /** A failed test leaves the page as its step left it: <class>_failure.png. */',
    '    @AfterMethod(alwaysRun = true)',
    '    public void tearDown(ITestResult result) {',
    '        if (driver == null) return;',
    '        try {',
    '            if (result.getStatus() == ITestResult.FAILURE) save(getClass().getSimpleName() + "_failure.png", pageShot());',
    '        } catch (Exception e) {',
    "            // no picture: the step's own error is what is reported",
    '        } finally {',
    '            driver.quit();',
    '        }',
    '    }',
    '',
    '    @Test',
    `    public void ${method}() throws Exception {`,
    ...(varLines.length ? ['        // --- VARIABLES ---', ...varLines.map((l) => `        ${l}`), ''] : []),
    '        try {',
    ...[...start, ...body].join('\n').trimEnd().split('\n').map((l) => (l === '' ? '' : `            ${l}`)),
    '        } catch (Exception | AssertionError e) {',
    '            throw new AssertionError((at.isEmpty() ? "Error" : at) + ": " + String.valueOf(e.getMessage()).lines().findFirst().orElse(""), e);',
    '        }',
    '    }',
    '}',
  ];

  warnUndefinedVars(enabled, variables, warnings);
  const skipped = steps.filter((st) => st.status === 'skip').length;
  return {
    code: `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`,
    stats: { total: enabled.length, supported: steps.length - skipped, skipped },
    steps,
    warnings: [...warnings],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// UI MODULE — the modal is popup/export-modal.js; what is particular to this export
// ─────────────────────────────────────────────────────────────────────────────

/** Wire the Selenium Java export. */
export function initExportJava() {
  const number = (id, fallback) => parseInt(document.getElementById(id)?.value) || fallback;
  initExportModal({
    triggerId: 'exportJava',
    format: 'java',
    badge: 'JV',
    title: 'Export Java',
    // The driver before Headless, which Safari turns off. The start URL follows the tab instead.
    remember: ['exportJavaDriver', 'exportJavaHeadless', 'exportJavaStepDelay', 'exportJavaElTimeout'],
    // The class's name: a public class's file is named after it.
    fileName: (base) => `${javaClassName(base)}.java`,
    readOptions: () => ({
      stepDelay: number('exportJavaStepDelay', 500),
      elTimeout: number('exportJavaElTimeout', 10000),
      driverType: document.getElementById('exportJavaDriver')?.value || 'Chrome',
      headless: !!document.getElementById('exportJavaHeadless')?.checked,
      startUrl: document.getElementById('exportJavaStartUrl')?.value.trim() || '',
    }),
    generate: generateJava,
    copyText: (code) => code,
    file: (code) => ({ text: code, type: 'text/x-java' }),
    startUrl: { field: 'exportJavaStartUrl', button: 'exportJavaGetUrl', badge: 'exportJavaUrlFromTab' },
    wire: () => document.getElementById('exportJavaDriver')?.addEventListener('change', syncHeadless),
  });
}

// Safari has no headless mode: with it chosen, Headless is off and cannot be turned on.
function syncHeadless() {
  const safari = document.getElementById('exportJavaDriver')?.value === 'Safari';
  const box = document.getElementById('exportJavaHeadless');
  if (!box) return;
  if (safari) box.checked = false;
  box.disabled = safari;
  document.getElementById('exportJavaHeadlessRow').title = safari ? 'Safari has no headless mode' : '';
}
