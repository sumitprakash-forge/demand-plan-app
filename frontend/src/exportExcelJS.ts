import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import { fetchSummaryAll } from './api';
import type { AccountConfig } from './App';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UseCase {
  name: string;
  domain: string;
  steadyStateDbu: number;
  onboardingMonth: number;
  liveMonth: number;
  rampType: string;
  scenarios: boolean[];
  monthlyProjection: number[];
  cloud?: string;
  assumptions?: string;
  skuBreakdown?: { sku: string; percentage: number; dbus: number; dollarDbu: number }[];
}

export interface ScenarioExportData {
  scenarioNum: 1 | 2 | 3;
  assumptions: string;
  baselineGrowthRate: number; // e.g. 2.0 = 2% MoM
  activeUseCases: UseCase[];
  baselineMonths: number[];   // length 36
  totalMonths: number[];      // length 36
  baseYearTotals: number[];   // length 3
  ucYearTotals: number[];     // length 3
  yearTotals: number[];       // length 3
}

export interface ExportOptions {
  accounts: AccountConfig[];
  account: string;
  historicalData: any[];
  domainMapping: Record<string, string>;
  wsCloud: Record<string, string>;
  wsOrg: Record<string, string>;
  domainBaselines: { domain: string; t12m: number; avgMonthly: number }[];
  allUseCases: UseCase[];        // all UCs (unfiltered) for Use Case Details + SKU Breakdown
  scenariosData: ScenarioExportData[];
}

// ─── Design tokens ────────────────────────────────────────────────────────────

const BRAND        = '1F3B6E';
const ACCENT       = 'FF3621';
const HEADER_BG    = '1F3B6E';
const HEADER_FG    = 'FFFFFF';
const SUBHEADER_BG = 'E8EDF5';
const SUBHEADER_FG = '1F3B6E';
const TOTAL_BG     = 'D6E4F0';
const TOTAL_FG     = '0D2B5A';
const ALT_ROW_BG   = 'F7F9FC';
const GRAND_BG     = 'C5D8EE';

const SCENARIO_COLORS: Record<number, { bg: string; light: string; text: string }> = {
  1: { bg: '1F3B6E', light: 'EFF6FF', text: '1D4ED8' },
  2: { bg: '6B21A8', light: 'F5F3FF', text: '7C3AED' },
  3: { bg: '065F46', light: 'ECFDF5', text: '059669' },
};

const USD_FMT = '$#,##0';
const PCT_FMT = '0.0%';

// ─── Style helpers ────────────────────────────────────────────────────────────

function rgb(hex: string): Partial<ExcelJS.Color> {
  return { argb: 'FF' + hex };
}

function headerStyle(bgHex = HEADER_BG, fgHex = HEADER_FG): Partial<ExcelJS.Style> {
  return {
    font: { bold: true, color: rgb(fgHex), size: 10, name: 'Calibri' },
    fill: { type: 'pattern', pattern: 'solid', fgColor: rgb(bgHex) },
    alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
    border: {
      bottom: { style: 'thin', color: rgb('AAAAAA') },
      right:  { style: 'hair', color: rgb('DDDDDD') },
    },
  };
}

function totalStyle(bgHex = TOTAL_BG, fgHex = TOTAL_FG): Partial<ExcelJS.Style> {
  return {
    font: { bold: true, color: rgb(fgHex), size: 10, name: 'Calibri' },
    fill: { type: 'pattern', pattern: 'solid', fgColor: rgb(bgHex) },
    alignment: { vertical: 'middle' },
    border: {
      top:    { style: 'thin',   color: rgb('AAAAAA') },
      bottom: { style: 'medium', color: rgb('888888') },
    },
  };
}

function dataStyle(alt = false): Partial<ExcelJS.Style> {
  return {
    font: { size: 10, name: 'Calibri' },
    fill: alt
      ? { type: 'pattern', pattern: 'solid', fgColor: rgb(ALT_ROW_BG) }
      : { type: 'pattern', pattern: 'none' },
    alignment: { vertical: 'middle' },
    border: { right: { style: 'hair', color: rgb('E0E0E0') } },
  };
}

