/**
 * result-export.js — the result file of a CSV data-driven run, as CSV, HTML
 * (screenshots inline as base64), XLSX (screenshots anchored in their cells) or
 * ZIP (results.csv plus one folder of screenshots per row).
 *
 * Pure: takes the parsed CSV, the per-row results and the screenshots, returns
 * text or a Blob. Downloading is the caller's job.
 */

import { applyVars } from '../../bg/interpolate.js';
import { rowVerdict, verdictLabel } from '../../shared/verdict.js';
import { buildScreenshotFilename, safeName } from '../../bg/screenshot/filename.js';
import { ZipWriter } from '../lib/zip-writer.js';

function _b64Bytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Format failures array into a human-readable bug string
function _formatBug(failures) {
  if (!failures || failures.length === 0) return "";
  return failures.map(f => {
    const label = f.label ? ` "${f.label}"` : "";
    // A failure recorded before reasons were kept reads as it did.
    return `[${f.index}] ${f.type}${label}${f.reason ? `: ${f.reason}` : ""}`;
  }).join("; ");
}

// The columns every result file ends with. Told apart by position, not by name:
// a column of the CSV itself may have the same name, and keeps its own values.
const RESULT_COLS = ["Run Result", "Action Failed"];

/** The cells of RESULT_COLS for a row. */
function _resultCells(r) {
  return [verdictLabel(rowVerdict(r)), _formatBug(r.failures)];
}

// Build and download result CSV after a CSV run
export function generateResultCsv(originalHeaders, originalRows, results) {
  // Collect any extra columns captured by readdom that weren't in original headers
  const extraCols = [];
  const headerSet = new Set(originalHeaders);
  results.forEach(r => {
    Object.keys(r.vars || {}).forEach(k => {
      if (!headerSet.has(k)) { extraCols.push(k); headerSet.add(k); }
    });
  });
  const dataHeaders = [...originalHeaders, ...extraCols];

  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [[...dataHeaders, ...RESULT_COLS].map(escape).join(",")];

  results.forEach((r) => {
    const origRow = originalRows[r.rowIndex] || {};
    const cells = [...dataHeaders.map(h => r.vars?.[h] ?? origRow[h] ?? ""), ..._resultCells(r)];
    lines.push(cells.map(escape).join(","));
  });
  return lines.join("\r\n");
}

// Build full-header list. Screenshot columns are always placed last in the
// action-capture order given by ssVarOrder, so the XLSX/HTML columns match
// the scenario's action sequence regardless of CSV or baseVars ordering.
function _buildAllHeaders(originalHeaders, results, screenshots, ssVarOrder) {
  const ssSet = new Set(ssVarOrder || []);

  // Non-screenshot base headers (CSV columns, excluding screenshot varNames)
  const baseHeaders = originalHeaders.filter(h => !ssSet.has(h));
  const headerSet   = new Set(baseHeaders);

  // Extra vars produced by the run (readdom, etc.) — excluding screenshot vars
  const extra = [];
  results.forEach(r => {
    Object.keys(r.vars || {}).forEach(k => {
      if (!headerSet.has(k) && !ssSet.has(k)) { extra.push(k); headerSet.add(k); }
    });
  });

  // Screenshot columns: start with ssVarOrder (action order), then append any
  // varNames found in screenshots that are not yet covered — this handles nested
  // scenarios reached via Switch whose varNames may not be in ssVarOrder.
  const ssHeaders = ssVarOrder && ssVarOrder.length > 0 ? [...ssVarOrder] : [];
  const ssHeaderSet = new Set([...Array.from(headerSet), ...ssHeaders]);
  // Fallback: add vars from results that slipped through (readdom-style outputs)
  if (!ssVarOrder || ssVarOrder.length === 0) {
    results.forEach(r => {
      Object.keys(r.vars || {}).forEach(k => {
        if (!ssHeaderSet.has(k)) { ssHeaders.push(k); ssHeaderSet.add(k); }
      });
    });
  }
  // Always sweep screenshots to catch any varName not yet covered
  Object.keys(screenshots || {}).forEach(key => {
    const vn = key.split(':').slice(1).join(':');
    if (!ssHeaderSet.has(vn)) { ssHeaders.push(vn); ssHeaderSet.add(vn); }
  });

  return [...baseHeaders, ...extra, ...ssHeaders];
}

// Colour of a Run Result cell in the HTML file.
const VERDICT_COLOR = { passed: '#16a34a', failed: '#dc2626', broken: '#d97706', stopped: '#6b7280' };

