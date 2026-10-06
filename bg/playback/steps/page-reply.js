/**
 * playback/steps/page-reply.js — how long a step waits for the content script to
 * play an action (PLAY_ACTION).
 */

// The action's own wait (its timeout) plus this much for the round trip …
const REPLY_SLACK_MS = 2_000;
// … but never less than this.
const MIN_REPLY_MS = 10_000;

export function pageReplyTimeout(action) {
  return Math.max(MIN_REPLY_MS, (action.timeout || 0) + REPLY_SLACK_MS);
}
