/**
 * tools/e2e/run.mjs — e2e suite "run". Run: node tools/e2e.mjs --suite run
 *
 * A run as it shows: the overlays, a schedule, Assert and the Last run card, the run
 * panel, Play right after Stop, runs grouped on Record & Play.
 *
 *   schedule      a schedule's alarm opens its start URL in a new tab and plays there,
 *                 not on the tab that was active
 *   stop-then-play  ■ Stop in a long Wait, or in a step's long delay, then Play at once:
 *                 the new run plays, the stopped one goes no further
 */

import { readdirSync } from 'node:fs';
import { sleep } from '../lib/cdp-browser.mjs';
import { PAGE_SETTLE_MS, POLL_MS, POPUP_SETTLE_MS, SETTLE_MS, check, clickAt, fail, makeScenario, openPopup, pageSoon, play, record, reloadTestPage } from './harness.mjs';

// The overlays content.js does not carry (content-overlays.js): loaded by the worker
// only for a countdown, a failed-action prompt or a segment capture.
export async function checkOverlays(ctx) {
  await reloadTestPage(ctx);
  await ctx.web.bringToFront();
  const loaded = () => ctx.ext.evaluate(`chrome.scripting.executeScript({ target: { tabId: ${ctx.webTabId} },
    func: () => !!window.__pqaOverlaysInjected }).then(([r]) => r.result)`);
  check(await loaded() === false, 'a page that has not needed one carries no overlay code', null);

  // The countdown the screenshot hotkey asks for, sent from the page as content.js sends it.
  await ctx.ext.evaluate(`chrome.storage.sync.set({ screenshotSaveMode: 'auto', screenshotPrefix: 'e2e' })`);
  const before = ctx.browser.downloads().length;
  await ctx.ext.evaluate(`chrome.scripting.executeScript({ target: { tabId: ${ctx.webTabId} },
    func: () => { chrome.runtime.sendMessage({ type: 'TAKE_SCREENSHOT', crop: false, fromHotkey: true, countdown: 2 }); } })`);
  const pill = await pageSoon(ctx, `document.getElementById('__screenshot_countdown')?.textContent || null`);
  let saved = 0;
  for (let waited = 0; !saved && waited < 8_000; waited += POLL_MS) { await sleep(POLL_MS); saved = ctx.browser.downloads().length - before; }
  check(!!pill?.includes('Screenshot in') && saved === 1, 'a hotkey countdown shows the pill on the page, then saves the shot', { pill, saved });

  // A failed action (an option the <select> does not have): the prompt on the page; Stop ends the run.
  const id = await makeScenario(ctx, 'e2e overlay prompt', [{ type: 'input', selector: '#sel', selectors: { css: '#sel' }, value: 'zzz', delay: 0 }]);
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: id });
  const prompt = await pageSoon(ctx, `document.getElementById('__action_failed_prompt')?.textContent || null`, 10_000);
  await ctx.web.evaluate(`document.querySelector('#__action_failed_prompt button[title="Record it as failed and end the run"]')?.click()`);
  let st = null;
  for (let waited = 0; waited < 5_000; waited += POLL_MS) { st = await ctx.send({ type: 'GET_EXTENSION_STATUS' }); if (!st?.playing) break; await sleep(POLL_MS); }
  if (st?.playing) await ctx.send({ type: 'STOP_PLAYBACK' });
  check(!!prompt?.includes('Action 1 of 1 failed') && !st?.playing, 'a failed action asks on the page, and Stop ends the run', { prompt, playing: st?.playing });

  // A segment capture: the bar on the page; its ✕ ends the session.
  await ctx.send({ type: 'START_SEGMENT_CAPTURE', tabId: ctx.webTabId, dir: 'vertical' });
  const bar = await pageSoon(ctx, `[...document.querySelectorAll('div')].some((d) => d.textContent.startsWith('📍 Start:'))`);
  await ctx.web.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await ctx.web.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  const gone = !!(await pageSoon(ctx, `![...document.querySelectorAll('div')].some((d) => d.textContent.startsWith('📍 Start:'))`, 3_000));
  check(bar === true && gone, 'a segment capture shows its bar on the page, and ESC takes it away', { bar, gone });
  // Alt+X (segment stop) from content.js reaches the bar's capture through window.
  const shotsBefore = ctx.browser.downloads().length;
  await ctx.send({ type: 'START_SEGMENT_CAPTURE', tabId: ctx.webTabId, dir: 'vertical' });
  await pageSoon(ctx, `[...document.querySelectorAll('div')].some((d) => d.textContent.startsWith('📍 Start:'))`);
  for (const type of ['keyDown', 'keyUp']) {
    await ctx.web.send('Input.dispatchKeyEvent', { type, key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, modifiers: 1 });
  }
  let segSaved = 0;
  for (let waited = 0; !segSaved && waited < 10_000; waited += POLL_MS) { await sleep(POLL_MS); segSaved = ctx.browser.downloads().length - shotsBefore; }
  check(segSaved === 1, 'the segment-stop hotkey captures the segment', { segSaved });
  check(await loaded() === true, 'the overlay code is in the page once one was needed', null);
}

