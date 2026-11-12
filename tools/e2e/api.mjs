/**
 * tools/e2e/api.mjs — e2e: the api suite. Run by tools/e2e.mjs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from '../lib/cdp-browser.mjs';
import { EXT, PAGE_SETTLE_MS, check, fail, failures } from './harness.mjs';

/** JSON endpoints under /api/ for the API Tests page (apitest.html). */
/** The token /api/login gave last: /api/me takes only that one. */
let apiToken = null;
/** The paths requested under /api/, in order: which requests a run sent. */
const apiHits = [];

export function apiRoute(req, reply) {
  const url = new URL(req.url, 'http://x');
  const json = (status, data) => { reply.writeHead(status, { 'content-type': 'application/json' }); reply.end(JSON.stringify(data)); };
  apiHits.push(url.pathname);
  req.resume();
  req.on('end', () => {
    if (url.pathname === '/api/slow') setTimeout(() => json(200, { slow: true }), 1500);
    else if (url.pathname === '/api/orders/42') json(200, { data: { id: 42, status: 'PAID', items: [{ id: 'a1' }, { id: 'a2' }] } });
    else if (url.pathname === '/api/html') { reply.writeHead(200, { 'content-type': 'text/html' }); reply.end('<p>not JSON</p>'); }
    else if (url.pathname === '/api/fail') json(500, { error: 'boom' });
    else if (url.pathname === '/api/echo') json(200, { headers: req.headers, url: req.url });
    else if (url.pathname === '/api/login') json(200, { token: (apiToken = `tok-${Math.random().toString(36).slice(2, 8)}`) });
    else if (url.pathname === '/api/me') {
      if (apiToken && req.headers.authorization === `Bearer ${apiToken}`) json(200, { user: 'an' });
      else json(401, { error: 'sign in first' });
    } else json(404, { error: 'not found' });
  });
}

/** Helpers for an apitest.html page, prepended to each evaluated script. */
const API_PAGE_HELPERS = `
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const type = (n, v) => { n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); };
  const btn = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(text));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await wait(50); } return null; };
  const send = async () => { $('.ac-send').click(); await wait(50); return until(() => !$('.ac-send').disabled && $('.ac-verdict')); };
  const verdict = () => $('.ac-verdict')?.textContent || '';
  const tab = (name) => btn($('.ac-tabs'), name).click();
  const marks = () => $$('.ac-check .ac-mark').map((m) => m.textContent).join('');
`;

