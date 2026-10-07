/**
 * selftest.mjs — regression guard for the Adminer rollback feature.
 *
 * Run with:  node dbtools/selftest.mjs
 *
 * No framework and no dependencies, same as sqlcases/selftest.mjs.
 *
 * What it is here to catch is a wrong *undo*, because that is the failure with
 * teeth: a rollback that runs cleanly and puts back the wrong value looks like a
 * success and is only noticed later, by someone else. So the assertions below
 * are mostly about the cases where the obvious implementation is subtly wrong —
 * NULL against the empty string, an edit that moved the primary key, a value
 * that merely looks like a number, a predicate that has to be lifted out of the
 * user's own SQL rather than re-rendered from an AST.
 *
 * Anything that needs a live DOM (reading Adminer's edit form, parsing a result
 * grid) is not covered here; those live in adapters/adminer.js behind an
 * `{ ok: false, reason }` contract precisely because they cannot be tested
 * without a browser.
 */

import {
  parseAdminerUrl, buildUrl, editUrl, connKey, connLabel, parseRowIdf, bracketEscape, unbracket,
} from './params.js';
import {
  snapshotSelect, keysSelect, keyOf, keyWhere, newRows, diffSnapshot, diffIsEmpty, restoreStatements,
  backupName, backupCreateSql, backupRestoreSql, backupDropSql,
} from './snapshot.js';
import {
  quoteIdent, quoteValue, quoteTable, whereClause,
  buildUpdate, buildInsert, buildDelete, engineOf, joinStatements,
} from './sqlquote.js';
import {
  undoStatements, undoWhere, blockingReason, changedColumns, columnsToRestore,
  driftOf, sameValue, sessionUndoScript, redoStatements, redoBlockingReason,
} from './undo.js';
import {
  splitStatements, whereText, describeStatement, prefetchSelect, isDestructiveDdl, literalInsertKeys,
} from './sqlcapture.js';
import { keyColsFromDoc } from './adapters/adminer.js';
import * as store from './session.js';
import {
  summaryLines, rowKeyLabel, isSpent, cleanupCandidates, defaultSessionName, changesInPlay, compactSummaryLines,
} from './summary.js';
import { compactPlan, planStatements, compactUndoScript, unitDrift } from './compact.js';
import { CATALOGS, LANGUAGES, setLang, t, missingKeys, clearMissingKeys } from './i18n.js';

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/* ---------------------------------------------------------------------
 * 1. URL shape — the row identity comes from here, so a mistake in this
 *    file targets the wrong row rather than failing loudly.
 * ------------------------------------------------------------------- */
{
  const href = 'https://db.test/adminer.php?server=h1&username=root&db=shop&edit=orders'
    + '&where%5Bid%5D=42&null%5Bnote%5D=';
  const info = parseAdminerUrl(href);

  eq('edit page is recognised', info.page, 'edit');
  eq('the default driver is read from the server parameter', info.conn.driver, 'server');
  eq('and its value is the host', info.conn.server, 'h1');
  eq('table is read from the edit parameter', info.table, 'orders');
  eq('where value survives', info.where.id, '42');
  check('a null key column is null, not an empty string', info.where.note === null,
    JSON.stringify(info.where.note));
  eq('base drops the query string', info.base, 'https://db.test/adminer.php');

  const rebuilt = parseAdminerUrl(editUrl(info.base, info.conn, info.table, info.where));
  check('edit URL round-trips the predicate',
    rebuilt.where.id === '42' && rebuilt.where.note === null, JSON.stringify(rebuilt.where));
  eq('rebuilt URL keeps the connection', rebuilt.conn.db, 'shop');

  eq('select page is recognised',
    parseAdminerUrl('https://db.test/a.php?db=x&select=t').page, 'select');
  eq('an empty sql parameter still means the SQL page',
    parseAdminerUrl('https://db.test/a.php?db=x&sql=').page, 'sql');

  check('two databases on one host are different changesets',
    connKey('https://db.test', { server: 'h', db: 'a' }) !==
    connKey('https://db.test', { server: 'h', db: 'b' }));
  check('the same database over two origins is different too',
    connKey('https://a.test', { server: 'h', db: 'a' }) !==
    connKey('https://b.test', { server: 'h', db: 'a' }));
  check('label names host and database', connLabel({ server: 'h', db: 'shop' }).includes('shop'));

  // Adminer names the driver rather than passing it as a value: `?pgsql=host`,
  // `?sqlite=`, `?server=host` for MySQL. Getting this wrong sends every request
  // to the login screen, which parses perfectly well as "no rows found".
  const pg = parseAdminerUrl('https://db.test/a.php?pgsql=h2&username=postgres&db=shop&ns=public&select=t');
  eq('a non-default driver is read from the parameter name', pg.conn.driver, 'pgsql');
  eq('its value is the server', pg.conn.server, 'h2');
  eq('the schema is kept', pg.conn.ns, 'public');
  check('and it is written back the same way',
    buildUrl(pg.base, pg.conn, { sql: '' }) ===
    'https://db.test/a.php?pgsql=h2&username=postgres&db=shop&ns=public&sql=',
    buildUrl(pg.base, pg.conn, { sql: '' }));

  const lite = parseAdminerUrl('http://127.0.0.1/index.php?sqlite=&username=&db=test.db&sql=');
  eq('an empty driver value still names the driver', lite.conn.driver, 'sqlite');
  eq('an empty server stays empty', lite.conn.server, '');
  eq('sqlite round-trips exactly',
    buildUrl(lite.base, lite.conn, { sql: '' }),
    'http://127.0.0.1/index.php?sqlite=&username=&db=test.db&sql=');

  // A URL with no username must not gain one: it is part of who Adminer thinks
  // we are logged in as.
  const anon = parseAdminerUrl('https://db.test/a.php?server=h&db=d&sql=');
  check('a missing username stays missing', anon.conn.username === null);
  check('and is not invented when rebuilding',
    !buildUrl(anon.base, anon.conn, { sql: '' }).includes('username'),
    buildUrl(anon.base, anon.conn, { sql: '' }));
  check('an empty username is kept as empty',
    buildUrl(lite.base, lite.conn, { sql: '' }).includes('username='));
}

