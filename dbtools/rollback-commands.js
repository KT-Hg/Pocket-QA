/**
 * rollback-commands.js — rolling a session back and forward from the panel,
 * undoing the last change, exporting the rollback SQL.
 */

import { refresh } from './content-main.js';
import { TABLE_COPIES } from './features.js';
import { t } from './i18n.js';
import { state } from './page-state.js';
import { askAboutDrift } from './playback-guard.js';
import { runRedo, runRollback } from './rollback.js';
import * as store from './session.js';
import { restoreSnapshots } from './snapshot-commands.js';
import { joinStatements } from './sqlquote.js';
import { compactSummaryLines, summaryLines } from './summary.js';

/* === Rollback ════════════════════════════════════════════════════════════ */

/** A dry run of the folded plan (compact.js), with the same options as the step-by-step one. */
function foldedDry(dir, session, opts) {
  const run = dir === 'redo' ? runRedo : runRollback;
  return run(state.ctx, session, { ...opts, dryRun: true, compact: true });
}

/** The confirm button's label when the caller does not set one. */
function defaultConfirmLabel(n) {
  return n ? t('rollback.confirm', { n }) : t('compact.markDone');
}

/**
 * The run offered two ways in the preview: step by step, as recorded, or folded
 * per row so that A → B → C goes straight back to A. `stepView` is what the
 * preview shows for the step-by-step run; `step` and `folded` are the dry runs of
 * each. Null when folding would not make the run any shorter: then there is
 * nothing to choose between, and the preview is the plain one it always was.
 *
 * The preview opens on whichever was chosen last (`settings.compactRun`).
 */
function runModes(dir, stepView, step, folded, { extra = [], confirm = null } = {}) {
  if (!folded || folded.statements.length >= step.statements.length) return null;
  const n = folded.statements.length;
  return {
    value: state.settings.compactRun ? 'compact' : 'step',
    label: t('compact.modes'),
    options: [
      { ...stepView, id: 'step', label: t('compact.step', { n: step.statements.length }), hint: t('compact.stepHint') },
      {
        id: 'compact',
        label: t('compact.fold', { n }),
        hint: t(dir === 'redo' ? 'compact.foldHintRedo' : 'compact.foldHint'),
        sql: n ? joinStatements(folded.statements) : `-- ${t('compact.nothingToRun')}`,
        summary: [...compactSummaryLines(folded.plan, { statements: n }), ...extra],
        note: stepView.note,
        // Every row back where it started: nothing is sent, and confirming only
        // records that the changes are undone.
        confirmLabel: confirm ? confirm(n) : defaultConfirmLabel(n),
      },
    ],
  };
}

/** Keep the way the preview was answered as the way the next one opens. */
async function rememberMode(answer) {
  const compact = answer === 'compact';
  if (Boolean(state.settings.compactRun) === compact) return;
  state.settings = await store.setSettings({ compactRun: compact });
}

export async function exportSql() {
  const session = state.session || (await refresh());
  if (!session) return;
  const dry = await runRollback(state.ctx, session, { dryRun: true });
  if (!dry.statements.length) {
    state.panel.notice(t('rollback.nothing'), 'warn');
    return;
  }
  const stepView = {
    sql: joinStatements(dry.statements),
    note: dry.skipped ? t('rollback.blocked', { n: dry.skipped }) : '',
    confirmLabel: t('rollback.copyGo'),
  };
  const modes = runModes('undo', stepView, dry, await foldedDry('undo', session, {}), {
    confirm: () => t('rollback.copyGo'),
  });
  // Copying is the whole point of this sheet, so it is the one button that does
  // it — the sheet's own spare "Copy" would sit next to it saying the same.
  const go = await state.panel.preview({
    title: t('rollback.exportTitle'),
    ...stepView,
    copyButton: false,
    modes,
  });
  if (!go) return;
  if (modes) await rememberMode(go);
  const sql = modes ? modes.options.find((o) => o.id === go).sql : stepView.sql;
  try {
    await navigator.clipboard.writeText(sql);
    state.panel.notice(t('rollback.copied'), 'ok');
  } catch {
    state.panel.notice(t('rollback.copied'), 'warn');
  }
}

