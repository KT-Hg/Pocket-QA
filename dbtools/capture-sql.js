/**
 * capture-sql.js — capture on the SQL command page: statements are read before
 * they run, rows they will change are snapshotted, inserts are traced to their keys.
 */

import * as adminer from './adapters/adminer.js';
import { baseChange } from './capture-grid.js';
import { READ_BATCH, TOO_MANY_ROWS, interceptSubmit, park } from './capture-record.js';
import { discoverKeyCols, readRow, selectFull, selectRows } from './executor.js';
import { t } from './i18n.js';
import { newId, pick, state } from './page-state.js';
import * as store from './session.js';
import { keyOf, keysSelect, snapshotSelect } from './snapshot.js';
import { describeStatement, isDestructiveDdl, literalInsertKeys, prefetchSelect, splitStatements } from './sqlcapture.js';

/* === The SQL command page ════════════════════════════════════════════════ */

export function wireSqlPage() {
  const found = adminer.findSqlForm(document);
  if (!found) return;

  // A statement with no WHERE changes every row of its table. That much is read
  // from the text alone, so it is asked about even when nothing is recording.
  const unbounded = (sql) => splitStatements(sql).map(describeStatement)
    .filter((desc) => desc.reason === 'no-where');

  interceptSubmit(found.form, async (submitter, { recording, pause }) => {
    const sql = adminer.readSqlQuery(found);

    // Put the text where Adminer expects to find it. Adminer copies the
    // highlighter's content into the hidden textarea from its own submit
    // handler, and holding the submit and re-issuing it is not guaranteed to run
    // that copy a second time — when it does not, the statement posts with an
    // empty `query` and comes back "No commands to execute". Writing it
    // ourselves makes the re-submit independent of that ordering; if Adminer's
    // copy does run again it writes the identical text.
    if (sql && found.textarea.value !== sql) found.textarea.value = sql;

    // Once a question is certain the watchdog stops: reading the rows of a big
    // statement can outlast it, and it would run what nobody has confirmed yet.
    const risks = [];
    const flag = (desc, say) => { risks.push(risk(desc, say)); pause(); };
    for (const desc of unbounded(sql)) flag(desc, t('risk.noWhere'));
    const captures = recording && state.settings.captureSqlPage
      ? await captureAll(sql, flag).catch((err) => {
        // Only the snapshot is lost; the question is still asked.
        state.panel.log(t('panel.captureFailed', { reason: String(err && err.message || err) }), 'err');
        return [];
      })
      : [];

    if (risks.length && pause() && !(await confirmRisks(sql, risks))) {
      state.panel.log(t('risk.cancelled'), 'warn');
      return false;
    }
    await park(captures);
  }, () => unbounded(adminer.readSqlQuery(found)).length > 0);
}

/** One line of the question below: which statement, on which table, and why. */
function risk(desc, say) {
  return { op: desc.kind, table: desc.table, say };
}

/** Run anyway, or go back and fix the statement. Resolves true to run it. */
function confirmRisks(sql, risks) {
  return state.panel.preview({
    title: t('risk.title'),
    sql,
    summary: risks,
    note: t('risk.note'),
    cancelLabel: t('risk.cancel'),
    confirmLabel: t('risk.run'),
    confirmKind: 'danger',
  });
}

/**
 * Snapshot every statement of one submit, telling `flag(desc, say)` of the ones
 * found to change a whole table only once their rows were read.
 */
async function captureAll(sql, flag) {
  const captures = [];
  // Every statement's rows are read before any of them runs, so two INSERTs into
  // one table found by comparing keys would both find each other's rows. They
  // share one change instead — see captureInsert.
  const byTable = new Map();
  for (const text of splitStatements(sql)) {
    if (isDestructiveDdl(text)) {
      state.panel.log(t('panel.notUndoable', { reason: text.split(/\s+/)[0].toUpperCase() }), 'err');
      continue;
    }
    const desc = describeStatement(text);
    if (desc.kind !== 'update' && desc.kind !== 'delete' && desc.kind !== 'insert') continue;

    const shared = desc.kind === 'insert' ? byTable.get(desc.table.toLowerCase()) : null;
    if (shared && shared.insertProbe && shared.insertProbe.strategy !== 'literal') {
      shared.statement = `${shared.statement};
${desc.sql}`;
      continue;
    }
    state.panel.notice(t('panel.capturing'));
    const change = await captureStatement(desc, flag);
    if (!change) continue;
    captures.push(change);
    if (change.op === 'insert') byTable.set(desc.table.toLowerCase(), change);
  }
  return captures;
}

/**
 * Whether a WHERE that matched `n` rows matched every row of the table — `1=1`,
 * or a condition all rows happen to meet. The table is read up to one row past
 * `n` instead of counted, so a big table costs no more than a small one. A
 * single row is not asked about: any WHERE that hits a one-row table hits all of it.
 */
async function matchesWholeTable(desc, keyCols, n) {
  if (n < 2) return false;
  try {
    const all = await selectRows(state.ctx, keysSelect(desc.table, keyCols, state.ctx.engine, desc.schema, n + 1));
    return all.ok && all.rows.length <= n;
  } catch {
    return false;   // a question that could not be asked must not block the statement
  }
}

/**
 * Snapshot the rows one hand-written statement is about.
 *
 * Always returns a change, even when it could not snapshot anything: a statement
 * that ran and was not recorded is exactly the thing a person needs to be told
 * about, so it goes into the changeset carrying its own reason.
 */
