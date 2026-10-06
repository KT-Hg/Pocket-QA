/**
 * modules.mjs — import / export facts of one source file, read from tokens.
 *
 * Covers the forms this repo uses: `import x from`, `import { a as b } from`,
 * `import * as ns from`, `import 'side-effect'`, `import('literal')`,
 * `export { a, b as c } [from …]`, `export * [as ns] from …`, and exported
 * function / class / const / let / var / default declarations.
 */

import { tokenize } from './js-tokens.mjs';

const STATEMENT_KEYWORDS = new Set([
  'export', 'import', 'const', 'let', 'var', 'function', 'class', 'if', 'for',
  'while', 'do', 'switch', 'try', 'return', 'throw', 'async',
]);

/** Names bound by a destructuring pattern starting at tokens[k] ('{' or '['). */
function patternNames(tokens, k) {
  const names = [];
  const open = tokens[k].v;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let j = k;
  for (; j < tokens.length; j++) {
    const tk = tokens[j];
    if (tk.t === 'punc' && (tk.v === '{' || tk.v === '[' || tk.v === '(')) depth++;
    else if (tk.t === 'punc' && (tk.v === '}' || tk.v === ']' || tk.v === ')')) {
      depth--;
      if (depth === 0 && tk.v === close) break;
    } else if (tk.t === 'id') {
      const next = tokens[j + 1];
      const prev = tokens[j - 1];
      // `{ key: binding }` binds `binding`; `{ a = 1 }` binds `a`; skip default values.
      if (next && next.t === 'punc' && next.v === ':' && open === '{') continue;
      if (prev && prev.t === 'punc' && prev.v === '=') continue;
      names.push(tk.v);
    }
  }
  return { names, end: j };
}