/**
 * Roll a session back: the recorded changes first, newest first, then any table
 * snapshots for whatever the change log could not see.
 *
 * `auto` is the Playback guard running this unattended: the person asked for it
 * up front, so there is no preview to confirm, and a row that someone else moved
 * in the meantime is skipped rather than asked about — never overwritten.
 * Snapshots are only restored for a whole-session rollback, not for a hand-picked
 * set of changes.
 *
 * A session is not used up by one rollback. When everything in it has already
 * been undone, the same changes are offered again — the test can be run a second
 * time, or the data can have moved since — and the preview says that is what this
 * is. Rolling the same changes back twice is harmless: each one writes the values
 * it recorded, and the drift check still asks before overwriting anything that no
 * longer holds what it expects.
 */
export async function rollback({ sessionId, changeIds, auto = false, includeUndone = false } = {}) {
  let session = sessionId ? await store.getSession(sessionId) : (state.session || (await refresh()));
  const report = { total: 0, ok: 0, failed: 0, skipped: 0, statements: [], details: [], snapshots: null };
  if (!session) return report;

  // With table copies switched off, a snapshot an older session holds is left
  // alone: the rollback is the change log's and nothing else.
  const snaps = TABLE_COPIES ? (session.snapshots || []) : [];
  const pending = (session.changes || []).some((c) => !c.undone) || snaps.some((s) => !s.restoredAt);
  const again = includeUndone || (!pending && Boolean((session.changes || []).length || snaps.length));

  const dry = await runRollback(state.ctx, session, { dryRun: true, changeIds, includeUndone: again });
  const hasSnapshots = !changeIds && snaps.some((s) => again || !s.restoredAt);
  if (!dry.statements.length && !hasSnapshots) {
    state.panel.notice(t('rollback.nothing'), 'warn');
    state.panel.expand();
    // A dry run counts every change it *could* undo as "ok". Handing that back
    // unmarked made the manager page report a rollback that never ran as
    // "3 succeeded, 0 failed".
    return { ...dry, nothing: true };
  }

  if (dry.statements.length) {
    const notes = [
      again ? t('rollback.againNote') : '',
      dry.skipped ? t('rollback.blocked', { n: dry.skipped }) : '',
    ].filter(Boolean);
    const stepView = {
      sql: joinStatements(dry.statements),
      summary: summaryLines(session, {
        changeIds,
        includeUndone: again,
        skipped: new Map((dry.details || []).filter((d) => d.skipped).map((d) => [d.change, d.skipped])),
        statements: dry.statements.length,
        hasSnapshots,
      }),
      note: notes.join('\n'),
      confirmLabel: t('rollback.confirm', { n: dry.statements.length }),
    };
    // The Playback guard runs unattended and step by step, as it always has:
    // nobody is there to pick, and folding is a choice made in the preview.
    const modes = auto ? null : runModes('undo', stepView, dry,
      await foldedDry('undo', session, { changeIds, includeUndone: again }), {
        extra: hasSnapshots
          ? [{ total: true, say: t('rollback.alsoSnapshots', { n: (session.snapshots || []).length }) }]
          : [],
      });
    const go = auto || await state.panel.preview({
      title: again ? t('rollback.againTitle') : t('rollback.title'),
      ...stepView,
      modes,
      // Blue is for "proceed"; this writes over rows that are in the database
      // right now, and the button that does it should look like the one on the
      // panel that opened it.
      confirmKind: 'danger',
    });
    if (!go) return { ...dry, cancelled: true };
    if (modes) await rememberMode(go);

    try {
      Object.assign(report, await runRollback(state.ctx, session, {
        changeIds,
        includeUndone: again,
        compact: go === 'compact',
        driftCheck: state.settings.driftCheck,
        onDrift: auto ? async () => 'skip' : askAboutDrift,
        // Only the run itself; the drift check reports the same position and would
        // print every line twice. One line that rewrites itself, not one per
        // statement: a forty-statement rollback used to bury everything the log
        // had said before it.
        onProgress: ({ phase, i, n }) => {
          if (phase === 'run') state.panel.progress(t('rollback.running', { i, n }), i - 1, n);
        },
      }));
    } finally {
      state.panel.progress(null);
    }

    reportRollback(report);
    // A change that failed leaves the tables in between states; restoring the
    // snapshots over that would hide where it stopped.
    if (report.failed) {
      await refresh();
      return report;
    }
  }

  if (hasSnapshots) {
    session = await store.getSession(session.id);
    report.snapshots = await restoreSnapshots(session, { auto, includeRestored: again });
  }
  await refresh();
  return report;
}

