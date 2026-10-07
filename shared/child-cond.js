/**
 * child-cond.js — the fields a Child Condition (action.conditions) can test.
 *
 * Playback, the variable scanners and both exporters (which write the list into
 * the code they generate) read it from here. content.js is a classic script and
 * keeps the literal (FALLBACK_FIELDS in findElementByCondition).
 *
 * Pure — no chrome.*.
 */

export const CHILD_COND_KEYS = Object.freeze(['valueEquals', 'textContains', 'idContains', 'classContains', 'typeEquals']);
