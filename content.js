/**
 * content.js — Content script injected into every eligible tab.
 * Handles action recording (click, input events), action playback, element
 * picker UI, screenshot helpers, hotkeys, and segment-capture overlay.
 *
 * A classic script in all frames, injected by the manifest and again by
 * chrome.scripting; everything after safeSend runs inside the
 * `window.__actionRecorderInjected` guard, so a second injection only says
 * CONTENT_READY again. Sections, in file order (search for the name):
 *
 *   STATE                          recording / picker state of this frame; REGISTER_FRAME,
 *                                  RECORDING_STATE
 *   DYNAMIC ID DETECTION           ids too unstable to use in a selector
 *   SELECTOR BUILDERS              css / xpath / full xpath / all locators of an element
 *   SHADOW DOM PIERCE              querySelectorDeep through open shadow roots
 *   ELEMENT FINDER                 findElementWithFallback: each locator in turn
 *   CONDITION-BASED ELEMENT FIND   findElementByCondition, waitForElement
 *   RECORDING                      page events → RECORDED_ACTION
 *   PLAYBACK                       PLAY_ACTION; the Read DOM reader sits between the
 *                                  <readdom-core> markers (tests/readdom.test.mjs loads it),
 *                                  Dropdown's item chooser after it (<dropdown-pick-core>,
 *                                  tests/dropdown-pick.test.mjs)
 *   SHARED IN-PAGE OVERLAY CHROME  _extOverlay(): the template every overlay below uses
 *   ELEMENT PICKER                 START_PICK_MODE / STOP_PICK_MODE → ELEMENT_PICKED
 *   FULL PAGE SCREENSHOT HELPER    GET_PAGE_DIMENSIONS, GET_ELEMENT_RECT, CHECK_CONDITION;
 *                                  MARK_ELEMENT / UNMARK_ELEMENT for the CDP steps
 *   HOTKEYS                        the shortcut settings
 *   VISIBLE SCREENSHOT COUNTDOWN   the countdown pill, FULL_CAPTURE_STATE (ESC cancels a
 *                                  capture), and the keydown handler that fires the hotkeys
 *   FAILED-ACTION PROMPT           ACTION_FAILED_PROMPT: retry / skip / stop on the page
 *   PING / PONG                    liveness probe
 *   SEGMENT CAPTURE OVERLAY        START_SEGMENT_TAB: the bar and auto-scroll → CAPTURE_SEGMENT
 *   HIGHLIGHT ENGINE LOADING       content-highlight.js (text highlights and notes, HL_*
 *                                  messages): what it uses from here, and HL_LOAD while
 *                                  highlighting is on
 *   NOTIFY READY                   CONTENT_READY to the worker
 */

// Suppress "Extension context invalidated" errors thrown after an extension
// reload or update while old content scripts are still alive in open tabs.
function safeSend(msg) {
  try {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch (_) { /* extension reloaded under this page: nobody left to send to */ }
}

// Guard against multiple injections — chrome.scripting.executeScript can be
// called more than once on a tab (e.g. reconnect after content script crash).
if (window.__actionRecorderInjected) {
  safeSend({ type: 'CONTENT_READY' });
} else {
  window.__actionRecorderInjected = true;

/* ─────────────────────────────────────────────────────────────────────────────
   STATE
───────────────────────────────────────────────────────────────────────────── */

let pickerMode = false;

/**
 * Whether a recording session is currently running.
 *
 * The click and input listeners below are attached to `document` on every page and
 * in every frame (manifest all_frames: true), so without this gate they fired for
 * every click and every keystroke the user made anywhere — sending the field's
 * value to the service worker each time. That woke the worker continuously (each
 * message resets its 30 s idle timer, so it effectively never slept) and pushed
 * input values, password fields included, onto the extension message bus outside
 * any recording session.
 *
 * Seeded from the REGISTER_FRAME reply so a script injected mid-recording (tab
 * activation, reconnect after a crash) starts in the right state, then kept in
 * sync by RECORDING_STATE broadcasts from background.js.
 */
let _isRecording = false;

/**
 * Whether this tab is activated: only there do the record hotkeys act, and only
 * there do they keep the key from the page. Seeded from the REGISTER_FRAME reply
 * and asked again when the activated tabs change (see HOTKEYS).
 */
let _tabActivated = false;

// Background has access to sender.frameId; content scripts do not.  We ask for
// it on load so every recorded action can embed the frameId and be replayed in
// the correct iframe.  Defaults to 0 (main frame) on error.
let _myFrameId = 0;
try {
  chrome.runtime.sendMessage({ type: 'REGISTER_FRAME' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    if (res.frameId != null) _myFrameId = res.frameId;
    _isRecording = !!res.recording;
    _tabActivated = !!res.activated;
  });
} catch (_) { /* extension context invalidated: keep frame 0, not recording */ }

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'RECORDING_STATE') _isRecording = !!msg.recording;
});

/* ─────────────────────────────────────────────────────────────────────────────
   DYNAMIC ID DETECTION
   Identifies auto-generated IDs that are unstable across page loads and
   therefore unsafe to use as selectors.
───────────────────────────────────────────────────────────────────────────── */

const _DYNAMIC_ID_RE = new RegExp([
  /^[:]./,                             // React fiber IDs (":r0:", ":ra:") — start with colon
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, // full UUID v4
].map(r => r.source).join('|'), 'i');

function _isDynamicId(id) {
  if (!id) return true;
  return _DYNAMIC_ID_RE.test(id);
}

/* ─────────────────────────────────────────────────────────────────────────────
   SELECTOR BUILDERS
───────────────────────────────────────────────────────────────────────────── */

function getCssSelector(el) {
  if (!el) return null;
  if (el.id && !_isDynamicId(el.id)) return `#${CSS.escape(el.id)}`;

  const path = [];
  let current = el;
  while (current && current.nodeType === 1 && current !== document.body) {
    let selector = current.tagName.toLowerCase();

    if (current.tagName === 'INPUT' && current.type) {
      selector += `[type="${CSS.escape(current.type)}"]`;
      if (current.name) selector += `[name="${CSS.escape(current.name)}"]`;
      if (current.type === 'radio' && current.value) {
        // Radio buttons with the same name share the same selector without value.
        selector += `[value="${CSS.escape(current.value)}"]`;
      }
    } else if (current.className && typeof current.className === 'string') {
      // Combine up to 3 stable classes for a more unique selector without being
      // fragile (more than 3 classes increases the chance of version-churn).
      const stableClasses = current.className.split(/\s+/).filter(Boolean)
        .filter(c => !_DYNAMIC_ID_RE.test(c))
        .slice(0, 3);
      if (stableClasses.length > 0) {
        selector += stableClasses.map(c => `.${CSS.escape(c)}`).join('');
      }
    }

    if (current.parentElement) {
      const siblings = current.parentElement.querySelectorAll(`:scope > ${selector}`);
      if (siblings.length > 1) {
        const idx = Array.from(current.parentElement.children).indexOf(current) + 1;
        selector += `:nth-child(${idx})`;
      }
    }

    path.unshift(selector);
    current = current.parentElement;
  }
  return path.join(' > ');
}

/**
 * Build an XPath expression that targets an element by its id attribute,
 * safely handling IDs that contain double-quote characters.
 *
 * XPath attribute values must be quoted; a literal " inside a double-quoted
 * string is invalid XPath.  The workaround is XPath's concat() function to
 * join the parts around the embedded quote character.
 */
function _xpathId(id) {
  if (!id.includes('"')) return `//*[@id="${id}"]`;
  const parts = id.split('"').map(p => `"${p}"`).join(', \'"\', ');
  return `//*[@id=concat(${parts})]`;
}

function getXPath(el) {
  if (!el) return null;
  if (el.id && !_isDynamicId(el.id)) return _xpathId(el.id);

  const parts = [];
  let current = el;

  while (current && current.nodeType === 1) {
    if (current === document.body) { parts.unshift('/html/body'); break; }

    if (current.id && !_isDynamicId(current.id)) {
      parts.unshift(_xpathId(current.id));   // anchor on stable ID
      break;
    }

    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
    current = current.parentElement;
  }
  return parts.join('/');
}

function getFullXPath(el) {
  if (!el) return null;
  const parts = [];
  let current = el;
  while (current && current.nodeType === 1) {
    if (current === document.documentElement) { parts.unshift('/html'); break; }
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
    current = current.parentElement;
  }
  return parts.join('/');
}

