/**
 * screenshot/full-page.js — Full page, vertical / horizontal scroll and segment capture
 * through the debugger, tiled past the 4 000 px limit.
 *
 * _takeFullPageScreenshot runs the capture as named steps, in this order:
 *   resetZoomTo100       full / scroll captures are measured and taken at 100 %
 *   clearLeftoverTiling  undo what an interrupted capture may have left
 *   attachDebugger       (cdp.js) detach a stale session, attach
 *   prepareForCapture    let the session settle, hide the scrollbar and our overlays
 *   measureViewport      (cdp.js) the real viewport and page size
 *   captureOnce          regions within the limit: one CDP shot
 *   captureTiles         larger ones: tile by tile …
 *   stitchBands          … stitched in 4 000 px bands
 *   restoreAfterCapture  give the page back and detach
 *   restoreAfterError    the same from the catch, when anything above threw
 */

import { markSessionClosed } from '../cdp/session.js';
import { tabMsg } from '../tabs.js';
import { uint8ToBase64 } from './base64.js';
import { CaptureCancelled, cancelledCaptures } from './cancel.js';
import { attachDebugger, cdpRaf, measureViewport, DETACH_SETTLE_MS, RAF_TIMEOUT_MS, TILE_SETTLE_MS } from './cdp.js';
import { openCropUI } from './crop.js';
import { downloadDataUrl } from './download.js';
import { buildDateFolder, buildScreenshotFilename, typeTagEnabled } from './filename.js';
import { CDP_HIDE_EXT_OVERLAYS, CDP_HIDE_SCROLLBAR, CDP_SHOW_EXT_OVERLAYS, CDP_SHOW_FIXED, CDP_SHOW_SCROLLBAR, cdpEval, restorePageDom, scriptingExec } from './page-scripts.js';
import { queueScreenshot } from './queue.js';
import { applyWatermark } from './watermark.js';

// Zoom reset: poll this often, this many times, then let the layout reflow.
const ZOOM_POLL_MS = 100;
const ZOOM_POLL_TRIES = 25;
const ZOOM_REFLOW_MS = 250;
// After clearing a leftover tiling transform, before measuring the page.
const UNTILE_SETTLE_MS = 100;
// A new debugger session is acknowledged within this, on slow machines too.
const ATTACH_ACK_MS = 1200;
// Once the scrollbar and overlays are hidden: frames, then a settle.
const REPAINT_TIMEOUT_MS = 3000;
const PREPARE_SETTLE_MS = 300;
// Tiles never exceed the capture limit described at needsStitch, in CSS px.
const MAX_TILE_PX = 4000;

/* ── Full Page / Segment Screenshot ─────────────────────────────────────────── */

/**
 * Capture a full-page or partial-scroll screenshot using the CDP Debugger API.
 *
 * Uses `Emulation.setDeviceMetricsOverride` to expand the virtual viewport to
 * the full page size, then `Page.captureScreenshot` with `captureBeyondViewport`.
 * For regions exceeding 4 000 px per side (the practical CDP capture limit),
 * the page is tiled via CSS `transform: translate()` and the tiles are stitched.
 *
 * @param {number}  tabId           - Target tab.
 * @param {object}  options
 * @param {string}  options.saveMode        - "auto" | "ask".
 * @param {string}  options.prefix          - Auto-name prefix.
 * @param {string|null} options.requestedFilename - Override filename.
 * @param {boolean} options.crop            - Open crop UI.
 * @param {string}  options.scrollDir       - "full" | "vertical" | "horizontal".
 * @param {boolean} options.returnBase64    - Embed base64 in result.
 * @param {boolean} options.skipDownload    - Capture without saving.
 * @param {object|null} options.segmentClip - {x,y,width,height} clip rect for segment capture.
 * @param {string|null} options.segmentDir  - "vertical" | "horizontal" | "elem" for segment suffix.
 * @returns {Promise<{success?: boolean, filename?: string, base64?: string, error?: string}>}
 */
export function takeFullPageScreenshot(tabId, options = {}) {
  return queueScreenshot(tabId, () => _takeFullPageScreenshot(tabId, options));
}

