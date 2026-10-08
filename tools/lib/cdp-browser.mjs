/**
 * cdp-browser.mjs — the unpacked extension in a Chromium-family browser, driven over
 * the DevTools protocol with Node's own WebSocket (Node 22+). No Playwright.
 *
 * Used by tools/smoke-cdp.mjs and tools/e2e.mjs. The browser is $CHROMIUM_PATH, or
 * the first usual Edge / Chromium install found. Branded Chrome ignores
 * --load-extension; Edge and Chromium accept it.
 *
 *   const browser = await launchWithExtension(ROOT);
 *   const sw = await browser.serviceWorker();          // the extension's worker; sw.extId
 *   const page = await browser.openPage(url, { width, height, initScript });
 *   await page.evaluate('expression');                  // awaited, returned by value
 *   page.errors();                                      // exceptions, console errors, failed loads
 *   await browser.close();
 *
 * Every run gets a fresh temporary profile whose downloads stay inside it, so a
 * capture never lands in the user's Downloads folder.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// How long the browser gets to write DevToolsActivePort, and a single CDP call or
// awaited expression to answer.
const STARTUP_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 15_000;
// How long the extension's service worker gets to appear and have `chrome` ready.
const WORKER_TIMEOUT_MS = 15_000;
const POLL_MS = 100;
// The browser holds profile files for a moment after it is killed.
const EXIT_SETTLE_MS = 800;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSER_CANDIDATES = {
  win32: [
    `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.LOCALAPPDATA}\\Chromium\\Application\\chrome.exe`,
  ],
  darwin: [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

/** $CHROMIUM_PATH, else the first usual install on this platform, else null. */
export function findBrowser() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  return (BROWSER_CANDIDATES[process.platform] || []).find((p) => existsSync(p)) || null;
}

/** A temporary profile whose downloads go to <profile>/downloads without asking. */
function makeProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'pqa-cdp-'));
  const downloads = join(dir, 'downloads');
  mkdirSync(join(dir, 'Default'), { recursive: true });
  mkdirSync(downloads);
  writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: downloads },
  }));
  return { dir, downloads };
}

/** The browser writes its port to DevToolsActivePort; stderr may stay empty. */
async function devToolsUrl(profileDir) {
  const file = join(profileDir, 'DevToolsActivePort');
  for (let waited = 0; waited < STARTUP_TIMEOUT_MS; waited += POLL_MS) {
    if (existsSync(file)) {
      const [port, path] = readFileSync(file, 'utf8').trim().split(/\s+/);
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    }
    await sleep(POLL_MS);
  }
  throw new Error('the browser did not open its DevTools port');
}

/** One WebSocket to the browser: `send` (optionally on a session) and per-session event lists. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('cannot connect to the DevTools port')), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const sessions = new Map(); // sessionId → { events, waiters }
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`)); else p.res(msg.result);
      return;
    }
    const s = msg.method && sessions.get(msg.sessionId);
    if (!s) return;
    s.events.push(msg);
    for (const w of [...s.waiters]) {
      if (w.method === msg.method) { s.waiters.splice(s.waiters.indexOf(w), 1); w.res(msg); }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { res, rej, method });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { ws, send, sessions };
}

/** Exceptions, console errors, "failed to load" warnings, failed requests and HTTP errors among `events`. */
function errorsIn(events) {
  return events.flatMap(({ method, params: p }) => {
    if (method === 'Runtime.exceptionThrown') {
      return [`exception: ${(p.exceptionDetails.exception?.description || p.exceptionDetails.text).split('\n')[0]}`];
    }
    if (method === 'Runtime.consoleAPICalled') {
      const text = p.args.map((a) => a.value ?? a.description).join(' ');
      if (p.type === 'error') return [`console.error: ${text}`];
      if (p.type === 'warning' && /failed to load/i.test(text)) return [`console.warn: ${text}`];
      return [];
    }
    if (method === 'Log.entryAdded' && p.entry.level === 'error') return [`log: ${p.entry.text} ${p.entry.url || ''}`];
    if (method === 'Network.loadingFailed' && !p.canceled) return [`request failed: ${p.errorText}`];
    if (method === 'Network.responseReceived' && p.response.status >= 400) return [`HTTP ${p.response.status}: ${p.response.url}`];
    return [];
  });
}