function applyRowStyle(row: ExcelJS.Row, style: Partial<ExcelJS.Style>, numFmt?: string) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    Object.assign(cell, { style: { ...cell.style, ...style } });
    if (numFmt && typeof cell.value === 'number') cell.numFmt = numFmt;
  });
  row.height = 18;
}

function addSheetTitle(ws: ExcelJS.Worksheet, title: string, subtitle: string, colCount: number) {
  const r1 = ws.addRow([title]);
  r1.height = 26;
  r1.getCell(1).style = {
    font: { bold: true, size: 14, color: rgb(BRAND), name: 'Calibri' },
    alignment: { vertical: 'middle' },
  };
  ws.mergeCells(r1.number, 1, r1.number, colCount);

  const r2 = ws.addRow([subtitle]);
  r2.height = 14;
  r2.getCell(1).style = {
    font: { italic: true, size: 9, color: rgb('666666'), name: 'Calibri' },
  };
  ws.mergeCells(r2.number, 1, r2.number, colCount);

  ws.addRow([]);
}

// ─── Projection sheet (HORIZONTAL) ───────────────────────────────────────────
// Rows = use cases, Columns = M1 … M36 + Y1/Y2/Y3/Grand Total

function buildProjectionSheet(wb: ExcelJS.Workbook, sd: ScenarioExportData) {
  const { scenarioNum, assumptions, baselineGrowthRate, activeUseCases,
          baselineMonths, totalMonths, baseYearTotals, ucYearTotals, yearTotals } = sd;

  const sc = SCENARIO_COLORS[scenarioNum];
  const sheetName = `S${scenarioNum} — Projection`;

  const ws = wb.addWorksheet(sheetName, {
    properties: { tabColor: { argb: 'FF' + sc.bg } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  });

  // Column defs: label col + M1-M36 + Y1 + Y2 + Y3 + Grand
  const totalCols = 1 + 36 + 4;
  ws.columns = [
    { key: 'label', width: 36 },
    ...Array.from({ length: 36 }, (_, i) => ({ key: `m${i + 1}`, width: 9 })),
    { key: 'y1', width: 14 },
    { key: 'y2', width: 14 },
    { key: 'y3', width: 14 },
    { key: 'grand', width: 16 },
  ];

  addSheetTitle(
    ws,
    `Scenario ${scenarioNum}  ·  36-Month Projection`,
    `Baseline growth: ${baselineGrowthRate.toFixed(1)}% MoM${assumptions ? '  ·  ' + assumptions : ''}`,
    totalCols
  );

  // Month header row: blank label | M1(Y1) … M12(Y1) | M13(Y2) … | Year totals
  const monthLabels = Array.from({ length: 36 }, (_, i) => {
    const yr = Math.floor(i / 12) + 1;
    const mo = (i % 12) + 1;
    return `M${mo}\nY${yr}`;
  });
  const hrow = ws.addRow(['', ...monthLabels, 'Y1 Total', 'Y2 Total', 'Y3 Total', 'Grand Total']);
  hrow.height = 30;
  hrow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.style = {
      font: { bold: true, color: rgb(HEADER_FG), size: 9, name: 'Calibri' },
      fill: { type: 'pattern', pattern: 'solid', fgColor: rgb(sc.bg) },
      alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
      border: { right: { style: 'hair', color: rgb('AAAAAA') } },
    };
    // Year-total columns get slightly lighter shade
    if (colNum > 37) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: rgb('2D4E8A') };
      cell.font = { bold: true, color: rgb(HEADER_FG), size: 9, name: 'Calibri' };
    }
  });

  // Add thin right border between years (after col 13, 25, 37)
  [13, 25, 37].forEach(col => {
    const c = hrow.getCell(col + 1); // +1 because col 1 is label
    c.border = { ...c.border, right: { style: 'medium', color: rgb('FFFFFF') } };
  });

  // Helper: build a data row [label, m1..m36, y1, y2, y3, grand]
  const ucYearSlice = (vals: number[], yr: number) =>
    vals.slice(yr * 12, (yr + 1) * 12).reduce((s, v) => s + v, 0);

  const addDataRow = (
    label: string,
    months: number[],
    style: Partial<ExcelJS.Style>,
    indent = 0
  ) => {
    const y1 = ucYearSlice(months, 0);
    const y2 = ucYearSlice(months, 1);
    const y3 = ucYearSlice(months, 2);
    const grand = y1 + y2 + y3;
    const r = ws.addRow([label, ...months, y1, y2, y3, grand]);
    r.height = 17;
    r.eachCell({ includeEmpty: true }, (cell, colNum) => {
      Object.assign(cell, { style: { ...cell.style, ...style } });
      if (colNum > 1 && typeof cell.value === 'number') {
        cell.numFmt = USD_FMT;
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      }
    });
    r.getCell(1).style = {
      ...style,
      alignment: { vertical: 'middle', indent },
      font: { ...(style.font as any), name: 'Calibri', size: 10 },
    };
    // Subtle column separator every 12 months
    [13, 25, 37].forEach(col => {
      const c = r.getCell(col + 1);
      c.border = { ...c.border, left: { style: 'thin', color: rgb('CCCCCC') } };
    });
    return r;
  };

  // Baseline row
  addDataRow('Baseline (Existing Consumption)', baselineMonths,
    { ...dataStyle(false), font: { bold: true, size: 10, name: 'Calibri', color: rgb('374151') } });

  // Use case rows
  const ucMonthTotals = new Array(36).fill(0);
  activeUseCases.forEach((uc, idx) => {
    const mp = uc.monthlyProjection;
    mp.forEach((v, i) => { ucMonthTotals[i] += v; });
    addDataRow(`  ↳ ${uc.name}`, mp, dataStyle(idx % 2 === 0));
  });

  // New use cases subtotal (only if there are any)
  if (activeUseCases.length > 0) {
    addDataRow('New Use Cases Subtotal', ucMonthTotals,
      { ...totalStyle(TOTAL_BG, TOTAL_FG) });
  }

  // Grand total
  addDataRow('Grand Total', totalMonths,
    { ...totalStyle(GRAND_BG, '0D2B5A'), font: { bold: true, size: 10, name: 'Calibri', color: rgb('0D2B5A') } });

  // Year-total summary block below
  ws.addRow([]);
  const yhRow = ws.addRow(['', 'Year 1', 'Year 2', 'Year 3', 'Grand Total']);
  yhRow.height = 18;
  [1, 2, 3, 4, 5].forEach(c => {
    yhRow.getCell(c).style = headerStyle(sc.bg);
  });

  const yLabels = ['Baseline', 'New Use Cases', 'Grand Total'];
  const yData = [baseYearTotals, ucYearTotals, yearTotals];
  const yBgs = [TOTAL_BG, 'E0F2FE', GRAND_BG];
  yLabels.forEach((label, li) => {
    const r = ws.addRow([label, yData[li][0], yData[li][1], yData[li][2],
      yData[li].reduce((s, v) => s + v, 0)]);
    r.height = 18;
    applyRowStyle(r, totalStyle(yBgs[li]));
    [2, 3, 4, 5].forEach(c => {
      if (typeof r.getCell(c).value === 'number') r.getCell(c).numFmt = USD_FMT;
    });
  });

  // Freeze first column + header rows so labels + month headers stay visible while scrolling
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 4, showGridLines: true }];
}