export async function checkAssert(ctx) {
  await reloadTestPage(ctx);
  const id = await makeScenario(ctx, 'e2e assert', [
    { type: 'assert', conditionType: 'textEquals', selector: '#asLate', selectors: { css: '#asLate' }, expectedValue: 'Saved' },
    { type: 'assert', conditionType: 'elementExists', selector: '#asNever', selectors: { css: '#asNever' } },
    { type: 'assert', conditionType: 'textEquals', selector: '#bg1', selectors: { css: '#bg1' }, expectedValue: 'nope' },
    { type: 'assert', conditionType: 'valueEquals', selector: '#asPw', selectors: { css: '#asPw' }, expectedValue: 'guess' },
    { type: 'click', selector: '#bg2', selectors: { css: '#bg2' } },
  ]);
  await ctx.web.evaluate(`{ const p = document.createElement('input'); p.type = 'password'; p.id = 'asPw'; p.value = 'hunter2'; document.body.append(p); }`);
  // The failures the worker reports, as the popup hears them.
  await ctx.ext.evaluate(`window.__fails = []; window.__failsHooked || chrome.runtime.onMessage.addListener((m) => {
    if (m.type === 'ACTION_FAILED') __fails.push(m.index + ' ' + m.reason);
  }); window.__failsHooked = true;`);
  // What the first Assert checks shows up 2 s after the run starts.
  await ctx.web.evaluate(`setTimeout(() => {
    const s = document.createElement('span'); s.id = 'asLate'; s.textContent = 'Saved'; document.body.append(s);
  }, 2000)`);
  await ctx.web.bringToFront();
  const started = Date.now();
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: id });
  let prompt = false;
  while (Date.now() - started < 30_000) {
    await sleep(POLL_MS);
    prompt ||= await ctx.web.evaluate(`[...document.querySelectorAll('[data-ext-overlay]:not(#__pqa_run)')].some((e) => /failed/i.test(e.textContent))`);
    if (prompt || (Date.now() - started > 1_000 && !(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.playing)) break;
  }
  const seconds = (Date.now() - started) / 1000;
  if (prompt) await ctx.send({ type: 'STOP_PLAYBACK' });
  await sleep(SETTLE_MS);
  const clicked = await ctx.web.evaluate(`__log.filter((e) => e.startsWith('bg2 '))`);
  const fails = await ctx.ext.evaluate('__fails');
  check(!prompt && clicked.length === 1, 'a false Assert does not stop the run: no prompt, and the step after it plays', { prompt, clicked });
  check(fails[0] === '1 Expected element to exist' && !fails.some((f) => f.startsWith('0 ')),
    'an Assert that holds after 2 s passes; one that never holds fails', fails);
  check(fails[1] === '2 Expected text "nope", got "bg1"', 'a false Assert says what the page held', fails);
  check(fails[2] === '3 Expected the value of a password field to match' && !JSON.stringify(fails).includes('hunter2'),
    'and never what a password field holds', fails);
  check(fails.length === 3, 'nothing else failed', fails);
  check(seconds >= 16 && seconds < 30, 'the run waited for each: about 2 s, then the full 5 s for every false one', { seconds });
  const ended = await ctx.ext.evaluate(`new Promise((r) => chrome.action.getBadgeText({}, (badge) =>
    chrome.storage.local.get('lastRun', (x) => r({ badge, status: x.lastRun?.verdict?.status, failures: x.lastRun?.failures?.length }))))`);
  check(ended.badge === '✗' && ended.status === 'failed' && ended.failures === 3,
    'the run ends Failed: ✗ on the badge, and the run kept as the last one', ended);
}