// HTML export — images as base64 <img> tags
export function generateResultHtml(originalHeaders, originalRows, results, screenshots, ssVarOrder) {
  const allHeaders = _buildAllHeaders(originalHeaders, results, screenshots, ssVarOrder);
  const imgCols = new Set();
  Object.keys(screenshots || {}).forEach(key => {
    const vn = key.split(':').slice(1).join(':');
    const ci = allHeaders.indexOf(vn);
    if (ci >= 0) imgCols.add(ci);
  });
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const hRow = [...allHeaders, ...RESULT_COLS].map((h, i) => `<th${imgCols.has(i) ? ' style="min-width:200px"' : ''}>${esc(h)}</th>`).join('');
  const rows = results.map(r => {
    const orig = originalRows[r.rowIndex] || {};
    const cells = allHeaders.map((h, ci) => {
      if (imgCols.has(ci)) {
        const b64 = (screenshots || {})[`${r.rowIndex}:${h}`];
        return b64 ? `<td><img src="data:image/png;base64,${b64}" style="max-width:200px;max-height:130px;display:block;border-radius:3px;"/></td>` : '<td></td>';
      }
      return `<td>${esc(r.vars?.[h] ?? orig[h] ?? '')}</td>`;
    }).join('');
    const [verdict, bugVal] = _resultCells(r);
    const bugStyle = bugVal ? ' style="color:#dc2626;font-weight:600;"' : '';
    return `<tr>${cells}<td style="color:${VERDICT_COLOR[rowVerdict(r)]};font-weight:600;white-space:nowrap;">${esc(verdict)}</td>`
      + `<td${bugStyle}>${esc(bugVal)}</td></tr>`;
  }).join('\n');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>CSV Result</title>
<style>body{font-family:sans-serif;font-size:13px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px 8px;vertical-align:top}th{background:#f3f4f6;font-weight:bold}tr:nth-child(even){background:#f9fafb}</style>
</head><body><h2>CSV Run Result (${results.length} rows)</h2>
<table><thead><tr>${hRow}</tr></thead><tbody>\n${rows}\n</tbody></table></body></html>`;
}

// XLSX export — images placed in cells via drawing anchors
export function generateResultXlsx(originalHeaders, originalRows, results, screenshots, ssVarOrder) {
  const allHeaders = _buildAllHeaders(originalHeaders, results, screenshots, ssVarOrder);
  const ss = screenshots || {};

  // Which columns have images
  const imgColIdx = new Set();
  Object.keys(ss).forEach(key => {
    const vn = key.split(':').slice(1).join(':');
    const ci = allHeaders.indexOf(vn);
    if (ci >= 0) imgColIdx.add(ci);
  });

  // Column ref: 0-indexed → A,B,...
  function colRef(n) {
    let r = ''; let c = n + 1;
    while (c > 0) { c--; r = String.fromCharCode(65 + (c % 26)) + r; c = Math.floor(c / 26); }
    return r;
  }
  function xmlEsc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Shared strings
  const strs = []; const strMap = new Map();
  function addStr(s) {
    const key = String(s ?? '');
    if (!strMap.has(key)) { strMap.set(key, strs.length); strs.push(key); }
    return strMap.get(key);
  }

  // Rows XML
  const rowsXml = [];
  // Header row
  const hCells = [...allHeaders, ...RESULT_COLS].map((h, ci) => `<c r="${colRef(ci)}1" t="s"><v>${addStr(h)}</v></c>`).join('');
  rowsXml.push(`<row r="1">${hCells}</row>`);

  // Data rows
  results.forEach((r, di) => {
    const rowNum = di + 2;
    const orig = originalRows[r.rowIndex] || {};
    const hasImg = Object.keys(ss).some(k => parseInt(k.split(':')[0],10) === r.rowIndex);
    const values = [...allHeaders.map((h) => String(r.vars?.[h] ?? orig[h] ?? '')), ..._resultCells(r)];
    const cells = values.map((val, ci) => {
      if (imgColIdx.has(ci)) return ''; // leave empty — image goes in drawing
      const si = addStr(val);
      return `<c r="${colRef(ci)}${rowNum}" t="s"><v>${si}</v></c>`;
    }).join('');
    const rowAttr = hasImg ? ` ht="80" customHeight="1"` : '';
    rowsXml.push(`<row r="${rowNum}"${rowAttr}>${cells}</row>`);
  });

  // Columns override for image columns
  let colsXml = '';
  if (imgColIdx.size > 0) {
    const defs = [...imgColIdx].map(ci => `<col min="${ci+1}" max="${ci+1}" width="28" customWidth="1"/>`).join('');
    colsXml = `<cols>${defs}</cols>`;
  }

  // Images
  const imageEntries = [];
  const anchors = [];
  const imgRels = [];
  let picIdx = 1;
  Object.entries(ss).forEach(([key, base64]) => {
    const colon = key.indexOf(':');
    const rowIdx = parseInt(key.slice(0, colon), 10);
    const vn = key.slice(colon + 1);
    const ci = allHeaders.indexOf(vn);
    if (ci < 0) return;
    const dataRowIdx = results.findIndex(r => r.rowIndex === rowIdx);
    if (dataRowIdx < 0) return;
    const col0 = ci;
    const row0 = dataRowIdx + 1; // +1 for header, 0-indexed for drawing
    const cx = 1905000, cy = 952500; // 200×100px in EMU
    anchors.push(`<xdr:oneCellAnchor>
  <xdr:from><xdr:col>${col0}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row0}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
  <xdr:ext cx="${cx}" cy="${cy}"/>
  <xdr:pic>
    <xdr:nvPicPr><xdr:cNvPr id="${picIdx+1}" name="Img${picIdx}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
    <xdr:blipFill><a:blip r:embed="rId${picIdx}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
    <xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
  </xdr:pic>
  <xdr:clientData/>
</xdr:oneCellAnchor>`);
    imgRels.push(`<Relationship Id="rId${picIdx}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${picIdx}.png"/>`);
    imageEntries.push({ base64, idx: picIdx });
    picIdx++;
  });

  const hasImages = imageEntries.length > 0;
  const drawingRef = hasImages ? '<drawing r:id="rId1"/>' : '';

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${colsXml}<sheetData>${rowsXml.join('')}</sheetData>${drawingRef}</worksheet>`;

  const ssXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strs.length}" uniqueCount="${strs.length}">
