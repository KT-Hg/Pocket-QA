/**
 * recent-captures.js — the last captures the user took, kept in IndexedDB for the
 * popup's Capture tab (Recent captures): copy, edit, save again, compare.
 *
 * The worker adds (bg/screenshot/after-capture.js, SAVE_CROPPED); the popup lists,
 * reads, removes and clears. Both are the extension's own origin, so they open the
 * same database. At most MAX_SHOTS captures or MAX_BYTES, the oldest dropped first.
 *
 * Where there is no indexedDB (the worker's unit tests run on a chrome fake) every
 * call resolves to nothing.
 */

export const MAX_SHOTS = 20;
export const MAX_BYTES = 50 * 1024 * 1024;
// Thumbnails show the top of the picture at 4:3, so a full-page shot is still a picture.
const THUMB_W = 240;
const THUMB_H = 180;
const DB_NAME = 'PocketQA_Recent';
const STORE = 'shots';

/**
 * The ids to drop so the newest captures fit: newest first, as many as fit under
 * both limits, and everything older than the first that does not. The newest one
 * always stays, however big it is. Pure.
 *
 * @param {{id: number, at: number, size: number}[]} entries
 */
export function pickEvictions(entries, { maxShots = MAX_SHOTS, maxBytes = MAX_BYTES } = {}) {
  const newest = [...entries].sort((a, b) => b.at - a.at);
  let bytes = 0;
  let keep = 0;
  for (const e of newest) {
    if (keep > 0 && (keep >= maxShots || bytes + e.size > maxBytes)) break;
    keep++;
    bytes += e.size;
  }
  return newest.slice(keep).map((e) => e.id);
}

let _db = null;
function openDb() {
  if (typeof indexedDB === 'undefined') return null;
  _db ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { _db = null; reject(req.error); };
  });
  return _db;
}

/** Run `fn(store)` in one transaction; resolves with what its last request returned. */
async function inStore(mode, fn) {
  const dbp = openDb();
  if (!dbp) return null;
  const db = await dbp;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let out = null;
    const req = fn(tx.objectStore(STORE));
    if (req) req.onsuccess = () => { out = req.result; };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function thumbnail(bitmap) {
  const scale = THUMB_W / bitmap.width;
  const h = Math.min(THUMB_H, Math.max(1, Math.round(bitmap.height * scale)));
  const c = new OffscreenCanvas(THUMB_W, h);
  c.getContext('2d').drawImage(bitmap, 0, 0, bitmap.width, h / scale, 0, 0, THUMB_W, h);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
}

/**
 * Keep a capture. `kind` names it in the strip (Page, Full, Element …), `name` is
 * the file it was saved as. Resolves with its id, or null without indexedDB.
 */
export async function addRecent({ blob, kind, name = '' }) {
  if (!openDb()) return null;
  const bitmap = await createImageBitmap(blob);
  const entry = { at: Date.now(), kind, name, w: bitmap.width, h: bitmap.height, size: blob.size, blob, thumb: await thumbnail(bitmap) };
  bitmap.close();
  const id = await inStore('readwrite', (s) => s.add(entry));
  const all = await listRecent();
  const drop = pickEvictions(all);
  if (drop.length) await inStore('readwrite', (s) => { drop.forEach((d) => s.delete(d)); });
  return id;
}

/** Every capture kept, newest first, without the full picture. */
export async function listRecent() {
  const all = (await inStore('readonly', (s) => s.getAll())) || [];
  return all.map(({ blob: _blob, ...rest }) => rest).sort((a, b) => b.at - a.at);
}

/** One capture, with its picture (`blob`), or null. */
export async function getRecent(id) {
  return (await inStore('readonly', (s) => s.get(id))) || null;
}

export function removeRecent(id) {
  return inStore('readwrite', (s) => s.delete(id));
}

export function clearRecent() {
  return inStore('readwrite', (s) => s.clear());
}

/** A Blob as a data: URL, for the editor and the image diff. */
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
