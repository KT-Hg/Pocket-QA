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
 * Pure apart from sending, which is passed in (sendRequest by default), so the
 * tests run it without a network.
 */

import { sendRequest } from '../shared/api-request.js';
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