function getAllSelectors(el) {
  if (!el) return null;
  const selectors = {
    css:       getCssSelector(el),
    xpath:     getXPath(el),
    fullXpath: getFullXPath(el),
  };
  if (el.id && !_isDynamicId(el.id)) selectors.id = el.id;
  if (el.name) selectors.name = el.name;

  const textContent = (el.textContent || '').trim();
  if (textContent && textContent.length <= 50 &&
      ['A', 'BUTTON', 'SPAN', 'LABEL', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(el.tagName)) {
    selectors.text    = textContent;
    selectors.textTag = el.tagName.toLowerCase();
  }
  if (el.dataset?.testid) selectors.testId = el.dataset.testid;
  if (el.dataset?.id)     selectors.dataId = el.dataset.id;

  return selectors;
}

/* ─────────────────────────────────────────────────────────────────────────────
   SHADOW DOM PIERCE
   Web components (LitElement, Stencil, etc.) render into shadow roots that are
   opaque to document.querySelector.  This recursive walk traverses open shadow
   roots so CSS selectors can resolve across component boundaries.
───────────────────────────────────────────────────────────────────────────── */

function querySelectorDeep(selector, root = document) {
  try {
    const el = root.querySelector(selector);
    if (el) return el;
  } catch (_) { return null; }
  const hosts = root.querySelectorAll('*');
  for (const host of hosts) {
    if (host.shadowRoot) {
      const found = querySelectorDeep(selector, host.shadowRoot);
      if (found) return found;
    }
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────────
   ELEMENT FINDER
───────────────────────────────────────────────────────────────────────────── */

// While waiting for an element, how often the shadow-DOM walk may run.
const DEEP_SCAN_INTERVAL_MS = 250;

/**
 * Run `cb` on the next animation frame, or on the next task when the tab is
 * hidden: Chrome runs no requestAnimationFrame callback in a background tab, so
 * a playback waiting on one stalls the moment the user switches tabs.
 */
function nextFrame(cb) {
  if (document.hidden) setTimeout(cb, 0);
  else requestAnimationFrame(cb);
}

/**
 * The ways to find the element `selectors` describes, in the order they are
 * tried: fullXpath first (absolute position — most precise for recorded actions),
 * then id (unique by spec), xpath (id-anchored), css, shadow DOM pierce,
 * testId/dataId, name, text (most ambiguous). `prefer`, the selector type the
 * user chose in the form (action.selectorType), is tried first; the rest keep
 * that order. Each is { type, fn }: fn returns the element or null, or throws on
 * a selector it cannot parse. `deep` is the shadow-DOM walk.
 */
function _locators(selectors, prefer = null, deep = querySelectorDeep) {
  if (typeof selectors === 'string') selectors = { css: selectors };
  const strategies = [];
  if (selectors.fullXpath) strategies.push({ type: 'fullXpath', fn: () => document.evaluate(selectors.fullXpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue });
  if (selectors.id)       strategies.push({ type: 'id',       fn: () => document.getElementById(selectors.id) });
  if (selectors.xpath)    strategies.push({ type: 'xpath',    fn: () => document.evaluate(selectors.xpath,    document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue });
  if (selectors.css)      strategies.push({ type: 'css',      fn: () => document.querySelector(selectors.css) });
  if (selectors.css)      strategies.push({ type: 'cssShadow', fn: () => deep(selectors.css) });
  if (selectors.testId)   strategies.push({ type: 'testId',   fn: () => document.querySelector(`[data-testid="${CSS.escape(selectors.testId)}"]`) });
  if (selectors.dataId)   strategies.push({ type: 'dataId',   fn: () => document.querySelector(`[data-id="${CSS.escape(selectors.dataId)}"]`) });
  if (selectors.name)     strategies.push({ type: 'name',     fn: () => document.querySelector(`[name="${CSS.escape(selectors.name)}"]`) });
  if (selectors.text) {
    strategies.push({
      type: 'text',
      fn: () => (selectors.textTag
        ? [...document.querySelectorAll(selectors.textTag)].find(el => el.textContent.trim() === selectors.text)
        : _innermostWithText(selectors.text)),
    });
  }
  const chosen = prefer ? strategies.findIndex((s) => s.type === prefer) : -1;
  if (chosen > 0) strategies.unshift(...strategies.splice(chosen, 1));
  return strategies;
}

/**
 * What a Text selector typed in the form finds: the first element whose text,
 * trimmed, is exactly `text`, then the deepest one inside it that still is (the
 * <span> in <button><span>OK</span></button>). A picked element also records its
 * tag (textTag) and is looked up by it; a typed one has none, and used to match
 * nothing. Only subtrees that hold the text are walked into.
 */
function _innermostWithText(text) {
  const want = String(text).trim();
  const holds = (el) => el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE' && el.textContent.trim() === want;
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (el) => (el.textContent.includes(want) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  let hit = null;
  for (let el = walker.nextNode(); el; el = walker.nextNode()) {
    if (hit && !hit.contains(el)) break;
    if (holds(el)) hit = el;
  }
  return hit;
}

/** The element the first strategy that finds one returns, or null. */
function _firstLocated(strategies) {
  for (const strategy of strategies) {
    try {
      const el = strategy.fn();
      if (el) { return el; }
    } catch (_) { /* selector invalid for this strategy: try the next one */ }
  }
  return null;
}

/**
 * The element as the page is now, without waiting, found the way an action
 * finds it (_locators): the Condition check and the element-screenshot rect
 * looked with orders of their own, and ignored the selector type chosen in the
 * form. `selector`, the action's plain selector, is tried as CSS when
 * `selectors` has no css of its own.
 */
function locateNow(selectors, selector, prefer = null) {
  return _firstLocated(_locators(_withPlain(selectors, selector), prefer));
}

/** `selectors`, with the action's plain `selector` as its CSS when it has none of its own. */
function _withPlain(selectors, selector) {
  const plain = typeof selector === 'string' && selector ? { css: selector } : {};
  return { ...plain, ...(selectors && typeof selectors === 'object' ? selectors : {}) };
}

/** `prefer`: the selector type the user chose in the form (action.selectorType) — see _locators. */
function findElementWithFallback(selectors, timeout = 5000, prefer = null) {
  return new Promise((resolve, reject) => {
    // A walk of every element and shadow root: run on the first try, then at
    // most every DEEP_SCAN_INTERVAL_MS while waiting, not on every animation
    // frame a busy page mutates in.
    let deepSkipped = false; // the last try left out the shadow-DOM walk (interval)
    let lastDeepScan = -Infinity;
    const deep = (css) => {
      deepSkipped = Date.now() - lastDeepScan < DEEP_SCAN_INTERVAL_MS;
      if (deepSkipped) return null;
      lastDeepScan = Date.now();
      return querySelectorDeep(css);
    };
    const strategies = _locators(selectors, prefer, deep);
    const tryStrategies = () => _firstLocated(strategies);

    const el = tryStrategies();
    if (el) return resolve(el);

    // MutationObserver with rAF debounce: coalesces burst DOM mutations (common
    // in React renders) into at most one check per animation frame.
    // childList+subtree only — omitting "attributes" prevents firing on every
    // CSS class/style update which would make this very hot.
    let found = false;
    let rafQueued = false;
    // A shadow-DOM walk skipped for the interval runs once it is over: changes
    // inside a shadow root do not reach the observer, so no later mutation may
    // come to try again.
    let trailing = null;

    const check = () => {
      if (found) return;
      const foundEl = tryStrategies();
      if (foundEl) {
        found = true;
        observer.disconnect();
        clearTimeout(timer);
        clearTimeout(trailing);
        resolve(foundEl);
      } else if (deepSkipped && !trailing) {
        trailing = setTimeout(() => { trailing = null; check(); }, DEEP_SCAN_INTERVAL_MS);
      }
    };

    const observer = new MutationObserver(() => {
      if (found || rafQueued) return;
      rafQueued = true;
      nextFrame(() => {
        rafQueued = false;
        check();
      });
    });

    // document.body is null during early HTML parsing; fall back to <html>.
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      if (found) return;
      found = true;
      clearTimeout(trailing);
      observer.disconnect();
      reject(new Error(`Timeout: Element not found with any selector strategy`));
    }, timeout);
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   CONDITION-BASED ELEMENT FIND
   Walks a container's subtree with a TreeWalker for O(n) early-exit rather
   than building a full NodeList with querySelectorAll("*").
───────────────────────────────────────────────────────────────────────────── */

// Detects {fallback:A|B|C} format stored in a condition field value.
const _FALLBACK_RE = /^\{fallback:(.+)\}$/;
function _parseFallbackSpec(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(_FALLBACK_RE);
  // An empty segment is a Blank entry — kept, it matches an empty field.
  return m ? m[1].split('|').map(s => s.trim()) : null;
}

// A Blank fallback entry for `field`: the child's field is empty.
function _blankCheck(field, normalize) {
  if (field === 'valueEquals')   return el => el.value !== undefined && String(el.value) === '';
  if (field === 'textContains')  return el => normalize(el.textContent) === '';
  if (field === 'idContains')    return el => !el.id;
  if (field === 'classContains') return el => normalize(el.getAttribute('class')) === '';
  return el => !el.getAttribute('type'); // typeEquals
}

// Core single-value child search.  Used by findElementByCondition for both the
// direct path (no fallback) and each iteration of the fallback path.
function _findElementSingle(root, conditions, normalize, blankField = null) {
  const { matchMode = 'any', valueEquals, textContains, idContains, classContains, typeEquals } = conditions;
  const checks = [];
  if (valueEquals  !== undefined && valueEquals  !== '') checks.push(el => el.value !== undefined && String(el.value) === String(valueEquals));
  if (textContains != null && textContains !== '') {
    const needle = normalize(textContains);
    checks.push(el => {
      const ownText = normalize(
        Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(''),
      );
      return ownText.includes(needle) || normalize(el.textContent).includes(needle);
    });
  }
  if (idContains    != null && idContains    !== '') { const n = normalize(idContains);    checks.push(el => normalize(el.id).includes(n)); }
  if (classContains != null && classContains !== '') { const n = normalize(classContains); checks.push(el => normalize(el.className).includes(n)); }
  // "select" is any <select>: its type is "select-one" or "select-multiple".
  if (typeEquals    != null && typeEquals    !== '') checks.push(el => (typeEquals === 'select' ? el.tagName === 'SELECT' : el.type === typeEquals));
  if (blankField) checks.push(_blankCheck(blankField, normalize));
  if (checks.length === 0) return null;
  const test = matchMode === 'all' ? el => checks.every(fn => fn(el)) : el => checks.some(fn => fn(el));
  let hit = _firstMatch(root, test);
  // An element's textContent holds all of its children's text, so for a text
  // condition the first match in document order is the outermost wrapper (the
  // <tbody> of a table holding "John"). Go down to the innermost element that
  // still matches: the cell or link the text is actually in.
  if (hit && textContains != null && textContains !== '') {
    for (let inner = _firstMatch(hit, test); inner; inner = _firstMatch(hit, test)) hit = inner;
  }
  return hit;
}

// The first element under `root`, in document order, that passes `test`.
function _firstMatch(root, test) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (test(node)) return node;
  }
  return null;
}

/**
 * Search a container's subtree for the first child element matching `conditions`.
 *
 * Supports {fallback:A|B|C} in condition string fields:
 *   Tries value A first; if no child matches, tries B, then C. An empty value
 *   (a Blank entry, `{fallback:A||C}`) matches a child whose field is empty.
 *   The first value that finds a match is returned along with which spec it came
 *   from (resolvedFallbacks), so the caller can persist it for sticky resolution.
 *
 * Returns { el: Element|null, resolvedFallbacks: { spec: resolvedValue } }.
 */
function findElementByCondition(root, conditions) {
  if (!root || !conditions) return { el: null, resolvedFallbacks: {} };

  const normalize = (s) => (s ?? '').toString().trim().toLowerCase();
  const resolvedFallbacks = {};

  // Detect the first condition field that contains a fallback spec.
  // CHILD_COND_KEYS in shared/child-cond.js (a classic script cannot import it).
  const FALLBACK_FIELDS = ['valueEquals', 'textContains', 'idContains', 'classContains', 'typeEquals'];
  let fbField = null, fbVals = null;
  for (const f of FALLBACK_FIELDS) {
    const vals = _parseFallbackSpec(conditions[f]);
    if (vals) { fbField = f; fbVals = vals; break; }
  }

  if (!fbField) {
    // No fallback — single-value search.
    const el = _findElementSingle(root, conditions, normalize);
    return { el, resolvedFallbacks };
  }

  // Fallback path: try each value in order, stop on first match.
  const originalSpec = conditions[fbField];
  for (const val of fbVals) {
    const resolved = { ...conditions, [fbField]: val };
    const el = _findElementSingle(root, resolved, normalize, val === '' ? fbField : null);
    if (el) {
      // Record which value succeeded. Not a Blank: stuck as '' it would reach the
      // next condition as "no check" rather than "field is empty", so a Blank
      // win is tried again from the top next time.
      if (val !== '') resolvedFallbacks[originalSpec] = val;
      return { el, resolvedFallbacks };
    }
  }
  return { el: null, resolvedFallbacks };
}

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    let resolved = false;
    let rafQueued = false;
    const observer = new MutationObserver(() => {
      if (resolved || rafQueued) return;
      rafQueued = true;
      nextFrame(() => {
        rafQueued = false;
        if (resolved) return;
        const foundEl = document.querySelector(selector);
        if (foundEl) { resolved = true; observer.disconnect(); clearTimeout(t); resolve(foundEl); }
      });
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    const t = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      observer.disconnect();
      reject(new Error(`Timeout waiting for ${selector}`));
    }, timeout);
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   RECORDING
───────────────────────────────────────────────────────────────────────────── */

// A click on a <label> makes the browser click its control too, in the same
// task. Only the label click — what the user clicked, and visible even when a
// styled checkbox hides its input — is recorded: playing both toggled the
// checkbox twice, back to where it started.
let _labelForwardTarget = null;

document.addEventListener('click', (event) => {
  if (!_isRecording || pickerMode) return;
  // What the page's own scripts dispatch is not something the user did: a widget
  // that clicks a hidden input on every real click played back as two clicks.
  if (!event.isTrusted) return;
  // The extension's own overlays (a prompt, a countdown, a highlight note) are
  // not part of the page being tested.
  if (_extIsOurChrome(event.target)) return;
  if (_labelForwardTarget && event.target === _labelForwardTarget) {
    _labelForwardTarget = null;
    return;
  }
  const label = event.target.closest?.('label');
  if (label?.control && !label.control.contains(event.target)) {
    _labelForwardTarget = label.control;
    // A disabled control is not clicked: forget it once this task is over.
    setTimeout(() => { _labelForwardTarget = null; }, 0);
  }

  // What was typed before this click comes before it. Not only the focused
  // field's: focus has moved to the clicked button by now, so typing a name and
  // clicking Submit within the debounce recorded the Submit first, and playback
  // sent the form empty.
  _flushPendingInputs();

  const selectors = getAllSelectors(event.target);
  if (!selectors) return;
  safeSend({ type: 'RECORDED_ACTION', action: { type: 'click', selector: selectors.css, selectors, frameId: _myFrameId } });
}, true);

// Inputs typed into but not recorded yet (the debounce below): element →
// { timer, selectors }, in the order they were last typed into. An entry leaves
// when it is recorded, so the map holds an element for 400 ms at most.
const _pendingInputs = new Map();
const INPUT_DEBOUNCE_MS = 400;

function _recordInput(el, selectors) {
  safeSend({
    type: 'RECORDED_ACTION',
    action: { type: 'input', selector: selectors.css, selectors, value: el.value, frameId: _myFrameId },
  });
}

function _flushPendingInputs() {
  for (const [el, { timer, selectors }] of _pendingInputs) {
    clearTimeout(timer);
    _recordInput(el, selectors);
  }
  _pendingInputs.clear();
}

document.addEventListener('input', (event) => {
  if (!_isRecording || pickerMode || !event.isTrusted) return;
  const el = event.target;
  // A file input's value cannot be typed back (setting it throws); choosing files
  // is the Upload File action's job. Text typed into an extension overlay (a
  // highlight note) is not the page's. A checkbox or radio fires input when it
  // toggles, but the click that toggled it is recorded already; an Input of its
  // value ("on") played back changes nothing.
  if (el.type === 'file' || el.type === 'checkbox' || el.type === 'radio' || _extIsOurChrome(el)) return;
  const selectors = getAllSelectors(el);
  if (!selectors) return;

  // 400 ms debounce: records the final value after typing pauses rather than
  // one action per keystroke.  This keeps the action list readable and reduces
  // the number of recorded actions for long inputs.
  clearTimeout(_pendingInputs.get(el)?.timer);
  _pendingInputs.delete(el); // set again below: last typed into, last recorded
  _pendingInputs.set(el, { selectors, timer: setTimeout(() => {
    _pendingInputs.delete(el);
    // Re-checked on fire: the user may have stopped recording during the 400 ms
    // window, and the pending value must not outlive the session.
    if (!_isRecording) return;
    _recordInput(el, selectors);
  }, INPUT_DEBOUNCE_MS) });
}, true);

/* ─────────────────────────────────────────────────────────────────────────────
   PLAYBACK
───────────────────────────────────────────────────────────────────────────── */

/* ── Read DOM ──────────────────────────────────────────────────────────────────
 * tests/readdom.test.mjs loads everything between the two marker comments into
 * a sandbox, so keep this block free of anything else from the file except
 * findElementWithFallback / findElementByCondition, which the test stubs.
 * ────────────────────────────────────────────────────────────────────────────── */
/* <readdom-core> */
function _rdCollapse(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Rendered text: innerText (visible only, no <script>/<style>), textContent where unavailable. */
function _rdInnerText(el) {
  return typeof el.innerText === 'string' ? el.innerText : (el.textContent ?? '');
}

/**
 * The value a Read DOM step stores.
 *   text     textContent, trimmed — the original behaviour, kept as is
 *   visible  what the user sees: innerText with whitespace collapsed; the chosen
 *            option's text for <select>, the typed value for input/textarea
 *   value    form value; selected options joined by ", " for <select multiple>;
 *            innerText for contenteditable; other elements try .value, then text
 *   attr     getAttribute(attrName), '' when absent
 */
function readElementValue(el, readFrom, attrName) {
  const tag = String(el.tagName || '').toUpperCase();
  const isField = tag === 'INPUT' || tag === 'TEXTAREA';

  if (readFrom === 'attr') return el.getAttribute(attrName) ?? '';

  if (readFrom === 'value') {
    if (tag === 'SELECT' && el.multiple) {
      return Array.from(el.selectedOptions || []).map(o => o.value).join(', ');
    }
    if (isField || tag === 'SELECT') return el.value ?? '';
    if (el.isContentEditable) return _rdInnerText(el).trim();
    const v = el.value;
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number' && tag !== 'LI') return String(v);
    const text = _rdInnerText(el).trim();
    if (text) return text;
    console.warn('[CONTENT] Read DOM: element has no value or text — stored an empty string', el);
    return '';
  }

  if (readFrom === 'visible') {
    if (tag === 'SELECT') {
      return Array.from(el.selectedOptions || []).map(o => _rdCollapse(o.text)).join(', ');
    }
    if (isField) return el.value ?? '';
    return _rdCollapse(_rdInnerText(el));
  }

  return el.textContent?.trim() ?? '';
}

/** Run one Read DOM action: { value } on success, { failed, error } otherwise. */
async function readDomAction(action) {
  const timeout = (action.timeout && action.timeout > 0) ? action.timeout : 5000;
  let sels = null;
  if (action.selectors && typeof action.selectors === 'object') sels = action.selectors;
  else if (action.selector) sels = { css: action.selector };
  const hasSel = !!sels && Object.values(sels).some(v => typeof v === 'string' && v.trim());
  // Actions saved before the form checked these could still lack them.
  if (!hasSel) return { failed: true, error: 'Read DOM: missing selector' };
  if (action.readFrom === 'attr' && !String(action.attrName || '').trim()) {
    return { failed: true, error: 'Read DOM: missing attribute name' };
  }

  const resolvedFallbacks = {};
  try {
    let el = await findElementWithFallback(sels, timeout, action.selectorType);
    if (!el) return { failed: true, error: 'Read DOM: element not found' };
    if (action.conditions) {
      const found = findElementByCondition(el, action.conditions);
      Object.assign(resolvedFallbacks, found.resolvedFallbacks);
      el = found.el;
      if (!el) return { failed: true, error: 'Read DOM: no child element matches the condition', resolvedFallbacks };
    }
    return { value: readElementValue(el, action.readFrom, action.attrName), resolvedFallbacks };
  } catch (e) {
    return { failed: true, error: e?.message || 'Read DOM: element not found', resolvedFallbacks };
  }
}
/* </readdom-core> */

/* ── Dropdown: choose item #i ─────────────────────────────────────────────────
 * A native <select> is set here (pickNativeOption). Any other dropdown is opened
 * by the worker first; pickDropdownItem then finds its items and clicks one.
 */
/* <dropdown-pick-core> */
// parsePickIndex / pickItemIndex: a copy of shared/dropdown-pick.js, which this
// classic script cannot import; tests/dropdown-pick.test.mjs keeps them the same.
function parsePickIndex(raw) {
  const s = String(raw ?? '').trim();
  if (/^random$/i.test(s)) return { random: true };
  if (/^-?\d+$/.test(s) && Number(s) !== 0) return { n: Number(s) };
  if (!s) return { error: 'no item number — 1 is the first item, -1 the last, or random' };
  return { error: `"${s}" is not an item number — use 1, 2, … (-1 = last) or random` };
}

function pickItemIndex(raw, count, eligible = () => true, rand = Math.random) {
  const p = parsePickIndex(raw);
  if (p.error) return p;
  if (p.random) {
    const pool = [];
    for (let k = 0; k < count; k++) if (eligible(k)) pool.push(k);
    if (!pool.length) return { error: `no item to choose at random (${count} found)` };
    return { index: pool[Math.floor(rand() * pool.length)] };
  }
  const index = p.n > 0 ? p.n - 1 : count + p.n;
  if (index < 0 || index >= count) return { error: `there is no item #${p.n} (${count} found)` };
  return { index };
}

/** Choose option `pick.index` of a native <select> and tell the page, as Input does. */
function pickNativeOption(select, pick) {
  const options = [...select.options];
  const r = pickItemIndex(pick?.index, options.length, (k) => !options[k].disabled && options[k].value !== '');
  if (r.error) return { failed: true, error: `Dropdown: ${r.error}` };
  const option = options[r.index];
  const text = String(option.text ?? '').trim();
  if (option.disabled) return { failed: true, error: `Dropdown: item #${r.index + 1} ("${text}") is disabled` };
  select.selectedIndex = r.index;
  select.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
  select.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  select.dispatchEvent(new Event('blur',   { bubbles: true }));
  select.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return { picked: { index: r.index + 1, text, count: options.length } };
}
/* </dropdown-pick-core> */

// The opened list may render a moment after the click; this long at most.
const DROPDOWN_ITEM_WAIT_MS = 5000;
const DROPDOWN_ITEM_POLL_MS = 100;
// Items of a custom dropdown when the action names none: ARIA options, else menu items.
const DROPDOWN_OPTION_SEL = '[role="option"]';
const DROPDOWN_MENUITEM_SEL = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

// checkVisibility also sees content-visibility (a closed <details>, for one).
function _isShown(el) {
  if (!el?.isConnected || !el.getClientRects().length) return false;
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
  const st = getComputedStyle(el);
  return st.display !== 'none' && st.visibility !== 'hidden';
}

function _itemDisabled(el) {
  return el.getAttribute('aria-disabled') === 'true'
    || el.hasAttribute('disabled')
    || el.matches('[data-disabled]:not([data-disabled="false"])');
}

/**
 * The shown items of an opened custom dropdown, in page order: `itemSelector`
 * when the action has one; else, when the trigger points to its list
 * (aria-controls / aria-owns, on the trigger, around it or inside it), the
 * options — or menu items — in that list only, even while it is still empty;
 * else every shown ARIA option, then every shown menu item, on the page.
 */
function _dropdownItems(trigger, itemSelector) {
  if (itemSelector) return [...document.querySelectorAll(itemSelector)].filter(_isShown);
  const owners = [
    trigger,
    trigger?.closest('[aria-controls], [aria-owns]'),
    trigger?.querySelector('[aria-controls], [aria-owns]'),
  ];
  const lists = [];
  for (const owner of owners) {
    if (!owner) continue;
    const ids = `${owner.getAttribute('aria-controls') || ''} ${owner.getAttribute('aria-owns') || ''}`
      .trim().split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const list = document.getElementById(id);
      if (list && !lists.includes(list)) lists.push(list);
    }
  }
  const scopes = lists.length ? lists : [document];
  const within = (sel) => scopes.flatMap((root) => [...root.querySelectorAll(sel)]).filter(_isShown);
  const options = within(DROPDOWN_OPTION_SEL);
  return options.length ? options : within(DROPDOWN_MENUITEM_SEL);
}

/** The press and click a person makes, so libraries that act on pointerdown or mousedown see it too. */
function _clickDropdownItem(el) {
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  const pointer = { ...opts, pointerType: 'mouse', isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointerdown', pointer));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', pointer));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
}

/** Custom dropdown, already opened: wait for item `pick.index`, then click it. `strict`: see _blockedReason. */
async function pickDropdownItem(action, strict = false) {
  const pick = action.pick || {};
  const parsed = parsePickIndex(pick.index);
  if (parsed.error) return { failed: true, error: `Dropdown: ${parsed.error}` };
  let trigger = null;
  if (!pick.itemSelector) {
    const sels = action.selectors && typeof action.selectors === 'object' ? action.selectors : { css: action.selector };
    trigger = await findElementWithFallback(sels, 500, action.selectorType).catch(() => null);
  }
  const eligible = (items) => (k) => !_itemDisabled(items[k]) && items[k].textContent.trim() !== '';
  const deadline = Date.now() + DROPDOWN_ITEM_WAIT_MS;
  let items, r;
  for (;;) {
    try {
      items = _dropdownItems(trigger, pick.itemSelector);
    } catch (e) {
      return { failed: true, error: `Dropdown: item selector "${pick.itemSelector}" — ${e.message}` };
    }
    r = pickItemIndex(pick.index, items.length, eligible(items));
    if (!r.error || Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, DROPDOWN_ITEM_POLL_MS));
  }
  if (r.error) {
    const where = pick.itemSelector
      ? `"${pick.itemSelector}"`
      : 'role=option / menuitem (set Items to the selector of the items)';
    return { failed: true, error: `Dropdown: ${r.error}; items looked for: ${where}` };
  }
  const item = items[r.index];
  const text = item.textContent.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (_itemDisabled(item)) return { failed: true, error: `Dropdown: item #${r.index + 1} ("${text}") is disabled` };
  if (strict) {
    item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const why = _blockedReason(item);
    if (why) return { failed: true, blocked: true, error: `Dropdown: item #${r.index + 1} ("${text}"): ${why}` };
  }
  _clickDropdownItem(item);
  return { picked: { index: r.index + 1, text, count: items.length } };
}

/* ── "Click through" off ──────────────────────────────────────────────────────
 * An action, or its scenario, can say it acts only on what a user could act on
 * (bg/playback/steps/click-through.js); the worker then sends `strict`. Without
 * it, playback acts on the element as it always has: events are dispatched to it
 * whatever it looks like, and a disabled one just ignores them.
 */

/** "button#save.primary": enough of an element to find it in DevTools. */
function _describeEl(el) {
  const classes = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 2) : [];
  return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + classes.map((c) => `.${c}`).join('');
}

/**
 * Why a user could not act on `el` as it is now, or null: it has no size, it is
 * disabled (or read-only, for a text field), or something else is on top of its
 * middle. A <label> of the element on top of it — a floating label — does not
 * count, nor do the extension's own overlays. `disabledOnly`: Upload File's file
 * input, which pages hide on purpose and style through a label or a button.
 */
function _blockedReason(el, { disabledOnly = false } = {}) {
  const disabled = el.matches(':disabled') || !!el.closest('[aria-disabled="true"]');
  if (disabledOnly) return disabled ? 'Element is disabled' : null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return 'Element is not visible';
  if (disabled) return 'Element is disabled';
  if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.readOnly) return 'Element is read-only';
  const root = el.getRootNode();
  const hit = (typeof root.elementFromPoint === 'function' ? root : document)
    .elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit || hit === el || el.contains(hit) || _extIsOurChrome(hit) || hit.closest('label')?.control === el) return null;
  return `Element is covered by ${_describeEl(hit)}`;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'PLAY_ACTION') return;

  (async () => {
    const action = msg.action;

    // Accumulates fallback resolutions from findElementByCondition calls in this
    // action.  Sent back in every success response so playback.js can persist
    // sticky values into resolvedVars for the rest of the run.
    const _rf = {};
    const _ok = (data = {}) => sendResponse({ ...data, resolvedFallbacks: _rf });

    /* ── dropdown, opened by the worker: choose its item ── */
    if (action.type === 'dropdown' && msg.pickStage === 'items') {
      const r = await pickDropdownItem(action, !!msg.strict);
      if (r.failed) sendResponse(r); else _ok(r);
      return;
    }

    /* ── readdom ── */
    if (action.type === 'readdom') {
      sendResponse(await readDomAction(action));
      return;
    }

    /* ── Resolve target element ── */
    const actionTimeout = (action.timeout && action.timeout > 0) ? action.timeout : 5000;
    let target;
    try {
      if (action.conditions && action.selector) {
        const parent = await findElementWithFallback(
          action.selectors && typeof action.selectors === 'object'
            ? action.selectors : { css: action.selector },
          actionTimeout, action.selectorType,
        );
        if (parent) {
          const { el, resolvedFallbacks } = findElementByCondition(parent, action.conditions);
          target = el;
          Object.assign(_rf, resolvedFallbacks);
        }
      } else if (action.selectors && typeof action.selectors === 'object') {
        target = await findElementWithFallback(action.selectors, actionTimeout, action.selectorType);
      } else if (action.selector) {
        target = await findElementWithFallback({ css: action.selector }, actionTimeout);
      } else {
        target = null;
      }
    } catch (e) {
      console.error('[CONTENT] Element find error:', e);
      sendResponse({ failed: true, error: e.message });
      return;
    }

    if (!target) { sendResponse({ failed: true }); return; }

    // scrollIntoView first, then re-query on the next rAF.
    // Virtualized lists (React-Window, AG-Grid) unmount and remount rows during
    // scroll — the original `target` reference may be stale after scrolling.
    target.scrollIntoView({ behavior: 'auto', block: 'center' });
    await new Promise(nextFrame);
    if (action.selectors && typeof action.selectors === 'object') {
      try {
        const requeried = await findElementWithFallback(action.selectors, 500, action.selectorType);
        if (requeried) {
          if (action.conditions) {
            const { el: rechild, resolvedFallbacks: rf2 } = findElementByCondition(requeried, action.conditions);
            if (rechild) { target = rechild; Object.assign(_rf, rf2); }
          } else {
            target = requeried;
          }
        }
      } catch (_) { /* keep original target */ }
    }
    if (msg.strict) {
      const why = _blockedReason(target);
      if (why) { sendResponse({ failed: true, blocked: true, error: why }); return; }
    }
    target.focus();

    /* ── HOVER ── */
    if (action.type === 'hover') {
      const rect = target.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top  + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
      target.dispatchEvent(new MouseEvent('mouseover',  opts));
      target.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
      target.dispatchEvent(new MouseEvent('mousemove',  opts));
      _ok();
      return;
    }

    /* ── DRAG & DROP ── */
    if (action.type === 'dragdrop') {
      let dropEl = null;
      if (action.targetSelector) {
        const ts = (action.targetSelectors && typeof action.targetSelectors === 'object')
          ? action.targetSelectors : { css: action.targetSelector };
        dropEl = await findElementWithFallback(ts, actionTimeout, action.targetSelectorType).catch(() => null);
      }
      if (!dropEl) { sendResponse({ failed: true }); return; }
      if (msg.strict) {
        const why = _blockedReason(dropEl);
        if (why) { sendResponse({ failed: true, blocked: true, error: `Drop target: ${why}` }); return; }
      }
      const srcRect = target.getBoundingClientRect();
      const dstRect = dropEl.getBoundingClientRect();
      const sx = srcRect.left + srcRect.width  / 2, sy = srcRect.top  + srcRect.height / 2;
      const dx = dstRect.left + dstRect.width  / 2, dy = dstRect.top  + dstRect.height / 2;
      const dt = new DataTransfer();
      const fireM = (el, t, x, y, extra = {}) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...extra }));
      const fireD = (el, t, x, y) => el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
      fireM(target, 'mousedown', sx, sy, { button: 0 });
      fireD(target, 'dragstart', sx, sy);
      fireD(dropEl, 'dragenter', dx, dy);
      fireD(dropEl, 'dragover',  dx, dy);
      fireD(dropEl, 'drop',      dx, dy);
      fireD(target, 'dragend',   dx, dy);
      fireM(target, 'mouseup',   dx, dy);
      _ok();
      return;
    }

    /* ── CLICK ── */
    if (action.type === 'click') {
      // Fire the full mousedown → mouseup → click sequence with realistic
      // clientX/Y coordinates.  Some frameworks (jQuery UI, custom widgets)
      // require mousedown/mouseup to fire their internal handlers; target.click()
      // alone only fires "click" and misses those.
      const rect = target.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top  + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
      target.dispatchEvent(new MouseEvent('mousedown', opts));
      target.dispatchEvent(new MouseEvent('mouseup',   opts));
      target.click(); // fires 'click' event + follows links/submits forms
      _ok();
      return;
    }

    /* ── DROPDOWN ── */
    if (action.type === 'dropdown') {
      // Choose item #: a native <select> is set right here; any other dropdown
      // is opened by the worker, which then asks for the item (pickStage 'items').
      if (msg.pickStage === 'select') {
        if (target.tagName !== 'SELECT') { _ok({ needsOpen: true }); return; }
        const r = pickNativeOption(target, action.pick);
        if (r.failed) sendResponse(r); else _ok(r);
        return;
      }
      // Fallback opener, when the worker cannot click through CDP.
      target.click();
      _ok();
      return;
    }

    /* ── INPUT / SELECT ── */
    if (action.type === 'input') {
      if (target.isContentEditable) {
        // Rich-text editors (Quill, Draft.js, Tiptap) manage state via mutation
        // observers on contenteditable.  Direct .textContent assignment bypasses
        // those observers; document.execCommand fires the correct mutation events.
        target.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, action.value ?? '');
        target.dispatchEvent(new Event('input',  { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        _ok();
        return;
      } else if (target.tagName === 'SELECT') {
        // The option with that value, else the one showing that text. None is a
        // failure, and the selection stays as it was: setting .value to a missing
        // option emptied the select, and the action still passed.
        const want = String(action.value ?? '');
        const options = [...target.options];
        const option = options.find(o => o.value === want) || options.find(o => o.text === want);
        if (!option) {
          sendResponse({ failed: true, error: `The dropdown has no option "${want}"` });
          return;
        }
        target.value = option.value;
        target.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
        target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        target.dispatchEvent(new Event('blur',   { bubbles: true }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } else {
        // Walk the prototype chain to find the native HTMLInputElement value setter.
        // React/Vue override .value to track their internal fiber state — direct
        // property assignment (el.value = x) bypasses that override and breaks
        // controlled components.  The native setter triggers the synthetic event
        // system (SyntheticInputEvent) correctly.
        let nativeSetter = null;
        let proto = Object.getPrototypeOf(target);
        while (proto && proto !== Object.prototype) {
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc?.set) { nativeSetter = desc.set; break; }
          proto = Object.getPrototypeOf(proto);
        }
        if (nativeSetter) {
          nativeSetter.call(target, action.value ?? '');
        } else {
          target.value = action.value ?? '';
        }
        target.dispatchEvent(new Event('input',  { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        target.dispatchEvent(new Event('blur',   { bubbles: true }));
      }

      if (action.waitForElement) {
        (async () => {
          try { await waitForElement(action.waitForElement, 5000); }
          catch (_) { /* element wait timeout — continue */ }
          _ok();
        })();
        return;
      }
      _ok();
      return;
    }

    _ok();
  })().catch((e) => {
    // Answer at once: unanswered, the worker waits out its reply timeout and then
    // reports the page as unreachable instead of what went wrong.
    sendResponse({ failed: true, error: e?.message || String(e) });
  });

  return true; // async
});

/* ─────────────────────────────────────────────────────────────────────────────
   SHARED IN-PAGE OVERLAY CHROME

   Every overlay this content script injects — picker bar, screenshot countdown,
   segment capture bar, highlight tooltip, note bubble — is one `_extOverlay()`
   call built from the tokens below. Shape, palette, spacing, theme switching,
   the ESC affordance and teardown all live in the template; a call site says
   only what its overlay says and what its buttons do. Add an overlay by adding
   a call, not a stylesheet.

   Each surface is built with `all:initial` so the host page's stylesheet cannot
   reach in and restyle it. That reset also strips the browser's own button
   rendering, so `_extButton` restates every visual property explicitly.
───────────────────────────────────────────────────────────────────────────── */

const _EXT_FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
const _EXT_ACCENT = '#4f46e5';  // brand indigo — picker affordances
const _EXT_DANGER = '#ef4444';  // destructive / stop actions

// Geometry shared by every overlay, so two surfaces can never drift apart on
// padding, spacing or shadow depth.
const _EXT_PAD    = '8px 16px';
const _EXT_GAP    = '12px';
const _EXT_RADIUS = '10px';
const _EXT_BAR_SHADOW = '0 2px 8px rgba(0,0,0,0.35)';
// Popovers pack more into less space than a bar does, so they get their own
// (single) pair of density tokens rather than one bespoke value per widget.
const _EXT_PANEL_PAD = '8px 10px';
const _EXT_PANEL_GAP = '6px';

const _EXT_THEMES = {
  dark: {
    bg: '#1e1e2e', border: 'rgba(255,255,255,0.22)', text: '#cdd6f4',
    sub: 'rgba(205,214,244,0.55)', taBg: '#11111b',
    btnBorder: 'rgba(255,255,255,0.18)', btnBg: 'rgba(255,255,255,0.12)',
    shadow: '0 0 0 1px rgba(255,255,255,0.22), 0 4px 24px rgba(0,0,0,0.55)',
  },
  light: {
    bg: '#ffffff', border: 'rgba(0,0,0,0.14)', text: '#1e1e2e',
    sub: 'rgba(60,60,70,0.6)', taBg: '#f4f4f7',
    btnBorder: 'rgba(0,0,0,0.18)', btnBg: 'rgba(0,0,0,0.06)',
    shadow: '0 0 0 1px rgba(0,0,0,0.10), 0 4px 24px rgba(0,0,0,0.18)',
  },
};

let _extTheme = 'dark';

// Overlays that should restyle themselves when the popup theme changes. Entries
// are plain { apply(tokens) } objects; they unregister on teardown.
const _extThemed = new Set();

function _extTokens() { return _EXT_THEMES[_extTheme] || _EXT_THEMES.dark; }

function _extRegisterThemed(apply) {
  const entry = { apply };
  _extThemed.add(entry);
  apply(_extTokens());
  return () => _extThemed.delete(entry);
}

function _extApplyTheme() {
  const t = _extTokens();
  _extThemed.forEach((e) => { try { e.apply(t); } catch (_) { /* one broken surface must not stop the others repainting */ } });
}

// Load the popup's theme once, up front. Owned here rather than by the
// highlight bootstrap so the capture overlays are themed even when the
// highlight engine bails out early (e.g. invalidated extension context).
// 'popupTheme' is THEME_KEY in shared/storage-keys.js; a classic script cannot import it.
try {
  chrome.storage.local.get(['popupTheme'], (res) => {
    try {
      void chrome.runtime.lastError;
      _extTheme = res?.popupTheme === 'dark' ? 'dark' : 'light';
      _extApplyTheme();
    } catch (_) { /* context invalidated mid-callback: keep the current theme */ }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.popupTheme) {
      _extTheme = changes.popupTheme.newValue === 'dark' ? 'dark' : 'light';
      _extApplyTheme();
    }
  });
} catch (_) { /* extension context invalidated: keep the default theme */ }

// Base declarations for a floating overlay panel. `extra` is appended last so
// callers can override any of the defaults (e.g. a non-neutral background).
function _extSurface(extra = []) {
  const t = _extTokens();
  return [
    'all:initial', 'box-sizing:border-box', 'position:fixed',
    `font-family:${_EXT_FONT}`, 'font-size:13px', 'line-height:1.4',
    `color:${t.text}`, `background:${t.bg}`,
    `box-shadow:${t.shadow}`,
    ...extra,
  ].join(';');
}

function _extButton(label, { bg, color, border, bold = false } = {}) {
  const t = _extTokens();
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = [
    'all:initial', 'box-sizing:border-box', 'cursor:pointer',
    `font-family:${_EXT_FONT}`, 'font-size:12px',
    `font-weight:${bold ? '600' : '400'}`, 'line-height:1.4',
    'padding:5px 10px', 'border-radius:6px', 'text-align:center',
    'user-select:none', 'flex:0 0 auto',
    `background:${bg || t.btnBg}`, `color:${color || t.text}`,
    `border:1px solid ${border || t.btnBorder}`,
  ].join(';');
  return b;
}

// Inline text span inside an overlay — `all:initial` again, since the host page
// may well have rules on plain spans.
function _extSpan(text, extra = []) {
  const s = document.createElement('span');
  if (text != null) s.textContent = text;
  s.style.cssText = [
    'all:initial', 'font-family:inherit', 'font-size:inherit',
    'line-height:inherit', 'color:inherit', ...extra,
  ].join(';');
  return s;
}

// Tag an injected node as extension chrome. The capture paths hide everything
// carrying this attribute for the duration of a screenshot, so no overlay can
// be baked into the image. Every overlay must be marked — the full-page path
// deliberately keeps fixed elements visible and cannot tell ours from the
// page's own header.
const _EXT_OVERLAY_ATTR = 'data-ext-overlay';
function _extMarkOverlay(el) { el.setAttribute(_EXT_OVERLAY_ATTR, '1'); return el; }

/* ── THE OVERLAY TEMPLATE ─────────────────────────────────────────────────────

   Every overlay is one `_extOverlay()` call. The template owns the surface, the
   variant's footprint, theme registration and repaint, the ESC affordance and
   teardown. A call site declares only what its overlay *says* and what its
   buttons *do* — no call site sets a colour, a padding or a shadow.

   Variants differ in footprint only; surface, type and spacing are identical:
     bar   — full-width, pinned to the top edge. Announces a mode the whole page
             is in (element picker, segment capture).
     pill  — floating top-right. Transient status that must not cover the page
             content it is about to capture (screenshot countdown).
     panel — free-positioned, caller drives top/left and display. Content-owning
             surfaces (highlight tooltip, note bubble).

   A bar with `dodge` lets the pointer through to the page (only its buttons
   catch it) and moves to the opposite edge when the pointer stays under it, so
   it never hides page content the user has to reach (element picker).

   Content slots, in render order:
     lead → label → detail → trail → hint → cancel button → extra buttons → content
─────────────────────────────────────────────────────────────────────────── */

const _EXT_VARIANTS = {
  bar: [
    'top:0', 'left:0', 'right:0',
    'display:flex', 'align-items:center',
    `gap:${_EXT_GAP}`, `padding:${_EXT_PAD}`,
    'border-bottom-width:1px', 'border-bottom-style:solid',
    // Bars sit flush against the viewport edge, so they carry a directional
    // drop shadow instead of the surface token's all-round ring.
    `box-shadow:${_EXT_BAR_SHADOW}`,
  ],
  pill: [
    'top:12px', 'right:12px',
    'display:flex', 'align-items:center',
    `gap:${_EXT_GAP}`, `padding:${_EXT_PAD}`, `border-radius:${_EXT_RADIUS}`,
    'border-width:1px', 'border-style:solid',
  ],
  panel: [
    'display:none', 'flex-direction:column',
    `gap:${_EXT_PANEL_GAP}`, `padding:${_EXT_PANEL_PAD}`, `border-radius:${_EXT_RADIUS}`,
    'border-width:1px', 'border-style:solid',
  ],
};

// A dodging bar's edge and the drop shadow that points away from that edge.
const _EXT_BAR_EDGES = {
  top:    { top: '0',    bottom: 'auto', border: 'borderBottom', shadow: _EXT_BAR_SHADOW },
  bottom: { top: 'auto', bottom: '0',    border: 'borderTop',    shadow: '0 -2px 8px rgba(0,0,0,0.35)' },
};
// How long the pointer must stay under a dodging bar before it moves. Long
// enough to cross the bar's padding on the way to its Cancel button, short
// enough to feel like the bar simply gets out of the way.
const _EXT_DODGE_DELAY_MS = 200;

// Moves a `dodge` bar between the top and bottom edges. The pointer is "under"
// the bar when it is inside the bar's strip but not on one of its buttons: the
// surface lets events through, so the target is then a page element. Resting
// there moves the bar to the other edge; reaching a button or leaving the strip
// first keeps it where it is.
function _extDodger(el) {
  // `all:initial` puts pointer-events back to auto on every text span, so each
  // one is switched off along with the surface. Buttons keep catching clicks.
  [el, ...el.querySelectorAll('span')].forEach((n) => { n.style.pointerEvents = 'none'; });
  let edge = 'top';
  let timer = null;
  const dock = (to) => {
    const from = _EXT_BAR_EDGES[edge];
    const next = _EXT_BAR_EDGES[to];
    el.style.top    = next.top;
    el.style.bottom = next.bottom;
    el.style[from.border + 'Width'] = '0';
    el.style[next.border + 'Width'] = '1px';
    el.style[next.border + 'Style'] = 'solid';
    el.style.boxShadow = next.shadow;
    edge = to;
  };
  const onMove = (e) => {
    const r = el.getBoundingClientRect();
    const under = e.clientY >= r.top && e.clientY < r.bottom && !el.contains(e.target);
    if (!under) { clearTimeout(timer); timer = null; return; }
    if (timer != null) return;
    timer = setTimeout(() => {
      timer = null;
      dock(edge === 'top' ? 'bottom' : 'top');
    }, _EXT_DODGE_DELAY_MS);
  };
  return {
    start() { document.addEventListener('mousemove', onMove, true); },
    stop() {
      document.removeEventListener('mousemove', onMove, true);
      clearTimeout(timer);
      timer = null;
    },
  };
}

// Topmost-first ESC dismissal. Every overlay that declares `onCancel` registers
// here, so one key handler serves all of them and the most recently opened wins
// — no overlay hand-rolls its own Escape branch.
const _extEscStack = [];

function _extDismissTop() {
  const top = _extEscStack[_extEscStack.length - 1];
  if (!top) return false;
  top.cancel();
  return true;
}

function _extOverlay({
  id,
  variant  = 'bar',
  lead     = null,           // arbitrary node rendered before the text
  label    = null,
  detail   = null,           // secondary text that takes the free space
  trail    = null,           // arbitrary node rendered after the text (countdown digit)
  hint     = 'ESC to cancel',
  onCancel = null,           // adds the ✕ affordance and binds ESC
  compactCancel = false,     // icon-only ✕, for footprints too narrow for a label
  buttons  = [],             // [{ key, label, tone:'danger', onClick }]
  content  = [],             // panel children
  extra    = [],             // footprint-level overrides (position, animation)
  dodge    = false,          // bar only: see the template notes above
} = {}) {
  const el = _extMarkOverlay(document.createElement('div'));
  if (id) el.id = id;
  el.style.cssText = _extSurface([
    'z-index:2147483647',
    ...(_EXT_VARIANTS[variant] || _EXT_VARIANTS.bar),
    ...extra,
  ]);

  // A label sharing the row with `detail` sizes to its text; alone it takes the
  // free space so the hint and buttons stay pinned to the right.
  const labelEl  = label  != null ? _extSpan(label,  [detail != null ? 'flex:0 0 auto' : 'flex:1 1 auto']) : null;
  const detailEl = detail != null ? _extSpan(detail, ['flex:1 1 auto']) : null;
  const hintEl   = hint   ? _extSpan(hint, ['font-size:12px', 'flex:0 0 auto', 'white-space:nowrap']) : null;

  // Buttons the template repaints from the theme. Danger buttons keep their
  // fixed palette in both themes and are deliberately left out.
  const themedBtns = [];
  const btns = {};

  if (onCancel) {
    const b = _extButton(compactCancel ? '✕' : '✕ Cancel');
    b.title = 'Cancel (ESC)';
    if (compactCancel) b.style.padding = '4px 8px';
    b.addEventListener('click', () => handle.cancel());
    themedBtns.push(b);
    btns.cancel = b;
  }

  buttons.forEach((spec) => {
    const danger = spec.tone === 'danger';
    const b = _extButton(spec.label, danger
      ? { bg: _EXT_DANGER, color: '#ffffff', border: _EXT_DANGER, bold: true }
      : {});
    if (spec.onClick) b.addEventListener('click', spec.onClick);
    if (!danger) themedBtns.push(b);
    btns[spec.key || spec.label] = b;
  });

  // Repaint touches only the themed properties — never the whole cssText — so a
  // theme change can't wipe a panel's position or a hidden overlay's display.
  const unregisterTheme = _extRegisterThemed((t) => {
    el.style.background  = t.bg;
    el.style.color       = t.text;
    el.style.borderColor = t.border;
    if (variant !== 'bar') el.style.boxShadow = t.shadow;
    if (hintEl) hintEl.style.color = t.sub;
    themedBtns.forEach((b) => {
      b.style.background  = t.btnBg;
      b.style.color       = t.text;
      b.style.borderColor = t.btnBorder;
    });
  });

  [lead, labelEl, detailEl, trail, hintEl, btns.cancel,
   ...buttons.map((s) => btns[s.key || s.label]), ...content]
    .forEach((node) => { if (node) el.appendChild(node); });

  const dodger = dodge && variant === 'bar' ? _extDodger(el) : null;

  const handle = {
    el,
    buttons: btns,
    setLabel(text)  { if (labelEl)  labelEl.textContent  = text; },
    setDetail(text) { if (detailEl) detailEl.textContent = text; },
    mount(parent = document.documentElement) { parent.appendChild(el); dodger?.start(); return handle; },
    // Idempotent: overlays tear down from several entry points (button, ESC,
    // timer expiry, a second capture starting) and any of them may run twice.
    destroy() {
      const i = _extEscStack.indexOf(handle);
      if (i !== -1) _extEscStack.splice(i, 1);
      unregisterTheme();
      dodger?.stop();
      el.remove();
    },
    cancel() { handle.destroy(); onCancel?.(); },
  };

  if (onCancel) _extEscStack.push(handle);
  return handle;
}

/* ─────────────────────────────────────────────────────────────────────────────
   ELEMENT PICKER
───────────────────────────────────────────────────────────────────────────── */

let _pickerBar = null;

function showPickerBar() {
  if (_pickerBar) return;
  _pickerBar = _extOverlay({
    id: '__picker_bar',
    variant: 'bar',
    // Headers and nav sit right under a top bar; the user must still reach them.
    dodge: true,
    label: '🎯 Click an element to select it',
    onCancel: () => {
      pickerMode = false;
      clearPickerUI();
      safeSend({ type: 'STOP_PICK_MODE' });
    },
  }).mount();
}

function hidePickerBar() {
  _pickerBar?.destroy();
  _pickerBar = null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'START_PICK_MODE') {
    pickerMode = true;
    document.body.style.cursor = 'crosshair';
    showPickerBar();
  }
  if (msg.type === 'STOP_PICK_MODE') {
    pickerMode = false;
    clearPickerUI();
  }
});

