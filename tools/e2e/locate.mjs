/**
 * tools/e2e/locate.mjs — e2e suite "locate". Run: node tools/e2e.mjs --suite locate
 *
 * How playback finds and acts on elements: dropdowns, conditions, selector types, shadow
 * DOM, frames, the CDP steps, Click through.
 *
 *   dropdown      "Choose item #" in a custom list and in a <select>; a Dropdown
 *                 known only by an id that needs escaping, or only by an XPath, opens
 *   switch        Switch "Always" plays the other scenario; a Random of length 9999
 *                 plays as 512 characters
 *   capture       two visible screenshots within a second are both saved (Chrome
 *                 allows two captureVisibleTab calls a second; the second shot retries)
 *   background-tab  a run keeps going once its tab is sent to the background, and
 *                 finds an element added there (Chrome runs no rAF in a hidden tab)
 *   label-click   a real click on a checkbox's <label>, recorded, is one action, and
 *                 playing it leaves the box checked
 *   child-condition  "Text contains" clicks the innermost element holding the text,
 *                 and ALL needs every condition; one that matches nothing says so
 *   file-input    choosing a file while recording adds no Input action, and an old
 *                 Input action on a file input fails at once (it timed out after 10 s)
 *   condition-unknown  a Condition whose type the page does not know brings up the
 *                 failure prompt instead of passing and running what it guards
 *   selector-choice  an action's selectorType is tried first; without one, Full XPath
 *                 still comes first
 *   shadow-dom    buttons in a shadow root are clicked, one added there mid-wait
 *                 included, on a page whose light DOM never stops changing
 *   select-type   a Child Condition "Type is: select" finds a <select multiple>
 *   condition-choice  a Condition checks the element of the selector type chosen in the
 *                 form, not the Full XPath one; a Condition and an element screenshot
 *                 find an element by a Name typed in the form
 *   cdp-targets   the steps that act through CDP use the element the page found:
 *                 Upload File by a typed XPath, a Dropdown opened by a typed Name,
 *                 an element screenshot of the chosen CSS, not of the Full XPath one
 *   click-through  with Click through on (the default) a covered button is clicked as
 *                 before; with it off for the scenario, or for the action, a disabled,
 *                 covered, read-only or hidden element (or drop target) fails the
 *                 action with the reason; a shadow-DOM button is not "covered" by its host.
 *                 Through CDP too: a covered Dropdown trigger and a disabled file input
 *                 fail, a file input hidden by CSS still gets its file
 *   typed-text    a Text selector typed in the form (no textTag) clicks the element
 *                 holding that text, surrounding spaces ignored
 *   select-missing  an Input of an option the <select> does not have brings up the
 *                 failure prompt and leaves the choice alone; one it has is chosen
 */

import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from '../lib/cdp-browser.mjs';
import { PAGE_SETTLE_MS, POLL_MS, POPUP_SETTLE_MS, SETTLE_MS, check, clickAt, exportStates, makeScenario, pageSoon, play, pngSize, record, reloadTestPage } from './harness.mjs';