/** A session on one target: `send`, `evaluate`, `waitEvent`, `errors`. */
async function attach(conn, targetId) {
  const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
  const s = { events: [], waiters: [] };
  conn.sessions.set(sessionId, s);
  const send = (method, params) => conn.send(method, params, sessionId);
  const waitEvent = (method, ms = CALL_TIMEOUT_MS) => new Promise((res, rej) => {
    const w = { method, res };
    s.waiters.push(w);
    setTimeout(() => {
      const i = s.waiters.indexOf(w);
      if (i >= 0) { s.waiters.splice(i, 1); rej(new Error(`no ${method} within ${ms} ms`)); }
    }, ms);
  });
  const evaluate = async (expression, ms = CALL_TIMEOUT_MS) => {
    const timeout = sleep(ms).then(() => ({ exceptionDetails: { text: `no answer within ${ms} ms: ${expression.slice(0, 80)}` } }));
    const r = await Promise.race([send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), timeout]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { targetId, send, evaluate, waitEvent, errors: () => errorsIn(s.events) };
}

/** Navigation, screenshots and closing on top of a page session. */
function pageApi(conn, session) {
  const goto = async (url) => {
    const load = session.waitEvent('Page.loadEventFired');
    await session.send('Page.navigate', { url });
    await load;
  };
  const reload = async () => {
    const load = session.waitEvent('Page.loadEventFired');
    await session.send('Page.reload', { ignoreCache: true });
    await load;
  };
  /** The whole page as a PNG Buffer. */
  const screenshot = async () => {
    const { cssContentSize: { width, height } } = await session.send('Page.getLayoutMetrics');
    const r = await session.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    return Buffer.from(r.data, 'base64');
  };
  const bringToFront = () => conn.send('Target.activateTarget', { targetId: session.targetId });
  const close = () => conn.send('Target.closeTarget', { targetId: session.targetId });
  return { ...session, goto, reload, screenshot, bringToFront, close };
}

/**
 * Launch the browser with `extDir` loaded. Throws when no browser is found
 * (message starts with "no browser").
 */
export async function launchWithExtension(extDir, { headed = false } = {}) {
  const exe = findBrowser();
  if (!exe) throw new Error('no browser: set CHROMIUM_PATH to an Edge or Chromium executable');
  const profile = makeProfile();
  const proc = spawn(exe, [
    ...(headed ? [] : ['--headless=new']), '--remote-debugging-port=0', `--user-data-dir=${profile.dir}`,
    `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1000,800', 'about:blank',
  ], { stdio: 'ignore' });
  const conn = await connect(await devToolsUrl(profile.dir));

  /** A new tab, with its domains on before it loads `url` so load-time errors are caught. */
  async function openPage(url, { initScript, width, height } = {}) {
    const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' });
    const page = pageApi(conn, await attach(conn, targetId));
    for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await page.send(`${domain}.enable`);
    if (width) await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    if (initScript) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
    await page.goto(url);
    return page;
  }

  /** The extension's service worker (background.js), once `chrome` is usable in it; null if it never starts. */
  async function serviceWorker() {
    for (let waited = 0; waited < WORKER_TIMEOUT_MS; waited += POLL_MS) {
      const { targetInfos } = await conn.send('Target.getTargets');
      // Edge runs extensions of its own; ours is the one whose worker is background.js.
      const info = targetInfos.find((t) => t.type === 'service_worker'
        && t.url.startsWith('chrome-extension://') && t.url.endsWith('/background.js'));
      if (info) {
        const sw = await attach(conn, info.targetId);
        await sw.send('Runtime.enable');
        sw.extId = new URL(info.url).host;
        // Right after start-up the worker's scope may not be evaluable yet.
        for (; waited < WORKER_TIMEOUT_MS; waited += POLL_MS) {
          const ready = await sw.evaluate(`typeof chrome !== 'undefined' && !!chrome.runtime`, 2_000).catch(() => false);
          if (ready) return sw;
          await sleep(POLL_MS);
        }
        return sw;
      }
      await sleep(POLL_MS);
    }
    return null;
  }

  /** PNG files downloaded so far, relative to the profile's download folder. */
  const downloads = () => readdirSync(profile.downloads, { recursive: true }).map(String).filter((f) => /\.png$/i.test(f));

  async function close() {
    // Killing the spawned process alone left Edge's browser process running on
    // Windows, one per run; Browser.close shuts the whole browser down. Not
    // waited on for long: a browser that goes without answering is handled by kill().
    await Promise.race([conn.send('Browser.close').catch(() => { /* already gone */ }), sleep(EXIT_SETTLE_MS)]);
    conn.ws.close();
    proc.kill();
    await sleep(EXIT_SETTLE_MS);
    try { rmSync(profile.dir, { recursive: true, force: true }); } catch { /* the browser may still hold a file; it is a temp folder */ }
  }

  return { browserPath: exe, send: conn.send, openPage, serviceWorker, downloads, downloadDir: profile.downloads, close };
}

/**
 * An init script that makes an extension page opened as a tab treat `url*` as the
 * active tab — opened as a tab, the popup would see itself and show "Not available".
 */
export function asActiveTab(url) {
  return `{ const query = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = (q, cb) => {
    const real = q && q.active && q.currentWindow ? { url: ${JSON.stringify(url + '*')} } : q;
    return cb ? query(real, cb) : query(real);
  }; }`;
}