let _pickerTarget = null;

function _updatePickerOverlay(el) {
  _pickerTarget = el;
  let overlay = document.getElementById('__picker_overlay');
  if (!overlay) {
    overlay = _extMarkOverlay(document.createElement('div'));
    overlay.id = '__picker_overlay';
    overlay.style.cssText = [
      'all:initial', 'position:fixed', 'pointer-events:none',
      'z-index:2147483646', 'box-sizing:border-box', 'display:block',
      `border:2px solid ${_EXT_ACCENT}`, 'background:rgba(79,70,229,0.08)',
      'transition:none',
    ].join(';');
    document.documentElement.appendChild(overlay);
  }
  const r = el.getBoundingClientRect();
  overlay.style.left   = r.left   + 'px';
  overlay.style.top    = r.top    + 'px';
  overlay.style.width  = r.width  + 'px';
  overlay.style.height = r.height + 'px';
  overlay.style.display = '';

  // Only the label changes on hover — the hint and cancel button stay put, so
  // the bar never reflows and the way out is always in the same place.
  if (_pickerBar) {
    const tag = el.tagName.toLowerCase();
    const id  = el.id   ? `#${el.id}`   : '';
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/)[0] : '';
    _pickerBar.setLabel(`🎯 ${tag}${id || cls} — click to select`);
  }
}

