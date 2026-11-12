/**
 * tools/e2e/export.mjs — e2e: the export suite. Run by tools/e2e.mjs.
 */

import { sleep } from '../lib/cdp-browser.mjs';
import { POLL_MS, POPUP_SETTLE_MS, SETTLE_MS, check, makeScenario, openPopup } from './harness.mjs';

export async function checkExportFileName(ctx) {
  const id = await makeScenario(ctx, 'Đăng nhập "admin"', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const popup = await openPopup(ctx);
  try {
    // The download's name, and whether its blob can still be read once the browser gets to it.
    await popup.evaluate(`(() => {
      window.__dl = [];
      HTMLAnchorElement.prototype.click = function () {
        const entry = { name: this.download };
        window.__dl.push(entry);
        setTimeout(() => fetch(this.href).then((r) => r.text()).then((t) => { entry.bytes = t.length; }, () => { entry.bytes = 0; }), 50);
      };
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      document.getElementById('exportSelenium').click();
    })()`);
    await sleep(POPUP_SETTLE_MS);
    await popup.evaluate(`document.getElementById('exportDownload').click()`);
    await sleep(SETTLE_MS);
    const dl = await popup.evaluate('window.__dl[0] || null');
    check(dl?.name === 'đăng_nhập__admin__selenium.py' && dl.bytes > 0,
      'an exported file keeps the letters of the scenario name, and holds the code', dl);
  } finally {
    await popup.close();
  }
}

// The Robot export with a data file: Download saves the test and the DataDriver
// reader beside it, both for real — a page's second download is held back by the
// browser, so the reader goes through chrome.downloads. A .py file waits for the
// browser's "Keep" (as the Selenium export's does), so it is seen in the
// download list, not yet on disk.
export async function checkExportRobotData(ctx) {
  const id = await makeScenario(ctx, 'rf data', [{ type: 'input', selector: '#out', selectors: { css: '#out' }, value: '${who}' }]);
  const popup = await openPopup(ctx);
  try {
    await popup.evaluate(`(() => {
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      document.getElementById('exportRobot').click();
    })()`);
    await sleep(POPUP_SETTLE_MS);
    await popup.evaluate(`(() => {
      const f = document.getElementById('exportRfData');
      f.value = 'people.csv';
      f.dispatchEvent(new Event('input', { bubbles: true }));
      f.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(SETTLE_MS);
    const code = await popup.evaluate(`document.querySelector('#exportCode code').textContent`);
    check(/^Library {13}DataDriver {4}file=people\.csv {4}reader_class=pqa_csv_reader\.py$/m.test(code),
      'the Robot code follows the Data file setting', code.split('\n').filter((l) => l.includes('DataDriver')));
    await popup.evaluate(`document.getElementById('exportDownload').click()`);
    let names = [];
    for (let waited = 0; names.length < 2 && waited < 5_000; waited += POLL_MS) {
      await sleep(POLL_MS);
      names = await popup.evaluate(`new Promise((res) => chrome.downloads.search({}, (items) =>
        res(items.map((i) => i.filename.split(/[\\\\/]/).pop()).filter((n) => /^(rf_data\\.robot|pqa_csv_reader\\.py)$/.test(n)))))`);
    }
    check(names.includes('rf_data.robot') && names.includes('pqa_csv_reader.py'),
      'Download saves the .robot file and pqa_csv_reader.py beside it', names);
  } finally {
    await popup.close();
  }
}

/**
 * The 11 steps the export modal is checked with (tasks/plan-6): named steps, a
 * Condition, a script, a full-page screenshot and an upload the bookmarklet
 * leaves out. With the variable pass-word saved, the exports note its new name.
 * A value is markup, which the code box must show as text.
 */
const EXPORT_SAMPLE = [
  { type: 'navigate', url: 'https://shop.test/login' },
  { type: 'input', selector: '#user', selectors: { css: '#user' }, value: 'alice<img src=x onerror="window.__xss=1">', label: 'Username' },
  { type: 'input', selector: '#pass', selectors: { css: '#pass' }, value: '${pass-word}' },
  { type: 'click', selector: '#login', selectors: { css: '#login' }, label: 'Sign in' },
  { type: 'condition', conditionType: 'elementExists', selector: '.welcome', selectors: { css: '.welcome' } },
  { type: 'click', selector: '.welcome', selectors: { css: '.welcome' } },
  { type: 'script', code: 'console.log(1)' },
  { type: 'readdom', selector: '#total', selectors: { css: '#total' }, varName: 'total' },
  { type: 'screenshot_full' },
  { type: 'uploadFile', selector: '#upload', selectors: { css: '#upload' }, folderPath: 'C:\\in', fileNames: ['a.txt'] },
  { type: 'click', selector: '#logout', selectors: { css: '#logout' } },
];

/** In `popup`, pick scenario `id` in the Export Code card and open `button`'s export. */
async function openExport(popup, id, button) {
  await popup.evaluate(`(() => {
    const s = document.getElementById('exportCodeSelect');
    s.value = ${JSON.stringify(id)};
    s.dispatchEvent(new Event('change'));
    document.getElementById(${JSON.stringify(button)}).click();
  })()`);
  await sleep(POPUP_SETTLE_MS);
}

export async function checkExportSteps(ctx) {
  const id = await makeScenario(ctx, 'e2e export steps', [
    { type: 'click', selector: '#bg1', selectors: { css: '#bg1' } },
    { type: 'uploadFile', selector: '#upload', selectors: { css: '#upload' }, folderPath: 'C:\\in', fileNames: ['a.txt'] },
  ]);
  const sample = await makeScenario(ctx, 'e2e export sample', EXPORT_SAMPLE);
  const popup = await openPopup(ctx);
  try {
    await popup.evaluate(`(() => {
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
    })()`);
    for (const [button, skipped] of [['exportSelenium', false], ['exportBookmarklet', true]]) {
      await popup.evaluate(`document.getElementById(${JSON.stringify(button)}).click()`);
      await sleep(POPUP_SETTLE_MS);
      const tab = await popup.evaluate(`({
        rows: [...document.querySelectorAll('#exportActList .export-bm-action-status')].map((el) => el.textContent.trim()),
        skipped: document.getElementById('exportSub').textContent.match(/\\d+ skipped/)?.[0] || null,
        warning: document.getElementById('exportWarning').hidden ? '' : document.getElementById('exportWarningText').textContent,
        notices: document.getElementById('exportActSummary').textContent,
      })`);
      const said = skipped
        ? JSON.stringify(tab.rows) === '["✓ OK","— Skip"]' && tab.skipped === '1 skipped' && tab.warning === '1 skipped — see Actions'
          && /Step 2 — a bookmarklet cannot read local files/.test(tab.notices)
        : JSON.stringify(tab.rows) === '["✓ OK","✓ OK"]' && tab.skipped === null && tab.warning === '';
      check(said, `${button}: the Actions tab, the header and the warning bar say whether Upload File is exported`, tab);
      await popup.evaluate(`document.getElementById('exportClose').click()`);
    }

    // What each row and the header say about the sample.
    await openExport(popup, sample, 'exportBookmarklet');
    const shown = await popup.evaluate(`({
      sub: document.getElementById('exportSub').textContent,
      rows: [...document.querySelectorAll('#exportActList .export-bm-action-row')].map((r) => ({
        type: r.querySelector('.export-bm-action-type').textContent.trim(),
        label: r.querySelector('.export-bm-action-label')?.textContent || '',
        desc: r.querySelector('.export-bm-action-desc').textContent.trim() })),
    })`);
    const row = (n) => shown.rows[n - 1] || {};
    check(shown.sub === 'e2e_export_sample_bookmarklet.js · 11 steps · 2 skipped',
      'the header counts every step and the skipped ones, as the Actions tab lists them', shown.sub);
    check(row(9).desc === 'full page' && row(10).type === '📎 upload' && row(5).desc === 'elementExists · .welcome',
      'a full-page screenshot says so, Upload File has its badge, a Condition names its element', [row(5), row(9), row(10)]);
    check(row(4).label === 'Sign in' && row(4).desc === 'Sign in #login' && row(3).label === '',
      'a named step reads by its name, its selector after it', [row(3), row(4)]);
  } finally {
    await popup.close();
  }
}

export async function checkExportRegenerate(ctx) {
  await ctx.send({ type: 'SAVE_VARIABLES', variables: { used: 'u', unused: 'x' } });
  const id = await makeScenario(ctx, 'e2e export regenerate', [
    { type: 'input', selector: '#out', selectors: { css: '#out' }, value: '${used}' },
  ]);
  const popup = await openPopup(ctx);
  try {
    await popup.evaluate(`(() => {
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
    })()`);
    let added = 0;
    for (const button of ['exportSelenium', 'exportBookmarklet']) {
      await popup.evaluate(`document.getElementById(${JSON.stringify(button)}).click()`);
      await sleep(POPUP_SETTLE_MS);
      // The scenario changes while the modal is open; Reload scenario has to show it.
      const marker = `regen${++added}`;
      await ctx.send({ type: 'ADD_MANUAL_ACTION', scenarioId: id,
        action: { type: 'click', selector: `#${marker}`, selectors: { css: `#${marker}` } } });
      await popup.evaluate(`document.getElementById('exportReload').click()`);
      await sleep(POPUP_SETTLE_MS);
      const shown = await popup.evaluate(`({
        vars: [...document.querySelectorAll('#exportVarList .export-bm-var-name')].map((el) => el.textContent),
        code: document.querySelector('#exportCode code').textContent,
      })`);
      check(JSON.stringify(shown.vars) === '["${used}"]' && shown.code.includes(`#${marker}`) && !/\bunused\b/.test(shown.code),
        `${button}: Reload scenario reads the scenario again and keeps to the variables it uses`,
        { vars: shown.vars, hasNewStep: shown.code.includes(`#${marker}`), declaresUnused: /\bunused\b/.test(shown.code) });
      await popup.evaluate(`document.getElementById('exportClose').click()`);
    }
  } finally {
    await popup.close();
  }
}

export async function checkExportHeadless(ctx) {
  const id = await makeScenario(ctx, 'e2e export headless', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const popup = await openPopup(ctx);
  try {
    const code = () => popup.evaluate(`document.querySelector('#exportCode code').textContent`);
    await popup.evaluate(`(() => {
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      document.getElementById('exportSelenium').click();
    })()`);
    await sleep(POPUP_SETTLE_MS);
    // A click on the row's text flips the switch, as on any switch row; the code follows.
    await popup.evaluate(`document.querySelector('#exportSeleniumHeadlessRow .export-bm-setting-label').click()`);
    await sleep(SETTLE_MS);
    const on = await code();
    // The exported browser and window are what _start_browser falls back on.
    check(/os\.environ\.get\("PQA_BROWSER", "Chrome"\)\n {4}headless = os\.environ\.get\("PQA_HEADLESS", "1"\) == "1"/.test(on),
      'Headless on: the script starts Chrome without a window', on.split('\n').filter((l) => /PQA_BROWSER|PQA_HEADLESS/.test(l)));
    await popup.evaluate(`(() => {
      const d = document.getElementById('exportSeleniumDriver');
      d.value = 'Safari';
      d.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(SETTLE_MS);
    const box = await popup.evaluate(`(({ checked, disabled }) => ({ checked, disabled }))(document.getElementById('exportSeleniumHeadless'))`);
    const safari = await code();
    check(!box.checked && box.disabled && /os\.environ\.get\("PQA_BROWSER", "Safari"\)\n {4}headless = os\.environ\.get\("PQA_HEADLESS", "0"\)/.test(safari),
      'Safari: Headless is off and cannot be turned on', box);
  } finally {
    await popup.close();
  }
}

export async function checkExportStartUrl(ctx) {
  const id = await makeScenario(ctx, 'e2e export start url', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const popup = await openPopup(ctx);
  try {
    // The popup here is a tab of its own, so the active tab is the page under test as it
    // is over a real popup, and it answers a moment later, as chrome.tabs.query does.
    await popup.evaluate(`(() => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (q, cb) => (q?.active ? setTimeout(() => cb([{ url: 'https://shop.test/start' }]), 50) : query(q, cb));
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      document.getElementById('exportSelenium').click();
    })()`);
    await sleep(POPUP_SETTLE_MS);
    const shown = await popup.evaluate(`({
      field: document.getElementById('exportSeleniumStartUrl').value,
      code: document.querySelector('#exportCode code').textContent,
    })`);
    check(shown.field === 'https://shop.test/start' && shown.code.includes('driver.get(_url("https://shop.test/start"))') && !shown.code.includes('your-url-here'),
      'Selenium: the start URL taken from the tab is in the code the modal first shows',
      { field: shown.field, get: shown.code.split('\n').filter((l) => l.includes('driver.get')) });

    // Playwright the same way, the badge saying where it came from; 🔄 takes the tab's URL again.
    await popup.evaluate(`document.getElementById('exportClose').click(); document.getElementById('exportPlaywright').click()`);
    await sleep(POPUP_SETTLE_MS);
    const pw = () => popup.evaluate(`({
      field: document.getElementById('exportPwStartUrl').value,
      badge: document.getElementById('exportPwUrlFromTab').style.display !== 'none',
      code: document.querySelector('#exportCode code').textContent,
    })`);
    const first = await pw();
    check(first.field === 'https://shop.test/start' && first.badge && first.code.includes('await page.goto(_url("https://shop.test/start"));'),
      'Playwright: the start URL is taken from the tab too, and the badge says so', { field: first.field, badge: first.badge });
    await popup.evaluate(`(() => {
      const query = chrome.tabs.query;
      chrome.tabs.query = (q, cb) => (q?.active ? setTimeout(() => cb([{ url: 'https://shop.test/other' }]), 50) : query(q, cb));
      document.getElementById('exportPwGetUrl').click();
    })()`);
    await sleep(SETTLE_MS);
    const again = await pw();
    check(again.field === 'https://shop.test/other' && again.code.includes('await page.goto(_url("https://shop.test/other"));'),
      'Playwright: 🔄 takes the tab\'s URL again, and the code follows', { field: again.field });
  } finally {
    await popup.close();
  }
}

export async function checkExportUrlField(ctx) {
  const id = await makeScenario(ctx, 'e2e export url field', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const popup = await openPopup(ctx);
  try {
    const NAMES = { exportSelenium: 'Selenium', exportPlaywright: 'Playwright', exportRobot: 'Robot', exportJava: 'Java' };
    for (const [button, field] of [['exportSelenium', 'exportSeleniumStartUrl'], ['exportPlaywright', 'exportPwStartUrl'], ['exportRobot', 'exportRfStartUrl'],
      ['exportJava', 'exportJavaStartUrl']]) {
      await popup.evaluate(`(() => {
        const s = document.getElementById('exportCodeSelect');
        s.value = ${JSON.stringify(id)};
        s.dispatchEvent(new Event('change'));
        document.getElementById(${JSON.stringify(button)}).click();
      })()`);
      await sleep(POPUP_SETTLE_MS);
      await popup.evaluate(`document.querySelector('#exportModal .export-bm-tab[data-tab="settings"]').click()`);
      await sleep(SETTLE_MS);
      const box = await popup.evaluate(`(() => {
        const f = document.getElementById(${JSON.stringify(field)});
        const row = f.closest('.export-bm-setting-row');
        return { field: Math.round(f.getBoundingClientRect().width), row: Math.round(row.getBoundingClientRect().width),
          align: getComputedStyle(f).textAlign };
      })()`);
      // The row's width less its padding and the 🔄 button: a URL is read from its start.
      check(box.field >= box.row - 80 && box.align !== 'right',
        `${NAMES[button]}: the Starting URL field spans its row, the URL read from its start`, box);
      await popup.evaluate(`document.getElementById('exportClose').click()`);
      await sleep(SETTLE_MS);
    }
  } finally {
    await popup.close();
  }
}

export async function checkExportOutput(ctx) {
  const id = await makeScenario(ctx, 'Đăng nhập pytest', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const popup = await openPopup(ctx);
  try {
    await popup.evaluate(`(() => {
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      document.getElementById('exportSelenium').click();
    })()`);
    await sleep(POPUP_SETTLE_MS);
    const dataRow = () => popup.evaluate(`getComputedStyle(document.getElementById('exportSeleniumDataRow')).display !== 'none'`);
    const scriptRow = await dataRow();
    await popup.evaluate(`(() => {
      const o = document.getElementById('exportSeleniumOutput');
      o.value = 'pytest';
      o.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(SETTLE_MS);
    const shown = await popup.evaluate(`({
      label: document.getElementById('exportCodeLabel').textContent,
      code: document.querySelector('#exportCode code').textContent,
    })`);
    check(shown.label === 'test_đăng_nhập_pytest.py' && /^import pytest$/m.test(shown.code) && /^def test_dang_nhap_pytest\(browser\):$/m.test(shown.code),
      'Output pytest: a test_….py file pytest finds, with a test function', { label: shown.label });
    // The data file is pytest's: its field shows only then, and the code follows what is typed in it.
    await popup.evaluate(`(() => { const f = document.getElementById('exportSeleniumData'); f.value = 'data.csv';
      f.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(SETTLE_MS);
    const withData = await popup.evaluate(`document.querySelector('#exportCode code').textContent`);
    check(!scriptRow && await dataRow() && /^@pytest\.mark\.parametrize\("_row", _rows\("data\.csv"\)\)$/m.test(withData),
      'Output pytest: the Data file (CSV) field shows, and a file named there gives a test per row', { scriptRow });
  } finally {
    await popup.close();
  }
}

export async function checkExportSettings(ctx) {
  const id = await makeScenario(ctx, 'e2e export settings', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  // Open the popup, pick the scenario, open `button`'s export, run `then`, close the popup.
  const withModal = async (button, then) => {
    const popup = await openPopup(ctx);
    try {
      await popup.evaluate(`(() => {
        const s = document.getElementById('exportCodeSelect');
        s.value = ${JSON.stringify(id)};
        s.dispatchEvent(new Event('change'));
        document.getElementById(${JSON.stringify(button)}).click();
      })()`);
      await sleep(POPUP_SETTLE_MS);
      return await then(popup);
    } finally {
      await popup.close();
    }
  };
  const set = (popup, values) => popup.evaluate(`(() => {
    for (const [id, v] of Object.entries(${JSON.stringify(values)})) {
      const el = document.getElementById(id);
      if (el.type === 'checkbox') el.checked = v; else el.value = v;
      el.dispatchEvent(new Event('change'));
    }
  })()`);
  const read = (popup, ids) => popup.evaluate(`Object.fromEntries(${JSON.stringify(ids)}.map((id) => {
    const el = document.getElementById(id);
    return [id, el.type === 'checkbox' ? el.checked : el.value];
  }))`);
  const PY = ['exportSeleniumElTimeout', 'exportSeleniumDriver', 'exportSeleniumHeadless', 'exportSeleniumOutput'];

  await ctx.ext.evaluate(`chrome.storage.local.remove('exportCodeSettings')`);
  await withModal('exportSelenium', (p) => set(p, { exportSeleniumElTimeout: '4321', exportSeleniumDriver: 'Firefox',
    exportSeleniumHeadless: true, exportSeleniumOutput: 'pytest' }));
  await withModal('exportBookmarklet', (p) => set(p, { exportBmElTimeout: '2222' }));
  const py = await withModal('exportSelenium', async (p) => ({ ...await read(p, PY),
    code: await p.evaluate(`document.querySelector('#exportCode code').textContent`) }));
  check(py.exportSeleniumElTimeout === '4321' && py.exportSeleniumDriver === 'Firefox' && py.exportSeleniumHeadless === true
    && py.exportSeleniumOutput === 'pytest' && /os\.environ\.get\("PQA_BROWSER", "Firefox"\)/.test(py.code) && /_find\(\[.*\], 4\.321, clickable=True\)/.test(py.code),
    'the Selenium Settings come back in a new popup, and the code is made with them', { ...py, code: undefined });
  const js = await withModal('exportBookmarklet', (p) => read(p, ['exportBmElTimeout', 'exportBmStepDelay']));
  check(js.exportBmElTimeout === '2222' && js.exportBmStepDelay === '300', 'the JS Settings come back, untouched by the Selenium ones', js);
  const RF = ['exportRfElTimeout', 'exportRfBrowser', 'exportRfHeadless', 'exportRfStepDelay'];
  await withModal('exportRobot', (p) => set(p, { exportRfElTimeout: '4321', exportRfBrowser: 'Firefox', exportRfHeadless: true, exportRfStepDelay: '0' }));
  const rf = await withModal('exportRobot', async (p) => ({ ...await read(p, RF),
    code: await p.evaluate(`document.querySelector('#exportCode code').textContent`) }));
  check(rf.exportRfElTimeout === '4321' && rf.exportRfBrowser === 'Firefox' && rf.exportRfHeadless === true && rf.exportRfStepDelay === '0'
    && /^\$\{PQA_TIMEOUT\} +\$\{4\.321\}$/m.test(rf.code) && /^\$\{PQA_BROWSER\} +Firefox$/m.test(rf.code) && /^\$\{PQA_HEADLESS\} +1$/m.test(rf.code),
    'the Robot Settings come back in a new popup, and the code is made with them', { ...rf, code: undefined });
  const JAVA = ['exportJavaElTimeout', 'exportJavaDriver', 'exportJavaHeadless', 'exportJavaStepDelay'];
  await withModal('exportJava', (p) => set(p, { exportJavaElTimeout: '4321', exportJavaDriver: 'Firefox', exportJavaHeadless: true, exportJavaStepDelay: '0' }));
  const java = await withModal('exportJava', async (p) => ({ ...await read(p, JAVA),
    code: await p.evaluate(`document.querySelector('#exportCode code').textContent`) }));
  check(java.exportJavaElTimeout === '4321' && java.exportJavaDriver === 'Firefox' && java.exportJavaHeadless === true && java.exportJavaStepDelay === '0'
    && java.code.includes('Duration.ofMillis(4321)') && java.code.includes('BROWSER = "Firefox"') && java.code.includes('HEADLESS = "1"'),
    'the Java Settings come back in a new popup, and the code is made with them', { ...java, code: undefined });

  // Headless on, then Safari: Headless was kept on; Safari, put back first, turns it off again.
  await withModal('exportSelenium', (p) => set(p, { exportSeleniumHeadless: true, exportSeleniumDriver: 'Safari' }));
  const safari = await withModal('exportSelenium', (p) => p.evaluate(`(({ checked, disabled }) => ({ checked, disabled,
    driver: document.getElementById('exportSeleniumDriver').value }))(document.getElementById('exportSeleniumHeadless'))`));
  check(safari.driver === 'Safari' && !safari.checked && safari.disabled, 'Safari comes back with Headless off', safari);

  // Wrap: turned on in one popup, still on in the next, for another format too.
  const wrapOf = (p) => p.evaluate(`({ pressed: document.getElementById('exportWrapBtn').getAttribute('aria-pressed'),
    wraps: getComputedStyle(document.getElementById('exportCode')).whiteSpace })`);
  const turnedOn = await withModal('exportSelenium', async (p) => {
    await p.evaluate(`document.getElementById('exportWrapBtn').click()`);
    return wrapOf(p);
  });
  const kept = await withModal('exportBookmarklet', wrapOf);
  check(turnedOn.pressed === 'true' && turnedOn.wraps === 'pre-wrap' && kept.pressed === 'true' && kept.wraps === 'pre-wrap',
    'wrap shows it is on, and is still on in a new popup', { turnedOn, kept });

  // Broken or stale storage: the defaults, not the bad values.
  await ctx.ext.evaluate(`chrome.storage.local.set({ exportCodeSettings: { py: { exportSeleniumDriver: 'Opera',
    exportSeleniumElTimeout: 'abc', exportSeleniumHeadless: 'yes' }, js: 'garbage' } })`);
  const bad = await withModal('exportSelenium', (p) => read(p, PY));
  check(bad.exportSeleniumDriver === 'Chrome' && bad.exportSeleniumElTimeout === '10000' && bad.exportSeleniumHeadless === false,
    'a stored value an input cannot take leaves its default', bad);
  await ctx.ext.evaluate(`chrome.storage.local.remove('exportCodeSettings')`);
}

export async function checkExportLiveSettings(ctx) {
  const id = await makeScenario(ctx, 'e2e export live', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  await ctx.ext.evaluate(`chrome.storage.local.set({ exportCodeSettings: { py: { exportSeleniumOutput: 'pytest', exportSeleniumStepDelay: '700' } } })`);
  const popup = await openPopup(ctx);
  try {
    // Every time the code is shown, and what Copy put on the clipboard.
    await popup.evaluate(`(() => {
      window.__renders = 0;
      new MutationObserver((records) => { window.__renders += records.length; })
        .observe(document.querySelector('#exportCode code'), { childList: true });
      window.__copied = [];
      navigator.clipboard.writeText = async (t) => { window.__copied.push(t); };
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      document.getElementById('exportSelenium').click();
    })()`);
    await sleep(POPUP_SETTLE_MS);
    const opened = await popup.evaluate(`({ renders: window.__renders, label: document.getElementById('exportCodeLabel').textContent,
      code: document.querySelector('#exportCode code').textContent })`);
    check(opened.renders === 1 && opened.label === 'test_e2e_export_live.py' && opened.code.includes('time.sleep(0.7)'),
      'opening with remembered Settings shows code made with them, generated once', { ...opened, code: undefined });

    // A change, then Copy at once, nothing else pressed: the clipboard has the code made with it.
    const thenCopy = (js) => popup.evaluate(`(() => {
      ${js}
      document.getElementById('exportCopy').click();
      return { copied: window.__copied.at(-1) || '', label: document.getElementById('exportCodeLabel').textContent };
    })()`);
    const pick = (id, value) => `(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', { bubbles: true })); })();`;
    const headless = await thenCopy(`document.querySelector('#exportSeleniumHeadlessRow .export-bm-setting-label').click();`);
    check(headless.copied.includes('os.environ.get("PQA_HEADLESS", "1")'), 'Headless switched on: Copy takes the headless code', headless.label);
    const driver = await thenCopy(pick('exportSeleniumDriver', 'Firefox'));
    check(driver.copied.includes('os.environ.get("PQA_BROWSER", "Firefox")'), 'WebDriver Firefox: Copy takes the Firefox code', driver.label);
    const output = await thenCopy(pick('exportSeleniumOutput', 'script'));
    check(output.label === 'e2e_export_live_selenium.py' && !/^import pytest$/m.test(output.copied),
      'Output Script: the file name and the code follow', output.label);
    // Typing: the code follows once it pauses; leaving the field (change) at once.
    await popup.evaluate(`(() => { const el = document.getElementById('exportSeleniumStepDelay'); el.value = '1234';
      el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(SETTLE_MS * 2);
    const typed = await popup.evaluate(`document.querySelector('#exportCode code').textContent`);
    check(typed.includes('time.sleep(1.234)'), 'a delay typed in is in the code once typing pauses', typed.match(/time\.sleep\([^)]*\)/)?.[0]);
    const left = await thenCopy(`(() => { const el = document.getElementById('exportSeleniumStepDelay'); el.value = '2345';
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })();`);
    check(left.copied.includes('time.sleep(2.345)'), 'a delay typed in, then Copy: the clipboard has it', left.copied.match(/time\.sleep\([^)]*\)/)?.[0]);
  } finally {
    await popup.close();
    await ctx.ext.evaluate(`chrome.storage.local.remove('exportCodeSettings')`);
  }
}

// An element's box in `page`, rounded.
const boxOf = (page, selector) => page.evaluate(`(() => {
  const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
  return { top: Math.round(r.top), left: Math.round(r.left), height: Math.round(r.height), bottom: Math.round(r.bottom) };
})()`);

const showExportTab = (page, tab) => page.evaluate(`document.querySelector('#exportModal .export-bm-tab[data-tab="${tab}"]').click()`);

export async function checkExportLayout(ctx) {
  const plain = await makeScenario(ctx, 'e2e export layout', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const sample = await makeScenario(ctx, 'e2e export layout sample', EXPORT_SAMPLE);
  await ctx.send({ type: 'SAVE_VARIABLES', variables: { 'pass-word': 'secret' } });
  // A real popup is at most 600 px tall.
  const tall = await openPopup(ctx, { width: 480, height: 600 });
  try {
    await openExport(tall, plain, 'exportSelenium');
    const code = await boxOf(tall, '#exportCode');
    check(code.height >= 400, 'at 480 × 600, Selenium with nothing to warn about: the code is at least 400 px tall', code);
    const copy = [];
    const shown = [];
    for (const tab of ['variables', 'actions', 'settings', 'preview']) {
      await showExportTab(tall, tab);
      copy.push(await boxOf(tall, '#exportCopy'));
      shown.push(await tall.evaluate(`[...document.querySelectorAll('#exportModal .export-bm-tab-panel')]
        .filter((p) => getComputedStyle(p).display !== 'none').map((p) => p.id).join()`));
    }
    check(copy.every((c) => c.top === copy[0].top && c.left === copy[0].left), 'Copy stays where it is through the four tabs', copy);
    check(shown.join(' ') === 'exportTabVariables exportTabActions exportTabSettings exportTabPreview', 'each tab shows its panel alone', shown);

    // The bookmarklet of the sample: four reasons and a note, counted in one line over the code.
    await tall.evaluate(`document.getElementById('exportClose').click()`);
    await openExport(tall, sample, 'exportBookmarklet');
    const bar = await boxOf(tall, '#exportWarning');
    const bmCode = await boxOf(tall, '#exportCode');
    check(bar.height <= 32 && bmCode.height >= 360, 'the bookmarklet\'s warnings take one line; the code keeps at least 360 px',
      { bar: bar.height, code: bmCode.height });
    await tall.evaluate(`document.getElementById('exportWarning').click()`);
    const listed = await tall.evaluate(`({
      actions: !document.getElementById('exportTabActions').hidden,
      bar: document.getElementById('exportWarningText').textContent,
      groups: [...document.querySelectorAll('#exportActSummary .export-bm-notice-group')]
        .map((g) => [g.querySelector('.export-bm-notice-title').textContent, ...[...g.querySelectorAll('li')].map((li) => li.textContent)]),
    })`);
    const [check2, skip2, notes] = listed.groups;
    check(listed.actions && listed.bar === '2 to check · 2 skipped · 1 note — see Actions'
      && check2?.[0] === 'To check' && check2.length === 3 && check2[2].startsWith('Step 7 — custom JS')
      && skip2?.[0] === 'Skipped' && skip2.length === 3 && notes?.[0] === 'Notes' && /pass_word/.test(notes[1]),
      'a click on the bar opens Actions, which lists the four reasons and the note', listed);
  } finally {
    await tall.close();
  }
  const short = await openPopup(ctx, { width: 480, height: 500 });
  try {
    await openExport(short, sample, 'exportSelenium');
    const code = await boxOf(short, '#exportCode');
    await showExportTab(short, 'settings');
    const fit = await short.evaluate(`(() => {
      const panel = document.getElementById('exportTabSettings');
      panel.scrollTop = panel.scrollHeight;
      const last = document.getElementById('exportReload').getBoundingClientRect();
      return { footer: Math.round(document.querySelector('.export-bm-footer').getBoundingClientRect().bottom), view: innerHeight,
        last: Math.round(last.bottom), panel: Math.round(panel.getBoundingClientRect().bottom) };
    })()`);
    check(code.height >= 150 && fit.footer <= fit.view && fit.last <= fit.panel,
      'at 480 × 500 the code, the footer and, scrolled, the last of the Settings all show', { code: code.height, ...fit });
  } finally {
    await short.close();
  }
}

/** A real key press on the focused element of `page`. */
async function pressKey(page, key, code, keyCode, text) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
}

export async function checkExportJump(ctx) {
  const sample = await makeScenario(ctx, 'e2e export jump', EXPORT_SAMPLE);
  const popup = await openPopup(ctx, { width: 480, height: 600 });
  try {
    await openExport(popup, sample, 'exportSelenium');
    // The line that opens step n: its text, whether the code box shows it, whether it is tinted.
    const stepLine = (n) => popup.evaluate(`(() => {
      const pre = document.getElementById('exportCode');
      const line = pre.querySelector('.export-bm-line[data-step="${n}"]');
      const p = pre.getBoundingClientRect(), r = line.getBoundingClientRect();
      return { text: line.textContent, inView: r.top >= p.top && r.bottom <= p.bottom, scrollTop: Math.round(pre.scrollTop),
        tinted: line.classList.contains('export-bm-line-flash') && getComputedStyle(line).backgroundColor !== 'rgba(0, 0, 0, 0)',
        codeTab: !document.getElementById('exportTabPreview').hidden, codeFocused: document.activeElement === pre };
    })()`);
    await showExportTab(popup, 'actions');
    await popup.evaluate(`document.querySelector('#exportActList [data-step="7"]').click()`);
    await sleep(SETTLE_MS);
    const seven = await stepLine(7);
    check(seven.codeTab && seven.inView && seven.tinted && seven.scrollTop > 0 && seven.text.trim().startsWith('# Step 7:') && !seven.codeFocused,
      'a click on row 7 opens the Code tab on "# Step 7", tinted, focus left alone', seven);
    await popup.evaluate(`document.getElementById('exportStepsBtn').click()`);
    await sleep(SETTLE_MS);
    const first = await stepLine(1);
    check(first.inView && first.text.trim().startsWith('# Step 1:'), '↧ Steps shows Step 1', first);
    // By keyboard: row 10 focused, Enter.
    await showExportTab(popup, 'actions');
    await popup.evaluate(`document.querySelector('#exportActList [data-step="10"]').focus()`);
    await pressKey(popup, 'Enter', 'Enter', 13, '\r');
    await sleep(SETTLE_MS);
    const ten = await stepLine(10);
    check(ten.codeTab && ten.inView && ten.tinted && ten.codeFocused, 'Enter on row 10 shows step 10 in the code, which takes the focus', ten);
    const text = await popup.evaluate(`document.querySelector('#exportCode code').textContent`);
    check(text.split('\n').length > 50 && /\n\s*# Step 10: /.test(text), 'the code box\'s text is still the code, line for line', text.length);
    const markup = await popup.evaluate(`({ elements: document.querySelectorAll('#exportCode img').length, xss: window.__xss ?? null,
      shown: document.querySelector('#exportCode code').textContent.includes('alice<img src=x onerror=') })`);
    check(markup.elements === 0 && markup.xss === null && markup.shown, 'a value holding <img onerror> shows as text, not as an element', markup);

    // Colours in both themes: comments, strings and keywords apart from the code's own colour, a step's comment apart too.
    const colours = () => popup.evaluate(`(() => {
      const c = (sel) => { const el = document.querySelector('#exportCode ' + sel); return el && getComputedStyle(el).color; };
      return { text: c('code'), cmt: c('.export-bm-line:not([data-step]) .tok-cmt'), str: c('.tok-str'), kw: c('.tok-kw'),
        step: c('.export-bm-line[data-step] .tok-cmt'), stepWeight: getComputedStyle(document.querySelector('#exportCode .export-bm-line[data-step] .tok-cmt')).fontWeight };
    })()`);
    for (const theme of ['light', 'dark']) {
      await popup.evaluate(`document.documentElement.setAttribute('data-theme', '${theme}')`);
      const c = await colours();
      check(new Set([c.text, c.cmt, c.str, c.kw, c.step]).size === 5 && Number(c.stepWeight) >= 700,
        `${theme} theme: comments, strings, keywords and step comments each have a colour`, c);
    }
  } finally {
    await popup.close();
  }
}

export async function checkExportFormats(ctx) {
  const id = await makeScenario(ctx, 'e2e export formats', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const popup = await openPopup(ctx);
  try {
    await popup.evaluate(`document.querySelector('.tab-btn[data-tab="tabData"]').click()`);
    await sleep(SETTLE_MS);
    const buttons = await popup.evaluate(`[...document.querySelectorAll('.export-code-grid > button')].map((b) => b.id)`);
    // Each one opens the modal as its own format, with the same Download button.
    const badges = [];
    const downloads = [];
    const labels = [];
    for (const button of buttons) {
      await popup.evaluate(`(() => {
        const s = document.getElementById('exportCodeSelect');
        s.value = ${JSON.stringify(id)};
        s.dispatchEvent(new Event('change'));
        document.getElementById(${JSON.stringify(button)}).click();
      })()`);
      await sleep(POPUP_SETTLE_MS);
      badges.push(await popup.evaluate(`document.getElementById('exportModal').classList.contains('show')
        ? document.getElementById('exportBadge').textContent : 'not open'`));
      downloads.push(await popup.evaluate(`document.getElementById('exportDownload').textContent`));
      labels.push(await popup.evaluate(`document.getElementById('exportCodeLabel').textContent`));
      await popup.evaluate(`document.getElementById('exportClose').click()`);
      await sleep(SETTLE_MS);
    }
    check(buttons.join() === 'exportBookmarklet,exportSelenium,exportPlaywright,exportRobot,exportJava' && badges.join() === 'JS,PY,PW,RF,JV',
      'The Export Code card offers the bookmarklet, Selenium, Playwright, Robot Framework and Selenium Java, each opening its own export', { buttons, badges });
    check(downloads.every((d) => d === '⬇ Download'), 'each export\'s Download button reads "⬇ Download"', downloads);
    check(labels[3] === 'e2e_export_formats.robot' && labels[4] === 'E2eExportFormatsTest.java',
      'Robot Framework opens a <name>.robot file, Selenium Java a <Name>Test.java holding that class', labels);
    // Two by two, every button the same size; the last, alone on its row, in the middle.
    const box = await popup.evaluate(`(() => {
      const grid = document.querySelector('.export-code-grid').getBoundingClientRect();
      const rs = [...document.querySelectorAll('.export-code-grid > button')].map((el) => el.getBoundingClientRect());
      const last = rs[rs.length - 1];
      return { widths: rs.map((r) => Math.round(r.width)), rows: [...new Set(rs.map((r) => Math.round(r.top)))].length,
        offCentre: last.left + last.width / 2 - (grid.left + grid.width / 2) };
    })()`);
    check(box.rows === 3 && Math.max(...box.widths) - Math.min(...box.widths) <= 1 && Math.abs(box.offCentre) <= 1,
      'the five buttons sit two by two, all one size, the last in the middle of its row', box);
  } finally {
    await popup.close();
  }
}

export async function checkExportTabsKeyboard(ctx) {
  const id = await makeScenario(ctx, 'e2e export tabs', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const popup = await openPopup(ctx);
  try {
    // Opened with a real mouse click, as in the popup.
    const at = await popup.evaluate(`(() => {
      document.querySelector('.tab-btn[data-tab="tabData"]').click();
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      const b = document.getElementById('exportSelenium');
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await popup.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    }
    await sleep(POPUP_SETTLE_MS);
    const focused = () => popup.evaluate(`(() => {
      const el = document.activeElement;
      return { tab: el.dataset.tab || el.id, ring: el.matches(':focus-visible'),
        open: document.querySelector('#exportModal .export-bm-tab[aria-selected="true"]').dataset.tab,
        shown: [...document.querySelectorAll('#exportModal [role="tabpanel"]')].filter((p) => !p.hidden).map((p) => p.id).join() };
    })()`);
    const opened = await focused();
    check(opened.tab === 'preview' && !opened.ring, 'opened with the mouse: focus on the Code tab, with no ring', opened);

    await pressKey(popup, 'ArrowRight', 'ArrowRight', 39);
    await pressKey(popup, 'ArrowRight', 'ArrowRight', 39);
    const right = await focused();
    check(right.tab === 'actions' && right.open === 'actions' && right.shown === 'exportTabActions' && right.ring,
      '→ twice from Code: the Actions tab opens and has the (keyboard) focus', right);
    await pressKey(popup, 'End', 'End', 35);
    const end = await focused();
    await pressKey(popup, 'ArrowRight', 'ArrowRight', 39);
    const round = await focused();
    await pressKey(popup, 'ArrowLeft', 'ArrowLeft', 37);
    const left = await focused();
    await pressKey(popup, 'Home', 'Home', 36);
    const home = await focused();
    check(end.open === 'settings' && round.open === 'preview' && left.open === 'settings' && home.open === 'preview',
      'End, → past the last, ← past the first and Home reach the tab they should', [end.open, round.open, left.open, home.open]);

    const aria = await popup.evaluate(`[...document.querySelectorAll('#exportModal [role="tab"]')].map((t) => {
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      return { tab: t.dataset.tab, tabindex: t.tabIndex, panel: panel?.getAttribute('role') === 'tabpanel' && panel.getAttribute('aria-labelledby') === t.id };
    })`);
    check(aria.every((t) => t.panel) && aria.map((t) => t.tabindex).join() === '0,-1,-1,-1',
      'each tab names its panel and the panel its tab; the open tab alone is in the Tab order', aria);
  } finally {
    await popup.close();
  }
}

export async function checkExportCard(ctx) {
  const click = [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }];
  const { id: folderId } = await ctx.send({ type: 'CREATE_FOLDER', name: 'e2e card folder' });
  const inFolder = await makeScenario(ctx, 'e2e card in folder', click);
  await ctx.send({ type: 'MOVE_TO_FOLDER', scenarioId: inFolder, folderId });
  const loose = await makeScenario(ctx, 'e2e card loose', click);
  // The format buttons, on or off and their titles; the scenario chosen.
  const state = (popup) => popup.evaluate(`({ value: document.getElementById('exportCodeSelect').value,
    buttons: [...document.querySelectorAll('.export-code-grid > button')].map((b) => ({ off: b.disabled, title: b.title, height: b.offsetHeight })) })`);

  await ctx.ext.evaluate(`chrome.storage.local.remove('lastSelectedScenario')`);
  let popup = await openPopup(ctx);
  try {
    await popup.evaluate(`document.querySelector('.tab-btn[data-tab="tabData"]').click()`);
    await sleep(SETTLE_MS);
    const none = await state(popup);
    check(none.value === '' && none.buttons.length === 5 && none.buttons.every((b) => b.off && b.title === 'Select a scenario first'),
      'no scenario chosen: the five format buttons are off and say why', none);
    await popup.evaluate(`(() => { const s = document.getElementById('exportCodeSelect'); s.value = ${JSON.stringify(loose)};
      s.dispatchEvent(new Event('change')); })()`);
    const chosen = await state(popup);
    check(chosen.buttons.every((b) => !b.off && b.title && b.title !== 'Select a scenario first' && b.height > 0 && b.height < 50),
      'a scenario chosen: the buttons are on, small, each titled with what it makes', chosen);
    const order = await popup.evaluate(`(() => {
      const s = document.getElementById('exportCodeSelect');
      const where = (id) => { const o = s.querySelector('option[value="' + id + '"]'); return o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : 'top'; };
      const kids = [...s.children].map((el) => el.tagName);
      return { inFolder: where(${JSON.stringify(inFolder)}), loose: where(${JSON.stringify(loose)}),
        looseFirst: kids.lastIndexOf('OPTION') < kids.indexOf('OPTGROUP') };
    })()`);
    check(order.inFolder === 'e2e card folder' && order.loose === 'top' && order.looseFirst,
      'the list has the scenarios in no folder first, then one group per folder', order);
  } finally {
    await popup.close();
  }

  // The scenario Manage Scenarios has selected is the card's when the card has none.
  await ctx.ext.evaluate(`chrome.storage.local.set({ lastSelectedScenario: ${JSON.stringify(inFolder)} })`);
  popup = await openPopup(ctx);
  try {
    const taken = await state(popup);
    check(taken.value === inFolder && taken.buttons.every((b) => !b.off), 'the popup opens with the card on the scenario Manage Scenarios has', taken);
  } finally {
    await popup.close();
    await ctx.ext.evaluate(`chrome.storage.local.remove('lastSelectedScenario')`);
  }
}

export async function checkExportPlaywright(ctx) {
  const id = await makeScenario(ctx, 'Đăng nhập pw', [{ type: 'click', selector: '#bg1', selectors: { css: '#bg1' } }]);
  const popup = await openPopup(ctx);
  try {
    await popup.evaluate(`(() => {
      const s = document.getElementById('exportCodeSelect');
      s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change'));
      document.getElementById('exportPlaywright').click();
    })()`);
    await sleep(POPUP_SETTLE_MS);
    const shown = await popup.evaluate(`({
      label: document.getElementById('exportCodeLabel').textContent,
      download: document.getElementById('exportDownload').textContent,
      code: document.querySelector('#exportCode code').textContent,
    })`);
    check(shown.label === 'đăng_nhập_pw.spec.js' && shown.download === '⬇ Download'
      && /^import \{ test \} from '@playwright\/test';$/m.test(shown.code) && shown.code.includes('test("Đăng nhập pw", async ({ page }) => {'),
      'Playwright Test opens a .spec.js with one test', { label: shown.label, download: shown.download });
  } finally {
    await popup.close();
  }
}

export const CHECKS = [
  ['export-file-name', 'The file name of an exported script', checkExportFileName],
  ['export-robot-data', 'The Robot export with a data file: the test and its reader', checkExportRobotData],
  ['export-steps', 'The export modal tells which steps were skipped', checkExportSteps],
  ['export-regenerate', 'Reload scenario in the export modals', checkExportRegenerate],
  ['export-headless', 'The Headless switch of the Selenium export', checkExportHeadless],
  ['export-start-url', 'The Selenium start URL taken from the tab', checkExportStartUrl],
  ['export-url-field', 'The Starting URL field of the export Settings', checkExportUrlField],
  ['export-output', 'The Output choice of the Selenium export', checkExportOutput],
  ['export-settings', 'The export Settings, kept between popups', checkExportSettings],
  ['export-live-settings', 'The export code follows its Settings', checkExportLiveSettings],
  ['export-layout', 'The export modal\'s size in a 600 and a 500 px popup', checkExportLayout],
  ['export-jump', 'From a row of the Actions tab to its code', checkExportJump],
  ['export-formats', 'The formats the Export Code card offers', checkExportFormats],
  ['export-card', 'The Export Code card: its buttons and its list', checkExportCard],
  ['export-tabs-keyboard', 'The export modal\'s tabs by keyboard', checkExportTabsKeyboard],
  ['export-playwright', 'The Playwright Test export in the popup', checkExportPlaywright],
];
