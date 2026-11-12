/**
 * tools/e2e/export-run.mjs — e2e suite "export-run". Run: node tools/e2e.mjs --suite export-run
 *
 * Exported code run on a page (bookmarklet, Selenium, pytest, Playwright, Robot, Java),
 * as playback leaves it.
 *
 *   export-run    each scenario of EXPORT_CASES, played, run as the exported bookmarklet
 *                 and run as the exported Selenium script (python, Edge exported
 *                 headless — with a window under --headed),
 *                 leaves the export page the same way; the form case runs as the
 *                 exported pytest test too, and a pytest test with a failing step
 *                 names it; every case runs as the exported Playwright .spec.js too
 *                 (PQA_PLAYWRIGHT_DIR: a folder with @playwright/test), and every case
 *                 the Selenium script runs as the exported Robot Framework test too
 *                 (PQA_ROBOT_PYTHON: a python with robotframework-seleniumlibrary) and as
 *                 the exported Java TestNG class (PQA_JAVA_HOME: a JDK; PQA_JAVA_LIBS: a
 *                 folder of the selenium-java and testng jars).
 *                 No python, selenium, pytest, Playwright, Robot or Java: those runs are skipped,
 *                 not failed. fails-at-step: a scenario whose step 3 finds nothing,
 *                 run by each export, has its error name the step, its label and the
 *                 locator
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sleep } from '../lib/cdp-browser.mjs';
import { EXT, HEADED, PAGE_SETTLE_MS, PLAY_TIMEOUT_MS, POLL_MS, SETTLE_MS, argValue, args, check, exportStates, fail, makeScenario, ok, play, pngSize } from './harness.mjs';
const CASES = argValue('--cases')?.split(',') || null;

/**
 * The page export-run plays on, at /export?run=<key>. Whatever its form holds —
 * every input, select, textarea and contenteditable with an id (a checkbox by
 * whether it is ticked) — plus the other elements with an id clicked, the alerts
 * shown and the marks its widgets set (events a page may wait for) is POSTed
 * to /state on every change, so a run in a browser the harness does not drive
 * (the Selenium script's own Edge) is read the same way as one it does.
 * A new element with an id is in the state as soon as it is on the page.
 */
export const EXPORT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>export</title></head>
<body>
<input id="name">
<select id="color"><option value="">-</option><option value="r">Red</option><option value="g">Green</option></select>
<label><input type="checkbox" id="agree"> Agree</label>
<span id="code">ORD-42</span>
<input id="echo">
<button id="submit">Submit</button><button id="after">After</button><button id="never">Never</button>
<div id="people">
  <div class="row"><span id="nameAlice">Alice</span> <button id="editAlice" class="edit">Edit</button></div>
  <div class="row"><span id="nameBob">Bob <i id="tagBob">VIP</i></span> <button id="editBob" class="edit special">Edit</button></div>
  <span id="note" style="display:none">ref 7731</span>
  <span id="ownTxt">Hello<b id="ownB">x</b>World</span>
</div>
<input id="picked">
<div id="conds">
  <div id="tagged" data-id="5">tagged</div>
  <div id="fixedBox" style="position:fixed;top:0;right:0;width:40px;height:20px">fixed</div>
  <div id="ghost" style="opacity:0">ghost</div>
  <div id="note2">Note <span style="display:none">secret</span></div>
  <div id="total">  Total: 42  </div>
  <button id="c1">c1</button><button id="c2">c2</button><button id="c3">c3</button>
  <button id="c4">c4</button><button id="c5">c5</button><button id="c6">c6</button>
</div>
<div id="acts">
  <div id="mdBtn">press</div>
  <div id="hoverMenu">menu</div>
  <div id="rich" contenteditable="true" style="min-height:20px;border:1px solid"></div>
  <input id="blurField">
  <div id="dragSrc" draggable="true">drag</div><div id="dropZone" style="min-height:30px">drop here</div>
  <button id="done">done</button>
  <input type="date" id="when"><input type="time" id="at"><input type="color" id="shade">
</div>
<div id="locs">
  <button id="okA">okA</button><button id="okB">okB</button>
  <button id="okCancel">OK Cancel</button> <button id="okBtn"><span id="okSpan">OK</span></button>
</div>
<input type="file" id="files" multiple style="display:none">
<div id="pickBox">Choose…</div>
<ul id="pickMenu" style="display:none"><li>One</li><li>Two</li><li>Three</li></ul>
<select id="pickSel"><option value="">-</option><option value="a">A</option><option value="b">B</option></select>
<shadow-box id="sbox"></shadow-box>
<div id="fileZone" style="min-height:30px">drop files here</div>
<iframe id="frm" src="/frame" style="height:160px"></iframe>
<div id="tall" style="height:3000px"></div>
<script>
  const run = new URLSearchParams(location.search).get('run');
  const clicks = [], alerts = [], marks = [];
  let seq = 0;
  const fields = () => Object.fromEntries([...document.querySelectorAll('input[id], select[id], textarea[id], [contenteditable][id]')]
    .map((el) => [el.id, el.type === 'checkbox' ? el.checked : (el.isContentEditable ? el.textContent : el.value)]));
  // seq: two posts in flight may arrive in either order; the harness keeps the latest.
  const report = () => fetch('/state', { method: 'POST', keepalive: true,
    body: JSON.stringify({ run, seq: ++seq, state: { fields: fields(), clicks, alerts, marks, headless: /Headless/.test(navigator.userAgent), width: innerWidth } }) });
  // The bookmarklet reports its errors with alert(), which would block a headless page.
  window.alert = (m) => { alerts.push(String(m)); report(); };
  // Fields are in the state by value; a click on one is not counted.
  document.addEventListener('click', (e) => {
    if (e.target.id && !e.target.matches('input, select, textarea')) { clicks.push(e.target.id); report(); }
  }, true);
  for (const type of ['input', 'change']) document.addEventListener(type, report, true);
  // A widget waiting for an event playback fires; sorted, as a real browser may fire them in another order.
  const mark = (m) => { if (!marks.includes(m)) { marks.push(m); marks.sort(); report(); } };
  const on = (id, type) => document.getElementById(id).addEventListener(type, () => mark(id + ' ' + type));
  on('mdBtn', 'mousedown');
  on('hoverMenu', 'mousemove');
  on('blurField', 'blur');
  on('color', 'click');
  const zone = document.getElementById('dropZone');
  zone.addEventListener('dragover', (e) => e.preventDefault());
  zone.addEventListener('drop', (e) => { e.preventDefault(); mark('dropZone drop'); });
  const pickMenu = document.getElementById('pickMenu');
  document.getElementById('pickBox').addEventListener('click', () => { pickMenu.style.display = 'block'; });
  pickMenu.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
    pickMenu.style.display = 'none';
    mark('picked ' + li.textContent);
  }));
  const files = document.getElementById('files');
  files.addEventListener('change', () => mark('files ' + [...files.files].map((f) => f.name).join(',')));
  // A drop zone for files: it names those dropped on it.
  const fileZone = document.getElementById('fileZone');
  for (const t of ['dragenter', 'dragover']) fileZone.addEventListener(t, (e) => e.preventDefault());
  fileZone.addEventListener('drop', (e) => { e.preventDefault(); mark('fileZone ' + [...e.dataTransfer.files].map((f) => f.name).join(',')); });
  // The frame (/frame) reports what is done in it through its parent.
  window.frameMark = (m) => mark(m);
  // ?xo: the same frame from another origin (localhost, the page being on 127.0.0.1).
  if (location.search.includes('xo')) {
    const xo = document.createElement('iframe');
    xo.src = 'http://localhost:' + location.port + '/frame?xo';
    document.body.insertBefore(xo, document.getElementById('tall'));
  }
  // A web component: a button in its open shadow root, and one added there a moment later.
  customElements.define('shadow-box', class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      const button = (id) => {
        const b = document.createElement('button');
        b.id = id;
        b.textContent = id;
        b.addEventListener('click', () => mark('shadow ' + id));
        root.append(b);
      };
      button('inShadow');
      setTimeout(() => button('lateShadow'), 700);
    }
  });
  report();
