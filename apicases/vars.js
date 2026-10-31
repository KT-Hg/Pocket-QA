/**
 * vars.js — the variables a request is filled with: the Data tab's (shared
 * with every scenario), then the environment in use, which wins on a name both
 * have. Each value is resolved as a playback resolves it: {random:…} and
 * {pick:…} drawn once per send, and {fallback:a|b} taken as its first value,
 * since a request has no page to try the others on.
 */

import { resolveRandomVars } from '../bg/interpolate.js';
import { normalizeVarName, parseListSpec } from '../shared/var-name.js';
import { activeEnv } from './model.js';

/** { name: value } with every spec resolved to a plain value. */
function plainValues(raw) {
  const vars = resolveRandomVars(raw || {});
  for (const [k, v] of Object.entries(vars)) {
    const list = parseListSpec('fallback', v);
    if (list) vars[k] = list.find((x) => x !== '') ?? '';
  }
  return vars;
}

/** An environment's rows as { name: value }; rows with no usable name are left out, a later row wins. */
export function envVarObject(env) {
  const out = {};
  for (const v of env?.vars || []) {
    const n = normalizeVarName(v.name);
    if (n) out[n] = v.value;
  }
  return out;
}

/** The Data tab's variables, then the environment's on top. Pure. */
export function resolveVars(dataVars, envVars) {
  return { ...plainValues(dataVars), ...plainValues(envVars) };
}

/** The Data tab's variables as stored (specs unresolved); {} outside the extension. */
export function loadDataVars() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) resolve({});
    else chrome.storage.local.get('variables', (r) => resolve(r?.variables || {}));
  });
}

/** What a send of the page in `state` fills its ${variables} with. */
export async function varsFor(state) {
  return resolveVars(await loadDataVars(), envVarObject(activeEnv(state)));
}
