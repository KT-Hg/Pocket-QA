/**
 * ui/var-suggest.js — variable suggestions in the API Tests page's fields,
 * with the popup's own list (popup/ui/var-suggest.js): type ${ (or Ctrl+Space)
 * in a field that takes ${variables} and the names show, each with where it
 * comes from and its value.
 *
 * Names, in the order a request resolves them (apicases/vars.js), so a name
 * both have shows with the value that is sent:
 *   E      the environment in use (a value whose name looks secret is hidden);
 *   S/R/P/F the Data tab's, with their kind and value;
 *   #      names a case saves from its response, not set yet.
 */

import { extractNames } from '../../shared/api-response.js';
import { normalizeVarName } from '../../shared/var-name.js';
import { variableType } from '../../shared/var-order.js';
import { varValueDetail } from '../../shared/var-suggest.js';
import { attachVarSuggest } from '../../popup/ui/var-suggest.js';
import { activeEnv } from '../model.js';
import { loadDataVars } from '../vars.js';

const SECRET = /token|secret|pass|key|auth|cookie|session/i;

/** [{ name, kind, detail }] for the page in `state`: environment, Data tab, saved by a case. */
export async function varEntries(state) {
  const out = [];
  const env = activeEnv(state);
  for (const v of env.vars) {
    const name = normalizeVarName(v.name);
    if (name) out.push({ name, kind: 'e', detail: { text: `${env.name}: ${SECRET.test(name) ? '••••' : v.value || '(empty)'}` } });
  }
  for (const [name, v] of Object.entries(await loadDataVars())) {
    out.push({ name, kind: variableType(v), detail: varValueDetail(v) });
  }
  for (const c of state.cases) {
    for (const x of c.extracts || []) {
      for (const name of extractNames(x)) out.push({ name, kind: 'w', detail: { text: `saved by ${c.name}` } });
    }
  }
  return out;
}

/**
 * Suggestions on `el`. `mode` 'ref' (the default): a field of text with
 * ${name} in it; 'name': a field that takes a bare variable name. `getValues`
 * (a 'ref' field): plain values offered away from a ${, e.g. a header's.
 */
export function suggestVars(el, app, mode = 'ref', getValues = undefined) {
  attachVarSuggest(el, { mode, getEntries: () => varEntries(app.state), getValues });
  return el;
}
