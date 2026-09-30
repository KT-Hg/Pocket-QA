/**
 * Switch blocks — pure helpers shared by playback (bg/playback.js), the
 * action-list mutations (background.js) and the popup preview and form.
 *
 * A Switch case that targets the scenario being played (`__self__`) and carries
 * an `endAt` owns the actions `startAt..endAt` (1-based, inclusive): only the
 * matched case's actions run, then playback continues after the block. The
 * block spans from the action right after the Switch to the largest `endAt` of
 * its block cases; `continueAt` (1-based) overrides where playback resumes, and
 * null / absent means "right after the block".
 *
 * A block case whose actions were all deleted, or that was saved as "do
 * nothing", is stored as `{ empty: true }` with no range — it runs nothing and
 * goes straight to `continueAt`.
 *
 * Cases without `endAt` behave exactly as before: an old-style `__self__` case
 * jumps to `startAt` and plays on to the end, a case targeting another scenario
 * plays that scenario from `startAt` to its end.
 *
 * Everything is stored by absolute index. The nested numbering (`1.2.1`) is
 * computed here at render time and never written back.
 *
 * No chrome.* and no DOM here: the module is imported by the service worker,
 * the popup and `node --test`.
 */

export const SWITCH_SELF = '__self__';
/** Number of case colours the popup defines (--sw-c0 … --sw-c4). */
export const CASE_COLORS = 5;

const _int = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/** Case display label: `"admin"` / `default`. */
export function caseLabel(c) {
  return c?.value === '__default__' ? 'default' : `"${c?.value ?? ''}"`;
}

/** A `__self__` case that owns a range (or an emptied one) instead of jumping. */
export function isBlockCase(c) {
  return !!c && c.scenarioId === SWITCH_SELF && (c.empty === true || _int(c.endAt) != null);
}

/** 0-based inclusive range of a non-empty block case, or null. */
export function caseRange(c) {
  if (!isBlockCase(c) || c.empty === true) return null;
  const start = (_int(c.startAt) ?? 1) - 1;
  const end   = _int(c.endAt) - 1;
  return { start, end };
}

/** True when the action is a Switch with at least one block case. */
export function hasBlock(action) {
  return action?.type === 'switch' && Array.isArray(action.cases) && action.cases.some(isBlockCase);
}

/**
 * 0-based index of the last action in the Switch's block (= the Switch itself
 * when every block case is empty). Clamped to the action list.
 */
export function blockEnd(actions, s) {
  const a = actions?.[s];
  let end = s;
  for (const c of (a?.cases || [])) {
    const r = caseRange(c);
    if (r && r.end > end) end = r.end;
  }
  const last = (actions?.length ?? 0) - 1;
  return Math.max(s, Math.min(end, last));
}

/** 0-based index playback resumes at once the Switch's block is done. */
export function continueIndex(actions, s) {
  const explicit = _int(actions?.[s]?.continueAt);
  if (explicit != null && explicit >= 1) return explicit - 1;
  return blockEnd(actions, s) + 1;
}

/* ── Layout ─────────────────────────────────────────────────────────────────── */

/**
 * Describe every action's place in the Switch structure.
 *
 * Returns one entry per index:
 *   role        'normal' | 'switch' | 'member' | 'orphan'
 *               (a Switch nested in a case keeps role 'switch'; its `parent` says where it lives)
 *   displayNo   '1', '1.2.1', '1.?' (orphan: inside a block, in no case)
 *   depth       nesting level, 0 = top
 *   parent      { switchIdx, caseIdx } of the innermost block, caseIdx null for orphans
 *   chain       every enclosing block, outermost first: { switchIdx, caseIdx, start, end, color }
 *   color       case colour index of the innermost case, or null
 *   caseStart   { switchIdx, caseIdx } when this is the first action of that case
 *   blockLast   [switchIdx…] whose block ends on this action
 *   continueOf  [switchIdx…] that resume at this action
 *   block       (block Switches only) { start, end, continueIdx, cases: [...] }
 */