export async function checkLastRun(ctx) {
  await reloadTestPage(ctx);
  const id = await makeScenario(ctx, 'e2e last run', [
    // Typed text the bug report hides until asked.
    { type: 'input', selector: '#out', selectors: { css: '#out' }, value: 'S3CRET' },
    { type: 'click', selector: '#bg1', selectors: { css: '#bg1' }, label: 'Press bg1' },
    { type: 'assert', conditionType: 'textEquals', selector: '#bg2', selectors: { css: '#bg2' }, expectedValue: 'nope', label: 'bg2 says nope' },
    { type: 'click', selector: '#bg2', selectors: { css: '#bg2' } },
  ]);
  await ctx.web.bringToFront();
  const started = Date.now();
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: id });
  while (Date.now() - started < 20_000) {
    await sleep(POLL_MS);
    if (Date.now() - started > 1_000 && !(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.playing) break;
  }
  await sleep(SETTLE_MS);
  // The first failure's evidence: the page's URL, the steps run, the tab as it failed.
  const evidence = await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get(['lastRun', 'lastRunShot'], (x) => r({
    url: x.lastRun?.failures?.[0]?.url, trace: x.lastRun?.failures?.[0]?.trace,
    shot: (x.lastRunShot || '').slice(0, 23), shotLength: (x.lastRunShot || '').length })))`);
  check(evidence.url === `${ctx.base}/page` && JSON.stringify(evidence.trace) === '[0,1,2]'
    && evidence.shot === 'data:image/jpeg;base64,' && evidence.shotLength > 1000,
  'the first failure keeps the URL, the steps run, and a JPEG of the tab', evidence);
  const badgeText = () => ctx.ext.evaluate('new Promise((r) => chrome.action.getBadgeText({}, r))');
  const before = await badgeText();

  const popup = await openPopup(ctx);
  const card = () => popup.evaluate(`(() => {
    const c = document.getElementById('lastRunCard');
    return { shown: !!c && !c.hidden, verdict: c?.querySelector('.lr-verdict')?.textContent,
      name: c?.querySelector('.lr-name')?.textContent, when: c?.querySelector('.lr-when')?.textContent,
      failures: [...(c?.querySelectorAll('.lr-failure') || [])].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()) };
  })()`);
  const shown = await card();
  check(shown.shown && shown.verdict === '✗ Failed' && shown.name === 'e2e last run' && shown.failures.length === 1
    && shown.failures[0].includes('#3 bg2 says nope') && shown.failures[0].includes('Expected text "nope", got "bg2"'),
  'the popup shows the last run: Failed, its scenario and its failed check', shown);
  check(/ago|just now/.test(shown.when || ''), 'and how long ago it ended', shown.when);
  check(before === '✗' && (await badgeText()) === '', 'opening the popup takes the verdict off the badge', { before, after: await badgeText() });

  // A failure leads to its action in the list.
  await popup.evaluate(`document.querySelector('.tab-btn[data-tab="tabRecord"]').click();
    document.querySelector('#lastRunCard .lr-failure').click();`);
  await sleep(SETTLE_MS * 2);
  const jumped = await popup.evaluate(`({ selected: document.getElementById('scenarioList').value,
    row: document.querySelector('#actions li.action.lr-target')?.dataset.index })`);
  check(jumped.selected === id && jumped.row === '2', 'a failure selects its scenario and marks its action in the list', jumped);

  // The bug report: Markdown in a preview, typed values hidden until asked, Copy, the screenshot.
  const report = () => popup.evaluate(`({ open: document.getElementById('bugReportModal').classList.contains('show'),
    text: document.getElementById('bugReportText').value,
    shotButton: getComputedStyle(document.getElementById('bugReportShot')).display !== 'none' })`);
  await popup.evaluate(`document.getElementById('lastRunBugReport').click()`);
  await sleep(SETTLE_MS);
  const hidden = await report();
  check(hidden.open && hidden.text.startsWith('## ✗ Failed — e2e last run, step #3')
    && hidden.text.includes('3. ✗ Check that the text of `#bg2` is "nope" — bg2 says nope')
    && hidden.text.includes('1. Type ••• into `#out`') && !hidden.text.includes('S3CRET')
    && /Attached: `pocketqa-bug-e2e last run-[\d_-]+\.jpg`/.test(hidden.text) && hidden.shotButton,
  'Bug report: the report with typed values hidden, and its screenshot to download', hidden);
  await popup.evaluate(`document.getElementById('bugReportShowValues').click()`);
  await sleep(SETTLE_MS);
  check((await report()).text.includes('1. Type "S3CRET" into `#out`'), 'Include typed values shows them', (await report()).text.slice(0, 300));
  await popup.evaluate(`document.getElementById('bugReportCopy').click()`);
  await sleep(SETTLE_MS);
  const copied = await popup.evaluate(`document.getElementById('toast').textContent`);
  check(/copied/i.test(copied), 'Copy puts the report on the clipboard', copied);
  const jpgs = () => readdirSync(ctx.browser.downloadDir).filter((f) => f.startsWith('pocketqa-bug-') && f.endsWith('.jpg'));
  const jpgsBefore = jpgs().length;
  await popup.evaluate(`document.getElementById('bugReportShot').click()`);
  for (let waited = 0; jpgs().length === jpgsBefore && waited < 5_000; waited += POLL_MS) await sleep(POLL_MS);
  check(jpgs().length === jpgsBefore + 1, 'Download screenshot saves the JPEG', jpgs());
  await popup.evaluate(`document.getElementById('bugReportClose').click()`);

  // Its scenario deleted: the card still shows, and a failure says the scenario is gone.
  await ctx.send({ type: 'DELETE_SCENARIO', scenarioId: id });
  await popup.reload();
  await sleep(POPUP_SETTLE_MS);
  const orphan = await card();
  await popup.evaluate(`document.querySelector('#lastRunCard .lr-failure')?.click()`);
  await sleep(SETTLE_MS);
  const toast = await popup.evaluate(`document.getElementById('toast').textContent`);
  check(orphan.shown && /no longer exists/.test(toast), 'with its scenario deleted the card still shows, and a failure says so', { orphan, toast });

  // × hides it until the next run.
  await popup.evaluate(`document.getElementById('lastRunDismiss').click()`);
  await popup.reload();
  await sleep(POPUP_SETTLE_MS);
  check(!(await card()).shown, '× hides the card, and it stays hidden when the popup opens again', await card());
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();
}