/* ---------------------------------------------------------------------
 * 2. Quoting — per engine. Every value is quoted, numbers too: a form
 *    value carries no column type (see quoteValue).
 * ------------------------------------------------------------------- */
{
  eq('mysql identifier', quoteIdent('a`b', 'mysql'), '`a``b`');
  eq('pgsql identifier', quoteIdent('a"b', 'pgsql'), '"a""b"');
  eq('mssql identifier', quoteIdent('a]b', 'mssql'), '[a]]b]');
  eq('qualified table', quoteTable('t', 'pgsql', 'public'), '"public"."t"');

  eq('mysql escapes a backslash', quoteValue('a\\b', 'mysql'), "'a\\\\b'");
  eq('pgsql leaves a backslash alone', quoteValue('a\\b', 'pgsql'), "'a\\b'");
  eq('a quote is doubled', quoteValue("O'Brien", 'mysql'), "'O''Brien'");
  eq('null is NULL', quoteValue(null, 'mysql'), 'NULL');
  eq('the empty string is not NULL', quoteValue('', 'mysql'), "''");

  eq('an integer is quoted', quoteValue('42', 'mysql'), "'42'");
  eq('a negative decimal is quoted', quoteValue('-7.5', 'pgsql'), "'-7.5'");
  eq('code 007 is quoted', quoteValue('007', 'mysql'), "'007'");
  eq('mssql strings are Unicode', quoteValue('Việt', 'mssql'), "N'Việt'");
  eq('mssql numbers are quoted the same way', quoteValue('42', 'mssql'), "N'42'");
  eq('mssql doubles a quote inside N', quoteValue("O'Brien", 'mssql'), "N'O''Brien'");
  eq('mssql null is NULL', quoteValue(null, 'mssql'), 'NULL');
  eq('no N prefix outside mssql', quoteValue('Việt', 'pgsql'), "'Việt'");

  eq('null in a predicate is IS NULL', whereClause({ a: null }, 'mysql'), '`a` IS NULL');
  eq('empty string in a predicate is an equality', whereClause({ a: '' }, 'mysql'), "`a` = ''");
  eq('an empty map yields no clause', whereClause({}, 'mysql'), '');

  eq('delete takes a limit guard only where it is legal',
    buildDelete('t', { a: '1' }, 'pgsql', '', 1), 'DELETE FROM "t" WHERE "a" = \'1\'');
  check('mysql delete accepts the limit guard',
    buildDelete('t', { a: '1' }, 'mysql', '', 1).endsWith('LIMIT 1'));

  eq('driver names map to a quoting family', engineOf('mariadb'), 'mysql');
  eq('an unknown driver falls back to mysql', engineOf('nonsense'), 'mysql');
  eq('an empty driver means Adminer default', engineOf(''), 'mysql');
  eq('statements are terminated once', joinStatements(['A;', 'B']), 'A;\nB;');
}

/* ---------------------------------------------------------------------
 * 3. Undo generation.
 * ------------------------------------------------------------------- */
{
  const update = {
    op: 'update', table: 'm_generic', keyCols: ['id'],
    rows: [{ where: { id: '42' }, before: { value: 'A', note: null }, after: { value: 'B', note: 'x' } }],
  };
  eq('a plain update is undoable', blockingReason(update), '');
  eq('it restores both columns by the recorded key',
    undoStatements(update, 'mysql')[0],
    "UPDATE `m_generic` SET `value` = 'A', `note` = NULL WHERE `id` = '42'");

  // The case the whole `undoWhere` exists for.
  const movedKey = {
    op: 'update', table: 't', keyCols: ['id'],
    rows: [{ where: { id: '1' }, before: { id: '1', v: 'a' }, after: { id: '2', v: 'b' } }],
  };
  eq('an edit that moved the key is looked up by its new value',
    undoWhere(movedKey.rows[0], movedKey.keyCols).id, '2');
  check('and it sets the old key back',
    undoStatements(movedKey, 'mysql')[0] === "UPDATE `t` SET `id` = '1', `v` = 'a' WHERE `id` = '2'",
    undoStatements(movedKey, 'mysql')[0]);

  // A non-key column with the same name as a key column elsewhere must not be
  // swapped into the predicate.
  const nonKeyEdit = {
    op: 'update', table: 't', keyCols: ['id'],
    rows: [{ where: { id: '1' }, before: { v: 'a' }, after: { v: 'b' } }],
  };
  eq('a predicate untouched by the edit is left alone',
    undoWhere(nonKeyEdit.rows[0], nonKeyEdit.keyCols).id, '1');

  eq('null and the empty string are different changes',
    changedColumns({ before: { a: null }, after: { a: '' } }).length, 1);
  eq('a value retyped identically is no change',
    changedColumns({ before: { a: '1' }, after: { a: '1' } }).length, 0);
  check('sameValue compares as text, not by type', sameValue('1', 1));
  check('sameValue keeps null apart from empty', !sameValue(null, ''));

  const noChange = {
    op: 'update', table: 't', keyCols: ['id'],
    rows: [{ where: { id: '1' }, before: { a: 'x' }, after: { a: 'x' } }],
  };
  eq('a save that changed nothing produces no statement', undoStatements(noChange, 'mysql').length, 0);

  const del = {
    op: 'delete', table: 't', keyCols: ['id'],
    rows: [{ where: { id: '9' }, before: { id: '9', a: 'z', b: null }, after: null }],
  };
  eq('a delete is undone by re-inserting the whole row',
    undoStatements(del, 'pgsql')[0], 'INSERT INTO "t" ("id", "a", "b") VALUES (\'9\', \'z\', NULL)');

  const ins = { op: 'insert', table: 't', keyCols: ['id'], rows: [{ where: { id: '5' }, before: null, after: {} }] };
  eq('an insert is undone by deleting the new row',
    undoStatements(ins, 'mysql')[0], 'DELETE FROM `t` WHERE `id` = \'5\'');

  // Refusals.
  eq('a keyless table is refused',
    blockingReason({ op: 'update', table: 't', keyCols: [], rows: [{ where: {}, before: { a: '1' }, after: { a: '2' } }] }),
    'no-key');
  eq('an unknown operation is refused',
    blockingReason({ op: 'alter', table: 't', rows: [{ where: { id: '1' } }] }), 'unsupported-op');
  eq('a change with no rows is refused', blockingReason({ op: 'update', table: 't', rows: [] }), 'no-rows');
  eq('an unreadable column blocks the change',
    blockingReason({
      op: 'update', table: 't', keyCols: ['id'], unreadableCols: ['photo'],
      rows: [{ where: { id: '1' }, before: { a: '1' }, after: { a: '2' } }],
    }), 'unreadable-columns');

  // A bulk capture from the SQL page: no "after" at all, columns named explicitly.
  const bulk = {
    op: 'update', table: 'm_generic', keyCols: ['id'], restoreCols: ['value'],
    rows: [
      { where: { id: '1' }, before: { id: '1', value: 'A', other: 'keep' }, after: {} },
      { where: { id: '2' }, before: { id: '2', value: 'B', other: 'keep' }, after: {} },
    ],
  };
  eq('a bulk capture is undoable without an after', blockingReason(bulk), '');
  eq('it restores only the columns the statement wrote',
    undoStatements(bulk, 'mysql').join('\n'),
    "UPDATE `m_generic` SET `value` = 'A' WHERE `id` = '1'\nUPDATE `m_generic` SET `value` = 'B' WHERE `id` = '2'");
  eq('columnsToRestore ignores a named column the row never had',
    columnsToRestore({ restoreCols: ['value', 'missing'] }, bulk.rows[0]).length, 1);
  eq('a named column with nothing recorded is refused',
    blockingReason({ op: 'update', table: 't', keyCols: ['id'], restoreCols: ['x'],
      rows: [{ where: { id: '1' }, before: {}, after: {} }] }), 'nothing-to-restore');

  // Drift.
  eq('an untouched row reports no drift', driftOf(update, update.rows[0], { value: 'B', note: 'x' }).diffs.length, 0);
  eq('a changed column is reported', driftOf(update, update.rows[0], { value: 'Z', note: 'x' }).diffs[0].col, 'value');
  check('a vanished row is reported as missing', driftOf(update, update.rows[0], null).missing);
  check('a bulk capture cannot be drift-checked and says so', driftOf(bulk, bulk.rows[0], { value: 'Z' }).unknown);
  check('a column the change never wrote is not drift',
    driftOf(update, update.rows[0], { value: 'B', note: 'x', unrelated: 'new' }).diffs.length === 0);

  // Ordering: the newest change has to be undone first.
  const session = {
    conn: { driver: '' },
    changes: [
      { seq: 1, ...del, id: 'a' },
      { seq: 2, ...update, id: 'b' },
      { seq: 3, ...ins, id: 'c', undone: true },
    ],
  };
  const script = sessionUndoScript(session);
  check('rollback runs newest first', script[0].startsWith('UPDATE'), script[0]);
  eq('an already undone change is left out', script.length, 2);
}