/**
 * Apply a session's changes again, after it has been rolled back.
 *
 * The step of a test nobody plans for: the rollback ran, something turned out to
 * be wrong, and the same rows have to go back to the values the test gave them.
 * The changeset already holds those values, so they are written again — oldest
 * change first, the order they were made in, so a row exists before the edit
 * that followed it is re-applied.
 *
 * Only the change log. A whole-table snapshot records how a table was *before*
 * the test and has nothing to say about how it looked after, so a redo leaves
 * snapshots alone rather than pretending otherwise.
 */
export async function redo({ sessionId, changeIds, includeApplied = false } = {}) {
  const session = sessionId ? await store.getSession(sessionId) : (state.session || (await refresh()));
  const report = { total: 0, ok: 0, failed: 0, skipped: 0, statements: [], details: [], snapshots: null };
  if (!session) return report;

  const changes = session.changes || [];
  // With nothing rolled back there is nothing waiting to be applied again, so the
  // ask is the other one: write the recorded values over whatever is there now.
  const again = includeApplied || (!changes.some((c) => c.undone) && Boolean(changes.length));

  const dry = await runRedo(state.ctx, session, { dryRun: true, changeIds, includeApplied: again });
  if (!dry.statements.length) {
    state.panel.notice(t('redo.nothing'), 'warn');
    state.panel.expand();
    return { ...dry, nothing: true };
  }

  const notes = [
    again ? t('redo.againNote') : t('redo.note'),
    dry.skipped ? t('redo.blocked', { n: dry.skipped }) : '',
  ].filter(Boolean);
  const stepView = {
    sql: joinStatements(dry.statements),
    summary: summaryLines(session, {
      dir: 'redo',
      changeIds,
      includeApplied: again,
      skipped: new Map((dry.details || []).filter((d) => d.skipped).map((d) => [d.change, d.skipped])),
      statements: dry.statements.length,
    }),
    note: notes.join('\n'),
    confirmLabel: t('rollback.confirm', { n: dry.statements.length }),
  };
  const modes = runModes('redo', stepView, dry,
    await foldedDry('redo', session, { changeIds, includeApplied: again }));
  const go = await state.panel.preview({
    title: again ? t('redo.againTitle') : t('redo.title'),
    ...stepView,
    modes,
    confirmKind: 'danger',
  });
  if (!go) return { ...dry, cancelled: true };
  if (modes) await rememberMode(go);

  try {
    Object.assign(report, await runRedo(state.ctx, session, {
      changeIds,
      includeApplied: again,
      compact: go === 'compact',
      driftCheck: state.settings.driftCheck,
      onDrift: askAboutDrift,
      onProgress: ({ phase, i, n }) => {
        if (phase === 'run') state.panel.progress(t('rollback.running', { i, n }), i - 1, n);
      },
    }));
  } finally {
    state.panel.progress(null);
  }

  reportRollback(report);
  await refresh();
  return report;
}

/**
 * Undo the most recent change on its own.
 *
 * The everyday correction — a value typed wrong, noticed one screen later — and
 * the only alternative on the panel was rolling the whole session back.
 */
export async function undoLast() {
  const session = state.session || (await refresh());
  const pending = ((session && session.changes) || [])
    .filter((c) => !c.undone)
    .sort((a, b) => b.seq - a.seq);
  if (!pending.length) {
    state.panel.notice(t('rollback.nothing'), 'warn');
    state.panel.expand();
    return;
  }
  await rollback({ changeIds: [pending[0].id] });
}

/**
 * What the run came to, in the panel's own log.
 *
 * "Done: 2 succeeded, 0 failed" was all it said, and said it for a rollback that
 * had quietly skipped three changes it could not undo and left those rows as the
 * test made them. Skips and the database's own error message are the two things
 * worth knowing afterwards, so both are said out loud.
 */
function reportRollback(report) {
  state.panel.log(t('rollback.done', { ok: report.ok, fail: report.failed }), report.failed ? 'err' : 'ok');
  if (report.skipped) state.panel.log(t('rollback.skippedDone', { n: report.skipped }), 'warn');
  const bad = (report.details || []).find((d) => d.ok === false && (d.errors || []).length);
  if (bad) state.panel.log(t('rollback.failedWith', { reason: bad.errors[0] }), 'err');
  if (report.failed || report.skipped) state.panel.expand();
}
