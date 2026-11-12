/**
 * tools/e2e/harness.mjs — e2e: the options, the timings, ok / fail / check, and the helpers more than one suite uses.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asActiveTab, sleep } from '../lib/cdp-browser.mjs';

export const args = process.argv.slice(2);
export const argValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
export const EXT = resolve(argValue('--ext') || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));
export const HEADED = args.includes('--headed');

// A run is waited for this long, then stopped.
export const PLAY_TIMEOUT_MS = 30_000;
export const POLL_MS = 150;
export const SETTLE_MS = 300;
export const PAGE_SETTLE_MS = 800;
export const POPUP_SETTLE_MS = 1500;
// The Add Manual Action draft is saved 600 ms after the last change (popup/record/draft.js).
export const DRAFT_SAVE_MS = 1000;
export const POPUP_VIEWPORT = { width: 480, height: 900 };

export const failures = [];
export const fail = (msg) => { failures.push(msg); console.log(`  ✖ ${msg}`); };
export const ok = (msg) => console.log(`  ✔ ${msg}`);
export const check = (cond, msg, detail) => (cond ? ok(msg) : fail(`${msg} — ${JSON.stringify(detail)}`));

/** A scenario made of `actions`, saved through the worker; its id. */
export async function makeScenario(ctx, name, actions) {
  const { id } = await ctx.send({ type: 'CREATE_SCENARIO', name });
  for (const action of actions) await ctx.send({ type: 'ADD_MANUAL_ACTION', scenarioId: id, action });
  return id;
}

/**
 * Play a scenario on the test tab (it must be the active tab) and return the page's state.
 * `away`: a page brought to the front once the run has started, which hides the test tab.
 */
export async function play(ctx, scenarioId, { away = null } = {}) {
  await ctx.web.bringToFront();
  await ctx.send({ type: 'START_PLAYBACK_SCENARIO', scenarioId });
  if (away) {
    // The run takes the active tab once it has read the scenarios — slower the more
    // there are: hidden before that, the test tab is not the one it plays on.
    for (let waited = 0; waited < 5_000 && !(await ctx.send({ type: 'GET_EXTENSION_STATUS' }))?.playing; waited += 20) await sleep(20);
    await away.bringToFront();
  }
  await sleep(SETTLE_MS);
  let running = true;
  for (let waited = 0; running && waited < PLAY_TIMEOUT_MS; waited += POLL_MS) {
    const st = await ctx.send({ type: 'GET_EXTENSION_STATUS' });
    running = !!(st?.playing || st?.sequencePlaying);
    if (running) await sleep(POLL_MS);
  }
  // A run stuck on a failure prompt would block the next check.
  if (running) await ctx.send({ type: 'STOP_PLAYBACK' });
  await sleep(SETTLE_MS);
  // `?.`: export-run plays on the export page, which has none of these.
  return ctx.web.evaluate(`({ log: window.__log, dd: document.getElementById('dd')?.textContent, vdd: document.getElementById('vdd')?.textContent,
    sel: document.getElementById('sel')?.value, out: document.getElementById('out')?.value,
    big: document.getElementById('big')?.value, timedOut: ${running} })`);
}

export const reloadTestPage = async (ctx) => { await ctx.web.reload(); await sleep(PAGE_SETTLE_MS); };

/** Record what `perform` does on the test tab into a new scenario; its id and the recorded actions. */
export async function record(ctx, name, perform) {
  const id = await makeScenario(ctx, name, []);
  await ctx.web.bringToFront();
  await ctx.send({ type: 'START_RECORD', scenarioId: id, tabId: ctx.webTabId });
  await sleep(SETTLE_MS);
  await perform();
  await sleep(SETTLE_MS);
  const r = await ctx.send({ type: 'STOP_RECORD' });
  return { id, actions: r?.actions || [] };
}

/** A real (trusted) mouse click in the middle of `selector` on the test tab. */
export async function clickAt(ctx, selector) {
  const { x, y } = await ctx.web.evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await ctx.web.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

/** Polls `expr` on the test page until it is truthy, for up to `ms`; its last value. */
export async function pageSoon(ctx, expr, ms = 5_000) {
  let v = null;
  for (let waited = 0; !v && waited < ms; waited += POLL_MS) { v = await ctx.web.evaluate(expr); if (!v) await sleep(POLL_MS); }
  return v;
}

/** The popup as if opened on the activated test page; `size`: { width, height } other than POPUP_VIEWPORT. */
export async function openPopup(ctx, size = POPUP_VIEWPORT) {
  const popup = await ctx.browser.openPage(ctx.extUrl('popup.html'), { initScript: asActiveTab(`${ctx.base}/page`), ...size });
  await popup.evaluate(`chrome.storage.local.set({ activatedTabs: [${ctx.webTabId}] })`);
  await popup.reload();
  await sleep(POPUP_SETTLE_MS);
  return popup;
}

/** Scenario `id` in the popup's action list. */
export async function showScenario(popup, id) {
  await popup.evaluate(`(() => {
    document.querySelector('.tab-btn[data-tab="tabRecord"]').click();
    const s = document.getElementById('scenarioList'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(POPUP_SETTLE_MS);
}

/** The popup closes itself for a pick (window.close); a page CDP opened may stay. */
export const closeQuietly = (page) => page.close().catch(() => { /* closed itself */ });

/** Width and height of a PNG file, from its IHDR chunk. */
export function pngSize(file) {
  const b = readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** The latest state each run of EXPORT_PAGE posted, by its ?run= key. */
export const exportStates = new Map();
