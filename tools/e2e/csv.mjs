/**
 * tools/e2e/csv.mjs — e2e suite "csv". Run: node tools/e2e.mjs --suite csv
 *
 * The CSV card's ZIP download: its Advanced section, suggestions, folder names.
 *
 *   csv-zip-advanced  the CSV card's Advanced section (ZIP folder name) shows only
 *                 while ZIP is chosen, also when code sets the format; a saved
 *                 folder name and Add row number come back in a new popup, the
 *                 section open
 *   csv-zip-suggest  typing ${ in the ZIP Folder name lists names with nothing
 *                 chosen in the CSV card: the Tools tab variables when no scenario
 *                 was ever chosen; after a reopen, the last CSV's columns, what the
 *                 last scenario writes and the Tools tab ones it reads (not one it
 *                 never uses); Enter inserts one
 *   csv-zip-run   a CSV run (john, kate, john) downloaded as a ZIP from the popup:
 *                 folders "abc ${name}" (abc john_2 for the repeat; _01 … with Add
 *                 row number, downloaded again with no new run), the image of a
 *                 Screenshot → Variable named by its Filename; HTML / XLSX unchanged
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep } from '../lib/cdp-browser.mjs';
import { PLAY_TIMEOUT_MS, POLL_MS, SETTLE_MS, check, fail, makeScenario, openPopup, reloadTestPage } from './harness.mjs';

export async function checkCsvZipAdvanced(ctx) {
  const state = `(() => { const d = document.getElementById('csvZipAdvanced');
    document.getElementById('csvRunCard').classList.remove('collapsed');
    return { shown: getComputedStyle(d).display !== 'none', open: d.open, name: document.getElementById('csvZipFolderName').value,
      rowNumber: document.getElementById('csvZipRowNumber').checked }; })()`;
  const reopen = async (stored) => {
    await ctx.ext.evaluate(`chrome.storage.local.set(${JSON.stringify(stored)})`);
    const popup = await openPopup(ctx);
    const s = await popup.evaluate(state);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
    return { popup, s };
  };
  let { popup, s } = await reopen({ csvExportFormat: 'xlsx', csvZipFolderName: '' });
  check(!s.shown, 'XLSX: the ZIP Advanced section is hidden', s);
  // Set by code, as the restore does: no change event.
  await popup.evaluate(`document.getElementById('csvExportFormat').value = 'zip'`);
  s = await popup.evaluate(state);
  check(s.shown && !s.open, 'ZIP chosen: Advanced shows, closed', s);
  await popup.close();
  ({ popup, s } = await reopen({ csvExportFormat: 'zip', csvZipFolderName: 'abc ${name}', csvZipRowNumber: true }));
  check(s.shown && s.open && s.name === 'abc ${name}' && s.rowNumber,
    'reopened on ZIP with a saved folder name: shown, open, name and Add row number kept', s);
  await popup.evaluate(`(() => { const i = document.getElementById('csvZipFolderName'); i.value = 'x \${id}'; i.dispatchEvent(new Event('input'));
    document.getElementById('csvZipRowNumber').click(); })()`);
  await sleep(SETTLE_MS);
  const saved = await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get(['csvZipFolderName', 'csvZipRowNumber'], r))`);
  check(saved.csvZipFolderName === 'x ${id}' && saved.csvZipRowNumber === false, 'a typed folder name and the checkbox are saved', saved);
  await popup.close();
  ({ popup, s } = await reopen({ csvExportFormat: 'xlsx' }));
  check(!s.shown, 'reopened on XLSX: hidden again', s);
  await popup.close();
  await ctx.ext.evaluate(`chrome.storage.local.remove(['csvExportFormat', 'csvZipFolderName', 'csvZipRowNumber'])`);
}

export async function checkCsvZipSuggest(ctx) {
  await ctx.send({ type: 'SAVE_VARIABLES', variables: { env: 'qa', unused: 'x' } });
  const id = await makeScenario(ctx, 'e2e csv zip suggest', [
    { type: 'input', selector: '#name', selectors: { css: '#name' }, value: '${env}', delay: 0 },
    { type: 'readdom', selector: '#total', selectors: { css: '#total' }, varName: 'order', readFrom: 'text', delay: 0 },
  ]);
  const keys = ['csvExportFormat', 'csvZipFolderName', 'csvSessionData', 'csvScenarioId'];
  await ctx.ext.evaluate(`chrome.storage.local.remove(${JSON.stringify(keys)})`);
  await ctx.ext.evaluate(`chrome.storage.local.set({ csvExportFormat: 'zip' })`);
  // A new popup with nothing chosen in the CSV card: type "abc ${" key by key.
  const typeInFolderName = async (popup) => {
    await popup.evaluate(`(() => {
      document.querySelector('.tab-btn[data-tab="tabRecord"]').click(); // the CSV card's tab since 1.0.29
      document.getElementById('csvRunCard').classList.remove('collapsed');
      document.getElementById('csvZipAdvanced').open = true;
      const i = document.getElementById('csvZipFolderName'); i.value = ''; i.focus();
    })()`);
    for (const ch of 'abc ${') {
      await popup.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
      await popup.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
    await sleep(SETTLE_MS);
    return popup.evaluate(`[...document.querySelectorAll('.var-suggest .vs-name')].map((e) => e.textContent)`);
  };
  let popup = await openPopup(ctx);
  try {
    let names = await typeInFolderName(popup);
    check(names.includes('env') && names.includes('unused'),
      'Folder name, no scenario ever chosen and no CSV: ${ lists the Tools tab variables', names);
    // Choose a scenario and load a CSV once, as a user does, then open a new popup.
    await popup.evaluate(`(() => { const s = document.getElementById('csvScenarioSelect'); s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const csvDir = mkdtempSync(join(tmpdir(), 'pqa-csv-'));
    writeFileSync(join(csvDir, 'people.csv'), 'name,city\njohn,HN\n');
    const { result } = await popup.send('Runtime.evaluate', { expression: `document.getElementById('csvFile')` });
    await popup.send('DOM.getDocument', {});
    await popup.send('DOM.setFileInputFiles', { files: [join(csvDir, 'people.csv')], objectId: result.objectId });
    await sleep(SETTLE_MS);
    rmSync(csvDir, { recursive: true, force: true });
    await popup.close();
    popup = await openPopup(ctx);
    names = await typeInFolderName(popup);
    check(['name', 'city', 'order', 'env'].every((n) => names.includes(n)) && !names.includes('unused'),
      'reopened with nothing chosen: the last CSV\'s columns, what the last scenario writes and the Tools tab variables it reads', names);
    for (const type of ['keyDown', 'keyUp']) await popup.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(SETTLE_MS);
    const value = await popup.evaluate(`document.getElementById('csvZipFolderName').value`);
    const saved = await ctx.ext.evaluate(`new Promise((r) => chrome.storage.local.get('csvZipFolderName', (s) => r(s.csvZipFolderName)))`);
    check(/^abc \$\{\w+\}$/.test(value) && saved === value, 'Enter inserts ${name}, and the folder name is saved', { value, saved });
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await popup.close();
    await ctx.ext.evaluate(`chrome.storage.local.remove(${JSON.stringify(keys)})`);
  }
}

/** The file names inside a ZIP, from its central directory. */
function zipNames(file) {
  const b = readFileSync(file);
  const eocd = b.length - 22; // the ZIP export writes no archive comment
  const names = [];
  for (let off = b.readUInt32LE(eocd + 16), n = b.readUInt16LE(eocd + 10); n > 0; n--) {
    const len = b.readUInt16LE(off + 28);
    names.push(b.toString('utf8', off + 46, off + 46 + len));
    off += 46 + len + b.readUInt16LE(off + 30) + b.readUInt16LE(off + 32);
  }
  return names;
}

