/**
 * ui/schema.js — the schema pane and the table diagram.
 */

import { keyTag, mountDiagram } from '../diagram.js';
import { t } from '../i18n.js';
import { el, node } from './dom.js';
import { renderRail } from './layout.js';
import { view } from './state.js';

/**
 * The schema the fixtures were built against.
 *
 * Shown because every generated value depends on it: if a type or a foreign key
 * was guessed wrong, this panel is where that becomes visible, before the
 * tester has typed the data in somewhere.
 */
export function renderSchema() {
  el.schemaBody.replaceChildren();
  const tables = view.data?.schema.tables || [];
  // A diagram left open across a run would be a picture of the query before
  // it: redraw it from the new schema, or shut it if there is no longer one.
  if (diagram) {
    if (tables.length) openDiagram();
    else closeDiagram();
  }
  if (!tables.length) {
    el.schemaSummary.textContent = '';
    renderRail();
    return;
  }

  tables.forEach(tbl => {
    const box = node('div', 'sc-table');
    const head = node('div', 'sc-name', tbl.name);
    if (tbl.alias) head.append(node('span', 'chip-type', ` ${tbl.alias}`));
    box.append(head);

    const cols = node('div', 'sc-cols');
    tbl.columns.forEach(c => {
      const row = node('div', 'sc-col');
      row.append(node('span', 'sc-col-name', c.name));
      row.append(node('span', 'sc-col-type', c.type));
      // Every badge goes in the same right-hand lane, so PK, FK and NOT NULL
      // line up down the panel instead of each landing wherever its own text
      // happened to run out.
      const tags = node('div', 'sc-col-tags');
      const tag = keyTag(c, { showTarget: true, showNotNull: true });
      if (tag) tags.append(tag);
      if (c.synthetic) tags.append(node('span', 'chip-type', t('dg.synthetic')));
      if (tags.childElementCount) row.append(tags);
      cols.append(row);
    });
    box.append(cols);
    el.schemaBody.append(box);
  });

  view.data.schema.notes.forEach(n => {
    el.schemaBody.append(node('div', 'fx-note', t(n.key, n.params)));
  });

  el.schemaSummary.textContent = t('ui.sumSchema', {
    tables: tables.length,
    columns: tables.reduce((sum, x) => sum + x.columns.length, 0)
  });
  renderRail();
}

/**
 * The open diagram, or null. It owns listeners on the stage and boxes of its
 * own making, so it is torn down rather than left to be garbage — and it is
 * rebuilt on every open, because the schema behind it changes with every run.
 */
export let diagram = null;

export function openDiagram() {
  const tables = view.data?.schema.tables || [];
  if (!tables.length) return;

  el.diagramModal.hidden = false;
  // Mounted only once the modal is on screen: the boxes are measured as they
  // are built, and a box inside `hidden` measures nothing at all.
  diagram?.destroy();
  diagram = mountDiagram({
    stage: el.dgStage,
    world: el.dgWorld,
    svg: el.dgLinks,
    tables,
    onZoom: (scale) => { el.dgZoom.textContent = `${Math.round(scale * 100)}%`; }
  });

  el.dgCount.textContent = t('dg.diagramCount', { tables: diagram.tables, links: diagram.links });
  // A query over one table has nothing to link, which is worth saying outright
  // rather than leaving the reader to wonder where the lines went.
  el.dgHint.textContent = t(diagram.links ? 'dg.diagramHint' : 'dg.diagramNoLinks');
  diagram.fit();
}

export function closeDiagram() {
  el.diagramModal.hidden = true;
  diagram?.destroy();
  diagram = null;
}
