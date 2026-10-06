/**
 * compact.js — the changes to one row, folded into the one statement that takes
 * it straight from where it is to where it has to be.
 *
 * A test that edits a value A → B and then B → C is undone step by step as
 * C → B, then B → A: two statements, two read-backs, two round trips, and a row
 * that briefly holds a value nobody wants. Folded, it is one statement, C → A.
 * A redo folds the same way, A → C.
 *
 * What a row folds to depends only on where it started and where it ended:
 *
 *   existed before · still there   → UPDATE the columns the test wrote
 *   existed before · deleted       → INSERT the row as it was     (redo: DELETE)
 *   inserted       · still there   → DELETE it                     (redo: INSERT as left)
 *   inserted       · deleted       → nothing at all
 *
 * and a row whose columns all ended where they started needs no statement either.
 *
 * Three rules keep that honest.
 *
 * A row is followed by the key it holds *now*: an edit that moved `id` 1 → 2 and a
 * later edit of the row at `id` 2 are one row, undone by one UPDATE that finds it
 * at 2 and sets `id` back to 1.
 *
 * A fold never reaches across a change that is not part of this run. If c2 edited
 * the row between c1 and c3 and only c1 and c3 were picked, folding them would
 * quietly undo c2 as well; the row is split at c2 into two folds instead, and each
 * is undone on its own — which is what the step-by-step rollback would do too.
 *
 * A row that was deleted and then inserted again under the same key is not
 * folded: what that INSERT wrote over is a row the capture never read. Its changes
 * are run one at a time, exactly as the step-by-step rollback runs them.
 *
 * Pure functions over plain objects, like undo.js.
 */

import { buildUpdate, buildInsert, buildDelete, engineOf } from './sqlquote.js';
import {
  blockingReason, redoBlockingReason, undoStatements, redoStatements, undoWhere,
  columnsToRestore, changedColumns, sameValue,
} from './undo.js';
import { changesInPlay } from './summary.js';

const has = (obj, key) => Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);

/** One row's identity: table and key, whatever order the key columns came in. */
function rowId(change, where) {
  const cols = Object.keys(where || {}).sort();
  if (!cols.length) return '';
  const key = cols.map((col) => [col, where[col] === null || where[col] === undefined ? null : String(where[col])]);
  return JSON.stringify([change.schema || '', change.table, key]);
}

function newFold(change, row) {
  return {
    table: change.table,
    schema: change.schema || '',
    start: { ...(row.where || {}) },  // the key the row had when this run first met it
    where: { ...(row.where || {}) },  // the key it holds now
    existed: change.op !== 'insert',
    exists: true,
    written: [],                      // columns an UPDATE wrote, in the order first written
    before: {},                       // each one's value before the first of those writes
    after: {},                        // and after the last, where that was read back
    unknown: new Set(),               // columns whose last write was never read back
    removed: null,                    // the whole row, as a DELETE took it away
    created: null,                    // the whole row, as an INSERT made it and later edits left it
    parts: [],                        // [{ change, row }] in recorded order
    opaque: false,
    createdSeq: 0,
    deletedSeq: 0,
    lastSeq: 0,
  };
}

/** Take one recorded row of one change into the fold for that row. */
function absorb(fold, change, row, dir) {
  // An INSERT into a row this run already knows about — one it deleted — or any
  // write to a row it deleted: the row in between is one nobody read.
  if (fold.parts.length && (change.op === 'insert' || !fold.exists)) fold.opaque = true;
  fold.parts.push({ change, row });
  fold.lastSeq = change.seq;

  if (change.op === 'insert') {
    fold.exists = true;
    fold.created = { ...(row.after || {}) };
    fold.createdSeq = change.seq;
    fold.where = undoWhere(row, change.keyCols);
    return;
  }

  if (change.op === 'delete') {
    fold.exists = false;
    fold.removed = { ...(row.before || {}) };
    fold.deletedSeq = change.seq;
    fold.where = { ...(row.where || {}) };
    return;
  }

  // An UPDATE. The columns are the ones each direction would write on its own:
  // an undo restores what the change names (a statement typed on the SQL page
  // names its columns and never reads them back), a redo writes what it read back.
  const cols = dir === 'redo' ? changedColumns(row) : columnsToRestore(change, row);
  for (const col of cols) {
    if (!fold.written.includes(col)) {
      fold.written.push(col);
      fold.before[col] = row.before[col];
    }
    if (has(row.after, col)) {
      fold.after[col] = row.after[col];
      fold.unknown.delete(col);
      if (fold.created) fold.created[col] = row.after[col];
    } else {
      delete fold.after[col];
      fold.unknown.add(col);
    }
  }
  fold.where = undoWhere(row, change.keyCols);
}

