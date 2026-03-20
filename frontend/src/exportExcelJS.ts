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
  description?: string;
  assumptions?: string;
  workloadType?: string;
  upliftOnly?: boolean;
  skuBreakdown?: { sku: string; percentage: number; dbus: number; dollarDbu: number; overridePrice?: number }[];
  adhocPeriods?: { id: string; label: string; months: number[]; skuAmounts: { sku: string; dollarPerMonth: number }[] }[];
}

export interface ScenarioExportData {
  scenarioNum: 1 | 2 | 3;
  assumptions: string;
  baselineGrowthRate: number;
  activeUseCases: UseCase[];
  baselineMonths: number[];
  totalMonths: number[];
  baseYearTotals: number[];
  ucYearTotals: number[];
  yearTotals: number[];
  baselineOverrides?: Record<number, number>; // monthIndex(0-35) -> overridden value
}

export interface AccountExportData {
  accountName: string;
  contractStartDate: string;  // YYYY-MM, e.g. "2026-05" — defines M1
  historicalData: any[];
  domainMapping: Record<string, string>;
  wsCloud: Record<string, string>;
  wsOrg: Record<string, string>;
  domainBaselines: { domain: string; t12m: number; avgMonthly: number }[];
  allUseCases: UseCase[];
  scenariosData: ScenarioExportData[];
}

export interface ExportOptions {
  accounts: AccountConfig[];
  account: string;
  accountsData: AccountExportData[];
  // Legacy single-account fields (ignored when accountsData present)
  historicalData?: any[];
  domainMapping?: Record<string, string>;
  wsCloud?: Record<string, string>;
  wsOrg?: Record<string, string>;
  domainBaselines?: { domain: string; t12m: number; avgMonthly: number }[];
  allUseCases?: UseCase[];
  scenariosData?: ScenarioExportData[];
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

// ─── Month label helpers ──────────────────────────────────────────────────────

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** M1-based index (1=M1) → "May_2026" using contractStartDate "YYYY-MM".
 *  Falls back to next calendar month when contractStartDate is blank,
 *  matching the backend's default behaviour. */
function projMonthLabel(monthNum: number, contractStartDate: string): string {
  let csd = contractStartDate;
  if (!csd) {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    csd = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
  }
  const [y, m] = csd.split('-').map(Number);
  const d = new Date(y, m - 1 + (monthNum - 1));
  return `${MONTH_NAMES[d.getMonth()]}_${d.getFullYear()}`;
}

/** "YYYY-MM" → "May_2026" for historical axis */
function histMonthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split('-').map(Number);
  if (!y || !m) return yyyymm;
  return `${MONTH_NAMES[m - 1]}_${y}`;
}

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

// Safe Excel sheet name: max 31 chars, no illegal chars
function safeName(accountName: string, suffix: string): string {
  const clean = accountName.replace(/[\\\/\?\*\[\]:]/g, '').trim();
  const max = 31 - suffix.length;
  return clean.slice(0, max) + suffix;
}

// ─── Projection sheet (multi-account, horizontal) ─────────────────────────────
// One sheet per scenario, all accounts as sections with SKU breakdown

