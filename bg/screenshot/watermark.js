/**
 * screenshot/watermark.js — the text bar stamped on a screenshot when watermarking is on.
 */

import { uint8ToBase64 } from './base64.js';

/* ── Watermark ──────────────────────────────────────────────────────────────── */

/**
 * Stamp a semi-transparent text bar at the bottom of a screenshot.
 * Returns the original dataUrl unchanged if watermarking is disabled or fails —
 * a watermark failure must never block the capture result.
 *
 * The bar sizes itself to the shot instead of assuming a full-page canvas:
 *  - A shot too short to spare the room (an element only a few dozen pixels
 *    tall) gets the bar appended *below* the image rather than painted over it,
 *    so the pixels the user actually asked for are never buried.
 *  - Text wider than the shot shrinks a few points, then middle-elides the URL.
 *    It is never squeezed through fillText's maxWidth, which condenses glyphs
 *    into an unreadable smear on a narrow capture of a page with a long URL.
 *
 * @param {string} dataUrl - PNG data URL to stamp.
 * @param {number} tabId   - Used to read the page URL for the {url} token.
 * @param {string|null} urlOverride - What the {url} token resolves to. `null`
 *        means "read it from the tab"; any string is used literally, and the
 *        empty string drops the token — window captures pass '' because they
 *        photograph something that is often not a tab, or not even a browser.
 * @returns {Promise<string>} Data URL, watermarked or original on error.
 */
export async function applyWatermark(dataUrl, tabId, urlOverride = null) {
  const settings = await new Promise(r => chrome.storage.local.get(['watermarkEnabled','watermarkFormat','watermarkFontSize'], r));
  if (!settings.watermarkEnabled) return dataUrl;
  try {
    let pageUrl = urlOverride;
    if (pageUrl == null) { pageUrl = ''; try { const t = await chrome.tabs.get(tabId); pageUrl = t.url || ''; } catch(_) { /* tab gone: watermark without a URL */ } }
    const now    = new Date().toLocaleString();
    const format = settings.watermarkFormat || '{url}  {datetime}';
    // Build the bar text from a (possibly shortened) URL. With no URL to stamp
    // — a window capture, or a tab that has gone away — the token leaves the
    // separator stranded at the front of the bar. Close the gap instead of
    // stamping padding that was meant to sit between two fields.
    const compose = (url) => {
      let t = format.replace(/\{url\}/g, () => url).replace(/\{datetime\}/g, () => now);
      if (!url) t = t.replace(/\s{2,}/g, ' ').trim();
      return t;
    };

    const bitmap    = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const requested = Math.min(48, Math.max(8, settings.watermarkFontSize || 13));
    const PAD       = Math.max(4, Math.min(12, Math.round(requested * 0.6)));
    const maxTextW  = Math.max(1, bitmap.width - PAD * 2);

    // Fit the text before committing to a canvas size: on a small shot the font
    // ends up smaller than requested, and the bar should shrink with it.
    const measure = new OffscreenCanvas(1, 1).getContext('2d');
    const fits    = (t) => measure.measureText(t).width <= maxTextW;
    // Shrink down to 7px on the default size, but never past ~half of a size
    // the user deliberately raised — they asked for a legible stamp, and an
    // elided URL beats a microscopic one.
    const MIN_FONT = Math.max(7, Math.round(requested * 0.55));
    let fontSize = requested;
    let text = compose(pageUrl);
    measure.font = `${fontSize}px sans-serif`;
    // 1. Give back a few points of font size before touching the text itself.
    while (fontSize > MIN_FONT && !fits(text)) { fontSize--; measure.font = `${fontSize}px sans-serif`; }
    // 2. Still too wide: keep both ends of the URL and elide the middle, so the
    //    host and the page stay readable and {datetime} survives intact.
    if (pageUrl && !fits(text)) {
      const elide = (n) => {
        if (n >= pageUrl.length) return pageUrl;
        const head = Math.ceil(n / 2), tail = Math.floor(n / 2);
        return pageUrl.slice(0, head) + '…' + (tail ? pageUrl.slice(pageUrl.length - tail) : '');
      };
      let lo = 0, hi = pageUrl.length;              // largest URL length that fits
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(compose(elide(mid)))) lo = mid; else hi = mid - 1;
      }
      // A URL cut down to a stub says nothing and only strands its separator —
      // drop the token and give the whole bar to the timestamp.
      text = compose(lo > 4 ? elide(lo) : '');
    }
    // 3. A shot narrower than the timestamp alone: chop whatever is left.
    if (!fits(text)) {
      let n = text.length;
      while (n > 0 && !fits(text.slice(0, n) + '…')) n--;
      text = text.slice(0, n) + '…';
    }

    const barH = Math.round(fontSize * 2.2);
    // Past roughly a third of the shot the bar stops being a caption and starts
    // being the screenshot, so it moves to its own strip underneath instead of
    // burying the pixels the user actually asked for.
    const overlay = barH <= bitmap.height * 0.35;

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height + (overlay ? 0 : barH));
    const ctx    = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const barTop = canvas.height - barH;
    ctx.fillStyle = overlay ? 'rgba(0,0,0,0.55)' : '#111111';
    ctx.fillRect(0, barTop, canvas.width, barH);
    ctx.fillStyle = '#ffffff';
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textBaseline = 'middle';
    // No maxWidth: it condenses glyphs into an unreadable smear instead of
    // clipping, which is exactly what a long URL on a narrow shot used to hit.
    ctx.fillText(text, PAD, barTop + barH / 2);

    const outBlob = await canvas.convertToBlob({ type: 'image/png' });
    return 'data:image/png;base64,' + uint8ToBase64(new Uint8Array(await outBlob.arrayBuffer()));
  } catch (e) {
    console.warn('[WATERMARK] Failed:', e);
    return dataUrl;
  }
}