/* ---------------------------------------------------------------------
 * 3b. Redo generation — the same changeset run forwards, for the test that
 *     has to be done a second time after it was rolled back.
 *
 *     The predicate is what has teeth here. A redo runs against a row that
 *     has been put back, so it must reach it by the key it was *recorded*
 *     with, never by the one the edit gave it — the exact opposite of what
 *     an undo does. Getting that backwards writes the test's values onto
 *     whatever row happens to hold the new key now.
 * ------------------------------------------------------------------- */
{
  const update = {
    op: 'update', table: 'm_generic', keyCols: ['id'],
    rows: [{ where: { id: '42' }, before: { value: 'A', note: null }, after: { value: 'B', note: 'x' } }],
  };
  eq('a recorded update can be applied again', redoBlockingReason(update), '');
  eq('it writes the values the test gave, by the recorded key',
    redoStatements(update, 'mysql')[0],
    "UPDATE `m_generic` SET `value` = 'B', `note` = 'x' WHERE `id` = '42'");

  const movedKey = {
    op: 'update', table: 't', keyCols: ['id'],
    rows: [{ where: { id: '1' }, before: { id: '1', v: 'a' }, after: { id: '2', v: 'b' } }],
  };
  eq('an edit that moved the key is redone on the old key, which the row has again',
    redoStatements(movedKey, 'mysql')[0], "UPDATE `t` SET `id` = '2', `v` = 'b' WHERE `id` = '1'");

  const del = {
    op: 'delete', table: 't', keyCols: ['id'],
    rows: [{ where: { id: '9' }, before: { id: '9', a: 'z', b: null }, after: null }],
  };
  eq('a delete is redone by deleting the row the rollback put back',
    redoStatements(del, 'mysql')[0], 'DELETE FROM `t` WHERE `id` = \'9\'');

  const ins = {
    op: 'insert', table: 't', keyCols: ['id'],
    rows: [{ where: { id: '5' }, before: null, after: { id: '5', a: 'new' } }],
  };
  eq('an insert is redone by putting the row back, key and all',
    redoStatements(ins, 'pgsql')[0], 'INSERT INTO "t" ("id", "a") VALUES (\'5\', \'new\')');

  // The refusal that matters: a bulk statement typed on the SQL page records the
  // old values but never reads the new ones, so it can be undone and cannot be
  // repeated from the changeset. It has to say so, not emit an empty SET.
  const bulk = {
    op: 'update', table: 'm_generic', keyCols: ['id'], restoreCols: ['value'],
    rows: [{ where: { id: '1' }, before: { id: '1', value: 'A' }, after: {} }],
  };
  eq('a capture with no new values is still undoable', blockingReason(bulk), '');
  eq('but it cannot be applied again', redoBlockingReason(bulk), 'redo-no-after');
  eq('and it produces no statement', redoStatements(bulk, 'mysql').length, 0);

  eq('an insert whose key was never found is refused',
    redoBlockingReason({ op: 'insert', table: 't', keyCols: [], rows: [{ where: {}, before: null, after: { a: '1' } }] }),
    'insert-key-unknown');
  eq('a keyless update is refused',
    redoBlockingReason({ op: 'update', table: 't', keyCols: [], rows: [{ where: {}, before: { a: '1' }, after: { a: '2' } }] }),
    'no-key');
  eq('an insert with nothing recorded to put back is refused',
    redoBlockingReason({ op: 'insert', table: 't', keyCols: ['id'], rows: [{ where: { id: '5' }, before: null, after: null }] }),
    'redo-no-after');
  eq('an unreadable column blocks a redo too',
    redoBlockingReason({
      op: 'update', table: 't', keyCols: ['id'], unreadableCols: ['photo'],
      rows: [{ where: { id: '1' }, before: { a: '1' }, after: { a: '2' } }],
    }), 'unreadable-columns');

  // Drift, the other way round: a redo expects the row as the rollback left it,
  // so "before" is what it compares against.
  eq('a row still holding the old value is where a redo expects it',
    driftOf(update, update.rows[0], { value: 'A', note: null }, 'redo').diffs.length, 0);
  eq('that same row is drift for an undo',
    driftOf(update, update.rows[0], { value: 'A', note: null }).diffs.length, 2);
  eq('a row someone else wrote over is drift for a redo',
    driftOf(update, update.rows[0], { value: 'Z', note: null }, 'redo').diffs[0].actual, 'Z');
  check('a vanished row is missing whichever way it is run',
    driftOf(update, update.rows[0], null, 'redo').missing);
}