function buildProjectionSheetMulti(
  wb: ExcelJS.Workbook,
  scenarioNum: 1 | 2 | 3,
  accountsData: AccountExportData[]
) {
  const sc = SCENARIO_COLORS[scenarioNum];
  const totalCols = 1 + 36 + 4;

  const ws = wb.addWorksheet(`S${scenarioNum} — Projection`, {
    properties: { tabColor: { argb: 'FF' + sc.bg } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  });

  ws.columns = [
    { key: 'label', width: 40 },
    ...Array.from({ length: 36 }, (_, i) => ({ key: `m${i + 1}`, width: 9 })),
    { key: 'y1', width: 14 },
    { key: 'y2', width: 14 },
    { key: 'y3', width: 14 },
    { key: 'grand', width: 16 },
  ];

  addSheetTitle(
    ws,
    `Scenario ${scenarioNum}  ·  36-Month Projection`,
    `All accounts combined  ·  Databricks List Price`,
    totalCols
  );

  // Month header row — use real calendar months from first account's contractStartDate
  const firstCsd = accountsData[0]?.contractStartDate || '';
  const monthLabels = Array.from({ length: 36 }, (_, i) =>
    projMonthLabel(i + 1, firstCsd)
  );

  // Y1/Y2/Y3 labels use actual year ranges when contractStartDate is set
  const y1Label = firstCsd
    ? `Y1 (${projMonthLabel(1, firstCsd)}–${projMonthLabel(12, firstCsd)})`
    : 'Y1 Total';
  const y2Label = firstCsd
    ? `Y2 (${projMonthLabel(13, firstCsd)}–${projMonthLabel(24, firstCsd)})`
    : 'Y2 Total';
  const y3Label = firstCsd
    ? `Y3 (${projMonthLabel(25, firstCsd)}–${projMonthLabel(36, firstCsd)})`
    : 'Y3 Total';

  const hrow = ws.addRow(['', ...monthLabels, y1Label, y2Label, y3Label, 'Grand Total']);
  hrow.height = 30;
  hrow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.style = {
      font: { bold: true, color: rgb(HEADER_FG), size: 9, name: 'Calibri' },
      fill: { type: 'pattern', pattern: 'solid', fgColor: rgb(sc.bg) },
      alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
      border: { right: { style: 'hair', color: rgb('AAAAAA') } },
    };
    if (colNum > 37) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: rgb('2D4E8A') };
      cell.font = { bold: true, color: rgb(HEADER_FG), size: 9, name: 'Calibri' };
    }
  });
  [13, 25, 37].forEach(col => {
    const c = hrow.getCell(col + 1);
    c.border = { ...c.border, right: { style: 'medium', color: rgb('FFFFFF') } };
  });

  const ucYearSlice = (vals: number[], yr: number) =>
    vals.slice(yr * 12, (yr + 1) * 12).reduce((s, v) => s + v, 0);

  const DBU_RATE = 1 / 0.20; // $0.20/DBU blended list price

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
    [13, 25, 37].forEach(col => {
      const c = r.getCell(col + 1);
      c.border = { ...c.border, left: { style: 'thin', color: rgb('CCCCCC') } };
    });
    return r;
  };

  // Adds a DBU companion row directly after a $DBU data row
  const addDbuRow = (
    label: string,
    months: number[],
    bgColor: string,
    indent = 1
  ) => {
    const dbuMonths = months.map(v => Math.round(v * DBU_RATE));
    const y1 = dbuMonths.slice(0, 12).reduce((s, v) => s + v, 0);
    const y2 = dbuMonths.slice(12, 24).reduce((s, v) => s + v, 0);
    const y3 = dbuMonths.slice(24, 36).reduce((s, v) => s + v, 0);
    const r = ws.addRow([label, ...dbuMonths, y1, y2, y3, y1 + y2 + y3]);
    r.height = 13;
    r.eachCell({ includeEmpty: true }, (cell, colNum) => {
      cell.style = {
        font: { size: 8, name: 'Calibri', italic: true, color: rgb('4B5563') },
        fill: { type: 'pattern', pattern: 'solid', fgColor: rgb(bgColor) },
        alignment: colNum === 1
          ? { vertical: 'middle', indent }
          : { horizontal: 'right', vertical: 'middle' },
      };
      if (colNum > 1 && typeof cell.value === 'number') cell.numFmt = '#,##0';
    });
    [13, 25, 37].forEach(col => {
      const c = r.getCell(col + 1);
      c.border = { ...c.border, left: { style: 'thin', color: rgb('CCCCCC') } };
    });
    return r;
  };

  // Per-account sections
  for (const ad of accountsData) {
    const sd = ad.scenariosData.find(s => s.scenarioNum === scenarioNum);
    if (!sd) continue;

    const { activeUseCases, baselineMonths, totalMonths,
            baseYearTotals, ucYearTotals, yearTotals,
            baselineGrowthRate, assumptions, baselineOverrides } = sd;
    const overriddenMonths = new Set(Object.keys(baselineOverrides || {}).map(Number));

    // Helper: merge-style sub-group header across all columns
    const addGroupHeader = (label: string, bgHex: string, fgHex: string) => {
      const r = ws.addRow([label]);
      r.height = 16;
      r.getCell(1).style = {
        font: { bold: true, size: 9, name: 'Calibri', color: rgb(fgHex) },
        fill: { type: 'pattern', pattern: 'solid', fgColor: rgb(bgHex) },
        alignment: { vertical: 'middle', indent: 1 },
      };
      ws.mergeCells(r.number, 1, r.number, totalCols);
      return r;
    };

    // Account section header band
    ws.addRow([]);
    const acctRow = ws.addRow([
      `${ad.accountName.toUpperCase()}  ·  Growth: ${baselineGrowthRate.toFixed(1)}% MoM` +
      (assumptions ? `  ·  ${assumptions}` : '')
    ]);
    acctRow.height = 22;
    acctRow.getCell(1).style = {
      font: { bold: true, size: 11, color: rgb('FFFFFF'), name: 'Calibri' },
      fill: { type: 'pattern', pattern: 'solid', fgColor: rgb('374151') },
      alignment: { vertical: 'middle', indent: 1 },
    };
    ws.mergeCells(acctRow.number, 1, acctRow.number, totalCols);

    // ── Group 1: $DBU MoM ────────────────────────────────────────────────────
    addGroupHeader('  $DBU — Monthly Spend', 'DBEAFE', '1E3A5F');

    // Baseline $DBU
    const baselineRow = addDataRow(
      'Baseline (Existing Consumption)', baselineMonths,
      { ...dataStyle(false), font: { bold: true, size: 10, name: 'Calibri', color: rgb('374151') } }
    );
    // Amber fill for overridden baseline cells
    if (overriddenMonths.size > 0) {
      overriddenMonths.forEach(mi => {
        const cell = baselineRow.getCell(mi + 2); // col 1 = label, col 2 = M1 (index 0)
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: rgb('FEF3C7') };
        cell.font = { bold: true, size: 10, name: 'Calibri', color: rgb('92400E') };
        cell.border = { ...cell.border, left: { style: 'medium', color: rgb('F59E0B') } };
      });
    }

    // Collect UC data so we can reuse it for the DBU group
    const ucMonthTotals = new Array(36).fill(0);
    type UcItem = { label: string; months: number[]; bgIdx: number; skus: Array<{ label: string; months: number[] }> };
    const ucItems: UcItem[] = [];

    activeUseCases.forEach((uc, idx) => {
      const mp = uc.monthlyProjection;
      mp.forEach((v, i) => { ucMonthTotals[i] += v; });
      const ucLabel = uc.upliftOnly ? `  ↳ ${uc.name}  [$ uplift only]` : `  ↳ ${uc.name}`;
      addDataRow(ucLabel, mp, dataStyle(idx % 2 === 0));

      const skus: Array<{ label: string; months: number[] }> = [];
      if (uc.skuBreakdown?.length) {
        uc.skuBreakdown.forEach(sku => {
          const skuMonths = mp.map(v => v * (sku.percentage / 100));
          skus.push({ label: `    └─ ${sku.sku} (${sku.percentage}%)`, months: skuMonths });
          addDataRow(
            `    └─ ${sku.sku} (${sku.percentage}%)`,
            skuMonths,
            {
              font: { size: 9, name: 'Calibri', color: rgb('6B7280'), italic: true },
              fill: { type: 'pattern', pattern: 'solid', fgColor: rgb('F9FAFB') },
              alignment: { vertical: 'middle' },
            },
            4
          );
        });
      }
      // For uplift-only UCs, pass zeroed months to DBU group so volume isn't inflated
      ucItems.push({ label: ucLabel, months: uc.upliftOnly ? new Array(mp.length).fill(0) : mp, bgIdx: idx, skus: uc.upliftOnly ? [] : skus });
    });

    if (activeUseCases.length > 0) {
      addDataRow('New Use Cases Subtotal', ucMonthTotals, { ...totalStyle(TOTAL_BG, TOTAL_FG) });
    }
    addDataRow(
      `Grand Total (${ad.accountName})`, totalMonths,
      { ...totalStyle(GRAND_BG, '0D2B5A'), font: { bold: true, size: 10, name: 'Calibri', color: rgb('0D2B5A') } }
    );

    // ── Group 2: DBU MoM ─────────────────────────────────────────────────────
    ws.addRow([]);
    addGroupHeader('  DBUs — Monthly Consumption', 'D1FAE5', '065F46');

    const baselineDbuRow = addDbuRow('Baseline (Existing Consumption) — DBUs', baselineMonths, 'F3F4F6', 0);
    if (overriddenMonths.size > 0) {
      overriddenMonths.forEach(mi => {
        const cell = baselineDbuRow.getCell(mi + 2);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: rgb('FEF3C7') };
        cell.font = { size: 8, name: 'Calibri', italic: true, color: rgb('92400E') };
      });
    }

    ucItems.forEach(({ label, months, bgIdx, skus }) => {
      addDbuRow(`${label} — DBUs`, months, bgIdx % 2 === 0 ? 'F9FAFB' : 'FFFFFF', 1);
      skus.forEach(sku => addDbuRow(`${sku.label} — DBUs`, sku.months, 'F9FAFB', 4));
    });

    if (activeUseCases.length > 0) {
      addDbuRow('New Use Cases Subtotal — DBUs', ucMonthTotals, TOTAL_BG, 0);
    }
    addDbuRow(`Grand Total (${ad.accountName}) — DBUs`, totalMonths, GRAND_BG, 0);

    // ── Year Summary block ────────────────────────────────────────────────────
    const csd = ad.contractStartDate || '';
    const yl1 = `Y1 (${projMonthLabel(1, csd)}–${projMonthLabel(12, csd)})`;
    const yl2 = `Y2 (${projMonthLabel(13, csd)}–${projMonthLabel(24, csd)})`;
    const yl3 = `Y3 (${projMonthLabel(25, csd)}–${projMonthLabel(36, csd)})`;
    ws.addRow([]);

    const yhRow = ws.addRow([`${ad.accountName}  —  Year Summary`, yl1, yl2, yl3, 'Grand Total']);
    yhRow.height = 20;
    [1, 2, 3, 4, 5].forEach(c => { yhRow.getCell(c).style = headerStyle(sc.bg); });
    yhRow.getCell(1).style = {
      ...headerStyle(sc.bg),
      font: { bold: true, size: 10, color: rgb(HEADER_FG), name: 'Calibri' },
      alignment: { vertical: 'middle', horizontal: 'left', indent: 1 },
    };

    const yLabels = ['Baseline', 'New Use Cases', 'Grand Total'];
    const yData = [baseYearTotals, ucYearTotals, yearTotals];
    const yBgs = [TOTAL_BG, 'E0F2FE', GRAND_BG];

    // $DBU group first
    yLabels.forEach((label, li) => {
      const r = ws.addRow([`${label} — $DBU`, yData[li][0], yData[li][1], yData[li][2],
        yData[li].reduce((s, v) => s + v, 0)]);
      r.height = 18;
      applyRowStyle(r, totalStyle(yBgs[li]));
      [2, 3, 4, 5].forEach(c => {
        if (typeof r.getCell(c).value === 'number') r.getCell(c).numFmt = USD_FMT;
      });
    });

    // DBU group after
    yLabels.forEach((label, li) => {
      const dbuVals = yData[li].map(v => Math.round(v * DBU_RATE));
      const dbuRow = ws.addRow([`${label} — DBUs`,
        dbuVals[0], dbuVals[1], dbuVals[2],
        dbuVals.reduce((s, v) => s + v, 0)]);
      dbuRow.height = 16;
      applyRowStyle(dbuRow, {
        font: { size: 9, name: 'Calibri', italic: true, color: rgb('4B5563') },
        fill: { type: 'pattern', pattern: 'solid', fgColor: rgb(yBgs[li]) },
        alignment: { vertical: 'middle', indent: 2 },
        border: {},
      });
      [2, 3, 4, 5].forEach(c => {
        if (typeof dbuRow.getCell(c).value === 'number') dbuRow.getCell(c).numFmt = '#,##0';
      });
    });
  }

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 5, showGridLines: true }];
}

