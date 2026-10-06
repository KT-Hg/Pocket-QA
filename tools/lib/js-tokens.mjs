/**
 * js-tokens.mjs — a small JavaScript tokenizer for the repo tools.
 *
 * The extension has no build step and no dependencies, and the tools keep it that
 * way: they need to find `import` / `export` statements and string arguments, not
 * a full AST. Skipping comments, strings, template literals and regex literals
 * correctly is what makes a plain regex over the source unreliable — a generated
 * bookmarklet holds code in strings, and URLs in strings contain `//`.
 *
 * Token: { t: 'id' | 'str' | 'tpl' | 'num' | 'punc' | 'regex', v, line }
 *   - 'str' carries the cooked value (escapes are not decoded beyond \' \" \\).
 *   - 'tpl' carries `head`: the text before the first `${` (enough for paths).
 */

const ID_START = /[A-Za-z_$\u0080-￿]/;
const ID_PART = /[A-Za-z0-9_$\u0080-￿]/;

// After these keywords a `/` starts a regex literal, not a division.
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  // Each entry is the brace depth at which a template literal's `${` opened.
  const tplStack = [];
  let braceDepth = 0;

  const prevSignificant = () => tokens[tokens.length - 1];

  const regexAllowed = () => {
    const p = prevSignificant();
    if (!p) return true;
    if (p.t === 'num' || p.t === 'str' || p.t === 'tpl' || p.t === 'regex') return false;
    if (p.t === 'id') return REGEX_AFTER_KEYWORD.has(p.v);
    if (p.t === 'punc') return !(p.v === ')' || p.v === ']' || p.v === '}');
    return true;
  };

  // Scans template text starting at i (just past a backtick or a closing `}`)
  // until the closing backtick or the next `${`.
  const scanTemplate = (startLine, isHead) => {
    let text = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { text += src.slice(i, i + 2); if (src[i + 1] === '\n') line++; i += 2; continue; }
      if (c === '\n') line++;
      if (c === '`') { i++; if (isHead) tokens.push({ t: 'tpl', v: text, head: text, line: startLine }); return; }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        if (isHead) tokens.push({ t: 'tpl', v: text, head: text, line: startLine });
        tplStack.push(braceDepth);
        braceDepth++;
        return;
      }
      text += c;
      i++;
    }
  };

  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '﻿' || c === ' ') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
      i = stop;
      continue;
    }
    if (c === '#' && i === 0 && src[1] === '!') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const startLine = line;
      let v = '';
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          const n = src[i + 1];
          if (n === '\n') line++;
          v += (n === c || n === '\\') ? n : '\\' + n;
          i += 2;
          continue;
        }
        if (src[i] === '\n') line++;
        v += src[i++];
      }
      i++;
      tokens.push({ t: 'str', v, line: startLine });
      continue;
    }
    if (c === '`') {
      i++;
      scanTemplate(line, true);
      continue;
    }
    if (c === '}' && tplStack.length && tplStack[tplStack.length - 1] === braceDepth - 1) {
      // End of a `${ … }` substitution: resume the template body.
      tplStack.pop();
      braceDepth--;
      i++;
      scanTemplate(line, false);
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j])) j++;
      tokens.push({ t: 'id', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      let j = i + 1;
      while (j < src.length && /[0-9A-Za-z_.]/.test(src[j])) j++;
      tokens.push({ t: 'num', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (inClass) { if (d === ']') inClass = false; }
        else if (d === '[') inClass = true;
        else if (d === '/') break;
        j++;
      }
      j++;
      while (j < src.length && /[a-z]/i.test(src[j])) j++;
      tokens.push({ t: 'regex', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (c === '{') braceDepth++;
    if (c === '}') braceDepth--;
    // Multi-char punctuators only matter for `...` and `=>`; the rest can be split.
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ t: 'punc', v: '...', line });
      i += 3;
      continue;
    }
    if (c === '=' && src[i + 1] === '>') {
      tokens.push({ t: 'punc', v: '=>', line });
      i += 2;
      continue;
    }
    tokens.push({ t: 'punc', v: c, line });
    i++;
  }
  return tokens;
}