</script></body></html>`;

export function saveExportState(req, reply) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const { run, seq, state } = JSON.parse(body);
      if (!(exportStates.get(run)?.seq > seq)) exportStates.set(run, { seq, state });
    } catch { /* not a state post: nothing to keep */ }
    reply.statusCode = 204;
    reply.end();
  });
}

/**
 * Scenarios export-run plays, then runs as each export, on EXPORT_PAGE. `expect`
 * is what playback must leave (fields listed; clicks, alerts and marks in full,
 * none when left out); each export of `runners` (default both) must then leave
 * exactly what playback left; `files` are what the Selenium and Playwright runs must save, by
 * name, each with a check on the PNG's { width, height }. With `pageVar`, each run
 * starts on another page and that variable holds the URL of its own; with
 * `bookmarkletClicks: 2` the bookmark is clicked once there, then again on the
 * page it opened. With `failedAsserts` (the titles of the steps of its false Asserts),
 * every export run must fail at its end naming them, and no other step (checkFailedAsserts).
 * Add a case per behaviour an export has to share with playback.
 */
// The tools folder: Upload File cases upload e2e.mjs and verify.mjs from it.
const TOOLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EXPORT_CASES = [
  {
    name: 'form',
    // Also as the exported pytest test (python -m pytest).
    runners: ['bookmarklet', 'selenium', 'pytest', 'playwright'],
    variables: { salute: 'Hi' },
    actions: [
      { type: 'input', selector: '#name', selectors: { css: '#name' }, value: 'Alice' },
      { type: 'input', selector: '#color', selectors: { css: '#color' }, value: 'g' },
      { type: 'click', selector: '#agree', selectors: { css: '#agree' } },
      { type: 'readdom', selector: '#code', selectors: { css: '#code' }, varName: 'code', readFrom: 'text' },
      { type: 'input', selector: '#echo', selectors: { css: '#echo' }, value: '${salute} ${code}' },
      { type: 'click', selector: '#submit', selectors: { css: '#submit' } },
      { type: 'condition', conditionType: 'elementExists', selector: '#submit', selectors: { css: '#submit' }, skipCount: 1 },
      { type: 'click', selector: '#after', selectors: { css: '#after' } },
      { type: 'condition', conditionType: 'elementExists', selector: '#nope', selectors: { css: '#nope' }, skipCount: 1 },
      { type: 'click', selector: '#never', selectors: { css: '#never' } },
    ],
    expect: { fields: { name: 'Alice', color: 'g', agree: true, echo: 'Hi ORD-42' }, clicks: ['submit', 'after'], marks: ['color click'] },
  },
  {
    // Child Condition: the innermost element holding the text, ALL, a Fallback
    // variable, and a text the page hides (playback matches textContent).
    name: 'child-condition',
    variables: { who: '{fallback:Carol|Bob}' },
    actions: [
      { type: 'click', selector: '#people', selectors: { css: '#people' }, conditions: { textContains: 'VIP' } },
      { type: 'click', selector: '#people', selectors: { css: '#people' },
        conditions: { matchMode: 'all', textContains: 'Edit', classContains: 'special' } },
      { type: 'click', selector: '#people', selectors: { css: '#people' }, conditions: { textContains: '${who}' } },
      { type: 'readdom', selector: '#people', selectors: { css: '#people' }, varName: 'ref', readFrom: 'text',
        conditions: { textContains: 'ref' } },
      { type: 'input', selector: '#picked', selectors: { css: '#picked' }, value: '${ref}' },
      // Text the element holds in its own text nodes, a child between them: only those match it.
      { type: 'click', selector: '#people', selectors: { css: '#people' }, conditions: { textContains: 'HelloWorld' } },
    ],
    expect: { fields: { picked: 'ref 7731' }, clicks: ['tagBob', 'editBob', 'nameBob', 'ownTxt'], alerts: [] },
  },
  {
    // Each Condition guards one click: hasAttribute name=value, visible / hidden by
    // style and size (a fixed element has no offsetParent), text by textContent,
    // textEquals trimmed on both sides.
    name: 'conditions',
    actions: [
      ['hasAttribute', '#tagged', 'data-id=5', '#c1'],
      ['elementVisible', '#fixedBox', '', '#c2'],
      ['elementHidden', '#ghost', '', '#c3'],
      ['textContains', '#note2', 'secret', '#c4'],
      ['textEquals', '#total', ' Total: 42 ', '#c5'],
      ['elementVisible', '#ghost', '', '#c6'],
    ].flatMap(([conditionType, sel, expectedValue, guarded]) => [
      { type: 'condition', conditionType, selector: sel, selectors: { css: sel }, expectedValue, skipCount: 1 },
      { type: 'click', selector: guarded, selectors: { css: guarded } },
    ]),
    expect: { clicks: ['c1', 'c2', 'c3', 'c4', 'c5'] },
  },
  {
    // Events a page may wait for, fired as playback fires them: mousedown before a
    // click, mousemove on a hover, text into a contenteditable, blur after an Input.
    name: 'actions',
    actions: [
      { type: 'click', selector: '#mdBtn', selectors: { css: '#mdBtn' } },
      { type: 'hover', selector: '#hoverMenu', selectors: { css: '#hoverMenu' } },
      { type: 'input', selector: '#rich', selectors: { css: '#rich' }, value: 'Hello' },
      { type: 'input', selector: '#blurField', selectors: { css: '#blurField' }, value: 'x' },
      // In the Selenium run, the real click that blurs the field.
      { type: 'click', selector: '#done', selectors: { css: '#done' } },
    ],
    expect: { fields: { rich: 'Hello', blurField: 'x' }, clicks: ['mdBtn', 'done'],
      marks: ['blurField blur', 'hoverMenu mousemove', 'mdBtn mousedown'] },
  },
  {
    // HTML5 drag and drop: dragstart … drop with one DataTransfer, as playback fires them.
    name: 'drag',
    actions: [{ type: 'dragdrop', selector: '#dragSrc', selectors: { css: '#dragSrc' },
      targetSelector: '#dropZone', targetSelectors: { css: '#dropZone' } }],
    expect: { marks: ['dropZone drop'] },
  },
  {
    // Fields send_keys cannot fill the same way everywhere: a date or time is typed
    // in the browser locale's format, a color takes no typing.
    name: 'typed-fields',
    actions: [
      { type: 'input', selector: '#when', selectors: { css: '#when' }, value: '2026-10-10' },
      { type: 'input', selector: '#at', selectors: { css: '#at' }, value: '13:45' },
      { type: 'input', selector: '#shade', selectors: { css: '#shade' }, value: '#336699' },
    ],
    expect: { fields: { when: '2026-10-10', at: '13:45', shade: '#336699' } },
  },
  {
    // Every locator tried in playback's order until one finds the element; a Text
    // locator matches the exact text, innermost.
    name: 'locators',
    actions: [
      // The CSS is stale; the id, which playback tries before it, is not.
      { type: 'click', selector: '#broken1', selectors: { css: '#broken1', id: 'okA' } },
      // The id is stale; the XPath, tried next, is not.
      { type: 'click', selector: '#broken2', selectors: { id: 'broken2', xpath: '//button[@id="okB"]' } },
      { type: 'click', selectors: { text: 'OK' }, selectorType: 'text' },
    ],
    expect: { clicks: ['okA', 'okB', 'okSpan'] },
  },
  {
    // Upload File into a file input the page hides, a ${var} file name included.
    // Two of the harness's own files; a bookmarklet cannot read files.
    name: 'upload',
    runners: ['selenium', 'playwright'],
    variables: { second: 'verify.mjs' },
    actions: [{ type: 'uploadFile', selector: '#files', selectors: { css: '#files' }, uploadMode: 'input',
      folderPath: TOOLS_DIR, fileNames: ['e2e.mjs', '${second}'] }],
    expect: { marks: ['files e2e.mjs,verify.mjs'] },
  },
  {
    // Upload File to a drop zone: the files set on a hidden file input, then dropped on the
    // zone, as playback does it through CDP. A bookmarklet cannot read files.
    name: 'dropzone',
    runners: ['selenium', 'pytest', 'playwright'],
    variables: { second: 'verify.mjs' },
    actions: [{ type: 'uploadFile', selector: '#fileZone', selectors: { css: '#fileZone' }, uploadMode: 'dropzone',
      folderPath: TOOLS_DIR, fileNames: ['e2e.mjs', '${second}'] }],
    expect: { marks: ['fileZone e2e.mjs,verify.mjs'] },
  },
  {
    // Dropdown "Choose item #": item 2 of a list that opens on a click, the last option of a <select>.
    name: 'dropdown-pick',
    actions: [
      { type: 'dropdown', selector: '#pickBox', selectors: { css: '#pickBox' }, pick: { by: 'index', index: '2', itemSelector: '#pickMenu li' } },
      { type: 'dropdown', selector: '#pickSel', selectors: { css: '#pickSel' }, pick: { by: 'index', index: '-1' } },
    ],
    expect: { fields: { pickSel: 'b' }, clicks: ['pickBox'], marks: ['picked Two'] },
  },
  {
    // A full-page screenshot holds the whole page (3000px of #tall), not the window.
    name: 'full-shot',
    runners: ['selenium', 'playwright'],
    actions: [{ type: 'screenshot_full' }],
    files: { 'screenshot_full_step1.png': ({ height }) => height > 3000 },
  },
  {
    // A Navigate first. The bookmarklet, clicked on another page, opens the page
    // and stops; clicked again there, it plays the rest.
    name: 'navigate-first',
    pageVar: 'page',
    bookmarkletClicks: 2,
    actions: [
      { type: 'navigate', url: '${page}' },
      { type: 'click', selector: '#submit', selectors: { css: '#submit' } },
    ],
    expect: { clicks: ['submit'] },
  },
  {
    // Buttons inside a web component's open shadow root, one added there mid-wait: playback
    // finds them by CSS through the shadow root; so must every export.
    name: 'shadow',
    actions: [
      { type: 'click', selector: '#inShadow', selectors: { css: '#inShadow' } },
      { type: 'click', selector: '#lateShadow', selectors: { css: '#lateShadow' } },
    ],
    // A click inside the shadow root reaches the document as one on its host.
    expect: { clicks: ['sbox', 'sbox'], marks: ['shadow inShadow', 'shadow lateShadow'] },
  },
  {
    // A field and a button inside the page's iframe, then a button of the page. `inFrame`
    // steps get the frameId playback knows the frame by (as recording gives it).
    name: 'iframe',
    // The frame is of the page's own origin: within the bookmarklet's reach.
    runners: ['bookmarklet', 'selenium', 'pytest', 'playwright'],
    actions: [
      { type: 'input', selector: '#fName', selectors: { css: '#fName' }, value: 'Zoe', inFrame: true },
      { type: 'click', selector: '#fGo', selectors: { css: '#fGo' }, inFrame: true },
      { type: 'click', selector: '#after', selectors: { css: '#after' } },
    ],
    expect: { clicks: ['after'], marks: ['frame go Zoe'] },
  },
  {
    // Conditions on elements inside the iframe: checked in the frame, as playback checks
    // them (the exports used to look in the top page, where none of them is).
    name: 'iframe-condition',
    runners: ['bookmarklet', 'selenium', 'pytest', 'playwright'],
    actions: [
      { type: 'condition', conditionType: 'elementExists', selector: '#fGo', selectors: { css: '#fGo' }, skipCount: 1, inFrame: true },
      { type: 'click', selector: '#c1', selectors: { css: '#c1' } },
      { type: 'condition', conditionType: 'textContains', selector: '#fDd', selectors: { css: '#fDd' }, expectedValue: 'choose', skipCount: 1, inFrame: true },
      { type: 'click', selector: '#c2', selectors: { css: '#c2' } },
      { type: 'condition', conditionType: 'elementExists', selector: '#noSuch', selectors: { css: '#noSuch' }, skipCount: 1, inFrame: true },
      { type: 'click', selector: '#c3', selectors: { css: '#c3' } },
    ],
    expect: { clicks: ['c1', 'c2'] },
  },
  // A Switch block on a variable: the case whose value it has runs its action, then the step
  // after the block — the default case when no case has the value.
  ...[['switch-block', 'user', 'c2'], ['switch-default', 'guest', 'c3']].map(([name, role, clicked]) => ({
    name,
    variables: { role },
    actions: [
      { type: 'switch', switchVar: 'role', cases: [
        { value: 'admin', scenarioId: '__self__', startAt: 2, endAt: 2 },
        { value: 'user', scenarioId: '__self__', startAt: 3, endAt: 3 },
        { value: '__default__', scenarioId: '__self__', startAt: 4, endAt: 4 },
      ] },
      { type: 'click', selector: '#c1', selectors: { css: '#c1' } },
      { type: 'click', selector: '#c2', selectors: { css: '#c2' } },
      { type: 'click', selector: '#c3', selectors: { css: '#c3' } },
      { type: 'click', selector: '#after', selectors: { css: '#after' } },
    ],
    expect: { clicks: [clicked, 'after'] },
  })),
  {
    // A value read on one page, a Navigate to a page that redirects, the value typed on the
    // page it lands on. The bookmarklet goes on there at its second click.
    name: 'multi-page',
    pageVar: 'next',
    redirect: true,
    bookmarkletClicks: 2,
    actions: [
      { type: 'readdom', selector: '#code', selectors: { css: '#code' }, varName: 'code', readFrom: 'text' },
      { type: 'navigate', url: '${next}' },
      { type: 'input', selector: '#echo', selectors: { css: '#echo' }, value: '${code} ok' },
    ],
    expect: { fields: { echo: 'ORD-42 ok' } },
  },
  {
    // An Assert is checked until it holds, as playback checks it: the text a script puts on the
    // page 2 s later passes; one that never holds fails the run at its end — the click after it
    // still runs — naming that step alone (`failedAsserts`), in every export as in playback.
    name: 'assert',
    runners: ['bookmarklet', 'selenium', 'pytest', 'playwright'],
    failedAsserts: ['Step 4: assert — textEquals — Never'],
    actions: [
      { type: 'script', code: "setTimeout(() => { document.getElementById('code').textContent = 'Saved'; }, 2000)" },
      { type: 'assert', conditionType: 'textEquals', selector: '#code', selectors: { css: '#code' }, expectedValue: 'Saved', label: 'Late' },
      { type: 'click', selector: '#submit', selectors: { css: '#submit' } },
      { type: 'assert', conditionType: 'textEquals', selector: '#code', selectors: { css: '#code' }, expectedValue: 'Nope', label: 'Never' },
      { type: 'click', selector: '#after', selectors: { css: '#after' } },
    ],
    expect: { clicks: ['submit', 'after'] },
  },
  {
    // Every Assert holds — one only after 2 s: every export passes, the bookmarklet with no alert.
    name: 'assert-held',
    runners: ['bookmarklet', 'selenium', 'pytest', 'playwright'],
    actions: [
      { type: 'script', code: "setTimeout(() => { document.getElementById('code').textContent = 'Saved'; }, 2000)" },
      { type: 'assert', conditionType: 'textEquals', selector: '#code', selectors: { css: '#code' }, expectedValue: 'Saved' },
      { type: 'assert', conditionType: 'urlContains', expectedValue: '/export' },
      { type: 'click', selector: '#after', selectors: { css: '#after' } },
    ],
    expect: { clicks: ['after'] },
  },
  {
    // A false Assert before a Navigate to a page of the site, one after it: the run fails at its
    // end naming both — the bookmarklet, going on there at its second click, kept the first.
    name: 'assert-pages',
    pageVar: 'next',
    bookmarkletClicks: 2,
    failedAsserts: ['Step 1: assert — textEquals — Before', 'Step 4: assert — urlContains — After'],
    actions: [
      { type: 'assert', conditionType: 'textEquals', selector: '#code', selectors: { css: '#code' }, expectedValue: 'Nope', label: 'Before' },
      { type: 'navigate', url: '${next}' },
      { type: 'click', selector: '#after', selectors: { css: '#after' } },
      { type: 'assert', conditionType: 'urlContains', expectedValue: '/nowhere', label: 'After' },
    ],
    expect: { clicks: ['after'] },
  },
  {
    // A one-line Script that ends in a quote: the Selenium literal closed early on it.
    name: 'script-quote',
    actions: [{ type: 'script', code: 'alert("hi"); window.done = "yes"' }],
    expect: { alerts: ['hi'] },
  },
  {
    // A ${ that names no variable, beside one that does, stays text: the JS exports'
    // template literal did not parse.
    name: 'dollar-brace',
    variables: { who: 'Bob' },
    actions: [
      { type: 'input', selector: '#name', selectors: { css: '#name' }, value: 'price ${' },
      { type: 'input', selector: '#echo', selectors: { css: '#echo' }, value: 'tick ` ${who} ${}' },
    ],
    expect: { fields: { name: 'price ${', echo: 'tick ` Bob ${}' } },
  },
  {
    // Variables named as what the code uses itself: `location` hid the page's from the
    // bookmarklet's first Navigate, `el2` was step 2's element (Playwright: declared twice).
    name: 'own-names',
    pageVar: 'page',
    bookmarkletClicks: 2,
    variables: { location: 'Hanoi', el2: 'x' },
    actions: [
      { type: 'navigate', url: '${page}' },
      { type: 'input', selector: '#name', selectors: { css: '#name' }, value: '${location} ${el2}' },
    ],
    expect: { fields: { name: 'Hanoi x' } },
  },
];