export function getSwitchLayout(actions) {
  const list = Array.isArray(actions) ? actions : [];
  const out = list.map((_, i) => ({
    index: i, role: 'normal', displayNo: String(i + 1), depth: 0,
    parent: null, chain: [], color: null,
    caseStart: null, blockLast: [], continueOf: [], block: null,
  }));

  const place = (i, no, depth, chain) => {
    const e = out[i];
    const inner = chain.length ? chain[chain.length - 1] : null;
    e.displayNo = no;
    e.depth     = depth;
    e.chain     = chain;
    e.parent    = inner ? { switchIdx: inner.switchIdx, caseIdx: inner.caseIdx } : null;
    e.color     = inner?.color ?? null;
    e.role      = list[i]?.type === 'switch' ? 'switch'
                : inner ? (inner.caseIdx == null ? 'orphan' : 'member') : 'normal';
  };

  const walk = (lo, hi, prefix, depth, chain) => {
    let n = 0;
    for (let i = lo; i <= hi;) {
      n++;
      const no = prefix ? `${prefix}.${n}` : String(n);
      place(i, no, depth, chain);
      const a = list[i];
      if (!hasBlock(a)) { i++; continue; }

      const bEnd = Math.min(blockEnd(list, i), hi);
      const orphanChain = [...chain, { switchIdx: i, caseIdx: null, start: i + 1, end: bEnd, color: null }];
      for (let j = i + 1; j <= bEnd; j++) place(j, `${no}.?`, depth + 1, orphanChain);

      const cases = (a.cases || []).map((c, k) => ({
        caseIdx: k, value: c.value, color: k % CASE_COLORS,
        isBlock: isBlockCase(c), empty: c.empty === true,
        start: null, end: null,
      }));
      // Claimed in position order; an overlapping case only gets what is left
      // (validateSwitch reports the overlap).
      const ranged = cases
        .map((cc) => ({ cc, r: caseRange(a.cases[cc.caseIdx]) }))
        .filter((x) => x.r)
        .sort((x, y) => x.r.start - y.r.start);
      let claimed = i;
      for (const { cc, r } of ranged) {
        const s0 = Math.max(r.start, claimed + 1);
        const e0 = Math.min(r.end, bEnd);
        if (s0 > e0) continue;
        cc.start = s0; cc.end = e0;
        walk(s0, e0, `${no}.${cc.caseIdx + 1}`, depth + 1,
          [...chain, { switchIdx: i, caseIdx: cc.caseIdx, start: s0, end: e0, color: cc.color }]);
        out[s0].caseStart = { switchIdx: i, caseIdx: cc.caseIdx };
        claimed = e0;
      }
      out[i].block = { start: i + 1, end: bEnd, continueIdx: continueIndex(list, i), cases };
      i = bEnd + 1;
    }
  };
  walk(0, list.length - 1, '', 0, []);

  out.forEach((e, i) => {
    if (!e.block) return;
    if (e.block.end > i) out[e.block.end].blockLast.push(i);
    const c = e.block.continueIdx;
    if (c >= 0 && c < out.length) out[c].continueOf.push(i);
  });
  return out;
}

/** Innermost enclosing case key: 'top' or '<switchIdx>:<caseIdx|->'. */
function _ctxKey(entry) {
  const p = entry?.parent;
  return p ? `${p.switchIdx}:${p.caseIdx ?? '-'}` : 'top';
}

/* ── Validation ─────────────────────────────────────────────────────────────── */

/**
 * Check one Switch. `errors` make playback stop on the Switch (Retry / Skip /
 * Stop); `warnings` are only shown in the preview.
 *
 * Nothing here can fire for a Switch that has no block and lives in a scenario
 * without blocks — old scenarios keep running exactly as before.
 */