function _removePickerOverlay() {
  _pickerTarget = null;
  document.getElementById('__picker_overlay')?.remove();
}

// Our own chrome is not part of the page: the picker must not outline it, and a
// click on the bar's Cancel button is a cancel, not a pick. The marker every
// overlay carries for the capture paths identifies it here too.
function _extIsOurChrome(node) {
  return !!(node && node.closest && node.closest(`[${_EXT_OVERLAY_ATTR}]`));
}

document.addEventListener('mouseover', (event) => {
  if (!pickerMode || _extIsOurChrome(event.target)) return;
  _updatePickerOverlay(event.target);
}, true);

document.addEventListener('click', (event) => {
  if (!pickerMode) return;
  // Let the click through untouched so the button's own handler runs.
  if (_extIsOurChrome(event.target)) return;
  event.preventDefault();
  event.stopImmediatePropagation();

  const el = _pickerTarget || event.target;
  const selectors = getAllSelectors(el);
  if (!selectors) return;

  const _cr = el.getBoundingClientRect();
  const pickedRect = {
    x:      Math.round(_cr.left + window.scrollX),
    y:      Math.round(_cr.top  + window.scrollY),
    width:  Math.round(_cr.width),
    height: Math.round(_cr.height),
  };

  try { chrome.storage.local.set({ lastPickedSelector: selectors.css, lastPickedSelectors: selectors, lastPickedFrameId: _myFrameId }); } catch (_) { /* context invalidated: ELEMENT_PICKED below still carries the selector */ }
  safeSend({ type: 'ELEMENT_PICKED', selector: selectors.css, selectors, rect: pickedRect, frameId: _myFrameId });
  pickerMode = false;
  clearPickerUI();
}, true);