// A step of another scenario a Switch played: its number is that one's. The card
// marked the step of that number of the scenario played instead.
export async function checkLastRunSwitch(ctx) {
  await reloadTestPage(ctx);
  const bId = await makeScenario(ctx, 'e2e switch B', [
    { type: 'click', selector: '#bg1', selectors: { css: '#bg1' } },
    { type: 'assert', conditionType: 'textEquals', selector: '#bg2', selectors: { css: '#bg2' }, expectedValue: 'nope', label: 'B says nope' },
  ]);
  const aId = await makeScenario(ctx, 'e2e switch A', [
    { type: 'click', selector: '#bg1', selectors: { css: '#bg1' } },
    { type: 'click', selector: '#bg2', selectors: { css: '#bg2' } },
    { type: 'switch', switchVar: '', cases: [{ value: '__default__', scenarioId: bId, scenarioName: 'e2e switch B' }] },
  ]);
  await play(ctx, aId);
  const popup = await openPopup(ctx);
  const failure = await popup.evaluate(`document.querySelector('#lastRunCard .lr-failure')?.textContent`);
  check(/#2 in "e2e switch B" B says nope/.test(failure || ''), 'a failure in the scenario a Switch played names that scenario', failure);
  await popup.evaluate(`document.querySelector('.tab-btn[data-tab="tabRecord"]').click();
    document.querySelector('#lastRunCard .lr-failure').click();`);
  await sleep(SETTLE_MS * 2);
  const jumped = await popup.evaluate(`({ selected: document.getElementById('scenarioList').value,
    row: document.querySelector('#actions li.action.lr-target')?.dataset.index })`);
  check(jumped.selected === bId && jumped.row === '1', 'and leads to its step there, not to step #2 of the scenario played', jumped);
  // The bug report lists that scenario's steps under the Switch.
  await popup.evaluate(`document.getElementById('lastRunBugReport').click()`);
  await sleep(SETTLE_MS);
  const report = await popup.evaluate(`document.getElementById('bugReportText').value`);
  check(report.includes(', step #2 in "e2e switch B"')
    && report.includes('3. Run the scenario "e2e switch B"\n   1. Click `#bg1`\n   2. ✗ Check that the text of `#bg2` is "nope" — B says nope\n'),
  'its bug report lists the steps of that scenario under the Switch', report);
  await popup.evaluate(`document.getElementById('bugReportClose').click()`);
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();
  for (const id of [aId, bId]) await ctx.send({ type: 'DELETE_SCENARIO', scenarioId: id });
}

export async function checkNoChecks(ctx) {
  const lastVerdict = () => ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('lastRun', (x) => r(x.lastRun?.verdict || null)))`);
  const card = async () => {
    const popup = await openPopup(ctx);
    const seen = await popup.evaluate(`(() => {
      const c = document.getElementById('lastRunCard');
      return { verdict: c.querySelector('.lr-verdict').textContent, status: c.dataset.status, hint: c.querySelector('.lr-hint')?.hidden === false };
    })()`);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
    await popup.close();
    return seen;
  };
  const clicks = [
    { type: 'click', selector: '#bg1', selectors: { css: '#bg1' } },
    { type: 'click', selector: '#bg2', selectors: { css: '#bg2' } },
  ];
  const holds = { type: 'assert', conditionType: 'textEquals', selector: '#bg1', selectors: { css: '#bg1' }, expectedValue: 'bg1' };

  await reloadTestPage(ctx);
  await play(ctx, await makeScenario(ctx, 'e2e no checks', clicks));
  const none = { verdict: await lastVerdict(), card: await card() };
  check(none.verdict?.status === 'passed' && none.verdict?.checks === 0
    && none.card.verdict === '✓ Finished · no checks' && none.card.status === 'unchecked' && none.card.hint,
  'a run with no Assert: "Finished · no checks", not Passed, and a hint to add one', none);

  await reloadTestPage(ctx);
  await play(ctx, await makeScenario(ctx, 'e2e one check', [...clicks, holds]));
  const one = { verdict: await lastVerdict(), card: await card() };
  check(one.verdict?.status === 'passed' && one.verdict?.checks === 1
    && one.card.verdict === '✓ Passed' && one.card.status === 'passed' && !one.card.hint,
  'an Assert that holds: Passed, no hint', one);

  await reloadTestPage(ctx);
  await play(ctx, await makeScenario(ctx, 'e2e check switched off', [...clicks, { ...holds, disabled: true }]));
  const off = await lastVerdict();
  check(off?.status === 'passed' && off?.checks === 0, 'a disabled Assert checks nothing', off);
}

export async function checkLastRunLive(ctx) {
  const click = (sel) => ({ type: 'click', selector: sel, selectors: { css: sel } });
  await reloadTestPage(ctx);
  await play(ctx, await makeScenario(ctx, 'e2e live before', [click('#bg1')]));
  const stuck = await makeScenario(ctx, 'e2e live stuck', [click('#bg1'), click('#gone'), click('#bg2')]);
  const cardState = `(() => { const c = document.getElementById('lastRunCard');
    return { visible: !c.hidden && getComputedStyle(c).display !== 'none', verdict: c.querySelector('.lr-verdict').textContent,
      name: c.querySelector('.lr-name').textContent }; })()`;
  // On a tab of its own: the step that fails logs a console error there.
  const away = await ctx.browser.openPage(`${ctx.base}/page?live`, { width: 1000, height: 700 });
  let prompt = false, during = null, after = null;
  try {
    await sleep(PAGE_SETTLE_MS);
    await away.bringToFront();
    await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: stuck });
    for (let waited = 0; !prompt && waited < 15_000; waited += POLL_MS) {
      await sleep(POLL_MS);
      prompt = await away.evaluate(`[...document.querySelectorAll('[data-ext-overlay]:not(#__pqa_run)')].some((e) => /failed/i.test(e.textContent))`);
    }
    const popup = await openPopup(ctx);
    during = await popup.evaluate(cardState);
    await ctx.send({ type: 'STOP_PLAYBACK' });
    await sleep(POPUP_SETTLE_MS);
    after = await popup.evaluate(cardState);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
    await popup.close();
  } finally {
    await away.close();
  }
  check(prompt && !during.visible, 'a run paused on its failed step: the Last run card of the run before is not shown', { prompt, during });
  check(after.visible && after.name === 'e2e live stuck' && /Test broken|Stopped/.test(after.verdict),
    'once the run ends, the card is back with its result', after);
}

// The run panel on the page a run plays on: what plays and how far, off the screen
// for a screenshot, gone when the run ends; its Stop ends a run.
export async function checkRunPanel(ctx) {
  await reloadTestPage(ctx);
  await ctx.ext.evaluate(`chrome.storage.sync.set({ screenshotSaveMode: 'auto', screenshotPrefix: 'e2e' })`);
  // What the page saw of the panel, each time it changed: "shown <text>" / "hidden <text>" / "none".
  const watch = () => ctx.web.evaluate(`(() => { window.__panel = ['none'];
    new MutationObserver(() => { const p = document.getElementById('__pqa_run');
      const s = p ? (p.style.visibility === 'hidden' ? 'hidden ' : 'shown ') + p.textContent : 'none';
      if (__panel.at(-1) !== s) __panel.push(s); })
      .observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); })()`);
  await watch();
  const id = await makeScenario(ctx, 'e2e run panel', [
    { type: 'wait', delay: 700 },
    { type: 'click', selector: '#bg1', selectors: { css: '#bg1' }, delay: 300 },
    { type: 'screenshot', value: 'panel', delay: 300 },
    { type: 'wait', delay: 700 },
  ]);
  const before = ctx.browser.downloads().length;
  await play(ctx, id);
  const seen = await ctx.web.evaluate('window.__panel');
  const shown = seen.filter((s) => s.startsWith('shown'));
  check(shown.some((s) => s.includes('e2e run panel') && s.includes('step 1/4')) && shown.some((s) => s.includes('step 4/4')) && seen.at(-1) === 'none',
    'a run shows its panel — the scenario and its step — and takes it away at the end', seen);
  const hiddenAt = seen.findIndex((s) => s.startsWith('hidden') && s.includes('step 3/4'));
  check(hiddenAt > 0 && seen.slice(hiddenAt + 1).some((s) => s.startsWith('shown')) && ctx.browser.downloads().length - before === 1,
    'the screenshot step takes the panel off the screen, then puts it back', { seen, saved: ctx.browser.downloads().length - before });

  // ■ Stop on the panel ends the run.
  await reloadTestPage(ctx);
  const long = await makeScenario(ctx, 'e2e run panel stop', [{ type: 'wait', delay: 8000 }, { type: 'click', selector: '#bg2', selectors: { css: '#bg2' } }]);
  await ctx.web.bringToFront();
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: long });
  const up = await pageSoon(ctx, `!!document.getElementById('__pqa_run')`, 5_000);
  await clickAt(ctx, '#__pqa_run button');
  let st = null;
  for (let waited = 0; waited < 3_000; waited += POLL_MS) { st = await ctx.send({ type: 'GET_EXTENSION_STATUS' }); if (!st?.playing) break; await sleep(POLL_MS); }
  const gone = !!(await pageSoon(ctx, `!document.getElementById('__pqa_run')`, 3_000));
  const log = await ctx.web.evaluate('window.__log');
  if (st?.playing) await ctx.send({ type: 'STOP_PLAYBACK' });
  check(up && !st?.playing && gone && !log.some((l) => l.startsWith('bg2')), "the panel's ■ Stop ends the run, and the panel goes", { up, playing: st?.playing, gone, log });
}

// ■ Stop in a long Wait, or in a step's long delay, then Play at once: the new run
// plays. The stopped run held its claim until its pause would have ended, so the
// Play was refused ("Already Running") and nothing played.
export async function checkStopThenPlay(ctx) {
  const click = (sel, extra) => ({ type: 'click', selector: sel, selectors: { css: sel }, ...extra });
  const next = await makeScenario(ctx, 'e2e play after stop', [click('#choiceA')]);
  const cases = [
    // [where, the stopped run's actions, true on the page once it is in its pause]
    ['a Wait', [{ type: 'wait', delay: 8000 }, click('#bg2')], 'true'],
    ["a step's delay", [click('#bg1', { delay: 8000 }), click('#bg2')], `__log.some((e) => e.startsWith('bg1 '))`],
  ];
  for (const [where, actions, inPause] of cases) {
    await reloadTestPage(ctx);
    const first = await makeScenario(ctx, `e2e stop in ${where}`, actions);
    await ctx.web.bringToFront();
    await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: first });
    let playing = false;
    for (let waited = 0; !playing && waited < 5_000; waited += POLL_MS) {
      await sleep(POLL_MS);
      playing = !!(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.playing;
    }
    const paused = playing && !!(await pageSoon(ctx, inPause, 3_000));
    await ctx.send({ type: 'STOP_PLAYBACK' });
    await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: next });
    const played = !!(await pageSoon(ctx, `__log.some((e) => e.startsWith('choiceA '))`, 3_000));
    for (let waited = 0; waited < 5_000 && (await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.playing; waited += POLL_MS) await sleep(POLL_MS);
    const log = await ctx.web.evaluate('window.__log');
    check(paused && played && !log.some((e) => e.startsWith('bg2 ')),
      `Play right after ■ Stop in ${where}: the new run plays, the stopped one goes no further`, { paused, played, log });
  }
}

export async function checkRunGroup(ctx) {
  const popup = await openPopup(ctx);
  try {
    const layout = await popup.evaluate(`(() => {
      const ids = [...document.querySelectorAll('#tabRecord .card[id]')].map((c) => c.id);
      return { tab: document.querySelector('.tab-btn[data-tab="tabData"]').textContent.trim(),
        group: document.querySelector('#tabRecord .tab-group-label')?.textContent.trim() || '',
        last: ids.slice(-3), inTools: !!document.querySelector('#tabData #scheduledPlaybackCard, #tabData #csvRunCard') };
    })()`);
    check(layout.tab === 'Tools' && /schedule/i.test(layout.group) && !layout.inTools
      && layout.last.join() === 'sequencePlaybackCard,scheduledPlaybackCard,csvRunCard',
    'Sequence, Scheduled Playback and the CSV run close Record & Play under one heading; the Data tab is Tools', layout);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await popup.close();
  }
}

export async function checkSchedule(ctx) {
  await reloadTestPage(ctx);
  const id = await makeScenario(ctx, 'e2e scheduled', [{ type: 'click', selector: '#bg2', selectors: { css: '#bg2' }, delay: 0 }]);
  const url = `${ctx.base}/page?scheduled`;
  // The schedule's alarm, fired half a second from now (an unpacked extension
  // is not held to the 30 s minimum).
  await ctx.ext.evaluate(`new Promise((res) => chrome.storage.local.set({ schedules: [
    { id: 'e2eSched', scenarioId: '${id}', time: '00:00', enabled: true, repeat: true, url: ${JSON.stringify(url)} },
  ] }, () => { chrome.alarms.create('sched_e2eSched', { when: Date.now() + 500 }); res(); }))`);
  let found = null;
  for (let waited = 0; !found?.log?.length && waited < 20_000; waited += POLL_MS) {
    await sleep(POLL_MS);
    found = await ctx.ext.evaluate(`new Promise((res) => chrome.tabs.query({ url: ${JSON.stringify(`${url}*`)} }, async ([tab]) => {
      if (!tab) return res(null);
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: () => window.__log }).catch(() => [{}]);
      res({ tabId: tab.id, log: r?.result || [] });
    }))`);
  }
  await ctx.ext.evaluate(`new Promise((res) => chrome.alarms.clear('sched_e2eSched', () => chrome.storage.local.set({ schedules: [] }, res)))`);
  if (found?.tabId) await ctx.ext.evaluate(`chrome.tabs.remove(${found.tabId})`);
  check(!!found?.tabId && found.tabId !== ctx.webTabId, 'a schedule with a start URL opens a new tab on it', found);
  check(!!found?.log?.some((e) => e.startsWith('bg2 ')), 'and plays its scenario there', found);
  const onTestTab = await ctx.web.evaluate(`__log.filter((e) => e.startsWith('bg2 '))`);
  check(onTestTab.length === 0, 'not on the tab that was active', onTestTab);
}

/** Play `id` on the test tab and wait for it to end; lastRun as it left it. */
async function playToEnd(ctx, id) {
  await ctx.web.bringToFront();
  const started = Date.now();
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId: id });
  while (Date.now() - started < 20_000) {
    await sleep(POLL_MS);
    if (Date.now() - started > 1_000 && !(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.playing) break;
  }
  await sleep(SETTLE_MS);
  return ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('lastRun', (x) => r(x.lastRun)))`);
}