/* ---------------------------------------------------------------------
 * 3c. Folded runs — the changes to one row turned into the one statement that
 *     goes straight from where it is to where it has to be: A → B → C is
 *     undone as C → A, and redone as A → C.
 *
 *     The failure with teeth here is a fold that reaches too far: across a
 *     change the person did not pick, or across a row that was deleted and
 *     inserted again, which would put back values nobody recorded.
 * ------------------------------------------------------------------- */
{
  const upd = (id, seq, where, before, after, extra = {}) => ({
    id, seq, op: 'update', table: 't', keyCols: ['id'], rows: [{ where, before, after }], ...extra,
  });
  const sess = (...changes) => ({ conn: { driver: '' }, changes });
  const sql = (plan) => planStatements(plan).join('\n');

  const abc = sess(
    upd('c1', 1, { id: '1' }, { v: 'A' }, { v: 'B' }),
    upd('c2', 2, { id: '1' }, { v: 'B' }, { v: 'C' }),
  );
  const undo = compactPlan(abc);
  eq('two edits of one row are undone in one statement', sql(undo), "UPDATE `t` SET `v` = 'A' WHERE `id` = '1'");
  eq('where step by step takes two', undo.steps, 2);
  eq('both changes take part', undo.units[0].parts.length, 2);
  eq('and a redo goes straight to the last value',
    sql(compactPlan(abc, { dir: 'redo', includeApplied: true })), "UPDATE `t` SET `v` = 'C' WHERE `id` = '1'");

  const back = compactPlan(sess(
    upd('c1', 1, { id: '1' }, { v: 'A' }, { v: 'B' }),
    upd('c2', 2, { id: '1' }, { v: 'B' }, { v: 'A' }),
  ));
  eq('a row that ended where it started needs no statement', planStatements(back).length, 0);
  eq('but its changes are still in the run', back.units[0].parts.length, 2);

  const twoCols = compactPlan(sess(
    upd('c1', 1, { id: '1' }, { v: 'A', w: null }, { v: 'B', w: '' }),
    upd('c2', 2, { id: '1' }, { v: 'B' }, { v: 'A' }),
  ));
  eq('only the columns that did not come back are written, NULL kept apart from empty',
    sql(twoCols), 'UPDATE `t` SET `w` = NULL WHERE `id` = \'1\'');

  // The key moved on the first edit; the second reached the row by its new key.
  const moved = sess(
    upd('c1', 1, { id: '1' }, { id: '1', v: 'a' }, { id: '2', v: 'b' }),
    upd('c2', 2, { id: '2' }, { v: 'b' }, { v: 'c' }),
  );
  eq('a row is followed through a key change and found by the key it has now',
    sql(compactPlan(moved)), "UPDATE `t` SET `id` = '1', `v` = 'a' WHERE `id` = '2'");
  eq('a redo reaches it by the key it had at the start',
    sql(compactPlan(moved, { dir: 'redo', includeApplied: true })), "UPDATE `t` SET `id` = '2', `v` = 'c' WHERE `id` = '1'");

  const ins = { id: 'i', seq: 1, op: 'insert', table: 't', keyCols: ['id'],
    rows: [{ where: { id: '5' }, before: null, after: { id: '5', a: 'x' } }] };
  const insEdit = sess(ins, upd('u', 2, { id: '5' }, { a: 'x' }, { a: 'y' }));
  eq('a row inserted and then edited is simply deleted', sql(compactPlan(insEdit)), 'DELETE FROM `t` WHERE `id` = \'5\'');
  eq('and redone as one INSERT of the row as the test left it',
    sql(compactPlan(insEdit, { dir: 'redo', includeApplied: true })), "INSERT INTO `t` (`id`, `a`) VALUES ('5', 'y')");

  const del9 = (seq, before) => ({ id: `d${seq}`, seq, op: 'delete', table: 't', keyCols: ['id'],
    rows: [{ where: { id: '9' }, before, after: null }] });
  const insDel = compactPlan(sess(
    { ...ins, rows: [{ where: { id: '9' }, before: null, after: { id: '9', a: 'x' } }] },
    del9(2, { id: '9', a: 'x' }),
  ));
  eq('a row inserted and deleted again needs nothing', planStatements(insDel).length, 0);
  eq('and says so', insDel.units[0].net, 'none');

  const editDel = sess(upd('u', 1, { id: '9' }, { a: 'z' }, { a: 'w' }), del9(2, { id: '9', a: 'w', b: null }));
  eq('a row edited and then deleted comes back as it was before the edit',
    sql(compactPlan(editDel)), "INSERT INTO `t` (`id`, `a`, `b`) VALUES ('9', 'z', NULL)");
  eq('and a redo just deletes it', sql(compactPlan(editDel, { dir: 'redo', includeApplied: true })),
    'DELETE FROM `t` WHERE `id` = \'9\'');

  // Deleted, then inserted under the same key: what that INSERT wrote over was
  // never read, so the row is run change by change, newest first.
  const delIns = compactPlan(sess(
    del9(1, { id: '9', a: 'old' }),
    { ...ins, seq: 2, rows: [{ where: { id: '9' }, before: null, after: { id: '9', a: 'new' } }] },
  ));
  eq('a row deleted and inserted again is not folded', delIns.units.map((u) => u.net).join(), 'steps,steps');
  eq('its changes run as the step-by-step rollback runs them', sql(delIns),
    "DELETE FROM `t` WHERE `id` = '9'\nINSERT INTO `t` (`id`, `a`) VALUES ('9', 'old')");

  // A fold stops at a change that is not part of the run.
  const three = sess(
    upd('c1', 1, { id: '1' }, { v: 'A' }, { v: 'B' }),
    upd('c2', 2, { id: '1' }, { v: 'B' }, { v: 'C' }),
    upd('c3', 3, { id: '1' }, { v: 'C' }, { v: 'D' }),
  );
  eq('a fold never reaches across a change that was not picked',
    sql(compactPlan(three, { changeIds: ['c1', 'c3'] })),
    "UPDATE `t` SET `v` = 'C' WHERE `id` = '1'\nUPDATE `t` SET `v` = 'A' WHERE `id` = '1'");
  eq('nor across a keyless one that may have written the same row',
    compactPlan(sess(three.changes[0], upd('k', 2, {}, { v: 'B' }, { v: 'C' }), three.changes[2])).units.length, 2);
  eq('nor across one already rolled back',
    compactPlan(sess(three.changes[0], { ...three.changes[1], undone: true }, three.changes[2])).units.length, 2);

  // Order: whatever created or removed a row decides where it goes.
  const fk = compactPlan(sess(
    { id: 'p', seq: 1, op: 'insert', table: 'parent', keyCols: ['id'], rows: [{ where: { id: '1' }, before: null, after: { id: '1' } }] },
    { id: 'c', seq: 2, op: 'insert', table: 'child', keyCols: ['id'], rows: [{ where: { id: '7' }, before: null, after: { id: '7', p: '1' } }] },
    { id: 'pu', seq: 3, op: 'update', table: 'parent', keyCols: ['id'], rows: [{ where: { id: '1' }, before: { n: 'a' }, after: { n: 'b' } }] },
  ));
  eq('a child inserted after its parent is deleted first, even if the parent was edited last',
    fk.units.map((u) => u.table).join(), 'child,parent');

  // A statement typed on the SQL page names the columns it wrote and never reads
  // them back. Folded with a later edit, the undo still goes back to the start.
  const typed = sess(
    { id: 'b', seq: 1, op: 'update', table: 't', keyCols: ['id'], restoreCols: ['value'],
      rows: [{ where: { id: '1' }, before: { id: '1', value: 'A' }, after: {} }] },
    upd('e', 2, { id: '1' }, { value: 'B' }, { value: 'C' }),
  );
  eq('a typed statement folds with the edit after it', sql(compactPlan(typed)), "UPDATE `t` SET `value` = 'A' WHERE `id` = '1'");
  const typedRedo = compactPlan(typed, { dir: 'redo', includeApplied: true });
  eq('but a redo cannot repeat it and says why', typedRedo.skipped.map((s) => s.reason).join(), 'redo-no-after');
  eq('and repeats only the edit it could read', sql(typedRedo), "UPDATE `t` SET `value` = 'C' WHERE `id` = '1'");
  const unread = compactPlan(sess(
    upd('e', 1, { id: '1' }, { value: 'A' }, { value: 'B' }),
    { id: 'b', seq: 2, op: 'update', table: 't', keyCols: ['id'], restoreCols: ['value'],
      rows: [{ where: { id: '1' }, before: { id: '1', value: 'B' }, after: {} }] },
  ));
  eq('a last value never read back is written anyway, even if it may have come back',
    sql(unread), "UPDATE `t` SET `value` = 'A' WHERE `id` = '1'");

  const bulk = compactPlan(sess(
    { id: 'b', seq: 1, op: 'update', table: 't', keyCols: ['id'], rows: [
      { where: { id: '1' }, before: { v: 'A' }, after: { v: 'B' } },
      { where: { id: '2' }, before: { v: 'A' }, after: { v: 'B' } },
    ] },
    upd('e', 2, { id: '1' }, { v: 'B' }, { v: 'C' }),
  ));
  eq('a bulk change folds row by row', `${planStatements(bulk).length}/${bulk.steps}`, '2/3');

  eq('a blocked change is left out and named',
    compactPlan(sess(upd('k', 1, {}, { v: 'A' }, { v: 'B' }))).skipped[0].reason, 'no-key');
  eq('quoting follows the session engine',
    sql(compactPlan({ conn: { driver: 'pgsql' }, changes: abc.changes })), 'UPDATE "t" SET "v" = \'A\' WHERE "id" = \'1\'');
  eq('the folded export script is the plan', compactUndoScript(abc).join(), "UPDATE `t` SET `v` = 'A' WHERE `id` = '1'");

  // Drift is checked once per row, against the row's last recorded values.
  const unit = undo.units[0];
  eq('a row as the test left it is not drift', unitDrift(unit, { id: '1', v: 'C' }), null);
  eq('a row someone else changed is', unitDrift(unit, { id: '1', v: 'Z' }).diffs[0].expected, 'C');
  check('a row that is gone is missing', unitDrift(unit, null).missing);
  const redoUnit = compactPlan(abc, { dir: 'redo', includeApplied: true }).units[0];
  eq('a redo expects the row as it was before the test', unitDrift(redoUnit, { v: 'A' }), null);
  check('a row the undo would put back must not be there already',
    compactPlan(editDel).units[0] && unitDrift(compactPlan(editDel).units[0], { id: '9' }).present);

  setLang('en');
  const lines = compactSummaryLines(undo, { statements: 1 });
  eq('the preview says what was folded', lines[0].say, 'restore 1 row(s) · folded from 2 change(s)');
  eq('and how much shorter it is', lines[lines.length - 1].say, '2 statements folded into 1');
  eq('a row that came back is said to need nothing',
    compactSummaryLines(back, { statements: 0 })[0].say, '1 row(s) end where they started — no statement needed');
}

