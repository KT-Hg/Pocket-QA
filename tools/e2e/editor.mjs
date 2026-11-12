/**
 * tools/e2e/editor.mjs — e2e: the editor suite. Run by tools/e2e.mjs.
 */

import { asActiveTab, sleep } from '../lib/cdp-browser.mjs';
import { DRAFT_SAVE_MS, POPUP_SETTLE_MS, POPUP_VIEWPORT, SETTLE_MS, check, clickAt, closeQuietly, fail, makeScenario, openPopup, pageSoon, reloadTestPage, showScenario } from './harness.mjs';

export async function checkPreviewNoFlash(ctx) {
  const id = await makeScenario(ctx, 'e2e no flash', [
    { type: 'click', selector: '#a1' }, { type: 'click', selector: '#a2' }, { type: 'click', selector: '#a3' },
  ]);
  await ctx.ext.evaluate(`chrome.storage.local.set({ lastSelectedScenario: ${JSON.stringify(id)} })`);
  const popup = await openPopup(ctx);
  // The list as each task leaves it — what the popup can paint, and size itself to.
  await popup.evaluate(`(() => {
    const list = document.getElementById('actions');
    window.__shown = [];
    new MutationObserver(() => __shown.push(list.querySelectorAll('li.action').length + (list.querySelector('.action-loading') ? ' loading' : '')))
      .observe(list, { childList: true });
  })()`);
  const rows = `[...document.querySelectorAll('#actions li.action')]`;
  const toggle = async (verb) => {
    await popup.evaluate(`__shown = []; document.querySelector('#actions button[aria-label^="${verb} action 2:"]').click()`);
    await sleep(SETTLE_MS);
    return popup.evaluate(`({ shown: __shown, disabled: ${rows}.map((li) => li.classList.contains('action-disabled')),
      button: ${rows}[1].querySelector('.btn-row button').textContent })`);
  };
  const off = await toggle('Disable');
  check(off.disabled.join() === 'false,true,false' && off.button === 'Enable', 'Disable greys out that action only, its button now Enable', off);
  check(off.shown.length > 0 && off.shown.every((s) => s === '3'), 'the list never empties or shows Loading… on the way', off.shown);
  const { scenarios } = await ctx.send({ type: 'GET_SCENARIOS' });
  check(scenarios[id].actions.map((a) => !!a.disabled).join() === 'false,true,false', 'the scenario has it disabled', scenarios[id].actions);
  const on = await toggle('Enable');
  check(on.disabled.join() === 'false,false,false' && on.button === 'Disable' && on.shown.every((s) => s === '3'), 'Enable puts it back, again without a flash', on);
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();
}

export async function checkFolderFilter(ctx) {
  const { id: folder } = await ctx.send({ type: 'CREATE_FOLDER', name: 'e2e kept folder' });
  const { id: inside } = await ctx.send({ type: 'CREATE_SCENARIO', name: 'e2e in the folder', folderId: folder });
  await makeScenario(ctx, 'e2e in no folder', []);
  const popup = await openPopup(ctx);
  const state = () => popup.evaluate(`({ filter: document.getElementById('filterFolder').value,
    index: document.getElementById('filterFolder').selectedIndex, selected: document.getElementById('scenarioList').value,
    listed: [...document.getElementById('scenarioList').options].map((o) => o.value).filter(Boolean).join() })`);
  const pick = (id, value) => popup.evaluate(`(() => { const s = document.getElementById(${JSON.stringify(id)});
    s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);
  const reopen = async () => { await popup.reload(); await sleep(POPUP_SETTLE_MS); return state(); };

  await pick('filterFolder', folder);
  await sleep(SETTLE_MS);
  const chosen = await state();
  check(chosen.filter === folder && chosen.listed === inside, 'the folder filter lists that folder\'s scenarios', chosen);
  await popup.evaluate(`document.getElementById('newFolderInput').value = 'e2e another folder'; document.getElementById('createFolderAction').click()`);
  await sleep(SETTLE_MS * 2);
  const rebuilt = await state();
  check(rebuilt.filter === folder && rebuilt.listed === inside, 'creating a folder, which rebuilds the folder lists, keeps the filter', rebuilt);
  const reopened = await reopen();
  check(reopened.filter === folder && reopened.listed === inside, 'a reopened popup keeps the filter', reopened);

  // Moved out of the folder shown, the chosen scenario stays listed and chosen: the filter shows all.
  await pick('scenarioList', inside);
  await pick('moveToFolderSelect', '');
  await popup.evaluate(`document.getElementById('doMoveToFolder').click()`);
  await sleep(SETTLE_MS * 2);
  const moved = await state();
  check(moved.filter === '' && moved.selected === inside, 'a scenario moved out of the folder shown stays chosen, all folders shown', moved);
  const movedReopened = await reopen();
  check(movedReopened.filter === '' && movedReopened.selected === inside, 'and so after a reopen', movedReopened);

  await pick('filterFolder', folder);
  await ctx.send({ type: 'DELETE_FOLDER', folderId: folder });
  const gone = await reopen();
  check(gone.filter === '' && gone.index === 0, 'its folder deleted, a reopened popup shows All Folders', gone);
  const { folders } = await ctx.send({ type: 'GET_FOLDERS' });
  for (const [id, f] of Object.entries(folders)) if (f.name === 'e2e another folder') await ctx.send({ type: 'DELETE_FOLDER', folderId: id });
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();
}

export async function checkSwitchDraft(ctx) {
  const a = await makeScenario(ctx, 'e2e alpha', []);
  const b = await makeScenario(ctx, 'e2e beta', []);
  await ctx.ext.evaluate(`chrome.storage.local.set({ manualFormDraft: {
    actionType: 'switch', switchVar: '\${role}', switchMode: 'var', cardOpen: true, scenarioId: '${a}',
    switchCases: [{ value: 'admin', scenarioId: '${b}', scenarioName: 'e2e beta' }],
  } })`);
  const popup = await openPopup(ctx);
  const list = `(() => { const sel = document.getElementById('switchCaseScenario');
    return { type: document.getElementById('manualActionType').value, ids: [...sel.options].map((o) => o.value), value: sel.value }; })()`;
  const restored = await popup.evaluate(list);
  check(restored.type === 'switch' && restored.ids.includes(a) && restored.ids.includes(b),
    'the popup reopened on a Switch draft lists the scenarios', restored);
  const picked = await popup.evaluate(`(async () => {
    document.querySelector('input[name="switchCaseMode"][value="other"]').click();
    document.getElementById('switchCaseScenario').value = '${b}';
    (await import(chrome.runtime.getURL('popup/scenarios/scenario-list.js'))).loadScenarios();
    await new Promise((r) => setTimeout(r, 500));
    return ${list};
  })()`);
  check(picked.value === b, 'a scenario picked in the case editor stays picked when the list reloads', picked);
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await ctx.ext.evaluate(`chrome.storage.local.remove('manualFormDraft')`);
  await popup.close();
}

/**
 * Drag action row `from` of the popup's list as a pointer does — dragover moving
 * up two pixels at a time — until what is above it reads `want` ('top',
 * 'after <index>'), and drop it there. Returns what it was dropped under.
 */
function dragRow(popup, from, want) {
  return popup.evaluate(`(async () => {
    const list = document.getElementById('actions');
    const li = list.querySelector('li.action[data-index="${from}"]');
    const dt = new DataTransfer();
    li.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    // The "move out of …" drop zones come in once dragstart has returned.
    await new Promise((r) => setTimeout(r, 100));
    const above = () => {
      let p = li.previousElementSibling;
      while (p && !p.getClientRects().length) p = p.previousElementSibling;
      if (!p) return 'top';
      return p.matches('li.action') ? 'after ' + p.dataset.index : p.className.split(' ')[0];
    };
    let got = above();
    for (let y = li.getBoundingClientRect().top + 20; y > -2000 && got !== ${JSON.stringify(want)}; y -= 2) {
      list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: y, dataTransfer: dt }));
      got = above();
    }
    list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    li.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return got;
  })()`);
}

/** #4 Switch ${role}: "admin" runs #5–#6, "user" #7; then #8 logout and #9 new. */
function switchBlockActions() {
  const click = (id) => ({ type: 'click', selector: `#${id}`, selectors: { css: `#${id}` } });
  const own = (value, startAt, endAt) => ({ value, scenarioId: '__self__', scenarioName: '↻ This scenario (jump)', startAt, endAt });
  return [
    click('a'), click('b'), click('c'),
    { type: 'switch', switchVar: '${role}', cases: [own('admin', 5, 6), own('user', 7, 7)] },
    click('menu'), click('settings'), click('profile'), click('logout'), click('new'),
  ];
}

