/**
 * run.js — one turn of a test case: send it, check the response, take the
 * values it saves into variables, come to a verdict. Send in the editor goes
 * through runCase(), and so will running a folder, so the two cannot disagree.
 *
 * The verdict is shared/verdict.js's: a false check is ✗ Failed; a request that
 * got no response, a check that could not run or a value that could not be
 * found is ⚠ Broken; the first failure decides. Writing the saved values into
 * the environment is the caller's: runCase() only says what they are.
 *
 * runAll() runs many, one after another; lastOf() is what is kept of a result
 * once the page is closed.
 *
 * Pure apart from sending, which is passed in (sendRequest by default), so the
 * tests run it without a network.
 */

import { MASK, buildRequest, isSecretName, maskUrl, sendRequest } from '../shared/api-request.js';
import { extractValues, runChecks } from '../shared/api-response.js';
import { runVerdict } from '../shared/verdict.js';

/**
 * { res, checks, saved, problems, failures, verdict }: the response (or
 * { error }), each check's result, the values to save ({ name: text }) and the
 * ones that could not be found, the failures as shared/verdict.js counts them
 * ({ kind, reason }), and 'passed' | 'failed' | 'broken'.
 */
export async function runCase(c, vars, send = sendRequest) {
  const res = await send(c, vars);
  if (res.error) {
    const failures = [{ kind: 'broken', reason: res.error }];
    return { res, checks: [], saved: {}, problems: [], failures, verdict: runVerdict(failures, { completed: true }).status };
  }
  const checks = runChecks(res, c.checks, vars);
  const { values: saved, problems } = extractValues(res, c.extracts);
  const failures = [
    ...checks.filter((r) => !r.ok).map((r) => ({ kind: r.kind, reason: r.message })),
    ...problems.map((p) => ({ kind: 'broken', reason: `Could not save ${p.varName || 'a value'}: ${p.reason}` })),
  ];
  return { res, checks, saved, problems, failures, verdict: runVerdict(failures, { completed: true }).status };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `cases` (as sent: requestOf) one after another. Each is sent with the
 * variables `getVars()` gives just before it, so a value the one before saved
 * (login → ${token}) is in them; `onResult(c, result)` is awaited before the
 * next starts. Once `shouldStop()` is true no other is sent — the one on its
 * way finishes. Resolves to the number sent.
 */
export async function runAll(cases, { getVars, onResult, send = sendRequest, delayMs = 0, shouldStop = () => false, wait = sleep }) {
  let n = 0;
  for (const c of cases) {
    if (n && delayMs > 0) await wait(delayMs);
    if (shouldStop()) break;
    const result = await runCase(c, await getVars(), send);
    n++;
    await onResult(c, result);
  }
  return n;
}

const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * "Send 4 POST, 1 DELETE to api.example.com?" for the requests among `cases`
 * that can change data, or '' when there is none. A host is named when the
 * URL can be filled in with `vars`.
 */
export function writePlan(cases, vars = {}) {
  const counts = new Map();
  const hosts = new Set();
  for (const c of cases) {
    if (!WRITES.includes(c.method)) continue;
    counts.set(c.method, (counts.get(c.method) || 0) + 1);
    const built = buildRequest({ method: c.method, url: c.url }, vars);
    if (built.url) hosts.add(new URL(built.url).host);
  }
  if (!counts.size) return '';
  const what = WRITES.filter((m) => counts.has(m)).map((m) => `${counts.get(m)} ${m}`).join(', ');
  return `Send ${what}${hosts.size ? ` to ${[...hosts].join(', ')}` : ''}?`;
}

/** The first characters of a body kept with a result. */
export const BODY_HEAD = 2048;

/** A JSON value with the strings under secret keys (token, password, apiKey…) masked. */
function maskJson(v) {
  if (Array.isArray(v)) return v.map(maskJson);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' && isSecretName(k) ? MASK : maskJson(x)]));
}

function bodyHead(res) {
  if (res.isBinary) return '';
  return (res.isJson ? JSON.stringify(maskJson(res.json), null, 2) : String(res.text || '')).slice(0, BODY_HEAD);
}

/**
 * What a case keeps of a result once the page is closed: { at, verdict,
 * status, ms, failures, bodyHead, sent }. The body is cut to BODY_HEAD, its
 * secret JSON values and the URL's secret query values masked; no header is
 * kept.
 */
export function lastOf(result, at = Date.now()) {
  const { res } = result;
  return {
    at,
    verdict: result.verdict,
    status: res.status ?? null,
    ms: res.ms ?? null,
    failures: result.failures,
    bodyHead: res.error ? '' : bodyHead(res),
    sent: res.sent ? { method: res.sent.method, url: maskUrl(res.sent.url) } : null,
  };
}

/** The last results of `cases` counted: { passed, failed, broken, notRun, at (the latest, 0 for none) }. */
export function runTally(cases) {
  const t = { passed: 0, failed: 0, broken: 0, notRun: 0, at: 0 };
  for (const c of cases) {
    if (!c.last) { t.notRun++; continue; }
    t[c.last.verdict]++;
    t.at = Math.max(t.at, c.last.at || 0);
  }
  return t;
}