export async function checkApiTests(ctx) {
  const page = await ctx.browser.openPage(ctx.extUrl('apitest.html'), { width: 1400, height: 900 });
  const ev = (js) => page.evaluate(`(async () => { ${API_PAGE_HELPERS} ${js} })()`, 20_000);
  // The Tools tab's variables, put back afterwards: this check adds one.
  const dataVars = await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('variables', (x) => r(x.variables || null)))`);
  try {
    await sleep(PAGE_SETTLE_MS);
    await ev(`btn($('#listHead'), '＋ Request').click(); await wait(50);
      type($('.ac-url'), ${JSON.stringify(`${ctx.base}/api/orders/42`)}); await send();`);
    check((await ev('return verdict();')).startsWith('✓ Passed'), 'a 200 with no checks passes on the default 2xx', await ev('return verdict();'));
    check((await ev(`return $$('.ac-jkey').map((k) => k.textContent).join(',');`)) === '"data","id","status","items","id","id"', 'the JSON keys are buttons');

    // A key clicked in the response becomes a check.
    await ev(`$$('.ac-jkey')[2].click(); await wait(30); btn($('.ac-keymenu'), 'Check equals').click(); await wait(30); tab('Checks');`);
    const row = await ev(`return { on: $('.ac-check:not(.ac-check-default) select').value, path: $('.ac-check-path').value, value: $('.ac-check-value').value, count: $('.ac-tabs [data-k="checks"] .rtab-n').textContent };`);
    check(row.on === 'json' && row.path === 'data.status' && row.value === 'PAID' && row.count === '1', 'clicking "status" adds the check data.status = PAID', row);
    await ev('await send();');
    check((await ev('return verdict();')).startsWith('✓ Passed') && (await ev('return marks();')) === '✓✓', 'Send: both checks hold, each row marked ✓', await ev('return marks();'));

    // Expect something else: ✗ Failed, with what came back.
    await ev(`type($('.ac-check-value'), 'PENDING'); await wait(20);`);
    check((await ev('return marks();')) === '✓', 'an edited check loses its mark', await ev('return marks();'));
    await ev('await send();');
    const failed = await ev(`return { v: verdict(), marks: marks(), note: $$('.ac-check-note').map((n) => n.textContent).join('|') };`);
    check(failed.v.startsWith('✗ Failed') && failed.v.includes('Expected data.status = "PENDING", got "PAID"') && failed.marks === '✓✗',
      'a false check: ✗ Failed, the row says what came back', failed);

    // A JSON check on an HTML page cannot run: the test is broken, not the app.
    await ev(`type($('.ac-url'), ${JSON.stringify(`${ctx.base}/api/html`)}); await send();`);
    check((await ev('return verdict();')).includes('The response is not JSON'), 'a JSON check on HTML: ⚠ Test broken', await ev('return verdict();'));
    check((await ev('return verdict();')).startsWith('⚠'), 'it is marked ⚠', await ev('return verdict();'));

    // A second check, dragged above the first.
    await ev(`btn($('.ac-pane-foot'), '＋ Add check').click(); await wait(20);
      const sel = $$('.ac-check:not(.ac-check-default) .ac-check-line > select')[2];
      sel.value = 'body'; sel.dispatchEvent(new Event('change', { bubbles: true })); await wait(20);
      type($$('.ac-check-value')[1], 'not JSON');
      const dt = new DataTransfer();
      $$('.ac-handle')[1].dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
      const first = $$('.ac-check:not(.ac-check-default)')[0];
      first.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      first.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      await wait(30);`);
    check((await ev(`return $$('.ac-check:not(.ac-check-default) .ac-check-line > select:first-of-type').map((s) => s.value).join(',');`)) === 'body,json',
      'dragging a check above another reorders them');

    // Headers as a table: typed into the empty row, one unticked, one added in a click.
    await ev(`type($('.ac-url'), ${JSON.stringify(`${ctx.base}/api/echo`)}); tab('Headers'); await wait(20);
      // The empty row at the end, taken before typing: typing in it adds the next one.
      const fill = (name, value) => { const i = $$('.ac-hdr-item').at(-1).querySelectorAll('input'); type(i[1], name); type(i[2], value); };
      fill('X-Team', 'qa');
      fill('X-Off', '1');
      $$('.ac-hdr-item')[1].querySelector('input[type=checkbox]').click();
      btn($('.ac-hdr-quick'), '＋ Accept JSON').click(); await wait(20);
      await send();`);
    const echoed = JSON.parse(await ev(`return $('pre.ac-pre').textContent;`)).headers;
    check(echoed['x-team'] === 'qa' && echoed.accept === 'application/json' && !('x-off' in echoed),
      'Headers table: a typed header and a one-click one are sent, an unticked one is not', echoed);

    // Header names and values offered in the page's own list, right under the
    // field — a <datalist> was drawn off to the side by the browser.
    await page.bringToFront();
    const offer = await ev(`const list = () => { const l = $('#varSuggest'); return l && !l.hidden ? l : null; };
      const names = () => [...(list()?.querySelectorAll('.vs-name') || [])].map((n) => n.textContent).join(',');
      const key = (n, k) => n.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      const [, name, value] = $$('.ac-hdr-item').at(-1).querySelectorAll('input');
      name.focus(); await wait(60); document.execCommand('insertText', false, 'acc'); await wait(60);
      const offeredNames = names(); key(name, 'ArrowDown'); key(name, 'Enter'); await wait(30);
      value.focus(); await wait(60);
      const a = value.getBoundingClientRect(); const b = list()?.getBoundingClientRect();
      const out = { offeredNames, name: name.value, offeredValues: names(), dx: b && Math.round(b.left - a.left), dy: b && Math.round(b.top - a.bottom) };
      key(value, 'Escape'); btn(name.closest('.ac-hdr-row'), '✕').click(); await wait(20);
      return out;`);
    check(offer.offeredNames === 'Accept,Accept-Language' && offer.name === 'Accept' && offer.offeredValues.startsWith('application/json,*/*')
      && offer.dx === 0 && offer.dy === 2, 'Headers: names and values are offered in a list right under the field', offer);

    // Variable suggestions: ${ in the URL lists the Tools tab's variables, Enter writes one.
    // e2eApiPin is stored as the Tools tab stores a Random: a config object, not text.
    await page.evaluate(`new Promise((r) => chrome.storage.local.set({ variables: { ...(${JSON.stringify(dataVars || {})}),
      e2eApiBase: ${JSON.stringify(ctx.base)}, e2eApiPin: { activeType: 'r', r: { type: 'numeric', length: 4 } } } }, r))`);
    const listed = await ev(`$('#btnEnvs').click(); await wait(150);
      const row = $$('.ac-env-data-row').find((r) => r.querySelector('code').textContent === 'e2eApiPin');
      const text = row?.querySelector('.ac-env-data-value')?.textContent ?? row?.textContent;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(30);
      return text;`);
    check(listed === 'R4 digits', 'the Environments dialog shows a Tools tab Random as "4 digits", not [object Object]', listed);
    await page.bringToFront();
    const picked = await ev(`const u = $('.ac-url'); u.focus(); await wait(60); u.select();
      document.execCommand('insertText', false, '\${e2eApi'); await wait(100);
      const offered = [...document.querySelectorAll('#varSuggest:not([hidden]) .vs-name')].map((n) => n.textContent).join(',');
      u.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await wait(60);
      return { offered, url: u.value };`);
    check(picked.offered === 'e2eApiBase,e2eApiPin' && picked.url === '${e2eApiBase}', 'typing ${ in the URL offers the variables and Enter writes the first', picked);

    // Kept across a reload.
    await sleep(800);
    await page.reload();
    await sleep(PAGE_SETTLE_MS);
    const kept = await ev(`$$('.ac-row')[0].click(); await wait(50); tab('Checks'); return $$('.ac-check:not(.ac-check-default)').map((r) => r.querySelector('select').value + ':' + (r.querySelector('.ac-check-value')?.value ?? '')).join(',');`);
    check(kept === 'body:not JSON,json:PENDING', 'the checks are kept when the page is opened again', kept);
    if (page.errors().length) fail(`apitest.html errors: ${page.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('apiCasesState')`);
    await ctx.ext.evaluate(dataVars ? `chrome.storage.local.set({ variables: ${JSON.stringify(dataVars)} })` : `chrome.storage.local.remove('variables')`);
    await page.close();
  }
}

/** API Tests: two environments, a token login saves and the folder's Bearer auth sends, the other auth kinds. */
export async function checkApiVars(ctx) {
  const page = await ctx.browser.openPage(ctx.extUrl('apitest.html'), { width: 1400, height: 900 });
  const ev = (js) => page.evaluate(`(async () => { ${API_PAGE_HELPERS} ${js} })()`, 20_000);
  const other = ctx.base.replace('127.0.0.1', 'localhost');
  const kase = (id, name, method, path, more = {}) => ({
    id, folderId: 'f1', name, method, url: `\${e2eBase}${path}`, headers: '', bodyType: 'none', body: '',
    timeoutMs: 10_000, cookies: false, checks: [], extracts: [], auth: { type: 'inherit' }, ...more,
  });
  const state = {
    folders: [{ id: 'f1', name: 'Users', auth: { type: 'none' } }],
    cases: [
      // Login runs before the token exists: it does not take the folder's auth.
      kase('login', 'Login', 'POST', '/api/login', { auth: { type: 'none' }, extracts: [{ varName: 'e2eToken', from: 'json', path: 'token' }] }),
      kase('me', 'Me', 'GET', '/api/me'),
      kase('echo', 'Echo', 'GET', '/api/echo?a=1'),
    ],
    environments: [
      { id: 'dev', name: 'Dev', vars: [{ name: 'e2eBase', value: ctx.base }] },
      { id: 'stg', name: 'Staging', vars: [{ name: 'e2eBase', value: other }] },
    ],
    envId: 'dev', folderId: 'f1', caseId: 'echo',
  };
  const open = (name) => `$$('.ac-row').find((r) => r.textContent.includes(${JSON.stringify(name)})).click(); await wait(60);`;
  const echoed = async () => JSON.parse(await ev(`await send(); return $('pre.ac-pre').textContent;`));
  const pickAuth = (type) => `tab('Auth'); const sel = $('.ac-auth select'); sel.value = '${type}'; sel.dispatchEvent(new Event('change', { bubbles: true })); await wait(20);`;
  const field = (label, value) => `type($('.ac-auth input[aria-label="${label}"]'), ${JSON.stringify(value)});`;
  const useEnv = (id) => ev(`const s = $('#envSelect'); s.value = '${id}'; s.dispatchEvent(new Event('change', { bubbles: true })); await wait(30);`);
  try {
    await page.evaluate(`new Promise((r) => chrome.storage.local.set({ apiCasesState: ${JSON.stringify(state)} }, r))`);
    await page.reload();
    await sleep(PAGE_SETTLE_MS);
    await page.bringToFront();

    // One request, two environments: the same ${e2eBase} goes to another host.
    const dev = (await echoed()).headers.host;
    await useEnv('stg');
    const stg = (await echoed()).headers.host;
    await useEnv('dev');
    check(dev === new URL(ctx.base).host && stg === new URL(other).host, 'switching the environment sends the request to the other host', { dev, stg });

    // A name typed in the editor stays when another folder is clicked: the
    // folder list, drawn before the typing, must not put its older state back.
    const renamed = await ev(`type($('.ac-name'), 'Echo back'); await wait(20);
      $$('.ac-folder')[0].click(); await wait(60); $$('.ac-folder')[1].click(); await wait(60);
      return $$('.ac-row-name').map((n) => n.textContent).join(',');`);
    check(renamed === 'Login,Me,Echo back', 'what was typed stays when another folder is clicked', renamed);

    // The folder signs in with Bearer ${e2eToken}; login saves the token, /me inherits the auth.
    await ev(`btn($('#listHead'), '🔑 Auth').click(); await wait(30);
      const d = $('.ac-auth-dialog'); const sel = d.querySelector('select');
      sel.value = 'bearer'; sel.dispatchEvent(new Event('change', { bubbles: true })); await wait(20);
      type(d.querySelector('input[aria-label="Token"]'), '\${e2eToken}');
      btn(d, '✕').click(); await wait(60);`);
    const flow = await ev(`const label = btn($('#listHead'), '🔑 Auth').textContent;
      ${open('Login')} await send(); const login = verdict();
      ${open('Me')} await send(); const me = verdict();
      tab('Auth'); const inherit = $('.ac-auth select').selectedOptions[0].textContent;
      return { label, login, me, inherit };`);
    check(flow.label === '🔑 Auth: Bearer' && flow.inherit === 'Inherit from folder (Users: Bearer)', 'the folder\'s auth is set in its dialog and shown on its requests', flow);
    check(flow.login.startsWith('✓ Passed') && flow.me.startsWith('✓ Passed'), 'login saves ${e2eToken}; /me is sent with it through the folder\'s Bearer auth', flow);

    // Copy cURL writes the folder's auth too.
    const copied = await ev(`let text = ''; navigator.clipboard.writeText = async (t) => { text = t; };
      btn($('.ac-insp-sub'), 'Copy cURL').click(); await wait(60); return text;`);
    check(/-H 'Authorization: Bearer tok-\w+'/.test(copied), 'Copy cURL has the folder\'s Bearer auth', copied);

    // A case set to None is sent without it.
    await ev(`${pickAuth('none')} await send();`);
    check((await ev('return verdict();')).startsWith('✗ Failed'), 'a case whose Auth is None is sent without the folder\'s: 401', await ev('return verdict();'));

    // Basic, UTF-8: an / pá.
    await ev(`${open('Echo')} ${pickAuth('basic')} ${field('Username', 'an')} ${field('Password', 'pá')}`);
    const basic = (await echoed()).headers.authorization;
    check(basic === 'Basic YW46cMOh', 'Basic an / pá is sent as Basic YW46cMOh', basic);

    // An API key in the query, after the query the URL has.
    await ev(`${pickAuth('apikey')} ${field('Name', 'api_key')} ${field('Value', 'k 1')}
      const where = $('.ac-auth select[aria-label="Add to"]'); where.value = 'query'; where.dispatchEvent(new Event('change', { bubbles: true }));`);
    const key = (await echoed()).url;
    check(key === '/api/echo?a=1&api_key=k%201', 'an API key in the query is added to the URL\'s', key);

    // A header written in the Headers tab wins, and the Auth tab says so.
    await ev(`${pickAuth('bearer')} ${field('Token', 'theirs')} tab('Headers');
      const [, n, v] = $$('.ac-hdr-item').at(-1).querySelectorAll('input'); type(n, 'Authorization'); type(v, 'Bearer mine'); await wait(20);`);
    const note = await ev(`tab('Auth'); const n = $('.ac-auth-note'); return n.hidden ? '' : n.textContent;`);
    const mine = (await echoed()).headers.authorization;
    check(mine === 'Bearer mine' && note.startsWith('The Headers tab sets Authorization'), 'a header written by hand wins over the auth, and the Auth tab says so', { mine, note });

    // Kept across a reload.
    await sleep(800);
    await page.reload();
    await sleep(PAGE_SETTLE_MS);
    const kept = await ev(`return btn($('#listHead'), '🔑 Auth')?.textContent;`);
    check(kept === '🔑 Auth: Bearer', 'the folder\'s auth is kept when the page is opened again', kept);
    // The 401 of /me sent without auth is logged by the browser; it is meant.
    const errors = page.errors().filter((e) => !e.includes('/api/me'));
    if (errors.length) fail(`apitest.html errors: ${errors.join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('apiCasesState')`);
    await page.close();
  }
}

/** API Tests: a folder run, asked first when it writes; Stop; Run selected; ▶ on a row; results kept. */
export async function checkApiRun(ctx) {
  const page = await ctx.browser.openPage(ctx.extUrl('apitest.html'), { width: 1400, height: 900 });
  const kase = (id, name, path, more = {}) => ({
    id, folderId: 'shop', name, method: 'GET', url: `\${e2eBase}${path}`, headers: '', bodyType: 'none', body: '',
    timeoutMs: 10_000, cookies: false, checks: [], extracts: [], auth: { type: 'inherit' }, ...more,
  });
  const status = (expected) => ({ on: 'json', path: 'data.status', op: 'equals', expected });
  const state = {
    folders: [{ id: 'shop', name: 'Shop', auth: { type: 'bearer', token: '${e2eRunToken}' } }, { id: 'slow', name: 'Slow', auth: { type: 'none' } }],
    cases: [
      kase('login', 'Login', '/api/login', { method: 'POST', auth: { type: 'none' }, extracts: [{ varName: 'e2eRunToken', from: 'json', path: 'token' }] }),
      kase('order', 'Order paid', '/api/orders/42', { checks: [status('PAID')] }),
      kase('wrong', 'Order pending', '/api/orders/42', { checks: [status('PENDING')] }),
      // Sent on its own before login: it does not take the folder's ${e2eRunToken}.
      kase('fail', 'Server error', '/api/fail', { auth: { type: 'none' } }),
      kase('timeout', 'Too slow', '/api/slow', { timeoutMs: 300 }),
      kase('html', 'Not JSON', '/api/html', { checks: [{ on: 'json', path: 'id', op: 'exists' }] }),
      kase('me', 'Me', '/api/me'),
      kase('s1', 'Slow one', '/api/slow', { folderId: 'slow' }),
      kase('s2', 'Slow two', '/api/slow', { folderId: 'slow',
        last: { at: 1000, verdict: 'failed', status: 500, ms: 9, failures: [{ kind: 'assert', reason: 'Expected status 2xx, got 500' }], bodyHead: '', sent: null } }),
    ],
    environments: [{ id: 'dev', name: 'Dev', vars: [{ name: 'e2eBase', value: ctx.base }] }],
    envId: 'dev', folderId: 'shop', caseId: 'order',
  };
  const H = `${API_PAGE_HELPERS}
    const rowMarks = () => $$('.ac-row .ac-row-mark').map((m) => m.textContent).join('');
    // A run that started ends with a toast: "Ran 7: …" or "Stopped after …".
    const finished = () => until(() => !$('#toast').hidden && /^(Ran|Stopped)/.test($('#toast').textContent), 20000);
    const start = (button) => { $('#toast').hidden = true; button.click(); };
    const asking = () => !$('#askModal').hidden;
    const row = (name) => $$('.ac-row').find((r) => r.querySelector('.ac-row-name').textContent === name);`;
  const run = (js) => page.evaluate(`(async () => { ${H} ${js} })()`, 30_000);
  const hits = () => apiHits.splice(0);
  try {
    await page.evaluate(`new Promise((r) => chrome.storage.local.set({ apiCasesState: ${JSON.stringify(state)} }, r))`);
    await page.reload();
    await sleep(PAGE_SETTLE_MS);
    await page.bringToFront();
    hits();

    // The folder has a POST: asked first, naming it and its host; Cancel sends nothing.
    const asked = await run(`btn($('#runBar'), '▶ Run folder').click(); await until(asking, 3000);
      const text = $('#askText').textContent; $('#askCancel').click(); await wait(100); return { text, marks: rowMarks() };`);
    check(asked.text.startsWith(`Send 1 POST to ${new URL(ctx.base).host}?`) && asked.marks === '·······' && !hits().length,
      'a folder with a POST is asked about first; Cancel sends nothing', asked);

    // ▶ on a row sends that one from the list, without asking or opening it.
    const one = await run(`row('Server error').querySelector('.ac-row-run').click();
      await until(() => rowMarks() !== '·······'); return { marks: rowMarks(), open: $('.ac-name').value, asked: asking() };`);
    check(one.marks === '···✗···' && one.open === 'Order paid' && !one.asked && hits().join() === '/api/fail',
      '▶ on a row sends it, shows its ✗ in the list, and the open request stays open', one);

    // OK: one at a time, in order; login's token reaches /me through the folder's Bearer auth.
    const ran = await run(`const seen = [];
      const mo = new MutationObserver(() => { const t = $('#runBar .ac-stop') && $('#runBar .ac-run-text')?.textContent; if (t && seen.at(-1) !== t) seen.push(t); });
      mo.observe($('#runBar'), { childList: true, subtree: true });
      start(btn($('#runBar'), '▶ Run folder')); await until(asking, 3000); $('#askOk').click(); await finished(); mo.disconnect();
      return { during: seen, marks: rowMarks(), bar: $('#runBar .ac-run-text').textContent, verdict: verdict(),
        fail: row('Server error').querySelector('.ac-row-fail')?.textContent, toast: $('#toast').textContent };`);
    check(ran.during[0] === 'Running 1 of 7' && ran.during.includes('Running 7 of 7 · 2 passed · 2 failed · 2 broken'), 'the bar says how far the run is', ran.during);
    check(ran.marks === '✓✓✗✗⚠⚠✓', 'a folder run: right, wrong check, 500, timeout, JSON check on HTML, login → me come to ✓ ✓ ✗ ✗ ⚠ ⚠ ✓', ran);
    check(hits().join() === '/api/login,/api/orders/42,/api/orders/42,/api/fail,/api/slow,/api/html,/api/me', 'the requests are sent in list order');
    check(/^Last run \S+.* · 3 passed · 2 failed · 2 broken$/.test(ran.bar) && ran.toast === 'Ran 7: 3 passed · 2 failed · 2 broken',
      'the bar sums up the last run; a toast when it ends', ran);
    check(ran.verdict.startsWith('✓ Passed') && ran.fail === 'Expected status 2xx, got 500', 'the open request shows its result; a row shows its first failure', ran);

    // Filtered by result.
    const failed = await run(`const s = $('#listResult'); s.value = 'failed'; s.dispatchEvent(new Event('change')); await wait(30);
      const names = $$('.ac-row-name').map((n) => n.textContent).join(','); const label = btn($('#runBar'), '▶').textContent;
      s.value = ''; s.dispatchEvent(new Event('change')); await wait(30); return { names, label };`);
    check(failed.names === 'Order pending,Server error' && failed.label === '▶ Run 2 shown', 'the list filters by last result; Run then runs the ones shown', failed);

    // Run selected: only the ticked ones, in list order, and GETs are not asked about.
    const picked = await run(`row('Me').querySelector('input[type=checkbox]').click(); row('Order paid').querySelector('input[type=checkbox]').click(); await wait(20);
      start(btn($('#listBulk'), '▶ Run selected')); await wait(50); const askedNow = asking(); await finished(); return { askedNow, marks: rowMarks() };`);
    check(!picked.askedNow && picked.marks === '✓✓✗✗⚠⚠✓' && hits().join() === '/api/orders/42,/api/me', 'Run selected sends only the ticked requests, GETs without asking', picked);

    // A GET-only folder runs without asking; ⏹ lets the request on its way finish and sends no more.
    const stopped = await run(`$$('.ac-folder')[2].click(); await wait(60); start(btn($('#runBar'), '▶ Run folder')); await wait(300);
      const askedNow = asking(); btn($('#runBar'), '⏹ Stop').click(); await wait(20); const stopping = $('#runBar .ac-stop')?.textContent;
      await finished(); return { askedNow, stopping, marks: rowMarks(), toast: $('#toast').textContent };`);
    check(!stopped.askedNow && stopped.stopping === 'Stopping…' && stopped.marks === '✓✗' && hits().join() === '/api/slow'
      && stopped.toast.startsWith('Stopped after 1 of 2'), '⏹ Stop: the request on its way finishes, the next keeps its old result', stopped);

    // Kept across a reload: marks, the bar, the start of a body — secret values masked.
    await sleep(800);
    await page.reload();
    await sleep(PAGE_SETTLE_MS);
    const kept = await run(`$$('.ac-folder')[1].click(); await wait(60); row('Login').click(); await wait(60);
      return { marks: rowMarks(), bar: $('#runBar .ac-run-text').textContent, meta: $('.ac-resp-meta').textContent, body: $('.ac-response pre')?.textContent || '' };`);
    check(kept.marks === '✓✓✗✗⚠⚠✓' && kept.bar.endsWith('· 3 passed · 2 failed · 2 broken'), 'the results and the bar are kept when the page is opened again', kept);
    check(kept.meta.startsWith('200') && kept.meta.includes('Last run') && kept.body.includes('"token": "••••"'), 'the last result shows the start of its body, the token masked', kept);
    const saved = await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('apiCasesState', (x) => r(JSON.stringify(x.apiCasesState.cases.map((c) => c.last)))))`);
    check(apiToken && !saved.includes(apiToken), 'no token value in the kept results', saved.slice(0, 200));
    // The 500 and the request aborted on its timeout are logged by the browser; they are meant.
    const errors = page.errors().filter((e) => !e.includes('/api/'));
    if (errors.length) fail(`apitest.html errors: ${errors.join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('apiCasesState')`);
    await page.close();
  }
}

