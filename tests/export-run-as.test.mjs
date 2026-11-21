// 📱 Run as (shared/run-as.js) in the code exports: the same CDP commands the run
// sends (bg/cdp/run-session.js). The Python helper is run against a recording
// driver when the machine has Python (else that test is skipped).
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
const { runAsCommands } = await import('../popup/export/run-as-code.js');

const STEPS = [{ type: 'navigate', url: 'https://shop.test/' }, { type: 'click', selector: '#a', selectors: { css: '#a' } }];
const RUN_AS = { device: 'pixel7', network: 'slow3g' };

test('the commands are the run\'s: device, user agent, touch, then the network', () => {
  assert.deepEqual(runAsCommands(RUN_AS).map(([m]) => m), ['Emulation.setDeviceMetricsOverride', 'Emulation.setUserAgentOverride',
    'Emulation.setTouchEmulationEnabled', 'Network.enable', 'Network.emulateNetworkConditions']);
  assert.equal(runAsCommands(RUN_AS)[0][1].deviceScaleFactor, 2.625);
  assert.deepEqual(runAsCommands(null), []);
});

test('no Run as: no code for it in any export', () => {
  for (const code of [generateSeleniumPy('x', STEPS, {}).code, generateRobot('x', STEPS, {}).code, generateJava('x', STEPS, {}).code, generatePlaywright('x', STEPS, {}).code]) {
    assert.doesNotMatch(code, /_run_as|Run As|runAs\(|_cdp|emulateNetworkConditions/);
  }
});

test('Robot, Java, Playwright and the Bookmarklet', () => {
  const robot = generateRobot('x', STEPS, {}, { runAs: RUN_AS }).code;
  assert.match(robot, /^ {4}Start Browser\n {4}Run As$/m);
  assert.match(robot, /^Run As\n/m);
  for (const line of robot.split('\n').filter((l) => l.includes('execute_cdp_cmd('))) {
    assert.ok(!/ {2}|\t/.test(line.split('Evaluate    ')[1]), `one Robot cell: ${line}`);
  }
  const java = generateJava('x', STEPS, {}, { runAs: RUN_AS }).code;
  assert.match(java, /driver = startBrowser\(\);\n {8}runAs\(driver\);/);
  assert.match(java, /cdp\.executeCdpCommand\("Emulation\.setDeviceMetricsOverride", Map\.of\("width", 412, "height", 915, "deviceScaleFactor", 2\.625, "mobile", true/);
  const pw = generatePlaywright('x', STEPS, {}, { runAs: RUN_AS }).code;
  assert.match(pw, /viewport: \{ width: 412, height: 915 \}, deviceScaleFactor: 2\.625, isMobile: true, hasTouch: true, userAgent: "Mozilla\/5\.0 \(Linux; Android 14; Pixel 7\)/);
  assert.match(pw, /await _cdp\.send\("Network\.emulateNetworkConditions", \{"offline":false,"latency":2000/);
  assert.match(generateBookmarklet('x', STEPS, {}, { runAs: RUN_AS }).warnings.join(), /is not exported: a bookmarklet plays in the page as it is/);
  assert.match(generateJava('x', STEPS, {}, { runAs: RUN_AS, driverType: 'Firefox' }).warnings.join(), /Chrome and Edge only/);
});

const python = (() => {
  for (const exe of ['python', 'python3']) {
    try { execFileSync(exe, ['--version'], { stdio: 'ignore' }); return exe; } catch { /* next */ }
  }
  return null;
})();

test('Selenium: _run_as sends the run\'s commands, in order, right after the browser starts', { skip: !python && 'no Python on this machine' }, () => {
  const code = generateSeleniumPy('x', STEPS, {}, { runAs: RUN_AS }).code;
  assert.match(code, /driver = _start_browser\(\)\n_run_as\(driver\)/);
  const helper = code.slice(code.indexOf('def _run_as(driver):'), code.indexOf('\n\n\n', code.indexOf('def _run_as(driver):')));
  const dir = mkdtempSync(join(tmpdir(), 'pqa-ra-'));
  try {
    const file = join(dir, 'ra.py');
    writeFileSync(file, [helper, '', 'import json', 'class D:', '    def __init__(self): self.calls = []',
      '    def execute_cdp_cmd(self, m, p): self.calls.append([m, p])', 'd = D()', '_run_as(d)', 'print(json.dumps(d.calls))'].join('\n'), 'utf8');
    const calls = JSON.parse(execFileSync(python, ['-X', 'utf8', file], { encoding: 'utf8' }));
    assert.deepEqual(calls, runAsCommands(RUN_AS));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
