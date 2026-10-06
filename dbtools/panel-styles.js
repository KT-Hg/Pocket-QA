/**
 * panel-styles.js — the stylesheet of the DB tools panel's shadow root (panel.js).
 *
 * Dark by default; the light colours are applied under the extension's theme
 * when one is set and under the operating system's otherwise.
 */

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.wrap {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  width: 300px; background: #1f2430; color: #e6e9ef;
  border: 1px solid #39405180; border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.35); font-size: 13px; line-height: 1.45;
}
.wrap.collapsed { width: auto; }
/* Docked left instead: a 300px box in the bottom-right corner can sit on the last
   columns of a wide result grid, or on its paging. */
.wrap.left { right: auto; left: 16px; }
.head:focus-visible { outline: 2px solid #2563eb; outline-offset: -2px; border-radius: 10px; }
.head .ended {
  flex: none; font-size: 11px; padding: 0 6px; border-radius: 999px;
  border: 1px solid #3b4358; color: #9aa3b5;
}
/* Only needed while shut: open, the meta line says "Ended" in full. */
.wrap:not(.collapsed) .head .ended { display: none; }
.head .dock {
  flex: none; padding: 0 6px; font-size: 12px; line-height: 18px; background: transparent; border-color: transparent;
  color: #9aa3b5;
}
.head .dock:hover { background: #2b3242; }
.collapsed .head .dock { display: none; }
.head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #5a6274; flex: none; }
.dot.rec { background: #ef4444; box-shadow: 0 0 0 3px #ef444433; }
.title { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chev { opacity: .6; font-size: 11px; }
/* Something went wrong while the panel was shut. The log is inside the body, so
   without this the warning is written to a box nobody can see. */
.badge {
  flex: none; font-size: 11px; font-weight: 600; padding: 0 6px; border-radius: 999px;
  background: #b45309; color: #fff;
}
.badge.err { background: #b91c1c; }
.body { padding: 0 10px 10px; display: grid; gap: 8px; }
.collapsed .body { display: none; }
.meta { color: #9aa3b5; font-size: 12px; }
.name { font-weight: 600; word-break: break-word; }
/* The session's name is the way to the other sessions: it is where someone looks
   to see which one this is, so it is where they click to change it. */
.name .switch {
  all: unset; box-sizing: border-box; cursor: pointer; font-weight: 600; word-break: break-word;
  display: inline-flex; align-items: baseline; gap: 6px; border-radius: 4px; padding: 1px 4px; margin: -1px -4px;
}
.name .switch:hover { background: #2b3242; }
.name .switch:focus-visible { outline: 2px solid #2563eb; }
.name .caret { font-size: 10px; opacity: .6; }
.meta .state.rec { color: #f87171; }
.row { display: flex; gap: 6px; flex-wrap: wrap; }
button {
  font: inherit; padding: 5px 9px; border-radius: 6px; cursor: pointer;
  background: #2b3242; color: #e6e9ef; border: 1px solid #3b4358;
}
button:hover { background: #343c4f; }
button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
button.danger  { background: #b91c1c; border-color: #b91c1c; color: #fff; }
button.primary:hover { background: #1d4ed8; border-color: #1d4ed8; }
button.danger:hover  { background: #991b1b; border-color: #991b1b; }
button:disabled { opacity: .5; cursor: default; }
button.more { padding: 5px 8px; line-height: 1; }
button.more.on { background: #3b4358; }
[hidden] { display: none !important; }
/* Scrollbars are drawn rather than left to the platform: the panel sits on
   somebody else's page in a dark box, and the default Windows bar is a wide
   light-grey slab that reads as part of Adminer rather than part of this. One bar
   for everything the panel scrolls, the same 9px one the extension's own pages
   draw. These rules live in the shadow tree, so Adminer's own scrollbars are left
   alone. The standard scrollbar-width and scrollbar-color are unset on purpose:
   Chrome ignores these pseudo-elements once either of them is specified. */
::-webkit-scrollbar { width: 9px; height: 9px; }
::-webkit-scrollbar-thumb { background: #4b5468; border-radius: 9px; }
::-webkit-scrollbar-thumb:hover { background: #5c6780; }
::-webkit-scrollbar-track { background: transparent; }
/* The log is the one part that grows without asking, so it scrolls inside a fixed height. */
.log {
  max-height: 128px; overflow-y: auto; overscroll-behavior: contain;
  font-size: 12px; color: #9aa3b5; display: grid; gap: 3px; padding-right: 2px;
}
.log div { word-break: break-word; }
.log .warn { color: #fbbf24; }
.log .err  { color: #f87171; }
.log .ok   { color: #4ade80; }
.log .time { color: #6b7385; font-variant-numeric: tabular-nums; }
/* A notice fades out on its own; a record stays. */
.log .notice { transition: opacity .6s ease; }
.log .notice.fading { opacity: 0; }
.log .link { cursor: pointer; }
.log .link:hover .text, .log .link:focus-visible .text { text-decoration: underline; }
.log .link:focus-visible { outline: 1px solid #2563eb; border-radius: 3px; }
/* One line that rewrites itself while a rollback runs. Prepending "Running 7/40…"
   forty times would push everything said before it out of a log that keeps 40. */
.log .prog { color: #e6e9ef; }
.log .prog .bar {
  display: block; height: 3px; margin-top: 3px; border-radius: 999px; background: #39405180;
}
.log .prog .bar i { display: block; height: 100%; border-radius: 999px; background: #2563eb; }

.modal {
  position: fixed; inset: 0; z-index: 2147483001; background: rgba(8,10,16,.6);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.sheet {
  background: #1f2430; color: #e6e9ef; border: 1px solid #39405180; border-radius: 12px;
  width: min(760px, 100%); max-height: 100%; display: flex; flex-direction: column;
  box-shadow: 0 20px 60px rgba(0,0,0,.5);
}
.sheet h2 { margin: 0; padding: 12px 14px; font-size: 14px; border-bottom: 1px solid #39405180; }
.sheet pre {
  margin: 0; padding: 12px 14px; overflow: auto; flex: 1; white-space: pre-wrap; word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #d7dbe5;
}
.sheet .note { padding: 0 14px 10px; font-size: 12px; color: #fbbf24; }
.sheet .body { padding: 0 14px; }
/* What the statements below add up to. The SQL is the contract and is always
   shown, but "UPDATE users · 3 rows" is what somebody actually reads before
   deciding, and a wall of quoted values is not.

   It scrolls, and the zero min-height is what lets it: a flex item refuses to
   shrink below its content without one, so a session with a line per table pushed the
   sheet's own buttons off the bottom of a short window — the SQL above them had
   already been squeezed to nothing, and there was no way left to confirm or
   cancel what was on screen. */
.sheet .summary {
  padding: 12px 14px 4px; display: grid; gap: 4px; font-size: 12px;
  min-height: 0; overflow-y: auto;
}
.sheet .summary .line { display: flex; gap: 8px; align-items: baseline; }
.sheet .summary .op {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  padding: 0 5px; border-radius: 4px; background: #2b3242; border: 1px solid #3b4358; flex: none;
}
.sheet .summary .op.delete { color: #f87171; }
.sheet .summary .op.insert { color: #4ade80; }
.sheet .summary .tbl { font-weight: 600; }
.sheet .summary .say { color: #9aa3b5; flex: 1; }
.sheet .summary .line.skip { opacity: .75; }
.sheet .summary .line.skip .say { color: #fbbf24; }
.sheet .summary .total { color: #9aa3b5; padding-top: 2px; }
.sheet .split { padding: 10px 14px 0; font-size: 11px; color: #9aa3b5; text-transform: uppercase; letter-spacing: .04em; }
/* Step by step or folded: the same run two ways, switched in place above what it
   comes to. The hint under the buttons says what the one chosen does. */
.sheet .modes { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 12px 14px 0; flex: none; }
.sheet .modes button.mode.on { background: #2563eb2e; border-color: #2563eb; }
.sheet .modes .hint { flex-basis: 100%; font-size: 12px; color: #9aa3b5; }
/* The drift question's rows. */
.grid-wrap { padding: 8px 14px 12px; overflow: auto; flex: 1; min-height: 0; }
.grid { width: 100%; border-collapse: collapse; font-size: 12px; }
.grid th { text-align: left; font-weight: 500; color: #9aa3b5; padding: 4px 6px; border-bottom: 1px solid #39405180; }
.grid td { padding: 4px 6px; border-bottom: 1px solid #39405140; vertical-align: top; word-break: break-word; }
.grid td.val { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.grid td.was { color: #4ade80; }
.grid td.now { color: #fbbf24; }
.grid td.gone { color: #f87171; font-style: italic; }
/* In a short window the list would otherwise be squeezed to nothing between the
   heading and the buttons; the whole sheet scrolls instead, list included. */
.sheet.narrow { width: min(480px, 100%); overflow-y: auto; }
/* The session list. It scrolls on its own so the buttons under it stay put. */
.picker { padding: 10px 14px 4px; display: grid; gap: 8px; flex: none; }
.picker .filter {
  font: inherit; font-size: 13px; padding: 6px 9px; border-radius: 6px;
  background: #171b24; color: #e6e9ef; border: 1px solid #3b4358;
}
.picker .filter:focus { outline: none; border-color: #2563eb; }
.picker .list {
  display: grid; gap: 6px; max-height: 320px; overflow-y: auto; overscroll-behavior: contain; padding-right: 2px;
}
.pick-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border: 1px solid #39405180; border-radius: 8px; background: #232937;
}
.pick-row.shown { border-color: #2563eb; }
.pick-main { flex: 1; min-width: 0; }
.pick-name { font-weight: 600; word-break: break-word; }
.pick-meta { font-size: 12px; color: #9aa3b5; }
.pick-row .rec { font-size: 12px; color: #f87171; white-space: nowrap; }
.picker .none { font-size: 12px; color: #9aa3b5; padding: 4px 0; }
.sheet .field { display: grid; gap: 5px; padding: 12px 0 4px; font-size: 12px; color: #9aa3b5; }
.sheet .field input {
  font: inherit; font-size: 13px; padding: 7px 9px; border-radius: 6px;
  background: #171b24; color: #e6e9ef; border: 1px solid #3b4358;
}
.sheet .field input:focus { outline: none; border-color: #2563eb; }
.sheet .foot { display: flex; gap: 8px; justify-content: flex-end; padding: 10px 14px; border-top: 1px solid #39405180; }
`;

/* Light colours, as rules without a scope. They are applied twice below: under
   the extension's own theme when one is set (the popup and the manager page use
   the same `popupTheme` setting), and under the operating system's otherwise —
   so the panel does not sit dark on a page whose manager tab is light. */
const LIGHT = `
.wrap, .sheet { background: #ffffff; color: #1b2030; border-color: #d7dbe5; }
button { background: #f1f3f7; color: #1b2030; border-color: #ccd2de; }
button:hover { background: #e6eaf2; }
button.more.on { background: #dbe1ec; }
/* Scoped under :host(), the plain \`button\` rules above outrank the unscoped
   \`button.primary\` and \`button.danger\`: in light, Start and Roll back all
   came out grey, and the session name picked up a button's fill. */
button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
button.primary:hover { background: #1d4ed8; border-color: #1d4ed8; }
button.danger { background: #b91c1c; border-color: #b91c1c; color: #fff; }
button.danger:hover { background: #991b1b; border-color: #991b1b; }
.name .switch { background: transparent; border-color: transparent; }
.meta, .log { color: #5c6579; }
.log .time { color: #8a93a6; }
.head .ended { border-color: #ccd2de; color: #5c6579; }
.head .dock { color: #5c6579; background: transparent; border-color: transparent; }
.head .dock:hover { background: #eef1f7; }
.log .prog { color: #1b2030; }
.log .prog .bar { background: #dbe1ec; }
.sheet pre { color: #1b2030; }
.sheet .summary .op { background: #f1f3f7; border-color: #ccd2de; }
.sheet .summary .op.delete { color: #b91c1c; }
.sheet .summary .op.insert { color: #0f9d63; }
.sheet .summary .say, .sheet .summary .total, .sheet .split { color: #5c6579; }
.sheet .modes button.mode.on { background: #2563eb1f; border-color: #2563eb; }
.sheet .modes .hint { color: #5c6579; }
.sheet .summary .line.skip .say { color: #a35a06; }
.sheet .note { color: #a35a06; }
.grid th { color: #5c6579; border-color: #d7dbe5; }
.grid td { border-color: #e6e9f0; }
.grid td.was { color: #0f7a4d; }
.grid td.now { color: #a35a06; }
.grid td.gone { color: #b91c1c; }
.name .switch:hover { background: #eef1f7; }
.meta .state.rec { color: #b91c1c; }
.pick-row { background: #f7f8fb; border-color: #d7dbe5; }
.pick-meta, .picker .none { color: #5c6579; }
.pick-row .rec { color: #b91c1c; }
.picker .filter { background: #f7f8fb; color: #1b2030; border-color: #ccd2de; }
.sheet .field { color: #5c6579; }
.sheet .field input { background: #f7f8fb; color: #1b2030; border-color: #ccd2de; }
::-webkit-scrollbar-thumb { background: #c2c9d6; }
::-webkit-scrollbar-thumb:hover { background: #a7b0c2; }
`;

/** Prefix every selector of every rule in `css` with `prefix`. */
function scoped(css, prefix) {
  return css.replace(/([^{}]+)\{([^{}]*)\}/g, (all, sel, body) => {
    const sels = sel.split(',').map((x) => x.trim()).filter(Boolean).map((x) => `${prefix} ${x}`);
    return `${sels.join(', ')} {${body}}\n`;
  });
}

export const STYLE = CSS
  + `@media (prefers-color-scheme: light) {\n${scoped(LIGHT, ':host(:not([data-theme="dark"]))')}}\n`
  + scoped(LIGHT, ':host([data-theme="light"])');
