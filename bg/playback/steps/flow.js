/**
 * playback/steps/flow.js — what a step returns when the run must end.
 */

/** Returned by a step to end the run, as `break` did in the playback loop. */
export const STOP = Symbol('stop');