export async function checkDropdown(ctx) {
  await reloadTestPage(ctx);
  const id = await makeScenario(ctx, 'e2e dropdowns', [
    { type: 'dropdown', selector: '#dd', selectors: { css: '#dd' }, pick: { by: 'index', index: '2', itemSelector: '#menu li' } },
    { type: 'dropdown', selector: '#sel', selectors: { css: '#sel' }, pick: { by: 'index', index: '-1' } },
    { type: 'dropdown', selectors: { id: '2nd:dd' } },
    { type: 'dropdown', selector: '//div[@class="xp"]', selectors: { xpath: '//div[@class="xp"]' } },
  ]);
  const r = await play(ctx, id);
  check(r.dd === 'Two', 'Choose item #2 in a custom list picks "Two"', r);
  check(r.sel === 'c', 'Choose item #-1 in a <select> picks the last option', r);
  check(r.log.includes('id dropdown clicked'), 'a Dropdown known only by an id that needs escaping opens', r.log);
  check(r.log.includes('xpath dropdown clicked'), 'a Dropdown known only by an XPath opens', r.log);
  // A virtualized list of 1000: #500 by its Items selector, then the last with none given;
  // rows of mixed heights, walked: #77 and the last of 120.
  for (const [index, itemSelector, want, page] of [['500', '#vlist [role="option"]', 'Item 500', 'page'],
    ['-1', '', 'Item 1000', 'page'], ['77', '', 'Item 77', 'page?mixed'], ['-1', '', 'Item 120', 'page?mixed']]) {
    await ctx.web.goto(`${ctx.base}/${page}`);
    await sleep(PAGE_SETTLE_MS);
    const v = await makeScenario(ctx, `e2e virtual ${index}`, [
      { type: 'dropdown', selector: '#vdd', selectors: { css: '#vdd' }, pick: { by: 'index', index, itemSelector } },
    ]);
    const rv = await play(ctx, v);
    check(rv.vdd === want && !rv.timedOut, `Choose item #${index} in a virtualized list${page.includes('mixed') ? ' of mixed rows' : ''} picks "${want}"`, rv);
  }
  await ctx.web.goto(`${ctx.base}/page`);
  await sleep(PAGE_SETTLE_MS);
}

export async function checkSwitchAlways(ctx) {
  await reloadTestPage(ctx);
  await ctx.send({ type: 'SAVE_VARIABLES', variables: { greet: 'hello', big: '{random:alpha:9999}' } });
  const other = await makeScenario(ctx, 'e2e other', [
    { type: 'input', selector: '#out', selectors: { css: '#out' }, value: '${greet}-from-other' },
    { type: 'input', selector: '#big', selectors: { css: '#big' }, value: '${big}' },
  ]);
  const main = await makeScenario(ctx, 'e2e always', [
    { type: 'switch', switchVar: '', cases: [{ value: '__default__', scenarioId: other, scenarioName: 'e2e other' }] },
  ]);
  const r = await play(ctx, main);
  check(r.out === 'hello-from-other', 'Switch Always plays the other scenario', r);
  check(r.big.length === 512 && /^[a-zA-Z]+$/.test(r.big), 'a Random of length 9999 plays as 512 letters', { length: r.big.length });
}

export async function checkCapture(ctx) {
  await ctx.ext.evaluate(`chrome.storage.sync.set({ screenshotSaveMode: 'auto', screenshotPrefix: 'e2e' })`);
  await ctx.web.bringToFront();
  await sleep(SETTLE_MS);
  const before = ctx.browser.downloads().length;
  const shots = await ctx.ext.evaluate(`Promise.all([1, 2].map(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: 'TAKE_SCREENSHOT', tabId: ${ctx.webTabId} }, (r) => res(r ?? null)))))`, 30_000);
  await sleep(POPUP_SETTLE_MS);
  check(shots.every((s) => s?.success), 'both screenshots succeed', shots);
  check(ctx.browser.downloads().length - before === 2, 'two PNG files saved', ctx.browser.downloads());
}

export async function checkBackgroundTab(ctx) {
  await reloadTestPage(ctx);
  const click = (id) => ({ type: 'click', selector: `#${id}`, selectors: { css: `#${id}` }, delay: 200 });
  const id = await makeScenario(ctx, 'e2e background tab', [click('bg1'), click('late'), click('bg2')]);
  const r = await play(ctx, id, { away: ctx.ext });
  await ctx.web.bringToFront();
  check(r.log.some((e) => e.endsWith(' hidden')), 'the test tab was hidden during the run', r.log);
  check(!r.timedOut && r.log.length === 3, 'every click plays with the tab in the background', r);
  check(r.log.some((e) => e.startsWith('late ')), 'an element added while the tab is hidden is found', r.log);
}