// A folder with @playwright/test installed (npm install @playwright/test): the Playwright
// runs use it, with the installed Edge. Unset, they are skipped, not failed.
const PLAYWRIGHT_DIR = process.env.PQA_PLAYWRIGHT_DIR || '';

// The exported Selenium script, first run included (Selenium Manager may fetch a driver).
const PYTHON_RUN_TIMEOUT_MS = 180_000;
// The bookmarklet runs in the page; its own step delays and waits add up.
const BOOKMARKLET_RUN_TIMEOUT_MS = 60_000;

const runFile = (file, args, opts) => new Promise((res) => {
  execFile(file, args, { windowsHide: true, ...opts }, (error, stdout, stderr) => res({ error, stdout, stderr }));
});

/** Whether `python -m pytest` runs here. */
async function hasPytest() {
  return !(await runFile('python', ['-m', 'pytest', '--version'])).error;
}

/** Run a pytest file from `dir`, no cache written; its report in UTF-8 (a pipe here is cp1252). */
const runPytest = (file, dir) => runFile('python', ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', file],
  { cwd: dir, timeout: PYTHON_RUN_TIMEOUT_MS, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });

// A python with Robot Framework and SeleniumLibrary (pip install robotframework-seleniumlibrary):
// the Robot runs use it. Without, they are skipped, not failed.
const ROBOT_PYTHON = process.env.PQA_ROBOT_PYTHON || 'python';

