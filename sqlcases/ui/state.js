/**
 * ui/state.js — state of the page that more than one of its modules writes: the last
 * result, the filters, the selected case, the mode, the layout (rail, inspector,
 * insight, density).
 *
 * One object so every module reads and writes the same values (an imported
 * binding cannot be assigned). Values that one module alone writes are
 * exported from that module instead.
 */

export const view = {
  /** Last generation result, and the filter state applied on top of it. */
  current: null,
  activeTechnique: '',
  activeClause: '',
  activeColumn: '',
  activeImpact: '',
  onlyWithFixture: false,
  /** Inferred schema and per-case fixtures for the current result. */
  data: null,
  /**
   * True when the last buildAllFixtures() call threw instead of producing
   * `data`. Lets the inspector's "no fixture" message tell a genuine no-fixture
   * case (by design) apart from every case going fixture-less because
   * generation itself blew up — those looked identical before this flag
   * existed. Only fires the toast on the rising edge so re-running the same
   * broken query on every keystroke doesn't spam it.
   */
  fixtureError: false,
  /** The one case the inspector is showing, or null. */
  selectedId: null,
  /** 'single' analyses #sqlInput alone; 'compare' diffs it against #sqlInputAfter. */
  mode: 'single',
  /** Cases from the "before" query whose source no longer exists (compare mode). */
  staleCases: [],
  // ---- layout state ----------------------------------------------------

  /**
   * Which of the two collapsible columns are open, which tab each tabbed block
   * is on, and how tall a case card is.
   *
   * Persisted, because all six are decisions about how the user wants to work
   * rather than about one query: someone who runs on a laptop with the rail shut
   * and the list dense wants that back tomorrow, not a fresh three-column page.
   */
  railTab: 'sql',
  railOpen: true,
  inspOpen: true,
  insightTab: '',
  insightOpen: false,
  density: 'full',
  /**
   * What was shut before the search box was typed into, or null when it is empty.
   *
   * A search is a request to see what matched, so it opens everything: leaving a
   * group shut would hide the very rows the box was typed to find and read as
   * "no results". Shutting a group while a search is running still works, and
   * clearing the box puts the list back in the shape it had before.
   */
  collapsedBeforeSearch: null,
  /**
   * True while a run is in flight.
   *
   * The panes report in one at a time — analysis, then findings, then coverage,
   * then the diff — and each asks for a redraw as it lands. Without this, the
   * first one to report is briefly the *only* thing available, and the tab
   * fallback below would treat the reader's chosen tab as gone and move them off
   * it. run() raises this for the whole pipeline and resolves the tab once, at
   * the end, when every pane has actually said whether it has anything.
   */
  insightSettling: false,
};

/**
 * Group headings the reader has shut, by name.
 *
 * Kept in memory rather than in storage: a collapsed group is a statement
 * about the list on screen right now ("I have read the eight cancelled_at
 * cases, get them out of my way"), and carrying it into tomorrow's query —
 * whose groups are named after different columns — would only ever surprise.
 */
export const collapsedGroups = new Set();

/**
 * Which insight tabs have anything behind them, and what their badges say.
 *
 * The render functions own these: each sets its own slot and then asks
 * renderInsight() to redraw. Keeping availability here rather than as a
 * `hidden` flag on the pane itself is what lets one pane be "has content" and
 * "not the tab you are looking at" at the same time — a distinction the old
 * accordions never had to make.
 */
export const insight = {
  diff: { available: false, count: 0 },
  findings: { available: false, count: 0, level: '' },
  coverage: { available: false, count: 0 },
  stale: { available: false, count: 0 },
  analysis: { available: false }
};