export function validateSwitch(actions, i, layout = null) {
  const errors = [], warnings = [];
  const list = Array.isArray(actions) ? actions : [];
  const a = list[i];
  if (a?.type !== 'switch') return { errors, warnings };
  const lay = layout || getSwitchLayout(list);
  const n = list.length;
  const cases = Array.isArray(a.cases) ? a.cases : [];
  const block = hasBlock(a);

  const ranges = [];
  cases.forEach((c, k) => {
    const lbl = `Case ${caseLabel(c)}`;
    if (isBlockCase(c)) {
      if (c.empty) { warnings.push(`${lbl} has no actions — it does nothing`); return; }
      const start = _int(c.startAt), end = _int(c.endAt);
      if (start == null) { errors.push(`${lbl}: missing start action`); return; }
      if (start - 1 <= i) errors.push(`${lbl}: its range must start after the Switch (#${i + 1})`);
      if (end < start) errors.push(`${lbl}: ends (#${end}) before it starts (#${start})`);
      if (end > n || start > n) errors.push(`${lbl}: range goes past the last action (#${n})`);
      ranges.push({ k, lbl, start: start - 1, end: end - 1 });
      return;
    }
    if (c.scenarioId === SWITCH_SELF) {
      const t = (_int(c.startAt) ?? 1) - 1;
      if (t >= n || t < 0) {
        warnings.push(`${lbl}: action #${t + 1} does not exist`);
      } else if (lay[t] && lay[i] && _ctxKey(lay[t]) !== _ctxKey(lay[i])) {
        errors.push(`${lbl}: jumps into the middle of a Switch block (#${t + 1})`);
      }
      if (block) warnings.push(`${lbl} jumps (old style) while other cases are blocks`);
    }
    if (c.retargeted) warnings.push(`${lbl}: its target action was deleted — now points to the next one`);
  });

  for (let x = 0; x < ranges.length; x++) {
    for (let y = x + 1; y < ranges.length; y++) {
      const p = ranges[x], q = ranges[y];
      if (p.start <= q.end && q.start <= p.end) errors.push(`${p.lbl} and ${q.lbl} overlap`);
    }
  }

  if (block) {
    const bEndRaw = cases.reduce((m, c) => {
      const r = caseRange(c);
      return r && r.end > m ? r.end : m;
    }, i);
    const inner = lay[i]?.chain?.[lay[i].chain.length - 1];
    if (inner && bEndRaw > inner.end) {
      errors.push(`The block runs past the end of its parent case (#${inner.end + 1})`);
    }
    const explicit = _int(a.continueAt);
    if (explicit != null) {
      const c = explicit - 1;
      if (c >= i && c <= bEndRaw) errors.push(`"Continue at" #${explicit} is inside the block`);
      else if (c > n) errors.push(`"Continue at" #${explicit} is past the last action (#${n})`);
      else if (c < i) warnings.push(`"Continue at" #${explicit} jumps backward`);
    }
    const orphans = lay.filter((e) => e.parent && e.parent.switchIdx === i && e.parent.caseIdx == null).length;
    if (orphans) warnings.push(`${orphans} action(s) in the block belong to no case`);
  }
  return { errors, warnings };
}

/**
 * Check a case that plays a range of another scenario. Returns an error
 * string, or null when the range fits `targetActions`.
 */
export function validateExternalCase(c, targetActions) {
  if (!c || c.scenarioId === SWITCH_SELF || !Array.isArray(targetActions)) return null;
  const n = targetActions.length;
  const start = _int(c.startAt) ?? 1;
  const end = _int(c.endAt);
  if (start > n) return `Case ${caseLabel(c)}: target has no action #${start} (only ${n})`;
  if (end != null && end > n) return `Case ${caseLabel(c)}: target has no action #${end} (only ${n})`;
  if (end != null && end < start) return `Case ${caseLabel(c)}: ends (#${end}) before it starts (#${start})`;
  return null;
}