/** Whether ROBOT_PYTHON runs Robot Framework with SeleniumLibrary. */
async function hasRobot() {
  return !(await runFile(ROBOT_PYTHON, ['-c', 'import robot, SeleniumLibrary'])).error;
}

/** Run a .robot file, its output (log, screenshots) into `outDir`; its console in UTF-8. */
const runRobot = (file, outDir, env = process.env) => runFile(ROBOT_PYTHON,
  ['-m', 'robot', '--outputdir', outDir, '--consolecolors', 'off', '--consolewidth', '160', file],
  { cwd: outDir, timeout: PYTHON_RUN_TIMEOUT_MS, env: { ...env, PYTHONIOENCODING: 'utf-8' } });

// A JDK and a folder of the selenium-java and testng jars (with their own): the Java runs use them.
// Without either, they are skipped, not failed.
const JAVA_HOME = process.env.PQA_JAVA_HOME || '';
const JAVA_LIBS = process.env.PQA_JAVA_LIBS || '';
const javaTool = (tool) => join(JAVA_HOME, 'bin', tool);

/** Why the Java runs cannot happen here, or null when they can. */
function javaMissing() {
  if (!JAVA_HOME || !existsSync(javaTool(process.platform === 'win32' ? 'javac.exe' : 'javac'))) return 'no JDK (set PQA_JAVA_HOME)';
  return JAVA_LIBS && existsSync(JAVA_LIBS) ? null : 'no selenium-java + testng jars (set PQA_JAVA_LIBS)';
}

/**
 * Compile a test class into `outDir` and run it there with TestNG (what it saves
 * lands there), its output in UTF-8; a failed compile is returned as the run.
 */
async function runJava(file, className, outDir, env = process.env) {
  const libs = join(JAVA_LIBS, '*');
  const built = await runFile(javaTool('javac'), ['-encoding', 'UTF-8', '-cp', libs, '-d', outDir, file], { timeout: PYTHON_RUN_TIMEOUT_MS });
  if (built.error) return built;
  return runFile(javaTool('java'), ['-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-cp', [outDir, libs].join(delimiter),
    'org.testng.TestNG', '-testclass', className, '-verbose', '2'],
  { cwd: outDir, timeout: PYTHON_RUN_TIMEOUT_MS, env });
}

/** Why the Selenium run cannot happen on this machine, or null when it can. */
async function pythonMissing() {
  const { error, stderr } = await runFile('python', ['-c', 'import selenium']);
  if (!error) return null;
  return error.code === 'ENOENT' ? 'no python on PATH' : `no selenium for python (${String(stderr).trim().split('\n').pop()})`;
}

/** The files a case expects (c.files) that a run saved into `folder`, checked on the PNG's size. */
function checkFiles(c, runner, folder) {
  for (const [name, ok] of Object.entries(c.files || {})) {
    const size = existsSync(join(folder, name)) ? pngSize(join(folder, name)) : null;
    check(size && ok(size), `${c.name}: the ${runner} run saves ${name} as expected`, size);
  }
}

/** Wait (up to PLAY_TIMEOUT_MS) until `page` has loaded `url`, then a moment more. */
async function untilOn(page, url) {
  for (let waited = 0; waited < PLAY_TIMEOUT_MS; waited += POLL_MS) {
    // Mid-navigation the page may not answer at all.
    const href = await page.evaluate('document.readyState === "complete" && location.href').catch(() => null);
    if (href === url) break;
    await sleep(POLL_MS);
  }
  await sleep(PAGE_SETTLE_MS);
}

