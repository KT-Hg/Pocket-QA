/**
 * run.js — one turn of a test case: send it, check the response, come to a
 * verdict. Send in the editor goes through runCase(), and so will running a
 * folder, so the two cannot disagree.
 *
 * The verdict is shared/verdict.js's: a false check is ✗ Failed, a request that
 * got no response or a check that could not run is ⚠ Broken, and the first
 * failure decides.
 *
 * Pure apart from sending, which is passed in (sendRequest by default), so the
 * tests run it without a network.
 */

import { sendRequest } from '../shared/api-request.js';
import { runChecks } from '../shared/api-response.js';
import { runVerdict } from '../shared/verdict.js';

/**
 * { res, checks, failures, verdict }: the response (or { error }), each check's
 * result, the failures as shared/verdict.js counts them ({ kind, reason }), and
 * 'passed' | 'failed' | 'broken'.
 */
export async function runCase(c, vars, send = sendRequest) {
  const res = await send(c, vars);
  if (res.error) {
    const failures = [{ kind: 'broken', reason: res.error }];
    return { res, checks: [], failures, verdict: runVerdict(failures, { completed: true }).status };
  }
  const checks = runChecks(res, c.checks, vars);
  const failures = checks.filter((r) => !r.ok).map((r) => ({ kind: r.kind, reason: r.message }));
  return { res, checks, failures, verdict: runVerdict(failures, { completed: true }).status };
}