/* ── Playback helpers ───────────────────────────────────────────────────────── */

/**
 * Where a failed Condition lands: skipping `skipCount` actions, a block
 * Switch counts as one action together with its block, and a landing point
 * inside a block the Condition is not part of moves on to that block's
 * `continueAt` (outermost such block first).
 *
 * Returns the 0-based index of the next action to run. Without blocks this is
 * exactly `i + 1 + skipCount`.
 */
export function conditionSkipTarget(actions, i, skipCount, layout = null) {
  const list = Array.isArray(actions) ? actions : [];
  const lay = layout || getSwitchLayout(list);
  let pos = i + 1;
  for (let k = 0; k < skipCount && pos < list.length; k++) pos = _unitNext(list, pos);
  // Leaving the Condition's own case counts too: landing in a sibling case of
  // the same Switch moves on to that Switch's continueAt.
  const own = new Set((lay[i]?.chain || []).map((c) => `${c.switchIdx}:${c.caseIdx}`));
  for (let guard = 0; guard < 50 && pos < list.length; guard++) {
    const outer = (lay[pos]?.chain || []).find((c) => !own.has(`${c.switchIdx}:${c.caseIdx}`));
    if (!outer) break;
    const next = continueIndex(list, outer.switchIdx);
    if (next <= pos) break;
    pos = next;
  }
  return pos;
}

/* ── Condition ranges ──────────────────────────────────────────────────────────
 * A Condition skips its next `skipCount` actions when false, so those are the
 * actions it guards — the ones that run only when it is true. They are stored
 * as a count, not a range: the preview draws them as the Condition's block, and
 * remove / reorder rewrite `skipCount` so the block keeps the same actions.
 * Numbering stays flat.
 *
 * `skipCount` cannot be 0 (older code reads 0 as 1), so a Condition whose last
 * guarded action was dragged out or deleted is marked `{ empty: true }` — like
 * an emptied Switch case — and guards nothing: a false result skips nothing.
 */

/** Where the unit starting at `pos` ends + 1: a block Switch with its block is one unit. */
function _unitNext(list, pos) {
  return hasBlock(list[pos]) ? Math.max(pos + 1, continueIndex(list, pos)) : pos + 1;
}

/** Actions a false Condition skips: `skipCount`, at least 1 — or 0 for an emptied one. */
export function conditionSkip(action) {
  if (action?.empty === true) return 0;
  const n = parseInt(action?.skipCount || action?.conditionSkipCount || 1, 10);
  return Math.max(1, Number.isFinite(n) ? n : 1);
}

/** 0-based index of the last action in the case (or scenario) action `i` lives in. */
function _ownEnd(list, lay, i) {
  const inner = lay[i]?.chain?.[lay[i].chain.length - 1];
  return Math.min(inner ? inner.end : list.length - 1, list.length - 1);
}

/**
 * Last index covered by 1, 2, 3 … units after Condition `i`, up to the end of
 * its own case: `ends[k - 1]` is where a `skipCount` of k stops. The form offers
 * these as "if true, run … through".
 */
export function conditionChoices(actions, i, layout = null) {
  const list = Array.isArray(actions) ? actions : [];
  const lay = layout || getSwitchLayout(list);
  const own = _ownEnd(list, lay, i);
  const ends = [];
  for (let pos = i + 1; pos <= own;) {
    const next = _unitNext(list, pos);
    ends.push(Math.min(next - 1, own));
    pos = next;
  }
  return ends;
}

/**
 * The actions Condition `i` guards, as playback skips them (conditionSkipTarget),
 * cut at the end of the Condition's own case.
 *
 * Returns { start, end, skip, units }: `end < start` when nothing follows.
 *   short  fewer than `skip` units follow — the skip runs off the end
 *   cut    the skip reaches past the end of the Condition's case, where playback
 *          moves on to that Switch's continueAt instead
 */