// ─── Summary sheet ────────────────────────────────────────────────────────────

async function buildSummarySheet(wb: ExcelJS.Workbook, opts: ExportOptions) {
  const ws = wb.addWorksheet('Demand Plan Summary', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    properties: { tabColor: { argb: 'FF' + BRAND } },
  });

  const accountNames = (opts.accounts || []).filter(a => a.name.trim()).map(a => a.name);
  if (accountNames.length === 0) accountNames.push(opts.account);

  const allSummaries: Record<string, any> = {};
  await Promise.all(accountNames.map(async (name) => {
    try { allSummaries[name] = await fetchSummaryAll(name); } catch {}
  }));

  ws.columns = [
    { key: 'indent', width: 3 },
    { key: 'label',  width: 44 },
    { key: 'y1',     width: 18 },
    { key: 'y2',     width: 18 },
    { key: 'y3',     width: 18 },
    { key: 'total',  width: 18 },
  ];

  addSheetTitle(ws, 'Demand Plan Summary', 'All prices are Databricks List Price', 6);

  for (let si = 0; si < 3; si++) {
    const sNum = si + 1;
    const sc = SCENARIO_COLORS[sNum];
    const firstAcct = allSummaries[accountNames[0]];
    const desc = firstAcct?.scenarios?.[si]?.description || `Scenario ${sNum}`;

    const secRow = ws.addRow(['', `SCENARIO ${sNum}  ·  ${desc.toUpperCase()}`]);
    secRow.height = 22;
    secRow.getCell(2).style = {
      font: { bold: true, size: 12, color: rgb('FFFFFF'), name: 'Calibri' },
      fill: { type: 'pattern', pattern: 'solid', fgColor: rgb(sc.bg) },
      alignment: { vertical: 'middle', indent: 1 },
    };
    ws.mergeCells(secRow.number, 2, secRow.number, 6);
    ws.addRow([]);

    const sh = ws.addRow(['', 'SUMMARY  —  Total $DBUs (List)', 'Year 1', 'Year 2', 'Year 3', 'Grand Total']);
    applyRowStyle(sh, headerStyle(sc.bg));
    sh.height = 20;

    let crossY1 = 0, crossY2 = 0, crossY3 = 0, crossTotal = 0;
    accountNames.forEach((name, idx) => {
      const gt = allSummaries[name]?.scenarios?.[si]?.summary_rows?.find((r: any) => r.use_case_area === 'Grand Total');
      const y1 = gt?.year1 || 0, y2 = gt?.year2 || 0, y3 = gt?.year3 || 0, tot = gt?.total || 0;
      crossY1 += y1; crossY2 += y2; crossY3 += y3; crossTotal += tot;
      const dr = ws.addRow(['', name, y1, y2, y3, tot]);
      applyRowStyle(dr, dataStyle(idx % 2 === 1), USD_FMT);
    });

    const gtr = ws.addRow(['', 'Grand Total', crossY1, crossY2, crossY3, crossTotal]);
    applyRowStyle(gtr, totalStyle(GRAND_BG));
    gtr.eachCell((c) => { if (typeof c.value === 'number') c.numFmt = USD_FMT; });

    ws.addRow([]);

    accountNames.forEach((name) => {
      const acctData = allSummaries[name]?.scenarios?.[si];
      const grandTotal = acctData?.summary_rows?.find((r: any) => r.use_case_area === 'Grand Total');
      const baseRow = acctData?.summary_rows?.find(
        (r: any) => !r.is_use_case && r.use_case_area !== 'Grand Total' && r.use_case_area !== 'New Use Cases'
      );
      const ucRows: any[] = acctData?.summary_rows?.filter((r: any) => r.is_use_case) || [];

      const dh = ws.addRow(['', `${name.toUpperCase()}  —  $DBUs List`, 'Year 1', 'Year 2', 'Year 3', 'Total']);
      applyRowStyle(dh, headerStyle(SUBHEADER_BG, SUBHEADER_FG));

      if (baseRow) {
        const br = ws.addRow(['', 'Existing — Live Use Cases', baseRow.year1, baseRow.year2, baseRow.year3, baseRow.total]);
        applyRowStyle(br, dataStyle(false), USD_FMT);
      }
      ucRows.forEach((row, idx) => {
        const ucName = (row.use_case_area || '').replace(/^\s*↳\s*/, '').trim();
        const r = ws.addRow(['', '  ↳ ' + ucName, row.year1, row.year2, row.year3, row.total]);
        applyRowStyle(r, dataStyle(idx % 2 === 1), USD_FMT);
      });

      const tot = ws.addRow(['', `Total (${name})`, grandTotal?.year1 || 0, grandTotal?.year2 || 0, grandTotal?.year3 || 0, grandTotal?.total || 0]);
      applyRowStyle(tot, totalStyle());
      tot.eachCell((c) => { if (typeof c.value === 'number') c.numFmt = USD_FMT; });
      ws.addRow([]);
    });

    ws.addRow([]);
  }

  ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: true }];
}

