/**
 * ui/dom.js — the page's fixed elements, a node builder, the toast and the
 * confirm dialog.
 *
 * Everything in the three columns is built with h(): names, URLs and response
 * bodies are text the user typed, pasted or received, and must show as text,
 * never become markup.
 */

const $ = (id) => document.getElementById(id);

export const el = {
  app: $('app'),
  theme: $('toggleTheme'),
  addFolder: $('btnAddFolder'),
  folderList: $('folderList'),
  listHead: $('listHead'),
  listBar: $('listBar'),
  listQuery: $('listQuery'),
  listMethod: $('listMethod'),
  listBulk: $('listBulk'),
  caseList: $('caseList'),
  inspInner: $('inspInner'),
  askModal: $('askModal'),
  askText: $('askText'),
  askOk: $('askOk'),
  askCancel: $('askCancel'),
  toast: $('toast'),
};

/**
 * `h('button', { class: 't-btn', onclick: fn, title: 'x' }, 'Label', child)`.
 * `on…` props are listeners, `class` is className, `dataset` is copied, any
 * other prop is set as a property. Children: nodes or text; null / false skipped.
 */
export function h(tag, props, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k in n) n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : String(c));
  }
  return n;
}

let toastTimer = null;

/** `type`: 'success' | 'error' | 'warn'. An `action` adds a button (e.g. Undo) to the toast. */
export function toast(message, type, { ms = 2600, action = null } = {}) {
  el.toast.replaceChildren(message);
  if (action) {
    el.toast.append(' ', h('button', { class: 'ac-toast-btn', onclick: () => { el.toast.hidden = true; action.run(); } }, action.label));
  }
  el.toast.className = `toast toast-${type}${action ? ' ac-toast-action' : ''}`;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, action ? Math.max(ms, 6000) : ms);
}

/** The confirm dialog: resolves true on OK, false on Cancel, Escape or a click outside. */
export function ask(message, { ok = 'OK', danger = false } = {}) {
  el.askText.replaceChildren(...[message].flat());
  el.askOk.textContent = ok;
  el.askOk.classList.toggle('ac-danger', danger);
  el.askModal.hidden = false;
  el.askOk.focus();
  return new Promise((resolve) => {
    const done = (answer) => {
      el.askModal.hidden = true;
      el.askOk.removeEventListener('click', onOk);
      el.askCancel.removeEventListener('click', onCancel);
      el.askModal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(answer);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e) => { if (e.target === el.askModal) done(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    el.askOk.addEventListener('click', onOk);
    el.askCancel.addEventListener('click', onCancel);
    el.askModal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
  });
}