// ─── Summary sheet (multi-account) ───────────────────────────────────────────

async function buildSummarySheet(wb: ExcelJS.Workbook, opts: ExportOptions) {
  const ws = wb.addWorksheet('Demand Plan Summary', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    properties: { tabColor: { argb: 'FF' + BRAND } },
  });

  // Use sfdc_id (the backend cache key) for fetching; display name for labels
  const acctEntries = (opts.accounts || []).filter(a => a.name.trim()).map(a => ({
    displayName: a.name,
    fetchKey: a.sfdc_id?.trim() || a.name,
  }));
  if (acctEntries.length === 0) acctEntries.push({ displayName: opts.account, fetchKey: opts.account });

  const allSummaries: Record<string, any> = {};
  await Promise.all(acctEntries.map(async ({ displayName, fetchKey }) => {
    try { allSummaries[displayName] = await fetchSummaryAll(fetchKey); } catch {}
  }));

  ws.columns = [
    { key: 'label',  width: 46 },
    { key: 'y1',     width: 18 },
    { key: 'y2',     width: 18 },
    { key: 'y3',     width: 18 },
    { key: 'total',  width: 18 },
  ];

  addSheetTitle(ws, 'Demand Plan Summary', 'All prices are Databricks List Price', 5);

  for (let si = 0; si < 3; si++) {
    const sNum = si + 1;
    const sc = SCENARIO_COLORS[sNum];
    const firstAcct = allSummaries[acctEntries[0].displayName];
    const desc = firstAcct?.scenarios?.[si]?.description || `Scenario ${sNum}`;

    const secRow = ws.addRow([`SCENARIO ${sNum}  ·  ${desc.toUpperCase()}`]);
    secRow.height = 22;
    secRow.getCell(1).style = {
      font: { bold: true, size: 12, color: rgb('FFFFFF'), name: 'Calibri' },
      fill: { type: 'pattern', pattern: 'solid', fgColor: rgb(sc.bg) },
      alignment: { vertical: 'middle', indent: 1 },
    };
    ws.mergeCells(secRow.number, 1, secRow.number, 5);
    ws.addRow([]);

    const sh = ws.addRow(['SUMMARY  —  Total $DBUs (List)', 'Year 1', 'Year 2', 'Year 3', 'Grand Total']);
    applyRowStyle(sh, headerStyle(sc.bg));
    sh.height = 20;

    let crossY1 = 0, crossY2 = 0, crossY3 = 0, crossTotal = 0;
    acctEntries.forEach(({ displayName }, idx) => {
      const gt = allSummaries[displayName]?.scenarios?.[si]?.summary_rows?.find((r: any) => r.use_case_area === 'Grand Total');
      const y1 = gt?.year1 || 0, y2 = gt?.year2 || 0, y3 = gt?.year3 || 0, tot = gt?.total || 0;
      crossY1 += y1; crossY2 += y2; crossY3 += y3; crossTotal += tot;
      const dr = ws.addRow([displayName, y1, y2, y3, tot]);
      applyRowStyle(dr, dataStyle(idx % 2 === 1), USD_FMT);
    });

    const gtr = ws.addRow(['Grand Total', crossY1, crossY2, crossY3, crossTotal]);
    applyRowStyle(gtr, totalStyle(GRAND_BG));
    gtr.eachCell((c) => { if (typeof c.value === 'number') c.numFmt = USD_FMT; });

    ws.addRow([]);

    acctEntries.forEach(({ displayName: name }) => {
      const acctData = allSummaries[name]?.scenarios?.[si];
      const grandTotal = acctData?.summary_rows?.find((r: any) => r.use_case_area === 'Grand Total');
      const baseRow = acctData?.summary_rows?.find(
        (r: any) => !r.is_use_case && r.use_case_area !== 'Grand Total' && r.use_case_area !== 'New Use Cases'
      );
      const ucRows: any[] = acctData?.summary_rows?.filter((r: any) => r.is_use_case) || [];

      const dh = ws.addRow([`${name.toUpperCase()}  —  $DBUs List`, 'Year 1', 'Year 2', 'Year 3', 'Total']);
      applyRowStyle(dh, headerStyle(SUBHEADER_BG, SUBHEADER_FG));

      if (baseRow) {
        const br = ws.addRow(['Existing — Live Use Cases', baseRow.year1, baseRow.year2, baseRow.year3, baseRow.total]);
        applyRowStyle(br, dataStyle(false), USD_FMT);
      }
      ucRows.forEach((row, idx) => {
        const ucName = (row.use_case_area || '').replace(/^\s*↳\s*/, '').trim();
        const r = ws.addRow(['  ↳ ' + ucName, row.year1, row.year2, row.year3, row.total]);
        applyRowStyle(r, dataStyle(idx % 2 === 1), USD_FMT);
      });

      const tot = ws.addRow([`Total (${name})`, grandTotal?.year1 || 0, grandTotal?.year2 || 0, grandTotal?.year3 || 0, grandTotal?.total || 0]);
      applyRowStyle(tot, totalStyle());
      tot.eachCell((c) => { if (typeof c.value === 'number') c.numFmt = USD_FMT; });
      ws.addRow([]);
    });

    ws.addRow([]);
  }

  ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: true }];
}