// ─── Historical sheets ────────────────────────────────────────────────────────

function buildHistoricalDomainSheet(wb: ExcelJS.Workbook, opts: ExportOptions) {
  const ws = wb.addWorksheet('Historical by Domain', {
    properties: { tabColor: { argb: 'FF2563EB' } },
  });
  const months = [...new Set(opts.historicalData.map(r => r.month))].sort();
  const domainMonthly: Record<string, Record<string, number>> = {};
  opts.historicalData.forEach(row => {
    const domain = opts.domainMapping[row.workspace_name] || 'Unmapped';
    const dbu = parseFloat(row.dollar_dbu_list) || 0;
    if (!domainMonthly[domain]) domainMonthly[domain] = {};
    domainMonthly[domain][row.month] = (domainMonthly[domain][row.month] || 0) + dbu;
  });
  const domainKeys = Object.keys(domainMonthly).sort(
    (a, b) => Object.values(domainMonthly[b]).reduce((s, v) => s + v, 0) -
              Object.values(domainMonthly[a]).reduce((s, v) => s + v, 0)
  );

  ws.columns = [{ key: 'domain', width: 32 }, ...months.map(m => ({ key: m, width: 13 })), { key: 'total', width: 16 }];
  addSheetTitle(ws, 'Historical Consumption by Domain', 'T12M actuals grouped by domain', months.length + 2);

  const hrow = ws.addRow(['Domain', ...months, 'Total']);
  applyRowStyle(hrow, headerStyle()); hrow.height = 20;

  domainKeys.forEach((d, idx) => {
    const vals = months.map(m => domainMonthly[d][m] || 0);
    const r = ws.addRow([d, ...vals, vals.reduce((s, v) => s + v, 0)]);
    applyRowStyle(r, dataStyle(idx % 2 === 1), USD_FMT);
  });

  const grandVals = months.map(m => domainKeys.reduce((s, d) => s + (domainMonthly[d][m] || 0), 0));
  const gr = ws.addRow(['Grand Total', ...grandVals, grandVals.reduce((s, v) => s + v, 0)]);
  applyRowStyle(gr, totalStyle(GRAND_BG));
  gr.eachCell((c) => { if (typeof c.value === 'number') c.numFmt = USD_FMT; });

  ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: true }];
}