${strs.map(s => `<si><t xml:space="preserve">${xmlEsc(s)}</t></si>`).join('')}</sst>`;

  const drawingXml = hasImages ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${anchors.join('\n')}</xdr:wsDr>` : '';

  const drawingRelsXml = hasImages ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${imgRels.join('\n')}</Relationships>` : '';

  const imgCT   = hasImages ? '\n  <Default Extension="png" ContentType="image/png"/>' : '';
  const drawCT  = hasImages ? '\n  <Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '';

  const zip = new ZipWriter();
  zip.add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>${imgCT}
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${drawCT}
</Types>`);
  zip.add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.add('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.add('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  zip.add('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`);
  zip.add('xl/sharedStrings.xml', ssXml);
  zip.add('xl/worksheets/sheet1.xml', sheetXml);

  if (hasImages) {
    zip.add('xl/worksheets/_rels/sheet1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`);
    zip.add('xl/drawings/drawing1.xml', drawingXml);
    zip.add('xl/drawings/_rels/drawing1.xml.rels', drawingRelsXml);
    for (const img of imageEntries) zip.add(`xl/media/image${img.idx}.png`, _b64Bytes(img.base64));
  }

  return zip.build('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

const _rowNum = (rowIndex) => String(rowIndex + 1).padStart(2, '0');

// A row's folder: the template with the row's values (+ _NN with `rowNumber`), or
// row_NN when that comes out empty. Windows refuses a folder name that ends in "."
// or a space.
function _folderName(template, vars, rowIndex, rowNumber) {
  const name = template && safeName(applyVars(template, vars)).replace(/\//g, '_').replace(/[. ]+$/, '');
  if (!name) return `row_${_rowNum(rowIndex)}`;
  return rowNumber ? `${name}_${_rowNum(rowIndex)}` : name;
}

// `base`, else base_2, base_3 … — the first name `used` does not hold yet. Case is
// ignored: Windows sees John/ and john/ as one folder.
function _unique(used, base) {
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}`;
  used.add(name.toLowerCase());
  return name;
}

/**
 * The screenshot files of the ZIP export as [path, base64] pairs, in the order the
 * screenshots come. Each row is one folder: row_NN, or `folderName` with ${column}
 * filled in from that row (a variable the run wrote wins over the CSV column) and,
 * with `rowNumber`, the row's number in the CSV after it (abc john_01). Two rows
 * that land on one name get _2, _3 … in row order. An image is named by its
 * Screenshot → Variable's Filename as the row filled it in (result.ssNames; "a/b"
 * makes a subfolder, as for a screenshot's Filename), else by its variable; two
 * images on one name in a folder get _2 too.
 */
export function zipEntries(rows, results, screenshots, { folderName = '', rowNumber = false } = {}) {
  const ss = screenshots || {};
  const template = folderName.trim();
  const rowOf = (key) => Number(key.slice(0, key.indexOf(':')));
  const byRow = new Map(results.map((r) => [r.rowIndex, r]));
  // Named in row order, not key order: IndexedDB sorts the key "10:a" before "2:a".
  const indexes = [...new Set([...byRow.keys(), ...Object.keys(ss).map(rowOf)])].sort((a, b) => a - b);
  const used = new Set();
  const folders = new Map(indexes.map((i) =>
    [i, _unique(used, _folderName(template, { ...rows[i], ...byRow.get(i)?.vars }, i, rowNumber))]));
  const filesIn = new Map(indexes.map((i) => [i, new Set()]));
  return Object.entries(ss).map(([key, b64]) => {
    const i = rowOf(key);
    const vn = key.slice(key.indexOf(':') + 1);
    const named = byRow.get(i)?.ssNames?.[vn];
    const file = named ? buildScreenshotFilename('', named) : `${vn}.png`;
    return [`${folders.get(i)}/${_unique(filesIn.get(i), file.slice(0, -4))}.png`, b64];
  });
}

// ZIP export — results.csv (with a BOM, so Excel reads it as UTF-8) and zipEntries.
export function generateResultZip(originalHeaders, originalRows, results, screenshots, naming) {
  const zip = new ZipWriter();
  zip.add('results.csv', '﻿' + generateResultCsv(originalHeaders, originalRows, results));
  for (const [path, b64] of zipEntries(originalRows, results, screenshots, naming)) zip.add(path, _b64Bytes(b64));
  return zip.build('application/zip');
}