// ─── Historical sheets (per account) ─────────────────────────────────────────

function buildHistoricalDomainSheet(wb: ExcelJS.Workbook, ad: AccountExportData) {
  const ws = wb.addWorksheet(safeName(ad.accountName, ' Hist-Domain'), {
    properties: { tabColor: { argb: 'FF2563EB' } },
  });
  const months = [...new Set(ad.historicalData.map(r => r.month))].sort();
  const monthDisplays = months.map(histMonthLabel);
  const domainMonthly: Record<string, Record<string, number>> = {};
  ad.historicalData.forEach(row => {
    const domain = ad.domainMapping[row.workspace_name] || 'Unmapped';
    const dbu = parseFloat(row.dollar_dbu_list) || 0;
    if (!domainMonthly[domain]) domainMonthly[domain] = {};
    domainMonthly[domain][row.month] = (domainMonthly[domain][row.month] || 0) + dbu;
  });
  const domainKeys = Object.keys(domainMonthly).sort(
    (a, b) => Object.values(domainMonthly[b]).reduce((s, v) => s + v, 0) -
              Object.values(domainMonthly[a]).reduce((s, v) => s + v, 0)
  );

  ws.columns = [{ key: 'domain', width: 32 }, ...months.map(m => ({ key: m, width: 13 })), { key: 'total', width: 16 }];
  addSheetTitle(ws, `${ad.accountName} — Historical by Domain`, 'T12M actuals grouped by domain', months.length + 2);

  const hrow = ws.addRow(['Domain', ...monthDisplays, 'Total']);
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

function buildHistoricalSkuSheet(wb: ExcelJS.Workbook, ad: AccountExportData) {
  const ws = wb.addWorksheet(safeName(ad.accountName, ' Hist-SKU'), {
    properties: { tabColor: { argb: 'FF7C3AED' } },
  });
  const months = [...new Set(ad.historicalData.map(r => r.month))].sort();
  const monthDisplays = months.map(histMonthLabel);
  const skuMonthly: Record<string, Record<string, number>> = {};
  ad.historicalData.forEach(row => {
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
  addSheetTitle(ws, `${ad.accountName} — Historical by SKU`, 'T12M actuals grouped by Databricks SKU', months.length + 2);

  const hrow = ws.addRow(['SKU', ...monthDisplays, 'Total']);
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

function buildCloudDomainSkuSheet(wb: ExcelJS.Workbook, ad: AccountExportData) {
  const ws = wb.addWorksheet(safeName(ad.accountName, ' Cloud-SKU'), {
    properties: { tabColor: { argb: 'FF0891B2' } },
  });
  const months = [...new Set(ad.historicalData.map(r => r.month))].sort();
  const monthDisplays = months.map(histMonthLabel);
  const cloudData: Record<string, Record<string, Record<string, Record<string, number>>>> = {};

  ad.historicalData.forEach(row => {
    const cloud  = ad.wsCloud[row.workspace_name] || 'unknown';
    const domain = ad.domainMapping[row.workspace_name] || 'Unmapped';
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
  addSheetTitle(ws, `${ad.accountName} — Cloud → Domain → SKU`, 'Hierarchical breakdown of T12M actuals', months.length + 4);

  const hrow = ws.addRow(['Cloud', 'Domain', 'SKU', ...monthDisplays, 'Total']);
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

// ─── Size tier helper ─────────────────────────────────────────────────────────

function sizeTierLabel(ssPerMonth: number): string {
  if (ssPerMonth <= 3000)   return 'XS ($3K/mo)';
  if (ssPerMonth <= 5000)   return 'S ($5K/mo)';
  if (ssPerMonth <= 15000)  return 'M ($15K/mo)';
  if (ssPerMonth <= 35000)  return 'L ($35K/mo)';
  if (ssPerMonth <= 75000)  return 'XL ($75K/mo)';
  if (ssPerMonth <= 150000) return 'XXL ($150K/mo)';
  if (ssPerMonth <= 300000) return 'XXXL ($300K/mo)';
  return `Custom ($${Math.round(ssPerMonth / 1000)}K/mo)`;
}

// ─── Use Case Details sheet (per account) ────────────────────────────────────

function buildUseCaseDetailsSheet(wb: ExcelJS.Workbook, ad: AccountExportData) {
  const csd = ad.contractStartDate || '';
  const ws = wb.addWorksheet(safeName(ad.accountName, ' Use Cases'), {
    properties: { tabColor: { argb: 'FF059669' } },
  });

  const y1Label = csd ? `Y1 (${projMonthLabel(1, csd)}–${projMonthLabel(12, csd)})` : 'Year 1';
  const y2Label = csd ? `Y2 (${projMonthLabel(13, csd)}–${projMonthLabel(24, csd)})` : 'Year 2';
  const y3Label = csd ? `Y3 (${projMonthLabel(25, csd)}–${projMonthLabel(36, csd)})` : 'Year 3';

  // Columns: Name | Domain | Size Tier | SS $/mo | Workload Type | Cloud | Onboard | Live | Ramp Duration | Ramp | S1|S2|S3 | Y1 | Y2 | Y3 | Total | Assumptions
  ws.columns = [
    { key: 'name',     width: 34 }, { key: 'domain',   width: 22 }, { key: 'tier',    width: 18 },
    { key: 'ss',       width: 14 }, { key: 'wltype',   width: 18 }, { key: 'cloud',   width: 10 },
    { key: 'onboard',  width: 16 }, { key: 'live',     width: 16 }, { key: 'rampmo',  width: 14 },
    { key: 'ramp',     width: 14 }, { key: 's1',       width: 5  }, { key: 's2',      width: 5  },
    { key: 's3',       width: 5  }, { key: 'y1',       width: 18 }, { key: 'y2',      width: 18 },
    { key: 'y3',       width: 18 }, { key: 'total',    width: 18 }, { key: 'notes',   width: 60 },
  ];

  addSheetTitle(ws, `${ad.accountName} — Use Case Details`, 'All use cases with full configuration, SKU breakdown, description, and assumptions', 18);
  const hrow = ws.addRow([
    'Name', 'Domain', 'Size Tier', 'DBUs/mo (steady state)', 'Workload Type', 'Cloud',
    'Onboard Month', 'Live Month', 'Ramp Duration (mo)', 'Ramp Type', 'S1', 'S2', 'S3',
    y1Label, y2Label, y3Label, 'Grand Total', 'Description / Assumptions',
  ]);
  applyRowStyle(hrow, headerStyle()); hrow.height = 22;

  let ucCount = 0;
  ad.allUseCases.forEach((uc) => {
    const yT = [0, 0, 0];
    uc.monthlyProjection.forEach((v, i) => { yT[Math.floor(i / 12)] += v; });
    const rampDuration = Math.max(0, uc.liveMonth - uc.onboardingMonth);
    // Derive approx DBUs/mo from steadyStateDbu using a blended ~$0.20/DBU list price
    const estDbus = uc.upliftOnly ? 0
      : uc.skuBreakdown?.length
        ? uc.skuBreakdown.reduce((s, a) => s + a.dbus, 0)
        : Math.round(uc.steadyStateDbu / 0.20);
    const ucDisplayName = uc.upliftOnly ? `${uc.name}  [$ uplift only]` : uc.name;
    const ucRow = ws.addRow([
      ucDisplayName,
      uc.domain,
      sizeTierLabel(uc.steadyStateDbu),
      estDbus,                   // col 4: DBUs/mo
      uc.workloadType || '—',    // col 5: Workload Type ($/mo shown in Y1/Y2/Y3 columns)
      uc.cloud || '',
      projMonthLabel(uc.onboardingMonth, csd),
      projMonthLabel(uc.liveMonth, csd),
      rampDuration,
      uc.rampType === 'hockey_stick' ? 'Hockey Stick' : 'Linear',
      uc.scenarios[0] ? '✓' : '', uc.scenarios[1] ? '✓' : '', uc.scenarios[2] ? '✓' : '',
      yT[0], yT[1], yT[2], yT.reduce((a, b) => a + b, 0),
      [uc.description, uc.assumptions].filter(Boolean).join('\n') || '',
    ]);
    applyRowStyle(ucRow, dataStyle(ucCount % 2 === 0));
    ucRow.getCell(1).font = { bold: true, size: 10, name: 'Calibri' };
    ucRow.getCell(4).numFmt = '#,##0';   // DBUs/mo — integer format
    [14, 15, 16, 17].forEach(col => {
      const c = ucRow.getCell(col); if (typeof c.value === 'number') c.numFmt = USD_FMT;
    });
    [11, 12, 13].forEach(col => {
      ucRow.getCell(col).alignment = { horizontal: 'center', vertical: 'middle' };
      ucRow.getCell(col).font = { color: rgb('059669'), bold: true, name: 'Calibri', size: 11 };
    });
    ucRow.getCell(18).alignment = { wrapText: true, vertical: 'top' };

    // SKU breakdown sub-rows
    if (uc.skuBreakdown?.length) {
      let hasCustomPrice = false;
      uc.skuBreakdown.forEach((sku) => {
        const isCustom = sku.overridePrice !== undefined;
        if (isCustom) hasCustomPrice = true;
        const pricePerDbu = isCustom ? (sku.overridePrice ?? 0) : (sku.dbus > 0 ? sku.dollarDbu / sku.dbus : 0);
        const skuLabel = `    └─ ${sku.sku}${isCustom ? ' *' : ''}`;
        const priceLabel = isCustom ? `$/DBU: ${pricePerDbu.toFixed(2)} (custom*)` : `$/DBU: ${pricePerDbu.toFixed(2)}`;
        const skuRow = ws.addRow([
          skuLabel,
          '',
          `${sku.percentage}% of UC`,
          Math.round(sku.dbus),
          sku.dollarDbu,
          priceLabel,
          '', '', '', '', '', '', '',
          yT[0] * sku.percentage / 100,
          yT[1] * sku.percentage / 100,
          yT[2] * sku.percentage / 100,
          yT.reduce((a, b) => a + b, 0) * sku.percentage / 100,
          '',
        ]);
        skuRow.height = 16;
        skuRow.eachCell({ includeEmpty: true }, (cell) => {
          cell.style = {
            font: { size: 9, name: 'Calibri', color: isCustom ? rgb('B45309') : rgb('6B7280'), italic: true },
            fill: { type: 'pattern', pattern: 'solid', fgColor: isCustom ? rgb('FFFBEB') : rgb('F9FAFB') },
            alignment: { vertical: 'middle' },
          };
        });
        skuRow.getCell(4).numFmt = '#,##0';
        [5, 14, 15, 16, 17].forEach(col => {
          const c = skuRow.getCell(col); if (typeof c.value === 'number') c.numFmt = USD_FMT;
        });
        skuRow.getCell(1).alignment = { vertical: 'middle', indent: 2 };
        skuRow.getCell(18).alignment = { vertical: 'middle', wrapText: true };
      });
      // Footnote row if any custom prices used
      if (hasCustomPrice) {
        const noteRow = ws.addRow(['    * Custom price — SKU not yet in standard price list', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
        noteRow.height = 14;
        noteRow.eachCell({ includeEmpty: true }, (cell) => {
          cell.style = {
            font: { size: 8, name: 'Calibri', color: rgb('B45309'), italic: true },
            fill: { type: 'pattern', pattern: 'solid', fgColor: rgb('FFFBEB') },
          };
        });
        noteRow.getCell(1).alignment = { vertical: 'middle', indent: 3 };
      }
    }

    // Adhoc period sub-rows
    if (uc.adhocPeriods?.length) {
      uc.adhocPeriods.forEach((period) => {
        const periodTotal = period.skuAmounts.reduce((s, sa) => s + (sa.dollarPerMonth || 0), 0);
        const monthsLabel = period.months.length > 0 ? `Months: ${period.months.join(', ')}` : 'No months selected';
        const y1Adhoc = period.months.filter(m => m >= 1 && m <= 12).length * periodTotal;
        const y2Adhoc = period.months.filter(m => m >= 13 && m <= 24).length * periodTotal;
        const y3Adhoc = period.months.filter(m => m >= 25 && m <= 36).length * periodTotal;
        const adhocRow = ws.addRow([
          `    ⚡ ${period.label}`,
          '',
          `${period.months.length} months`,
          '',
          periodTotal > 0 ? `+${periodTotal.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}/mo` : '',
          monthsLabel,
          '', '', '', '', '', '', '',
          y1Adhoc, y2Adhoc, y3Adhoc, y1Adhoc + y2Adhoc + y3Adhoc,
          '',
        ]);
        adhocRow.height = 16;
        adhocRow.eachCell({ includeEmpty: true }, (cell) => {
          cell.style = {
            font: { size: 9, name: 'Calibri', color: rgb('4338CA'), italic: true },
            fill: { type: 'pattern', pattern: 'solid', fgColor: rgb('EEF2FF') },
            alignment: { vertical: 'middle' },
          };
        });
        [14, 15, 16, 17].forEach(col => {
          const c = adhocRow.getCell(col); if (typeof c.value === 'number') c.numFmt = USD_FMT;
        });
        adhocRow.getCell(1).alignment = { vertical: 'middle', indent: 2 };
      });
    }

    ucCount++;
  });

  // Totals row
  const totRow = ws.addRow([
    'TOTAL', '', '',
    ad.allUseCases.reduce((s, uc) => s + (uc.skuBreakdown?.length ? uc.skuBreakdown.reduce((a, sk) => a + sk.dbus, 0) : Math.round(uc.steadyStateDbu / 0.20)), 0),
    '', '', '', '', '', '', '', '', '',
    ad.allUseCases.reduce((s, uc) => s + uc.monthlyProjection.slice(0, 12).reduce((a, v) => a + v, 0), 0),
    ad.allUseCases.reduce((s, uc) => s + uc.monthlyProjection.slice(12, 24).reduce((a, v) => a + v, 0), 0),
    ad.allUseCases.reduce((s, uc) => s + uc.monthlyProjection.slice(24, 36).reduce((a, v) => a + v, 0), 0),
    ad.allUseCases.reduce((s, uc) => s + uc.monthlyProjection.reduce((a, v) => a + v, 0), 0),
    '',
  ]);
  applyRowStyle(totRow, totalStyle(GRAND_BG));
  totRow.getCell(4).numFmt = '#,##0';
  [14, 15, 16, 17].forEach(col => {
    const c = totRow.getCell(col); if (typeof c.value === 'number') c.numFmt = USD_FMT;
  });

  ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: true }];
}

// ─── Consumption Forecast sheet (per scenario, per account) ──────────────────
// Month-by-month projection with SKU sub-rows under each use case

function buildConsumptionForecastSheet(
  wb: ExcelJS.Workbook,
  scenarioNum: 1 | 2 | 3,
  accountsData: AccountExportData[]
) {
  const sc = SCENARIO_COLORS[scenarioNum];
  const totalCols = 1 + 36 + 4;

  const ws = wb.addWorksheet(`S${scenarioNum} — Forecast`, {
    properties: { tabColor: { argb: 'FF' + sc.bg } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  });

  ws.columns = [
    { key: 'label', width: 42 },
    ...Array.from({ length: 36 }, (_, i) => ({ key: `m${i + 1}`, width: 9 })),
    { key: 'y1', width: 14 },
    { key: 'y2', width: 14 },
    { key: 'y3', width: 14 },
    { key: 'grand', width: 16 },
  ];

  addSheetTitle(
    ws,
    `Scenario ${scenarioNum}  ·  Consumption Forecast — Month-by-Month`,
    'All accounts  ·  Baseline + Use Cases  ·  SKU-level breakdown  ·  Databricks List Price',
    totalCols
  );

  const firstCsd = accountsData[0]?.contractStartDate || '';
  const monthLabels = Array.from({ length: 36 }, (_, i) => projMonthLabel(i + 1, firstCsd));

  const y1Label = firstCsd
    ? `Y1 (${projMonthLabel(1, firstCsd)}–${projMonthLabel(12, firstCsd)})`
    : 'Y1 Total';
  const y2Label = firstCsd
    ? `Y2 (${projMonthLabel(13, firstCsd)}–${projMonthLabel(24, firstCsd)})`
    : 'Y2 Total';
  const y3Label = firstCsd
    ? `Y3 (${projMonthLabel(25, firstCsd)}–${projMonthLabel(36, firstCsd)})`
    : 'Y3 Total';

  const hrow = ws.addRow(['', ...monthLabels, y1Label, y2Label, y3Label, 'Grand Total']);
  hrow.height = 30;
  hrow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.style = {
      font: { bold: true, color: rgb(HEADER_FG), size: 9, name: 'Calibri' },
      fill: { type: 'pattern', pattern: 'solid', fgColor: rgb(sc.bg) },
      alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
      border: { right: { style: 'hair', color: rgb('AAAAAA') } },
    };
    if (colNum > 37) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: rgb('2D4E8A') };
    }
  });
  [13, 25, 37].forEach(col => {
    const c = hrow.getCell(col + 1);
    c.border = { ...c.border, right: { style: 'medium', color: rgb('FFFFFF') } };
  });

  const yearSlice = (vals: number[], yr: number) =>
    vals.slice(yr * 12, (yr + 1) * 12).reduce((s, v) => s + v, 0);

  const addForecastRow = (
    label: string,
    months: number[],
    style: Partial<ExcelJS.Style>,
    indent = 0
  ) => {
    const y1 = yearSlice(months, 0);
    const y2 = yearSlice(months, 1);
    const y3 = yearSlice(months, 2);
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
    [13, 25, 37].forEach(col => {
      const c = r.getCell(col + 1);
      c.border = { ...c.border, left: { style: 'thin', color: rgb('CCCCCC') } };
    });
    return r;
  };

  for (const ad of accountsData) {
    const sd = ad.scenariosData.find(s => s.scenarioNum === scenarioNum);
    if (!sd) continue;

    const { activeUseCases, baselineMonths, totalMonths,
            baselineGrowthRate, assumptions } = sd;
    const csd = ad.contractStartDate || '';

    // Account section header
    ws.addRow([]);
    const acctRow = ws.addRow([
      `${ad.accountName.toUpperCase()}  ·  S${scenarioNum}  ·  Baseline Growth: ${baselineGrowthRate.toFixed(1)}% MoM` +
      (assumptions ? `  ·  ${assumptions}` : '')
    ]);
    acctRow.height = 22;
    acctRow.getCell(1).style = {
      font: { bold: true, size: 11, color: rgb('FFFFFF'), name: 'Calibri' },
      fill: { type: 'pattern', pattern: 'solid', fgColor: rgb('374151') },
      alignment: { vertical: 'middle', indent: 1 },
    };
    ws.mergeCells(acctRow.number, 1, acctRow.number, totalCols);

    // Baseline row
    addForecastRow(
      'Baseline (Existing Consumption)', baselineMonths,
      { ...dataStyle(false), font: { bold: true, size: 10, name: 'Calibri', color: rgb('374151') } }
    );

    // Use case rows + SKU sub-rows
    const ucMonthTotals = new Array(36).fill(0);
    activeUseCases.forEach((uc, idx) => {
      const mp = uc.monthlyProjection;
      mp.forEach((v, i) => { ucMonthTotals[i] += v; });

      // UC header row with size tier and ramp info
      const tier = sizeTierLabel(uc.steadyStateDbu);
      const onbLabel = projMonthLabel(uc.onboardingMonth, csd);
      const liveLabel = projMonthLabel(uc.liveMonth, csd);
      const upliftTag = uc.upliftOnly ? '  ·  $ UPLIFT ONLY — no new DBUs' : '';
      const ucLabel = `  ↳ ${uc.name}  [${tier}  ·  ${uc.rampType === 'hockey_stick' ? 'Hockey Stick' : 'Linear'}  ·  ${onbLabel}→${liveLabel}${upliftTag}]`;

      addForecastRow(ucLabel, mp, dataStyle(idx % 2 === 0), 2);

      // SKU breakdown rows
      if (uc.skuBreakdown?.length) {
        uc.skuBreakdown.forEach(sku => {
          const skuMonths = mp.map(v => v * (sku.percentage / 100));
          addForecastRow(
            `      └─ ${sku.sku} (${sku.percentage}%  ·  $${Math.round(sku.dollarDbu / 1000)}K/mo  ·  ${Math.round(sku.dbus)} DBUs/mo)`,
            skuMonths,
            {
              font: { size: 9, name: 'Calibri', color: rgb('6B7280'), italic: true },
              fill: { type: 'pattern', pattern: 'solid', fgColor: rgb('F9FAFB') },
              alignment: { vertical: 'middle' },
            },
            5
          );
        });
      }
    });

    if (activeUseCases.length > 0) {
      addForecastRow(
        'New Use Cases Subtotal', ucMonthTotals,
        { ...totalStyle(TOTAL_BG, TOTAL_FG) }
      );
    }

    addForecastRow(
      `Grand Total (${ad.accountName})`, totalMonths,
      { ...totalStyle(GRAND_BG, '0D2B5A'), font: { bold: true, size: 10, name: 'Calibri', color: rgb('0D2B5A') } }
    );
  }

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 5, showGridLines: true }];
}

// ─── Domain Baseline sheet (per account) ─────────────────────────────────────

function buildDomainBaselineSheet(wb: ExcelJS.Workbook, ad: AccountExportData) {
  const ws = wb.addWorksheet(safeName(ad.accountName, ' Baseline'), {
    properties: { tabColor: { argb: 'FF6366F1' } },
  });
  ws.columns = [{ key: 'domain', width: 32 }, { key: 't12m', width: 20 }, { key: 'avg', width: 20 }, { key: 'pct', width: 14 }];
  addSheetTitle(ws, `${ad.accountName} — Domain Baseline`, 'T12M consumption per domain used as projection baseline', 4);

  const hrow = ws.addRow(['Domain', 'T12M $DBU (List)', 'Avg Monthly', '% of Total']);
  applyRowStyle(hrow, headerStyle()); hrow.height = 20;

  const totalBL = ad.domainBaselines.reduce((s, b) => s + b.t12m, 0);
  ad.domainBaselines.forEach((b, idx) => {
    const pct = totalBL > 0 ? b.t12m / totalBL : 0;
    const r = ws.addRow([b.domain, b.t12m, b.avgMonthly, pct]);
    applyRowStyle(r, dataStyle(idx % 2 === 1));
    r.getCell(2).numFmt = USD_FMT;
    r.getCell(3).numFmt = USD_FMT;
    r.getCell(4).numFmt = PCT_FMT;
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

// ─── SKU Breakdown sheet (per account) ───────────────────────────────────────

function buildSkuBreakdownSheet(wb: ExcelJS.Workbook, ad: AccountExportData) {
  const ws = wb.addWorksheet(safeName(ad.accountName, ' SKU Detail'), {
    properties: { tabColor: { argb: 'FFEA580C' } },
  });
  ws.columns = [
    { key: 'uc',    width: 32 }, { key: 'sku',   width: 28 }, { key: 'cloud', width: 10 },
    { key: 'pct',   width: 10 }, { key: 'dbus',  width: 14 }, { key: 'price', width: 12 },
    { key: 'dollar',width: 16 }, { key: 'notes', width: 52 },
  ];
  addSheetTitle(ws, `${ad.accountName} — SKU Breakdown`, 'Per-use-case SKU allocation, pricing, and assumptions', 8);

  const hrow = ws.addRow(['Use Case', 'SKU', 'Cloud', '% Split', 'DBUs/mo', '$/DBU', '$/month', 'Assumptions']);
  applyRowStyle(hrow, headerStyle()); hrow.height = 20;

  ad.allUseCases.forEach((uc) => {
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

async function buildExcelBlob(opts: ExportOptions): Promise<{ blob: Blob; filename: string }> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Demand Plan App';
  wb.created = new Date();
  wb.properties.date1904 = false;

  // 1. Summary (all accounts)
  // 1. Summary
  await buildSummarySheet(wb, opts);

  // 2. Projection sheets (S1, S2, S3 — multi-account horizontal view)
  for (const sNum of [1, 2, 3] as const) {
    buildProjectionSheetMulti(wb, sNum, opts.accountsData);
  }

  // 3. Historical sheets: one set per account
  for (const ad of opts.accountsData) {
    buildHistoricalDomainSheet(wb, ad);
    buildHistoricalSkuSheet(wb, ad);
    buildCloudDomainSkuSheet(wb, ad);
  }

  // 5. Per-account detail sheets
  for (const ad of opts.accountsData) {
    buildUseCaseDetailsSheet(wb, ad);
    buildDomainBaselineSheet(wb, ad);
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const accountLabel = opts.accounts.filter(a => a.name.trim()).map(a => a.name).join('_') || opts.account;
  const filename = `Demand_Plan_${accountLabel}_AllScenarios_${new Date().toISOString().split('T')[0]}.xlsx`;
  return { blob, filename };
}

export async function exportToExcelJS(opts: ExportOptions): Promise<string> {
  const { blob, filename } = await buildExcelBlob(opts);
  saveAs(blob, filename);
  return filename;
}

export async function exportToExcelJSAndUpload(opts: ExportOptions): Promise<{ filename: string; driveUrl: string }> {
  const { blob, filename } = await buildExcelBlob(opts);

  const form = new FormData();
  form.append('file', blob, filename);

  const res = await fetch(`/api/export/upload-to-drive?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || 'Upload to Drive failed');
  }
  const { url } = await res.json();
  return { filename, driveUrl: url };
}