function clearPickerUI() {
  document.body.style.cursor = 'auto';
  hidePickerBar();
  _removePickerOverlay();
}

/* ─────────────────────────────────────────────────────────────────────────────
   FULL PAGE SCREENSHOT HELPER
───────────────────────────────────────────────────────────────────────────── */

// The CDP steps — Upload File, opening a Dropdown, the element screenshot's
// second measurement — run in the page's own world, where this script's finder
// cannot be called. They used to guess one CSS selector themselves, and an XPath
// or a Name typed in the form found nothing there, or another element. The
// element is found here instead, the way an action finds it, and given a
// one-off attribute they select it by (MARK_ELEMENT, GET_ELEMENT_RECT);
// UNMARK_ELEMENT takes it off again.
const _TARGET_ATTR = 'data-pqa-target';
let _markedTarget = null;

function _unmarkTarget() {
  _markedTarget?.removeAttribute(_TARGET_ATTR);
  _markedTarget = null;
}

/** Tag `el` for CDP: the CSS selector that finds it. */
function _markTarget(el) {
  _unmarkTarget();
  const token = Math.random().toString(36).slice(2, 10);
  el.setAttribute(_TARGET_ATTR, token);
  _markedTarget = el;
  return `[${_TARGET_ATTR}="${token}"]`;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'MARK_ELEMENT') {
    const timeout = msg.timeout > 0 ? msg.timeout : 5000;
    (async () => {
      const el = await findElementWithFallback(_withPlain(msg.selectors, msg.selector), timeout, msg.selectorType);
      // "Click through" off: a blocked element is reported, not tagged (PLAYBACK).
      if (msg.strict) {
        if (!msg.disabledOnly) {
          el.scrollIntoView({ behavior: 'auto', block: 'center' });
          await new Promise(nextFrame);
        }
        const why = _blockedReason(el, { disabledOnly: !!msg.disabledOnly });
        if (why) return { blocked: why };
      }
      return { css: _markTarget(el) };
    })().then(sendResponse, (e) => sendResponse({ error: e?.message || 'Element not found' }));
    return true;
  }

  if (msg.type === 'UNMARK_ELEMENT') {
    _unmarkTarget();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'GET_PAGE_DIMENSIONS') {
    const body = document.body;
    const html = document.documentElement;
    const fullHeight = Math.max(body.scrollHeight, body.offsetHeight, html.clientHeight, html.scrollHeight, html.offsetHeight);
    const fullWidth  = Math.max(body.scrollWidth,  body.offsetWidth,  html.clientWidth,  html.scrollWidth,  html.offsetWidth);
    sendResponse({
      fullWidth, fullHeight,
      viewportWidth:   window.innerWidth,
      viewportHeight:  window.innerHeight,
      scrollX:         window.scrollX,
      scrollY:         window.scrollY,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
    return true;
  }

  if (msg.type === 'GET_ELEMENT_RECT') {
    try {
      const el = locateNow(msg.selectors, msg.selector, msg.selectorType);
      if (!el) { sendResponse({ error: 'Element not found' }); return true; }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) { sendResponse({ error: 'Element has no size' }); return true; }
      sendResponse({
        x: rect.left + window.scrollX,
        y: rect.top  + window.scrollY,
        width:  rect.width,
        height: rect.height,
        devicePixelRatio: window.devicePixelRatio || 1,
        // For the measurement after the scroll, through CDP (bg/screenshot/element.js).
        css: _markTarget(el),
      });
    } catch (e) {
      sendResponse({ error: e.message });
    }
    return true;
  }

  /* ── CHECK_CONDITION ── */
  if (msg.type === 'CHECK_CONDITION') {
    const { conditionType, selector, selectors: selectorMap, expectedValue } = msg;

    // Conditions evaluate the DOM at the current moment, no waiting, and find
    // the element the way an action does — the chosen selector type first.
    const getEl = () => locateNow(selectorMap, selector, msg.selectorType);

    let result = false;
    try {
      switch (conditionType) {
        case 'elementExists': {
          result = !!getEl();
          break;
        }
        case 'elementNotExists': {
          result = !getEl();
          break;
        }
        case 'elementVisible': {
          const el = getEl();
          if (el) {
            const style = getComputedStyle(el);
            const rect  = el.getBoundingClientRect();
            result = style.display !== 'none' && style.visibility !== 'hidden' &&
                     style.opacity !== '0' && rect.width > 0 && rect.height > 0;
          }
          break;
        }
        case 'elementHidden': {
          const el = getEl();
          if (!el) {
            result = true;
          } else {
            const style = getComputedStyle(el);
            const rect  = el.getBoundingClientRect();
            result = style.display === 'none' || style.visibility === 'hidden' ||
                     style.opacity === '0' || rect.width === 0 || rect.height === 0;
          }
          break;
        }
        case 'textContains': {
          const el = getEl();
          if (el) result = el.textContent.includes(expectedValue);
          break;
        }
        case 'textEquals': {
          const el = getEl();
          if (el) result = el.textContent.trim() === (expectedValue || '').trim();
          break;
        }
        case 'valueEquals': {
          const el = getEl();
          if (el && 'value' in el) result = el.value === expectedValue;
          break;
        }
        case 'valueContains': {
          const el = getEl();
          if (el && 'value' in el) result = el.value.includes(expectedValue);
          break;
        }
        case 'urlContains': result = window.location.href.includes(expectedValue); break;
        case 'urlEquals':   result = window.location.href === expectedValue; break;
        case 'hasClass': {
          const el = getEl();
          if (el) result = el.classList.contains(expectedValue);
          break;
        }
        case 'hasAttribute': {
          const el = getEl();
          if (el) {
            if ((expectedValue || '').includes('=')) {
              const eqIdx    = expectedValue.indexOf('=');
              const attrName = expectedValue.slice(0, eqIdx);
              const attrVal  = expectedValue.slice(eqIdx + 1);
              result = el.hasAttribute(attrName) && el.getAttribute(attrName) === attrVal;
            } else {
              result = el.hasAttribute(expectedValue);
            }
          }
          break;
        }
        default:
          // A type this version does not know (a newer export, an edited import)
          // is not a check that passed: the run reports it.
          sendResponse({ result: false, error: `Unknown condition type "${conditionType}"` });
          return;
      }
    } catch (e) {
      // Reported, not passed: the run asks retry / skip / stop.
      sendResponse({ result: false, error: e?.message || String(e) });
      return;
    }
    sendResponse({ result });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   HOTKEYS
───────────────────────────────────────────────────────────────────────────── */

let activeHotkeys = {
  startRecord:         'Alt+R',
  stopRecord:          'Alt+S',
  screenshot:          'Alt+P',
  screenshotFull:      'Alt+Shift+F',
  screenshotScrollV:   'Alt+V',
  screenshotScrollH:   'Alt+H',
  segV:                'Alt+Shift+V',
  segH:                'Alt+Shift+H',
  segStop:             'Alt+X',
  screenshotElement:   'Alt+E',
};

try {
  chrome.storage.sync.get(['hotkeys'], (res) => {
    try { void chrome.runtime.lastError; if (res?.hotkeys) activeHotkeys = { ...activeHotkeys, ...res.hotkeys }; } catch (_) { /* context invalidated mid-callback: keep the default hotkeys */ }
  });
} catch (_) { /* extension context invalidated: keep the default hotkeys */ }
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.hotkeys) {
      activeHotkeys = { ...activeHotkeys, ...changes.hotkeys.newValue };
    }
  });
} catch (_) { /* extension context invalidated: no live hotkey updates */ }

