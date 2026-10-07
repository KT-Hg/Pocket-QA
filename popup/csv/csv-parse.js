// csv-parse.js — CSV text of a data-driven run into { headers, rows }.

/**
 * The field separator: whichever of comma, semicolon and Tab the header row uses
 * most outside quotes, comma on a tie or when it uses none. Excel in a locale
 * whose decimal mark is a comma (vi-VN, most of Europe) saves "CSV" with
 * semicolons, and a Tab-separated paste is common too.
 */
function _delimiterOf(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuote = false;
  for (const ch of text) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && (ch === '\n' || ch === '\r')) break;
    else if (!inQuote && ch in counts) counts[ch]++;
  }
  return Object.keys(counts).reduce((best, d) => (counts[d] > counts[best] ? d : best), ',');
}

/**
 * Parse CSV text into { headers, rows }.
 *
 * Scans the whole document character by character rather than splitting on
 * newlines first. Splitting first broke any file with a line break inside a
 * quoted field — an Excel export with a multi-line note column turned one record
 * into several, and the fragments were then run as real rows (e.g. a scenario
 * logging in with username "- second line of the note").
 *
 * Follows RFC 4180: fields may be quoted, "" is a literal quote inside a quoted
 * field, and CR/LF inside quotes is data. Whitespace is trimmed only on unquoted
 * fields — a quoted "  001  " keeps its padding, which is the reason to quote it.
 *
 * @returns {{headers: string[], rows: Object<string,string>[]}|null} null when
 *          the file has no header row plus at least one data row.
 */
export function parseCSV(text) {
  if (typeof text !== 'string') return null;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const delimiter = _delimiterOf(text);

  const records = [];
  let record  = [];
  let field   = '';
  let quoted  = false;   // this field was opened with a quote
  let inQuote = false;   // currently inside the quotes
  // Whether the current record has any content at all. Distinguishes a blank line
  // (skipped) from a genuine one-column row holding an empty quoted value.
  let dirty   = false;
  let i       = 0;

  const endField = () => {
    record.push(quoted ? field : field.trim());
    field  = '';
    quoted = false;
  };
  const endRecord = () => {
    endField();
    if (dirty) records.push(record);
    record = [];
    dirty  = false;
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuote = false; i++; }
      } else { field += ch; i++; }
      continue;
    }
    if (ch === '"')       { inQuote = true; quoted = true; dirty = true; i++; }
    else if (ch === delimiter) { endField(); dirty = true; i++; }
    else if (ch === '\r') { i++; if (text[i] === '\n') i++; endRecord(); }
    else if (ch === '\n') { i++; endRecord(); }
    else                  { field += ch; dirty = true; i++; }
  }
  // Trailing record when the file does not end in a newline.
  if (dirty) endRecord();

  if (records.length < 2) return null;

  const headers = records[0];
  const rows = records.slice(1).map((vals) => {
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] ?? ""; });
    return row;
  });
  return { headers, rows };
}