async function _takeFullPageScreenshot(tabId, {
  saveMode, prefix, requestedFilename, crop = false, scrollDir = 'full', returnBase64 = false,
  skipDownload = false, segmentClip = null, segmentDir = null,
}) {
  const suffixMap = { full: '_full', vertical: '_scrollV', horizontal: '_scrollH', segV: '_segV', segH: '_segH', elem: '_elem' };
  const effectiveDir = segmentClip ? segmentKind(segmentDir) : scrollDir;
  const suffix   = (requestedFilename || !(await typeTagEnabled())) ? '' : suffixMap[effectiveDir] || '_full';
  const filename = buildScreenshotFilename(prefix, requestedFilename, suffix);

  // Clear any stale cancel request from a prior capture, then expose a checker the
  // capture loop calls at safe points to abort cooperatively on ESC.
  cancelledCaptures.delete(tabId);
  const _checkCancel = () => { if (cancelledCaptures.has(tabId)) throw new CaptureCancelled(); };

  // Full/scroll captures are normalised to 100% zoom before measuring so the saved
  // image is the standard desktop layout (and so the page dimensions read below are not
  // distorted by the zoom factor). The user's zoom is restored in both the success and
  // catch paths. Mirrors the element-capture path. Declared out here so catch can see it.
  //
  // Skipped for segment captures: the segmentClip rect was measured at the current zoom,
  // so resetting zoom (which reflows the layout) would make the clip point at the wrong
  // content. Segments instead keep the zoom and capture faithfully via the tile path
  // (see the needsStitch note below).
  const origZoom = await new Promise(r => chrome.tabs.getZoom(tabId, r));
  const zoomAdjusted = !segmentClip && Math.abs(origZoom - 1) > 0.01;
  if (zoomAdjusted) await resetZoomTo100(tabId);

  if (!segmentClip && scrollDir === 'full') await clearLeftoverTiling(tabId);

  const dims = await tabMsg(tabId, { type: 'GET_PAGE_DIMENSIONS' });
  if (!dims || dims.failed) return { error: 'Could not get page dimensions' };

  const { viewportWidth, viewportHeight, scrollX, scrollY, devicePixelRatio: dpr = 1 } = dims;
  // Mutable: the full content size from the content script is only a fallback. Once the
  // debugger is attached we replace it with CDP's own Page.getLayoutMetrics value, which
  // is authoritative and zoom-safe (see below).
  let { fullWidth, fullHeight } = dims;

  try {
    await attachDebugger(tabId);
    await prepareForCapture(tabId, effectiveDir, _checkCancel);

    // Authoritative full-page size, straight from CDP. The content-script
    // window.scrollHeight/innerWidth read earlier can lag the zoom reset, so a zoomed
    // page may report a smaller content box than Page.captureScreenshot actually
    // renders — the clip then cuts the page short. Page.getLayoutMetrics.cssContentSize
    // reports the exact CSS-px content box the capture will produce, so the clip can
    // never disagree with the rendered pixels. Falls back to the content-script dims if
    // the command is unavailable. Only the full-page size is taken from here; the
    // viewport (used for per-tile clips) stays the content-script value.
    // Effective capture viewport, measured AFTER attach. The content-script innerWidth/
    // innerHeight read before attaching does not account for the "...is debugging this
    // browser" info-bar Chrome shows once the debugger is attached, which shaves ~40px
    // off the top of the page. Tiling the page against that taller pre-attach height made
    // every captureBeyondViewport:false tile clip exceed the real viewport, leaving a
    // blank band at each row seam. cssVisualViewport is the true visible box.
    const view = await measureViewport(tabId, viewportWidth, viewportHeight);
    const { vpW, vpH } = view;
    // Authoritative full-page box (segment captures supply their own clip instead).
    if (!segmentClip && view.content) {
      fullWidth  = view.content.width;
      fullHeight = view.content.height;
    }

    const { clipX, clipY, clipWidth, clipHeight } = captureClip(segmentClip, scrollDir,
      { scrollX, scrollY, viewportWidth, viewportHeight, fullWidth, fullHeight });

    // CDP Page.captureScreenshot with captureBeyondViewport silently corrupts or
    // returns empty data for regions whose physical pixel dimension exceeds ~4 000.
    // Exceeding regions must be tiled and stitched instead.
    //
    // Segment captures additionally ALWAYS take the tile path, even for small regions.
    // The one-shot path uses captureBeyondViewport:true, which makes Chrome re-render
    // the page against its default layout viewport — on a zoomed page that reflows the
    // site into its narrow/mobile layout. The tile path uses captureBeyondViewport:false
    // and shifts the page with a CSS transform, so it captures exactly what is rendered
    // on screen at the current zoom — the "keep zoom, capture faithfully" behaviour.
    const MAX_CAPTURE_DIM = 4000;
    const needsStitch = !!segmentClip
      || (clipWidth * dpr > MAX_CAPTURE_DIM) || (clipHeight * dpr > MAX_CAPTURE_DIM);

    let result;
    // Set when a tiled capture is cancelled partway: we keep the rows captured so
    // far and save that partial image instead of discarding the whole capture.
    let partialCapture = false;

    if (!needsStitch) {
      _checkCancel();
      result = await captureOnce(tabId, { clipX, clipY, clipWidth, clipHeight });
    } else {
      const tiled = await captureTiles(tabId, { clipX, clipY, clipWidth, clipHeight }, { vpW, vpH }, { scrollX, scrollY });
      partialCapture = tiled.partial;
      result = await stitchBands(tiled.tiles, clipWidth, tiled.captHeight, dpr);
    }

    await restoreAfterCapture(tabId);

    // Restore the user's browser zoom now that the CDP capture (which required 100%)
    // is done. Detach has run, so this can no longer affect the screenshot.
    if (zoomAdjusted) {
      await new Promise(r => chrome.tabs.setZoom(tabId, origZoom, r));
    }

    if (!result?.data) return { error: 'CDP capture returned no data' };

    let dataUrl = `data:image/png;base64,${result.data}`;
    dataUrl = await applyWatermark(dataUrl, tabId);
    const downloadPath = saveMode === 'auto' ? `screenshots/${buildDateFolder()}/${filename}` : filename;
    if (crop) return openCropUI(dataUrl, downloadPath, saveMode === 'ask');
    if (!skipDownload) {
      const dl = await downloadDataUrl(dataUrl, downloadPath, saveMode === 'ask');
      if (dl.cancelled) return { cancelled: true };
      if (dl.error) return { error: dl.error };
    }
    const r = { success: true, filename };
    if (partialCapture) r.partial = true;
    if (returnBase64) r.base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
    return r;

  } catch (e) {
    // Cancelled either cooperatively (ESC on page → CaptureCancelled) or by an
    // external debugger detach (banner Cancel → onDetach marks cancelledCaptures,
    // and the in-flight CDP call rejects into here). Both resolve as a clean cancel.
    const cancelled = e instanceof CaptureCancelled || cancelledCaptures.has(tabId);
    await restoreAfterError(tabId, scrollX, scrollY);
    if (zoomAdjusted) {
      await new Promise(r => chrome.tabs.setZoom(tabId, origZoom, r)).catch(() => {});
    }
    return cancelled ? { cancelled: true } : { error: e.message || 'Screenshot failed' };
  }
}

