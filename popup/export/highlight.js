/**
 * highlight.js — the colours of the export modal's code: the comments, strings
 * and keywords of Python and JavaScript, nothing more, with no library (no
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
};

// What may come before a JS regex literal (else a / divides): an operator or an
// opening bracket, the start of the code, or one of these words.
const BEFORE_REGEX = /^$|^[(,=:[!&|?{};+\-*%<>~^]$|^(return|typeof|case|of|in|void|delete|throw)$/;

const WORD = /[A-Za-z_$][\w$]*/y;
const PY_PREFIX = /^[rRbBuUfF]{1,2}$/;

/**
 * The code in coloured pieces, a list per line: [text, kind], kind 'cmt', 'str',
 * 'kw' or null. `lang` is 'py' for Python, anything else JavaScript.
 */
export function highlightLines(code, lang) {
  const lines = [[]];
  for (const [text, kind] of tokens(code, lang === 'py')) {
    text.split('\n').forEach((part, i) => {
      if (i) lines.push([]);
      if (part) lines[lines.length - 1].push([part, kind]);
    });
  }
  return lines;
}

function tokens(code, py) {
  const out = [];
  const push = (text, kind) => {
    const last = out[out.length - 1];
    if (last && last[1] === kind) last[0] += text; else out.push([text, kind]);
  };
  const keywords = py ? KEYWORDS.py : KEYWORDS.js;
  // JS: for each template literal whose ${…} is open, the { depth inside it.
  const braces = [];
  // The last thing in the code proper: a JS / after it opens a regex or divides.
  let prev = '';
  let i = 0;
  // Push code[i, end) as `kind` and go on from `end`.
  const take = (end, kind) => { push(code.slice(i, end), kind); i = end; };

  while (i < code.length) {
    const c = code[i];
    if (py ? c === '#' : code.startsWith('//', i)) {
      take(lineEnd(code, i), 'cmt');
    } else if (!py && code.startsWith('/*', i)) {
      const close = code.indexOf('*/', i + 2);
      take(close < 0 ? code.length : close + 2, 'cmt');
    } else if (c === '"' || c === "'") {
      take(py ? pyStringEnd(code, i) : quoteEnd(code, i), 'str');
      prev = 'x';
    } else if (!py && (c === '`' || (c === '}' && braces.length && braces[braces.length - 1] === 0))) {
      // A template literal from its start, or from the } that closes one of its ${…}.
      if (c === '}') braces.pop();
      const [end, opensExpr] = templateEnd(code, i + 1);
      if (opensExpr) braces.push(0);
      take(end, 'str');
      prev = 'x';
    } else if (!py && c === '/' && BEFORE_REGEX.test(prev) && regexEnd(code, i) > 0) {
      take(regexEnd(code, i), 'str');
      prev = 'x';
    } else if (/[A-Za-z_$]/.test(c)) {
      WORD.lastIndex = i;
      const word = WORD.exec(code)[0];
      const end = i + word.length;
      if (py && PY_PREFIX.test(word) && (code[end] === '"' || code[end] === "'")) {
        // f"…", rb'…': the prefix is part of the string.
        take(pyStringEnd(code, end), 'str');
        prev = 'x';
        continue;
      }
      take(end, keywords.has(word) && code[i - 1] !== '.' ? 'kw' : null);
      prev = word;
    } else {
      if (!py && braces.length) {
        if (c === '{') braces[braces.length - 1]++;
        else if (c === '}') braces[braces.length - 1]--;
      }
      take(i + 1, null);
      if (!/\s/.test(c)) prev = c;
    }
  }
  return out;
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
