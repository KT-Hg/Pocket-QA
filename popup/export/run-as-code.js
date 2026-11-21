/**
 * export/run-as-code.js — 📱 Run as (shared/run-as.js) in exported code: the same
 * CDP commands the run sends (bg/cdp/run-session.js), so the exported test plays
 * on the device and network the extension plays on. Chromium only (Chrome, Edge):
 * Firefox and Safari have no CDP, and play as they are, saying so.
 *
 *   runAsCommands   [method, params] in the order the run sends them
 *   pyRunAsLines    _run_as(driver) for Selenium Python
 *   robotRunAsLines the "Run As" keyword for Robot Framework
 *   javaRunAsCode   runAs(driver) for Selenium Java
 *   playwrightRunAs test.use(…) fields for the device, the test's first lines for the network
 *
 * Pure — no chrome.*.
 */

import { DEVICES, NETWORKS, runAsOf, runAsText } from '../../shared/run-as.js';

/** The CDP commands `runAs` comes to, as the run sends them. */
export function runAsCommands(runAs) {
  const r = runAsOf(runAs);
  if (!r) return [];
  const out = [];
  const d = DEVICES[r.device];
  if (d) {
    out.push(['Emulation.setDeviceMetricsOverride', { width: d.width, height: d.height, deviceScaleFactor: d.dpr, mobile: true, screenWidth: d.width, screenHeight: d.height }]);
    out.push(['Emulation.setUserAgentOverride', { userAgent: d.ua }]);
    out.push(['Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }]);
  }
  const n = NETWORKS[r.network];
  if (n) {
    out.push(['Network.enable', {}]);
    out.push(['Network.emulateNetworkConditions', { offline: !!n.offline, latency: n.latency, downloadThroughput: n.download, uploadThroughput: n.upload }]);
  }
  return out;
}

/** A value as a Python literal: JSON, with Python's True / False. */
function py(v) {
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (Array.isArray(v)) return `[${v.map(py).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${py(x)}`).join(', ')}}`;
  return JSON.stringify(v);
}

/** Selenium Python: def _run_as(driver), or nothing. */
export function pyRunAsLines(runAs) {
  const cmds = runAsCommands(runAs);
  if (!cmds.length) return [];
  return [
    'def _run_as(driver):',
    `    """Run as ${runAsText(runAs)}, as the extension plays it — Chrome and Edge only (CDP)."""`,
    '    if not hasattr(driver, "execute_cdp_cmd"):',
    `        print("Run as ${runAsText(runAs)}: needs Chrome or Edge — this browser plays as it is")`,
    '        return',
    ...cmds.map(([m, p]) => `    driver.execute_cdp_cmd(${JSON.stringify(m)}, ${py(p)})`),
    '',
    '',
  ];
}

/** Robot Framework: the "Run As" keyword, or nothing. Each command one Evaluate cell (no double spaces). */
export function robotRunAsLines(runAs) {
  const cmds = runAsCommands(runAs);
  if (!cmds.length) return [];
  return [
    'Run As',
    `    [Documentation]    Run as ${runAsText(runAs)}, as the extension plays it — Chrome and Edge only (CDP).`,
    '    ${lib}=    Get Library Instance    SeleniumLibrary',
    "    IF    not hasattr($lib.driver, 'execute_cdp_cmd')",
    `        Log    Run as ${runAsText(runAs)}: needs Chrome or Edge — this browser plays as it is    WARN`,
    '        RETURN',
    '    END',
    ...cmds.map(([m, p]) => `    Evaluate    $lib.driver.execute_cdp_cmd(${JSON.stringify(m)}, ${py(p)})`),
    '',
  ];
}

/** A value as Java: Map.of(…) for an object. */
function java(v) {
  if (v && typeof v === 'object') return `Map.of(${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}, ${java(x)}`).join(', ')})`;
  if (typeof v === 'number' && !Number.isInteger(v)) return String(v);
  return JSON.stringify(v);
}

/** Selenium Java: static void runAs(WebDriver), or ''. */
export function javaRunAsCode(runAs) {
  const cmds = runAsCommands(runAs);
  if (!cmds.length) return '';
  return [
    `    /** Run as ${runAsText(runAs)}, as the extension plays it — Chrome and Edge only (CDP). */`,
    '    static void runAs(WebDriver driver) {',
    '        if (!(driver instanceof HasCdp)) {',
    `            System.out.println("Run as ${runAsText(runAs)}: needs Chrome or Edge — this browser plays as it is");`,
    '            return;',
    '        }',
    '        HasCdp cdp = (HasCdp) driver;',
    ...cmds.map(([m, p]) => `        cdp.executeCdpCommand(${JSON.stringify(m)}, ${java(p)});`),
    '    }',
  ].join('\n');
}

/** Into `warnings`: the export's browser cannot play `runAs` (Firefox, Safari: no CDP). */
export function warnRunAsBrowser(runAs, driverType, warnings) {
  const text = runAsText(runAs);
  if (text && (driverType === 'Firefox' || driverType === 'Safari')) {
    warnings.add(`Run as ${text} works in Chrome and Edge only (CDP): in ${driverType} the test plays as the browser is`);
  }
}

/**
 * Playwright: `use` — test.use fields for the device (Playwright's own emulation);
 * `lines` — the test's first lines for the network, through a CDP session (Chromium).
 */
export function playwrightRunAs(runAs) {
  const r = runAsOf(runAs);
  const d = DEVICES[r?.device];
  const use = d
    ? `viewport: { width: ${d.width}, height: ${d.height} }, deviceScaleFactor: ${d.dpr}, isMobile: true, hasTouch: true, userAgent: ${JSON.stringify(d.ua)}`
    : '';
  const net = runAsCommands({ network: r?.network });
  const lines = net.length
    ? [`// 📱 Run as: ${NETWORKS[r.network].name}, as the extension plays it — Chromium only (CDP).`,
      'const _cdp = await page.context().newCDPSession(page);',
      ...net.map(([m, p]) => `await _cdp.send(${JSON.stringify(m)}, ${JSON.stringify(p)});`), '']
    : [];
  return { use, lines };
}