async function captureStatement(desc, flag = () => {}) {
  const base = {
    id: newId('ch'),
    at: new Date().toISOString(),
    op: desc.kind,
    table: desc.table,
    schema: desc.schema,
    source: 'sql-page',
    statement: desc.sql,
    keyCols: [],
    rows: [],
    warnings: [],
  };

  if (!desc.capturable) {
    base.warnings.push(desc.reason);
    state.panel.log(t('panel.notUndoable', { reason: t(`reason.${desc.reason}`) }), 'warn');
    return base;
  }

  if (desc.kind === 'insert') return captureInsert(desc, base);

  const keyCols = await keyColsFor(desc.table);
  if (!keyCols) {
    base.warnings.push('no-key');
    state.panel.log(t('panel.notUndoable', { reason: t('reason.no-key') }), 'warn');
    return base;
  }
  base.keyCols = keyCols;
  if (desc.kind === 'update') base.restoreCols = desc.setCols;

  const limit = state.settings.prefetchLimit;
  const sql = prefetchSelect(desc, state.ctx.engine, limit, keyCols);
  let found;
  try {
    found = await selectRows(state.ctx, sql);
  } catch (err) {
    found = { ok: false, errors: [String(err && err.message || err)] };
  }
  if (!found.ok) {
    base.warnings.push(`prefetch-failed:${found.errors[0] || ''}`);
    state.panel.log(t('panel.captureFailed', { reason: found.errors[0] || '' }), 'err');
    return base;
  }
  if (found.rows.length > limit) {
    base.warnings.push('too-many-rows');
    state.panel.log(t(TOO_MANY_ROWS, { n: limit }), 'err');
    flag(desc, t('risk.tooMany', { n: limit }));
    return base;
  }
  if (await matchesWholeTable(desc, keyCols, found.rows.length)) {
    flag(desc, t('risk.everyRow', { n: found.rows.length }));
  }

  // The grid gave us which rows; each row's real values come from its edit form,
  // where Adminer abbreviates nothing.
  const keys = found.rows.map((row) => pick(normaliseRow(row), keyCols));
  base.rows = await readRows(desc.table, keys);
  if (!base.rows.length && keys.length) base.warnings.push('no-before');
  return base;
}

/**
 * An INSERT typed on the SQL page. Its rows do not exist yet, so what is taken
 * now is whatever will let them be found afterwards:
 *
 *   - the keys themselves, when the statement spells every key column out as a
 *     literal — nothing to read, nothing to guess;
 *   - otherwise the table's keys as they are now, to compare with the keys after
 *     it ran; the new ones are the inserted rows;
 *   - and when the table's key is not known yet (an empty table has no edit links
 *     to learn it from), whole rows, compared the same way.
 *
 * The comparison also counts rows someone else inserted in the same moment. The
 * window is one page load, and the change says it was found this way.
 */
async function captureInsert(desc, base) {
  const keyCols = await keyColsFor(desc.table);
  const literal = keyCols ? literalInsertKeys(desc, keyCols) : null;
  if (literal) {
    base.keyCols = keyCols;
    base.insertProbe = { strategy: 'literal', wheres: literal };
    return base;
  }
  return captureInsertByDifference(desc.table, 'sql-page', desc.schema || '', base);
}

export async function captureInsertByDifference(table, source, schema, base = null) {
  const change = base || baseChange('insert', table, source);
  const keyCols = await keyColsFor(table);
  const limit = state.settings.keyScanLimit;
  const engine = state.ctx.engine;
  const sql = keyCols
    ? keysSelect(table, keyCols, engine, schema, limit + 1)
    : snapshotSelect(table, engine, schema, limit + 1);
  let found;
  try {
    found = await selectFull(state.ctx, sql);
  } catch (err) {
    found = { ok: false, errors: [String(err && err.message || err)], rows: [] };
  }
  if (!found.ok || found.rows.length > limit) {
    change.warnings.push(found.ok ? 'too-many-rows' : `prefetch-failed:${found.errors[0] || ''}`);
    change.warnings.push('insert-key-unknown');
    state.panel.log(t('panel.notUndoable', { reason: t('reason.insert-key-unknown') }), 'warn');
    return change;
  }
  change.keyCols = keyCols || [];
  change.warnings.push('insert-found-by-difference');
  change.insertProbe = keyCols
    ? { strategy: 'keys', beforeKeys: found.rows.map((row) => keyOf(row, keyCols)) }
    : { strategy: 'rows', beforeRows: found.rows };
  return change;
}

/** Result-grid headers can carry sort links and padding; the values do not. */
function normaliseRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[String(key).trim()] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}

/** Read each row's full values through its edit form, a few at a time. */
async function readRows(table, keys) {
  const rows = [];
  for (let i = 0; i < keys.length; i += READ_BATCH) {
    const slice = keys.slice(i, i + READ_BATCH);
    const read = await Promise.all(slice.map(async (where) => {
      try {
        const res = await readRow(state.ctx, table, where);
        return res.ok ? { where, before: res.values, after: {} } : null;
      } catch {
        return null;
      }
    }));
    for (const row of read) if (row) rows.push(row);
  }
  return rows;
}

/** Key columns for a table, discovered once and cached per connection. */
export async function keyColsFor(table) {
  const cached = await store.getKeyCols(state.ctx.key, table);
  if (cached && cached.length) return cached;
  let cols = null;
  try {
    cols = await discoverKeyCols(state.ctx, table);
  } catch {
    cols = null;
  }
  // Only an answer is cached. An empty table has no edit links to learn its key
  // from, and remembering that as "no key" would outlive the first INSERT into it.
  if (cols) await store.setKeyCols(state.ctx.key, table, cols);
  return cols;
}