// 🩹 A form recorded, then changed the way a new release changes it: a field put at
// its top (the full XPath of the email field now finds it), the button moved and
// given a new id (only its text still finds it). The run says so; Review takes the
// locators again; the next run has nothing to say.
export async function checkLocatorCheck(ctx) {
  await reloadTestPage(ctx);
  const FORM = `<form id="lcForm" onsubmit="return false"><label>Email <input id="lcEmail" name="lcEmail"></label>
    <button id="lcGo" type="button">Go now</button></form>`;
  await ctx.web.evaluate(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(FORM)})`);
  const { id, actions } = await record(ctx, 'e2e locator check', async () => {
    await clickAt(ctx, '#lcEmail');
    await ctx.web.send('Input.insertText', { text: 'me@x.test' });
    await clickAt(ctx, '#lcGo');
  });
  check(actions.map((a) => a.type).join() === 'click,input,click' && !!actions[1]?.selectors?.fullXpath,
    'the form is recorded with all its locators', actions.map((a) => `${a.type} ${JSON.stringify(a.selectors)}`));
  await ctx.web.evaluate(`(() => {
    const f = document.getElementById('lcForm');
    f.insertAdjacentHTML('afterbegin', '<label>Coupon <input id="lcCoupon"></label>');
    const b = document.getElementById('lcGo'); b.id = 'lcGo2';
    const box = document.createElement('div'); f.append(box); box.append(b);
  })()`);
  const run = await playToEnd(ctx, id);
  const notes = (run?.notes || []).map((n) => `${n.index} ${n.kind || n.locator.kind}`);
  const kinds = (run?.notes || []).map((n) => `#${n.index} ${n.locator.kind} used ${n.locator.used.label.id}${n.locator.other ? ` other ${n.locator.other.label.id}` : ''}`);
  const typedInto = await ctx.web.evaluate(`({ coupon: document.getElementById('lcCoupon').value, email: document.getElementById('lcEmail').value })`);
  check(JSON.stringify(kinds) === JSON.stringify(['#1 split used lcCoupon other lcEmail', '#2 split used lcCoupon other lcEmail', '#3 fragile used lcGo2']),
    'the run notes the steps whose locators disagree (full XPath on the new field) and the one only its text still finds', { kinds, notes });
  check(typedInto.coupon === 'me@x.test' && run.verdict?.status !== 'broken',
    'playback still uses the first locator, as the exports do; the notes do not change the verdict', { typedInto, verdict: run.verdict });

  const popup = await openPopup(ctx);
  const line = await popup.evaluate(`(() => { const l = document.getElementById('lastRunNotes'); return l && !l.hidden ? l.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
  check(/🩹 3 steps: locators to check/.test(line || ''), 'the Last run card has a 🩹 line with Review', line);
  await popup.evaluate(`document.getElementById('lastRunNotesReview').click()`);
  await sleep(SETTLE_MS);
  const review = await popup.evaluate(`[...document.querySelectorAll('#locatorReviewModal.show .lrv-step')].map((s) => ({
    head: s.querySelector('.lrv-head').textContent, why: s.querySelector('.lrv-why').textContent,
    rows: [...s.querySelectorAll('.lrv-table tr')].slice(1).map((r) => r.textContent.replace(/\\s+/g, ' ').trim()),
    buttons: [...s.querySelectorAll('.lrv-buttons button')].map((b) => b.textContent) }))`);
  check(review.length === 3 && review[1].buttons.join() === 'Use “Email”,Keep “Coupon”,Show'
    && review[1].rows.some((r) => r.startsWith('full XPath') && r.includes('≠') === false && r.includes('lcCoupon'))
    && review[1].rows.some((r) => r.startsWith('ID') && r.includes('≠ input#lcEmail'))
    && review[2].buttons.join() === 'Take locators again,Show' && /Only text still finds button#lcGo2 “Go now”\. Full XPath, ID, XPath and CSS found nothing/.test(review[2].why),
  'Review: each locator and what it found; Use / Keep for a split, Take again for a fragile step', { review, errors: popup.errors() });

  // Use “Email” on the input step, Take again on the button.
  await popup.evaluate(`[...document.querySelectorAll('#locatorReviewModal .lrv-step')][1].querySelector('.lrv-fix').click()`);
  await sleep(SETTLE_MS * 2);
  await popup.evaluate(`[...document.querySelectorAll('#locatorReviewModal .lrv-step')][2].querySelector('.lrv-fix').click()`);
  await sleep(SETTLE_MS * 2);
  const fixed = await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get(['scenarios', 'lastRun'], (x) => {
    const a = x.scenarios[${JSON.stringify(id)}].actions;
    r({ input: a[1].selectors, button: a[2].selectors, selector: a[2].selector, done: x.lastRun.notes.map((n) => !!n.done) });
  }))`);
  const after = await popup.evaluate(`({ line: document.getElementById('lastRunNotes').hidden ? null : document.getElementById('lastRunNotesText').textContent,
    done: document.querySelectorAll('#locatorReviewModal .lrv-done').length })`);
  check(fixed.input?.id === 'lcEmail' && /label\[2\]/.test(fixed.input?.fullXpath || '') && fixed.button?.id === 'lcGo2' && fixed.selector === '#lcGo2'
    && fixed.done.join() === 'false,true,true' && after.done === 2 && /🩹 1 step:/.test(after.line || ''),
  'taking the locators again writes them into the step, and the note is done', { fixed, after });
  // The click into the field too; then the next run has nothing to say, and types where it should.
  await popup.evaluate(`[...document.querySelectorAll('#locatorReviewModal .lrv-step')][0].querySelector('.lrv-fix').click()`);
  await sleep(SETTLE_MS * 2);
  await popup.evaluate(`document.getElementById('locatorReviewClose').click()`);
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();
  await ctx.web.evaluate(`document.getElementById('lcCoupon').value = ''`);
  const again = await playToEnd(ctx, id);
  const typed = await ctx.web.evaluate(`({ coupon: document.getElementById('lcCoupon').value, email: document.getElementById('lcEmail').value })`);
  check(!again?.notes && typed.email === 'me@x.test' && typed.coupon === '', 'the next run has nothing to say, and types into the email field', { notes: again?.notes, typed });
  await ctx.send({ type: 'DELETE_SCENARIO', scenarioId: id });
}

