/**
 * screenshot/base64.js — bytes to base64 without blowing the call stack.
 */

/* ── Utilities ──────────────────────────────────────────────────────────────── */

/**
 * Convert a Uint8Array to a base64 string.
 *
 * `String.fromCharCode.apply(null, largeArray)` throws a call-stack overflow
 * for arrays larger than ~65 000 elements. Chunking at 8 192 bytes stays well
 * under that limit while still amortising the per-call overhead.
 */
export function uint8ToBase64(u8) {
  const CHUNK = 8192;
  const parts = [];
  for (let i = 0; i < u8.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(''));
}