/**
 * API Tests and Postman: a folder exported (a secret header left blank), imported back
 * into an empty page and run as before; a collection written in Postman shows the hosts
 * its requests go to before anything is added.
 */
export async function checkApiPostman(ctx) {
  const page = await ctx.browser.openPage(ctx.extUrl('apitest.html'), { width: 1400, height: 900 });
  const kase = (id, name, path, more = {}) => ({
    id, folderId: 'shop', name, method: 'GET', url: `\${e2eBase}${path}`, headers: '', bodyType: 'none', body: '',
    timeoutMs: 10_000, cookies: false, checks: [], extracts: [], auth: { type: 'inherit' }, ...more,
  });
  const status = (expected) => ({ on: 'json', path: 'data.status', op: 'equals', expected });
  const cases = [
    kase('login', 'Login', '/api/login', { method: 'POST', auth: { type: 'none' }, bodyType: 'json', body: '{"user": "an"}',
      extracts: [{ varName: 'e2ePmToken', from: 'json', path: 'token' }] }),
    kase('order', 'Order paid', '/api/orders/42', { headers: 'X-Api-Key: live-key-123',
      checks: [status('PAID'), { on: 'json', path: 'data.items[-1].id', op: 'equals', expected: 'a2' }] }),
    kase('wrong', 'Order pending', '/api/orders/42', { checks: [status('PENDING')], timeoutMs: 5000 }),
    kase('me', 'Me', '/api/me'),
  ];
  const envs = { environments: [{ id: 'dev', name: 'Dev', vars: [{ name: 'e2eBase', value: ctx.base }] }], envId: 'dev' };
  const seed = async (state) => {
    await page.evaluate(`new Promise((r) => chrome.storage.local.set({ apiCasesState: ${JSON.stringify(state)} }, r))`);
    await page.reload();
    await sleep(PAGE_SETTLE_MS);
  };
  const H = `${API_PAGE_HELPERS}
    const rowMarks = () => $$('.ac-row .ac-row-mark').map((m) => m.textContent).join('');
    const pick = async (name, text) => {
      btn($('#listHead'), 'Import').click(); await wait(60);
      const input = $('.ac-import input[type=file]');
      const dt = new DataTransfer(); dt.items.add(new File([text], name, { type: 'application/json' }));
      input.files = dt.files; input.dispatchEvent(new Event('change'));
      await until(() => $('.ac-import-info').childElementCount || !$('.ac-import .ac-field-error').hidden, 3000);
    };`;
  const run = (js) => page.evaluate(`(async () => { ${H} ${js} })()`, 30_000);
  const fixturePath = join(EXT, 'tests', 'fixtures', 'postman-sample.json');
  try {
    await seed({ folders: [{ id: 'shop', name: 'Shop', auth: { type: 'bearer', token: '${e2ePmToken}' } }], cases, ...envs, folderId: 'shop', caseId: null });
    await page.bringToFront();

    // Export ▾ → Postman collection: the file chrome.downloads is handed, caught here.
    const out = await run(`let got = null;
      chrome.downloads.download = (o, cb) => { got = o; if (cb) cb(1); };
      btn($('#listHead'), 'Export').click(); await wait(60); $('.ac-menu button').click();
      await until(() => got, 3000);
      return { file: got.filename, text: await (await fetch(got.url)).text(), toast: $('#toast').textContent };`);
    const col = JSON.parse(out.text || '{}');
    check(out.file === 'Shop.postman_collection.json' && col.info?.schema === 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      'Export ▾ → Postman collection saves a v2.1 collection named after the folder', { file: out.file, info: col.info });
    check(!out.text.includes('live-key-123') && out.text.includes('{{e2ePmToken}}') && out.text.includes('{{e2eBase}}/api/login')
      && out.toast.includes('left blank: Order paid: X-Api-Key header'), 'a secret written out is left blank and named; ${x} is {{x}}', out.toast);

    // Into an empty page (the environment kept): the same folder, cases, checks and saved values; then run.
    await seed({ folders: [], cases: [], ...envs, folderId: '__all__', caseId: null });
    const back = await run(`await pick('Shop.postman_collection.json', ${JSON.stringify(out.text || '')});
      return { hosts: $$('.ac-host').map((x) => x.textContent), notes: $$('.ac-import-notes li').length, env: !!$('.ac-import-env') };`);
    check(back.hosts.join() === '${e2eBase}' && !back.notes && !back.env, 'importing an exported folder: its host, nothing left out', back);
    await run(`btn($('.ac-import'), 'Add').click(); await wait(700);`);
    const saved = await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('apiCasesState', (x) => r(x.apiCasesState)))`);
    const strip = (c) => ({ name: c.name, method: c.method, url: c.url, body: c.body, auth: c.auth, checks: c.checks, extracts: c.extracts, timeoutMs: c.timeoutMs, cookies: c.cookies });
    // Keys in any order: storage does not keep the order they were written in.
    const sortedKeys = (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v);
    const same = (a, b) => JSON.stringify(a, sortedKeys) === JSON.stringify(b, sortedKeys);
    check(same(saved.folders.map((f) => [f.name, f.auth]), [['Shop', { type: 'bearer', token: '${e2ePmToken}' }]]) && same(saved.cases.map(strip), cases.map(strip)),
      'exported, then imported: the same folder, auth, requests, checks and saved values', saved.cases.map(strip));
    const ran = await run(`btn($('#runBar'), '▶ Run folder').click(); await until(() => !$('#askModal').hidden, 3000); $('#askOk').click();
      await until(() => /^Ran /.test($('#toast').textContent), 15000); return rowMarks();`);
    check(ran === '✓✓✗✓', 'the imported folder runs as the exported one did: login → token → me', ran);
    const csv = await run(`let got = null;
      chrome.downloads.download = (o, cb) => { got = o; if (cb) cb(1); };
      btn($('#listHead'), 'Export').click(); await wait(60); $$('.ac-menu button').at(-1).click();
      await until(() => got, 3000);
      return { file: got.filename, text: await (await fetch(got.url)).text() };`);
    const lines = csv.text.split('\r\n');
    check(/^Shop results \d{4}-\d\d-\d\d\.csv$/.test(csv.file) && lines[0].endsWith('"Folder","Name","Method","URL","Result","Status","Time (ms)","Failed checks","Ran at"')
      && lines.length === 6 && lines[1].startsWith('"Shop","Login","POST"') && lines[1].includes('"Passed","200"') && lines[3].includes('"Failed","200"')
      && !csv.text.includes(apiToken), 'Export ▾ → Results saves a CSV: a row per request with its last result, no token', { file: csv.file, text: csv.text.slice(0, 400) });

    // A collection written in Postman: the hosts and what is left out, before Add; Cancel adds nothing.
    if (!existsSync(fixturePath)) fail(`no ${fixturePath}`);
    else {
      const pm = await run(`await pick('shop.json', ${JSON.stringify(readFileSync(fixturePath, 'utf8'))});
        const r = { hosts: $$('.ac-host').map((x) => x.textContent), notes: $$('.ac-import-notes li').length, summary: $('.ac-import-info p').textContent };
        btn($('.ac-import'), 'Cancel').click(); await wait(60); r.folders = $$('.ac-folder').length; return r;`);
      check(pm.hosts.join() === 'shop.example.com,auth.partner.test,admin.shop.example.com' && pm.notes === 7 && pm.summary === 'Shop API — 4 folders, 7 requests',
        'a Postman collection shows where its requests go and what is left out before Add', pm);
      check(pm.folders === 2, 'Cancel adds nothing (All requests and Shop only)', pm.folders);
    }
    const errors = page.errors().filter((e) => !e.includes('/api/'));
    if (errors.length) fail(`apitest.html errors: ${errors.join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('apiCasesState')`);
    await page.close();
  }
}

export const CHECKS = [
  ['api-tests', 'API Tests: Send, checks from a clicked key, verdicts', checkApiTests],
  ['api-vars', 'API Tests: environments, a saved token, folder auth', checkApiVars],
  ['api-run', 'API Tests: run a folder, ask before writes, Stop, results kept', checkApiRun],
  ['api-postman', 'API Tests: Postman export, import back and run, a Postman collection\'s hosts', checkApiPostman],
];
