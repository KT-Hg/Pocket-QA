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
  for (let k = 0; k < skipCount && pos < list.length; k++) {
    pos = hasBlock(list[pos]) ? Math.max(pos + 1, continueIndex(list, pos)) : pos + 1;
  }
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
 * Cases that target another scenario are left alone.
 */
export function remapAfterRemove(actions, removedIdx) {
  const list = Array.isArray(actions) ? actions : [];
  const r1 = removedIdx + 1;
  const shiftRef = (n) => (n > r1 ? n - 1 : n);
  return list.filter((_, i) => i !== removedIdx).map((a) => {
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

  return newOrder.map((o) => {
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
 *
 * Returns { newOrder, move, actions } or null when nothing changes.
 */
export function planDrop(actions, dragged, anchor) {
  const list = Array.isArray(actions) ? actions : [];
  if (!(dragged >= 0 && dragged < list.length) || !anchor) return null;
  const lay = getSwitchLayout(list);
  const unitEnd = hasBlock(list[dragged]) ? (lay[dragged].block?.end ?? dragged) : dragged;
  const unit = [];
  for (let j = dragged; j <= unitEnd; j++) unit.push(j);
  const inUnit = (j) => j >= dragged && j <= unitEnd;

  const parentOf = (s) => {
    const inner = lay[s]?.chain?.[lay[s].chain.length - 1];
    return inner ? { switchIdx: inner.switchIdx, caseIdx: inner.caseIdx } : null;
  };
  const afterBlock = (s) => (lay[s].block ? lay[s].block.end + 1 : s + 1);

  let insertBefore, target;
  switch (anchor.kind) {
    case 'top':
      insertBefore = 0; target = null; break;
    case 'after': {
      const j = anchor.index;
      if (!(j >= 0 && j < list.length) || inUnit(j)) return null;
      const b = lay[j].block;
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
      break;
    }
    case 'afterCollapsed':
    case 'outside': {
      const s = anchor.switchIdx;
      if (!lay[s]?.block || inUnit(s)) return null;
      insertBefore = afterBlock(s); target = parentOf(s);
      break;
    }
    case 'caseHead': {
      const s = anchor.switchIdx;
      const cc = lay[s]?.block?.cases?.[anchor.caseIdx];
      if (!cc || inUnit(s)) return null;
      insertBefore = cc.start != null ? cc.start : afterBlock(s);
      target = { switchIdx: s, caseIdx: anchor.caseIdx };
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
  const move = { items: unit, target };
  const next = remapAfterReorder(list, newOrder, move);
  const same = newOrder.every((o, p) => o === p) && JSON.stringify(next) === JSON.stringify(list);
  if (same) return null;
  return { newOrder, move, actions: next };
}

/** True when any action in the list is a block Switch. */
export function anyBlocks(actions) {
  return (Array.isArray(actions) ? actions : []).some(hasBlock);
}
