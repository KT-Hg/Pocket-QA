// ↗ / ↩ Switch tab (bg/playback/steps/switch-tab.js) in the code exports: the helpers
// run here against a recording driver (Python, when the machine has it) and fake pages
// (Playwright), and every export writes the step.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { generateBookmarklet } = await import('../popup/export-bookmarklet.js');
const { generateSeleniumPy } = await import('../popup/export-selenium.js');
const { generatePlaywright } = await import('../popup/export-playwright.js');
const { generateRobot } = await import('../popup/export-robot.js');
const { generateJava } = await import('../popup/export-java.js');
const { PW_TABS_HELPER, PY_TABS_HELPER } = await import('../popup/export/switch-tab-code.js');

const STEPS = [
  { type: 'navigate', url: 'https://shop.test/' },
  { type: 'click', selector: '#invoice', selectors: { css: '#invoice' } },
  { type: 'switchTab', tabTarget: 'new', timeout: 4000 },
  { type: 'click', selector: '#pdf', selectors: { css: '#pdf' } },
  { type: 'switchTab', tabTarget: 'back', closeTab: true },
];

test('every export writes the steps; the Bookmarklet leaves them out, saying why', () => {
  assert.match(generateSeleniumPy('x', STEPS, {}).code, /^ +_new_tab\(driver, 4\)$[\s\S]*^ +_back_tab\(driver, True\)$/m);
  assert.match(generateSeleniumPy('x', STEPS, {}).code, /^_tabs\["seen"\]\.update\(driver\.window_handles\)$/m);
  assert.match(generatePlaywright('x', STEPS, {}).code, /async \(\{ page, context \}\) => \{[\s\S]*const _tabs = _watchTabs\(context\);[\s\S]*page = await _newTab\(_tabs, page, 4\);[\s\S]*page = await _backTab\(_tabs, page, true\);/);
  assert.match(generateRobot('x', STEPS, {}).code, /^ {4}Switch To New Tab {4}4$[\s\S]*^ {4}Switch Back Tab {4}\$\{True\}$/m);
  assert.match(generateRobot('x', STEPS, {}).code, /^@\{PQA_TABS\}$/m);
  const java = generateJava('x', STEPS, {}).code;
  assert.match(java, /newTab\(4\);[\s\S]*backTab\(true\);/);
  assert.match(java, /seenTabs\.addAll\(driver\.getWindowHandles\(\)\);/);
  const bk = generateBookmarklet('x', STEPS, {});
  assert.deepEqual(bk.steps.filter((s) => s.type === 'switchTab').map((s) => s.reason), Array(2).fill('a bookmarklet plays in one page: it cannot follow another tab'));
  // No step: no helper.
  assert.doesNotMatch(generateSeleniumPy('x', STEPS.slice(0, 2), {}).code, /_new_tab|_tabs/);
  assert.doesNotMatch(generatePlaywright('x', STEPS.slice(0, 2), {}).code, /_watchTabs|context/);
});

test('Playwright: _newTab takes the page the context opened, _backTab closes it and goes back', async () => {
  const fns = new Function(`${PW_TABS_HELPER}\nreturn { _watchTabs, _newTab, _backTab };`)();
  const handlers = [];
  const context = { on: (ev, fn) => handlers.push(fn) };
  const page = (name) => ({ name, closed: false, front: 0, isClosed() { return this.closed; }, async waitForLoadState() {}, async bringToFront() { this.front++; }, async close() { this.closed = true; } });
  const first = page('first');
  const tabs = fns._watchTabs(context);
  const child = page('child');
  setTimeout(() => handlers.forEach((h) => h(child)), 30);
  const now = await fns._newTab(tabs, first, 2);
  assert.equal(now, child);
  assert.equal(child.front, 1);
  const back = await fns._backTab(tabs, now, true);
  assert.equal(back, first);
  assert.ok(child.closed && first.front === 1);
  await assert.rejects(fns._newTab(tabs, first, 0.2), /No new tab opened by this one within 0\.2 s/);
  await assert.rejects(fns._backTab(tabs, first, false), /No tab to go back to/);
});

const python = (() => {
  for (const exe of ['python', 'python3']) {
    try { execFileSync(exe, ['--version'], { stdio: 'ignore' }); return exe; } catch { /* next */ }
  }
  return null;
})();

test('Selenium: _new_tab switches to the handle not seen before, _back_tab closes and comes back', { skip: !python && 'no Python on this machine' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pqa-st-'));
  try {
    const file = join(dir, 'st.py');
    writeFileSync(file, [
      'import time, json', ...PY_TABS_HELPER, '',
      'class Sw:',
      '    def __init__(self, d): self.d = d',
      '    def window(self, h): self.d.current_window_handle = h; self.d.log.append("to " + h)',
      'class D:',
      '    def __init__(self): self.window_handles = ["A"]; self.current_window_handle = "A"; self.log = []; self.switch_to = Sw(self)',
      '    def close(self): self.window_handles.remove(self.current_window_handle); self.log.append("close " + self.current_window_handle)',
      'd = D()',
      '_tabs["seen"].update(d.window_handles)',
      'd.window_handles.append("B")',
      '_new_tab(d, 1)',
      '_back_tab(d, True)',
      'try:',
      '    _new_tab(d, 0.2)',
      'except Exception as e:',
      '    d.log.append(str(e))',
      'print(json.dumps(d.log))',
    ].join('\n'), 'utf8');
    const log = JSON.parse(execFileSync(python, ['-X', 'utf8', file], { encoding: 'utf8' }));
    assert.deepEqual(log, ['to B', 'close B', 'to A', 'No new tab opened by this one within 0.2 s']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
