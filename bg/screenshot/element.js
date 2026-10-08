/**
 * screenshot/element.js — Element capture through the debugger, tiled when the
 * element is bigger than the viewport.
 *
 * _takeElementScreenshot: attachDebugger (cdp.js), hide the scrollbar and our
 * overlays, locateElement, measureViewport (cdp.js), captureElementTiles, put the
 * page back, stitchTiles, detach, save. The catch restores the page and the zoom.
 */

import { markSessionClosed } from '../cdp/session.js';
import { tabMsg } from '../tabs.js';
import { attachDebugger, cdpRaf, measureViewport, DETACH_SETTLE_MS, TILE_SETTLE_MS } from './cdp.js';
import { openCropUI } from './crop.js';
import { downloadDataUrl } from './download.js';
import { buildDateFolder, buildScreenshotFilename, typeTagEnabled } from './filename.js';
import { CDP_HIDE_EXT_OVERLAYS, CDP_HIDE_SCROLLBAR, CDP_SHOW_EXT_OVERLAYS, CDP_SHOW_FIXED, CDP_SHOW_SCROLLBAR, cdpEval, restorePageDom, scriptingExec } from './page-scripts.js';
import { queueScreenshot } from './queue.js';
import { applyWatermark } from './watermark.js';

// After resetting the zoom to 100 %, before measuring.
const ZOOM_SETTLE_MS = 300;
// After each scroll that the measurement depends on.
const SCROLL_SETTLE_MS = 150;

/* ── Element Screenshot ─────────────────────────────────────────────────────── */

/**
 * Capture a specific DOM element, tiling it if it is larger than the viewport.
 * Uses CDP for precise clip coordinates so the result excludes surrounding page
 * content, and shifts the page with a CSS transform rather than scrolling — see
 * the tiling loop for why.
 *
 * @param {number}      tabId         - Target tab.
 * @param {object}  options
 * @param {string}      options.selector      - CSS selector fallback.
 * @param {string}      options.saveMode      - "auto" | "ask".
 * @param {string}      options.prefix        - Auto-name prefix.
 * @param {boolean}     options.crop          - Open crop UI.
 * @param {boolean}     options.returnBase64  - Embed base64 in result.
 * @param {boolean}     options.skipDownload  - Capture without saving.
 * @param {object|null} options.selectors     - The action's locators, as content.js locateNow takes them.
 * @param {string|null} options.selectorType  - The locator type chosen in the form, tried first.
 * @param {string|null} options.requestedFilename - Override filename, or null for auto.
 * @returns {Promise<{success?: boolean, filename?: string, base64?: string, error?: string}>}
 */
export function takeElementScreenshot(tabId, options = {}) {
  return queueScreenshot(tabId, () => _takeElementScreenshot(tabId, options));
}

