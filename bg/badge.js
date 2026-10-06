/**
 * badge.js — the toolbar badge: what the worker is doing (REC, PICK, playback
 * progress, CSV row, sequence item, a paused failed action).
 */

import { state } from './state.js';

/* ── Badge ─────────────────────────────────────────────────────────────────── */

function _badgeProgress(current, total) {
  const s = `${current}/${total}`;
  return s.length <= 4 ? s : `${Math.round(current / total * 100)}%`;
}

/** The badge text and colour for what the worker is doing now; the first that applies wins. */
function badgeState() {
  if (state.pickMode) return { text: 'PICK', color: '#6366f1' };
  if (state.recording) return { text: 'REC', color: '#ef4444' };
  if (state.playback.active && state.playback.failPrompt) {
    // Paused on the failed-action prompt in the page, waiting for a click.
    return { text: '!', color: '#f59e0b' };
  }
  if (state.csvPlayback.active) {
    const row   = state.csvPlayback.currentRow ?? 0;
    const total = state.csvPlayback.rows?.length ?? 0;
    return { text: total > 0 ? _badgeProgress(row + 1, total) : 'CSV', color: '#3b82f6' };
  }
  if (state.sequencePlayback.active) {
    const idx   = state.sequencePlayback.currentIndex ?? 0;
    const total = state.sequencePlayback.runList?.length ?? 0;
    return { text: total > 0 ? _badgeProgress(idx + 1, total) : 'SEQ', color: '#f97316' };
  }
  if (state.playback.active) {
    const loopTot = state.playback.loopTotal ?? 1;
    if (loopTot > 1) {
      const loopCur = state.playback.loopCurrent ?? 1;
      return { text: _badgeProgress(loopCur, loopTot), color: '#22c55e' };
    }
    const idx   = state.playback.actionIndex ?? 0;
    const total = state.playback.totalActions ?? 0;
    return { text: total > 0 ? _badgeProgress(idx + 1, total) : '▶', color: '#22c55e' };
  }
  return { text: '', color: '#6b7280' };
}

export function updateBadge() {
  const { text, color } = badgeState();
  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
}