/**
 * The combo as the hotkey settings write it. `byCode` names a letter or digit
 * by its physical key: Option on macOS (and AltGr) types a symbol for Alt+R,
 * "®", which would never match "Alt+R" (popup/settings.js stores that form).
 */
function getKeyCombo(e, byCode = false) {
  const parts = [];
  if (e.ctrlKey)  parts.push('Ctrl');
  if (e.altKey)   parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey)  parts.push('Meta');
  const key = e.key;
  if (!key) return parts.join('+');
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
    const phys = byCode && /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code || '');
    if (phys) parts.push(phys[1] || phys[2]);
    else parts.push(key.length === 1 ? key.toUpperCase() : key);
  }
  return parts.join('+');
}

// _tabActivated (STATE) follows a change to the activated tabs.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.activatedTabs) return;
    chrome.runtime.sendMessage({ type: 'IS_TAB_ACTIVATED' }, (res) => {
      if (chrome.runtime.lastError) return;
      _tabActivated = !!res?.activated;
    });
  });
} catch (_) { /* extension context invalidated: the record hotkeys stay as they were */ }

/* ─────────────────────────────────────────────────────────────────────────────
   VISIBLE SCREENSHOT COUNTDOWN
───────────────────────────────────────────────────────────────────────────── */

let _countdownTimer   = null;
// Module-scoped because the countdown is torn down from three entry points
// (timer expiry, cancel button, ESC) — all of which go through the overlay
// handle, or the theme registry would leak a closure over a removed node.
let _countdownOverlay = null;