async function _takeElementScreenshot(tabId, {
  selector, saveMode, prefix, crop = false, returnBase64 = false, skipDownload = false, selectors = null,
  selectorType = null, requestedFilename = null,
}) {
  const tag = !requestedFilename && (await typeTagEnabled()) ? '_elem' : '';
  const filename = buildScreenshotFilename(prefix, requestedFilename, tag);

  const rect0 = await tabMsg(tabId, {
    type: 'GET_ELEMENT_RECT', selector, selectors, ...(selectorType ? { selectorType } : {}),
  });
  if (!rect0 || rect0.error) return { error: rect0?.error || 'Could not get element rect' };

  const dims = await tabMsg(tabId, { type: 'GET_PAGE_DIMENSIONS' });
  if (!dims || dims.failed) return { error: 'Could not get page dimensions' };
  const { viewportWidth, viewportHeight, scrollX: origScrollX = 0, scrollY: origScrollY = 0 } = dims;

  // Non-1 browser zoom scales the viewport layout, which shifts getBoundingClientRect
  // values and makes clip coordinates mismatch the actual pixel positions in the
  // CDP screenshot. Reset to 100% for capture, then restore afterward.
  const origZoom = await new Promise(r => chrome.tabs.getZoom(tabId, r));
  if (Math.abs(origZoom - 1) > 0.01) {
    await new Promise(r => chrome.tabs.setZoom(tabId, 1, r));
    await new Promise(r => setTimeout(r, ZOOM_SETTLE_MS));
  }

  try {
    await attachDebugger(tabId);

    await cdpRaf(tabId);
    await cdpEval(tabId, CDP_HIDE_SCROLLBAR);
    await cdpRaf(tabId);
    await cdpEval(tabId, CDP_HIDE_EXT_OVERLAYS);
    await cdpRaf(tabId);

    const rect = await locateElement(tabId, selector, selectors, rect0, viewportHeight);

    // Effective capture viewport, measured AFTER attach. cssVisualViewport is the true
    // visible box — a tile clip that exceeds it renders as a blank band, because the
    // tiling uses captureBeyondViewport:false (see captureElementTiles). Falls back to the
    // page's own innerWidth/innerHeight if the command is unavailable.
    const { vpW, vpH } = await measureViewport(tabId, rect.vpW || viewportWidth, rect.vpH || viewportHeight);

    const tiles = await captureElementTiles(tabId, rect, vpW, vpH);

    await cdpEval(tabId, `document.documentElement.style.transform=''`);
    await cdpEval(tabId, `window.scrollTo(${origScrollX}, ${origScrollY})`);
    // Nothing tags `data-fxhide` any more; kept so a page left mid-capture by an older
    // build (or an interrupted run) still gets its fixed/sticky elements back.
    await cdpEval(tabId, CDP_SHOW_FIXED);
    await cdpEval(tabId, CDP_SHOW_EXT_OVERLAYS);

    let dataUrl = await stitchTiles(tiles, rect.width, rect.height);

    await cdpEval(tabId, CDP_SHOW_SCROLLBAR);
    await new Promise((r) => chrome.debugger.detach({ tabId }, r));
    await new Promise(r => setTimeout(r, DETACH_SETTLE_MS));

    if (Math.abs(origZoom - 1) > 0.01) {
      await new Promise(r => chrome.tabs.setZoom(tabId, origZoom, r));
    }

    // No tiles means CDP returned nothing for every slice — usually an element
    // that collapsed to zero height once it was scrolled into view. Reported here
    // rather than carried forward: a null dataUrl used to surface as the very
    // misleading "Download failed", or open the crop editor on a blank image.
    if (!dataUrl) {
      return { error: 'Element produced no image — it may be hidden or have zero size when scrolled into view' };
    }

    dataUrl = await applyWatermark(dataUrl, tabId);
    const downloadPath = saveMode === 'auto' ? `screenshots/${buildDateFolder()}/${filename}` : filename;
    if (crop) return openCropUI(dataUrl, downloadPath, saveMode === 'ask');
    if (!skipDownload) {
      const dl = await downloadDataUrl(dataUrl, downloadPath, saveMode === 'ask');
      if (dl.cancelled) return { cancelled: true };
      if (dl.error) return { error: dl.error };
    }
    const r = { success: true, filename };
    if (returnBase64) r.base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
    return r;

  } catch (e) {
    // See _takeFullPageScreenshot's catch (full-page.js): restore via chrome.scripting so the
    // page recovers even if the debugger detached mid-capture (e.g. ESC / banner).
    await new Promise((r) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; r(); }));
    markSessionClosed(tabId);
    await restorePageDom(tabId);
    // restorePageDom clears the tiling transform but not the scroll position, which the
    // tiling loop parks at 0,0 — put the user back where they were.
    await scriptingExec(tabId, (x, y) => window.scrollTo(x, y), [origScrollX, origScrollY]);
    if (Math.abs(origZoom - 1) > 0.01) {
      await new Promise(r => chrome.tabs.setZoom(tabId, origZoom, r)).catch(() => {});
    }
    return { error: e.message || 'Screenshot failed' };
  }
}