function buildHistoricalSkuSheet(wb: ExcelJS.Workbook, opts: ExportOptions) {
  const ws = wb.addWorksheet('Historical by SKU', { properties: { tabColor: { argb: 'FF7C3AED' } } });
  const months = [...new Set(opts.historicalData.map(r => r.month))].sort();
  const skuMonthly: Record<string, Record<string, number>> = {};
  opts.historicalData.forEach(row => {
    const sku = row.sku || row.sku_name || 'Unknown';
    const dbu = parseFloat(row.dollar_dbu_list) || 0;
    if (!skuMonthly[sku]) skuMonthly[sku] = {};
    skuMonthly[sku][row.month] = (skuMonthly[sku][row.month] || 0) + dbu;
  });
  const skuKeys = Object.keys(skuMonthly).sort(
    (a, b) => Object.values(skuMonthly[b]).reduce((s, v) => s + v, 0) -
              Object.values(skuMonthly[a]).reduce((s, v) => s + v, 0)
  );

  ws.columns = [{ key: 'sku', width: 48 }, ...months.map(m => ({ key: m, width: 13 })), { key: 'total', width: 16 }];
  addSheetTitle(ws, 'Historical Consumption by SKU', 'T12M actuals grouped by Databricks SKU', months.length + 2);

  const hrow = ws.addRow(['SKU', ...months, 'Total']);
  applyRowStyle(hrow, headerStyle()); hrow.height = 20;

  skuKeys.forEach((s, idx) => {
    const vals = months.map(m => skuMonthly[s][m] || 0);
    const r = ws.addRow([s, ...vals, vals.reduce((a, v) => a + v, 0)]);
    applyRowStyle(r, dataStyle(idx % 2 === 1), USD_FMT);
  });

  const grandVals = months.map(m => skuKeys.reduce((s, k) => s + (skuMonthly[k][m] || 0), 0));
  const gr = ws.addRow(['Grand Total', ...grandVals, grandVals.reduce((s, v) => s + v, 0)]);
  applyRowStyle(gr, totalStyle(GRAND_BG));
  gr.eachCell((c) => { if (typeof c.value === 'number') c.numFmt = USD_FMT; });

  ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: true }];
}

