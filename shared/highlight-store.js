/**
 * highlight-store.js — the text-highlight store (hl_v1): the key a page's
 * highlights go under, re-grouping it when the URL patterns change, and the
 * edits the worker applies to it (HL_EDIT).
 *
 * Edits, not whole lists: a page or the popup that sent its copy of a list wrote
 * back whatever it had read, and a highlight another tab saved in between was
 * lost. The worker applies each edit to the store as it is then.
 *
 * content-highlight.js keeps its own copy of the URL functions: it is a classic
 * script and cannot import this.
 *
 * Pure — no chrome.*.
 */

/**
 * A bare #anchor jumps within the same document, so it must not fork the
 * storage key. A #/route (or #!/route) hash is a router path and does name a
 * different page, so that one stays part of the key.
 */
export function hlCanonicalUrl(url) {
  const s = String(url || '');
  const i = s.indexOf('#');
  if (i === -1) return s;
  const first = s[i + 1];
  return (first === '/' || first === '!') ? s : s.slice(0, i);
}

/** Supports * in both path segments AND subdomain (e.g. *.myapp.com/path). */
export function hlMatchPattern(url, pattern) {
  const strip = s => hlCanonicalUrl(s).replace(/^https?:\/\//, '');
  const pat = strip(pattern);
  const u   = strip(url);
  // A pattern naming no query of its own matches whatever query the URL
  // carries — /products and /products?page=2 are one page as far as a
  // grouping rule is concerned.
  const target = pat.includes('?') ? u : u.split('?')[0];
  // Escape all regex special chars except *, then convert * → one path segment
  const escaped = pat
    .replace(/[.+?^${}()|[\]\\]/g, c => '\\' + c)
    .replace(/\*/g, '[^/?#]+');
  try { return new RegExp('^' + escaped + '(/.*)?$').test(target); }
  catch (_) { return false; }
}

/** The key `url`'s highlights go under: the first pattern it matches, else the URL itself. */
export function hlNormalizeUrl(url, patterns) {
  for (const p of patterns) {
    if (hlMatchPattern(url, p)) return p;
  }
  return hlCanonicalUrl(url);
}

/**
 * Re-group stored highlights against a pattern list. hl_v1 is keyed by the
 * *normalized* URL, so adding or removing a pattern moves the key every saved
 * page resolves to. Without this, highlights made on page A vanish the moment a
 * pattern that also covers A is added for page B — the data stays in storage but
 * under a key nothing reads any more. Each entry carries srcUrl (the page it was
 * actually made on), so the whole store can be re-bucketed from scratch. Works
 * for add and remove alike. Legacy entries with no srcUrl fall back to their
 * current key: correct when that key is a plain URL, and a no-op when it is a
 * pattern (a pattern always matches itself), so nothing is ever dropped.
 */
export function hlRegroup(data, nextPatterns) {
  const out = {};
  for (const [key, list] of Object.entries(data || {})) {
    if (!Array.isArray(list) || !list.length) continue;
    for (const h of list) {
      const src = h.srcUrl || key;
      const newKey = hlNormalizeUrl(src, nextPatterns);
      (out[newKey] ||= []).push({ ...h, srcUrl: src });
    }
  }
  // Two buckets can merge into one; drop duplicate ids and keep a stable order.
  for (const key of Object.keys(out)) {
    const seen = new Set();
    out[key] = out[key]
      .filter(h => !seen.has(h.id) && seen.add(h.id))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }
  return out;
}

// What a `set` may change; the text and where it sits stay as they were made.
const EDITABLE = new Set(['color', 'note', 'disabled', 'srcUrl']);
const isId = (v) => typeof v === 'string' && v !== '';
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Whether `ops` is a list of edits HL_EDIT takes, each one of:
 *   { op: 'add', item }        a new highlight (kept once per id)
 *   { op: 'set', id, fields }  color / note / disabled / srcUrl of one
 *   { op: 'remove', id }
 *   { op: 'clear' }            every highlight of the page
 */
export function validHighlightOps(ops) {
  return Array.isArray(ops) && ops.length > 0 && ops.every((o) => {
    if (!isObject(o)) return false;
    switch (o.op) {
      case 'add':    return isObject(o.item) && isId(o.item.id);
      case 'set':    return isId(o.id) && isObject(o.fields) && Object.keys(o.fields).every((k) => EDITABLE.has(k));
      case 'remove': return isId(o.id);
      case 'clear':  return true;
      default:       return false;
    }
  });
}

/** `all` with `ops` (validHighlightOps) applied to the highlights under `url`; a page left empty is dropped. */
export function applyHighlightOps(all, url, ops) {
  let list = Array.isArray(all[url]) ? [...all[url]] : [];
  for (const o of ops) {
    if (o.op === 'add' && !list.some((h) => h.id === o.item.id)) list.push(o.item);
    else if (o.op === 'set') list = list.map((h) => (h.id === o.id ? { ...h, ...o.fields } : h));
    else if (o.op === 'remove') list = list.filter((h) => h.id !== o.id);
    else if (o.op === 'clear') list = [];
  }
  const out = { ...all };
  if (list.length) out[url] = list;
  else delete out[url];
  return out;
}