/* ---------------------------------------------------------------------
 * 4. Reading a hand-written statement.
 * ------------------------------------------------------------------- */
{
  const both = splitStatements("UPDATE a SET x=';' WHERE id=1; DELETE FROM b WHERE y IN (SELECT z FROM c);");
  eq('a semicolon inside a string does not split', both.length, 2);
  check('the first statement is intact', both[0].includes("x=';'"), both[0]);

  const subquery = "UPDATE shop.m_generic g SET value='B' "
    + "WHERE g.id IN (SELECT x FROM y WHERE k=';') AND a=1 ORDER BY id LIMIT 3";
  const desc = describeStatement(subquery);
  eq('the table is read through its schema and alias', desc.table, 'm_generic');
  eq('the schema survives', desc.schema, 'shop');
  eq('the alias survives', desc.alias, 'g');
  eq('the written column is known', desc.setCols.join(','), 'value');
  // This is the assertion the module exists for: the predicate is the user's own
  // text, subquery and all, not a re-rendered approximation of it.
  eq('the predicate is lifted verbatim, subquery included',
    desc.where, "g.id IN (SELECT x FROM y WHERE k=';') AND a=1");
  check('ORDER BY and LIMIT are not swept into the predicate', !/ORDER BY/i.test(desc.where), desc.where);
  check('the statement is capturable', desc.capturable);

  eq('a WHERE-less delete is refused', describeStatement('DELETE FROM t').reason, 'no-where');
  eq('a multi-table update is refused',
    describeStatement('UPDATE a JOIN b ON a.id=b.id SET a.x=1 WHERE b.y=2').reason, 'multi-table');
  check('an insert is captured now — its key is found afterwards',
    describeStatement('INSERT INTO t (a) VALUES (1)').capturable);
  eq('a select is not a write', describeStatement('SELECT 1').reason, 'not-a-write');
  eq('unparsable text is reported as such', describeStatement('NOT SQL AT ALL ((').reason, 'parse-error');

  eq('a statement with no WHERE has no predicate text', whereText('UPDATE t SET a=1'), '');
  eq('a nested WHERE is not mistaken for the outer one',
    whereText('UPDATE t SET a=(SELECT max(b) FROM u WHERE u.c=1) WHERE t.d=2'), 't.d=2');

  eq('the snapshot asks for the key columns through the alias',
    prefetchSelect(desc, 'mysql', 200, ['id']),
    "SELECT `g`.`id` FROM `shop`.`m_generic` `g` WHERE g.id IN (SELECT x FROM y WHERE k=';') AND a=1 LIMIT 201");
  check('the row cap is fetched one over so overflow is detectable',
    prefetchSelect(describeStatement('DELETE FROM t WHERE a=1'), 'mysql', 5, ['id']).endsWith('LIMIT 6'));
  check('DDL is flagged', isDestructiveDdl('  truncate table t') && isDestructiveDdl('DROP TABLE t'));
  check('a plain update is not DDL', !isDestructiveDdl('UPDATE t SET a=1 WHERE b=2'));
}

/* ---------------------------------------------------------------------
 * 5. Key discovery from an edit link. The smallest fake document that
 *    exercises the real selector path.
 * ------------------------------------------------------------------- */
{
  const fakeDoc = (hrefs) => ({
    baseURI: 'https://db.test/adminer.php',
    querySelectorAll: () => hrefs.map((href) => ({ getAttribute: () => href })),
  });

  eq('a single-column key is read off the edit link',
    (keyColsFromDoc(fakeDoc(['?db=shop&edit=orders&where%5Bid%5D=7'])) || []).join(','), 'id');
  eq('a composite key keeps both columns',
    (keyColsFromDoc(fakeDoc(['?db=shop&edit=lines&where%5Border_id%5D=7&where%5Bline%5D=2'])) || []).join(','),
    'order_id,line');
  check('a link with no predicate yields no key',
    keyColsFromDoc(fakeDoc(['?db=shop&edit=orders'])) === null);
  check('an empty page yields no key', keyColsFromDoc(fakeDoc([])) === null);
}