/** What the test did to the row, all told: 'update', 'delete', 'insert', 'none' — or 'steps'. */
function netOf(fold) {
  if (fold.opaque) return 'steps';
  if (fold.existed && fold.exists) return 'update';
  if (fold.existed) return 'delete';
  if (fold.exists) return 'insert';
  return 'none';
}

/**
 * Which change decides where the row goes in the run.
 *
 * The one that created or removed it, when there is one: a child row inserted
 * after its parent has to be deleted before it even if the parent was edited
 * later, and a parent deleted after its child has to be back before the child is.
 * An edited row goes by its last edit, as the step-by-step rollback would.
 */
function pivotOf(fold) {
  switch (netOf(fold)) {
    case 'delete': return fold.deletedSeq;
    case 'insert': return fold.createdSeq;
    default: return fold.lastSeq;
  }
}

/** The statements one folded row comes to. */
function foldStatements(fold, net, engine, dir) {
  const redo = dir === 'redo';
  const { table, schema } = fold;

  if (net === 'update') {
    const sets = {};
    for (const col of fold.written) {
      if (redo) {
        if (fold.unknown.has(col) || sameValue(fold.before[col], fold.after[col])) continue;
        sets[col] = fold.after[col];
      } else {
        // Where the last value was never read back, whether it ended where it
        // started cannot be known — so it is written back regardless.
        if (!fold.unknown.has(col) && sameValue(fold.before[col], fold.after[col])) continue;
        sets[col] = fold.before[col];
      }
    }
    if (!Object.keys(sets).length) return [];
    return [buildUpdate(table, sets, redo ? fold.start : fold.where, engine, schema)];
  }

  if (net === 'delete') {
    if (redo) return [buildDelete(table, fold.start, engine, schema)];
    // The row as the DELETE found it, with every column this run had edited
    // before that put back to the value it had at the start.
    const row = { ...fold.removed };
    for (const col of fold.written) row[col] = fold.before[col];
    return [buildInsert(table, row, engine, schema)];
  }

  if (net === 'insert') {
    if (!redo) return [buildDelete(table, fold.where, engine, schema)];
    return fold.created && Object.keys(fold.created).length ? [buildInsert(table, fold.created, engine, schema)] : [];
  }

  return [];
}

/**
 * What the row should look like right before the fold runs, for the drift check:
 * where to find it, whether it should be there at all, and what the columns this
 * run wrote should hold. An undo expects the row as the test left it; a redo, as
 * the rollback left it — which is how it was before the test.
 */
function foldExpect(fold, net, dir) {
  const redo = dir === 'redo';
  const values = {};
  for (const col of fold.written) {
    if (redo) values[col] = fold.before[col];
    else if (!fold.unknown.has(col)) values[col] = fold.after[col];
  }
  if (net === 'update') return { where: redo ? fold.start : fold.where, present: true, values };
  // The row the undo puts back must not be there already; the one a redo deletes
  // must still be there, as the rollback left it.
  if (net === 'delete') return redo ? { where: fold.start, present: true, values } : { where: fold.start, present: false };
  if (net === 'insert') return redo ? { where: fold.start, present: false } : { where: fold.where, present: true, values };
  return null;
}

/**
 * A write with no key: there is no telling which row it wrote, so every fold
 * open on its table stops here rather than risk folding across it.
 */
function closeFoldsOnTable(open, change) {
  for (const [key, fold] of open) {
    if (fold.table === change.table && fold.schema === (change.schema || '')) open.delete(key);
  }
}