/** The fields whose values differ between two page states, as { field: [a, b] }. */
function stateDiff(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a?.fields || {}), ...Object.keys(b?.fields || {})])) {
    if (a?.fields?.[k] !== b?.fields?.[k]) out[k] = [a?.fields?.[k], b?.fields?.[k]];
  }
  for (const k of ['clicks', 'alerts', 'marks']) {
    if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) out[k] = [a?.[k], b?.[k]];
  }
  return out;
}

// A scenario whose step 3, "Sign in", finds nothing: what each export says when it fails.
const FAILING_STEPS = [
  { type: 'input', selector: '#name', selectors: { css: '#name' }, value: 'Alice' },
  { type: 'click', selector: '#submit', selectors: { css: '#submit' } },
  { type: 'click', selector: '#nope', selectors: { css: '#nope' }, label: 'Sign in' },
  { type: 'click', selector: '#after', selectors: { css: '#after' } },
];
// What a failure report has to say: the step, its label, and what was looked for.
const NAMES_STEP_3 = /Step 3: click — Sign in/;
const NAMES_LOCATOR = /#nope/;

/** Each export of FAILING_STEPS, run: its error names step 3 and its label, and what it looked for. */
async function checkFailsAtStep(ctx, run) {
  const opts = { elTimeout: 1000, stepDelay: 0 };
  const page = (runner) => run.pageUrl(`fails-at-step:${runner}`);

  // A tab of its own: the error the bookmarklet logs is meant, not one of the test page's.
  const tab = await ctx.browser.openPage(page('bookmarklet'));
  await sleep(PAGE_SETTLE_MS);
  const url = run.toBookmarkletUrl(run.generateBookmarklet('fails at step', FAILING_STEPS, {}, opts).code);
  await tab.evaluate(decodeURIComponent(url.slice('javascript:'.length)), BOOKMARKLET_RUN_TIMEOUT_MS).catch(() => {});
  await sleep(SETTLE_MS);
  await tab.close();
  const alerts = exportStates.get('fails-at-step:bookmarklet')?.state?.alerts || [];
  check(alerts.length === 1 && NAMES_STEP_3.test(alerts[0]) && NAMES_LOCATOR.test(alerts[0]),
    'fails-at-step: the bookmarklet\'s alert names step 3, its label and what it looked for', alerts);

  if (!run.noPython) {
    const file = join(run.dir, 'fails_at_step.py');
    writeFileSync(file, run.generateSeleniumPy('fails at step', FAILING_STEPS, {},
      { ...opts, driverType: 'Edge', startUrl: page('selenium'), headless: !HEADED }).code);
    const r = await runFile('python', [file], { cwd: run.dir, timeout: PYTHON_RUN_TIMEOUT_MS });
    const said = String(r.stdout).trim();
    check(r.error && NAMES_STEP_3.test(said) && NAMES_LOCATOR.test(said),
      'fails-at-step: the Selenium script fails, printing step 3, its label and what it looked for', said.split('\n').pop());
    check(existsSync(join(run.dir, 'fails_at_step_failure.png')), 'fails-at-step: the Selenium script leaves fails_at_step_failure.png', null);
  }
  if (run.pwRun) {
    // The list reporter, as on a terminal: each test.step and the failing one.
    const spec = 'fails_at_step.spec.js';
    writeFileSync(join(run.pwRun, spec), run.generatePlaywright('fails at step', FAILING_STEPS, {}, { ...opts, startUrl: page('playwright') }).code);
    const r = await runFile(process.execPath, [run.pwCli, 'test', spec, '--config', 'playwright.config.mjs', '--reporter=list'],
      { cwd: run.pwRun, timeout: PYTHON_RUN_TIMEOUT_MS, env: { ...process.env, PLAYWRIGHT_LIST_PRINT_STEPS: '1' } });
    const report = String(r.stdout);
    // Reported under its step (test.step), not only near the step's comment in the code frame.
    check(r.error && /› Step 3: click — Sign in/.test(report) && NAMES_LOCATOR.test(report),
      'fails-at-step: the Playwright report names step 3, its label and what it looked for', report.split('\n').filter((l) => /Step 3|nope/.test(l)).slice(0, 3));
    const results = join(run.pwRun, 'test-results');
    const shots = existsSync(results) ? readdirSync(results, { recursive: true }).map(String).filter((f) => f.endsWith('.png')) : [];
    check(shots.length > 0, 'fails-at-step: the Playwright test keeps a screenshot in test-results/', shots);
  }
  if (run.pytestHere) {
    const file = join(run.dir, 'test_fails_at_step.py');
    writeFileSync(file, run.generateSeleniumPy('fails at step', FAILING_STEPS, {},
      { ...opts, driverType: 'Edge', startUrl: page('pytest'), headless: !HEADED, output: 'pytest' }).code);
    const r = await runPytest(file, run.dir);
    const report = String(r.stdout);
    check(r.error && report.split('\n').some((l) => /^E\s/.test(l) && NAMES_STEP_3.test(l) && NAMES_LOCATOR.test(l)),
      'fails-at-step: the pytest report\'s error names step 3, its label and what it looked for', report.split('\n').filter((l) => /^E\s/.test(l)).slice(0, 2));
    check(existsSync(join(run.dir, 'test_fails_at_step_failure.png')), 'fails-at-step: the pytest test leaves test_fails_at_step_failure.png', null);
  }
  if (run.robotHere) {
    const out = mkdtempSync(join(run.dir, 'robot-'));
    const file = join(out, 'fails_at_step.robot');
    writeFileSync(file, run.generateRobot('fails at step', FAILING_STEPS, {},
      { ...opts, driverType: 'Edge', startUrl: page('robot'), headless: !HEADED }).code);
    const r = await runRobot(file, out);
    const report = String(r.stdout);
    check(r.error && report.split('\n').some((l) => NAMES_STEP_3.test(l) && NAMES_LOCATOR.test(l)),
      'fails-at-step: the Robot report\'s message names step 3, its label and what it looked for', report.split('\n').filter((l) => /Step 3|nope/.test(l)).slice(0, 2));
    check(existsSync(join(out, 'fails_at_step_failure.png')), 'fails-at-step: the Robot test leaves fails_at_step_failure.png', null);
  }
  if (run.javaHere) {
    const out = mkdtempSync(join(run.dir, 'java-'));
    const cls = run.javaClassName('fails at step');
    writeFileSync(join(out, `${cls}.java`), run.generateJava('fails at step', FAILING_STEPS, {},
      { ...opts, driverType: 'Edge', startUrl: page('java'), headless: !HEADED }).code);
    const r = await runJava(join(out, `${cls}.java`), cls, out);
    const report = String(r.stdout);
    check(r.error && report.split('\n').some((l) => NAMES_STEP_3.test(l) && NAMES_LOCATOR.test(l)),
      'fails-at-step: the TestNG report names step 3, its label and what it looked for', report.split('\n').filter((l) => /Step 3|nope/.test(l)).slice(0, 2));
    check(existsSync(join(out, `${cls}_failure.png`)), `fails-at-step: the Java test leaves ${cls}_failure.png`, null);
  }
}

/**
 * One export, run with the environment set (PQA_BASE_URL, PQA_<name>), changes the
 * run without an export: its start URL is on a site nothing answers on, and the
 * echo field gets the variable's value from the environment.
 */