/**
 * The region to capture, in CSS px: the segment as given, the whole page, or for
 * a scroll capture one viewport across, from the scroll position on.
 */
function captureClip(segmentClip, scrollDir, { scrollX, scrollY, viewportWidth, viewportHeight, fullWidth, fullHeight }) {
  if (segmentClip) {
    const { x: clipX, y: clipY, width: clipWidth, height: clipHeight } = segmentClip;
    return { clipX, clipY, clipWidth, clipHeight };
  }
  const clipX = scrollDir === 'full' ? 0 : scrollX;
  const clipY = scrollDir === 'full' ? 0 : scrollY;
  if (scrollDir === 'vertical') return { clipX, clipY, clipWidth: viewportWidth, clipHeight: fullHeight - scrollY };
  if (scrollDir === 'horizontal') return { clipX, clipY, clipWidth: fullWidth - scrollX, clipHeight: viewportHeight };
  return { clipX, clipY, clipWidth: fullWidth, clipHeight: fullHeight };
}

/** The file-name kind of a segment capture: segH, elem or segV. */
function segmentKind(segmentDir) {
  if (segmentDir === 'horizontal') return 'segH';
  if (segmentDir === 'elem') return 'elem';
  return 'segV';
}

/**
 * setZoom resolves as soon as the change is QUEUED, not when the renderer has
 * reflowed at the new zoom. If we measure too early the viewport is still the zoomed
 * (narrow) one. Poll getZoom until the reset has actually taken effect before measuring.
 */
