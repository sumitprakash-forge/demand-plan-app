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
  adhocPeriods?: { id: string; label: string; months: number[]; skuAmounts: { sku: string; dbuPerMonth: number; dollarPerMonth: number; customDbuRate?: number }[] }[];
}

export interface ScenarioExportData {
  scenarioNum: 1 | 2 | 3;
  assumptions: string;
  baselineGrowthRate: number;
  activeUseCases: UseCase[];
  baselineMonths: number[];       // $DBU projected baseline (overrides applied)
  baselineDbuMonths: number[];    // DBU projected baseline (same % overrides applied, no rate conversion)
  totalMonths: number[];
  baseYearTotals: number[];
  ucYearTotals: number[];
  yearTotals: number[];
  baselineOverrides?: Record<number, number>; // monthIndex -> % adjustment
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

interface ProjRowMap {
  sheetName: string;
  accountRows: Array<{
    accountName: string;
    ucRows: Array<{ name: string; rowNum: number }>;
    yearSummary: { baselineRow: number; newUcsRow: number; grandTotalRow: number };
  }>;
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

// ─── Excel column letter helper ───────────────────────────────────────────────
// Converts 1-based column index to Excel letter(s): 1→A, 26→Z, 27→AA, etc.
function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
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
): ProjRowMap {
  const sc = SCENARIO_COLORS[scenarioNum];
  const INFO_COLS = 2; // SKU name + $/DBU columns after label
  const totalCols = 1 + INFO_COLS + 36 + 4;

  const ws = wb.addWorksheet(`S${scenarioNum}_Projection`, {
    properties: { tabColor: { argb: 'FF' + sc.bg } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  });

  ws.columns = [
    { key: 'label', width: 30 },
    { key: 'sku',   width: 26 },  // SKU name (for SKU sub-rows)
    { key: 'dbu',   width: 9  },  // $/DBU rate
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

  const hrow = ws.addRow(['', 'SKU', '$/DBU', ...monthLabels, y1Label, y2Label, y3Label, 'Grand Total']);
  hrow.height = 30;
  hrow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.style = {
      font: { bold: true, color: rgb(HEADER_FG), size: 9, name: 'Calibri' },
      fill: { type: 'pattern', pattern: 'solid', fgColor: rgb(sc.bg) },
      alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
      border: { right: { style: 'hair', color: rgb('AAAAAA') } },
    };
    if (colNum > 39) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: rgb('2D4E8A') };
      cell.font = { bold: true, color: rgb(HEADER_FG), size: 9, name: 'Calibri' };
    }
  });
  [15, 27, 39].forEach(col => {
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
    indent = 0,
    infoPct: string | number = '',
    infoDbu: string | number = ''
  ) => {
    const y1 = ucYearSlice(months, 0);
    const y2 = ucYearSlice(months, 1);
    const y3 = ucYearSlice(months, 2);
    const grand = y1 + y2 + y3;
    const r = ws.addRow([label, infoPct, infoDbu, ...months, y1, y2, y3, grand]);
    r.height = 17;
    r.eachCell({ includeEmpty: true }, (cell, colNum) => {
      Object.assign(cell, { style: { ...cell.style, ...style } });
      if (colNum > 3 && typeof cell.value === 'number') {
        cell.numFmt = USD_FMT;
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      }
    });
    r.getCell(1).style = {
      ...style,
      alignment: { vertical: 'middle', indent },
      font: { ...(style.font as any), name: 'Calibri', size: 10 },
    };
    // Info cols 2-3: right-align
    if (infoPct !== '') {
      r.getCell(2).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      r.getCell(2).font = { ...(style.font as any), name: 'Calibri', size: 9 };
    }
    if (infoDbu !== '') {
      r.getCell(3).alignment = { horizontal: 'right', vertical: 'middle' };
      r.getCell(3).numFmt = '$#,##0.00';
      r.getCell(3).font = { ...(style.font as any), name: 'Calibri', size: 9 };
    }
    [15, 27, 39].forEach(col => {
      const c = r.getCell(col + 1);
      c.border = { ...c.border, left: { style: 'thin', color: rgb('CCCCCC') } };
    });
    return r;
  };

  // Adds a DBU companion row directly after a $DBU data row
  // dbuRateOverride: pass a per-UC rate (DBUs/$) to override the default blended rate
  const addDbuRow = (
    label: string,
    months: number[],
    bgColor: string,
    indent = 1,
    dbuRateOverride?: number,
    infoLabel = ''
  ) => {
    const rate = dbuRateOverride !== undefined ? dbuRateOverride : DBU_RATE;
    const dbuMonths = months.map(v => Math.round(v * rate));
    const y1 = dbuMonths.slice(0, 12).reduce((s, v) => s + v, 0);
    const y2 = dbuMonths.slice(12, 24).reduce((s, v) => s + v, 0);
    const y3 = dbuMonths.slice(24, 36).reduce((s, v) => s + v, 0);
    const r = ws.addRow([label, infoLabel, '', ...dbuMonths, y1, y2, y3, y1 + y2 + y3]);
    r.height = 13;
    r.eachCell({ includeEmpty: true }, (cell, colNum) => {
      cell.style = {
        font: { size: 8, name: 'Calibri', italic: true, color: rgb('4B5563') },
        fill: { type: 'pattern', pattern: 'solid', fgColor: rgb(bgColor) },
        alignment: colNum === 1
          ? { vertical: 'middle', indent }
          : colNum === 2
          ? { horizontal: 'left', vertical: 'middle', indent: 1 }
          : { horizontal: 'right', vertical: 'middle' },
      };
      if (colNum > 3 && typeof cell.value === 'number') cell.numFmt = '#,##0';
    });
    [15, 27, 39].forEach(col => {
      const c = r.getCell(col + 1);
      c.border = { ...c.border, left: { style: 'thin', color: rgb('CCCCCC') } };
    });
    return r;
  };

  const accountRows: ProjRowMap['accountRows'] = [];

  // Per-account sections
  for (const ad of accountsData) {
    const sd = ad.scenariosData.find(s => s.scenarioNum === scenarioNum);
    if (!sd) continue;

    const acctUcRows: Array<{ name: string; rowNum: number }> = [];

    const { activeUseCases, baselineMonths, baselineDbuMonths, totalMonths,
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
      `${ad.accountName.toUpperCase()}  ·  Growth: ${baselineGrowthRate.toFixed(2)}% MoM` +
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
        const cell = baselineRow.getCell(mi + 4); // col 1 = label, cols 2-3 = info, col 4 = M1
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: rgb('FEF3C7') };
        cell.font = { bold: true, size: 10, name: 'Calibri', color: rgb('92400E') };
        cell.border = { ...cell.border, left: { style: 'medium', color: rgb('F59E0B') } };
      });
    }

    // Collect UC data so we can reuse it for the DBU group
    const ucMonthTotals = new Array(36).fill(0);
    // dbuMonths: pre-computed DBU array — ramp uses blended rate, adhoc uses dbuPerMonth directly
    type UcItem = { label: string; months: number[]; dbuMonths: number[]; bgIdx: number; rate: number; skus: Array<{ label: string; skuName: string; months: number[]; rate: number }> };
    const ucItems: UcItem[] = [];

    activeUseCases.forEach((uc, idx) => {
      const mp = uc.monthlyProjection;
      mp.forEach((v, i) => { ucMonthTotals[i] += v; });
      const ucLabel = uc.upliftOnly ? `  ↳ ${uc.name}  [$ uplift only]` : `  ↳ ${uc.name}`;
      const ucDataRow = addDataRow(ucLabel, mp, dataStyle(idx % 2 === 0));
      acctUcRows.push({ name: uc.name, rowNum: ucDataRow.number });

      // Compute per-UC blended DBU rate from SKU breakdown; 0 for uplift-only
      let ucRate = DBU_RATE;
      if (uc.upliftOnly) {
        ucRate = 0;
      } else if (uc.skuBreakdown?.length) {
        const totalDollar = uc.skuBreakdown.reduce((s, sk) => s + sk.dollarDbu, 0);
        const totalDbu    = uc.skuBreakdown.reduce((s, sk) => s + sk.dbus, 0);
        if (totalDollar > 0 && totalDbu > 0) ucRate = totalDbu / totalDollar;
      }

      // Build per-month adhoc dollar and DBU arrays so adhoc DBU uses dbuPerMonth directly
      const adhocDollarByMonth = new Array(mp.length).fill(0);
      const adhocDbuByMonth = new Array(mp.length).fill(0);
      (uc.adhocPeriods || []).forEach(period => {
        period.months.forEach(m => {
          if (m >= 1 && m <= mp.length) {
            const periodDollar = period.skuAmounts.reduce((s, sa) => s + (sa.dollarPerMonth || 0), 0);
            const periodDbu = period.skuAmounts.reduce((s, sa) => s + (sa.dbuPerMonth || 0), 0);
            adhocDollarByMonth[m - 1] += periodDollar;
            adhocDbuByMonth[m - 1] += periodDbu;
          }
        });
      });

      // Pre-compute DBU months: ramp portion uses blended rate, adhoc uses direct dbuPerMonth
      const dbuMonths = uc.upliftOnly
        ? new Array(mp.length).fill(0)
        : mp.map((v, i) => {
            const rampDollar = v - adhocDollarByMonth[i];
            return Math.round(rampDollar * ucRate + adhocDbuByMonth[i]);
          });

      const skus: Array<{ label: string; skuName: string; months: number[]; rate: number }> = [];
      if (!uc.upliftOnly && uc.skuBreakdown?.length) {
        uc.skuBreakdown.forEach(sku => {
          const skuMonths = mp.map(v => v * (sku.percentage / 100));
          const skuRate = (sku.dollarDbu > 0 && sku.dbus > 0) ? sku.dbus / sku.dollarDbu : DBU_RATE;
          const pricePerDbu = sku.overridePrice !== undefined
            ? (sku.overridePrice ?? 0)
            : (sku.dbus > 0 ? sku.dollarDbu / sku.dbus : 0);
          skus.push({ label: `    └─ ${sku.sku}`, skuName: sku.sku, months: skuMonths, rate: skuRate });
          addDataRow(
            '',                          // col 1: empty — SKU name lives in col 2
            skuMonths,
            {
              font: { size: 9, name: 'Calibri', color: rgb('6B7280'), italic: true },
              fill: { type: 'pattern', pattern: 'solid', fgColor: rgb('F9FAFB') },
              alignment: { vertical: 'middle' },
            },
            0,
            `└─ ${sku.sku}`,             // col 2: SKU name
            pricePerDbu                  // col 3: $/DBU
          );
        });
      }
      ucItems.push({ label: ucLabel, months: uc.upliftOnly ? new Array(mp.length).fill(0) : mp, dbuMonths, bgIdx: idx, rate: ucRate, skus });
    });

    if (activeUseCases.length > 0) {
      const dbuSubRow = addDataRow('New Use Cases Subtotal', ucMonthTotals, { ...totalStyle(TOTAL_BG, TOTAL_FG) });
      const gtRow = addDataRow(
        `Grand Total (${ad.accountName})`, totalMonths,
        { ...totalStyle(GRAND_BG, '0D2B5A'), font: { bold: true, size: 10, name: 'Calibri', color: rgb('0D2B5A') } }
      );
      const baselineRN = baselineRow.number;
      const subtotalRN = dbuSubRow.number;
      for (let c = 4; c <= 43; c++) {
        const col = colLetter(c);
        const cell = gtRow.getCell(c);
        const precomputed = typeof cell.value === 'number' ? cell.value : 0;
        cell.value = { formula: `${col}${baselineRN}+${col}${subtotalRN}`, result: precomputed };
      }
    } else {
      addDataRow(
        `Grand Total (${ad.accountName})`, totalMonths,
        { ...totalStyle(GRAND_BG, '0D2B5A'), font: { bold: true, size: 10, name: 'Calibri', color: rgb('0D2B5A') } }
      );
    }

    // ── Group 2: DBU MoM ─────────────────────────────────────────────────────
    ws.addRow([]);
    addGroupHeader('  DBUs — Monthly Consumption', 'D1FAE5', '065F46');

    // baselineDbuMonths already contains actual DBU values (no rate conversion — same % overrides applied)
    const baselineDbuRow = addDbuRow('Baseline (Existing Consumption) — DBUs', baselineDbuMonths ?? baselineMonths, 'F3F4F6', 1);
    if (overriddenMonths.size > 0) {
      overriddenMonths.forEach(mi => {
        const cell = baselineDbuRow.getCell(mi + 4);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: rgb('FEF3C7') };
        cell.font = { size: 8, name: 'Calibri', italic: true, color: rgb('92400E') };
      });
    }

    ucItems.forEach(({ label, dbuMonths, bgIdx, rate, skus }) => {
      // dbuMonths is pre-computed (ramp × rate + adhoc dbuPerMonth), so pass rate=1 to addDbuRow
      addDbuRow(`${label} — DBUs`, dbuMonths, bgIdx % 2 === 0 ? 'F9FAFB' : 'FFFFFF', 1, 1);
      skus.forEach(sku => addDbuRow('', sku.months, 'F9FAFB', 0, sku.rate, `└─ ${sku.skuName} — DBUs`));
    });

    if (activeUseCases.length > 0) {
      // Sum pre-computed UC DBU monthly arrays for subtotal/grand total
      const ucDbuMonthTotals = new Array(36).fill(0);
      ucItems.forEach(({ dbuMonths }) => dbuMonths.forEach((v, i) => { if (i < 36) ucDbuMonthTotals[i] += v; }));
      const totalDbuMonths = (baselineDbuMonths ?? new Array(36).fill(0)).map((v, i) => v + (ucDbuMonthTotals[i] || 0));
      const dbuSubRow = addDbuRow('New Use Cases Subtotal — DBUs', ucDbuMonthTotals, TOTAL_BG, 0, 1);
      const dbuGtRow = addDbuRow(`Grand Total (${ad.accountName}) — DBUs`, totalDbuMonths, GRAND_BG, 0, 1);
      const dbuBaseRN = baselineDbuRow.number;
      const dbuSubRN = dbuSubRow.number;
      for (let c = 4; c <= 43; c++) {
        const col = colLetter(c);
        const cell = dbuGtRow.getCell(c);
        const precomputed = typeof cell.value === 'number' ? cell.value : 0;
        cell.value = { formula: `${col}${dbuBaseRN}+${col}${dbuSubRN}`, result: precomputed };
        if (c > 3) cell.numFmt = '#,##0';
      }
    } else {
      addDbuRow(`Grand Total (${ad.accountName}) — DBUs`, totalMonths, GRAND_BG, 0);
    }

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

    // Baseline year DBUs — from actual baselineDbuMonths (no rate conversion)
    const baseYearDbus = [0, 0, 0];
    (baselineDbuMonths ?? []).forEach((v, i) => {
      if (i < 36) baseYearDbus[Math.floor(i / 12)] += v;
    });

    // UC year DBUs — use pre-computed dbuMonths (ramp × rate + adhoc dbuPerMonth directly)
    const ucYearDbus = [0, 0, 0];
    ucItems.forEach(({ dbuMonths }) => {
      dbuMonths.forEach((v, i) => {
        if (i < 36) ucYearDbus[Math.floor(i / 12)] += v;
      });
    });
    // $DBU group first
    let yearBaselineRow = 0, yearNewUcsRow = 0, yearGrandTotalRow = 0;
    yLabels.forEach((label, li) => {
      const r = ws.addRow([`${label} — $DBU`, yData[li][0], yData[li][1], yData[li][2],
        yData[li].reduce((s, v) => s + v, 0)]);
      r.height = 18;
      applyRowStyle(r, totalStyle(yBgs[li]));
      if (li === 0) yearBaselineRow = r.number;
      else if (li === 1) yearNewUcsRow = r.number;
      else if (li === 2) yearGrandTotalRow = r.number;
      [2, 3, 4, 5].forEach(c => {
        if (typeof r.getCell(c).value === 'number') r.getCell(c).numFmt = USD_FMT;
      });
    });

    // DBU group after
    yLabels.forEach((label, li) => {
      // Baseline: use actual baseYearDbus (no rate conversion)
      // UC: per-year blended rate from SKU breakdown
      // Grand Total: baseline DBU + UC DBU
      const dbuVals = yData[li].map((v, y) => {
        if (li === 0) return Math.round(baseYearDbus[y]);   // Baseline: actual DBUs
        if (li === 1) return Math.round(ucYearDbus[y]);     // UC: from SKU rates
        return Math.round(baseYearDbus[y] + ucYearDbus[y]); // Grand Total
      });
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

    accountRows.push({
      accountName: ad.accountName,
      ucRows: acctUcRows,
      yearSummary: { baselineRow: yearBaselineRow, newUcsRow: yearNewUcsRow, grandTotalRow: yearGrandTotalRow },
    });
  }

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 5, showGridLines: true }];
  return { sheetName: ws.name, accountRows };
}

