/**
 * run-state.js — "is something running?", asked the same way everywhere.
 *
 * Two questions, kept apart on purpose: whether any playback is going (a
 * scenario, a sequence or a CSV run), and whether the worker is busy at all —
 * the same plus a recording. Both return the expression's own value, like the
 * inline checks they replace.
 */

import { state } from './state.js';

/** A scenario, sequence or CSV run is playing. */
export function isAnyPlaybackActive() {
  return state.playback.active || state.sequencePlayback.active || state.csvPlayback.active;
}

/** Recording, or any playback. */
export function isBusy() {
  return state.recording || state.playback.active ||
         state.sequencePlayback.active || state.csvPlayback.active;
}