export async function checkLabelClick(ctx) {
  await reloadTestPage(ctx);
  const { id, actions } = await record(ctx, 'e2e label', () => clickAt(ctx, '#agreeLabel'));
  check(actions.length === 1, 'a click on a <label> is recorded as one action', actions);
  await reloadTestPage(ctx);
  await play(ctx, id);
  const checked = await ctx.web.evaluate(`document.getElementById('agree').checked`);
  check(checked === true, 'played back, it leaves the checkbox checked', { checked, actions });
  const direct = await record(ctx, 'e2e label direct', async () => { await clickAt(ctx, '#agree'); await clickAt(ctx, '#plainLabel'); });
  check(direct.actions.map((a) => a.selector).join() === '#agree,#plainLabel',
    'a click on the checkbox itself, and on a label with no control, are still recorded', direct.actions.map((a) => a.selector));
}

export async function checkChildCondition(ctx) {
  await reloadTestPage(ctx);
  const inPeople = (conditions) => ({ type: 'click', selector: '#people', selectors: { css: '#people' }, conditions, delay: 100 });
  const id = await makeScenario(ctx, 'e2e child condition', [
    inPeople({ matchMode: 'any', textContains: 'John' }),
    inPeople({ matchMode: 'all', textContains: 'Edit', classContains: 'special' }),
  ]);
  const r = await play(ctx, id);
  const clicked = r.log.filter((e) => e.startsWith('people ')).map((e) => e.slice(7));
  check(clicked[0] === 'johnCell', 'Text contains "John" clicks the cell holding it, not the table body', clicked);
  check(clicked[1] === 'edit2', 'ALL clicks the one element matching every condition', clicked);

  // No child matching: the prompt says so.
  await reloadTestPage(ctx);
  const none = await makeScenario(ctx, 'e2e child condition none', [inPeople({ matchMode: 'any', textContains: 'Nobody' })]);
  await ctx.web.bringToFront();
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: none });
  let text = '';
  for (let waited = 0; !text && waited < 10_000; waited += POLL_MS) {
    await sleep(POLL_MS);
    text = await ctx.web.evaluate(`[...document.querySelectorAll('[data-ext-overlay]:not(#__pqa_run)')].map((e) => e.textContent).find((t) => /failed/i.test(t)) || ''`);
  }
  await ctx.send({ type: 'STOP_PLAYBACK' });
  await sleep(SETTLE_MS);
  check(/No child element matches the Child Condition/.test(text), 'a Child Condition that matches nothing says so on the prompt', text.slice(0, 160));
}

export async function checkFileInput(ctx) {
  await reloadTestPage(ctx);
  const { actions } = await record(ctx, 'e2e file input', async () => {
    const { root } = await ctx.web.send('DOM.getDocument');
    const { nodeId } = await ctx.web.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#upload' });
    await ctx.web.send('DOM.setFileInputFiles', { nodeId, files: [fileURLToPath(import.meta.url)] });
    await sleep(600); // past the recorder's input debounce
  });
  check(!actions.some((a) => a.type === 'input'), 'choosing a file while recording adds no Input action', actions);

  await reloadTestPage(ctx);
  const id = await makeScenario(ctx, 'e2e file input played', [
    { type: 'input', selector: '#upload', selectors: { css: '#upload' }, value: 'C:\\fakepath\\a.pdf' },
  ]);
  const { prompt, seconds } = await playUntilPrompt(ctx, id);
  check(prompt && seconds < 4, 'an Input action on a file input fails at once', { prompt, seconds });
}

/**
 * Play a scenario until the failed-action prompt shows on the test page (or the
 * run ends, or 15 s pass), then stop it. Whether the prompt showed, and after how long.
 */