async function resetZoomTo100(tabId) {
  await new Promise(r => chrome.tabs.setZoom(tabId, 1, r));
  for (let i = 0; i < ZOOM_POLL_TRIES; i++) {
    const z = await new Promise(r => chrome.tabs.getZoom(tabId, r));
    if (Math.abs(z - 1) < 0.01) break;
    await new Promise(r => setTimeout(r, ZOOM_POLL_MS));
  }
  // A little extra settle time for the post-reset layout reflow.
  await new Promise(r => setTimeout(r, ZOOM_REFLOW_MS));
}

/**
 * Clear any leftover transforms from a previous interrupted tile-stitch pass.
 * A non-zero scroll position or a residual translateX/Y would offset the
 * coordinates reported by GET_PAGE_DIMENSIONS, causing the capture clip to
 * be calculated against a shifted layout.
 */
async function clearLeftoverTiling(tabId) {
  await scriptingExec(tabId, () => {
    document.documentElement.style.transform = '';
    document.documentElement.style.transformOrigin = '';
    document.body.style.transform = '';
    document.body.style.transformOrigin = '';
    window.scrollTo(0, 0);
    document.documentElement.scrollTop  = 0;
    document.documentElement.scrollLeft = 0;
  });
  await new Promise(r => setTimeout(r, UNTILE_SETTLE_MS));
}

/**
 * Wait for the browser to acknowledge the new debugger session before sending
 * commands. Sending commands immediately after attach can silently fail on
 * slow machines or when the tab is mid-navigation.
 * Then hide the scrollbar and our own overlays; a full capture also starts from
 * the top, untransformed.
 */
async function prepareForCapture(tabId, effectiveDir, _checkCancel) {
  await new Promise(r => setTimeout(r, ATTACH_ACK_MS));
  _checkCancel();

  // NOTE: we deliberately do NOT call Emulation.setDeviceMetricsOverride here.
  // The override establishes its own emulated viewport, but it does NOT cancel the
  // tab's browser zoom — the two compound, so on a zoomed page the emulated layout
  // viewport shrank (width ÷ zoom), flipping the site into its narrow/mobile
  // responsive layout and throwing the tile coordinates off (overlapping strips).
  // captureBeyondViewport already renders the full page beyond the visible area on
  // its own, so the override was never needed. Capturing at the page's natural
  // devicePixelRatio keeps the clip math and the rendered pixels in agreement at any
  // zoom — the same approach the element-capture path uses successfully.

  await new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
      awaitPromise: true, timeout: RAF_TIMEOUT_MS,
    }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });

  await cdpEval(tabId, CDP_HIDE_SCROLLBAR);
  await cdpEval(tabId, CDP_HIDE_EXT_OVERLAYS);

  if (effectiveDir === 'full') {
    await cdpEval(tabId, `document.documentElement.style.transform='';document.body.style.transform='';window.scrollTo(0,0);`);
  }

  await cdpRaf(tabId, REPAINT_TIMEOUT_MS);
  await new Promise(r => setTimeout(r, PREPARE_SETTLE_MS));
}

/** One CDP shot of the whole clip, for regions within the 4 000 px limit. */
function captureOnce(tabId, { clipX, clipY, clipWidth, clipHeight }) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: clipX, y: clipY, width: clipWidth, height: clipHeight, scale: 1 },
    }, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

/**
 * Larger regions: shift the page tile by tile and capture each, then put the page
 * back to `scrollX`, `scrollY`. Resolves { tiles (rows of tiles), captHeight,
 * partial }; a cancel keeps the rows taken so far (partial), or throws when there
 * are none.
 */
