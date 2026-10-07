/**
 * storage-keys.js — chrome.storage keys that more than one page reads.
 *
 * The value is what installed copies already have in storage: renaming it would
 * silently reset every user's setting, so only the constant's name may change.
 *
 * Classic scripts (content.js, editor.js) cannot import and keep the literal, as
 * do the modules an Adminer page loads (dbtools/content-main.js): pulling this
 * file in there would add it to web_accessible_resources for one string.
 *
 * Pure — no chrome.*.
 */

/** Light / dark choice of the popup, shared by every extension page and in-page overlay. */
export const THEME_KEY = 'popupTheme';

/** Text highlights, keyed by normalized page URL (content.js writes through HL_SAVE_PAGE). */
export const HIGHLIGHTS_KEY = 'hl_v1';