async function checkEnvOverrides(ctx, run) {
  const steps = [{ type: 'input', selector: '#echo', selectors: { css: '#echo' }, value: '${salute} there' }];
  const env = (runner) => ({ ...process.env, PQA_BASE_URL: ctx.base, PQA_salute: 'Yo', PQA_TEST_RUN: runner });
  // Port 9 (discard): nothing to open there; the run has to go to PQA_BASE_URL instead.
  const deadStart = (runner) => `http://127.0.0.1:9/export?run=${encodeURIComponent(`env:${runner}`)}`;
  const reached = (runner) => exportStates.get(`env:${runner}`)?.state;
  if (!run.noPython) {
    const file = join(run.dir, 'env.py');
    writeFileSync(file, run.generateSeleniumPy('env', steps, { salute: 'Hi' },
      { driverType: 'Edge', startUrl: deadStart('selenium'), headless: !HEADED, stepDelay: 0 }).code);
    const r = await runFile('python', [file], { cwd: run.dir, timeout: PYTHON_RUN_TIMEOUT_MS, env: env('selenium') });
    await sleep(SETTLE_MS);
    check(!r.error && reached('selenium')?.fields?.echo === 'Yo there',
      'env: the Selenium script opens PQA_BASE_URL\'s site and takes PQA_salute, with no export', r.error ? String(r.stdout).trim().split('\n').pop() : reached('selenium')?.fields?.echo);
  }
  if (run.pwRun) {
    writeFileSync(join(run.pwRun, 'env.spec.js'), run.generatePlaywright('env', steps, { salute: 'Hi' }, { startUrl: deadStart('playwright'), stepDelay: 0 }).code);
    const r = await runFile(process.execPath, [run.pwCli, 'test', 'env.spec.js', '--config', 'playwright.config.mjs'],
      { cwd: run.pwRun, timeout: PYTHON_RUN_TIMEOUT_MS, env: env('playwright') });
    await sleep(SETTLE_MS);
    check(!r.error && reached('playwright')?.fields?.echo === 'Yo there',
      'env: the Playwright test opens PQA_BASE_URL\'s site and takes PQA_salute, with no export', r.error ? String(r.stdout).trim().split('\n').slice(-3) : reached('playwright')?.fields?.echo);
  }
  if (run.robotHere) {
    const out = mkdtempSync(join(run.dir, 'robot-'));
    writeFileSync(join(out, 'env.robot'), run.generateRobot('env', steps, { salute: 'Hi' },
      { driverType: 'Edge', startUrl: deadStart('robot'), headless: !HEADED, stepDelay: 0 }).code);
    const r = await runRobot(join(out, 'env.robot'), out, env('robot'));
    await sleep(SETTLE_MS);
    check(!r.error && reached('robot')?.fields?.echo === 'Yo there',
      'env: the Robot test opens PQA_BASE_URL\'s site and takes PQA_salute, with no export', r.error ? String(r.stdout).trim().split('\n').slice(-6) : reached('robot')?.fields?.echo);
  }
  if (run.javaHere) {
    const out = mkdtempSync(join(run.dir, 'java-'));
    const cls = run.javaClassName('env');
    writeFileSync(join(out, `${cls}.java`), run.generateJava('env', steps, { salute: 'Hi' },
      { driverType: 'Edge', startUrl: deadStart('java'), headless: !HEADED, stepDelay: 0 }).code);
    const r = await runJava(join(out, `${cls}.java`), cls, out, env('java'));
    await sleep(SETTLE_MS);
    check(!r.error && reached('java')?.fields?.echo === 'Yo there',
      'env: the Java test opens PQA_BASE_URL\'s site and takes PQA_salute, with no export', r.error ? String(r.stdout + r.stderr).trim().split('\n').slice(-6) : reached('java')?.fields?.echo);
  }
}

/**
 * A pytest test, a Playwright spec, a Robot test (DataDriver, through the
 * exported reader) and a Java TestNG class exported with a data file run once per
 * row of it, each with its row's values: the page to open (a column no variable has)
 * and "who", whose column wins over the variable's "Zed" — one value quoted,
 * holding the delimiter.
 */
async function checkCsvData(ctx, run) {
  const steps = [
    { type: 'navigate', url: '${page}' },
    { type: 'input', selector: '#name', selectors: { css: '#name' }, value: '${who}' },
  ];
  const who = ['Ann', 'Bo, Jr.', 'Cy'];
  const writeCsv = (folder, runner) => writeFileSync(join(folder, 'data.csv'),
    ['page,who', ...who.map((w, k) => `${run.pageUrl(`csv:${runner}:${k + 1}`)},"${w}"`)].join('\r\n') + '\r\n');
  const names = (runner) => who.map((w, k) => exportStates.get(`csv:${runner}:${k + 1}`)?.state?.fields?.name);
  if (run.pytestHere) {
    writeCsv(run.dir, 'pytest');
    writeFileSync(join(run.dir, 'test_csv_data.py'), run.generateSeleniumPy('csv data', steps, { who: 'Zed' },
      { driverType: 'Edge', headless: !HEADED, output: 'pytest', dataFile: 'data.csv', stepDelay: 0 }).code);
    const r = await runPytest('test_csv_data.py', run.dir);
    await sleep(SETTLE_MS);
    const summary = String(r.stdout).trim().split('\n').pop();
    check(!r.error && /^3 passed/.test(summary) && JSON.stringify(names('pytest')) === JSON.stringify(who),
      'csv-data: pytest runs a test per row of data.csv, each with its row', { summary, names: names('pytest') });
  }
  if (run.pwRun) {
    writeCsv(run.pwRun, 'playwright');
    writeFileSync(join(run.pwRun, 'csv_data.spec.js'), run.generatePlaywright('csv data', steps, { who: 'Zed' },
      { dataFile: 'data.csv', stepDelay: 0 }).code);
    const r = await runFile(process.execPath, [run.pwCli, 'test', 'csv_data.spec.js', '--config', 'playwright.config.mjs'],
      { cwd: run.pwRun, timeout: PYTHON_RUN_TIMEOUT_MS });
    await sleep(SETTLE_MS);
    const out = String(r.stdout);
    check(!r.error && /\b3 passed\b/.test(out) && JSON.stringify(names('playwright')) === JSON.stringify(who),
      'csv-data: Playwright runs a test per row of data.csv, each with its row', { out: out.trim().split('\n').slice(-2), names: names('playwright') });
  }
  if (run.robotHere) {
    const out = mkdtempSync(join(run.dir, 'robot-csv-'));
    writeCsv(out, 'robot');
    writeFileSync(join(out, run.ROBOT_READER_FILE), run.robotReaderPy());
    writeFileSync(join(out, 'csv_data.robot'), run.generateRobot('csv data', steps, { who: 'Zed' },
      { driverType: 'Edge', headless: !HEADED, dataFile: 'data.csv', stepDelay: 0 }).code);
    const r = await runRobot(join(out, 'csv_data.robot'), out);
    await sleep(SETTLE_MS);
    const out2 = String(r.stdout);
    check(!r.error && /3 tests, 3 passed, 0 failed/.test(out2) && JSON.stringify(names('robot')) === JSON.stringify(who),
      'csv-data: Robot (DataDriver) runs a test per row of data.csv, each with its row', { out: out2.trim().split('\n').slice(-8), names: names('robot') });
  }
  if (run.javaHere) {
    const out = mkdtempSync(join(run.dir, 'java-csv-'));
    writeCsv(out, 'java');
    const cls = run.javaClassName('csv data');
    writeFileSync(join(out, `${cls}.java`), run.generateJava('csv data', steps, { who: 'Zed' },
      { driverType: 'Edge', headless: !HEADED, dataFile: 'data.csv', stepDelay: 0 }).code);
    const r = await runJava(join(out, `${cls}.java`), cls, out);
    await sleep(SETTLE_MS);
    const out2 = String(r.stdout) + String(r.stderr);
    check(!r.error && /Total tests run: 3, Passes: 3, Failures: 0/.test(out2) && JSON.stringify(names('java')) === JSON.stringify(who),
      'csv-data: Java (TestNG) runs a test per row of data.csv, each with its row', { out: out2.trim().split('\n').slice(-8), names: names('java') });
  }
}