export function conditionRange(actions, i, layout = null) {
  const list = Array.isArray(actions) ? actions : [];
  const lay = layout || getSwitchLayout(list);
  const skip = conditionSkip(list[i]);
  let pos = i + 1, units = 0;
  while (units < skip && pos < list.length) { pos = _unitNext(list, pos); units++; }
  const own = _ownEnd(list, lay, i);
  const rawEnd = Math.min(pos - 1, list.length - 1);
  return {
    start: i + 1,
    end: Math.min(rawEnd, own),
    skip,
    units,
    short: units < skip && own === list.length - 1,
    cut: rawEnd > own || (units < skip && own < list.length - 1),
  };
}

/**
 * Per action: `conds` — the Conditions guarding it, outermost first — and, on a
 * Condition, its `range` (conditionRange). Ranges that overlap without nesting
 * (an inner Condition reaching past its outer one) are both listed; `past` on
 * the inner range names the outer Condition it overruns.
 */
export function getConditionLayout(actions, layout = null) {
  const list = Array.isArray(actions) ? actions : [];
  const lay = layout || getSwitchLayout(list);
  const out = list.map(() => ({ conds: [], range: null }));
  list.forEach((a, i) => {
    if (a?.type !== 'condition') return;
    const r = conditionRange(list, i, lay);
    out[i].range = r;
    for (let j = r.start; j <= r.end; j++) out[j].conds.push(i);
  });
  out.forEach((e, i) => {
    if (!e.range) return;
    const over = e.conds.find((c) => out[c].range.end < e.range.end);
    if (over != null) e.range.past = over;
  });
  return out;
}

/** True when any action in the list is a Condition guarding at least one action. */
export function anyConditions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  return list.some((a, i) => a?.type === 'condition' && i < list.length - 1);
}

/** Units from `from` up to `to` (inclusive, 0-based). */
function _countUnits(list, from, to) {
  let n = 0;
  for (let pos = from; pos <= to && pos < list.length; pos = _unitNext(list, pos)) n++;
  return n;
}

/**
 * Rewrite `skipCount` so every Condition touched by an edit guards the same
 * actions afterwards. `newPos(old)` → new index or null (removed). With a
 * dragged `unit` (Set of old indices), the unit leaves every Condition it was in
 * and joins those in `joins` (Set of old Condition indices). Conditions the edit
 * did not touch keep their `skipCount`, even an odd one (short / cut).
 */
function _refitConditions(oldList, newList, newPos, { removed = null, unit = null, joins = null } = {}) {
  const lay = getSwitchLayout(oldList);
  const out = [...newList];
  oldList.forEach((a, c) => {
    if (a?.type !== 'condition') return;
    const cNew = newPos(c);
    if (cNew == null || unit?.has(c)) return;
    const r = conditionRange(oldList, c, lay);
    const members = new Set();
    for (let j = r.start; j <= r.end; j++) members.add(j);
    let touched = removed != null && members.has(removed);
    if (unit) {
      for (const j of unit) if (members.delete(j)) touched = true;
      if (joins?.has(c)) { for (const j of unit) members.add(j); touched = true; }
    }
    if (!touched) return;
    const ps = [...members].map(newPos).filter((p) => p != null);
    if (!ps.length) {
      // Its last guarded action left: the Condition now guards nothing.
      if (a.empty !== true) out[cNew] = { ...out[cNew], empty: true };
      return;
    }
    const want = _countUnits(newList, cNew + 1, Math.max(...ps));
    if (want < 1 || want === conditionSkip(a)) return;
    const next = { ...out[cNew], skipCount: want };
    delete next.empty;
    out[cNew] = next;
  });
  return out;
}

/**
 * Resuming at `fromIndex` (tab reload): finish the case the checkpoint sits in,
 * then go on at each enclosing Switch's `continueAt`, innermost first.
 *
 * Returns the segments to play in order: [{ start, end }] (0-based, inclusive;
 * `end` null = to the end of the scenario). Without blocks: one segment.
 */