async function playUntilPrompt(ctx, scenarioId) {
  await ctx.web.bringToFront();
  const started = Date.now();
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId });
  let prompt = false;
  while (!prompt && Date.now() - started < 15_000) {
    await sleep(POLL_MS);
    prompt = await ctx.web.evaluate(`[...document.querySelectorAll('[data-ext-overlay]:not(#__pqa_run)')].some((e) => /failed/i.test(e.textContent))`);
    if (!prompt && Date.now() - started > 2_000 && !(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.playing) break;
  }
  const seconds = (Date.now() - started) / 1000;
  await ctx.send({ type: 'STOP_PLAYBACK' });
  await sleep(SETTLE_MS);
  return { prompt, seconds };
}

export async function checkConditionUnknown(ctx) {
  await reloadTestPage(ctx);
  const id = await makeScenario(ctx, 'e2e unknown condition', [
    { type: 'condition', conditionType: 'bogus', selector: '#bg1', selectors: { css: '#bg1' }, skipCount: 1 },
    { type: 'click', selector: '#bg2', selectors: { css: '#bg2' } },
  ]);
  const { prompt } = await playUntilPrompt(ctx, id);
  const clicked = await ctx.web.evaluate(`__log.filter((e) => e.startsWith('bg2 '))`);
  check(prompt && clicked.length === 0, 'a Condition of an unknown type stops on the failure prompt instead of passing', { prompt, clicked });
}

export async function checkSelectorChoice(ctx) {
  await reloadTestPage(ctx);
  // Full XPath finds #choiceA, CSS finds #choiceB: which one plays shows which was tried first.
  const selectors = { fullXpath: '//*[@id="choiceA"]', css: '#choiceB' };
  const id = await makeScenario(ctx, 'e2e selector choice', [
    { type: 'click', selector: '#choiceB', selectors, selectorType: 'css', delay: 100 },
    { type: 'click', selector: '#choiceB', selectors, delay: 100 },
  ]);
  const r = await play(ctx, id);
  const clicked = r.log.filter((e) => e.startsWith('choice')).map((e) => e.split(' ')[0]);
  check(clicked[0] === 'choiceB', 'the selector type chosen in the form is tried first', clicked);
  check(clicked[1] === 'choiceA', 'without one, the usual order (Full XPath first) applies', clicked);
}

export async function checkShadowDom(ctx) {
  await ctx.web.goto(`${ctx.base}/page?shadow`);
  await sleep(PAGE_SETTLE_MS);
  const id = await makeScenario(ctx, 'e2e shadow dom', [
    { type: 'click', selector: '#shadowBtn', selectors: { css: '#shadowBtn' }, delay: 0 },
    { type: 'click', selector: '#lateShadowBtn', selectors: { css: '#lateShadowBtn' }, delay: 0 },
  ]);
  const r = await play(ctx, id);
  await ctx.web.goto(`${ctx.base}/page`);
  await sleep(PAGE_SETTLE_MS);
  const clicked = r.log.filter((e) => e.startsWith('shadow '));
  check(clicked.join() === 'shadow shadowBtn,shadow lateShadowBtn',
    'elements in a shadow root are found, one added there while the run waits too', { clicked, timedOut: r.timedOut });
}

export async function checkSelectType(ctx) {
  await reloadTestPage(ctx);
  // "Type is: select" as saved before 20464f1, against a <select multiple>.
  const id = await makeScenario(ctx, 'e2e select type', [
    { type: 'click', selector: '#forms', selectors: { css: '#forms' }, conditions: { matchMode: 'any', typeEquals: 'select' }, delay: 0 },
  ]);
  const { prompt } = await playUntilPrompt(ctx, id);
  const clicked = await ctx.web.evaluate(`__log.filter((e) => e.startsWith('forms '))`);
  check(!prompt && clicked.join() === 'forms multiSel', 'Child Condition "Type is: select" finds a <select multiple>', { prompt, clicked });
}

