/**
 * playback/steps/wait.js — Wait: a fixed pause.
 */

export async function runWait(ctx, i, action) {
  // `delay` first, the same order the popup's preview and editor and both
  // exporters read it in. Only old actions (and "save sequence as
  // scenario" ones) keep the duration in `value`; one carrying both used
  // to show one duration and wait another.
  const ms = parseInt(action.delay || action.value || 500, 10);
  await new Promise((resolve) => setTimeout(resolve, isNaN(ms) ? 500 : ms));
  return i;
}