// True while the background is running a (cancellable) full-page / scroll capture.
// Set via FULL_CAPTURE_STATE messages so the ESC key can abort a long capture on a
// super-tall page. A safety timer clears it in case the "off" message never arrives,
// so ESC never stays hijacked from the page.
let _fullCaptureActive = false;
let _fullCaptureSafetyTimer = null;
// Longer than any capture takes; only a lost "off" message ever reaches it.
const FULL_CAPTURE_SAFETY_MS = 120_000;

function _setFullCaptureActive(active) {
  _fullCaptureActive = active;
  clearTimeout(_fullCaptureSafetyTimer);
  if (active) {
    _fullCaptureSafetyTimer = setTimeout(() => { _fullCaptureActive = false; }, FULL_CAPTURE_SAFETY_MS);
  }
}

// `fromHotkey` is carried all the way to the background so the capture result
// can be reported as a notification. A hotkey capture happens with the popup
// closed, so the SCREENSHOT_RESULT toast has nobody to show it to.
// One count of the countdown.
const COUNTDOWN_TICK_MS = 1000;

function _startVisibleCountdown(seconds, crop, fromHotkey = false) {
  if (_countdownOverlay) return;
  let remaining = seconds;

  const numEl = _extSpan(String(remaining), [
    'font-weight:700', 'font-size:20px', 'min-width:18px', 'text-align:center',
  ]);

  // A pill rather than a bar: the countdown exists so you can open a menu before
  // the shot, and a full-width bar would cover the very chrome you are about to
  // capture. Same surface, same type, same spacing — smaller footprint.
  _countdownOverlay = _extOverlay({
    id: '__screenshot_countdown',
    variant: 'pill',
    label: '📸 Screenshot in…',
    trail: numEl,
    compactCancel: true,
    // Routed through the teardown so the ✕, ESC and a fired capture all leave
    // the same state behind — otherwise a cancelled countdown could never restart.
    onCancel: () => _teardownCountdown(),
  }).mount();

  const tick = () => {
    remaining--;
    if (remaining <= 0) { _fireVisibleCapture(crop, fromHotkey); return; }
    numEl.textContent = remaining;
    _countdownTimer = setTimeout(tick, COUNTDOWN_TICK_MS);
  };
  _countdownTimer = setTimeout(tick, COUNTDOWN_TICK_MS);
}

function _teardownCountdown() {
  _countdownOverlay?.destroy();
  _countdownOverlay = null;
  clearTimeout(_countdownTimer);
  _countdownTimer = null;
}

function _fireVisibleCapture(crop, fromHotkey = false) {
  _teardownCountdown();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    safeSend({ type: 'TAKE_SCREENSHOT', crop: !!crop, fromHotkey });
  }));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_VISIBLE_COUNTDOWN') {
    _startVisibleCountdown(msg.seconds || 3, !!msg.crop);
    // The ack is what tells the worker the pill is up and this frame owns the
    // count — without an answer it counts down on the toolbar badge instead and
    // takes the shot itself, which is what has to happen on every tab this
    // script is not injected into.
    sendResponse({ ok: true });
  } else if (msg.type === 'FULL_CAPTURE_STATE') {
    _setFullCaptureActive(!!msg.active);
  }
});

/** The record hotkeys: start or stop, on an activated tab only. */
function _hotkeyRecord(combo) {
  try {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({ type: 'IS_TAB_ACTIVATED' }, (res) => {
      if (chrome.runtime.lastError) return;
      if (!res?.activated) return;
      if (combo === activeHotkeys.startRecord) { safeSend({ type: 'START_RECORD' }); }
      else                                     { safeSend({ type: 'STOP_RECORD'  }); }
    });
  } catch (_) { /* extension context invalidated: the hotkey does nothing */ }
}

/** The screenshot hotkey: after the countdown when it is on, cropping either way. */
function _hotkeyScreenshot() {
  try {
    if (!chrome.runtime?.id) return;
    chrome.storage.local.get(['screenshotCountdownEnabled', 'screenshotCountdownSeconds'], (res) => {
      try {
        void chrome.runtime.lastError;
        if (res.screenshotCountdownEnabled) _startVisibleCountdown(res.screenshotCountdownSeconds || 3, true, true);
        else safeSend({ type: 'TAKE_SCREENSHOT', crop: true, fromHotkey: true });
      } catch (_) { /* context invalidated mid-callback: the hotkey does nothing */ }
    });
  } catch (_) { /* extension context invalidated: the hotkey does nothing */ }
}

