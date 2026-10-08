/**
 * click-through.js — the action types "Click through" covers: the ones that act
 * on an element the way a user would. With it off (for the action or its
 * scenario), playback fails such an action when a user could not reach the
 * element — disabled, read-only, not visible, covered. The form shows the
 * checkbox for these types (popup/record/form-table.js); the worker decides with
 * them (bg/playback/steps/click-through.js).
 */
export const CLICK_THROUGH_TYPES = ['click', 'hover', 'input', 'dropdown', 'dragdrop', 'uploadFile'];