/** Button `n` of action row `i` clicked: 1 Disable, 2 Copy, 3 Edit, 4 Delete. */
async function rowButton(popup, i, n) {
  await popup.evaluate(`document.querySelector('#actions li.action[data-index="${i}"] .btn-row button:nth-child(${n})').click()`);
  await sleep(SETTLE_MS);
}

const formTitle = (popup) => popup.evaluate(`document.getElementById('manualCardTitle').textContent`);

export async function checkNumbersByPosition(ctx) {
  const id = await makeScenario(ctx, 'e2e numbers by position', switchBlockActions());
  const popup = await openPopup(ctx);
  try {
    await showScenario(popup, id);
    const rows = await popup.evaluate(`[...document.querySelectorAll('#actions li.action .index')].map((el) => el.textContent.trim()).join(' ')`);
    const place = await popup.evaluate(`document.querySelector('#actions li.action[data-index="4"] .index').title`);
    check(rows === '1. 2. 3. 4. 5. 6. 7. 8. 9.' && place === 'Switch 4 › case "admin"',
      'every row is numbered by its position, in a Switch block too; the number\'s tooltip names its Switch and case', { rows, place });
    await rowButton(popup, 7, 3);
    const title = await formTitle(popup);
    check(title === 'Edit Action #8', 'Edit on row 8, after the block, opens "Edit Action #8"', title);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('manualFormDraft')`);
    await popup.close();
  }
}

/** Scenario `id`'s actions as stored. */
const storedActions = (popup, id) => popup.evaluate(`new Promise((r) => chrome.storage.local.get(['scenarios'], (x) => r(x.scenarios[${JSON.stringify(id)}].actions)))`);

export async function checkPasteEmpty(ctx) {
  const from = await makeScenario(ctx, 'e2e paste from', [{ type: 'click', selector: '#a', selectors: { css: '#a' } }]);
  const { id: to } = await ctx.send({ type: 'CREATE_SCENARIO', name: 'e2e paste into empty' });
  const popup = await openPopup(ctx);
  try {
    await showScenario(popup, from);
    await rowButton(popup, 0, 2);
    await showScenario(popup, to);
    const shown = await popup.evaluate(`({ paste: !!document.querySelector('#actions .action-paste-btn'), empty: document.querySelector('#actions li.empty')?.textContent })`);
    check(shown.paste && /card below/.test(shown.empty || ''), 'an empty scenario shows the Paste row, and the card it points to is below', shown);
    await popup.evaluate(`document.querySelector('#actions .action-paste-btn')?.click()`);
    await sleep(POPUP_SETTLE_MS);
    const acts = await storedActions(popup, to);
    check(acts.length === 1 && acts[0].selector === '#a', 'Paste into the empty scenario adds the copied action', acts);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await popup.close();
  }
}

export async function checkSaveSelects(ctx) {
  // An unsaved draft of two actions, nothing selected, as after a first recording.
  await ctx.send({ type: 'START_NEW_SCENARIO' });
  for (const sel of ['#a', '#b']) await ctx.send({ type: 'ADD_MANUAL_ACTION', action: { type: 'click', selector: sel, selectors: { css: sel } } });
  await ctx.ext.evaluate(`chrome.storage.local.remove('lastSelectedScenario')`);
  const popup = await openPopup(ctx);
  try {
    await popup.evaluate(`(() => {
      document.querySelector('.tab-btn[data-tab="tabRecord"]').click();
      document.getElementById('scenarioName').value = 'e2e saved and kept';
      document.getElementById('saveFlow').click();
    })()`);
    await sleep(POPUP_SETTLE_MS * 2);
    const after = await popup.evaluate(`(() => {
      const list = document.getElementById('scenarioList');
      return { name: list.options[list.selectedIndex]?.textContent || '', play: !document.getElementById('playScenario').disabled,
        rows: document.querySelectorAll('#actions li.action').length, toast: document.getElementById('toast').textContent,
        notice: document.getElementById('autoSaveNotice').textContent };
    })()`);
    check(after.name === 'e2e saved and kept' && after.play && after.rows === 2,
      'after Save the scenario stays selected: its 2 actions listed, ▶ Play ready', after);
    check(/Saved "e2e saved and kept" — press ▶ Play/.test(after.toast) && /To start another one/.test(after.notice),
      'the toast points to Play, and the notice says how to start another scenario', after);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await popup.close();
  }
}

/**
 * Add Action on scenario `id` with the page scrolled past the top of the card, as
 * after filling a long form: where the card and the new row (`last`) end up.
 */
async function addFromBelow(popup, id, last) {
  await showScenario(popup, id);
  await popup.evaluate(`(() => {
    document.getElementById('addManualActionCard')?.classList.remove('collapsed');
    const type = document.getElementById('manualActionType'); type.value = 'click'; type.dispatchEvent(new Event('change'));
    document.getElementById('manualSelector').value = '#added';
    const card = document.getElementById('addManualActionCard');
    // body's overflow goes to the viewport: the document scrolls, not body.
    document.scrollingElement.scrollTop += card.getBoundingClientRect().top + 250;
  })()`);
  await sleep(SETTLE_MS);
  const before = await popup.evaluate(`Math.round(document.getElementById('addManualActionCard').getBoundingClientRect().top)`);
  await popup.evaluate(`document.getElementById('addManualAction').click()`);
  await sleep(POPUP_SETTLE_MS);
  return popup.evaluate(`(() => {
    const card = document.getElementById('addManualActionCard').getBoundingClientRect();
    const list = document.getElementById('actions');
    const row = list.querySelector('li.action[data-index="${last}"]')?.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    // The fixed header covers the top of the page: "in view" is below it.
    const bar = Math.round(document.querySelector('.sticky-header').getBoundingClientRect().bottom);
    return { before: ${before}, bar, cardTop: Math.round(card.top), rowShown: !!row && row.top >= box.top - 1 && row.bottom <= box.bottom + 1, listScroll: list.scrollTop };
  })()`);
}

export async function checkFormScroll(ctx) {
  const click = (i) => ({ type: 'click', selector: `#row${i}`, selectors: { css: `#row${i}` } });
  const long = await makeScenario(ctx, 'e2e form scroll', Array.from({ length: 30 }, (_, i) => click(i + 1)));
  const short = await makeScenario(ctx, 'e2e form scroll short', [click(1), click(2), click(3)]);
  const popup = await openPopup(ctx, { width: 480, height: 600 });
  try {
    const a = await addFromBelow(popup, long, 30);
    check(a.before < 0 && a.cardTop >= a.bar && a.cardTop < 600, 'Add Action brings the Add Manual Action card back into view, below the header', a);
    check(a.rowShown && a.listScroll > 0, 'the list scrolls to the action just added', a);
    // A short list grows by the new row: the page scrolls once that row is in, so
    // the card still lands at the top rather than as far below as the row is tall.
    const b = await addFromBelow(popup, short, 3);
    check(b.before < 0 && b.cardTop >= b.bar && b.cardTop <= b.bar + 12, 'with a short list growing by the new row, the card lands right below the header', b);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('manualFormDraft')`);
    await popup.close();
  }
}

export async function checkCopySwitchBlock(ctx) {
  const id = await makeScenario(ctx, 'e2e copy switch block', switchBlockActions());
  const popup = await openPopup(ctx);
  try {
    await showScenario(popup, id);
    await rowButton(popup, 3, 2);
    const label = await popup.evaluate(`document.querySelector('#actions .action-paste-btn')?.textContent`);
    await popup.evaluate(`document.querySelector('#actions .action-paste-btn').click()`);
    await sleep(POPUP_SETTLE_MS);
    const acts = await storedActions(popup, id);
    const shape = acts.map((a) => (a.type === 'switch' ? `switch ${a.cases.map((c) => `${c.startAt}–${c.endAt}`).join(' ')}` : a.selector)).join(' | ');
    const invalid = await popup.evaluate(`document.querySelectorAll('#actions li.sw-invalid, #actions .sw-warn').length`);
    check(label === '📋 Paste: switch + 3 actions' && invalid === 0
      && shape === '#a | #b | #c | switch 5–6 7–7 | #menu | #settings | #profile | #logout | #new | switch 11–12 13–13 | #menu | #settings | #profile',
    'Copy on a Switch takes its block; pasted, the new Switch runs its own copies', { label, invalid, shape });
    await popup.evaluate(`document.getElementById('undoAction').click()`);
    await sleep(POPUP_SETTLE_MS);
    const undone = (await storedActions(popup, id)).length;
    check(undone === 9, 'one Undo takes the whole pasted block away', undone);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await popup.close();
  }
}

export async function checkInsertPoint(ctx) {
  const id = await makeScenario(ctx, 'e2e insert point', switchBlockActions());
  const popup = await openPopup(ctx);
  const note = () => popup.evaluate(`(() => { const n = document.getElementById('insertPointNote'); return n.hidden ? '' : n.textContent.trim(); })()`);
  const fill = (type, selector) => popup.evaluate(`(() => {
    const t = document.getElementById('manualActionType'); t.value = ${JSON.stringify(type)}; t.dispatchEvent(new Event('change'));
    document.getElementById('manualSelector').value = ${JSON.stringify(selector)};
  })()`);
  const add = async () => { await popup.evaluate(`document.getElementById('addManualAction').click()`); await sleep(POPUP_SETTLE_MS); };
  const shape = async () => (await storedActions(popup, id)).map((a) => {
    if (a.type === 'switch') return `switch ${a.cases.map((c) => `${c.startAt}–${c.endAt}`).join(' ')}`;
    return a.type === 'condition' ? `if ${a.skipCount}` : a.selector;
  }).join(' | ');
  try {
    await showScenario(popup, id);
    await popup.evaluate(`document.getElementById('addManualActionCard')?.classList.remove('collapsed');
      document.querySelector('#actions li.action[data-index="4"] .ins-gap').click()`);
    await sleep(SETTLE_MS);
    const ghost = await popup.evaluate(`(() => { const g = document.querySelector('#actions li.action-ghost');
      return { after: g?.previousElementSibling?.dataset.index, depth: g?.style.getPropertyValue('--sw-depth'), sub: g?.querySelector('.value-sub')?.textContent }; })()`);
    const picked = await note();
    check(ghost.after === '4' && ghost.depth === '1' && /#6 · Switch 4 › case "admin"/.test(ghost.sub || '') && /Insert at #6/.test(picked),
      '+ under row 5 puts the dummy row right under it, in case "admin"', { ghost, picked });
    await fill('click', '#x1'); await add();
    await fill('click', '#x2'); await add();
    const two = await shape();
    check(two === '#a | #b | #c | switch 5–8 9–9 | #menu | #x1 | #x2 | #settings | #profile | #logout | #new',
      'two adds in a row go in at the place, one after the other, inside the case', two);
    await fill('condition', '#guard');
    await sleep(POPUP_SETTLE_MS);
    const runTo = await popup.evaluate(`[...document.getElementById('conditionRunTo').options].map((o) => o.textContent)`);
    check(runTo.includes('Only the next action'), 'a Condition at the place counts the actions after the place', runTo);
    await popup.evaluate(`(() => { const r = document.getElementById('conditionRunTo'); r.value = '1'; r.dispatchEvent(new Event('change')); })()`);
    await add();
    await rowButton(popup, 0, 2);
    await popup.evaluate(`document.querySelector('#actions .action-paste-btn').click()`);
    await sleep(POPUP_SETTLE_MS);
    const pasted = await shape();
    check(pasted === '#a | #b | #c | switch 5–10 11–11 | #menu | #x1 | #x2 | if 2 | #a | #settings | #profile | #logout | #new',
      'the Condition guards the action after the place; Paste goes in at the place, under it', pasted);
    await popup.evaluate(`document.getElementById('undoAction').click()`);
    await sleep(POPUP_SETTLE_MS);
    check(await note() === '' && !(await popup.evaluate(`!!document.querySelector('#actions li.action-ghost')`)), 'Undo drops the insertion point', await note());
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('manualFormDraft')`);
    await popup.close();
  }
}