/** The element's rect in page coordinates (plus dpr and viewport), measured in the page, or null. */
function cdpGetRect(tabId, sel, sels) {
  return new Promise((resolve) => {
    const expr = `(function(){
      let el = null;
      ${sels?.fullXpath ? `try{ el = document.evaluate(${JSON.stringify(sels.fullXpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }catch(e){}` : ''}
      ${sels?.xpath    ? `if(!el) try{ el = document.evaluate(${JSON.stringify(sels.xpath)},     document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }catch(e){}` : ''}
      ${sels?.id       ? `if(!el) el = document.getElementById(${JSON.stringify(sels.id)});` : ''}
      if(!el) el = document.querySelector(${JSON.stringify(sel || '')});
      if(!el) return null;
      const r   = el.getBoundingClientRect();
      const sx  = document.documentElement.scrollLeft || document.body.scrollLeft || 0;
      const sy  = document.documentElement.scrollTop  || document.body.scrollTop  || 0;
      return { x: r.left + sx, y: r.top + sy, width: r.width, height: r.height,
               dpr: window.devicePixelRatio || 1,
               vpW: window.innerWidth, vpH: window.innerHeight };
    })()`;
    chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: expr, returnByValue: true,
    }, (res) => resolve(res?.result?.value || null));
  });
}

/**
 * Find the element and leave the page parked at 0,0: measure, scroll it into view
 * once, park, measure again. Falls back to the previous measurement at each step.
 */
async function locateElement(tabId, selector, selectors, rect0, viewportHeight) {
  const probe = await cdpGetRect(tabId, selector, selectors) || rect0;

  // Scroll the element into view once before capturing. The tiling below never
  // scrolls, so without this pass an element sitting below the fold would be captured
  // before its IntersectionObserver-driven lazy content (images, virtualised rows) had
  // any reason to load — the old strip loop got that for free by scrolling to it.
  const warmVpH = probe.vpH || viewportHeight;
  const warmY   = Math.max(0, probe.y - Math.max(0, (warmVpH - probe.height) / 2));
  await cdpEval(tabId, `window.scrollTo(${probe.x}, ${warmY})`);
  await cdpRaf(tabId);
  await new Promise(r => setTimeout(r, SCROLL_SETTLE_MS));

  // Park the page at 0,0 with no transform, then re-measure. Measuring here rather
  // than above is what makes the rect trustworthy: cdpGetRect converts to page
  // coordinates as `boundingClientRect + scrollTop`, which is only correct for a
  // fixed/sticky target when the scroll offset is 0 — at any other offset a fixed
  // element's rect would be reported that many pixels too low.
  await cdpEval(tabId, `document.documentElement.style.transform='';window.scrollTo(0,0)`);
  await cdpRaf(tabId);
  await new Promise(r => setTimeout(r, SCROLL_SETTLE_MS));

  return await cdpGetRect(tabId, selector, selectors) || probe;
}

/**
 * Tile the element by shifting `documentElement` with a CSS transform instead of
 * scrolling it into view.
 *
 * Scrolling re-rendered every position:fixed element at the top of the viewport for
 * each strip, baking a duplicate of the site's fixed header into every seam — and it
 * clamps at maxScrollY, so the last strip's scroll position silently stopped matching
 * its clip. A transform on documentElement makes it the containing block for its
 * fixed descendants, so a fixed header translates with the page and renders exactly
 * once, at its real position; sticky elements never enter their stuck state at
 * scroll 0, so they likewise render once, in flow. This is the same technique the
 * full-page tile path uses — hiding fixed/sticky is no longer needed here either.
 *
 * captureBeyondViewport:false means a clip may never exceed the visible viewport,
 * so elements wider or taller than it are tiled on both axes.
 */
async function captureElementTiles(tabId, rect, vpW, vpH) {
  const chunkW = Math.max(1, Math.min(vpW, rect.width));
  const chunkH = Math.max(1, Math.min(vpH, rect.height));
  const tiles  = [];

  // The 0.5 slack stops a fractional element size from emitting a final sub-pixel
  // tile, which CDP answers with an empty or 1-px image.
  for (let rowY = 0; rowY < rect.height - 0.5; rowY += chunkH) {
    const tileH = Math.min(chunkH, rect.height - rowY);
    for (let colX = 0; colX < rect.width - 0.5; colX += chunkW) {
      const tileW = Math.min(chunkW, rect.width - colX);
      await cdpEval(tabId, `document.documentElement.style.transform='translate(${-(rect.x + colX)}px,${-(rect.y + rowY)}px)'`);
      await cdpRaf(tabId);
      await new Promise(r => setTimeout(r, TILE_SETTLE_MS));

      const cap = await new Promise((resolve) => {
        chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: false,
          clip: { x: 0, y: 0, width: tileW, height: tileH, scale: 1 },
        }, (res) => resolve(res));
      });

      if (cap?.data) tiles.push({ dataUrl: `data:image/png;base64,${cap.data}`, dx: colX, dy: rowY, tileW, tileH });
    }
  }
  return tiles;
}

// Process tiles sequentially — release each GPU texture immediately after drawing
// to prevent OOM on large elements that need many tiles.
async function stitchTiles(tiles, totalWidth, totalHeight) {
  if (!tiles.length) return null;
  // Derive the real device-pixel scale from an actual captured tile rather than
  // trusting window.devicePixelRatio: without setDeviceMetricsOverride the CDP
  // screenshot renders at the monitor's native scale, which on a browser-zoomed page
  // differs from devicePixelRatio (= display scale × browser zoom). Measuring the
  // captured pixels keeps canvas and tiles in lockstep at any zoom. Measured against
  // the tile's own width, not the element width, since a tile may be a partial column.
  const firstBmp = await createImageBitmap(await fetch(tiles[0].dataUrl).then(r => r.blob()));
  const physDpr  = tiles[0].tileW > 0 ? firstBmp.width / tiles[0].tileW : 1;
  const canvas   = new OffscreenCanvas(Math.round(totalWidth * physDpr), Math.round(totalHeight * physDpr));
  const ctx      = canvas.getContext('2d');

  // Place each tile by accumulating the bitmaps' own pixel sizes rather than by
  // scaling its CSS offset. Scaling rounds every seam on its own, so a fractional
  // device-pixel ratio (a 642 px viewport at dpr 1.25 lands on 802.5) left a
  // transparent hair-line between rows. `tiles` arrives row-major, so a change in
  // `dy` means a new row starts.
  let destX = 0, destY = 0, rowH = 0, curRow = tiles[0].dy;
  for (let i = 0; i < tiles.length; i++) {
    const bmp = i === 0
      ? firstBmp
      : await createImageBitmap(await fetch(tiles[i].dataUrl).then(r => r.blob()));
    if (tiles[i].dy !== curRow) { destY += rowH; rowH = 0; destX = 0; curRow = tiles[i].dy; }
    ctx.drawImage(bmp, destX, destY);
    destX += bmp.width;
    if (bmp.height > rowH) rowH = bmp.height;
    bmp.close();
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}