function buildCloudDomainSkuSheet(wb: ExcelJS.Workbook, opts: ExportOptions) {
  const ws = wb.addWorksheet('Cloud · Domain · SKU', { properties: { tabColor: { argb: 'FF0891B2' } } });
  const months = [...new Set(opts.historicalData.map(r => r.month))].sort();
  const cloudData: Record<string, Record<string, Record<string, Record<string, number>>>> = {};

  opts.historicalData.forEach(row => {
    const cloud  = opts.wsCloud[row.workspace_name] || 'unknown';
    const domain = opts.domainMapping[row.workspace_name] || 'Unmapped';
    const sku    = row.sku || row.sku_name || 'Unknown';
    const dbu    = parseFloat(row.dollar_dbu_list) || 0;
    cloudData[cloud] ??= {};
    cloudData[cloud][domain] ??= {};
    cloudData[cloud][domain][sku] ??= {};
    cloudData[cloud][domain][sku][row.month] = (cloudData[cloud][domain][sku][row.month] || 0) + dbu;
  });

  ws.columns = [
    { key: 'cloud',  width: 12 }, { key: 'domain', width: 26 }, { key: 'sku', width: 42 },
    ...months.map(m => ({ key: m, width: 13 })), { key: 'total', width: 16 },
  ];
  addSheetTitle(ws, 'Historical: Cloud → Domain → SKU', 'Hierarchical breakdown of T12M actuals', months.length + 4);

  const hrow = ws.addRow(['Cloud', 'Domain', 'SKU', ...months, 'Total']);
  applyRowStyle(hrow, headerStyle()); hrow.height = 20;

  Object.keys(cloudData).sort().forEach(cloud => {
    const cloudTotal: Record<string, number> = {};
    Object.values(cloudData[cloud]).forEach(domains =>
      Object.values(domains).forEach(skus =>
        Object.entries(skus).forEach(([m, v]) => { cloudTotal[m] = (cloudTotal[m] || 0) + v; })
      )
    );
    const cTot = Object.values(cloudTotal).reduce((s, v) => s + v, 0);
    const cr = ws.addRow([cloud.toUpperCase(), '', '', ...months.map(m => cloudTotal[m] || 0), cTot]);
    applyRowStyle(cr, totalStyle('D1FAE5', '065F46'), USD_FMT);

    Object.keys(cloudData[cloud]).sort().forEach((domain) => {
      const domTotal: Record<string, number> = {};
      Object.values(cloudData[cloud][domain]).forEach(skus =>
        Object.entries(skus).forEach(([m, v]) => { domTotal[m] = (domTotal[m] || 0) + v; })
      );
      const dTot = Object.values(domTotal).reduce((s, v) => s + v, 0);
      const dr = ws.addRow(['', domain, '', ...months.map(m => domTotal[m] || 0), dTot]);
      applyRowStyle(dr, headerStyle(SUBHEADER_BG, SUBHEADER_FG), USD_FMT);

      Object.keys(cloudData[cloud][domain]).sort().forEach((sku, si) => {
        const skuData = cloudData[cloud][domain][sku];
        const sTot = Object.values(skuData).reduce((s, v) => s + v, 0);
        const r = ws.addRow(['', '', sku, ...months.map(m => skuData[m] || 0), sTot]);
        applyRowStyle(r, dataStyle(si % 2 === 1), USD_FMT);
      });
    });
  });

  ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: true }];
}

// ─── Use Case Details sheet ───────────────────────────────────────────────────