/** The popup opened again as the toolbar button opens it: one load, so it restores what was kept once. */
async function reopenPopup(ctx) {
  const popup = await ctx.browser.openPage(ctx.extUrl('popup.html'), { initScript: asActiveTab(`${ctx.base}/page`), ...POPUP_VIEWPORT });
  await sleep(POPUP_SETTLE_MS);
  return popup;
}

/**
 * The popup after an element was picked on the page: the worker opens it
 * (chrome.action.openPopup), and that one takes what the pick kept, so another
 * opened beside it would find nothing. Where the browser does not let the worker
 * open it, the toolbar button does.
 */
async function popupAfterPick(ctx) {
  const opened = await ctx.browser.pageOpenedAt(ctx.extUrl('popup.html'), POPUP_SETTLE_MS);
  if (!opened) return reopenPopup(ctx);
  await sleep(POPUP_SETTLE_MS);
  return opened;
}

export async function checkInsertPointPick(ctx) {
  const click = (id) => ({ type: 'click', selector: `#${id}`, selectors: { css: `#${id}` } });
  const id = await makeScenario(ctx, 'e2e insert point pick', [click('a'), click('b'), click('c')]);
  const placeOf = (popup) => popup.evaluate(`(() => { const g = document.querySelector('#actions li.action-ghost');
    const n = document.getElementById('insertPointNote');
    return { after: g?.previousElementSibling?.dataset.index ?? null, note: n.hidden ? '' : n.textContent.trim(),
      selector: document.getElementById('manualSelector').value }; })()`);
  const add = async (popup) => { await popup.evaluate(`document.getElementById('addManualAction').click()`); await sleep(POPUP_SETTLE_MS); };
  const shape = async (popup) => (await storedActions(popup, id)).map((a) => a.selector).join(' | ');
  let popup = await openPopup(ctx);
  try {
    await showScenario(popup, id);
    await popup.evaluate(`(() => {
      document.getElementById('addManualActionCard')?.classList.remove('collapsed');
      document.querySelector('#actions li.action[data-index="0"] .ins-gap').click();
      const t = document.getElementById('manualActionType'); t.value = 'click'; t.dispatchEvent(new Event('change'));
    })()`);
    await sleep(SETTLE_MS);
    // 🎯 keeps the form and closes the popup; the element is clicked on the page.
    await popup.evaluate(`document.getElementById('pickElement').click()`);
    await sleep(SETTLE_MS);
    await closeQuietly(popup);
    await clickAt(ctx, '#choiceA');
    await sleep(SETTLE_MS);
    popup = await popupAfterPick(ctx);
    const picked = await placeOf(popup);
    check(picked.selector === '#choiceA' && picked.after === '0' && /Insert at #2/.test(picked.note),
      'after 🎯 Pick the popup comes back with the place picked by + (under row 1)', picked);
    await add(popup);
    const one = await shape(popup);
    check(one === '#a | #choiceA | #b | #c', 'the action whose element was picked goes in at the place, not last', one);
    // The popup closed with an action half filled in: its draft keeps the place too.
    await popup.evaluate(`(() => {
      const t = document.getElementById('manualActionType'); t.value = 'click'; t.dispatchEvent(new Event('change'));
      const s = document.getElementById('manualSelector'); s.value = '#x'; s.dispatchEvent(new Event('input'));
    })()`);
    await sleep(DRAFT_SAVE_MS);
    await closeQuietly(popup);
    popup = await reopenPopup(ctx);
    const drafted = await placeOf(popup);
    check(drafted.selector === '#x' && drafted.after === '1' && /Insert at #3/.test(drafted.note),
      'a draft brought back keeps the place: right after the action just added', drafted);
    await add(popup);
    const two = await shape(popup);
    check(two === '#a | #choiceA | #x | #b | #c', 'the drafted action goes in at that place', two);
    // A Drag & Drop's drop target picked on the page: the popup closes for it too.
    await popup.evaluate(`(() => {
      const t = document.getElementById('manualActionType'); t.value = 'dragdrop'; t.dispatchEvent(new Event('change'));
      document.getElementById('manualSelector').value = '#from';
      document.getElementById('dragdropTargetPick').click();
    })()`);
    await sleep(SETTLE_MS);
    await closeQuietly(popup);
    await clickAt(ctx, '#choiceB');
    await sleep(SETTLE_MS);
    popup = await popupAfterPick(ctx);
    const target = await popup.evaluate(`document.getElementById('dragdropTarget').value`);
    const dd = await placeOf(popup);
    check(target === '#choiceB' && dd.after === '2' && /Insert at #4/.test(dd.note),
      'after picking a drop target the place is still there', { target, ...dd });
    await add(popup);
    const three = await shape(popup);
    check(three === '#a | #choiceA | #x | #from | #b | #c', 'the Drag & Drop goes in at the place', three);
    // A place kept for a list that has changed since is dropped, not used at a wrong index.
    await popup.evaluate(`(() => {
      const t = document.getElementById('manualActionType'); t.value = 'click'; t.dispatchEvent(new Event('change'));
      const s = document.getElementById('manualSelector'); s.value = '#y'; s.dispatchEvent(new Event('input'));
    })()`);
    await sleep(DRAFT_SAVE_MS);
    await closeQuietly(popup);
    await ctx.send({ type: 'ADD_MANUAL_ACTION', scenarioId: id, action: click('z') });
    popup = await reopenPopup(ctx);
    const stale = await placeOf(popup);
    check(stale.selector === '#y' && stale.note === '', 'the list changed while the popup was closed: the place is dropped, the action goes last', stale);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove(['manualFormDraft', 'pendingEdit', 'lastPickedSelector', 'lastPickedSelectors', 'lastPickedFrameId', 'lastPickedLabel'])`);
    await closeQuietly(popup);
  }
}

// After a hover: the 150 ms intent, the message to the page and its answer.
const PREVIEW_SETTLE_MS = 500;
// After a click: the smooth scroll, then the flash (1.2 s) is still on.
const FLASH_SETTLE_MS = 900;

export async function checkShowOnPage(ctx) {
  await reloadTestPage(ctx);
  // The page tells "under the popup" from where the popup says it is on the screen (placeLikeEdge below):
  // #choiceA goes to the left edge, clear of it, #choiceB to the window's top-right corner, right of it.
  await ctx.web.evaluate(`(() => { document.body.prepend(document.getElementById('choiceA'));
    Object.assign(document.getElementById('choiceB').style, { position: 'fixed', right: '40px', top: '120px' }); })()`);
  // Outlines the preview draws on the page: the text of each (its label, or the edge arrow's).
  const outlines = () => ctx.web.evaluate(`[...document.querySelectorAll(':root > [data-ext-overlay="1"]')].map((n) => n.textContent)`);
  // The popup is a tab here. For the page's sums, put it where Edge's toolbar popup sits: under the
  // extension's icon, 261 px in from the window's right edge (measured), not at the edge.
  const placeLikeEdge = async (p) => {
    const g = await ctx.web.evaluate(`({ screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight })`);
    const side = (g.outerWidth - g.innerWidth) / 2;
    const x = g.screenX + side + g.innerWidth - 480 - 261;
    const y = g.screenY + g.outerHeight - g.innerHeight - side;
    await p.evaluate(`void Object.defineProperties(window, { screenX: { get: () => ${x} }, screenY: { get: () => ${y} } })`);
  };
  let popup = await openPopup(ctx);
  try {
    await popup.evaluate(`(() => {
      document.getElementById('addManualActionCard')?.classList.remove('collapsed');
      const t = document.getElementById('manualActionType'); t.value = 'click'; t.dispatchEvent(new Event('change'));
      document.getElementById('pickElement').click();
    })()`);
    await sleep(SETTLE_MS);
    await closeQuietly(popup);
    await clickAt(ctx, '#choiceA');
    await sleep(SETTLE_MS);
    popup = await popupAfterPick(ctx);
    await placeLikeEdge(popup);
    const name = await popup.evaluate(`document.querySelector('#pickedSelectorsInfo .pk-name')?.textContent`);
    check(name === 'button “choiceA”', 'after a pick the Picked line names the element', name);

    const eye = (event) => popup.evaluate(`document.getElementById('showSelectorOnPage').dispatchEvent(new MouseEvent('${event}'))`);
    const onName = (event) => popup.evaluate(`document.querySelector('#pickedSelectorsInfo .pk-name')
      .dispatchEvent(new MouseEvent('${event}', { bubbles: true, relatedTarget: document.body }))`);
    const typeSelector = (v) => popup.evaluate(`(() => { const s = document.getElementById('manualSelector');
      s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('input')); })()`);
    const message = () => popup.evaluate(`document.querySelector('#pickedSelectorsWrap + .field-error')?.textContent || ''`);
    const scrollY = () => ctx.web.evaluate('Math.round(scrollY)');

    // Hover 👁: an outline with the element's name, the page not scrolled; gone when the mouse leaves.
    const before = await scrollY();
    await eye('mouseenter');
    await sleep(PREVIEW_SETTLE_MS);
    const peek = await outlines();
    const still = await scrollY();
    await eye('mouseleave');
    await sleep(SETTLE_MS);
    check(peek.length === 1 && peek[0].includes('choiceA') && still === before && (await outlines()).length === 0,
      'hovering 👁 outlines the element without scrolling; leaving takes the outline away', { peek, before, still });

    // Off-screen: a hover says where (an arrow at the page edge); a click scrolls to it and flashes it.
    await ctx.web.evaluate(`(() => { const s = document.createElement('div'); s.style.height = '3000px'; document.body.append(s);
      scrollTo(0, document.documentElement.scrollHeight); })()`);
    await eye('mouseenter');
    await sleep(PREVIEW_SETTLE_MS);
    const edge = await outlines();
    await eye('mouseleave');
    check(edge.length === 1 && /^↑ .*choiceA.* above/.test(edge[0]), 'an off-screen element: the hover shows an arrow saying where it is', edge);
    await popup.evaluate(`document.getElementById('showSelectorOnPage').click()`);
    await sleep(FLASH_SETTLE_MS);
    const inView = await ctx.web.evaluate(`(() => { const r = document.getElementById('choiceA').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`);
    const flashed = await outlines();
    const icon = await popup.evaluate(`document.getElementById('showSelectorOnPage').textContent`);
    // The flash (1.2 s) starts once the scroll ends (up to 0.7 s): polled, not timed.
    const gone = !!(await pageSoon(ctx, `!document.querySelector(':root > [data-ext-overlay="1"]')`, 3_000));
    check(inView && flashed.some((t) => t.includes('choiceA')) && icon === '✓' && gone,
      'a click on 👁 scrolls the element into view, flashes it, shows ✓, and the flash goes', { inView, flashed, icon, gone });

    // The box edited: the name is struck out and still shows the picked element; 👁 shows what the box holds.
    await typeSelector('#bg2');
    const stale = await popup.evaluate(`document.getElementById('pickedSelectorsWrap').classList.contains('picked-stale')`);
    await onName('mouseover');
    await sleep(PREVIEW_SETTLE_MS);
    const byName = await outlines();
    await onName('mouseout');
    await eye('mouseenter');
    await sleep(PREVIEW_SETTLE_MS);
    const byEye = await outlines();
    check(stale && byName.some((t) => t.includes('choiceA')) && byEye.some((t) => t.includes('bg2')),
      'with the box edited, the struck-out name shows the picked element and 👁 what the box holds', { stale, byName, byEye });
    // A click on the page takes away an outline the popup did not (it may have closed).
    await clickAt(ctx, '#out');
    await sleep(SETTLE_MS);
    check((await outlines()).length === 0, 'a click on the page takes away an outline left on it', await outlines());
    await eye('mouseleave');

    // At the window's right edge, right of the popup: in view — no "Under this popup" line. (The old
    // guess put the popup at that edge and said it was under it, though it could be seen.)
    await typeSelector('#choiceB');
    await popup.evaluate(`document.getElementById('showSelectorOnPage').click()`);
    await sleep(FLASH_SETTLE_MS);
    const rightOfPopup = await message();
    check(!rightOfPopup.startsWith('Under this popup'), 'an element right of the popup, at the window\'s edge, is not called covered', rightOfPopup);
    await clickAt(ctx, '#out');
    await sleep(SETTLE_MS);

    // Under the popup: the line says so, and the flash is held (until a click on the page) so Esc shows it.
    await ctx.web.evaluate(`document.getElementById('choiceB').style.right = '400px'`);
    await popup.evaluate(`document.getElementById('showSelectorOnPage').click()`);
    await sleep(FLASH_SETTLE_MS + 1_000);
    const held = { text: await message(), outlines: await outlines() };
    check(held.text === 'Under this popup — press Esc to see it.' && held.outlines.some((t) => t.includes('choiceB')),
      'an element under the popup: the line says so, and its outline outlasts the flash', held);
    await clickAt(ctx, '#out');
    await sleep(SETTLE_MS);

    // What 👁 says when it finds no single visible element.
    const says = async (selector) => {
      await typeSelector(selector);
      await popup.evaluate(`document.getElementById('showSelectorOnPage').click()`);
      await sleep(PREVIEW_SETTLE_MS);
      return { text: await message(), icon: await popup.evaluate(`document.getElementById('showSelectorOnPage').textContent`), outlines: await outlines() };
    };
    const missing = await says('#nope');
    check(missing.text.startsWith('Not on this page') && missing.icon === '✕', 'a selector that finds nothing: "Not on this page" and ✕', missing);
    const several = await says('.edit');
    check(several.text.startsWith('2 matches — playback uses the first') && several.outlines.length === 2 && several.icon === '!',
      'a selector with two matches: both outlined, the line says playback uses the first', several);
    const hidden = await says('#ctHidden');
    check(hidden.text.startsWith('On the page but hidden'), 'a hidden element: "On the page but hidden"', hidden);
    const variable = await says('#${who}');
    check(variable.text.includes('only known when it plays'), 'a selector with ${…}: not looked for, says why', variable);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove(['manualFormDraft', 'pendingEdit', 'lastPickedSelector', 'lastPickedSelectors', 'lastPickedFrameId', 'lastPickedLabel'])`);
    await closeQuietly(popup);
  }
}

