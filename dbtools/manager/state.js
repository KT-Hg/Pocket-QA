/**
 * manager/state.js — what the manager page holds: its elements, the sessions read from
 * storage, the one on screen, the changes ticked and the diffs open, the
 * settings.
 */

export const managerState = {
  sessions: {},
  currentId: '',
  selected: new Set(),
  // Which changes have their diff open. The page redraws on every write to storage
  // — which, with Adminer open beside it, is every recorded edit — and a redraw
  // that shut every diff somebody had opened to read made the page unusable while
  // the test was running.
  openIds: new Set(),
  settings: null,
};

export const el = (id) => document.getElementById(id);

export const ui = {};
