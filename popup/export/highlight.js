/**
 * highlight.js — the colours of the export modal's code: the comments, strings
 * and keywords of Python and JavaScript — of Robot Framework its comments, section
 * headers and control words (IF, FOR, END…) — nothing more, with no library (no
 * dependency, no build step). The code is read a character at a time, in or out
 * of a string or comment, so a # or // inside a string stays string and a quote
 * inside a comment stays comment.
 *
 * Only ever pieces of the code's own text come out: joined, each line is the
 * line as it was (tests/export.test.mjs checks it on every golden export).
 */

const KEYWORDS = {
  py: new Set(['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
    'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal',
    'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while', 'with', 'yield']),
  js: new Set(['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do',
    'else', 'export', 'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new',
    'null', 'of', 'return', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while',
    'yield']),
  robot: new Set(['IF', 'ELSE', 'END', 'FOR', 'IN', 'WHILE', 'RETURN', 'BREAK', 'CONTINUE', 'TRY', 'EXCEPT', 'FINALLY', 'VAR']),
};

// What may come before a JS regex literal (else a / divides): an operator or an
// opening bracket, the start of the code, or one of these words.
const BEFORE_REGEX = /^$|^[(,=:[!&|?{};+\-*%<>~^]$|^(return|typeof|case|of|in|void|delete|throw)$/;

const WORD = /[A-Za-z_$][\w$]*/y;
const PY_PREFIX = /^[rRbBuUfF]{1,2}$/;

/**
 * The code in coloured pieces, a list per line: [text, kind], kind 'cmt', 'str',
 * 'kw' or null. `lang` is 'py' for Python, 'robot' for Robot Framework, anything
 * else JavaScript.
 */
export function highlightLines(code, lang) {
  const lines = [[]];
  for (const [text, kind] of tokens(code, { py: pyToken, robot: robotToken }[lang] || jsToken)) {
    text.split('\n').forEach((part, i) => {
      if (i) lines.push([]);
      if (part) lines[lines.length - 1].push([part, kind]);
    });
  }
  return lines;
}

function tokens(code, next) {
  const out = [];
  // JS: for each template literal whose ${…} is open, the { depth inside it; and
  // the last thing in the code proper, after which a / opens a regex or divides.
  const state = { braces: [], prev: '' };
  for (let i = 0; i < code.length;) {
    const [end, kind] = next(code, i, state);
    const text = code.slice(i, end);
    const last = out[out.length - 1];
    if (last && last[1] === kind) last[0] += text; else out.push([text, kind]);
    i = end;
  }
  return out;
}

// A word at `i`: where it ends, and whether it is one of `keywords` (not a property: .default).
function wordAt(code, i, keywords) {
  WORD.lastIndex = i;
  const word = WORD.exec(code)[0];
  return [i + word.length, keywords.has(word) && code[i - 1] !== '.' ? 'kw' : null, word];
}

// The Python piece at `i`: [where it ends, its kind].
function pyToken(code, i) {
  const c = code[i];
  if (c === '#') return [lineEnd(code, i), 'cmt'];
  if (c === '"' || c === "'") return [pyStringEnd(code, i), 'str'];
  if (!/[A-Za-z_]/.test(c)) return [i + 1, null];
  const [end, kind, word] = wordAt(code, i, KEYWORDS.py);
  // f"…", rb'…': the prefix is part of the string.
  if (PY_PREFIX.test(word) && (code[end] === '"' || code[end] === "'")) return [pyStringEnd(code, end), 'str'];
  return [end, kind];
}

/**
 * The Robot Framework piece at `i`: [where it ends, its kind]. Robot has no quotes;
 * a cell starts a line or follows two spaces, and only there is a # a comment
 * (an escaped \# is text) or IF / END… a control word.
 */
function robotToken(code, i) {
  const lineStart = i === 0 || code[i - 1] === '\n';
  if (lineStart && code.startsWith('***', i)) return [lineEnd(code, i), 'kw'];
  if (!lineStart && !(i >= 2 && code.startsWith('  ', i - 2))) return [i + 1, null];
  if (code[i] === '#') return [lineEnd(code, i), 'cmt'];
  if (!/[A-Z]/.test(code[i])) return [i + 1, null];
  const [end, kind] = wordAt(code, i, KEYWORDS.robot);
  return [end, kind];
}

// The JavaScript piece at `i`: [where it ends, its kind]; keeps `state` up to date.
function jsToken(code, i, state) {
  const c = code[i];
  if (code.startsWith('//', i)) return [lineEnd(code, i), 'cmt'];
  if (code.startsWith('/*', i)) {
    const close = code.indexOf('*/', i + 2);
    return [close < 0 ? code.length : close + 2, 'cmt'];
  }
  const value = jsValueEnd(code, i, state);
  if (value) {
    state.prev = 'x';
    return [value, 'str'];
  }
  if (/[A-Za-z_$]/.test(c)) {
    const [end, kind, word] = wordAt(code, i, KEYWORDS.js);
    state.prev = word;
    return [end, kind];
  }
  const { braces } = state;
  if (braces.length && c === '{') braces[braces.length - 1]++;
  else if (braces.length && c === '}') braces[braces.length - 1]--;
  if (!/\s/.test(c)) state.prev = c;
  return [i + 1, null];
}

// The end of the JS string, template literal piece or regex literal at `i`; 0 for none.
function jsValueEnd(code, i, state) {
  const c = code[i];
  if (c === '"' || c === "'") return quoteEnd(code, i);
  const { braces } = state;
  if (c === '`' || (c === '}' && braces[braces.length - 1] === 0)) {
    // A template literal from its start, or from the } that closes one of its ${…}.
    if (c === '}') braces.pop();
    const [end, opensExpr] = templateEnd(code, i + 1);
    if (opensExpr) braces.push(0);
    return end;
  }
  return c === '/' && BEFORE_REGEX.test(state.prev) ? regexEnd(code, i) : 0;
}

const lineEnd = (code, i) => {
  const nl = code.indexOf('\n', i);
  return nl < 0 ? code.length : nl;
};

// The end of a '…' or "…" string at `q`: past its closing quote, or the line's
// end for one left open (no string runs on to the next line by mistake).
function quoteEnd(code, q) {
  for (let j = q + 1; j < code.length; j++) {
    if (code[j] === '\\') j++;
    else if (code[j] === code[q]) return j + 1;
    else if (code[j] === '\n') return j;
  }
  return code.length;
}

// A Python string at `q`: '''…''' and """…""" run over lines.
function pyStringEnd(code, q) {
  const triple = code.substr(q, 3);
  if (triple !== '"""' && triple !== "'''") return quoteEnd(code, q);
  for (let j = q + 3; j < code.length; j++) {
    if (code[j] === '\\') j++;
    else if (code.startsWith(triple, j)) return j + 3;
  }
  return code.length;
}

// A template literal's text from `from`: [where it ends, whether it ends on a ${
// (the code inside comes next) rather than on its closing `].
function templateEnd(code, from) {
  for (let j = from; j < code.length; j++) {
    if (code[j] === '\\') j++;
    else if (code[j] === '`') return [j + 1, false];
    else if (code.startsWith('${', j)) return [j + 2, true];
  }
  return [code.length, false];
}

// The end of a regex literal at `s` (past its flags), or 0 when the line has no
// closing / for it: then the / is not one.
function regexEnd(code, s) {
  let inClass = false;
  for (let j = s + 1; j < code.length && code[j] !== '\n'; j++) {
    if (code[j] === '\\') j++;
    else if (code[j] === '[') inClass = true;
    else if (code[j] === ']') inClass = false;
    else if (code[j] === '/' && !inClass) {
      let end = j + 1;
      while (/[a-z]/.test(code[end] || '')) end++;
      return end;
    }
  }
  return 0;
}
