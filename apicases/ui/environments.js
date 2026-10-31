/**
 * ui/environments.js — the environment picker in the top bar, and the dialog
 * that adds, renames, copies, deletes and fills in environments.
 *
 * An environment is a set of variables laid over the Data tab's (apicases/
 * vars.js): Dev and Staging each set ${baseUrl}, the requests stay the same.
 * Edits apply as they are typed; the dialog also lists the Data tab's
 * variables, read-only, so a name both have is seen to be overridden.
 */

import {
  activeEnv, addEnvironment, deleteEnvironment, duplicateEnvironment, envVarProblems, findEnv,
  renameEnvironment, setEnvVars, useEnvironment,
} from '../model.js';
import { loadDataVars } from '../vars.js';
import { el, h, toast } from './dom.js';

export function renderEnvSelect(app) {
  const s = app.state;
  el.envSelect.replaceChildren(...s.environments.map((e) => h('option', { value: e.id }, e.name)));
  el.envSelect.value = activeEnv(s).id;
}

/** The dialog's table of variables for environment `id`. */
function varsTable(app, id) {
  const table = h('div', { class: 'ac-env-vars' });
  const rows = () => findEnv(app.state, id)?.vars || [];
  const save = (next, redraw) => {
    app.set(setEnvVars(app.state, id, next), { render: 'none' });
    if (redraw) draw();
  };
  function draw() {
    const vars = rows();
    const problems = envVarProblems(vars);
    table.replaceChildren(
      h('div', { class: 'ac-env-row ac-env-head' }, h('span', null, 'Variable'), h('span', null, 'Value'), h('span')),
      ...vars.map((v, i) => {
        const note = h('div', { class: 'ac-field-error', hidden: !problems[i] }, problems[i]);
        const edit = (field) => (e) => {
          const next = rows().map((x, k) => (k === i ? { ...x, [field]: e.target.value } : x));
          save(next, false);
          const p = envVarProblems(next)[i];
          note.textContent = p;
          note.hidden = !p;
        };
        return h('div', { class: 'ac-env-item' },
          h('div', { class: 'ac-env-row' },
            h('input', { type: 'text', value: v.name, placeholder: 'baseUrl', spellcheck: false, 'aria-label': 'Variable name', oninput: edit('name') }),
            h('input', { type: 'text', value: v.value, placeholder: 'https://staging.example.com', spellcheck: false, 'aria-label': 'Value', oninput: edit('value') }),
            h('button', { type: 'button', class: 't-btn t-btn-sm t-btn-ghost', 'aria-label': 'Remove this variable', title: 'Remove',
              onclick: () => save(rows().filter((_, k) => k !== i), true) }, '✕')),
          note);
      }),
      h('button', { type: 'button', class: 't-btn t-btn-sm', onclick: () => save([...rows(), { name: '', value: '' }], true) }, '＋ Variable'));
  }
  draw();
  return table;
}

/** The Data tab's variables, read-only, marked where this environment overrides them. */
async function dataTabList(app, id) {
  const data = await loadDataVars();
  const mine = new Set((findEnv(app.state, id)?.vars || []).map((v) => v.name.trim()));
  const names = Object.keys(data);
  return h('div', { class: 'ac-env-data' },
    h('div', { class: 'pane-label' }, 'From the Data tab'),
    h('p', { class: 'helper' }, 'Used when this environment does not set the name. Change them in the popup\'s Data tab.'),
    names.length
      ? h('div', { class: 'ac-env-data-list' }, ...names.map((n) => h('div', { class: `ac-env-data-row${mine.has(n) ? ' is-over' : ''}` },
        h('code', null, n), h('span', null, String(data[n])), mine.has(n) ? h('em', null, 'set here') : null)))
      : h('p', { class: 'helper' }, 'None.'));
}

function openManager(app) {
  let editing = activeEnv(app.state).id;
  const left = h('div', { class: 'ac-env-list' });
  const right = h('div', { class: 'ac-env-edit' });

  const pick = (id) => { editing = id; draw(); };
  async function draw() {
    const s = app.state;
    const env = findEnv(s, editing) || activeEnv(s);
    editing = env.id;
    left.replaceChildren(...s.environments.map((e) => h('button', {
      type: 'button', class: `ac-env-pick${e.id === editing ? ' is-open' : ''}`, onclick: () => pick(e.id),
    }, e.name, e.id === s.envId ? h('span', { class: 'ac-env-inuse' }, 'in use') : null)),
    h('div', { class: 'ac-env-list-actions' },
      h('button', { type: 'button', class: 't-btn t-btn-sm', onclick: () => {
        const r = addEnvironment(app.state, `Environment ${app.state.environments.length + 1}`);
        app.set(r.state, { render: 'none' });
        pick(r.id);
      } }, '＋ New'),
      h('button', { type: 'button', class: 't-btn t-btn-sm', onclick: () => {
        const r = duplicateEnvironment(app.state, editing);
        app.set(r.state, { render: 'none' });
        pick(r.id);
      } }, 'Duplicate'),
      h('button', { type: 'button', class: 't-btn t-btn-sm', disabled: s.environments.length < 2, onclick: () => {
        const prev = app.state;
        const name = env.name;
        app.set(deleteEnvironment(prev, editing), { render: 'none' });
        renderEnvSelect(app);
        draw();
        toast(`Deleted environment "${name}"`, 'success', { action: { label: 'Undo', run: () => { app.set(prev, { render: 'none' }); renderEnvSelect(app); if (backdrop.isConnected) draw(); } } });
      } }, 'Delete')));

    const name = h('input', { type: 'text', class: 'ac-env-name', value: env.name, 'aria-label': 'Environment name',
      oninput: () => {
        app.set(renameEnvironment(app.state, editing, name.value), { render: 'none' });
        renderEnvSelect(app);
        left.querySelector('.ac-env-pick.is-open')?.firstChild?.replaceWith(name.value.trim() || env.name);
      } });
    right.replaceChildren(
      h('div', { class: 'ac-env-top' }, name,
        env.id === s.envId
          ? h('span', { class: 'helper' }, 'In use')
          : h('button', { type: 'button', class: 't-btn t-btn-sm', onclick: () => { app.set(useEnvironment(app.state, editing), { render: 'none' }); renderEnvSelect(app); draw(); } }, 'Use this one')),
      varsTable(app, editing),
      await dataTabList(app, editing));
  }

  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); renderEnvSelect(app); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } },
    h('div', { class: 'modal ac-envs', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Environments' },
      h('div', { class: 'modal-head' }, h('h3', null, 'Environments'),
        h('button', { class: 't-btn t-btn-sm', 'aria-label': 'Close', onclick: close }, '✕')),
      h('p', { class: 'helper ac-envs-help' },
        'Each environment sets variables on top of the Data tab\'s — e.g. ${baseUrl} for Dev and Staging. Values saved from responses go into the one in use.'),
      h('div', { class: 'ac-envs-body' }, left, right)));
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey, true);
  draw();
}

export function initEnvironments(app) {
  el.envSelect.addEventListener('change', () => app.set(useEnvironment(app.state, el.envSelect.value), { render: 'none' }));
  el.envManage.addEventListener('click', () => openManager(app));
}
