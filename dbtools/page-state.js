/**
 * page-state.js — what the integration in this Adminer tab knows right now (the
 * connection, the page, the session on the panel, the panel itself), and two
 * small helpers its modules share.
 */

export const state = {
  ctx: null,
  info: null,
  settings: null,
  session: null,  // the session the panel shows — recording, or the one last ended here
  count: 0,       // how many sessions this connection has, for the switcher's hint
  warnedUnsaved: '',
  panel: null,
  on: false,      // is the integration switched on right now?
  wired: false,   // have this page's forms been hooked?
};

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) out[key] = obj[key];
  }
  return out;
}