export function resumeSegments(actions, fromIndex, layout = null) {
  const list = Array.isArray(actions) ? actions : [];
  const lay = layout || getSwitchLayout(list);
  const chain = lay[fromIndex]?.chain || [];
  const segs = [];
  let pos = fromIndex;
  for (let d = chain.length - 1; d >= 0; d--) {
    const ctx = chain[d];
    if (pos > ctx.end) continue;
    if (pos >= ctx.start) segs.push({ start: pos, end: ctx.end });
    pos = continueIndex(list, ctx.switchIdx);
  }
  segs.push({ start: pos, end: null });
  return segs;
}

/* ── Remapping after list edits ─────────────────────────────────────────────── */

/**
 * The action list after removing `removedIdx`, with every Switch reference in
 * this scenario shifted to match:
 *   - block ranges before the removed action move up, ranges containing it shrink;
 *     a case left with nothing becomes `{ empty: true }`;
 *   - old-style `startAt` and an explicit `continueAt` follow their action; when
 *     that action is the one removed they point at the next one (`retargeted`).
 * Cases that target another scenario are left alone. A Condition that guarded
 * the removed action guards one action less (see _refitConditions).
 */
export function remapAfterRemove(actions, removedIdx) {
  const list = Array.isArray(actions) ? actions : [];
  const r1 = removedIdx + 1;
  const shiftRef = (n) => (n > r1 ? n - 1 : n);
  const next = list.filter((_, i) => i !== removedIdx).map((a) => {
    if (a?.type !== 'switch' || !Array.isArray(a.cases)) return a;
    let touched = false;
    const cases = a.cases.map((c) => {
      if (c?.scenarioId !== SWITCH_SELF) return c;
      if (isBlockCase(c)) {
        if (c.empty) return c;
        let s = _int(c.startAt) ?? 1, e = _int(c.endAt);
        if (r1 > e) return c;
        touched = true;
        if (r1 < s) { s--; e--; } else { e--; }
        const next = { ...c };
        if (e < s) {
          delete next.startAt; delete next.endAt;
          next.empty = true;
        } else {
          next.startAt = s; next.endAt = e;
        }
        return next;
      }
      const s = _int(c.startAt) ?? 1;
      if (s < r1) return c;
      touched = true;
      const next = { ...c, startAt: shiftRef(s) };
      if (s === r1) next.retargeted = true;
      return next;
    });
    const ca = _int(a.continueAt);
    if (!touched && !(ca != null && ca >= r1)) return a;
    const out = { ...a, cases };
    if (ca != null && ca >= r1) out.continueAt = shiftRef(ca);
    return out;
  });
  const newPos = (j) => (j === removedIdx ? null : j > removedIdx ? j - 1 : j);
  return _refitConditions(list, next, newPos, { removed: removedIdx });
}

/**
 * The action list reordered by `newOrder` (new position → old index), with the
 * Switch references rewritten.
 *
 * Block membership is what is preserved: every action stays in the case it was
 * in, except the moved unit (`move.items`, old indices — a Switch travels with
 * its whole block) which leaves its old cases and joins `move.target`
 * ({ switchIdx, caseIdx } in old indices; caseIdx null = in the block but in no
 * case; null target = top level). Each case's new range is the span of its
 * members; old-style `startAt` and an explicit `continueAt` follow their action.
 *
 * Conditions likewise keep the actions they guard: the moved unit leaves the
 * Conditions it was in and joins `move.joins` (old Condition indices), and
 * `skipCount` is rewritten to match.
 */