export async function checkConditionChoice(ctx) {
  await reloadTestPage(ctx);
  const shots = ctx.browser.downloads().length;
  const id = await makeScenario(ctx, 'e2e condition choice', [
    // Full XPath finds the hidden #menu, CSS the visible #choiceA; CSS was chosen.
    { type: 'condition', conditionType: 'elementVisible', skipCount: 1, selector: '#choiceA',
      selectors: { fullXpath: '//*[@id="menu"]', css: '#choiceA' }, selectorType: 'css', delay: 0 },
    { type: 'click', selector: '#choiceB', selectors: { css: '#choiceB' }, delay: 0 },
    // A Name typed in the form: { name } only.
    { type: 'condition', conditionType: 'elementExists', skipCount: 1, selector: 'nick',
      selectors: { name: 'nick' }, selectorType: 'name', delay: 0 },
    { type: 'click', selector: '#choiceA', selectors: { css: '#choiceA' }, delay: 0 },
    { type: 'screenshot_element', selector: 'nick', selectors: { name: 'nick' }, selectorType: 'name', delay: 0 },
  ]);
  const r = await play(ctx, id);
  const clicked = r.log.filter((e) => e.startsWith('choice')).map((e) => e.split(' ')[0]);
  check(clicked.join() === 'choiceB,choiceA', 'a Condition checks the element of the selector type chosen, a typed Name too', clicked);
  check(!r.timedOut && ctx.browser.downloads().length === shots + 1, 'an element screenshot finds its element by a typed Name',
    { timedOut: r.timedOut, saved: ctx.browser.downloads().length - shots });
}

export async function checkCdpTargets(ctx) {
  const marks = () => ctx.web.evaluate(`document.querySelectorAll('[data-pqa-target]').length`);
  // Each its own run: one that fails stops on the prompt, and must not hide the others.
  const playOne = async (name, action) => { await reloadTestPage(ctx); return play(ctx, await makeScenario(ctx, name, [action])); };

  const here = fileURLToPath(import.meta.url);
  // Known only by an XPath typed in the form: CDP was handed it as CSS.
  const up = await playOne('e2e cdp upload', { type: 'uploadFile', selector: '//input[@id="upload"]',
    selectors: { xpath: '//input[@id="upload"]' }, selectorType: 'xpath', folderPath: dirname(here), fileNames: [basename(here)], delay: 0 });
  const files = await ctx.web.evaluate(`document.getElementById('upload').files.length`);
  check(files === 1 && !up.timedOut && await marks() === 0, 'Upload File finds its input by an XPath typed in the form', { files, timedOut: up.timedOut });

  // A Name typed in the form: CDP looked for a <ddtrigger> tag.
  const dd = await playOne('e2e cdp dropdown', { type: 'dropdown', selector: 'ddtrigger', selectors: { name: 'ddtrigger' }, selectorType: 'name', delay: 300 });
  check(dd.log.includes('dd open') && await marks() === 0, 'a Dropdown opens by a Name typed in the form', dd.log);

  // Full XPath on the whole table, CSS on one button; CSS was chosen.
  const shots = ctx.browser.downloads();
  const shot = await playOne('e2e cdp element shot', { type: 'screenshot_element', selector: '#bg1',
    selectors: { fullXpath: '//*[@id="people"]', css: '#bg1' }, selectorType: 'css', delay: 0 });
  const bg1 = await ctx.web.evaluate(`(({ width, height }) => ({ width, height }))(document.getElementById('bg1').getBoundingClientRect())`);
  const added = ctx.browser.downloads().filter((f) => !shots.includes(f));
  const size = added.length === 1 ? pngSize(join(ctx.browser.downloadDir, added[0])) : null;
  check(!!size && Math.abs(size.width - bg1.width) <= 2 && Math.abs(size.height - bg1.height) <= 2 && await marks() === 0,
    'an element screenshot captures the element of the chosen selector type', { size, bg1, added, timedOut: shot.timedOut });
}

