/**
 * export/test-data-code.js — a Random test-data variable (shared/test-data.js) in
 * exported code: drawn by the same rules a run draws it, from the same lists.
 *
 *   jsTestDataFn      a JS function expression (Bookmarklet, Playwright)
 *   pyTestDataExpr    a Python expression (Selenium; Robot through Evaluate, `robot`)
 *   javaTestDataArgs  the arguments of the Java export's testData(kind, args…)
 *
 * Pure — no chrome.*.
 */

import { EMAIL_CHARS, EMAIL_LENGTH, EMAIL_LOCAL, PHONE_PREFIXES, nameParts } from '../../shared/test-data.js';

const q = (s) => JSON.stringify(String(s));
const pyFormat = (format) => format.replace(/yyyy|MM|dd/g, (t) => ({ dd: '%d', MM: '%m', yyyy: '%Y' })[t]);

/** A JS function expression drawing a value of `spec`, as resolveRandomVars does. */
export function jsTestDataFn(spec) {
  const one = (list) => `${list}[Math.floor(Math.random()*${list}.length)]`;
  switch (spec.type) {
    case 'email':
      return `() => ${q(EMAIL_LOCAL)} + Array.from({length:${EMAIL_LENGTH}},()=>${one(q(EMAIL_CHARS))}).join('') + '@' + ${q(spec.domain)}`;
    case 'phone':
      return `() => ${one(JSON.stringify(PHONE_PREFIXES))} + Array.from({length:8},()=>String(Math.floor(Math.random()*10))).join('')`;
    case 'name':
      return `() => ${JSON.stringify(nameParts(spec.lang))}.map((l) => ${one('l')}).join(' ')`;
    case 'int':
      return `() => String(${spec.min} + Math.floor(Math.random()*${spec.max - spec.min + 1}))`;
    case 'date':
      return `() => { const d = new Date(); d.setDate(d.getDate() + (${spec.days})); const p = (n) => String(n).padStart(2, '0'); `
        + `return ${q(spec.format)}.replace(/yyyy|MM|dd/g, (t) => ({ dd: p(d.getDate()), MM: p(d.getMonth() + 1), yyyy: String(d.getFullYear()) })[t]); }`;
    case 'uuid':
      return "() => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.floor(Math.random() * 16); "
        + "return (c === 'x' ? r : 8 + (r % 4)).toString(16); })";
    default:
      return "() => ''";
  }
}

/**
 * A Python expression drawing a value of `spec`. Selenium imports `random`,
 * `string`, `datetime` / `timedelta` (from datetime) and `uuid`; Robot's Evaluate
 * (`robot`) imports the modules it names, so it says datetime.datetime.
 */
export function pyTestDataExpr(spec, { robot = false } = {}) {
  switch (spec.type) {
    case 'email':
      return `${q(EMAIL_LOCAL)} + ''.join(random.choices(${q(EMAIL_CHARS)}, k=${EMAIL_LENGTH})) + '@' + ${q(spec.domain)}`;
    case 'phone':
      return `random.choice(${JSON.stringify(PHONE_PREFIXES)}) + ''.join(random.choices(string.digits, k=8))`;
    case 'name':
      return `' '.join(random.choice(part) for part in ${JSON.stringify(nameParts(spec.lang))})`;
    case 'int':
      return `str(random.randint(${spec.min}, ${spec.max}))`;
    case 'date': {
      const now = robot ? 'datetime.datetime.now()' : 'datetime.now()';
      const days = robot ? 'datetime.timedelta' : 'timedelta';
      return `(${now} + ${days}(days=${spec.days})).strftime(${q(pyFormat(spec.format))})`;
    }
    case 'uuid':
      return 'str(uuid.uuid4())';
    default:
      return "''";
  }
}

/** What the Python export imports for the test-data specs it uses. */
export function pyTestDataImports(specs) {
  const kinds = new Set(specs.map((s) => s.type));
  return { date: kinds.has('date'), uuid: kinds.has('uuid') };
}

/** testData(kind, args…) of the Java export: the kind, then its arguments as strings. */
export function javaTestDataArgs(spec) {
  switch (spec.type) {
    case 'email': return ['email', spec.domain];
    case 'int': return ['int', String(spec.min), String(spec.max)];
    case 'date': return ['date', String(spec.days), spec.format];
    case 'name': return ['name', ...nameParts(spec.lang).map((list) => list.join('|'))];
    default: return [spec.type];
  }
}