/* ---------------------------------------------------------------------
 * 5b. Row identity as Adminer writes it — in the grid's `check[]` boxes and
 *     in its edit links. NULL key columns come as a list, `null[]=col`;
 *     a long text key comes as a hash that cannot go into an undo.
 * ------------------------------------------------------------------- */
{
  const real = parseAdminerUrl('https://db.test/a.php?server=h&db=d&edit=t&where%5Bid%5D=1&null%5B%5D=note');
  check('null[]=col — how Adminer actually sends a NULL key column — is read as that column',
    real.where.id === '1' && real.where.note === null && !('' in real.where), JSON.stringify(real.where));

  const url = editUrl('https://db.test/a.php', { driver: 'server', server: 'h', username: null, db: 'd', ns: '' },
    't', { id: '1', note: null, other: null });
  check('and it is written back as a list, one entry per column',
    url.includes('null%5B%5D=note') && url.includes('null%5B%5D=other') && !url.includes('null%5Bnote%5D'), url);

  eq('a column name with brackets is escaped the way Adminer does', bracketEscape('a[b]:c'), 'a:3b:2:1c');
  eq('and read back', unbracket(bracketEscape('a[b]:"c"')), 'a[b]:"c"');
  const odd = parseAdminerUrl(editUrl('https://db.test/a.php', { driver: 'sqlite', server: '', username: '', db: 'x', ns: '' },
    't', { 'a[1]': '5' }));
  eq('a bracketed column name round-trips through an edit URL', odd.where['a[1]'], '5');

  const v4 = parseRowIdf('where%5Bid%5D=42&where%5Bcode%5D=A%26B');
  check('a 4.x grid identity (URL-encoded) gives the predicate',
    v4.where.id === '42' && v4.where.code === 'A&B' && !v4.hashed.length, JSON.stringify(v4));
  const v5 = parseRowIdf('where[id]=42&null[]=note');
  check('a 5.x grid identity (brackets left bare) gives the same, NULL included',
    v5.where.id === '42' && v5.where.note === null, JSON.stringify(v5));
  const md5v4 = parseRowIdf('where%5BMD5%28%60body%60%29%5D=abc123&where%5Bid%5D=1');
  check('a 4.x hashed long-text key is flagged, not used as a column',
    md5v4.hashed.join() === 'body' && !Object.keys(md5v4.where).some((k) => k.includes('(')),
    JSON.stringify(md5v4));
  const md5v5 = parseRowIdf('fun[0]=md5&col[0]=body&val[0]=abc123&where[id]=1');
  check('a 5.x hashed key (fun/col/val) is flagged too',
    md5v5.hashed.join() === 'body' && md5v5.where.id === '1' && !('body' in md5v5.where), JSON.stringify(md5v5));
  eq('the identity is kept verbatim for fetching the row', parseRowIdf('&where[id]=1').raw, 'where[id]=1');
}

/* ---------------------------------------------------------------------
 * 5c. INSERT: undone by deleting the new row, which needs its key.
 * ------------------------------------------------------------------- */
{
  const desc = describeStatement("INSERT INTO m_generic (id, code, value) VALUES (7, 'X', NULL), (8, 'Y''s', 'z')");
  const keys = literalInsertKeys(desc, ['id']);
  check('keys spelled out as literals are read straight off the statement',
    keys && keys.length === 2 && keys[0].id === '7' && keys[1].id === '8', JSON.stringify(keys));
  check('a key column left out means the key is not known from the text',
    literalInsertKeys(describeStatement("INSERT INTO t (code) VALUES ('a')"), ['id']) === null);
  check('INSERT … SELECT names no rows',
    literalInsertKeys(describeStatement('INSERT INTO t SELECT * FROM u'), ['id']) === null);
  check('a key computed by an expression is not a literal',
    literalInsertKeys(describeStatement("INSERT INTO t (id, a) VALUES (1+1, 'x')"), ['id']) === null);
  check('a NULL key is not a key',
    literalInsertKeys(describeStatement("INSERT INTO t (id) VALUES (NULL)"), ['id']) === null);
  eq('column names match whatever their case',
    (literalInsertKeys(describeStatement('INSERT INTO t (ID, a) VALUES (3, 4)'), ['id']) || [])[0]?.id, '3');

  const ins = { op: 'insert', table: 'm_generic', keyCols: ['id'],
    rows: [{ where: { id: '7' }, before: null, after: { id: '7', code: 'X', value: null } }] };
  eq('an insert with its key is undone by deleting exactly that row',
    undoStatements(ins, 'mysql')[0], 'DELETE FROM `m_generic` WHERE `id` = \'7\'');
  eq('and nothing blocks it', blockingReason(ins), '');
  eq('an insert whose key was never found says so, in its own words',
    blockingReason({ op: 'insert', table: 't', keyCols: [], rows: [{ where: {}, before: null, after: { a: '1' } }] }),
    'insert-key-unknown');
}