function buildUseCaseDetailsSheet(wb: ExcelJS.Workbook, opts: ExportOptions) {
  const ws = wb.addWorksheet('Use Case Details', { properties: { tabColor: { argb: 'FF059669' } } });
  ws.columns = [
    { key: 'name',    width: 32 }, { key: 'domain',  width: 22 }, { key: 'ss',   width: 18 },
    { key: 'onboard', width: 16 }, { key: 'live',    width: 12 }, { key: 'ramp', width: 14 },
    { key: 's1',      width: 6  }, { key: 's2',      width: 6  }, { key: 's3',   width: 6  },
    { key: 'y1',      width: 18 }, { key: 'y2',      width: 18 }, { key: 'y3',   width: 18 },
    { key: 'total',   width: 18 },
  ];

  addSheetTitle(ws, 'Use Case Details', 'All use cases across scenarios with year-by-year projections', 13);
  const hrow = ws.addRow(['Name', 'Domain', 'Steady-State $/mo', 'Onboard Month', 'Live Month', 'Ramp Type', 'S1', 'S2', 'S3', 'Year 1', 'Year 2', 'Year 3', 'Total']);
  applyRowStyle(hrow, headerStyle()); hrow.height = 22;

  opts.allUseCases.forEach((uc, idx) => {
    const yT = [0, 0, 0];
    uc.monthlyProjection.forEach((v, i) => { yT[Math.floor(i / 12)] += v; });
    const r = ws.addRow([
      uc.name, uc.domain, uc.steadyStateDbu,
      `M${uc.onboardingMonth}`, `M${uc.liveMonth}`,
      uc.rampType === 'hockey_stick' ? 'Hockey Stick' : 'Linear',
      uc.scenarios[0] ? '✓' : '', uc.scenarios[1] ? '✓' : '', uc.scenarios[2] ? '✓' : '',
      yT[0], yT[1], yT[2], yT.reduce((a, b) => a + b, 0),
    ]);
    applyRowStyle(r, dataStyle(idx % 2 === 1));
    [3, 10, 11, 12, 13].forEach(col => {
      const c = r.getCell(col);
      if (typeof c.value === 'number') c.numFmt = USD_FMT;
    });
    [7, 8, 9].forEach(col => {
      r.getCell(col).alignment = { horizontal: 'center', vertical: 'middle' };
      r.getCell(col).font = { color: rgb('059669'), bold: true, name: 'Calibri', size: 11 };
    });
  });

  const totRow = ws.addRow([
    'TOTAL', '', opts.allUseCases.reduce((s, uc) => s + uc.steadyStateDbu, 0),
    '', '', '', '', '', '',
    opts.allUseCases.reduce((s, uc) => s + uc.monthlyProjection.slice(0, 12).reduce((a, v) => a + v, 0), 0),
    opts.allUseCases.reduce((s, uc) => s + uc.monthlyProjection.slice(12, 24).reduce((a, v) => a + v, 0), 0),
    opts.allUseCases.reduce((s, uc) => s + uc.monthlyProjection.slice(24, 36).reduce((a, v) => a + v, 0), 0),
    opts.allUseCases.reduce((s, uc) => s + uc.monthlyProjection.reduce((a, v) => a + v, 0), 0),
  ]);
  applyRowStyle(totRow, totalStyle(GRAND_BG));
  [3, 10, 11, 12, 13].forEach(col => {
    const c = totRow.getCell(col);
    if (typeof c.value === 'number') c.numFmt = USD_FMT;
  });

  ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: true }];
}

// ─── Domain Baseline sheet ────────────────────────────────────────────────────