export async function checkSwitchOtherCase(ctx) {
  const guest = await makeScenario(ctx, 'e2e guest', [{ type: 'click', selector: '#g', selectors: { css: '#g' } }]);
  const click = (id) => ({ type: 'click', selector: `#${id}`, selectors: { css: `#${id}` } });
  // #2 Switch: "admin" runs #3, "guest" runs another scenario; then #4.
  const id = await makeScenario(ctx, 'e2e switch other case', [
    click('a'),
    { type: 'switch', switchVar: '${role}', cases: [{ value: 'admin', scenarioId: '__self__', scenarioName: '↻ This scenario (jump)', startAt: 3, endAt: 3 },
      { value: 'guest', scenarioId: guest, scenarioName: 'e2e guest' }] },
    click('b'), click('c'),
  ]);
  const popup = await openPopup(ctx);
  try {
    await showScenario(popup, id);
    const head = await popup.evaluate(`document.querySelector('#actions li.sw-case-other')?.textContent || ''`);
    check(head.includes('case "guest"') && head.includes('runs scenario “e2e guest”'), 'a case running another scenario has its own row in the block', head);
    const under = await dragRow(popup, 3, 'sw-case-head');
    await sleep(POPUP_SETTLE_MS);
    const order = (await storedActions(popup, id)).map((a) => a.selector || a.type).join(' ');
    const toast = await popup.evaluate(`document.getElementById('toast').textContent`);
    check(order === '#a switch #b #c' && /another scenario/.test(toast), 'an action dropped under that case stays where it was', { under, order, toast });
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await popup.close();
  }
}