// 📈 Three runs of one scenario, the page changed in between: passed, failed, passed —
// with the same steps, so the card asks whether it is flaky.
export async function checkRunHistory(ctx) {
  await reloadTestPage(ctx);
  await ctx.web.evaluate(`document.body.insertAdjacentHTML('beforeend', '<div id="rhT">ok</div>')`);
  const id = await makeScenario(ctx, 'e2e run history', [
    { type: 'assert', conditionType: 'textEquals', selector: '#rhT', selectors: { css: '#rhT' }, expectedValue: 'ok', label: 'Status', delay: 0 },
  ]);
  const setText = (t) => ctx.web.evaluate(`document.getElementById('rhT').textContent = ${JSON.stringify(t)}`);
  await playToEnd(ctx, id);
  await setText('down');
  await playToEnd(ctx, id);
  await setText('ok');
  await playToEnd(ctx, id);
  const stored = await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('runHistory', (x) => r((x.runHistory?.[${JSON.stringify(id)}] || []).map((e) => e.how + ' ' + e.status))))`);
  check(JSON.stringify(stored) === '["play passed","play failed","play passed"]', 'each Play adds to the history of its scenario', stored);

  const popup = await openPopup(ctx);
  const card = () => popup.evaluate(`({
    strip: !document.getElementById('lastRunHistory').hidden,
    dots: [...document.querySelectorAll('#lastRunDots .lr-dot')].map((d) => d.dataset.status),
    sum: document.getElementById('lastRunHistSum').textContent,
    flag: document.getElementById('lastRunHistFlag').hidden ? null : document.getElementById('lastRunHistFlag').textContent,
    detail: document.getElementById('lastRunHistDetail').hidden ? null : document.getElementById('lastRunHistDetail').textContent })`);
  const shown = await card();
  check(shown.strip && shown.dots.join() === 'passed,failed,passed' && shown.sum === '1 of the last 3 failed'
    && /Flaky\? #1 Status failed 1 of the last 3 runs, and passed again with the same steps/.test(shown.flag || ''),
  'the Last run card shows the runs as dots, how many failed, and asks Flaky?', shown);
  await popup.evaluate(`document.querySelectorAll('#lastRunDots .lr-dot')[1].click()`);
  await sleep(SETTLE_MS);
  const picked = await card();
  check(/^Run 2 of 3 · ▶ Play · .+ — ✗ Failed\n✗ #1 Status — Expected text "ok", got "down"$/.test(picked.detail || ''),
    'a dot clicked tells that run and its first failure', picked.detail);
  await popup.evaluate(`document.getElementById('lastRunHistAll').click()`);
  await sleep(SETTLE_MS);
  const all = await popup.evaluate(`({ open: document.getElementById('runHistoryModal').classList.contains('show'),
    title: document.getElementById('runHistoryName').textContent,
    rows: [...document.querySelectorAll('#runHistoryTable tr')].slice(1).map((r) => [...r.cells].slice(1).map((c) => c.textContent).join(' | ')) })`);
  check(all.open && all.title === 'e2e run history · last 3 runs' && all.rows.length === 3
    && all.rows[1] === '▶ Play | ✗ Failed | ✗ #1 Status — Expected text "ok", got "down"' && all.rows[0].startsWith('▶ Play | ✓ Passed'),
  'All runs lists every run, newest first', all);
  await popup.evaluate(`document.getElementById('runHistoryClose').click()`);
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();

  // A deleted scenario's runs go with the next run of any scenario.
  await ctx.send({ type: 'DELETE_SCENARIO', scenarioId: id });
  const other = await makeScenario(ctx, 'e2e run history other', [{ type: 'wait', delay: 10, value: 10 }]);
  await playToEnd(ctx, other);
  const left = await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('runHistory', (x) => r(Object.keys(x.runHistory || {}))))`);
  check(!left.includes(id) && left.includes(other), 'the runs of a deleted scenario are dropped', left);
  await ctx.send({ type: 'DELETE_SCENARIO', scenarioId: other });
}

export const CHECKS = [
  ['locator-check', '🩹 Steps whose locators disagree, and taking them again', checkLocatorCheck],
  ['run-history', '📈 The last runs of a scenario on the Last run card', checkRunHistory],
  ['overlays', 'The countdown, failed-action prompt and segment bar, loaded when needed', checkOverlays],
  ['schedule', 'A scheduled run on its start URL', checkSchedule],
  ['assert', 'Assert: waited for, and a false one does not stop the run', checkAssert],
  ['last-run', 'The Last run card in the popup', checkLastRun],
  ['last-run-switch', 'A failure in the scenario a Switch played leads there', checkLastRunSwitch],
  ['no-checks', 'A run with no Assert says it checked nothing', checkNoChecks],
  ['last-run-live', 'The Last run card hides while a run is on', checkLastRunLive],
  ['run-panel', 'The run panel on the page: progress, off for a screenshot, its Stop', checkRunPanel],
  ['stop-then-play', 'Play right after ■ Stop in a long Wait or delay', checkStopThenPlay],
  ['run-group', 'Sequence, schedule and CSV run in one group on Record & Play', checkRunGroup],
];