async function captureTiles(tabId, { clipX, clipY, clipWidth, clipHeight }, { vpW, vpH }, { scrollX, scrollY }) {
  const chunkW = Math.min(MAX_TILE_PX, vpW);
  const chunkH = Math.min(MAX_TILE_PX, vpH);
  const tiles  = [];

  await cdpEval(tabId, `window.scrollTo(0, 0)`);
  await cdpRaf(tabId);

  // Tile the page by shifting `documentElement` with CSS transform rather than
  // scrolling. Scrolling would reposition fixed/sticky elements on each tile; the
  // transform approach keeps the layout static so each tile aligns when stitched.
  //
  // Fixed and sticky elements are deliberately NOT hidden here. A transform on
  // documentElement makes it the containing block for its fixed descendants, so a
  // fixed header is positioned relative to (and translates with) the page — it
  // renders once at the top instead of repeating per tile. Sticky elements never
  // enter their stuck state at scroll 0, so they likewise render once in flow.
  // Hiding either would simply drop them from the screenshot (e.g. a site's main
  // header losing its background bar).
  let rowY = 0;
  let aborted = false;
  while (rowY < clipHeight) {
    const tileH  = Math.min(chunkH, clipHeight - rowY);
    const rowTiles = [];
    let colX = 0;
    while (colX < clipWidth) {
      // On cancel — ESC on the page, or an external detach (banner Cancel →
      // onDetach marks the tab) — stop and keep the rows captured so far rather
      // than discarding everything. Breaking before the current (incomplete) row
      // is pushed keeps the partial image a clean rectangle.
      if (cancelledCaptures.has(tabId)) { aborted = true; break; }
      const tileW = Math.min(chunkW, clipWidth - colX);
      await cdpEval(tabId, `document.documentElement.style.transform='translate(${-(clipX+colX)}px,${-(clipY+rowY)}px)'`);
      await cdpRaf(tabId);
      await new Promise(r => setTimeout(r, TILE_SETTLE_MS));

      const cap = await new Promise((resolve) => {
        chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: false,
          clip: { x: 0, y: 0, width: tileW, height: tileH, scale: 1 },
        }, (res) => resolve(res));
      });

      if (cap?.data) rowTiles.push({ dataUrl: `data:image/png;base64,${cap.data}`, dx: colX, dy: rowY, tileW, tileH });
      colX += tileW;
    }
    if (aborted) break;
    tiles.push(rowTiles);
    rowY += tileH;
  }

  // Height actually captured: the full clip, or how far we got before a cancel.
  // If nothing was captured (cancelled on the very first row), there is no partial
  // image to keep — fall back to a clean cancel via the catch.
  const captHeight = aborted ? rowY : clipHeight;
  if (aborted && captHeight === 0) throw new CaptureCancelled();

  await cdpEval(tabId, `document.documentElement.style.transform=''`);
  await cdpEval(tabId, `window.scrollTo(${scrollX}, ${scrollY})`);
  await cdpEval(tabId, CDP_SHOW_FIXED);
  return { tiles, captHeight, partial: aborted };
}