/* ---------------------------------------------------------------------
 * 5d. Whole-table snapshots and backup tables.
 * ------------------------------------------------------------------- */
{
  eq('snapshot select, mysql', snapshotSelect('m_generic', 'mysql', '', 5001, ['id']),
    'SELECT * FROM `m_generic` ORDER BY `id` LIMIT 5001');
  eq('snapshot select, mssql uses TOP', snapshotSelect('t', 'mssql', '', 10, ['id']),
    'SELECT TOP 10 * FROM [t] ORDER BY [id]');
  eq('snapshot select, oracle uses FETCH FIRST', snapshotSelect('t', 'oracle', '', 10, []),
    'SELECT * FROM "t" FETCH FIRST 10 ROWS ONLY');
  eq('key select asks for the key only', keysSelect('t', ['a', 'b'], 'pgsql', '', 3),
    'SELECT "a", "b" FROM "t" ORDER BY "a", "b" LIMIT 3');

  const snap = {
    keyCols: ['id'],
    columns: ['id', 'code', 'note', 'blob'],
    unreadable: ['blob'],
    rows: [
      { id: '1', code: 'A', note: null, blob: null },
      { id: '2', code: 'B', note: '', blob: null },
      { id: '3', code: 'C', note: 'x', blob: null },
    ],
  };
  const now = {
    columns: ['id', 'code', 'note', 'blob'],
    unreadable: ['blob'],
    rows: [
      { id: '1', code: 'A', note: '', blob: null },      // NULL became ''
      { id: '2', code: 'B', note: '', blob: null },      // untouched
      { id: '4', code: 'D', note: null, blob: null },    // inserted since
    ],                                                   // 3 deleted since
  };
  const diff = diffSnapshot(snap, now);
  eq('a row added since the snapshot is deleted', diff.deletes.map((d) => d.where.id).join(), '4');
  eq('a row removed since is inserted back', diff.inserts.map((i) => i.row.id).join(), '3');
  check('a NULL that became an empty string is a change, and is put back as NULL',
    diff.updates.length === 1 && diff.updates[0].where.id === '1' && diff.updates[0].set.note === null
      && Object.keys(diff.updates[0].set).join() === 'note', JSON.stringify(diff.updates));
  check('an unreadable column is not compared, and is listed as skipped',
    diff.skippedCols.includes('blob') && !diff.inserts[0].row.hasOwnProperty('blob'), JSON.stringify(diff));
  const sql = restoreStatements(diff, 'm_generic', 'mysql');
  check('deletes run first, then updates, then inserts — so unique values are free when needed',
    sql[0].startsWith('DELETE') && sql[1].startsWith('UPDATE') && sql[2].startsWith('INSERT'), sql.join(' | '));
  eq('the restored row keeps its NULL', sql[1], 'UPDATE `m_generic` SET `note` = NULL WHERE `id` = \'1\'');
  check('an unchanged table needs nothing', diffIsEmpty(diffSnapshot(snap, { ...snap })));

  eq('no key, no diff', diffSnapshot({ ...snap, keyCols: [] }, now).reason, 'no-key');
  eq('duplicate keys are refused rather than guessed',
    diffSnapshot(snap, { ...now, rows: [...now.rows, { id: '4', code: 'E', note: null }] }).reason, 'duplicate-key');
  eq('a key column that cannot be read is refused',
    diffSnapshot({ ...snap, unreadable: ['id'] }, now).reason, 'key-not-compared');
  check('a column dropped since the snapshot is skipped, not written',
    diffSnapshot(snap, { ...now, columns: ['id', 'code', 'blob'] }).skippedCols.includes('note'));

  // An empty table reads back as "No rows." — no header, so no column list.
  const wasEmpty = diffSnapshot({ keyCols: ['id'], columns: [], rows: [], unreadable: [] },
    { columns: ['id', 'name'], rows: [{ id: '2', name: 'from app' }], unreadable: [] });
  check('a table that was empty when snapshotted is emptied again',
    !wasEmpty.reason && wasEmpty.deletes.length === 1 && wasEmpty.deletes[0].where.id === '2', JSON.stringify(wasEmpty));
  const nowEmpty = diffSnapshot({ keyCols: ['id'], columns: ['id', 'name'], rows: [{ id: '1', name: 'a' }], unreadable: [] },
    { columns: [], rows: [], unreadable: [] });
  check('a table emptied since the snapshot gets its rows back',
    !nowEmpty.reason && nowEmpty.inserts.length === 1 && nowEmpty.inserts[0].row.name === 'a', JSON.stringify(nowEmpty));

  const before = [keyOf({ id: '1' }, ['id']), keyOf({ id: '2' }, ['id'])];
  eq('new rows are the ones whose key was not there before',
    newRows(before, [{ id: '1' }, { id: '2' }, { id: '9' }], ['id']).map((r) => r.id).join(), '9');
  eq('key comparison keeps NULL apart from the text "null"',
    newRows([keyOf({ id: null }, ['id'])], [{ id: 'null' }], ['id']).length, 1);
  eq('a key predicate from a row', JSON.stringify(keyWhere({ a: '1', b: null, c: 'x' }, ['a', 'b'])), '{"a":"1","b":null}');

  const when = new Date(2026, 8, 19, 14, 5, 9);
  eq('a backup is named after the table and the moment', backupName('m_generic', when, 'mysql'),
    'm_generic_bak_20260919_140509');
  const long = backupName('x'.repeat(80), when, 'pgsql');
  check('a long name is cut from the table end, never the timestamp',
    long.length === 63 && long.endsWith('_bak_20260919_140509'), long);
  check('oracle keeps within 30', backupName('a_long_master_table', when, 'oracle').length <= 30);
  eq('backup is CREATE TABLE AS', backupCreateSql('t', 't_bak', 'mysql'), 'CREATE TABLE `t_bak` AS SELECT * FROM `t`');
  eq('except in SQL Server, which uses SELECT INTO', backupCreateSql('t', 't_bak', 'mssql'),
    'SELECT * INTO [t_bak] FROM [t]');
  eq('wholesale restore empties then copies back', backupRestoreSql('t', 't_bak', 'pgsql').join('; '),
    'DELETE FROM "t"; INSERT INTO "t" SELECT * FROM "t_bak"');
  eq('drop', backupDropSql('t_bak', 'sqlite'), 'DROP TABLE "t_bak"');
}

/* ---------------------------------------------------------------------
 * 6. Translation catalogs. A missing key degrades to the key itself, which
 *    is how `reason.no-key` ends up on screen instead of a sentence.
 * ------------------------------------------------------------------- */
{
  const viKeys = Object.keys(CATALOGS.vi).sort();
  const enKeys = Object.keys(CATALOGS.en).sort();
  eq('both catalogs hold the same keys', viKeys.join(','), enKeys.join(','));

  const placeholders = (text) => (text.match(/\{(\w+)\}/g) || []).sort().join(',');
  for (const key of viKeys) {
    check(`placeholders match for ${key}`,
      placeholders(CATALOGS.vi[key]) === placeholders(CATALOGS.en[key]),
      `${CATALOGS.vi[key]} / ${CATALOGS.en[key]}`);
  }

  // Every reason code the code can produce must have a sentence in both.
  const REASONS = [
    'no-key', 'no-before', 'nothing-to-restore', 'no-rows', 'no-table', 'unsupported-op',
    'unreadable-columns', 'multi-table', 'no-where', 'insert-not-captured', 'parse-error', 'not-a-write',
    'insert-key-unknown', 'too-many-rows', 'import-not-captured', 'redo-no-after',
  ];
  for (const lang of LANGUAGES) {
    setLang(lang);
    clearMissingKeys();
    for (const reason of REASONS) t(`reason.${reason}`);
    for (const op of ['update', 'delete', 'insert']) t(`op.${op}`);
    for (const key of viKeys) t(key);
    eq(`no key is missing in ${lang}`, missingKeys().join(','), '');
  }

  setLang('vi');
  eq('placeholders are filled', t('panel.changes', { n: 3 }), '3 thay đổi');
  setLang('en');
  eq('and in English too', t('panel.changes', { n: 3 }), '3 change(s)');
  eq('an unknown key degrades to itself', t('nope.nope'), 'nope.nope');
}

