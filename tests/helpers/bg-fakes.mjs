// Extra behaviour on top of tests/helpers/chrome-fake.mjs for the playback and
// capture characterization tests: tabs that navigate, content-script replies
// that can fail the way Chrome fails them (runtime.lastError), a scripted CDP
// debugger, an in-memory IndexedDB, and images and canvases that record what is
// drawn instead of drawing it.
//
// A "picture" here is a PNG data URL whose bytes are JSON — {w, h, tag} for a
// captured frame, {w, h, tag: 'canvas', ops} for a canvas — so a golden file can
// show exactly which tiles were stitched where.
//
// Everything stays deterministic: callbacks go through the fake's own queue,
// image and blob work resolves in microtasks, and nothing touches a real clock.

const B64 = 'data:image/png;base64,';

export const png = (w, h, tag) => B64 + Buffer.from(JSON.stringify({ w, h, tag })).toString('base64');

/** A data URL's picture as an object, or null when it is not one of ours. */
export function readPng(url) {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  const meta = url.slice(5, comma);
  const body = url.slice(comma + 1);
  const text = meta.endsWith(';base64') ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body);
  try { return JSON.parse(text); } catch { return null; }
}

/** Replace every picture data URL in `v` (deeply) with ‹png …› for a readable transcript. */
export function showPictures(v) {
  if (typeof v === 'string') {
    if (v.startsWith('data:')) {
      const p = readPng(v);
      return p ? `‹png ${JSON.stringify(p)}›` : `‹data ${v.length}›`;
    }
    // base64 without the data: prefix (returnBase64 results, CSV screenshot vars)
    if (v.length > 16 && /^[A-Za-z0-9+/]+=*$/.test(v)) {
      const p = readPng(B64 + v);
      if (p) return `‹base64 ${JSON.stringify(p)}›`;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(showPictures);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = showPictures(v[k]);
    return o;
  }
  return v;
}

/** The transcript form of a log line: `path [args…]` with pictures decoded. */
export function showLogLine(line) {
  const sp = line.indexOf(' ');
  if (sp < 0) return line;
  let args;
  try { args = JSON.parse(line.slice(sp + 1)); } catch { return line; }
  return `${line.slice(0, sp)} ${JSON.stringify(showPictures(args))}`;
}

// ── images ──────────────────────────────────────────────────────────────────

class FakeBlob {
  constructor(bytes, type = '') { this._bytes = bytes; this.type = type; this.size = bytes.length; }
  text() { return Promise.resolve(this._bytes.toString('utf8')); }
  arrayBuffer() {
    const b = this._bytes;
    return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  }
}

function blobOf(url) {
  const comma = url.indexOf(',');
  const meta = url.slice(5, comma);
  const body = url.slice(comma + 1);
  const bytes = meta.endsWith(';base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body));
  return new FakeBlob(bytes, meta.replace(/;base64$/, ''));
}

function fontPx(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(font || '');
  return m ? Number(m[1]) : 10;
}

/** Deterministic pixels for getImageData: a pattern seeded by what was drawn. */
function pixels(w, h, seed) {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = 0;
  for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) % 251;
  for (let i = 0; i < data.length; i += 4) {
    const p = i / 4;
    data[i] = (p * 7 + s) % 256;
    data[i + 1] = (p * 3 + s * 2) % 256;
    data[i + 2] = (p + s * 5) % 256;
    data[i + 3] = 255;
  }
  return data;
}

export function installImageFakes(fake) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (typeof url === 'string' && url.startsWith('data:')) {
      return Promise.resolve({ blob: () => Promise.resolve(blobOf(url)) });
    }
    return realFetch(url, ...rest);
  };

  globalThis.createImageBitmap = (blob) => blob.text().then((text) => {
    let d;
    try { d = JSON.parse(text); } catch { throw new Error('The source image could not be decoded.'); }
    // A canvas drawn into another canvas brings its own drawing along.
    const tag = d.tag === 'canvas' ? { canvas: `${d.w}x${d.h}`, ops: d.ops } : d.tag;
    return { width: d.w, height: d.h, tag, close() {} };
  });

  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      this.width = w;
      this.height = h;
      const ops = [];
      this._ops = ops;
      const ctx = {
        font: '10px sans-serif', fillStyle: '#000000', textBaseline: 'alphabetic',
        drawImage: (bmp, ...n) => ops.push(['draw', bmp?.tag ?? '?', ...n]),
        fillRect: (...n) => ops.push(['fillRect', ctx.fillStyle, ...n]),
        fillText: (t, ...n) => ops.push(['fillText', ctx.font, ctx.textBaseline, ctx.fillStyle, t, ...n]),
        measureText: (t) => ({ width: String(t).length * fontPx(ctx.font) * 0.5 }),
        createImageData: (iw, ih) => ({ width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) }),
        getImageData: (x, y, iw, ih) => ({ width: iw, height: ih, data: pixels(iw, ih, JSON.stringify(ops)) }),
        putImageData: (img, x, y) => {
          let sum = 0;
          for (const b of img.data) sum = (sum + b) % 1000003;
          ops.push(['putImageData', img.width, img.height, sum, x, y]);
        },
      };
      this._ctx = ctx;
    }
    getContext() { return this._ctx; }
    convertToBlob(opts) {
      const desc = { w: this.width, h: this.height, tag: 'canvas', ops: this._ops };
      return Promise.resolve(new FakeBlob(Buffer.from(JSON.stringify(desc)), opts?.type || 'image/png'));
    }
  };

  globalThis.FileReader = class {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((ab) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(ab).toString('base64')}`;
        this.onload?.();
      });
    }
  };
  void fake;
}

// ── replies with runtime.lastError ──────────────────────────────────────────

/**
 * Wrap a callback so a reply of `{ __lastError: 'message' }` reaches it the way
 * Chrome delivers a failure: no value, runtime.lastError set for the call.
 */
function errorAware(fake, cb) {
  return (res) => {
    if (res && typeof res === 'object' && '__lastError' in res) {
      fake.setLastError({ message: res.__lastError });
      try { cb(undefined); } finally { fake.setLastError(undefined); }
      return;
    }
    cb(res);
  };
}

/** Route a chrome.* function's callback through `reply(args)`, keeping the fake's log and queue. */
function scripted(fake, ns, name, reply) {
  const base = globalThis.chrome[ns][name];
  globalThis.chrome[ns][name] = (...args) => {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    let answer;
    const wrapped = errorAware(fake, (res) => cb(res));
    if (!cb) {
      // Promise style: lastError becomes a rejection.
      return base(...args).then(() => {
        answer = reply(args);
        if (answer && typeof answer === 'object' && '__lastError' in answer) throw new Error(answer.__lastError);
        return answer;
      });
    }
    return base(...args, () => wrapped(reply(args)));
  };
}

/**
 * Content-script answers by message type: `replies[type]` is a value or
 * `(msg, tabId, frameId) => value`; `{ __lastError }` fails the call.
 */
export function installTabMessages(fake, replies) {
  scripted(fake, 'tabs', 'sendMessage', ([tabId, msg, opts]) => {
    const r = replies[msg?.type];
    const v = typeof r === 'function' ? r(msg, tabId, opts?.frameId) : r;
    return v === undefined ? {} : JSON.parse(JSON.stringify(v));
  });
}

/**
 * The CDP debugger: `cdp.attach(tabId)`, `cdp.detach(tabId)` and
 * `cdp.command(method, params, tabId, n)` return the answer (or `{ __lastError }`);
 * `n` counts calls of that method.
 */
export function installDebugger(fake, cdp) {
  const counts = {};
  scripted(fake, 'debugger', 'attach', ([target]) => cdp.attach?.(target.tabId));
  scripted(fake, 'debugger', 'detach', ([target]) => cdp.detach?.(target.tabId));
  scripted(fake, 'debugger', 'sendCommand', ([target, method, params]) => {
    counts[method] = (counts[method] || 0) + 1;
    return cdp.command?.(method, params || {}, target.tabId, counts[method]) ?? {};
  });
  return { counts, reset() { for (const k of Object.keys(counts)) delete counts[k]; } };
}

/** captureVisibleTab answers from `next(windowId, n)`. */
export function installCaptureVisibleTab(fake, next) {
  let n = 0;
  scripted(fake, 'tabs', 'captureVisibleTab', ([windowId]) => next(windowId, ++n));
  return { reset() { n = 0; } };
}

/** downloads.download answers from `next(options)` — an id, or `{ __lastError }`. */
export function installDownloads(fake, next) {
  scripted(fake, 'downloads', 'download', ([opts]) => next(opts));
}

// ── tabs that navigate ──────────────────────────────────────────────────────

/**
 * chrome.tabs.update({ url }) moves the tab, by what the URL contains:
 *   "never"  — nothing happens (the page never finishes loading)
 *   "spa"    — the URL changes after 300 ms, no status event
 *   "closes" — the tab is closed after 100 ms
 *   anything else — after 200 ms the URL changes and status 'complete' fires
 */
export function installNavigation(fake, tabs) {
  const base = globalThis.chrome.tabs.update;
  const fire = (event, ...args) => { for (const fn of [...(fake.events[event] || [])]) fn(...args); };
  const tabById = (id) => tabs.find((t) => t.id === id);
  const closeTab = (id) => {
    const i = tabs.findIndex((t) => t.id === id);
    if (i >= 0) tabs.splice(i, 1);
    fire('tabs.onRemoved', id, { windowId: 1, isWindowClosing: false });
  };
  const loaded = (id, url) => {
    const t = tabById(id);
    if (!t) return;
    t.url = url;
    t.status = 'complete';
    fire('tabs.onUpdated', id, { status: 'complete' }, { ...t });
  };
  globalThis.chrome.tabs.update = (...args) => {
    const [id, props] = args;
    const url = props?.url;
    if (url) {
      if (/closes/.test(url)) setTimeout(() => closeTab(id), 100);
      else if (/spa/.test(url)) setTimeout(() => { const t = tabById(id); if (t) t.url = url; }, 300);
      else if (!/never/.test(url)) setTimeout(() => loaded(id, url), 200);
    }
    return base(...args);
  };
  return { fire, closeTab, loaded };
}

// ── IndexedDB ───────────────────────────────────────────────────────────────

/**
 * Just enough IndexedDB for bg/idb-screenshots.js; every write lands in `fake.log`.
 * Set `failWrites` on the returned object to a store name to make its puts fail.
 */
export function installIndexedDb(fake) {
  const stores = {};
  const ctl = { stores, failWrites: null };
  const shown = (v) => JSON.stringify(showPictures(v));
  const db = {
    objectStoreNames: { contains: (n) => n in stores },
    createObjectStore: (n) => { stores[n] = new Map(); },
    transaction(name) {
      const tx = { oncomplete: null, onerror: null, aborted: false };
      let open = 0;
      const done = () => queueMicrotask(() => {
        if (tx.aborted) tx.onerror?.({ target: { error: { name: 'AbortError' } } });
        else tx.oncomplete?.({ target: tx });
      });
      const request = (fn) => {
        const r = { result: undefined, onsuccess: null, onerror: null };
        open++;
        queueMicrotask(() => {
          r.result = fn();
          r.onsuccess?.({ target: r });
          if (--open === 0) done();
        });
        return r;
      };
      tx.abort = () => { tx.aborted = true; };
      tx.objectStore = (n) => ({
        put: (v, k) => {
          if (ctl.failWrites === n) {
            fake.log.push(`idb.put (fails) ${JSON.stringify([n, k])}`);
            queueMicrotask(() => tx.onerror?.({ target: { error: { name: 'QuotaExceededError', message: 'The quota has been exceeded.' } } }));
            return {};
          }
          return request(() => { fake.log.push(`idb.put ${JSON.stringify([n, k])} ${shown(v)}`); stores[n].set(k, v); });
        },
        count: () => request(() => stores[n].size),
        clear: () => request(() => { fake.log.push(`idb.clear ${JSON.stringify([n])}`); stores[n].clear(); }),
      });
      return tx;
    },
  };
  globalThis.indexedDB = {
    open(name, ver) {
      fake.log.push(`idb.open ${JSON.stringify([name, ver])}`);
      const req = { result: null, onsuccess: null, onupgradeneeded: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        req.result = db;
        if (!Object.keys(stores).length) req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };
  return ctl;
}

// ── listeners ───────────────────────────────────────────────────────────────

/** Each event's listeners, in registration order, by the start of their source. */
export function listenerShapes(fake, events) {
  const out = {};
  for (const e of events) {
    out[e] = (fake.events[e] || []).map((fn) => String(fn).replace(/\s+/g, ' ').slice(0, 90));
  }
  return out;
}