/** The frameId the extension knows the test tab's frame at `path` by, or null. */
const frameIdOf = (ctx, path) => ctx.ext.evaluate(`new Promise((res) => chrome.scripting.executeScript(
  { target: { tabId: ${ctx.webTabId}, allFrames: true }, func: () => location.pathname },
  (r) => res((r || []).find((f) => f.result === ${JSON.stringify(path)})?.frameId ?? null)))`);

export async function checkExportRun(ctx) {
  const extModule = (p) => pathToFileURL(join(EXT, p)).href;
  const { generateBookmarklet, toBookmarkletUrl } = await import(extModule('popup/export-bookmarklet.js'));
  const { generateSeleniumPy } = await import(extModule('popup/export-selenium.js'));
  const { getUsedVarNames } = await import(extModule('popup/utils.js'));
  const noPython = await pythonMissing();
  if (noPython) console.log(`  – the Selenium runs are skipped: ${noPython}`);
  const pytestHere = !noPython && await hasPytest();
  // An export a version does not have (an older checkout under --ext) is not run.
  const { generatePlaywright } = await import(extModule('popup/export-playwright.js')).catch(() => ({}));
  const pwCli = PLAYWRIGHT_DIR && join(PLAYWRIGHT_DIR, 'node_modules', '@playwright', 'test', 'cli.js');
  const pwRun = generatePlaywright && pwCli && existsSync(pwCli) ? mkdtempSync(join(PLAYWRIGHT_DIR, 'pqa-run-')) : null;
  if (pwRun) {
    // outputDir beside the config: by default it goes beside the nearest package.json, outside pwRun.
    writeFileSync(join(pwRun, 'playwright.config.mjs'),
      `export default { use: { channel: 'msedge', headless: ${!HEADED} }, reporter: 'line', workers: 1, outputDir: './test-results' };\n`);
  } else {
    console.log('  – the Playwright runs are skipped: set PQA_PLAYWRIGHT_DIR to a folder with @playwright/test installed');
  }
  if (!noPython && !pytestHere) console.log('  – the pytest runs are skipped: no pytest for python');
  const { generateRobot, robotReaderPy, ROBOT_READER_FILE } = await import(extModule('popup/export-robot.js')).catch(() => ({}));
  const robotHere = !!generateRobot && await hasRobot();
  if (generateRobot && !robotHere) console.log(`  – the Robot runs are skipped: no robotframework-seleniumlibrary for ${ROBOT_PYTHON} (set PQA_ROBOT_PYTHON)`);
  const { generateJava, javaClassName } = await import(extModule('popup/export-java.js')).catch(() => ({}));
  const noJava = generateJava && javaMissing();
  if (noJava) console.log(`  – the Java runs are skipped: ${noJava}`);
  const javaHere = !!generateJava && !noJava;
  const dir = mkdtempSync(join(tmpdir(), 'pqa-export-'));
  let headlessChecked = false;
  const pageUrl = (key) => `${ctx.base}/export?run=${encodeURIComponent(key)}`;
  // A case whose Asserts are false (c.failedAsserts, their steps' titles): a run of it fails at its
  // end (`failed`) and what it said (`said`) names each of them — and no other Assert: one that
  // held, if only after a while, is no failure. A failure's message is "<title>: expected …"; a
  // title elsewhere (pytest's code listing, a report's heading) is none.
  const checkFailedAsserts = (c, runner, failed, said) => {
    const named = [...new Set([...said.matchAll(/Step \d+: assert[^:\n"]*(?=: expected )/g)].map((m) => m[0]))];
    check(failed && c.failedAsserts.every((t) => named.includes(t)) && named.every((t) => c.failedAsserts.includes(t)),
      `${c.name}: the ${runner} run fails at its end, naming the false Assert(s) and no other`, { failed: !!failed, named });
  };
  try {
    for (const c of EXPORT_CASES.filter((x) => !CASES || CASES.includes(x.name))) {
      // The URL of each run's own page, in the variable named by `pageVar`.
      // Through /redirect with `redirect`: the page a Navigate opens sends it on to the run's page.
      const pageVars = (runner) => (c.pageVar ? { [c.pageVar]: c.redirect
        ? `${ctx.base}/redirect?to=${encodeURIComponent(pageUrl(`${c.name}:${runner}`))}` : pageUrl(`${c.name}:${runner}`) } : {});
      const startUrl = (runner) => pageUrl(`${c.name}:${c.pageVar ? 'start' : runner}`);
      await ctx.send({ type: 'SAVE_VARIABLES', variables: { ...c.variables, ...pageVars('playback') } });
      // The playback page first: a step in its frame needs the frameId the frame has there.
      await ctx.web.goto(startUrl('playback'));
      await sleep(PAGE_SETTLE_MS);
      const frameId = c.actions.some((a) => a.inFrame) ? await frameIdOf(ctx, '/frame') : null;
      const id = await makeScenario(ctx, `e2e export ${c.name}`,
        c.actions.map(({ inFrame, ...a }) => (inFrame ? { ...a, frameId } : a)));
      // The exports get what the modal hands them: the stored actions, and the variables they use.
      const actions = (await ctx.send({ type: 'GET_SCENARIOS' })).scenarios[id].actions;
      const used = getUsedVarNames(actions);
      const variables = Object.fromEntries(Object.entries((await ctx.send({ type: 'GET_VARIABLES' })).variables || {})
        .filter(([k]) => used.has(k)));
      const states = {};
      const runners = c.runners || ['bookmarklet', 'selenium', 'playwright'];

      const played = await play(ctx, id);
      if (played.timedOut) fail(`${c.name}: playback did not finish`);
      states.playback = exportStates.get(`${c.name}:playback`)?.state;

      if (runners.includes('bookmarklet')) {
        // With false Asserts, a tab of its own: the errors the bookmarklet logs for them are meant, not the test page's.
        const tab = c.failedAsserts ? await ctx.browser.openPage(startUrl('bookmarklet')) : ctx.web;
        if (c.failedAsserts) await sleep(PAGE_SETTLE_MS);
        else await ctx.web.goto(startUrl('bookmarklet'));
        const url = toBookmarkletUrl(generateBookmarklet(c.name, actions, { ...variables, ...pageVars('bookmarklet') }).code);
        for (let click = 1; click <= (c.bookmarkletClicks || 1); click++) {
          if (click > 1) await untilOn(tab, pageUrl(`${c.name}:bookmarklet`));
          // What a click on the bookmark runs: the URL, percent-decoded.
          await tab.evaluate(decodeURIComponent(url.slice('javascript:'.length)), BOOKMARKLET_RUN_TIMEOUT_MS)
            .catch((e) => fail(`${c.name}: the bookmarklet threw on click ${click}: ${e.message}`));
        }
        await sleep(SETTLE_MS);
        if (c.failedAsserts) await tab.close();
        states.bookmarklet = exportStates.get(`${c.name}:bookmarklet`)?.state;
        // Its alert that lists the false Asserts is one playback does not show: checked, then left out.
        if (c.failedAsserts && states.bookmarklet) {
          const summary = states.bookmarklet.alerts.filter((a) => /Assert\(s\) failed/.test(a));
          checkFailedAsserts(c, 'bookmarklet', summary.length === 1, summary.join('\n'));
          states.bookmarklet = { ...states.bookmarklet, alerts: states.bookmarklet.alerts.filter((a) => !summary.includes(a)) };
        }
      }

      if (!noPython && runners.includes('selenium')) {
        const file = join(dir, `${c.name}.py`);
        writeFileSync(file, generateSeleniumPy(c.name, actions, { ...variables, ...pageVars('selenium') },
          { driverType: 'Edge', startUrl: startUrl('selenium'), headless: !HEADED }).code);
        // In the temporary folder: what the script saves (screenshots) lands there.
        const r = await runFile('python', [file], { cwd: dir, timeout: PYTHON_RUN_TIMEOUT_MS });
        if (c.failedAsserts) checkFailedAsserts(c, 'Selenium', r.error, String(r.stdout));
        else if (r.error) fail(`${c.name}: the Selenium script failed: ${String(r.stderr || r.error.message).trim().split('\n').slice(-3).join(' | ')}`);
        await sleep(SETTLE_MS);
        states.selenium = exportStates.get(`${c.name}:selenium`)?.state;
        if (!headlessChecked && states.selenium) {
          headlessChecked = true;
          check(states.selenium.headless === !HEADED, `the Selenium script runs ${HEADED ? 'with' : 'without'} a window, as exported`, states.selenium.headless);
          // Headless, the window is the size a desktop page is recorded at, not a phone's.
          // (A 1920 px window is 1896 px inside here; the default was 756.)
          if (!HEADED) check(states.selenium.width >= 1800, 'the headless Selenium window is a desktop one, 1920 px wide', states.selenium.width);
        }
        checkFiles(c, 'Selenium', dir);
      }

      if (pwRun && runners.includes('playwright')) {
        const spec = `${c.name.replace(/\W/g, '_')}.spec.js`;
        writeFileSync(join(pwRun, spec), generatePlaywright(c.name, actions, { ...variables, ...pageVars('playwright') },
          { startUrl: startUrl('playwright') }).code);
        // The file by its name: Playwright reads the argument as a pattern, and a Windows path's \ escapes.
        const r = await runFile(process.execPath, [pwCli, 'test', spec, '--config', 'playwright.config.mjs'],
          { cwd: pwRun, timeout: PYTHON_RUN_TIMEOUT_MS });
        if (c.failedAsserts) checkFailedAsserts(c, 'Playwright', r.error, String(r.stdout));
        else if (r.error) fail(`${c.name}: the Playwright test failed: ${String(r.stdout).trim().split('\n').slice(-4).join(' | ')}`);
        await sleep(SETTLE_MS);
        states.playwright = exportStates.get(`${c.name}:playwright`)?.state;
        checkFiles(c, 'Playwright', pwRun);
      }

      if (pytestHere && runners.includes('pytest')) {
        const file = join(dir, `test_${c.name.replace(/\W/g, '_')}.py`);
        writeFileSync(file, generateSeleniumPy(c.name, actions, { ...variables, ...pageVars('pytest') },
          { driverType: 'Edge', startUrl: startUrl('pytest'), headless: !HEADED, output: 'pytest' }).code);
        const r = await runPytest(file, dir);
        if (c.failedAsserts) checkFailedAsserts(c, 'pytest', r.error, String(r.stdout));
        else if (r.error) fail(`${c.name}: the pytest test failed: ${String(r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
        await sleep(SETTLE_MS);
        states.pytest = exportStates.get(`${c.name}:pytest`)?.state;
      }

      // Every case the Selenium script runs, the Robot test runs too.
      if (robotHere && runners.includes('selenium')) {
        const out = mkdtempSync(join(dir, 'robot-'));
        const file = join(out, `${c.name.replace(/\W/g, '_')}.robot`);
        writeFileSync(file, generateRobot(c.name, actions, { ...variables, ...pageVars('robot') },
          { driverType: 'Edge', startUrl: startUrl('robot'), headless: !HEADED }).code);
        const r = await runRobot(file, out);
        if (c.failedAsserts) checkFailedAsserts(c, 'Robot', r.error, String(r.stdout));
        else if (r.error) fail(`${c.name}: the Robot test failed: ${String(r.stdout).trim().split('\n').filter((l) => !/^(Output|Log|Report):/.test(l)).slice(-6).join(' | ')}`);
        await sleep(SETTLE_MS);
        states.robot = exportStates.get(`${c.name}:robot`)?.state;
        checkFiles(c, 'Robot', out);
      }

      // And the Java test.
      if (javaHere && runners.includes('selenium')) {
        const out = mkdtempSync(join(dir, 'java-'));
        const cls = javaClassName(c.name);
        writeFileSync(join(out, `${cls}.java`), generateJava(c.name, actions, { ...variables, ...pageVars('java') },
          { driverType: 'Edge', startUrl: startUrl('java'), headless: !HEADED }).code);
        const r = await runJava(join(out, `${cls}.java`), cls, out);
        if (c.failedAsserts) checkFailedAsserts(c, 'Java', r.error, String(r.stdout));
        else if (r.error) fail(`${c.name}: the Java test failed: ${String(r.stdout + r.stderr).trim().split('\n').filter((l) => !/^\s+at /.test(l)).slice(-6).join(' | ')}`);
        await sleep(SETTLE_MS);
        states.java = exportStates.get(`${c.name}:java`)?.state;
        checkFiles(c, 'Java', out);
      }

      // Fields not named in `expect` are taken as playback left them.
      const expected = { clicks: [], alerts: [], marks: [], ...c.expect, fields: { ...states.playback?.fields, ...c.expect?.fields } };
      const wanted = stateDiff(states.playback, expected);
      check(states.playback && !Object.keys(wanted).length, `${c.name}: playback leaves the expected page`, wanted);
      for (const runner of ['bookmarklet', 'selenium', 'pytest', 'playwright', 'robot', 'java']) {
        if (!(runner in states)) continue;
        const diff = stateDiff(states.playback, states[runner]);
        check(states[runner] && !Object.keys(diff).length,
          `${c.name}: the ${runner} export leaves the page as playback does`, states[runner] ? diff : 'no state posted');
      }
    }
    if (!CASES || CASES.includes('csv-data')) {
      await checkCsvData(ctx, { dir, pageUrl, pytestHere, pwRun, pwCli, robotHere, javaHere, generateSeleniumPy, generatePlaywright,
        generateRobot, robotReaderPy, ROBOT_READER_FILE, generateJava, javaClassName });
    }
    if (!CASES || CASES.includes('env')) {
      await checkEnvOverrides(ctx, { dir, noPython, pwRun, pwCli, robotHere, javaHere, generateSeleniumPy, generatePlaywright, generateRobot, generateJava, javaClassName });
    }
    if (!CASES || CASES.includes('fails-at-step')) {
      await checkFailsAtStep(ctx, { dir, pageUrl, noPython, pytestHere, pwRun, pwCli, robotHere, javaHere, generateBookmarklet, toBookmarkletUrl,
        generateSeleniumPy, generatePlaywright, generateRobot, generateJava, javaClassName });
    }
    if (pytestHere && !CASES) {
      const file = join(dir, 'test_failing_step.py');
      writeFileSync(file, generateSeleniumPy('failing step', [
        { type: 'click', selector: '#submit', selectors: { css: '#submit' } },
        { type: 'click', selector: '#nowhere', selectors: { css: '#nowhere' } },
      ], {}, { driverType: 'Edge', startUrl: pageUrl('failing-step:pytest'), headless: !HEADED, output: 'pytest', elTimeout: 1000 }).code);
      const r = await runPytest(file, dir);
      const out = String(r.stdout);
      const summary = out.trim().split('\n').pop();
      check(r.error && /# Step 2: click/.test(out) && /^1 failed in /.test(summary),
        'a pytest test fails on the step that fails, and its browser is closed (no teardown error)', summary);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (pwRun) rmSync(pwRun, { recursive: true, force: true });
    // The checks after this one reload the test page.
    await ctx.web.goto(`${ctx.base}/page`);
    await sleep(PAGE_SETTLE_MS);
  }
}

export const CHECKS = [
  ['export-run', 'Exported code run on a page, as playback leaves it', checkExportRun],
];