/* ---------------------------------------------------------------------
 * The words around a changeset — what the preview lists above its SQL, how a
 * change is named, which sessions a clean-up may take.
 * ------------------------------------------------------------------- */
{
  setLang('en');
  const change = (id, seq, op, table, rows, extra = {}) => ({
    id, seq, op, table, rows: Array.from({ length: rows }, (_, i) => ({ where: { id: seq * 10 + i } })), ...extra,
  });
  const session = {
    changes: [
      change('a', 1, 'update', 'orders', 3),
      change('b', 2, 'delete', 'items', 1),
      change('c', 3, 'insert', 'orders', 2),
      change('d', 4, 'update', 'legacy', 1),
      change('e', 5, 'update', 'orders', 1, { undone: true }),
    ],
    snapshots: [{ id: 's1' }],
  };

  eq('changes run newest first, undone ones left out',
    changesInPlay(session).map((c) => c.id).join(), 'd,c,b,a');
  eq('undone ones are back in on a second run',
    changesInPlay(session, { includeUndone: true }).map((c) => c.id).join(), 'e,d,c,b,a');

  // A redo is the same list the other way up: only what was rolled back, and in
  // the order it was recorded, so a row exists again before the edit that follows.
  eq('a redo takes the rolled-back ones', changesInPlay(session, { dir: 'redo' }).map((c) => c.id).join(), 'e');
  eq('and the ones still applied when asked, oldest first',
    changesInPlay(session, { dir: 'redo', includeApplied: true }).map((c) => c.id).join(), 'a,b,c,d,e');

  const redone = summaryLines(session, { dir: 'redo', includeApplied: true, statements: 5 });
  eq('a redo says what it writes, not what it restores', redone[0].say, 'set 3 row(s) again');
  eq('a delete is redone by deleting again', redone[1].say, 'delete 1 row(s) again');
  eq('an insert is redone by putting the row back', redone[2].say, 're-insert 2 row(s)');

  const lines = summaryLines(session, { skipped: new Map([['d', 'no-key']]), statements: 3, hasSnapshots: true });
  eq('one line per change, plus the totals', lines.length, 6);
  eq('an insert is undone by deleting it', lines[1].say, 'delete the 2 inserted row(s)');
  eq('a delete is undone by putting it back', lines[2].say, 're-insert 1 row(s)');
  check('a skipped change is listed with its reason', lines[0].skipped && /no key/.test(lines[0].say), lines[0].say);
  eq('the total counts only what will run', lines[4].say, '3 statement(s) · 6 row(s) · 2 table(s)');
  check('snapshots are mentioned when they follow', /snapshot/.test(lines[5].say), lines[5].say);

  const many = { changes: Array.from({ length: 30 }, (_, i) => change(`m${i}`, i + 1, i % 3 ? 'update' : 'delete', i % 2 ? 'orders' : 'items', 2)) };
  const grouped = summaryLines(many, { statements: 30, groupOver: 12 });
  check('a long session is grouped by table and operation', grouped.length <= 5, String(grouped.length));
  const upd = grouped.find((l) => l.op === 'update' && l.table === 'orders');
  check('a group says how many rows and how many changes', /row\(s\) · \d+ change\(s\)/.test(upd && upd.say), upd && upd.say);
  eq('grouping keeps the totals', grouped[grouped.length - 1].say, '30 statement(s) · 60 row(s) · 2 table(s)');

  eq('a one-row change is named by its key', rowKeyLabel({ rows: [{ where: { id: 2 } }] }), 'id=2');
  eq('a composite key is named in full', rowKeyLabel({ rows: [{ where: { a: 1, b: null } }] }), 'a=1, b=NULL');
  eq('more rows are counted after the first', rowKeyLabel({ rows: [{ where: { id: 1 } }, { where: { id: 2 } }] }), 'id=1 +1');
  eq('a long key is shortened', rowKeyLabel({ rows: [{ where: { k: 'x'.repeat(40) } }] }).length <= 26, true);
  eq('no rows, no name', rowKeyLabel({ rows: [] }), '');

  check('a session with everything undone is spent', isSpent({ changes: [{ undone: true }], snapshots: [{ restoredAt: 'x' }] }));
  check('one pending change is not', !isSpent({ changes: [{ undone: true }, { undone: false }] }));
  check('an unrestored snapshot is not', !isSpent({ changes: [], snapshots: [{}] }));

  const pool = {
    rec: { id: 'rec', closedAt: null, changes: [] },
    spent: { id: 'spent', closedAt: 'x', changes: [{ undone: true }] },
    pending: { id: 'pending', closedAt: 'x', changes: [{ undone: false }] },
    backup: { id: 'backup', closedAt: 'x', changes: [], backups: [{ id: 'b1' }] },
    dropped: { id: 'dropped', closedAt: 'x', changes: [], backups: [{ id: 'b2', droppedAt: 'y' }] },
  };
  const ids = (list) => list.map((x) => x.id).sort().join();
  const cands = cleanupCandidates(pool);
  eq('clean-up takes spent ended sessions by default', ids(cands.chosen), 'dropped,spent');
  eq('pending ones only when asked', ids(cleanupCandidates(pool, { includePending: true }).chosen), 'dropped,pending,spent');
  check('never the recording one', !cleanupCandidates(pool, { includePending: true }).chosen.some((x) => x.id === 'rec'));
  eq('a live backup table keeps its session', ids(cands.keptForBackups), 'backup');

  eq('a default name says what and when', defaultSessionName('Test session', 'orders', new Date(2026, 8, 22, 9, 5)),
    'Test session · orders · 09:05');
  eq('and leaves out what it does not know', defaultSessionName('Test session', '', new Date(2026, 8, 22, 14, 30)),
    'Test session · 14:30');
}

/* ---------------------------------------------------------------------
 * Session lifecycle — which session the panel shows, and the rule that a
 * connection has one recording session at most. Run against an in-memory
 * stand-in for chrome.storage.local.
 * ------------------------------------------------------------------- */
{
  const mem = {};
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          for (const k of [].concat(keys)) if (k in mem) out[k] = structuredClone(mem[k]);
          cb(out);
        },
        set: (obj, cb) => { Object.assign(mem, structuredClone(obj)); cb && cb(); },
        remove: (keys, cb) => { for (const k of [].concat(keys)) delete mem[k]; cb && cb(); },
      },
    },
  };

  const conn = { driver: 'sqlite', db: 'shop' };
  const base = { conn, origin: 'http://h', base: 'http://h/', key: 'K1' };
  const tick = () => new Promise((r) => setTimeout(r, 2));

  const a = await store.startSession({ ...base, name: 'A' });
  eq('a started session is what the panel shows', (await store.panelSession('K1')).id, a.id);

  await store.closeSession(a.id);
  const shown = await store.panelSession('K1');
  eq('an ended session stays on the panel', shown && shown.id, a.id);
  check('and it is shown as ended', Boolean(shown && shown.closedAt));
  eq('nothing is recording after End', await store.activeSessionId('K1'), '');

  await tick();
  const b = await store.startSession({ ...base, name: 'B' });
  eq('a new session takes over the panel', (await store.panelSession('K1')).id, b.id);

  await store.reopenSession(a.id);
  const all = await store.allSessions();
  eq('resuming one session makes it the recording one', await store.activeSessionId('K1'), a.id);
  check('and ends the one that was recording', Boolean(all[b.id].closedAt), JSON.stringify(all[b.id]));
  check('the resumed session is open again', all[a.id].closedAt === null);

  await tick();
  const c = await store.startSession({ ...base, name: 'C' });
  check('starting a session ends the one recording', Boolean((await store.getSession(a.id)).closedAt));
  eq('only the new one is open',
    Object.values(await store.allSessions()).filter((x) => !x.closedAt).map((x) => x.name).join(), 'C');

  // Ending a session that is no longer the recording one must not pull the panel
  // off the one that is.
  await store.closeSession(b.id);
  eq('ending a stale session leaves the recording one on the panel', (await store.panelSession('K1')).id, c.id);

  const list = await store.sessionsFor('K1');
  eq('sessions of a connection are listed newest first', list.map((x) => x.name).join(), 'C,B,A');
  eq('another connection has none', (await store.sessionsFor('K2')).length, 0);
  eq('and nothing to show', await store.panelSession('K2'), null);

  await store.closeSession(c.id);
  await store.deleteSession(c.id);
  eq('deleting the shown session falls back to the newest left', (await store.panelSession('K1')).id, b.id);

  delete globalThis.chrome;
}

/* ------------------------------------------------------------------- */

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed:\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`All ${passed} checks passed.`);
