/**
 * tools/e2e/vars.mjs — e2e: the vars suite. Run by tools/e2e.mjs.
 */

import { sleep } from '../lib/cdp-browser.mjs';
import { DRAFT_SAVE_MS, POPUP_SETTLE_MS, SETTLE_MS, check, fail, makeScenario, openPopup, play, reloadTestPage } from './harness.mjs';

export async function checkSuggest(ctx) {
  await ctx.send({ type: 'SAVE_VARIABLES', variables: { greet: 'hello', gamma: 'g' } });
  const popup = await openPopup(ctx);
  await popup.evaluate(`(() => {
    document.getElementById('addManualActionCard')?.classList.remove('collapsed');
    const type = document.getElementById('manualActionType');
    type.value = 'input'; type.dispatchEvent(new Event('change'));
    const value = document.getElementById('manualValue'); value.value = ''; value.focus();
  })()`);
  await popup.send('Input.insertText', { text: 'Hi ${g' });
  await sleep(SETTLE_MS);
  const names = await popup.evaluate(`[...document.querySelectorAll('.var-suggest .vs-name')].map((e) => e.textContent)`);
  check(names.includes('greet') && names.includes('gamma'), 'typing ${g lists greet and gamma', names);
  for (const type of ['keyDown', 'keyUp']) {
    await popup.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  await sleep(SETTLE_MS);
  const value = await popup.evaluate(`document.getElementById('manualValue').value`);
  check(/^Hi \$\{(greet|gamma)\}$/.test(value), 'Enter inserts the highlighted ${name}', value);
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();
}

/** The Tools tab's variable modal in `popup`: a row's Edit (Add with no key), filled in and saved. */
function variableModal(popup) {
  return {
    open: (key) => popup.evaluate(key == null
      ? `document.getElementById('addVariableRow').click()`
      : `[...document.querySelectorAll('li.var-row')].find((li) => li.dataset.key === ${JSON.stringify(key)}).querySelector('.vr-edit').click()`),
    // The toast, and whether the modal stayed open, once Save has had its answer. `value` null: as it was.
    save: async (name, value = null) => {
      await popup.evaluate(`(() => {
        document.getElementById('randomVarName').value = ${JSON.stringify(name)};
        if (${JSON.stringify(value)} !== null) document.getElementById('staticValue').value = ${JSON.stringify(value)};
        document.getElementById('confirmRandom').click();
      })()`);
      await sleep(SETTLE_MS);
      return popup.evaluate(`({ toast: document.getElementById('toast').textContent, open: document.getElementById('randomModal').classList.contains('show') })`);
    },
    cancel: () => popup.evaluate(`document.getElementById('cancelRandom').click()`),
  };
}

export async function checkVarNameGuard(ctx) {
  await ctx.send({ type: 'SAVE_VARIABLES', variables: { alpha: 'one', beta: 'two' }, order: ['alpha', 'beta'] });
  const popup = await openPopup(ctx);
  const table = async () => JSON.stringify((await ctx.send({ type: 'GET_VARIABLES' })).variables);
  const { open, save, cancel } = variableModal(popup);
  const before = await table();

  await open(null);
  const added = await save('beta', 'three');
  check(added.open && /already exists/.test(added.toast), 'adding a name the table has is refused', added);
  await cancel();
  await open('alpha');
  const renamed = await save('beta', 'one');
  check(renamed.open && /already exists/.test(renamed.toast), 'renaming to a name another row has is refused', renamed);
  await cancel();
  for (const bad of ['a}', '${x}']) {
    await open(null);
    const r = await save(bad, 'v');
    check(r.open && /variable name/i.test(r.toast), `"${bad}" is refused as a name`, r);
    await cancel();
  }
  const rows = await popup.evaluate(`[...document.querySelectorAll('li.var-row')].map((li) => li.dataset.key)`);
  check(JSON.stringify(rows) === '["alpha","beta"]', 'the table still has alpha and beta once', rows);
  const after = await table();
  check(after === before, 'nothing refused was saved', { before, after });

  await open('alpha');
  const kept = await save('alpha', 'uno');
  const vars = JSON.parse(await table());
  check(!kept.open && vars.alpha?.s === 'uno' && vars.beta?.s === 'two', 'saving a row under its own name is not a clash', { kept, vars });
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();
}

export async function checkVarRename(ctx) {
  await ctx.send({ type: 'SAVE_VARIABLES', variables: { first: '1', renameMe: 'hello', last: '3' }, order: ['first', 'renameMe', 'last'] });
  // The preview shows an Input by its selector, and its label: a label naming the variable follows a rename too.
  const played = await makeScenario(ctx, 'e2e rename: typed', [{ type: 'input', selector: '#out', value: '${renameMe}', label: 'Type ${renameMe}' }]);
  const other = await makeScenario(ctx, 'e2e rename: read', [
    { type: 'readdom', selector: '#dd', varName: 'renameMe' },
    { type: 'click', selector: '#${renameMe}', selectors: { css: '#${renameMe}' } },
  ]);
  await makeScenario(ctx, 'e2e rename: writes taken', [{ type: 'readdom', selector: '#dd', varName: 'taken' }]);
  await ctx.ext.evaluate(`chrome.storage.local.set({ lastSelectedScenario: ${JSON.stringify(played)} })`);
  // An empty Add Action card: a draft another check left (form-roundtrip's is in Save Edit
  // mode on its own scenario) would send the Add Action below elsewhere.
  await ctx.ext.evaluate(`chrome.storage.local.remove('manualFormDraft')`);
  const popup = await openPopup(ctx);
  const { open, save, cancel } = variableModal(popup);
  const preview = () => popup.evaluate(`document.getElementById('actions').textContent`);
  const stored = async () => JSON.stringify([await ctx.send({ type: 'GET_VARIABLES' }), await ctx.send({ type: 'GET_SCENARIOS' })]);
  check((await preview()).includes('${renameMe}'), 'the preview shows ${renameMe} at first', await preview());
  // An Input half-typed in the Add Manual Action card, its draft saved, a Read DOM target typed under it.
  await popup.evaluate(`(() => {
    document.getElementById('addManualActionCard')?.classList.remove('collapsed');
    const type = document.getElementById('manualActionType');
    type.value = 'input'; type.dispatchEvent(new Event('change'));
    document.getElementById('manualSelector').value = '#big';
    document.getElementById('readdomVarName').value = 'renameMe';
    const value = document.getElementById('manualValue');
    value.value = '\${renameMe} and more'; value.dispatchEvent(new Event('input'));
  })()`);
  await sleep(DRAFT_SAVE_MS);

  await open('renameMe');
  const renamed = await save('renamed');
  check(!renamed.open && /5 references in 2 scenarios/.test(renamed.toast), 'the rename says what it updated', renamed);
  const { scenarios } = await ctx.send({ type: 'GET_SCENARIOS' });
  const [typed] = scenarios[played].actions;
  check(typed.value === '${renamed}' && typed.label === 'Type ${renamed}', 'the played scenario reads ${renamed}', scenarios[played].actions);
  const [read, click] = scenarios[other].actions;
  check(read.varName === 'renamed' && click.selector === '#${renamed}' && click.selectors?.css === '#${renamed}',
    'Read DOM writes renamed, the selectors read ${renamed}', scenarios[other].actions);
  const table = await ctx.send({ type: 'GET_VARIABLES' });
  check(JSON.stringify(table.order) === '["first","renamed","last"]' && !('renameMe' in table.variables) && table.variables.renamed?.s === 'hello',
    'the table has renamed in renameMe\'s place, its value kept', table);
  const shown = await preview();
  check(shown.includes('${renamed}') && !shown.includes('${renameMe}'), 'the preview follows without reopening the popup', shown);
  const form = await popup.evaluate(`({ type: document.getElementById('manualActionType').value,
    value: document.getElementById('manualValue').value, readdom: document.getElementById('readdomVarName').value })`);
  check(form.type === 'input' && form.value === '${renamed} and more' && form.readdom === 'renamed', 'the open form follows the rename', form);
  const { manualFormDraft: draft } = await ctx.ext.evaluate(`chrome.storage.local.get('manualFormDraft')`);
  check(draft?.value === '${renamed} and more' && draft?.readdomVarName === 'renamed', 'so does the draft kept of it', draft);

  const before = await stored();
  await open('renamed');
  const taken = await save('taken');
  check(taken.open && /"taken" is already used in "e2e rename: writes taken"/.test(taken.toast), 'a name a scenario writes is refused', taken);
  await cancel();
  check(await stored() === before, 'the refused rename wrote nothing', null);

  await popup.evaluate(`document.getElementById('addManualAction').click()`);
  await sleep(SETTLE_MS * 2);
  const { variables } = await ctx.send({ type: 'GET_VARIABLES' });
  const added = (await ctx.send({ type: 'GET_SCENARIOS' })).scenarios[played].actions;
  check(!('renameMe' in variables) && added[1]?.value === '${renamed} and more',
    'Add Action saves ${renamed}, and brings no renameMe back to the table', { variables: Object.keys(variables), added });

  // That action open for editing while renamed → final: Save Edit writes the new name, not the one it was opened with.
  await popup.evaluate(`document.querySelector('#actions button[aria-label^="Edit action 2:"]').click()`);
  await sleep(SETTLE_MS);
  await open('renamed');
  await save('final');
  const editing = await popup.evaluate(`({ value: document.getElementById('manualValue').value, button: document.getElementById('addManualAction').textContent })`);
  check(editing.value === '${final} and more' && editing.button === 'Save Edit', 'an action open for editing follows the rename', editing);
  await popup.evaluate(`document.getElementById('addManualAction').click()`);
  await sleep(SETTLE_MS * 2);
  const edited = (await ctx.send({ type: 'GET_SCENARIOS' })).scenarios[played].actions;
  const { variables: finalVars } = await ctx.send({ type: 'GET_VARIABLES' });
  check(edited.map((a) => a.value).join() === '${final},${final} and more' && !('renamed' in finalVars),
    'Save Edit keeps ${final}; no renamed comes back', { edited, variables: Object.keys(finalVars) });
  // The CSV loaded last still has a column of the old name: it no longer fills the variable in.
  await ctx.ext.evaluate(`chrome.storage.local.set({ csvSessionData: { headers: ['final', 'other'], rows: [{ final: 'x', other: 'y' }] } })`);
  await popup.reload();
  await sleep(POPUP_SETTLE_MS);
  await open('final');
  const csv = await save('csvd');
  check(!csv.open && /CSV column "final"/.test(csv.toast) && /"csvd"/.test(csv.toast), 'a CSV column of the old name is pointed out', csv);
  await open('csvd');
  const plain = await save('plain');
  check(!plain.open && !/CSV/.test(plain.toast), 'not when the CSV has no column of that name', plain);
  await ctx.ext.evaluate(`chrome.storage.local.remove('csvSessionData')`);
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();

  const page = await play(ctx, played);
  check(page.out === 'hello' && page.big === 'hello and more', 'played, the scenario types the value of plain', page);
  await reloadTestPage(ctx);
}

export const CHECKS = [
  ['suggest', 'Variable suggestions in the popup', checkSuggest],
  ['var-name-guard', 'A variable name already taken, or one no ${…} can reach', checkVarNameGuard],
  ['var-rename', 'A variable renamed in the Tools tab, and in the scenarios using it', checkVarRename],
];