export async function checkNewSwitchOverActions(ctx) {
  // #1 Switch: default runs #2..#3; then #4 and #5. A new Switch is to run #5.
  const wait = (label) => ({ type: 'wait', delay: 100, label });
  const id = await makeScenario(ctx, 'e2e new switch over actions', [
    { type: 'switch', switchVar: '${role}', cases: [{ value: '__default__', scenarioId: '__self__', scenarioName: '↻ This scenario (jump)', startAt: 2, endAt: 3 }] },
    wait('upload'), wait('w3'), wait('w4'), wait('w5'),
  ]);
  const popup = await openPopup(ctx);
  try {
    await showScenario(popup, id);
    const form = await popup.evaluate(`(async () => {
      document.getElementById('addManualActionCard')?.classList.remove('collapsed');
      const type = document.getElementById('manualActionType'); type.value = 'switch'; type.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 600));
      document.getElementById('switchVar').value = '\${mode}';
      const from = document.getElementById('switchCaseFrom'); from.value = '4'; from.dispatchEvent(new Event('change'));
      document.getElementById('switchAddCase').click();
      await new Promise((r) => setTimeout(r, 300));
      return { validation: document.getElementById('switchValidation').innerText.trim(),
        continueAt: document.getElementById('switchContinueAt').selectedOptions[0]?.textContent };
    })()`);
    await popup.evaluate(`document.getElementById('addManualAction').click()`);
    await sleep(POPUP_SETTLE_MS);
    const acts = await popup.evaluate(`new Promise((r) => chrome.storage.local.get(['scenarios'], (x) => r(x.scenarios[${JSON.stringify(id)}].actions)))`);
    const shape = acts.map((a) => (a.type === 'switch' ? `switch ${a.cases.map((c) => `${c.startAt}–${c.endAt}`).join(' ')}` : a.label)).join(' | ');
    const place = await popup.evaluate(`document.querySelector('#actions li.action[data-index="5"] .index')?.title`);
    check(form.validation === '' && shape === 'switch 2–3 | upload | w3 | w4 | switch 6–6 | w5' && place === 'Switch 5 › case default',
      'a new Switch whose case runs action 5 goes in front of it: the Switch is #5, its case #6', { form, shape, place });
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('manualFormDraft')`);
    await popup.close();
  }
}

export async function checkDraftSwitchFollows(ctx) {
  // #1 a … #6 f. A new Switch in the Add form runs #5–#6 (e, f); the list changes before Add Action.
  const wait = (label) => ({ type: 'wait', delay: 100, label });
  const id = await makeScenario(ctx, 'e2e draft switch follows', ['a', 'b', 'c', 'd', 'e', 'f'].map(wait));
  let popup = await openPopup(ctx);
  try {
    await showScenario(popup, id);
    const cases = () => popup.evaluate(`document.getElementById('switchCaseList').innerText.replace(/\\s+/g, ' ').trim()`);
    const pendingFrom = () => popup.evaluate(`document.getElementById('switchCaseFrom').selectedOptions[0]?.textContent.trim()`);
    await popup.evaluate(`(async () => {
      document.getElementById('addManualActionCard')?.classList.remove('collapsed');
      const type = document.getElementById('manualActionType'); type.value = 'switch'; type.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 600));
      document.getElementById('switchVar').value = '\${mode}';
      const pick = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change')); };
      pick('switchCaseFrom', '4'); pick('switchCaseTo', '5');
      document.getElementById('switchAddCase').click();
      await new Promise((r) => setTimeout(r, 300));
      pick('switchCaseFrom', '2');   // a second case begun on "c", not added
    })()`);
    const added = await cases();
    const pending = await pendingFrom();

    await rowButton(popup, 0, 4);   // Delete "a"
    await popup.evaluate(`document.getElementById('confirmModalOk').click()`);
    await sleep(POPUP_SETTLE_MS);
    const deleted = await cases();
    const pendingAfter = await pendingFrom();
    check(added.includes('Run 5–6') && deleted.includes('Run 4–5') && !deleted.includes('Run 5–6'),
      'a Delete above a new Switch\'s case: the case still runs its actions, now #4–#5', { added, deleted });
    check(pending.endsWith(' c') && (pendingAfter === '— nothing —' || pendingAfter.endsWith(' c')),
      'a case begun but not added never names another action after a Delete', { pending, pendingAfter });

    const dropped = await dragRow(popup, 4, 'top');   // "f", the case's last action, to the top
    await sleep(POPUP_SETTLE_MS);
    const dragged = await cases();
    await popup.close();
    popup = await openPopup(ctx);
    // A draft restored before its list has loaded numbers a case "#5" (noOf), then "5".
    const reopened = (await cases()).replace('Run #', 'Run ');
    check(dropped === 'top' && dragged.includes('Run 5') && !dragged.includes('Run 4') && reopened === dragged,
      'an action dragged out of a new Switch\'s case leaves it; the draft keeps that', { dropped, dragged, reopened });

    await popup.evaluate(`document.getElementById('addManualAction').click()`);
    await sleep(POPUP_SETTLE_MS);
    const acts = await popup.evaluate(`new Promise((r) => chrome.storage.local.get(['scenarios'], (x) => r(x.scenarios[${JSON.stringify(id)}].actions)))`);
    const shape = acts.map((a) => (a.type === 'switch' ? `switch ${a.cases.map((c) => `${c.startAt}–${c.endAt}`).join(' ')}` : a.label)).join(' | ');
    check(shape === 'f | b | c | d | switch 6–6 | e', 'Add Action puts the Switch in front of the action its case still runs', shape);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('manualFormDraft')`);
    await popup.close();
  }
}

