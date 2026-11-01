/**
 * rail.js — the left column of the full-tab pages (sqltest.html, apitest.html,
 * dbtest.html), shut and reopened the same way on all three.
 *
 * ☰ in the top bar (#btnRail) and ⟨ in the column's head (#btnRailClose) shut
 * it; a shut column leaves #railReopen at the window's left edge, and ☰ opens
 * it again. The look is css/tool-base.css's (.app.rail-off). Each page keeps its
 * own choice under `key` — a view preference of this browser, like the Adminer
 * panel's dock side (dbtools/panel.js), so localStorage rather than
 * chrome.storage: read synchronously, a column remembered shut never flashes
 * open first. Below 900px the column is an overlay and starts shut whatever was
 * kept, or it would open on top of the page.
 *
 * `onToggle` runs after every change, for a page whose layout follows the main
 * column's width.
 */

const NARROW = '(max-width: 900px)';

export function initRail(key, onToggle = () => {}) {
  const app = document.getElementById('app');
  const reopen = document.getElementById('railReopen');
  let kept = null;
  try { kept = localStorage.getItem(key); } catch { /* private mode */ }
  let open = kept !== '0' && !matchMedia(NARROW).matches;

  const apply = () => {
    app.classList.toggle('rail-off', !open);
    // The top bar sits above .app, and takes the same gutter.
    document.body.classList.toggle('rail-off', !open);
    reopen.hidden = open;
    onToggle();
  };
  const set = (next) => {
    open = next;
    try { localStorage.setItem(key, open ? '1' : '0'); } catch { /* private mode */ }
    apply();
  };

  document.getElementById('btnRail').addEventListener('click', () => set(!open));
  document.getElementById('btnRailClose').addEventListener('click', () => set(false));
  reopen.addEventListener('click', () => set(true));
  apply();
}