export async function checkCsvZipRun(ctx) {
  await reloadTestPage(ctx);
  // kate's row expects a text #bg1 does not have: her Assert fails. The second john's
  // checks an element that is not there: the test is broken. The first john passes.
  const rows = [{ name: 'john', expect: 'bg1', sel: '#bg1' }, { name: 'kate', expect: 'nope', sel: '#bg1' },
    { name: 'john', expect: 'bg1', sel: '#gone' }];
  // Two Screenshot → Variable: one with a Filename, which only the ZIP uses.
  const id = await makeScenario(ctx, 'e2e csv zip', [
    { type: 'screenshot_tovar', target: 'page', varName: 'after', value: '${name}_after', delay: 0 },
    { type: 'screenshot_tovar', target: 'page', varName: 'shot', delay: 0 },
    { type: 'assert', conditionType: 'textEquals', selector: '${sel}', selectors: { css: '${sel}' }, expectedValue: '${expect}', delay: 0 },
  ]);
  await ctx.ext.evaluate(`chrome.storage.local.set(${JSON.stringify({
    csvSessionData: { headers: ['name', 'expect', 'sel'], rows }, csvExportFormat: 'zip', csvZipFolderName: 'abc ${name}', csvZipRowNumber: false })})`);
  await ctx.web.bringToFront();
  await ctx.send({ type: 'START_CSV_PLAYBACK', scenarioId: id, rows, delayBetween: 100, exportFormat: 'zip' });
  await sleep(SETTLE_MS);
  for (let waited = 0; waited < PLAY_TIMEOUT_MS && (await ctx.send({ type: 'GET_CSV_STATUS' }))?.active; waited += POLL_MS) await sleep(POLL_MS);
  const popup = await openPopup(ctx);
  // Each Download click (in `format`; the select is locked, code can still set it):
  // the path of the file that appears in the download folder.
  const download = async (format) => {
    const files = () => readdirSync(ctx.browser.downloadDir).filter((f) => f.endsWith(`.${format}`));
    const before = new Set(files());
    await popup.evaluate(`document.getElementById('csvExportFormat').value = '${format}'; document.getElementById('csvDownloadResult').click()`);
    for (let waited = 0; waited < PLAY_TIMEOUT_MS; waited += POLL_MS) {
      const added = files().find((f) => !before.has(f));
      if (added) { await sleep(SETTLE_MS); return join(ctx.browser.downloadDir, added); }
      await sleep(POLL_MS);
    }
    throw new Error(`no .${format} downloaded`);
  };
  const entries = (folders) => ['results.csv', ...folders.flatMap((f, i) => [`${f}/${rows[i].name}_after.png`, `${f}/shot.png`])];
  try {
    const progress = await popup.evaluate(`document.getElementById('pbPanelCsvProgText')?.textContent`);
    check(progress === '1 passed · 1 failed · 1 broken', 'the finished run counts its rows by verdict', progress);
    const zipPath = await download('zip');
    const resultsCsv = readFileSync(zipPath, 'utf8');
    check(resultsCsv.includes('"name","expect","sel","after","shot","Run Result","Action Failed"')
      && resultsCsv.includes('"✗ Failed","[3] assert: Expected text ""nope"", got ""bg1"""')
      && resultsCsv.includes('"⚠ Test broken","[3] assert: Element not found — could not check"')
      && (resultsCsv.match(/"✓ Passed",""/g) || []).length === 1,
    'results.csv: a Run Result per row, and the failed Assert with its reason', resultsCsv.split('results.csv')[1]?.slice(0, 400));
    const named = zipNames(zipPath);
    check(JSON.stringify(named) === JSON.stringify(entries(['abc john', 'abc kate', 'abc john_2'])),
      'ZIP named "abc ${name}": abc john, abc kate, abc john_2; the Filename ${name}_after names its image', named);
    await popup.evaluate(`document.getElementById('csvZipRowNumber').click()`);
    const numbered = zipNames(await download('zip'));
    check(JSON.stringify(numbered) === JSON.stringify(entries(['abc john_01', 'abc kate_02', 'abc john_03'])),
      'with Add row number: abc john_01, abc kate_02, abc john_03 — downloaded again, no new run', numbered);
    // HTML and XLSX: the variables' columns and images as before; the Filename is nowhere.
    const html = readFileSync(await download('html'), 'utf8');
    const xlsx = readFileSync(await download('xlsx')).toString('latin1');
    check(/<th[^>]*>after<\/th>/.test(html) && (html.match(/<img /g) || []).length === 6 && !html.includes('_after')
      && xlsx.includes('xl/media/image6.png') && !xlsx.includes('_after'),
    'HTML / XLSX: one column per variable, six images, no Filename', { imgs: (html.match(/<img /g) || []).length });
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await popup.close();
    await ctx.ext.evaluate(`chrome.storage.local.remove(['csvSessionData', 'csvExportFormat', 'csvZipFolderName', 'csvZipRowNumber'])`);
  }
}

export const CHECKS = [
  ['csv-zip-advanced', 'The ZIP\'s Advanced section in the CSV card', checkCsvZipAdvanced],
  ['csv-zip-suggest', 'Variable suggestions in the ZIP Folder name', checkCsvZipSuggest],
  ['csv-zip-run', 'A CSV run downloaded as a ZIP with named folders', checkCsvZipRun],
];