export async function checkNestedBlockCheck(ctx) {
  const wait = (label) => ({ type: 'wait', delay: 100, label });
  const own = (value, startAt, endAt) => ({ value, scenarioId: '__self__', scenarioName: '↻ This scenario (jump)', startAt, endAt });
  const swOn = (v, ...cases) => ({ type: 'switch', switchVar: `\${${v}}`, cases });
  // #2 Switch runs #3–#4 (A, B); a new Switch over #2–#3 would hold it and half its block.
  const addId = await makeScenario(ctx, 'e2e nested check add', [wait('x'), swOn('role', own('1', 3, 4)), wait('A'), wait('B'), wait('C')]);
  // #1 Switch "1" runs #2–#4: #2 Switch and its block #3–#4. Cut to #2–#3, it would cross that block.
  const editId = await makeScenario(ctx, 'e2e nested check edit', [swOn('role', own('1', 2, 4)), swOn('mode', own('i', 3, 4)), wait('A'), wait('B'), wait('C')]);
  const popup = await openPopup(ctx);
  try {
    const stored = (id) => popup.evaluate(`new Promise((r) => chrome.storage.local.get(['scenarios'], (x) => r(JSON.stringify(x.scenarios[${JSON.stringify(id)}].actions))))`);
    const tryToSave = () => popup.evaluate(`(async () => {
      const shown = document.getElementById('switchValidation').innerText.trim();
      document.getElementById('addManualAction').click();
      await new Promise((r) => setTimeout(r, ${SETTLE_MS}));
      return { shown, toast: document.getElementById('toast').textContent };
    })()`);

    await showScenario(popup, addId);
    const before = await stored(addId);
    await popup.evaluate(`(async () => {
      document.getElementById('addManualActionCard')?.classList.remove('collapsed');
      const type = document.getElementById('manualActionType'); type.value = 'switch'; type.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 600));
      document.getElementById('switchVar').value = '\${mode}';
      const pick = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change')); };
      pick('switchCaseFrom', '1'); pick('switchCaseTo', '2');
      document.getElementById('switchAddCase').click();
      await new Promise((r) => setTimeout(r, 300));
    })()`);
    const added = await tryToSave();
    const addWhy = 'the block of Switch #3 runs past the end of this case (#4)';
    check(added.shown.includes(addWhy) && added.toast.includes(addWhy) && await stored(addId) === before,
      'a new Switch over a Switch and half its block: the form says why and Add Action refuses', added);
    await popup.evaluate(`document.getElementById('cancelEdit')?.click()`);

    await showScenario(popup, editId);
    const beforeEdit = await stored(editId);
    await rowButton(popup, 0, 3);
    await popup.evaluate(`(async () => {
      document.querySelector('#switchCaseList .sw-case-edit[data-idx="0"]').click();
      await new Promise((r) => setTimeout(r, 300));
      const to = document.getElementById('switchCaseTo'); to.value = '2'; to.dispatchEvent(new Event('change'));
      document.getElementById('switchAddCase').click();
      await new Promise((r) => setTimeout(r, 300));
    })()`);
    const edited = await tryToSave();
    const editWhy = 'the block of Switch #2 runs past the end of this case (#3)';
    check(edited.shown.includes(editWhy) && edited.toast.includes(editWhy) && await stored(editId) === beforeEdit,
      'a Switch\'s case cut through the block of a Switch in it: the form says why and Save Edit refuses', edited);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('manualFormDraft')`);
    await popup.close();
  }
}

export async function checkEditFollowsList(ctx) {
  const ids = {};
  for (const name of ['switch', 'action', 'delete']) ids[name] = await makeScenario(ctx, `e2e edit follows ${name}`, switchBlockActions());
  let popup = await openPopup(ctx);
  try {
    const stored = (id) => popup.evaluate(`new Promise((r) => chrome.storage.local.get(['scenarios'], (x) => r(x.scenarios[${JSON.stringify(id)}].actions)))`);
    const confirmDelete = async () => {
      await popup.evaluate(`document.getElementById('confirmModalOk').click()`);
      await sleep(POPUP_SETTLE_MS);
    };
    const title = () => formTitle(popup);
    const save = () => popup.evaluate(`(async () => {
      const button = document.getElementById('addManualAction');
      button.click();
      for (let t = 0; button.textContent !== 'Add Action' && t < 100; t++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 300));
    })()`, 10_000);
    const setSelector = (s) => popup.evaluate(`(() => { const el = document.getElementById('manualSelector');
      el.value = ${JSON.stringify(s)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const ranges = (acts) => acts.find((a) => a.type === 'switch').cases.map((c) => `${c.startAt}–${c.endAt}`).join(' ');
    const selectors = (acts) => acts.map((a) => a.selector || a.type).join(' ');

    // The Switch open in the form, "new" dragged to the end of case "admin", then Save Edit.
    await showScenario(popup, ids.switch);
    await rowButton(popup, 3, 3);
    const dropped = await dragRow(popup, 8, 'after 5');
    await sleep(POPUP_SETTLE_MS);
    const dragged = ranges(await stored(ids.switch));
    await save();
    const saved = ranges(await stored(ids.switch));
    check(dropped === 'after 5' && dragged === '5–7 8–8' && saved === dragged,
      'Save Edit on a Switch keeps the case ranges a drag gave it while the form was open', { dropped, dragged, saved });

    // "logout" (#8) open in the form and changed, "new" dragged to the top, the popup
    // closed and opened again on its draft, then Save Edit.
    await showScenario(popup, ids.action);
    await rowButton(popup, 7, 3);
    await setSelector('#logout2');
    await dragRow(popup, 8, 'top');
    await sleep(POPUP_SETTLE_MS);
    const moved = await title();
    await popup.close();
    popup = await openPopup(ctx);
    const reopened = await title();
    await save();
    const afterDrag = selectors(await stored(ids.action));
    check(moved === 'Edit Action #9' && reopened === moved && afterDrag === '#new #a #b #c switch #menu #settings #profile #logout2',
      'the action open in the form follows a drag, its draft too: Save Edit writes it, not the one now in its old place',
      { moved, reopened, afterDrag });

    // A Delete above the action open in the form, Undo while it is open, then deleting it.
    await showScenario(popup, ids.delete);
    await rowButton(popup, 7, 3);
    await setSelector('#logout2');
    await rowButton(popup, 0, 4);
    await confirmDelete();
    const shifted = await title();
    await save();
    const afterDelete = selectors(await stored(ids.delete));
    check(shifted === 'Edit Action #7' && afterDelete === '#b #c switch #menu #settings #profile #logout2 #new',
      'the action open in the form follows a Delete above it', { shifted, afterDelete });

    await rowButton(popup, 6, 3);
    const undo = await popup.evaluate(`(async () => {
      const button = document.getElementById('undoAction');
      const enabled = !button.disabled;
      button.click();
      await new Promise((r) => setTimeout(r, ${POPUP_SETTLE_MS}));
      return { enabled, toast: document.getElementById('toast').textContent };
    })()`);
    const afterUndo = selectors(await stored(ids.delete));
    check(undo.enabled && afterUndo === afterDelete && await title() === 'Edit Action #7',
      'Undo waits while an action is open in the form: the list and the edit stay', { ...undo, afterUndo });
    await rowButton(popup, 6, 4);
    await confirmDelete();
    check(await title() === 'Add Manual Action', 'deleting the action open in the form closes the edit', await title());
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove('manualFormDraft')`);
    await popup.close();
  }
}

// A new action being filled in: Cancel beside Add Action (laid out as Save Edit / Cancel),
// and the dummy row's ✕ — both empty the card, and the dummy row goes with it.
export async function checkAddCancel(ctx) {
  const click = (id) => ({ type: 'click', selector: `#${id}`, selectors: { css: `#${id}` } });
  const id = await makeScenario(ctx, 'e2e add cancel', [click('a'), click('b')]);
  const popup = await openPopup(ctx);
  const fill = () => popup.evaluate(`(() => {
    document.getElementById('addManualActionCard')?.classList.remove('collapsed');
    const t = document.getElementById('manualActionType'); t.value = 'click'; t.dispatchEvent(new Event('change', { bubbles: true }));
    const s = document.getElementById('manualSelector'); s.value = '#new'; s.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const state = () => popup.evaluate(`(() => {
    const c = document.getElementById('cancelEdit'), a = document.getElementById('addManualAction');
    return { type: document.getElementById('manualActionType').value, selector: document.getElementById('manualSelector').value,
      ghost: !!document.querySelector('#actions li.action-ghost'), cancel: c.offsetWidth > 0,
      cancelW: c.offsetWidth, addW: a.offsetWidth, addText: a.textContent };
  })()`);
  try {
    await showScenario(popup, id);
    await fill();
    await sleep(SETTLE_MS);
    const adding = await state();
    check(adding.ghost && adding.cancel && adding.addText === 'Add Action', 'filling in a new action: the dummy row, and Cancel beside Add Action', adding);
    await rowButton(popup, 0, 3); // Edit on row 1: Save Edit / Cancel
    const editing = await state();
    check(editing.cancel && editing.addText === 'Save Edit' && editing.cancelW === adding.cancelW && editing.addW === adding.addW,
      'Add Action / Cancel take the widths Save Edit / Cancel take', { adding, editing });
    await popup.evaluate(`document.getElementById('cancelEdit').click()`);
    await sleep(SETTLE_MS);

    await fill();
    await sleep(SETTLE_MS);
    await popup.evaluate(`document.querySelector('#actions li.action-ghost [data-g="cancel"]').click()`);
    await sleep(SETTLE_MS);
    const byX = await state();
    check(!byX.ghost && byX.type === '' && byX.selector === '', "the dummy row's ✕ empties the Add Action card, and the row goes", byX);

    await fill();
    await sleep(SETTLE_MS);
    await popup.evaluate(`document.getElementById('cancelEdit').click()`);
    await sleep(SETTLE_MS);
    const byCancel = await state();
    check(!byCancel.ghost && byCancel.type === '' && byCancel.selector === '', 'Cancel while adding empties the card the same way', byCancel);
    if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  } finally {
    await ctx.ext.evaluate(`chrome.storage.local.remove(['manualFormDraft'])`);
    await closeQuietly(popup);
  }
}

// One action of every type (and each Read DOM mode) as the form saves it.
const ROUNDTRIP_LOCATORS = { css: '#go', xpath: '//*[@id="go"]', fullXpath: '/html/body/button[1]', id: 'go' };
const roundtripFixtures = (otherId) => [
  { type: 'click', selector: '#go', selectors: ROUNDTRIP_LOCATORS, delay: 500, label: 'Go' },
  { type: 'click', selector: '#list', selectors: { css: '#list' }, delay: 500, conditions: { matchMode: 'all', textContains: 'John', classContains: 'row', typeEquals: 'select' } },
  { type: 'input', selector: '#name', selectors: { css: '#name' }, value: 'Ann ${x}', delay: 300 },
  { type: 'hover', selector: '#go', selectors: ROUNDTRIP_LOCATORS, selectorType: 'id', delay: 500 },
  { type: 'navigate', url: 'https://example.com/login', delay: 1000 },
  { type: 'wait', delay: 2000 },
  { type: 'script', code: "document.title = 'x';", delay: 500 },
  { type: 'screenshot', value: 'page-${n}', delay: 500 },
  { type: 'screenshot_full', delay: 500 },
  { type: 'screenshot_element', selector: '#go', selectors: ROUNDTRIP_LOCATORS, value: 'go.png', delay: 500 },
  { type: 'screenshot_tovar', varName: 'shot', target: 'element', selector: '#go', selectors: ROUNDTRIP_LOCATORS, delay: 500 },
  { type: 'screenshot_tovar', varName: 'named', target: 'page', value: 'sub/${user}_login', delay: 500 },
  { type: 'readdom', selector: '#title', selectors: { css: '#title' }, varName: 'title', readFrom: 'text', delay: 500 },
  { type: 'readdom', selector: '#title', selectors: { css: '#title' }, pattern: 'Hello ${who}!', matchCase: true, readFrom: 'text', delay: 500 },
  { type: 'readdom', selector: '#link', selectors: { css: '#link' }, varName: 'href', readFrom: 'attr', attrName: 'href', delay: 500 },
  { type: 'dragdrop', selector: '#a', selectors: { css: '#a' }, targetSelector: '#b', targetSelectors: { css: '#b' }, delay: 500 },
  { type: 'dropdown', selector: '#sel', selectors: { css: '#sel' }, pick: { by: 'index', index: '-1', itemSelector: '.menu li' }, delay: 500 },
  { type: 'uploadFile', selector: '#file', selectors: { css: '#file' }, uploadMode: 'input', folderPath: 'C:\\data', fileNames: ['a.pdf', '${f}'], delay: 500 },
  { type: 'condition', conditionType: 'textContains', selector: '#title', selectors: { css: '#title' }, expectedValue: 'Hi', skipCount: 2, delay: 500 },
  { type: 'condition', conditionType: 'urlContains', expectedValue: '/login', skipCount: 1, delay: 500 },
  { type: 'assert', selector: '#title', selectors: { css: '#title' }, conditionType: 'textEquals', expectedValue: 'Hi ${who}', delay: 500, label: 'Title' },
  { type: 'assert', conditionType: 'urlContains', expectedValue: '/done', delay: 500 },
  { type: 'assert', selector: '#go', selectors: ROUNDTRIP_LOCATORS, conditionType: 'elementVisible', expectedValue: '', delay: 500 },
  { type: 'switch', switchVar: '${role}', cases: [{ value: 'admin', scenarioId: otherId, scenarioName: 'e2e rt other' }, { value: '__default__', scenarioId: otherId, scenarioName: 'e2e rt other' }], delay: 500 },
  // "Click through" off, on each type that has it.
  { type: 'click', selector: '#go', selectors: ROUNDTRIP_LOCATORS, delay: 500, clickThrough: false },
  { type: 'hover', selector: '#go', selectors: ROUNDTRIP_LOCATORS, delay: 500, label: 'Hover', clickThrough: false },
  { type: 'input', selector: '#name', selectors: { css: '#name' }, value: 'x', delay: 300, clickThrough: false },
  { type: 'dropdown', selector: '#sel', selectors: { css: '#sel' }, delay: 500, clickThrough: false },
  { type: 'dragdrop', selector: '#a', selectors: { css: '#a' }, targetSelector: '#b', targetSelectors: { css: '#b' }, delay: 500, clickThrough: false },
  { type: 'uploadFile', selector: '#file', selectors: { css: '#file' }, uploadMode: 'input', folderPath: 'C:\\data', fileNames: ['a.pdf'], delay: 500, clickThrough: false },
];

/** JSON with every object's keys sorted: chrome.storage hands nested objects back sorted. */
const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

export async function checkFormRoundtrip(ctx) {
  const other = await makeScenario(ctx, 'e2e rt other', [{ type: 'wait', delay: 100 }]);
  const fixtures = roundtripFixtures(other);
  const id = await makeScenario(ctx, 'e2e roundtrip', fixtures);
  const popup = await openPopup(ctx);
  await popup.evaluate(`(() => {
    document.querySelector('.tab-btn[data-tab="tabRecord"]').click();
    const s = document.getElementById('scenarioList'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(SETTLE_MS);
  const actionAt = (i) => popup.evaluate(`new Promise((r) => chrome.storage.local.get(['scenarios'], (x) => r(x.scenarios[${JSON.stringify(id)}].actions[${i}])))`);
  // Edit → Save the action at i through the form; its saved copy.
  // A type the form does not offer leaves its select empty and Save does nothing,
  // so the stored copy would come back unchanged without the form ever holding it.
  const formTypes = [];
  const editSave = async (i) => {
    const before = await actionAt(i);
    formTypes[i] = await popup.evaluate(`(async () => {
      const { startEdit } = await import('./popup/record/action-form.js');
      startEdit(${i}, ${JSON.stringify(before)});
      return document.getElementById('manualActionType').value;
    })()`);
    await popup.evaluate(`(async () => {
      await new Promise((r) => setTimeout(r, 100));
      // Saved once the form leaves edit mode (storage.onChanged does not fire for
      // a value written back unchanged, which is the point here).
      const button = document.getElementById('addManualAction');
      button.click();
      for (let t = 0; button.textContent !== 'Add Action' && t < 100; t++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 100));
    })()`, 10_000);
    return actionAt(i);
  };
  const bad = [];
  for (let i = 0; i < fixtures.length; i++) {
    const a1 = await editSave(i);
    const a2 = await editSave(i);
    if (formTypes[i] !== fixtures[i].type) bad.push({ i, type: fixtures[i].type, formType: formTypes[i] });
    else if (canonical(a1) !== canonical(fixtures[i])) bad.push({ i, type: fixtures[i].type, saved: a1 });
    else if (JSON.stringify(a2) !== JSON.stringify(a1)) bad.push({ i, type: fixtures[i].type, secondSave: a2 });
  }
  check(!bad.length, `every action type (${fixtures.length} fixtures) comes back from Edit → Save as it was`, bad);

  // The Click through checkbox: shown only for the types it covers, and kept by
  // a draft (the popup closed and opened again mid-edit).
  const offIndex = fixtures.findIndex((a) => a.type === 'hover' && a.clickThrough === false);
  const form = await popup.evaluate(`(async () => {
    const { startEdit, clearEditState } = await import('./popup/record/action-form.js');
    const { collectManualFormState, applyManualFormState } = await import('./popup/record/form-state.js');
    const shown = () => getComputedStyle(document.getElementById('clickThroughWrapper')).display !== 'none';
    const box = document.getElementById('clickThrough');
    startEdit(4, ${JSON.stringify(fixtures[4])});
    const onNavigate = shown();
    startEdit(${offIndex}, ${JSON.stringify(fixtures[offIndex])});
    const onHover = { shown: shown(), checked: box.checked };
    const draft = collectManualFormState();
    clearEditState();
    const cleared = box.checked;
    applyManualFormState(draft);
    const restored = { shown: shown(), checked: box.checked };
    clearEditState();
    return { onNavigate, onHover, draft: draft.clickThrough, cleared, restored };
  })()`);
  check(!form.onNavigate && form.onHover.shown && !form.onHover.checked && form.draft === false && form.cleared
    && form.restored.shown && !form.restored.checked,
  'the Click through checkbox shows only where it applies, and a draft keeps it', form);

  // Assert has a Condition's fields without "Then run"; switching the type keeps
  // what was filled in, and so does a draft.
  const condIndex = fixtures.findIndex((a) => a.type === 'condition');
  const asAssert = await popup.evaluate(`(async () => {
    const { startEdit, clearEditState } = await import('./popup/record/action-form.js');
    const { collectManualFormState, applyManualFormState } = await import('./popup/record/form-state.js');
    const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
    const read = () => ({
      type: document.getElementById('manualActionType').value,
      check: document.getElementById('conditionType').value,
      value: document.getElementById('conditionExpectedValue').value,
      selector: document.getElementById('manualSelector').value,
      ifShown: shown('conditionIfWrapper'), runShown: shown('conditionRunWrapper'),
      word: document.querySelector('label[for="conditionType"]').textContent,
    });
    startEdit(${condIndex}, ${JSON.stringify(fixtures.find((a) => a.type === 'condition'))});
    const asCondition = read();
    const typeSel = document.getElementById('manualActionType');
    typeSel.value = 'assert';
    typeSel.dispatchEvent(new Event('change'));
    const switched = read();
    const draft = collectManualFormState();
    clearEditState();
    applyManualFormState(draft);
    const restored = read();
    clearEditState();
    return { asCondition, switched, restored };
  })()`);
  const { asCondition: ac, switched: sw, restored: rs } = asAssert;
  check(ac.runShown && ac.word === 'If' && sw.type === 'assert' && sw.ifShown && !sw.runShown && sw.word === 'Expect'
    && sw.check === ac.check && sw.value === ac.value && sw.selector === ac.selector,
  'Condition → Assert keeps the check, its value and the selector, and leaves out "Then run"', asAssert);
  check(JSON.stringify(rs) === JSON.stringify(sw), 'a draft brings an Assert back as it was', asAssert);
  if (popup.errors().length) fail(`popup errors: ${popup.errors().join(' | ')}`);
  await popup.close();
}

export const CHECKS = [
  ['preview-no-flash', 'Disable / Enable an action without the list flashing', checkPreviewNoFlash],
  ['folder-filter', 'The Manage Scenarios folder filter, kept', checkFolderFilter],
  ['switch-draft', 'Switch draft in the popup', checkSwitchDraft],
  ['edit-follows-list', 'An action open in the form while its list changes', checkEditFollowsList],
  ['numbers-by-position', 'Every action numbered by its position, in a Switch block too', checkNumbersByPosition],
  ['switch-insert', 'A new Switch over actions already in the list', checkNewSwitchOverActions],
  ['switch-draft-follows', 'A new Switch in the form while its list changes', checkDraftSwitchFollows],
  ['switch-nested-check', 'A Switch whose case would cross the block of a Switch in it', checkNestedBlockCheck],
  ['paste-empty', 'Paste into a scenario with no actions', checkPasteEmpty],
  ['save-selects', 'Save keeps the saved scenario selected, ready to Play', checkSaveSelects],
  ['form-scroll', 'After Add Action: the card back in view, the list on the new action', checkFormScroll],
  ['switch-other-case', 'A Switch case running another scenario: listed, never dropped into', checkSwitchOtherCase],
  ['copy-switch-block', 'Copy and Paste a Switch with its block', checkCopySwitchBlock],
  ['insert-point', 'The + between rows: the dummy row, adds and a paste at that place', checkInsertPoint],
  ['insert-point-pick', 'The place picked by + kept across 🎯 Pick and a reopened draft', checkInsertPointPick],
  ['show-on-page', 'The picked element named in the form; 👁 and its name outline it on the page or scroll to it', checkShowOnPage],
  ['add-cancel','Cancel while adding, and the dummy row\'s ✕, empty the Add Action card', checkAddCancel],
  ['form-roundtrip', 'Every action type through Edit → Save', checkFormRoundtrip],
];