/**
 * The folded run of part or all of a session.
 *
 * Takes the options `runRollback`/`runRedo` take — `changeIds`, `includeUndone`,
 * `includeApplied`, `dir` — and considers exactly the changes they would. Returns:
 *
 *   units    what will run, in order: `{ table, net, parts, statements, expect }`.
 *            A folded row is one unit; a row that could not be folded gives one
 *            unit per change (`net: 'steps'`, with `check` for the drift check).
 *   skipped  `{ change, reason }` for the changes that cannot run at all.
 *   changes  every change that takes part.
 *   steps    how many statements the step-by-step run would send, for comparison.
 */
export function compactPlan(session, opts = {}) {
  const dir = opts.dir === 'redo' ? 'redo' : 'undo';
  const redo = dir === 'redo';
  const engine = engineOf(opts.engine || (session && session.conn && session.conn.driver));

  const skipped = [];
  const taking = new Map();
  for (const change of changesInPlay(session, { ...opts, dir })) {
    const reason = redo ? redoBlockingReason(change) : blockingReason(change);
    if (reason) skipped.push({ change, reason });
    else taking.set(change.id, change);
  }

  // Follow every row through the whole session in recorded order, including the
  // changes this run leaves out: those are where a fold has to stop.
  const open = new Map();
  const folds = [];
  const all = [...((session && session.changes) || [])].sort((a, b) => a.seq - b.seq);
  for (const change of all) {
    const joins = taking.has(change.id);
    for (const row of change.rows || []) {
      const id = rowId(change, row.where);
      if (!joins) {
        if (id) open.delete(id);
        else closeFoldsOnTable(open, change);
        continue;
      }
      let fold = id ? open.get(id) : null;
      if (!fold) {
        fold = newFold(change, row);
        folds.push(fold);
      }
      absorb(fold, change, row, dir);
      if (id) open.delete(id);
      const now = rowId(change, fold.where);
      if (now) open.set(now, fold);
    }
  }

  // A stable sort, so rows that one change touched keep the order it recorded them in.
  const ordered = folds
    .map((fold) => ({ fold, pivot: pivotOf(fold) }))
    .sort((a, b) => (redo ? a.pivot - b.pivot : b.pivot - a.pivot))
    .map((x) => x.fold);

  const units = [];
  for (const fold of ordered) {
    const net = netOf(fold);
    if (net === 'steps') {
      const parts = redo ? fold.parts : [...fold.parts].reverse();
      for (const { change, row } of parts) {
        const one = { ...change, rows: [row] };
        units.push({
          table: fold.table, net, op: change.op, parts: [{ change, row }],
          statements: redo ? redoStatements(one, engine) : undoStatements(one, engine),
          expect: null, check: one,
        });
      }
      continue;
    }
    // Every column back where it started is the same as a row that never changed.
    const statements = foldStatements(fold, net, engine, dir);
    units.push({
      table: fold.table, net: statements.length ? net : 'none', op: net, parts: fold.parts,
      statements,
      expect: statements.length ? foldExpect(fold, net, dir) : null,
      check: null,
    });
  }

  let steps = 0;
  for (const change of taking.values()) {
    steps += (redo ? redoStatements(change, engine) : undoStatements(change, engine)).length;
  }

  return { dir, units, skipped, changes: [...taking.values()], steps };
}

/** Every statement of a plan, in the order it runs. */
export function planStatements(plan) {
  return plan.units.flatMap((unit) => unit.statements);
}

/** The folded undo script for a whole session — what "Export .sql" writes. */
export function compactUndoScript(session) {
  return planStatements(compactPlan(session, { dir: 'undo' }));
}

/**
 * Compare the row as it is now with what the unit expects.
 * `current` is the row read back, or null when it is not there.
 * Returns null when the row is where it should be, else `{ missing | present | diffs }`.
 */
export function unitDrift(unit, current) {
  const want = unit.expect;
  if (!want) return null;
  if (!want.present) return current ? { present: true, diffs: [] } : null;
  if (!current) return { missing: true, diffs: [] };
  const diffs = [];
  for (const [col, expected] of Object.entries(want.values || {})) {
    if (!has(current, col)) continue;
    if (!sameValue(current[col], expected)) diffs.push({ col, expected, actual: current[col] });
  }
  return diffs.length ? { diffs } : null;
}