export function remapAfterReorder(actions, newOrder, move = null) {
  const list = Array.isArray(actions) ? actions : [];
  const lay = getSwitchLayout(list);
  const newPos = new Array(list.length);
  newOrder.forEach((o, p) => { newPos[o] = p; });

  const members = new Map(); // "s:k" → Set(old idx)
  const key = (s, k) => `${s}:${k}`;
  const add = (s, k, j) => {
    const kk = key(s, k);
    if (!members.has(kk)) members.set(kk, new Set());
    members.get(kk).add(j);
  };
  lay.forEach((e, j) => {
    for (const c of e.chain) if (c.caseIdx != null) add(c.switchIdx, c.caseIdx, j);
  });

  if (move && Array.isArray(move.items) && move.items.length) {
    const unit = new Set(move.items);
    for (const j of unit) {
      for (const c of lay[j].chain) {
        if (c.caseIdx != null && !unit.has(c.switchIdx)) members.get(key(c.switchIdx, c.caseIdx))?.delete(j);
      }
    }
    const t = move.target;
    if (t && !unit.has(t.switchIdx) && lay[t.switchIdx]) {
      const targets = lay[t.switchIdx].chain.filter((c) => c.caseIdx != null).map((c) => [c.switchIdx, c.caseIdx]);
      if (t.caseIdx != null) targets.push([t.switchIdx, t.caseIdx]);
      for (const [s, k] of targets) for (const j of unit) add(s, k, j);
    }
  }

  const mapRef = (n1) => {
    const o = n1 - 1;
    return o >= 0 && o < list.length ? newPos[o] + 1 : n1;
  };

  const next = newOrder.map((o) => {
    const a = list[o];
    if (a?.type !== 'switch' || !Array.isArray(a.cases)) return a;
    let changed = false;
    const cases = a.cases.map((c, k) => {
      if (c?.scenarioId !== SWITCH_SELF) return c;
      if (isBlockCase(c)) {
        const set = members.get(key(o, k));
        if (!set || !set.size) {
          if (c.empty) return c;
          changed = true;
          const next = { ...c, empty: true };
          delete next.startAt; delete next.endAt;
          return next;
        }
        const ps = [...set].map((j) => newPos[j]);
        const s = Math.min(...ps) + 1, e = Math.max(...ps) + 1;
        if (!c.empty && _int(c.startAt) === s && _int(c.endAt) === e) return c;
        changed = true;
        const next = { ...c, startAt: s, endAt: e };
        delete next.empty;
        return next;
      }
      const s = _int(c.startAt) ?? 1;
      const m = mapRef(s);
      if (m === s) return c;
      changed = true;
      return { ...c, startAt: m };
    });
    const ca = _int(a.continueAt);
    const caNew = ca != null ? mapRef(ca) : null;
    if (!changed && caNew === ca) return a;
    const out = { ...a, cases };
    if (ca != null) out.continueAt = caNew;
    return out;
  });
  // Without a move nothing says who left or joined: Conditions keep their count.
  if (!move || !Array.isArray(move.items) || !move.items.length) return next;
  const joins = new Set((Array.isArray(move.joins) ? move.joins : []).filter((j) => Number.isInteger(j)));
  return _refitConditions(list, next, (j) => newPos[j], { unit: new Set(move.items), joins });
}

/**
 * Turn a drag-and-drop in the preview into a reorder.
 *
 * `dragged` is the old index of the dragged action (a block Switch drags its
 * whole block). `anchor` says where it was dropped:
 *   { kind: 'top' }                              before everything
 *   { kind: 'after', index }                     after an action row (joins that action's case;
 *                                                 after an expanded block Switch: the start of its first case)
 *   { kind: 'afterCollapsed', switchIdx }        after a collapsed block Switch: after its block
 *   { kind: 'caseHead', switchIdx, caseIdx }     on a case header: start of that case
 *   { kind: 'outside', switchIdx }               on the "out of the block" zone: after the block
 *   { kind: 'afterCollapsedCond', condIdx }      after a collapsed Condition: after what it guards
 *   { kind: 'outsideCond', condIdx }             on the "out of the If" zone: after what it guards
 *
 * A Condition drags the actions it guards along. The dropped unit joins every
 * Condition guarding the row it lands after (and, dropped right after an
 * expanded Condition, that Condition itself) — `move.joins`.
 *
 * Returns { newOrder, move, actions } or null when nothing changes.
 */