// The CDP steps — Upload File, a drop zone, opening a Dropdown, an element screenshot —
// on elements inside a frame of the page's origin; and the error from one of another origin.
export async function checkCdpFrames(ctx) {
  const here = fileURLToPath(import.meta.url);
  const files = { folderPath: dirname(here), fileNames: [basename(here)] };
  const runOn = async (key, actions, xo = false) => {
    await ctx.web.goto(`${ctx.base}/export?run=${key}${xo ? '&xo=1' : ''}`);
    await sleep(PAGE_SETTLE_MS * (xo ? 2 : 1));
    const frameId = await ctx.ext.evaluate(`new Promise((res) => chrome.scripting.executeScript(
      { target: { tabId: ${ctx.webTabId}, allFrames: true }, func: () => location.href },
      (r) => res((r || []).find((f) => f.result.includes(${JSON.stringify(xo ? 'localhost' : '/frame')}))?.frameId ?? null)))`);
    const id = await makeScenario(ctx, `e2e ${key}`, actions.map((a) => ({ ...a, frameId, delay: 0 })));
    return { played: await play(ctx, id), marks: () => exportStates.get(key)?.state?.marks || [] };
  };

  const up = await runOn('cdp-frame-upload', [
    { type: 'uploadFile', selector: '#fFiles', selectors: { css: '#fFiles' }, uploadMode: 'input', ...files },
    { type: 'uploadFile', selector: '#fZone', selectors: { css: '#fZone' }, uploadMode: 'dropzone', ...files },
  ]);
  const name = basename(here);
  check(up.marks().includes(`frame files ${name}`) && up.marks().includes(`frame zone ${name}`) && !up.played.timedOut,
    'Upload File into a file input and onto a drop zone inside a frame', up.marks());

  const dd = await runOn('cdp-frame-dropdown', [
    { type: 'dropdown', selector: '#fDd', selectors: { css: '#fDd' }, pick: { by: 'index', index: '2', itemSelector: '#fMenu li' } },
  ]);
  check(dd.marks().includes('frame dd trusted') && dd.marks().includes('frame picked fb') && !dd.played.timedOut,
    'a Dropdown inside a frame opens with a trusted click, and item #2 is chosen', dd.marks());

  const before = ctx.browser.downloads();
  const shot = await runOn('cdp-frame-shot', [{ type: 'screenshot_element', selector: '#fShot', selectors: { css: '#fShot' } }]);
  const added = ctx.browser.downloads().filter((f) => !before.includes(f));
  const size = added.length === 1 ? pngSize(join(ctx.browser.downloadDir, added[0])) : null;
  check(!!size && Math.abs(size.width - 57) <= 2 && Math.abs(size.height - 23) <= 2 && !shot.played.timedOut,
    'an element screenshot inside a frame captures that element', { size, added });

  // Another origin: the frame's content script finds it, CDP cannot reach it — said so.
  await ctx.web.goto(`${ctx.base}/export?run=cdp-frame-xo&xo=1`);
  await sleep(PAGE_SETTLE_MS * 2);
  const frameId = await ctx.ext.evaluate(`new Promise((res) => chrome.scripting.executeScript(
    { target: { tabId: ${ctx.webTabId}, allFrames: true }, func: () => location.href },
    (r) => res((r || []).find((f) => f.result.includes('localhost'))?.frameId ?? null)))`);
  const xo = await makeScenario(ctx, 'e2e cdp-frame-xo', [{ type: 'uploadFile', selector: '#fFiles', selectors: { css: '#fFiles' },
    uploadMode: 'input', ...files, frameId, delay: 0 }]);
  await ctx.web.bringToFront();
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: xo });
  const prompt = await pageSoon(ctx, `document.getElementById('__action_failed_prompt')?.textContent || null`, 20_000);
  await ctx.send({ type: 'STOP_PLAYBACK' });
  await sleep(SETTLE_MS);
  check(frameId != null && !!prompt?.includes('another origin'), 'Upload File in a frame of another origin says why it cannot', { frameId, prompt });
  await ctx.web.goto(`${ctx.base}/page`);
  await sleep(PAGE_SETTLE_MS);
}