document.addEventListener('keydown', (e) => {
  // Held keys re-fire 'keydown' at the OS repeat rate. Without this guard, a
  // press that lasts a beat too long re-triggers the matched hotkey (most
  // visibly: two screenshots from one press of Alt+P) instead of one.
  if (e.repeat) return;

  if (e.key === 'Escape' && _fullCaptureActive) {
    e.preventDefault();
    _setFullCaptureActive(false);
    safeSend({ type: 'CANCEL_FULL_SCREENSHOT' });
    return;
  }
  // One branch for every overlay: the template's ESC stack dismisses whichever
  // one is on top, running that overlay's own cancel path.
  if (e.key === 'Escape' && _extDismissTop()) { e.preventDefault(); return; }

  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA'].includes(tag)) return;
  if (document.activeElement?.isContentEditable) return;

  // As typed, and with a letter or digit named by its physical key (macOS Option).
  const combos = new Set([getKeyCombo(e), getKeyCombo(e, true)]);
  const is = (hotkey) => !!hotkey && combos.has(hotkey);

  if (is(activeHotkeys.startRecord) || is(activeHotkeys.stopRecord)) {
    // Not an activated tab: the hotkey does nothing here, so the page keeps the key.
    if (!_tabActivated) return;
    e.preventDefault();
    _hotkeyRecord(is(activeHotkeys.startRecord) ? activeHotkeys.startRecord : activeHotkeys.stopRecord);
  } else if (is(activeHotkeys.screenshot)) {
    e.preventDefault();
    _hotkeyScreenshot();
  } else if (is(activeHotkeys.screenshotFull))    { e.preventDefault(); safeSend({ type: 'TAKE_SCREENSHOT_FULL', crop: true, fromHotkey: true }); }
  else if (is(activeHotkeys.screenshotScrollV)) { e.preventDefault(); safeSend({ type: 'TAKE_SCREENSHOT_SCROLL_V', fromHotkey: true }); }
  else if (is(activeHotkeys.screenshotScrollH)) { e.preventDefault(); safeSend({ type: 'TAKE_SCREENSHOT_SCROLL_H', fromHotkey: true }); }
  else if (is(activeHotkeys.segV))              { e.preventDefault(); safeSend({ type: 'HOTKEY_SEG_START', dir: 'vertical'   }); }
  else if (is(activeHotkeys.segH))              { e.preventDefault(); safeSend({ type: 'HOTKEY_SEG_START', dir: 'horizontal' }); }
  else if (is(activeHotkeys.segStop)) {
    e.preventDefault();
    _segCapture?.capture();
  } else if (is(activeHotkeys.screenshotElement)) {
    e.preventDefault(); safeSend({ type: 'HOTKEY_SCREENSHOT_ELEMENT' });
  }
}, true);

/* ─────────────────────────────────────────────────────────────────────────────
   FAILED-ACTION PROMPT

   Playback pauses on a failed action and asks here, on the page being played,
   whether to retry it, skip it or stop the run. The worker holds its message
   open and the click goes back as the response. Only the top frame is asked
   (the worker sends to frameId 0). The page stays usable underneath, so the
   user can put it right by hand before pressing Retry.
───────────────────────────────────────────────────────────────────────────── */

let _failPrompt = null; // { handle, respond }

function _closeFailPrompt(choice) {
  if (!_failPrompt) return;
  const { handle, respond } = _failPrompt;
  _failPrompt = null;
  handle.destroy();
  try { respond(choice ? { choice } : { closed: true }); } catch (_) { /* the waiting side already gave up: nothing to answer */ }
}

function _failPromptLine(text, extra = []) {
  return _extSpan(text, [
    'display:block', 'font-size:12px', 'white-space:pre-wrap', 'word-break:break-word', ...extra,
  ]);
}

function _showFailPrompt(msg, respond) {
  // A newer prompt replaces an older one; the worker is no longer waiting on it.
  _closeFailPrompt(null);

  const head = document.createElement('div');
  head.style.cssText = [
    'all:initial', 'display:flex', 'align-items:center', 'gap:6px',
    'font-family:inherit', 'font-size:13px', 'line-height:1.4', 'color:inherit',
  ].join(';');
  head.append(
    _extSpan('⚠', [`color:${_EXT_DANGER}`, 'font-size:15px', 'flex:0 0 auto']),
    _extSpan(`Action ${msg.index + 1}${msg.total ? ` of ${msg.total}` : ''} failed`, ['font-weight:700']),
  );

  const what  = [msg.actionType, msg.label && `"${msg.label}"`].filter(Boolean).join(' · ');
  const where = [msg.scenarioName, msg.row ? `row ${msg.row} of ${msg.rows}` : ''].filter(Boolean).join(' · ');

  const row = document.createElement('div');
  row.style.cssText = [
    'all:initial', 'display:flex', 'justify-content:flex-end', 'gap:6px', 'margin-top:4px',
  ].join(';');

  const handle = _extOverlay({
    id: '__action_failed_prompt',
    variant: 'panel',
    hint: null,
    buttons: [
      { key: 'retry', label: '↻ Retry', onClick: () => _closeFailPrompt('retry') },
      { key: 'skip',  label: '⏭ Skip',  onClick: () => _closeFailPrompt('skip') },
      { key: 'stop',  label: '■ Stop', tone: 'danger', onClick: () => _closeFailPrompt('stop') },
    ],
    content: [
      head,
      what  ? _failPromptLine(what, ['opacity:0.75']) : null,
      _failPromptLine(msg.reason || 'Action failed', ['max-height:120px', 'overflow:auto']),
      where ? _failPromptLine(where, ['font-size:11px', 'opacity:0.6']) : null,
      row,
    ],
    extra: [
      'display:flex', 'top:16px', 'left:50%', 'transform:translateX(-50%)',
      'width:min(420px, calc(100vw - 32px))',
    ],
  });

  // The template appends buttons straight onto the panel's column; they belong
  // on one row under the text. Moving the nodes keeps their theme repaint.
  const { retry, skip, stop } = handle.buttons;
  retry.title = 'Run this action again';
  skip.title  = 'Record it as failed and go on to the next action';
  stop.title  = 'Record it as failed and end the run';
  row.append(retry, skip, stop);

  _failPrompt = { handle, respond };
  handle.mount();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ACTION_FAILED_PROMPT') {
    _showFailPrompt(msg, sendResponse);
    return true; // answered when a button is clicked
  }
  if (msg.type === 'ACTION_FAILED_PROMPT_CLOSE') {
    _closeFailPrompt(null);
    sendResponse({ ok: true });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   PING / PONG
───────────────────────────────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ type: 'PONG', ready: true, timestamp: Date.now() });
    return true;
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   SEGMENT CAPTURE OVERLAY
───────────────────────────────────────────────────────────────────────────── */

let _segCapture = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'START_SEGMENT_TAB') return;

  if (_segCapture) _segCapture.cleanup();

  const dir    = msg.dir;
  const isVert = dir === 'vertical';
  const startX = window.scrollX;
  const startY = window.scrollY;

  // Declared before the overlay so the button handlers can close over it; the
  // template calls back into these, never the other way round.
  // eslint-disable-next-line prefer-const -- assigned below, after the overlay exists
  let cleanup, capture;

  const bar = _extOverlay({
    variant: 'bar',
    label:  `📍 Start: X=${Math.round(startX)}px, Y=${Math.round(startY)}px`,
    detail: '',
    onCancel: () => { cleanup(); safeSend({ type: 'CANCEL_SEGMENT_CAPTURE' }); },
    buttons: [
      { key: 'stop', label: '⏹ Stop & Capture', tone: 'danger', onClick: () => capture() },
    ],
  }).mount();

  // Rounded for display only: on a zoomed page scrollY is fractional, and the
  // raw value printed 15 decimals next to an integer start coordinate.
  const updateLbl = () => {
    const endX = Math.round(window.scrollX + window.innerWidth);
    const endY = Math.round(window.scrollY + window.innerHeight);
    bar.setDetail(`To: X=${endX}px, Y=${endY}px (W=${Math.abs(endX - startX)}px, H=${Math.abs(endY - startY)}px)`);
  };
  updateLbl();

  let rafId = null, scrollStopped = false, scrollStep = 2;
  const speedKey = isVert ? 'segScrollSpeedV' : 'segScrollSpeedH';
  try {
    chrome.storage.sync.get([speedKey], (res) => {
      try { void chrome.runtime.lastError; scrollStep = Math.min(10, Math.max(0.1, parseFloat(res?.[speedKey]) || 2)); } catch (_) { /* context invalidated mid-callback: keep the default speed */ }
    });
  } catch (_) { /* extension context invalidated: keep the default speed */ }

  const scrollLoop = () => {
    if (scrollStopped) return;
    const before = isVert ? window.scrollY : window.scrollX;
    if (isVert) window.scrollBy(0, scrollStep); else window.scrollBy(scrollStep, 0);
    const after = isVert ? window.scrollY : window.scrollX;
    updateLbl();
    if (after === before) { scrollStopped = true; bar.buttons.stop.textContent = '⏹ Capture (end of page)'; return; }
    rafId = requestAnimationFrame(scrollLoop);
  };
  rafId = requestAnimationFrame(scrollLoop);

  cleanup = () => {
    scrollStopped = true;
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
    bar.destroy();
    _segCapture = null;
  };

  capture = () => {
    const endX = window.scrollX + window.innerWidth;
    const endY = window.scrollY + window.innerHeight;
    cleanup();
    window.scrollTo(startX, startY);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      safeSend({
        type: 'CAPTURE_SEGMENT',
        xStart: Math.min(startX, endX), yStart: Math.min(startY, endY),
        xEnd:   Math.max(startX, endX), yEnd:   Math.max(startY, endY),
      });
    }));
  };

  _segCapture = { cleanup, capture };
  sendResponse({ ok: true });
  return true;
});

/* ─────────────────────────────────────────────────────────────────────────────
   HIGHLIGHT ENGINE LOADING

   The highlight engine, content-highlight.js, is loaded only while highlighting
   is on (hl_enabled is not false): this frame asks the worker to inject it
   (HL_LOAD) when the page loads and when highlighting is turned on. A page with
   highlighting off never runs it.

   It runs in this same isolated world, but declarations inside the injection
   guard are not visible to another script, so what it uses from this file is
   handed over here, and only that.
───────────────────────────────────────────────────────────────────────────── */

window.__pqaContent = {
  safeSend, getAllSelectors, findElementWithFallback, _isDynamicId, _DYNAMIC_ID_RE,
  _extOverlay, _extTokens, _extRegisterThemed, _EXT_THEMES, _EXT_ACCENT,
};

function _loadHighlightEngine() {
  if (!window.__pqaHighlightInjected) safeSend({ type: 'HL_LOAD' });
}

try {
  chrome.storage.local.get(['hl_enabled'], (res) => {
    void chrome.runtime.lastError;
    if (res?.hl_enabled !== false) _loadHighlightEngine();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.hl_enabled && changes.hl_enabled.newValue !== false) _loadHighlightEngine();
  });
} catch (_) { /* extension context invalidated: no highlights on this page */ }

/* ─────────────────────────────────────────────────────────────────────────────
   NOTIFY READY
───────────────────────────────────────────────────────────────────────────── */

safeSend({ type: 'CONTENT_READY' });

} // End of injection guard
