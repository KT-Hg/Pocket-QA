/**
 * run-as.js — the devices and networks a scenario can be played as (📱 Run as):
 * a phone's screen, pixel ratio, touch and user agent; a slower or no network.
 * The service worker applies them through CDP for the whole run
 * (bg/cdp/run-session.js); the popup lists them; the code exports set the same.
 *
 * Stored on the scenario as `runAs: { device, network }`, each a key below;
 * missing, or 'desktop' / 'normal', means as the browser is.
 *
 * Pure — no chrome.*.
 */

const IOS = (model) => `Mozilla/5.0 (${model}; CPU ${model === 'iPad' ? 'OS' : 'iPhone OS'} 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1`;
const ANDROID = (model) => `Mozilla/5.0 (Linux; Android 14; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36`;

export const DEVICES = Object.freeze({
  iphoneSE:  { name: 'iPhone SE',  width: 375,  height: 667,  dpr: 2,     ua: IOS('iPhone') },
  iphone14:  { name: 'iPhone 14',  width: 390,  height: 844,  dpr: 3,     ua: IOS('iPhone') },
  pixel7:    { name: 'Pixel 7',    width: 412,  height: 915,  dpr: 2.625, ua: ANDROID('Pixel 7') },
  galaxyS20: { name: 'Galaxy S20', width: 360,  height: 800,  dpr: 3,     ua: ANDROID('SM-G981B') },
  ipad:      { name: 'iPad',       width: 820,  height: 1180, dpr: 2,     ua: IOS('iPad') },
  ipadPro:   { name: 'iPad Pro',   width: 1024, height: 1366, dpr: 2,     ua: IOS('iPad') },
});

// Chrome DevTools' throttling presets: bytes a second, and milliseconds added to each request.
export const NETWORKS = Object.freeze({
  fast4g:  { name: 'Fast 4G', latency: 165,   download: 1012500, upload: 168750 },
  '3g':    { name: '3G',      latency: 562.5, download: 180000,  upload: 84375 },
  slow3g:  { name: 'Slow 3G', latency: 2000,  download: 50000,   upload: 50000 },
  offline: { name: 'Offline', offline: true,  latency: 0, download: 0, upload: 0 },
});

/** `runAs` with only what it changes: { device?, network? } of known keys, or null for as the browser is. */
export function runAsOf(runAs) {
  const device = DEVICES[runAs?.device] ? runAs.device : null;
  const network = NETWORKS[runAs?.network] ? runAs.network : null;
  if (!device && !network) return null;
  return { ...(device ? { device } : {}), ...(network ? { network } : {}) };
}

/** "📱 iPhone 14 · Slow 3G", "Slow 3G", or '' — as the run panel and the Last run card say it. */
export function runAsText(runAs) {
  const r = runAsOf(runAs);
  if (!r) return '';
  const parts = [];
  if (r.device) parts.push(`📱 ${DEVICES[r.device].name}`);
  if (r.network) parts.push(NETWORKS[r.network].name);
  return parts.join(' · ');
}