// ─── Summary sheet (multi-account) ───────────────────────────────────────────

async function buildSummarySheet(
  wb: ExcelJS.Workbook,
  opts: ExportOptions,
  projRowMaps: Record<number, ProjRowMap>
) {
  const ws = wb.addWorksheet('Demand Plan Summary', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    properties: { tabColor: { argb: 'FF' + BRAND } },
  });

  const TOTAL_COLS = 6;
  ws.columns = [
    { key: 'type',  width: 16 },
    { key: 'label', width: 40 },
    { key: 'y1',    width: 18 },
    { key: 'y2',    width: 18 },
    { key: 'y3',    width: 18 },
    { key: 'total', width: 18 },
  ];

  addSheetTitle(ws, 'Demand Plan Summary', 'All prices are Databricks List Price', TOTAL_COLS);

  // Formula cell helper: ExcelJS will prepend '=' when writing
  const fml = (formula: string, result = 0) => ({ formula, result });

  const acctEntries = (opts.accounts || []).filter(a => a.name.trim()).map(a => ({
    displayName: a.name,
    fetchKey: a.sfdc_id?.trim() || a.name,
  }));
  if (acctEntries.length === 0) acctEntries.push({ displayName: opts.account, fetchKey: opts.account });

  for (let si = 0; si < 3; si++) {
    const sNum = (si + 1) as 1 | 2 | 3;
    const sc = SCENARIO_COLORS[sNum];
    const projMap = projRowMaps[sNum];
    const sn = projMap.sheetName; // e.g. "S1_Projection"
    const desc = opts.accountsData[0]?.scenariosData[si]?.assumptions || `Scenario ${sNum}`;

    // Scenario header band
    const secRow = ws.addRow([`SCENARIO ${sNum}  ·  ${desc.toUpperCase()}`]);
    secRow.height = 22;
    secRow.getCell(1).style = {
      font: { bold: true, size: 12, color: rgb('FFFFFF'), name: 'Calibri' },
      fill: { type: 'pattern', pattern: 'solid', fgColor: rgb(sc.bg) },
      alignment: { vertical: 'middle', indent: 1 },
    };
    ws.mergeCells(secRow.number, 1, secRow.number, TOTAL_COLS);
    ws.addRow([]);

    // Cross-account summary table
    const sh = ws.addRow(['SUMMARY  —  Total $DBUs (List)', '', 'Year 1', 'Year 2', 'Year 3', 'Grand Total']);
    applyRowStyle(sh, headerStyle(sc.bg));
    sh.height = 20;
    ws.mergeCells(sh.number, 1, sh.number, 2);

    const acctSummaryRowNums: number[] = [];
    acctEntries.forEach(({ displayName }, idx) => {
      const acctProjRows = projMap.accountRows.find(a => a.accountName === displayName);
      const sd = opts.accountsData.find(a => a.accountName === displayName)?.scenariosData.find(s => s.scenarioNum === sNum);
      const gtR = acctProjRows?.yearSummary.grandTotalRow;
      const y1r = gtR ? fml(`'${sn}'!B${gtR}`, sd?.yearTotals[0] ?? 0) : 0;
      const y2r = gtR ? fml(`'${sn}'!C${gtR}`, sd?.yearTotals[1] ?? 0) : 0;
      const y3r = gtR ? fml(`'${sn}'!D${gtR}`, sd?.yearTotals[2] ?? 0) : 0;
      const totr = gtR ? fml(`'${sn}'!E${gtR}`, (sd?.yearTotals ?? []).reduce((a, b) => a + b, 0)) : 0;
      const dr = ws.addRow([displayName, '', y1r, y2r, y3r, totr]);
      applyRowStyle(dr, dataStyle(idx % 2 === 1));
      [3, 4, 5, 6].forEach(c => { dr.getCell(c).numFmt = USD_FMT; });
      ws.mergeCells(dr.number, 1, dr.number, 2);
      acctSummaryRowNums.push(dr.number);
    });

    // Grand Total (cross-account)
    const fRow = acctSummaryRowNums[0], lRow = acctSummaryRowNums[acctSummaryRowNums.length - 1];
    const gtr = ws.addRow(['Grand Total', '',
      fml(fRow === lRow ? `C${fRow}` : `SUM(C${fRow}:C${lRow})`),
      fml(fRow === lRow ? `D${fRow}` : `SUM(D${fRow}:D${lRow})`),
      fml(fRow === lRow ? `E${fRow}` : `SUM(E${fRow}:E${lRow})`),
      fml(fRow === lRow ? `F${fRow}` : `SUM(F${fRow}:F${lRow})`),
    ]);
    applyRowStyle(gtr, totalStyle(GRAND_BG));
    [3, 4, 5, 6].forEach(c => { gtr.getCell(c).numFmt = USD_FMT; });
    ws.mergeCells(gtr.number, 1, gtr.number, 2);
    ws.addRow([]);

    // Per-account UC detail tables
    acctEntries.forEach(({ displayName: name }) => {
      const acctProjRows = projMap.accountRows.find(a => a.accountName === name);
      const sd = opts.accountsData.find(a => a.accountName === name)?.scenariosData.find(s => s.scenarioNum === sNum);
      if (!acctProjRows || !sd) return;
      const { yearSummary, ucRows } = acctProjRows;

      // Account sub-header
      const dh = ws.addRow([`${name.toUpperCase()}  —  $DBUs List`, '', 'Year 1', 'Year 2', 'Year 3', 'Total']);
      applyRowStyle(dh, headerStyle(SUBHEADER_BG, SUBHEADER_FG));
      ws.mergeCells(dh.number, 1, dh.number, 2);

      // Existing — Live Use Cases (baseline)
      const baseY = sd.baseYearTotals;
      const br = ws.addRow([
        '', 'Existing — Live Use Cases',
        fml(`'${sn}'!B${yearSummary.baselineRow}`, baseY[0] ?? 0),
        fml(`'${sn}'!C${yearSummary.baselineRow}`, baseY[1] ?? 0),
        fml(`'${sn}'!D${yearSummary.baselineRow}`, baseY[2] ?? 0),
        fml(`'${sn}'!E${yearSummary.baselineRow}`, (baseY ?? []).reduce((a, b) => a + b, 0)),
      ]);
      applyRowStyle(br, dataStyle(false));
      [3, 4, 5, 6].forEach(c => { br.getCell(c).numFmt = USD_FMT; });

      // Individual UC rows — cross-sheet monthly SUM formulas
      ucRows.forEach(({ name: ucName, rowNum: ucProjRow }, idx) => {
        const uc = sd.activeUseCases.find(u => u.name === ucName);
        const mp = uc?.monthlyProjection ?? [];
        const ucY1 = mp.slice(0, 12).reduce((a, b) => a + b, 0);
        const ucY2 = mp.slice(12, 24).reduce((a, b) => a + b, 0);
        const ucY3 = mp.slice(24, 36).reduce((a, b) => a + b, 0);
        const r = ws.addRow([
          'New Use Case',
          ucName,
          fml(`SUM('${sn}'!D${ucProjRow}:O${ucProjRow})`, ucY1),   // M1–M12
          fml(`SUM('${sn}'!P${ucProjRow}:AA${ucProjRow})`, ucY2),  // M13–M24
          fml(`SUM('${sn}'!AB${ucProjRow}:AM${ucProjRow})`, ucY3), // M25–M36
          0,
        ]);
        r.getCell(6).value = fml(`C${r.number}+D${r.number}+E${r.number}`, ucY1 + ucY2 + ucY3);
        applyRowStyle(r, dataStyle(idx % 2 === 1));
        // "New Use Case" badge styling on Type cell
        r.getCell(1).style = {
          font: { bold: true, size: 9, name: 'Calibri', color: rgb('1D4ED8') },
          fill: { type: 'pattern', pattern: 'solid', fgColor: rgb('DBEAFE') },
          alignment: { horizontal: 'center', vertical: 'middle' },
        };
        [3, 4, 5, 6].forEach(c => { r.getCell(c).numFmt = USD_FMT; });
      });

      // Total row
      const gtY = sd.yearTotals;
      const tot = ws.addRow([
        `Total (${name})`, '',
        fml(`'${sn}'!B${yearSummary.grandTotalRow}`, gtY[0] ?? 0),
        fml(`'${sn}'!C${yearSummary.grandTotalRow}`, gtY[1] ?? 0),
        fml(`'${sn}'!D${yearSummary.grandTotalRow}`, gtY[2] ?? 0),
        fml(`'${sn}'!E${yearSummary.grandTotalRow}`, (gtY ?? []).reduce((a, b) => a + b, 0)),
      ]);
      applyRowStyle(tot, totalStyle());
      [3, 4, 5, 6].forEach(c => { tot.getCell(c).numFmt = USD_FMT; });
      ws.mergeCells(tot.number, 1, tot.number, 2);
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
    const cloud  = (row.cloud || ad.wsCloud[row.workspace_name] || 'unknown').toLowerCase();
    const domain = ad.domainMapping[row.workspace_name] || ad.domainMapping[row.workspace_name?.toLowerCase()] || 'Unmapped';
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

// ─── Cloud → Domain → SKU: pivot source builder ───────────────────────────────

interface PivotSpec {
  sourceSheetName: string;
  pivotSheetName: string;
  rowCount: number; // data rows excluding header
}

function buildCloudSkuPivotSource(wb: ExcelJS.Workbook, ad: AccountExportData): PivotSpec {
  const srcName = safeName(ad.accountName, ' CldSKU-Src');
  const pvtName = safeName(ad.accountName, ' Cloud-SKU');

  // Hidden flat source table: Cloud | Domain | SKU | Month | Amount ($)
  const src = wb.addWorksheet(srcName, { state: 'veryHidden' });
  src.columns = [
    { key: 'cloud',  width: 12 }, { key: 'domain', width: 26 },
    { key: 'sku',    width: 42 }, { key: 'month',  width: 12 },
    { key: 'amount', width: 16 },
  ];
  const hdr = src.addRow(['Cloud', 'Domain', 'SKU', 'Month', 'Amount ($)']);
  applyRowStyle(hdr, headerStyle());

  let rowCount = 0;
  ad.historicalData.forEach(row => {
    const cloud  = (row.cloud || ad.wsCloud[row.workspace_name] || 'unknown').toLowerCase();
    const domain = ad.domainMapping[row.workspace_name]
      || ad.domainMapping[(row.workspace_name || '').toLowerCase()]
      || 'Unmapped';
    const sku    = row.sku || row.sku_name || 'Unknown';
    const month  = row.month || '';
    const amount = parseFloat(row.dollar_dbu_list) || 0;
    if (month && amount > 0) { src.addRow([cloud, domain, sku, month, amount]); rowCount++; }
  });

  // Empty output sheet — pivot table is injected as XML
  const pvt = wb.addWorksheet(pvtName, { properties: { tabColor: { argb: 'FF0891B2' } } });
  addSheetTitle(pvt, `${ad.accountName} — Cloud → Domain → SKU`,
    'Pivot: Cloud/Domain/SKU rows × Month columns · Refresh on open in Excel', 16);

  return { sourceSheetName: srcName, pivotSheetName: pvtName, rowCount };
}

function _escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _pivotCacheXml(sourceSheet: string, rowCount: number): string {
  const range = `A1:E${rowCount + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" refreshedBy="Excel" refreshedDate="1" refreshedVersion="6" createdVersion="6" recordCount="0" refreshOnLoad="1">
  <cacheSource type="worksheet"><worksheetSource ref="${range}" sheet="${_escXml(sourceSheet)}"/></cacheSource>
  <cacheFields count="5">
    <cacheField name="Cloud" numFmtId="0"><sharedItems/></cacheField>
    <cacheField name="Domain" numFmtId="0"><sharedItems/></cacheField>
    <cacheField name="SKU" numFmtId="0"><sharedItems/></cacheField>
    <cacheField name="Month" numFmtId="0"><sharedItems/></cacheField>
    <cacheField name="Amount ($)" numFmtId="0"><sharedItems containsNumber="1" containsNonDate="1" minValue="0" maxValue="0"/></cacheField>
  </cacheFields>
</pivotCacheDefinition>`;
}

function _pivotTableXml(cacheId: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="PivotTable${cacheId}" cacheId="${cacheId}" applyNumberFormats="0" applyBorderFormats="0" applyFontFormats="0" applyPatternFormats="0" applyAlignmentFormats="0" applyWidthHeightFormats="1" dataCaption="Values" updatedVersion="6" minRefreshableVersion="3" useAutoFormatting="1" itemPrintTitles="1" createdVersion="6" indent="2" outline="1" outlineData="1" compact="0" compactData="0" gridDropZones="0">
  <location ref="A3" firstHeaderRow="1" firstDataRow="2" firstDataCol="1"/>
  <pivotFields count="5">
    <pivotField axis="axisRow" showAll="0" outline="1" subtotalTop="1" compact="0"><items count="1"><item t="default"/></items></pivotField>
    <pivotField axis="axisRow" showAll="0" outline="1" subtotalTop="1" compact="0"><items count="1"><item t="default"/></items></pivotField>
    <pivotField axis="axisRow" showAll="0" outline="0" subtotalTop="0" compact="0" defaultSubtotal="0"><items count="0"/></pivotField>
    <pivotField axis="axisCol" showAll="0" compact="0"><items count="1"><item t="default"/></items></pivotField>
    <pivotField dataField="1" showAll="0" compact="0"/>
  </pivotFields>
  <rowFields count="3"><field x="0"/><field x="1"/><field x="2"/></rowFields>
  <colFields count="1"><field x="3"/></colFields>
  <dataFields count="1"><dataField name="Sum of Amount ($)" fld="4" baseField="0" baseItem="0"/></dataFields>
  <pivotTableStyleInfo name="PivotStyleMedium9" showRowHeaders="1" showColHeaders="1" showRowStripes="0" showColStripes="0" showLastColumn="1"/>
</pivotTableDefinition>`;
}

async function injectPivotTables(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zip: any,
  specs: PivotSpec[]
): Promise<void> {
  if (!specs.length) return;

  const wbXml    = await zip.files['xl/workbook.xml'].async('string');
  const wbRels   = await zip.files['xl/_rels/workbook.xml.rels'].async('string');

  // rId → target path
  const relMap: Record<string, string> = {};
  const relRe = /Id="([^"]+)"[^/]*Target="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = relRe.exec(wbRels)) !== null) relMap[m[1]] = m[2];

  // sheet name → rId
  const sheetRid: Record<string, string> = {};
  const shRe = /name="([^"]+)"[^/]*r:id="([^"]+)"/g;
  while ((m = shRe.exec(wbXml)) !== null) sheetRid[m[1]] = m[2];

  let maxRid = Math.max(0, ...Object.keys(relMap).map(k => parseInt(k.replace(/\D/g, ''), 10) || 0));
  let ctXml  = await zip.files['[Content_Types].xml'].async('string');
  let curRels = wbRels;
  let curWb   = wbXml;

  for (let i = 0; i < specs.length; i++) {
    const spec    = specs[i];
    const cacheId = i + 1;
    const cacheRid = `rId${++maxRid}`;

    const pvtRid    = sheetRid[spec.pivotSheetName];
    if (!pvtRid) continue;
    const pvtTarget = relMap[pvtRid];              // "worksheets/sheetN.xml"
    const pvtFile   = pvtTarget?.split('/').pop(); // "sheetN.xml"
    if (!pvtFile) continue;

    // Pivot cache definition
    zip.file(`xl/pivotCache/pivotCacheDefinition${cacheId}.xml`,
      _pivotCacheXml(spec.sourceSheetName, spec.rowCount));

    // Pivot table definition
    zip.file(`xl/pivotTables/pivotTable${cacheId}.xml`, _pivotTableXml(cacheId));

    // Pivot table → cache rels
    zip.file(`xl/pivotTables/_rels/pivotTable${cacheId}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="../pivotCache/pivotCacheDefinition${cacheId}.xml"/></Relationships>`);

    // Worksheet → pivot table rels
    const wsRelsPath = `xl/worksheets/_rels/${pvtFile}.rels`;
    const pvtRelEntry = `<Relationship Id="rId_pv${cacheId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable${cacheId}.xml"/>`;
    if (zip.files[wsRelsPath]) {
      const ex = await zip.files[wsRelsPath].async('string');
      zip.file(wsRelsPath, ex.replace('</Relationships>', `${pvtRelEntry}</Relationships>`));
    } else {
      zip.file(wsRelsPath, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${pvtRelEntry}</Relationships>`);
    }

    // Workbook rels: add pivot cache
    curRels = curRels.replace('</Relationships>',
      `<Relationship Id="${cacheRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition${cacheId}.xml"/></Relationships>`);

    // Workbook.xml: add <pivotCache> entry
    const pvtCacheEl = `<pivotCache cacheId="${cacheId}" r:id="${cacheRid}"/>`;
    if (curWb.includes('<pivotCaches>')) {
      curWb = curWb.replace('</pivotCaches>', `${pvtCacheEl}</pivotCaches>`);
    } else {
      curWb = curWb.replace('</workbook>', `<pivotCaches>${pvtCacheEl}</pivotCaches></workbook>`);
    }

    // Content types
    const addCT = (part: string, ct: string) => {
      if (!ctXml.includes(part)) ctXml = ctXml.replace('</Types>', `<Override PartName="${part}" ContentType="${ct}"/></Types>`);
    };
    addCT(`/xl/pivotCache/pivotCacheDefinition${cacheId}.xml`,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml');
    addCT(`/xl/pivotTables/pivotTable${cacheId}.xml`,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml');
  }

  zip.file('[Content_Types].xml', ctXml);
  zip.file('xl/_rels/workbook.xml.rels', curRels);
  zip.file('xl/workbook.xml', curWb);
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

  // Columns: Name | Domain | Size Tier | DBUs/mo | $/mo | $/DBU | Workload Type | Cloud | Onboard | Live | Ramp Duration | Ramp | S1|S2|S3 | Y1 | Y2 | Y3 | Total | Assumptions
  ws.columns = [
    { key: 'name',     width: 34 }, { key: 'domain',   width: 22 }, { key: 'tier',    width: 18 },
    { key: 'dbus',     width: 14 }, { key: 'ssmo',     width: 14 }, { key: 'dbuprice',width: 10 },
    { key: 'wltype',   width: 18 }, { key: 'cloud',    width: 10 },
    { key: 'onboard',  width: 16 }, { key: 'live',     width: 16 }, { key: 'rampmo',  width: 14 },
    { key: 'ramp',     width: 14 }, { key: 's1',       width: 5  }, { key: 's2',      width: 5  },
    { key: 's3',       width: 5  }, { key: 'y1',       width: 18 }, { key: 'y2',      width: 18 },
    { key: 'y3',       width: 18 }, { key: 'total',    width: 18 }, { key: 'notes',   width: 60 },
  ];

  addSheetTitle(ws, `${ad.accountName} — Use Case Details`, 'All use cases with full configuration, SKU breakdown, description, and assumptions', 20);
  const hrow = ws.addRow([
    'Name', 'Domain', 'Size Tier', 'DBUs/mo (steady state)', '$/mo (Steady State)', '$/DBU (blended)',
    'Workload Type', 'Cloud',
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
    const blendedDbuPerDollar = estDbus > 0 ? uc.steadyStateDbu / estDbus : 0;
    const ucRow = ws.addRow([
      ucDisplayName,
      uc.domain,
      sizeTierLabel(uc.steadyStateDbu),
      estDbus,                                         // col 4: DBUs/mo
      uc.upliftOnly ? 0 : uc.steadyStateDbu,           // col 5: $/mo (steady state)
      uc.upliftOnly ? 0 : blendedDbuPerDollar,         // col 6: $/DBU (blended)
      uc.workloadType || '—',                          // col 7: Workload Type
      uc.cloud || '',                                  // col 8: Cloud
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
    ucRow.getCell(5).numFmt = USD_FMT;   // $/mo
    ucRow.getCell(6).numFmt = '$#,##0.00'; // $/DBU blended
    [16, 17, 18, 19].forEach(col => {
      const c = ucRow.getCell(col); if (typeof c.value === 'number') c.numFmt = USD_FMT;
    });
    [13, 14, 15].forEach(col => {
      ucRow.getCell(col).alignment = { horizontal: 'center', vertical: 'middle' };
      ucRow.getCell(col).font = { color: rgb('059669'), bold: true, name: 'Calibri', size: 11 };
    });
    ucRow.getCell(20).alignment = { wrapText: true, vertical: 'top' };

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
          pricePerDbu,
          '', '', '', '', '', '', '', '', '',
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
        skuRow.getCell(5).numFmt = USD_FMT;
        skuRow.getCell(6).numFmt = '$#,##0.00';
        [16, 17, 18, 19].forEach(col => {
          const c = skuRow.getCell(col); if (typeof c.value === 'number') c.numFmt = USD_FMT;
        });
        skuRow.getCell(1).alignment = { vertical: 'middle', indent: 2 };
        skuRow.getCell(20).alignment = { vertical: 'middle', wrapText: true };
      });
      // Footnote row if any custom prices used
      if (hasCustomPrice) {
        const noteRow = ws.addRow(['    * Custom price — SKU not yet in standard price list', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
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
        const periodTotalDbu = period.skuAmounts.reduce((s, sa) => s + (sa.dbuPerMonth || 0), 0);
        const monthsLabel = period.months.length > 0 ? `Months: ${period.months.join(', ')}` : 'No months selected';
        const y1Adhoc = period.months.filter(m => m >= 1 && m <= 12).length * periodTotal;
        const y2Adhoc = period.months.filter(m => m >= 13 && m <= 24).length * periodTotal;
        const y3Adhoc = period.months.filter(m => m >= 25 && m <= 36).length * periodTotal;
        const dbuLabel = periodTotalDbu > 0 ? `+${Math.round(periodTotalDbu).toLocaleString()} DBUs/mo (${periodTotal.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}/mo)` : (periodTotal > 0 ? `+${periodTotal.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}/mo` : '');
        const adhocRow = ws.addRow([
          `    ⚡ ${period.label}`,
          '',
          `${period.months.length} months`,
          '',
          periodTotal,
          '',
          dbuLabel,
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
        adhocRow.getCell(5).numFmt = USD_FMT;
        [16, 17, 18, 19].forEach(col => {
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
    ad.allUseCases.reduce((s, uc) => s + (uc.upliftOnly ? 0 : (uc.skuBreakdown?.length ? uc.skuBreakdown.reduce((a, sk) => a + sk.dbus, 0) : Math.round(uc.steadyStateDbu / 0.20))), 0),
    ad.allUseCases.reduce((s, uc) => s + (uc.upliftOnly ? 0 : uc.steadyStateDbu), 0),
    '', '', '', '', '', '', '', '', '', '',
    ad.allUseCases.reduce((s, uc) => s + uc.monthlyProjection.slice(0, 12).reduce((a, v) => a + v, 0), 0),
    ad.allUseCases.reduce((s, uc) => s + uc.monthlyProjection.slice(12, 24).reduce((a, v) => a + v, 0), 0),
    ad.allUseCases.reduce((s, uc) => s + uc.monthlyProjection.slice(24, 36).reduce((a, v) => a + v, 0), 0),
    ad.allUseCases.reduce((s, uc) => s + uc.monthlyProjection.reduce((a, v) => a + v, 0), 0),
    '',
  ]);
  applyRowStyle(totRow, totalStyle(GRAND_BG));
  totRow.getCell(4).numFmt = '#,##0';
  totRow.getCell(5).numFmt = USD_FMT;
  [16, 17, 18, 19].forEach(col => {
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
      `${ad.accountName.toUpperCase()}  ·  S${scenarioNum}  ·  Baseline Growth: ${baselineGrowthRate.toFixed(2)}% MoM` +
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

  // 1. Projection sheets first (to capture row maps for cross-sheet references)
  const projRowMaps: Record<number, ProjRowMap> = {};
  for (const sNum of [1, 2, 3] as const) {
    projRowMaps[sNum] = buildProjectionSheetMulti(wb, sNum, opts.accountsData);
  }

  // 2. Summary sheet (references projection sheet cells)
  await buildSummarySheet(wb, opts, projRowMaps);

  // 3. Historical sheets + pivot source: one set per account
  const pivotSpecs: PivotSpec[] = [];
  for (const ad of opts.accountsData) {
    buildHistoricalDomainSheet(wb, ad);
    buildHistoricalSkuSheet(wb, ad);
    pivotSpecs.push(buildCloudSkuPivotSource(wb, ad));
  }

  // 5. Per-account detail sheets
  for (const ad of opts.accountsData) {
    buildUseCaseDetailsSheet(wb, ad);
    buildDomainBaselineSheet(wb, ad);
  }

  // Move 'Demand Plan Summary' to first sheet position.
  // Projection sheets must be built first (row maps for cross-sheet refs), so we reorder after.
  // ExcelJS sorts worksheets by orderNo; shift all earlier sheets up by 1, set Summary to 0.
  const summarySheet = wb.getWorksheet('Demand Plan Summary');
  if (summarySheet) {
    const summaryOrderNo = (summarySheet as unknown as { orderNo: number }).orderNo;
    wb.worksheets.forEach(ws => {
      const w = ws as unknown as { orderNo: number };
      if (w.orderNo < summaryOrderNo) w.orderNo += 1;
    });
    (summarySheet as unknown as { orderNo: number }).orderNo = 0;
  }

  const rawBuffer = await wb.xlsx.writeBuffer();

  // ExcelJS XML-escapes single quotes in <f> tags (e.g. &apos;Sheet&apos;!A1).
  // Excel's formula parser reads raw XML content and cannot decode XML entities,
  // so cross-sheet references break. Post-process the ZIP to unescape them.
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(rawBuffer);

  // Inject pivot table XML for each account's Cloud→Domain→SKU sheet
  await injectPivotTables(zip, pivotSpecs);

  const wsFiles = Object.keys(zip.files).filter(
    n => n.startsWith('xl/worksheets/') && n.endsWith('.xml')
  );
  await Promise.all(wsFiles.map(async name => {
    const xml = await zip.files[name].async('string');
    const fixed = xml.replace(/<f([^>]*)>([^<]*)<\/f>/g,
      (_m, attrs, formula) => `<f${attrs}>${formula.replace(/&apos;/g, "'")}<\/f>`
    );
    zip.file(name, fixed);
  }));
  const buffer = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });

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
