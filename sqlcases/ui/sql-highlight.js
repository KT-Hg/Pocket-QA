/**
 * ui/sql-highlight.js — SQL syntax colouring for the inspector and the diff.
 */

import { node } from './dom.js';

/**
 * Colour one block of SQL for display.
 *
 * Comments and strings come first so a keyword inside either stays plain, and
 * the result is a fragment of spans rather than a string of markup: the text
 * is the user's own query, and the whole point of building nodes elsewhere in
 * this file would be lost if the one place that shows the query verbatim
 * handed it to innerHTML.
 */
const SQL_TOKEN = new RegExp([
  /(--[^\n]*)/,                                        // 1 comment
  /('(?:[^']|'')*')/,                                  // 2 string
  /(:[A-Za-z_]\w*|\?)/,                                // 3 bind parameter
  /\b(SELECT|FROM|WHERE|GROUP|ORDER|BY|HAVING|LEFT|RIGHT|FULL|INNER|CROSS|OUTER|JOIN|ON|AND|OR|NOT|IN|IS|NULL|BETWEEN|LIKE|AS|LIMIT|OFFSET|DESC|ASC|DISTINCT|COUNT|SUM|AVG|MIN|MAX|COALESCE|CASE|WHEN|THEN|ELSE|END|UPDATE|SET|INSERT|INTO|VALUES|DELETE|EXISTS|UNION|ALL|WITH|NULLS|FIRST|LAST|TRUE|FALSE|UNKNOWN)\b/,
  /\b(\d+(?:\.\d+)?)\b/                                // 5 number
].map(r => r.source).join('|'), 'gi');

/** The class of a SQL_TOKEN match: comment, string, parameter, keyword, number. */
function tokenClass(m) {
  if (m[1]) return 'c';
  if (m[2]) return 's';
  if (m[3]) return 'p';
  if (m[4]) return 'k';
  return 'n';
}

export function sqlHighlight(text) {
  const frag = document.createDocumentFragment();
  const re = new RegExp(SQL_TOKEN.source, 'gi');
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
    const cls = tokenClass(m);
    frag.append(node('span', cls, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  return frag;
}