function buildDomainBaselineSheet(wb: ExcelJS.Workbook, opts: ExportOptions) {
  const ws = wb.addWorksheet('Domain Baseline', { properties: { tabColor: { argb: 'FF6366F1' } } });
  ws.columns = [{ key: 'domain', width: 32 }, { key: 't12m', width: 20 }, { key: 'avg', width: 20 }, { key: 'pct', width: 14 }];
  addSheetTitle(ws, 'Domain Baseline Summary', 'T12M consumption per domain used as projection baseline', 4);

  const hrow = ws.addRow(['Domain', 'T12M $DBU (List)', 'Avg Monthly', '% of Total']);
  applyRowStyle(hrow, headerStyle()); hrow.height = 20;

  const totalBL = opts.domainBaselines.reduce((s, b) => s + b.t12m, 0);
  opts.domainBaselines.forEach((b, idx) => {
    const pct = totalBL > 0 ? b.t12m / totalBL : 0;
    const r = ws.addRow([b.domain, b.t12m, b.avgMonthly, pct]);
    applyRowStyle(r, dataStyle(idx % 2 === 1));
    r.getCell(2).numFmt = USD_FMT;
    r.getCell(3).numFmt = USD_FMT;
    r.getCell(4).numFmt = PCT_FMT;
    // Heat-map: blue tint proportional to share
    const intensity = Math.round(200 - pct * 150);
    const hex = intensity.toString(16).padStart(2, '0');
    r.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${hex}${hex}FF` } };
  });

  const gtr = ws.addRow(['Grand Total', totalBL, totalBL / 12, 1]);
  applyRowStyle(gtr, totalStyle(GRAND_BG));
  gtr.getCell(2).numFmt = USD_FMT;
  gtr.getCell(3).numFmt = USD_FMT;
  gtr.getCell(4).numFmt = PCT_FMT;

  ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: true }];
}

// ─── SKU Breakdown sheet ──────────────────────────────────────────────────────

function buildSkuBreakdownSheet(wb: ExcelJS.Workbook, opts: ExportOptions) {
  const ws = wb.addWorksheet('SKU Breakdown', { properties: { tabColor: { argb: 'FFEA580C' } } });
  ws.columns = [
    { key: 'uc',    width: 32 }, { key: 'sku',   width: 28 }, { key: 'cloud', width: 10 },
    { key: 'pct',   width: 10 }, { key: 'dbus',  width: 14 }, { key: 'price', width: 12 },
    { key: 'dollar',width: 16 }, { key: 'notes', width: 52 },
  ];
  addSheetTitle(ws, 'Use Case SKU Breakdown', 'Per-use-case SKU allocation, pricing, and assumptions', 8);

  const hrow = ws.addRow(['Use Case', 'SKU', 'Cloud', '% Split', 'DBUs/mo', '$/DBU', '$/month', 'Assumptions']);
  applyRowStyle(hrow, headerStyle()); hrow.height = 20;

  opts.allUseCases.forEach((uc) => {
    if (!uc.skuBreakdown?.length) return;
    uc.skuBreakdown.forEach((alloc, idx) => {
      const price = alloc.dbus > 0 ? alloc.dollarDbu / alloc.dbus : 0;
      const r = ws.addRow([
        idx === 0 ? uc.name : '',
        alloc.sku,
        idx === 0 ? (uc.cloud || '') : '',
        alloc.percentage / 100,
        Math.round(alloc.dbus), price, alloc.dollarDbu,
        idx === 0 ? (uc.assumptions || '') : '',
      ]);
      applyRowStyle(r, dataStyle(idx % 2 === 1));
      r.getCell(4).numFmt = PCT_FMT;
      r.getCell(6).numFmt = '$#,##0.00';
      r.getCell(7).numFmt = USD_FMT;
      r.getCell(8).alignment = { wrapText: true, vertical: 'top' };
      if (idx === 0) r.getCell(1).font = { bold: true, size: 10, name: 'Calibri' };
    });

    const totDbus   = uc.skuBreakdown.reduce((s, a) => s + a.dbus, 0);
    const totDollar = uc.skuBreakdown.reduce((s, a) => s + a.dollarDbu, 0);
    const totPct    = uc.skuBreakdown.reduce((s, a) => s + a.percentage, 0);
    const sub = ws.addRow(['', 'SUBTOTAL', '', totPct / 100, Math.round(totDbus),
      totDbus > 0 ? totDollar / totDbus : 0, totDollar, '']);
    applyRowStyle(sub, totalStyle(TOTAL_BG));
    sub.getCell(4).numFmt = PCT_FMT;
    sub.getCell(6).numFmt = '$#,##0.00';
    sub.getCell(7).numFmt = USD_FMT;
  });

  ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: true }];
}

// ─── Main export entry point ──────────────────────────────────────────────────

export async function exportToExcelJS(opts: ExportOptions): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Demand Plan App';
  wb.created = new Date();
  wb.properties.date1904 = false;

  await buildSummarySheet(wb, opts);
  buildHistoricalDomainSheet(wb, opts);
  buildHistoricalSkuSheet(wb, opts);
  buildCloudDomainSkuSheet(wb, opts);

  // One horizontal projection sheet per scenario
  for (const sd of opts.scenariosData) {
    buildProjectionSheet(wb, sd);
  }

  buildUseCaseDetailsSheet(wb, opts);
  buildDomainBaselineSheet(wb, opts);
  buildSkuBreakdownSheet(wb, opts);

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const filename = `Demand_Plan_${opts.account}_AllScenarios_${new Date().toISOString().split('T')[0]}.xlsx`;
  saveAs(blob, filename);
  return filename;
}