export function planDrop(actions, dragged, anchor) {
  const list = Array.isArray(actions) ? actions : [];
  if (!(dragged >= 0 && dragged < list.length) || !anchor) return null;
  const lay = getSwitchLayout(list);
  const cl = getConditionLayout(list, lay);
  const unitEnd = hasBlock(list[dragged]) ? (lay[dragged].block?.end ?? dragged)
    : cl[dragged].range ? Math.max(dragged, cl[dragged].range.end)
    : dragged;
  const unit = [];
  for (let j = dragged; j <= unitEnd; j++) unit.push(j);
  const inUnit = (j) => j >= dragged && j <= unitEnd;

  const parentOf = (s) => {
    const inner = lay[s]?.chain?.[lay[s].chain.length - 1];
    return inner ? { switchIdx: inner.switchIdx, caseIdx: inner.caseIdx } : null;
  };
  const afterBlock = (s) => (lay[s].block ? lay[s].block.end + 1 : s + 1);
  const guarding = (j) => cl[j].conds;

  let insertBefore, target, joins = [];
  switch (anchor.kind) {
    case 'top':
      insertBefore = 0; target = null; break;
    case 'after': {
      const j = anchor.index;
      if (!(j >= 0 && j < list.length) || inUnit(j)) return null;
      const b = lay[j].block;
      joins = guarding(j);
      if (b) {
        const first = b.cases.filter((c) => c.start != null).sort((x, y) => x.start - y.start)[0]
          || b.cases.find((c) => c.isBlock);
        if (first) {
          insertBefore = first.start != null ? first.start : j + 1;
          target = { switchIdx: j, caseIdx: first.caseIdx };
          break;
        }
      }
      insertBefore = j + 1; target = lay[j].parent;
      // Right after an expanded Condition: the first action it guards.
      if (cl[j].range) joins = [...joins, j];
      break;
    }
    case 'afterCollapsed':
    case 'outside': {
      const s = anchor.switchIdx;
      if (!lay[s]?.block || inUnit(s)) return null;
      insertBefore = afterBlock(s); target = parentOf(s); joins = guarding(s);
      break;
    }
    case 'afterCollapsedCond':
    case 'outsideCond': {
      const c = anchor.condIdx;
      const r = cl[c]?.range;
      if (!r || inUnit(c)) return null;
      insertBefore = Math.max(c + 1, r.end + 1); target = parentOf(c); joins = guarding(c);
      break;
    }
    case 'caseHead': {
      const s = anchor.switchIdx;
      const cc = lay[s]?.block?.cases?.[anchor.caseIdx];
      if (!cc || inUnit(s)) return null;
      insertBefore = cc.start != null ? cc.start : afterBlock(s);
      target = { switchIdx: s, caseIdx: anchor.caseIdx };
      joins = guarding(s);
      break;
    }
    default:
      return null;
  }
  if (target && inUnit(target.switchIdx)) return null;

  const rest = [];
  for (let j = 0; j < list.length; j++) if (!inUnit(j)) rest.push(j);
  let at = rest.findIndex((j) => j >= insertBefore);
  if (at < 0) at = rest.length;
  const newOrder = [...rest.slice(0, at), ...unit, ...rest.slice(at)];
  const move = { items: unit, target, joins: joins.filter((c) => !inUnit(c)) };
  const next = remapAfterReorder(list, newOrder, move);
  const same = newOrder.every((o, p) => o === p) && JSON.stringify(next) === JSON.stringify(list);
  if (same) return null;
  return { newOrder, move, actions: next };
}

/** True when any action in the list is a block Switch. */
export function anyBlocks(actions) {
  return (Array.isArray(actions) ? actions : []).some(hasBlock);
}
