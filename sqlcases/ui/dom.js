/**
 * ui/dom.js — the page's elements, looked up once, and a small node() builder.
 */

// ---- element handles -------------------------------------------------

const $ = id => document.getElementById(id);

export const el = {
  app: $('app'),
  // rail
  rail: $('rail'),
  railTabs: $('railTabs'),
  railClose: $('btnRailClose'),
  railToggle: $('btnRail'),
  railTabSqlLabel: $('railTabSqlLabel'),
  railTechCount: $('railTechCount'),
  railValuesCount: $('railValuesCount'),
  railSchemaCount: $('railSchemaCount'),
  // rail: query pane
  sql: $('sqlInput'),
  sqlLabel: $('sqlLabel'),
  modeToggle: $('modeToggle'),
  sqlAfterCard: $('sqlAfterCard'),
  sqlAfter: $('sqlInputAfter'),
  parseErrors: $('parseErrors'),
  parseErrorsAfter: $('parseErrorsAfter'),
  sample: $('sampleSelect'),
  clear: $('btnClear'),
  parseStatus: $('parseStatus'),
  analyze: $('btnAnalyze'),
  // rail: technique pane
  techList: $('techList'),
  techSummary: $('techSummary'),
  maxFull: $('optMaxFull'),
  joinConds: $('optJoinConds'),
  // rail: values pane
  valuesBody: $('valuesBody'),
  valuesSummary: $('valuesSummary'),
  resetValues: $('btnResetValues'),
  // rail: schema pane
  schemaBody: $('schemaBody'),
  schemaSummary: $('schemaSummary'),
  diagramBtn: $('btnDiagram'),
  // the diagram modal
  diagramModal: $('diagramModal'),
  dgStage: $('dgStage'),
  dgWorld: $('dgWorld'),
  dgLinks: $('dgLinks'),
  dgZoom: $('dgZoom'),
  dgCount: $('dgCount'),
  dgHint: $('dgHint'),
  dgClose: $('btnDgClose'),
  dgFit: $('btnDgFit'),
  dgZoomIn: $('btnDgZoomIn'),
  dgZoomOut: $('btnDgZoomOut'),
  // centre: head
  exportBtn: $('btnExport'),
  exportMenu: $('exportMenu'),
  inspToggle: $('btnInsp'),
  csv: $('btnCsv'),
  json: $('btnJson'),
  copyJson: $('btnCopyJson'),
  dataCsv: $('btnDataCsv'),
  verifySql: $('btnVerifySql'),
  // centre: triage
  triage: $('triage'),
  triChangedN: $('triChangedN'),
  triUnrelatedN: $('triUnrelatedN'),
  triStaleN: $('triStaleN'),
  // centre: insight
  insight: $('insight'),
  insightTabs: $('insightTabs'),
  insightToggle: $('btnInsight'),
  diffBody: $('diffBody'),
  findings: $('findings'),
  findingsDot: $('findingsDot'),
  coverage: $('coverage'),
  staleBody: $('staleBody'),
  analysisBody: $('analysisBody'),
  itabDiffN: $('itabDiffN'),
  itabFindingsN: $('itabFindingsN'),
  itabCoverageN: $('itabCoverageN'),
  itabStaleN: $('itabStaleN'),
  // centre: command bar
  cmdbarDock: $('cmdbarDock'),
  cmdbar: $('cmdbar'),
  search: $('searchBox'),
  filtersBtn: $('btnFilters'),
  filterPop: $('filterPop'),
  filterCount: $('filterCount'),
  clearFilters: $('btnClearFilters'),
  closeFilters: $('btnCloseFilters'),
  density: $('density'),
  techFilter: $('techFilter'),
  prioFilter: $('prioFilter'),
  clauseFilter: $('clauseFilter'),
  columnFilter: $('columnFilter'),
  fixtureFilter: $('fixtureFilter'),
  // centre: list
  listwrap: $('listwrap'),
  caseList: $('caseList'),
  empty: $('emptyState'),
  emptySteps: $('emptySteps'),
  emptyClear: $('btnEmptyClear'),
  // right: inspector
  insp: $('insp'),
  inspInner: $('inspInner'),
  // chrome
  theme: $('toggleTheme'),
  lang: $('toggleLang'),
  langLabel: $('langLabel'),
  help: $('btnHelp'),
  helpModal: $('helpModal'),
  helpClose: $('btnHelpClose'),
  toast: $('toast'),
  stats: {
    total: $('statTotal'), high: $('statHigh'),
    conds: $('statConds'), joins: $('statJoins'), tables: $('statTables')
  }
};

/** The rail panes, keyed by the tab that shows them. */
export const RAIL_PANES = { sql: $('paneSql'), tech: $('paneTech'), values: $('paneValues'), schema: $('paneSchema') };

/** The insight panes, keyed by the tab that shows them. */
export const INSIGHT_PANES = {
  diff: $('paneDiff'), findings: $('paneFindings'), coverage: $('paneCoverage'),
  stale: $('paneStale'), analysis: $('paneAnalysis')
};

// ---- small helpers ---------------------------------------------------

export function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
