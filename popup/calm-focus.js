/**
 * calm-focus.js — a dropdown picked with the mouse lets go of focus.
 *
 * Its focus border otherwise stayed lit until the next click somewhere else,
 * which read as the field still being edited. Once a pointer pick lands
 * (change), the select is blurred — after the page's own change handlers, and
 * only if none of them moved focus on. Keyboard use is left alone: arrow keys
 * on a closed select fire a change per press, so blurring there would throw a
 * keyboard user out of the control.
 *
 * Side-effect module: importing it (or loading it with <script type="module">)
 * installs the listeners once for the page. The resting / focus look of the
 * fields themselves is plain CSS — see "Form field focus" in css/popup.css.
 */

let _pickedByPointer = null;

document.addEventListener('pointerdown', (e) => {
  _pickedByPointer = e.target?.closest?.('select') || null;
}, true);

document.addEventListener('keydown', (e) => {
  if (e.target?.tagName === 'SELECT') _pickedByPointer = null;
}, true);

document.addEventListener('change', (e) => {
  const sel = e.target;
  if (sel?.tagName !== 'SELECT' || sel !== _pickedByPointer) return;
  _pickedByPointer = null;
  setTimeout(() => { if (document.activeElement === sel) sel.blur(); });
}, true);
