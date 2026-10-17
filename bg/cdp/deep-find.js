/**
 * cdp/deep-find.js — the element a CDP step means, in the top document or in a
 * frame of the same origin below it.
 *
 * MARK_ELEMENT tags the element in the frame the action was recorded in (that
 * frame's content script answers), with a token no other document has. CDP
 * evaluates in the top document, which reaches the documents of its same-origin
 * frames, frames in frames too. A frame of another origin runs in another
 * process, out of this session's reach: chrome.debugger can address one only
 * from Chrome 125, and the manifest allows 109.
 *
 * Pure strings — no chrome.*.
 */

/** A page function: the element `sel` finds in `doc` or in a same-origin frame below it, else null. */
const FIND_FN = `function find(doc, sel) {
  const el = doc.querySelector(sel);
  if (el) return el;
  for (const frame of doc.querySelectorAll('iframe, frame')) {
    let inner = null;
    try { inner = frame.contentDocument; } catch (_) { /* another origin */ }
    const found = inner && find(inner, sel);
    if (found) return found;
  }
  return null;
}`;

/** A page expression: the element `selector` finds in the top document or in a same-origin frame, else null. */
export function deepFindExpr(selector) {
  return `(${FIND_FN})(document, ${JSON.stringify(selector)})`;
}

/**
 * A page function: the element's box in the top window's viewport — its own,
 * moved by the content box of each frame it sits in.
 */
export const DEEP_RECT_FN = `(el) => {
  const r = el.getBoundingClientRect();
  let x = r.left, y = r.top;
  for (let w = el.ownerDocument.defaultView; w && w.frameElement; w = w.parent) {
    const f = w.frameElement, fr = f.getBoundingClientRect(), cs = getComputedStyle(f);
    x += fr.left + f.clientLeft + (parseFloat(cs.paddingLeft) || 0);
    y += fr.top + f.clientTop + (parseFloat(cs.paddingTop) || 0);
  }
  return { x, y, width: r.width, height: r.height };
}`;
