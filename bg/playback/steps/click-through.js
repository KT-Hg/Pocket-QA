/**
 * playback/steps/click-through.js — "Click through": whether an action may act on
 * an element a user could not (disabled, read-only, not visible, covered).
 *
 * Two flags, both allowing it unless set to false: one on the action, one on the
 * scenario it belongs to (`ctx.strict` is the scenario's, off). The action may
 * click through only when both allow it, so turning the scenario's off checks
 * every action of it, and turning it back on leaves each action with its own.
 * When it may not, the page is told `strict: true` and fails the action instead
 * (content.js _blockedReason).
 */

// The actions that act on an element the way a user would.
const CLICK_THROUGH_TYPES = new Set(['click', 'hover', 'input', 'dropdown', 'dragdrop', 'uploadFile']);

/** `{ strict: true }` to add to the page's message when the action may not click through, else `{}`. */
export function strictFor(ctx, action) {
  const strict = CLICK_THROUGH_TYPES.has(action.type) && (ctx.strict || action.clickThrough === false);
  return strict ? { strict: true } : {};
}