export function analyzeModule(src) {
  const tokens = tokenize(src);
  const imports = [];   // { spec, names: [{ imported, local }], kind: 'static'|'dynamic'|'side', line }
  const exports = new Set();
  const reexports = []; // { spec, names: [{ imported, exported }] | '*', line }
  const strings = [];   // every string literal / template head with its line, for path checks
  const calls = [];     // { callee: 'getURL', arg, line } and { key: 'files', items }

  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    const afterDot = prev && prev.t === 'punc' && prev.v === '.';

    if (tk.t === 'str') strings.push({ v: tk.v, line: tk.line });
    if (tk.t === 'tpl') strings.push({ v: tk.head, line: tk.line, template: true });

    if (tk.t === 'id' && tk.v === 'getURL' && next?.v === '(') {
      const arg = tokens[k + 2];
      if (arg && (arg.t === 'str' || arg.t === 'tpl')) {
        calls.push({ callee: 'getURL', arg: arg.t === 'str' ? arg.v : arg.head, template: arg.t === 'tpl', line: arg.line });
      }
    }
    if (tk.t === 'id' && tk.v === 'files' && next?.v === ':' && tokens[k + 2]?.v === '[') {
      const items = [];
      for (let j = k + 3; j < tokens.length && tokens[j].v !== ']'; j++) {
        if (tokens[j].t === 'str') items.push(tokens[j].v);
      }
      calls.push({ key: 'files', items, line: tk.line });
    }
    // const CONTENT_SCRIPT_FILES = ['…'] — a files list kept in a named constant.
    if (tk.t === 'id' && /_FILES$/.test(tk.v) && next?.v === '=' && tokens[k + 2]?.v === '[') {
      const items = [];
      for (let j = k + 3; j < tokens.length && tokens[j].v !== ']'; j++) {
        if (tokens[j].t === 'str') items.push(tokens[j].v);
      }
      calls.push({ key: 'files', name: tk.v, items, line: tk.line });
    }

    if (tk.t !== 'id' || afterDot) continue;

    if (tk.v === 'import') {
      if (next?.v === '.') continue; // import.meta
      if (next?.v === '(') {
        const arg = tokens[k + 2];
        if (arg?.t === 'str' && tokens[k + 3]?.v === ')') {
          imports.push({ spec: arg.v, names: [], kind: 'dynamic', line: tk.line });
        } else if (arg?.t === 'id' && arg.v === 'chrome') {
          // import(chrome.runtime.getURL('x')) — recorded through the getURL call.
          const g = tokens.slice(k + 2, k + 8).find((t) => t.v === 'getURL');
          const lit = g && tokens[tokens.indexOf(g) + 2];
          if (lit?.t === 'str') imports.push({ spec: lit.v, names: [], kind: 'extension-url', line: tk.line });
        }
        continue;
      }
      if (next?.t === 'str') {
        imports.push({ spec: next.v, names: [], kind: 'side', line: tk.line });
        continue;
      }
      // import <clause> from '<spec>'
      const names = [];
      let j = k + 1;
      for (; j < tokens.length; j++) {
        const t = tokens[j];
        if (t.t === 'id' && t.v === 'from' && tokens[j + 1]?.t === 'str') break;
        if (t.t === 'id' && j === k + 1) names.push({ imported: 'default', local: t.v });
        if (t.t === 'punc' && t.v === '*') {
          names.push({ imported: '*', local: tokens[j + 2]?.v });
          j += 2;
        }
        if (t.t === 'punc' && t.v === '{') {
          j++;
          while (j < tokens.length && tokens[j].v !== '}') {
            const a = tokens[j];
            if (a.t === 'id' || a.t === 'str') {
              if (tokens[j + 1]?.v === 'as') {
                names.push({ imported: a.v, local: tokens[j + 2].v });
                j += 3;
              } else {
                names.push({ imported: a.v, local: a.v });
                j++;
              }
            } else j++;
          }
        }
      }
      if (j < tokens.length) imports.push({ spec: tokens[j + 1].v, names, kind: 'static', line: tk.line });
      continue;
    }

    if (tk.v === 'export') {
      if (next?.v === 'default') { exports.add('default'); continue; }
      if (next?.v === '*') {
        // export * from 'x'  |  export * as ns from 'x'
        if (tokens[k + 2]?.v === 'as') {
          exports.add(tokens[k + 3].v);
          reexports.push({ spec: tokens[k + 5].v, names: [{ imported: '*', exported: tokens[k + 3].v }], line: tk.line });
        } else {
          reexports.push({ spec: tokens[k + 3].v, names: '*', line: tk.line });
        }
        continue;
      }
      if (next?.v === '{') {
        const list = [];
        let j = k + 2;
        while (j < tokens.length && tokens[j].v !== '}') {
          const a = tokens[j];
          if (a.t === 'id') {
            if (tokens[j + 1]?.v === 'as') {
              list.push({ imported: a.v, exported: tokens[j + 2].v });
              j += 3;
            } else {
              list.push({ imported: a.v, exported: a.v });
              j++;
            }
          } else j++;
        }
        for (const n of list) exports.add(n.exported);
        if (tokens[j + 1]?.v === 'from') reexports.push({ spec: tokens[j + 2].v, names: list, line: tk.line });
        continue;
      }
      let j = k + 1;
      if (tokens[j]?.v === 'async') j++;
      if (tokens[j]?.v === 'function') {
        j++;
        if (tokens[j]?.v === '*') j++;
        exports.add(tokens[j].v);
        continue;
      }
      if (tokens[j]?.v === 'class') { exports.add(tokens[j + 1].v); continue; }
      if (['const', 'let', 'var'].includes(tokens[j]?.v)) {
        j++;
        // One or more declarators: name = init, name2 = init2 …
        for (;;) {
          const t = tokens[j];
          if (!t) break;
          if (t.t === 'punc' && (t.v === '{' || t.v === '[')) {
            const p = patternNames(tokens, j);
            p.names.forEach((n) => exports.add(n));
            j = p.end + 1;
          } else if (t.t === 'id') {
            exports.add(t.v);
            j++;
          }
          // Skip the initializer up to a top-level comma (another declarator) or the end.
          let depth = 0;
          let more = false;
          for (; j < tokens.length; j++) {
            const u = tokens[j];
            if (u.t === 'punc' && '([{'.includes(u.v)) depth++;
            else if (u.t === 'punc' && ')]}'.includes(u.v)) { if (depth === 0) break; depth--; }
            else if (depth === 0 && u.t === 'punc' && u.v === ';') break;
            else if (depth === 0 && u.t === 'punc' && u.v === ',') { more = true; j++; break; }
            else if (depth === 0 && u.t === 'id' && STATEMENT_KEYWORDS.has(u.v) && j > k + 3) break;
          }
          if (!more) break;
        }
        continue;
      }
    }
  }
  return { imports, exports, reexports, strings, calls };
}