/** The scenario's own "Click through" flag, written straight into storage. */
async function setScenarioClickThrough(ctx, id, allowed) {
  await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('scenarios', ({ scenarios }) => {
    if (${allowed}) delete scenarios[${JSON.stringify(id)}].clickThrough;
    else scenarios[${JSON.stringify(id)}].clickThrough = false;
    chrome.storage.local.set({ scenarios }, r);
  }))`);
}

export async function checkClickThrough(ctx) {
  const click = (id, extra = {}) => ({ type: 'click', selector: `#${id}`, selectors: { css: `#${id}` }, delay: 0, ...extra });
  /** The failure prompt's text for a one-action run, '' when the action passes. */
  const failureOf = async (name, action, { scenarioOff = false, shadow = false } = {}) => {
    await ctx.web.goto(`${ctx.base}/page${shadow ? '?shadow' : ''}`);
    await sleep(PAGE_SETTLE_MS);
    const id = await makeScenario(ctx, name, [action]);
    if (scenarioOff) await setScenarioClickThrough(ctx, id, false);
    await ctx.web.bringToFront();
    await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: id });
    let text = '';
    for (let waited = 0; !text && waited < 8_000; waited += POLL_MS) {
      await sleep(POLL_MS);
      text = await ctx.web.evaluate(`[...document.querySelectorAll('[data-ext-overlay]:not(#__pqa_run)')].map((e) => e.textContent).find((t) => /failed/i.test(t)) || ''`);
      if (!text && waited > 2_000 && !(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.playing) break;
    }
    await ctx.send({ type: 'STOP_PLAYBACK' });
    await sleep(SETTLE_MS);
    return text;
  };

  check(await failureOf('e2e ct default', click('ctCovered')) === '' && (await ctx.web.evaluate('__log')).includes('ctCovered'),
    'Click through on (the default): a covered button is clicked as before');
  const off = [
    ['disabled', click('ctDisabled'), /Element is disabled/],
    ['covered', click('ctCovered'), /covered by span#ctCover/],
    ['read-only', { type: 'input', selector: '#ctReadonly', selectors: { css: '#ctReadonly' }, value: 'x', delay: 0 }, /read-only/],
    ['hidden', { type: 'hover', selector: '#ctHidden', selectors: { css: '#ctHidden' }, delay: 0 }, /not visible/],
    ['drop target', { type: 'dragdrop', selector: '#bg1', selectors: { css: '#bg1' }, targetSelector: '#ctCovered', targetSelectors: { css: '#ctCovered' }, delay: 0 }, /Drop target: Element is covered/],
  ];
  for (const [what, action, reason] of off) {
    const text = await failureOf(`e2e ct ${what}`, action, { scenarioOff: true });
    check(reason.test(text), `Click through off for the scenario: a ${what} element fails with the reason`, text.slice(0, 160));
  }
  // The steps that act through CDP ask the page first (MARK_ELEMENT).
  const here = fileURLToPath(import.meta.url);
  const upload = (id) => ({ type: 'uploadFile', selector: `#${id}`, selectors: { css: `#${id}` },
    folderPath: dirname(here), fileNames: [basename(here)], delay: 0 });
  const dd = await failureOf('e2e ct dropdown', { type: 'dropdown', selector: '#ctCovered', selectors: { css: '#ctCovered' }, delay: 0 }, { scenarioOff: true });
  check(/covered by span#ctCover/.test(dd), 'Click through off: a covered Dropdown trigger fails, through CDP', dd.slice(0, 160));
  const disabledFile = await failureOf('e2e ct upload disabled', upload('ctFileDisabled'), { scenarioOff: true });
  check(/Element is disabled/.test(disabledFile), 'Click through off: Upload File into a disabled file input fails', disabledFile.slice(0, 160));
  const hiddenFile = await failureOf('e2e ct upload hidden', upload('ctFileHidden'), { scenarioOff: true });
  const hiddenFiles = await ctx.web.evaluate(`document.getElementById('ctFileHidden').files.length`);
  check(hiddenFile === '' && hiddenFiles === 1, 'Click through off: a file input hidden by CSS still gets its file', { hiddenFile: hiddenFile.slice(0, 120), hiddenFiles });

  const own = await failureOf('e2e ct action off', click('ctCovered', { clickThrough: false }));
  check(/covered by span#ctCover/.test(own), 'Click through off for the action alone: the covered button fails too', own.slice(0, 160));
  const shadow = await failureOf('e2e ct shadow', click('shadowBtn'), { scenarioOff: true, shadow: true });
  check(shadow === '', 'a button in a shadow root is not "covered" by its own host', shadow.slice(0, 160));
  await ctx.web.goto(`${ctx.base}/page`);
  await sleep(PAGE_SETTLE_MS);
}

export async function checkTypedText(ctx) {
  await reloadTestPage(ctx);
  // As the form saves a Text selector typed by hand: no textTag beside it.
  const id = await makeScenario(ctx, 'e2e typed text', [
    { type: 'click', selector: 'choiceA', selectors: { text: 'choiceA' }, selectorType: 'text', timeout: 2000, delay: 0 },
    { type: 'click', selector: ' choiceB ', selectors: { text: ' choiceB ' }, selectorType: 'text', timeout: 2000, delay: 0 },
  ]);
  const r = await play(ctx, id);
  const clicked = r.log.filter((e) => e.startsWith('choice')).map((e) => e.split(' ')[0]);
  check(clicked.join() === 'choiceA,choiceB' && !r.timedOut, 'a Text selector typed in the form finds its element', { clicked, timedOut: r.timedOut });
}

export async function checkSelectMissing(ctx) {
  await reloadTestPage(ctx);
  await ctx.web.evaluate(`document.getElementById('sel').value = 'b'`);
  const missing = await makeScenario(ctx, 'e2e select missing', [
    { type: 'input', selector: '#sel', selectors: { css: '#sel' }, value: 'zzz', delay: 0 },
  ]);
  const { prompt } = await playUntilPrompt(ctx, missing);
  const kept = await ctx.web.evaluate(`document.getElementById('sel').value`);
  check(prompt && kept === 'b', 'an Input of an option the <select> does not have fails, and leaves its choice alone', { prompt, kept });
  const present = await makeScenario(ctx, 'e2e select present', [
    { type: 'input', selector: '#sel', selectors: { css: '#sel' }, value: 'c', delay: 0 },
  ]);
  const r = await play(ctx, present);
  check(r.sel === 'c' && !r.timedOut, 'an option it has is still chosen', r);
}

export const CHECKS = [
  ['dropdown', 'Dropdown', checkDropdown],
  ['switch', 'Switch Always and the Random cap', checkSwitchAlways],
  ['capture', 'Two visible screenshots in a row', checkCapture],
  ['background-tab', 'A run in a background tab', checkBackgroundTab],
  ['label-click', 'A click on a label, recorded and played', checkLabelClick],
  ['child-condition', 'Child Condition: innermost text match, ALL', checkChildCondition],
  ['file-input', 'A file input, recorded and played', checkFileInput],
  ['condition-unknown', 'A Condition of an unknown type', checkConditionUnknown],
  ['selector-choice', 'The selector type chosen in the form plays first', checkSelectorChoice],
  ['shadow-dom', 'Elements in a shadow root', checkShadowDom],
  ['select-type', 'Child Condition type "select"', checkSelectType],
  ['condition-choice', 'Condition and element screenshot use the chosen selector type', checkConditionChoice],
  ['cdp-targets', 'Upload, Dropdown and element screenshot act on the element the page found', checkCdpTargets],
  ['cdp-frames', 'Upload, Dropdown and element screenshot inside a frame', checkCdpFrames],
  ['click-through', 'Click through: off for the scenario or the action', checkClickThrough],
  ['typed-text', 'A Text selector typed in the form', checkTypedText],
  ['select-missing', 'Input of an option a <select> does not have', checkSelectMissing],
];