/** The tiles drawn into one image, as { data } (base64 PNG). */
async function stitchBands(tiles, clipWidth, captHeight, dpr) {
  // Stitch in 4000 px bands to keep OffscreenCanvas under GPU memory limits.
  // Process strips sequentially — release each GPU texture after drawing.
  const BAND_H    = 4000;
  const allTiles  = tiles.flat();

  // Derive the real device-pixel scale from an actual captured tile rather than
  // trusting window.devicePixelRatio. Without setDeviceMetricsOverride the CDP
  // screenshot renders at the monitor's native scale, which on a browser-zoomed
  // page differs from window.devicePixelRatio (= display scale × browser zoom).
  // Using the reported dpr would size the stitch canvas too wide (or too narrow) and
  // leave half the image blank. Measuring the captured pixels keeps canvas and tiles
  // in lockstep at any zoom — the same approach the element-capture path uses.
  let stitchDpr = dpr;
  if (allTiles.length > 0 && allTiles[0].tileW > 0) {
    const probe = await createImageBitmap(await fetch(allTiles[0].dataUrl).then(r => r.blob()));
    if (probe.width > 0) stitchDpr = probe.width / allTiles[0].tileW;
    probe.close();
  }

  const bandSections = [];
  let bandY = 0;

  while (bandY < captHeight) {
    const bandH   = Math.min(BAND_H, captHeight - bandY);
    const bandEnd = bandY + bandH;
    const bandTiles = allTiles.filter(t => t.dy < bandEnd && (t.dy + t.tileH) > bandY);

    if (bandTiles.length > 0) {
      const canvas = new OffscreenCanvas(Math.round(clipWidth * stitchDpr), Math.round(bandH * stitchDpr));
      const ctx    = canvas.getContext('2d');

      for (const tile of bandTiles) {
        const bmp = await createImageBitmap(await fetch(tile.dataUrl).then(r => r.blob()));
        const srcYStart = Math.max(0, bandY - tile.dy);
        const srcYEnd   = Math.min(tile.tileH, bandEnd - tile.dy);
        const srcH      = srcYEnd - srcYStart;
        if (srcH <= 0) { bmp.close(); continue; }
        const destY = Math.max(0, tile.dy - bandY);
        ctx.drawImage(bmp,
          0, Math.round(srcYStart * stitchDpr), Math.round(tile.tileW * stitchDpr), Math.round(srcH * stitchDpr),
          Math.round(tile.dx * stitchDpr), Math.round(destY * stitchDpr), Math.round(tile.tileW * stitchDpr), Math.round(srcH * stitchDpr));
        bmp.close();
      }

      const sectionBlob = await canvas.convertToBlob({ type: 'image/png' });
      bandSections.push({ data: uint8ToBase64(new Uint8Array(await sectionBlob.arrayBuffer())), h: bandH });
    }
    bandY += bandH;
  }

  if (bandSections.length === 1) {
    return { data: bandSections[0].data };
  } else {
    const finalCanvas = new OffscreenCanvas(Math.round(clipWidth * stitchDpr), Math.round(captHeight * stitchDpr));
    const finalCtx    = finalCanvas.getContext('2d');
    let yPos = 0;
    for (const band of bandSections) {
      const bmp = await createImageBitmap(await fetch(`data:image/png;base64,${band.data}`).then(r => r.blob()));
      finalCtx.drawImage(bmp, 0, Math.round(yPos * stitchDpr));
      bmp.close();
      yPos += band.h;
    }
    const finalBlob = await finalCanvas.convertToBlob({ type: 'image/png' });
    return { data: uint8ToBase64(new Uint8Array(await finalBlob.arrayBuffer())) };
  }
}

/** Give the page back after a capture — scrollbar, overlays, metrics — and detach. */
async function restoreAfterCapture(tabId) {
  await cdpEval(tabId, CDP_SHOW_SCROLLBAR);
  await cdpEval(tabId, CDP_SHOW_EXT_OVERLAYS);
  await new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride', {}, resolve);
  });
  await new Promise((resolve) => chrome.debugger.detach({ tabId }, resolve));
  await new Promise(r => setTimeout(r, DETACH_SETTLE_MS));
}

/**
 * On a cooperative cancel the debugger is still attached, so undo the page
 * mutations via CDP first (clean path). These cdpEval/sendCommand calls are
 * best-effort no-ops if the debugger already went away (e.g. ESC dismissed
 * Chrome's banner); restorePageDom via chrome.scripting is then the guaranteed
 * path that resets transform / scrollbar / hidden fixed elements without it.
 */
async function restoreAfterError(tabId, scrollX, scrollY) {
  await cdpEval(tabId, `document.documentElement.style.transform='';document.body.style.transform='';`).catch(() => {});
  await cdpEval(tabId, CDP_SHOW_FIXED).catch(() => {});
  await cdpEval(tabId, CDP_SHOW_EXT_OVERLAYS).catch(() => {});
  await cdpEval(tabId, CDP_SHOW_SCROLLBAR).catch(() => {});
  await cdpEval(tabId, `window.scrollTo(${scrollX}, ${scrollY})`).catch(() => {});
  await new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride', {}, () => { void chrome.runtime.lastError; resolve(); });
  });
  await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); }));
  markSessionClosed(tabId);
  await restorePageDom(tabId);
}
