import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import { fetchSummaryAll } from './api';
import type { AccountConfig } from './App';
import type { ExportOptions, ScenarioExportData } from './exportExcelJS';

export type { ExportOptions, ScenarioExportData } from './exportExcelJS';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function applyDollarFormat(ws: XLSX.WorkSheet) {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (cell && cell.t === 'n' && typeof cell.v === 'number') {
        cell.v = Math.round(cell.v);
        cell.z = '$#,##0';
      }
    }
  }
}

function applyPercentFormat(ws: XLSX.WorkSheet, col: number, startRow: number) {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (let r = startRow; r <= range.e.r; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: col });
    const cell = ws[addr];
    if (cell && cell.t === 'n' && typeof cell.v === 'number' && cell.v >= 0 && cell.v <= 1) {
      cell.z = '0.0%';
    }
  }
}

// ─── Projection sheet (HORIZONTAL) ───────────────────────────────────────────
// Rows = use cases; Columns = Label | M1…M36 | Y1 Total | Y2 Total | Y3 Total | Grand Total

function buildProjectionSheet(wb: XLSX.WorkBook, sd: ScenarioExportData) {
  const { scenarioNum, assumptions, baselineGrowthRate,
          activeUseCases, baselineMonths, totalMonths,
          baseYearTotals, ucYearTotals, yearTotals } = sd;

  const ucYearSlice = (vals: number[], yr: number) =>
    vals.slice(yr * 12, (yr + 1) * 12).reduce((s, v) => s + v, 0);

  // Header row: blank label | M1(Y1) … M12(Y1) | M13(Y2) … | year totals
  const monthHeaders = Array.from({ length: 36 }, (_, i) => {
    const yr = Math.floor(i / 12) + 1;
    const mo = (i % 12) + 1;
    return `M${mo}Y${yr}`;
  });

  const rows: any[][] = [
    [`Scenario ${scenarioNum} — 36-Month Projection`, `Growth: ${baselineGrowthRate.toFixed(1)}% MoM`, assumptions || ''],
    [],
    ['', ...monthHeaders, 'Y1 Total', 'Y2 Total', 'Y3 Total', 'Grand Total'],
  ];

  // Baseline row
  const blY1 = ucYearSlice(baselineMonths, 0);
  const blY2 = ucYearSlice(baselineMonths, 1);
  const blY3 = ucYearSlice(baselineMonths, 2);
  rows.push(['Baseline', ...baselineMonths, blY1, blY2, blY3, blY1 + blY2 + blY3]);

  // Use case rows
  const ucMonthTotals = new Array(36).fill(0);
  activeUseCases.forEach(uc => {
    const mp = uc.monthlyProjection;
    mp.forEach((v, i) => { ucMonthTotals[i] += v; });
    const y1 = ucYearSlice(mp, 0), y2 = ucYearSlice(mp, 1), y3 = ucYearSlice(mp, 2);
    rows.push([`  ↳ ${uc.name}`, ...mp, y1, y2, y3, y1 + y2 + y3]);
  });

  // New use cases subtotal
  if (activeUseCases.length > 0) {
    const ucY1 = ucYearSlice(ucMonthTotals, 0), ucY2 = ucYearSlice(ucMonthTotals, 1), ucY3 = ucYearSlice(ucMonthTotals, 2);
    rows.push(['New Use Cases Total', ...ucMonthTotals, ucY1, ucY2, ucY3, ucY1 + ucY2 + ucY3]);
  }

  // Grand total
  rows.push(['Grand Total', ...totalMonths, yearTotals[0], yearTotals[1], yearTotals[2], yearTotals.reduce((s, v) => s + v, 0)]);

  // Year summary block
  rows.push([]);
  rows.push(['', 'Year 1', 'Year 2', 'Year 3', 'Grand Total']);
  [
    ['Baseline',       baseYearTotals],
    ['New Use Cases',  ucYearTotals],
    ['Grand Total',    yearTotals],
  ].forEach(([label, data]) => {
    const d = data as number[];
    rows.push([label, d[0], d[1], d[2], d.reduce((s, v) => s + v, 0)]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    { wch: 36 },
    ...Array(36).fill({ wch: 9 }),
    { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 },
  ];
  // Freeze first column + first 3 rows (title, blank, header)
  ws['!freeze'] = { xSplit: 1, ySplit: 3 } as any;
  applyDollarFormat(ws);

  const sheetName = `S${scenarioNum} Projection`;
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function exportToXLS(opts: ExportOptions) {
  const wb = XLSX.utils.book_new();
  const months = [...new Set(opts.historicalData.map(r => r.month))].sort();

  // ── Sheet 1: Demand Plan Summary ──
  const allAccountSummaries: Record<string, any> = {};
  const accountNames = (opts.accounts || []).filter(a => a.name.trim()).map(a => a.name);
  if (accountNames.length === 0) accountNames.push(opts.account);

  await Promise.all(accountNames.map(async (name) => {
    try { allAccountSummaries[name] = await fetchSummaryAll(name); } catch {}
  }));

  const summaryRows: any[][] = [];
  summaryRows.push(['', 'Databricks Pricing:']);
  summaryRows.push(['', 'Note: All Prices are Databricks List Price.']);
  summaryRows.push(['']);
  summaryRows.push(['']);

  for (let si = 0; si < 3; si++) {
    const scenarioNum = si + 1;
    const firstAccountData = allAccountSummaries[accountNames[0]];
    const description = firstAccountData?.scenarios?.[si]?.description || `Scenario ${scenarioNum}`;
    summaryRows.push(['', `Scenario ${scenarioNum} (${description})`]);
    summaryRows.push(['']);
    summaryRows.push(['', 'SUMMARY']);
    summaryRows.push(['', 'Total $DBUs (DBCU at List)', 'Year 1', 'Year 2', 'Year 3', 'Grand Total']);

    let crossY1 = 0, crossY2 = 0, crossY3 = 0, crossTotal = 0;
    accountNames.forEach((acctName) => {
      const gt = allAccountSummaries[acctName]?.scenarios?.[si]?.summary_rows?.find((r: any) => r.use_case_area === 'Grand Total');
      const y1 = gt?.year1 || 0, y2 = gt?.year2 || 0, y3 = gt?.year3 || 0, total = gt?.total || 0;
      summaryRows.push(['', acctName, y1, y2, y3, total]);
      crossY1 += y1; crossY2 += y2; crossY3 += y3; crossTotal += total;
    });
    summaryRows.push(['', 'Grand Total', crossY1, crossY2, crossY3, crossTotal]);
    summaryRows.push(['']);
    summaryRows.push(['']);

    accountNames.forEach((acctName) => {
      const scenarioData = allAccountSummaries[acctName]?.scenarios?.[si];
      const grandTotal = scenarioData?.summary_rows?.find((r: any) => r.use_case_area === 'Grand Total');
      const baselineRow = scenarioData?.summary_rows?.find(
        (r: any) => !r.is_use_case && r.use_case_area !== 'Grand Total' && r.use_case_area !== 'New Use Cases'
      );
      const useCaseRows = scenarioData?.summary_rows?.filter((r: any) => r.is_use_case) || [];

      summaryRows.push(['', `$DBUs List (${acctName.toUpperCase()})`, 'Year 1', 'Year 2', 'Year 3', 'Total']);
      if (baselineRow) {
        summaryRows.push(['', 'Existing - Live Use Cases', baselineRow.year1, baselineRow.year2, baselineRow.year3, baselineRow.total]);
      }
      useCaseRows.forEach((row: any) => {
        summaryRows.push(['', (row.use_case_area || '').replace(/^\s*↳\s*/, '').trim(), row.year1, row.year2, row.year3, row.total]);
      });
      const y1 = grandTotal?.year1 || 0, y2 = grandTotal?.year2 || 0, y3 = grandTotal?.year3 || 0, total = grandTotal?.total || 0;
      summaryRows.push(['', `Total (${acctName})`, y1, y2, y3, total]);
      summaryRows.push(['']);
    });
    summaryRows.push(['']);
  }

  const ws1 = XLSX.utils.aoa_to_sheet(summaryRows);
  ws1['!cols'] = [{ wch: 4 }, { wch: 40 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
  applyDollarFormat(ws1);
  XLSX.utils.book_append_sheet(wb, ws1, 'Demand Plan Summary');

  // ── Sheet 2: Historical by Domain ──
  const domainMonthly: Record<string, Record<string, number>> = {};
  opts.historicalData.forEach(row => {
    const domain = opts.domainMapping[row.workspace_name] || 'Unmapped';
    const dbu = parseFloat(row.dollar_dbu_list) || 0;
    if (!domainMonthly[domain]) domainMonthly[domain] = {};
    domainMonthly[domain][row.month] = (domainMonthly[domain][row.month] || 0) + dbu;
  });
  const domainKeys = Object.keys(domainMonthly).sort((a, b) =>
    Object.values(domainMonthly[b]).reduce((s, v) => s + v, 0) - Object.values(domainMonthly[a]).reduce((s, v) => s + v, 0)
  );
  const domRows: any[][] = [['Domain', ...months, 'Total']];
  domainKeys.forEach(d => {
    domRows.push([d, ...months.map(m => domainMonthly[d][m] || 0), Object.values(domainMonthly[d]).reduce((s, v) => s + v, 0)]);
  });
  domRows.push(['Grand Total', ...months.map(m => domainKeys.reduce((s, d) => s + (domainMonthly[d][m] || 0), 0)),
    domainKeys.reduce((s, d) => s + Object.values(domainMonthly[d]).reduce((a, b) => a + b, 0), 0)]);
  const ws2 = XLSX.utils.aoa_to_sheet(domRows);
  ws2['!cols'] = [{ wch: 30 }, ...months.map(() => ({ wch: 14 })), { wch: 16 }];
  applyDollarFormat(ws2);
  XLSX.utils.book_append_sheet(wb, ws2, 'Historical by Domain');

  // ── Sheet 3: Historical by SKU ──
  const skuMonthly: Record<string, Record<string, number>> = {};
  opts.historicalData.forEach(row => {
    const sku = row.sku || row.sku_name || 'Unknown';
    const dbu = parseFloat(row.dollar_dbu_list) || 0;
    if (!skuMonthly[sku]) skuMonthly[sku] = {};
    skuMonthly[sku][row.month] = (skuMonthly[sku][row.month] || 0) + dbu;
  });
  const skuKeys = Object.keys(skuMonthly).sort((a, b) =>
    Object.values(skuMonthly[b]).reduce((s, v) => s + v, 0) - Object.values(skuMonthly[a]).reduce((s, v) => s + v, 0)
  );
  const skuRows: any[][] = [['SKU', ...months, 'Total']];
  skuKeys.forEach(s => {
    skuRows.push([s, ...months.map(m => skuMonthly[s][m] || 0), Object.values(skuMonthly[s]).reduce((sv, v) => sv + v, 0)]);
  });
  skuRows.push(['Grand Total', ...months.map(m => skuKeys.reduce((s, k) => s + (skuMonthly[k][m] || 0), 0)),
    skuKeys.reduce((s, k) => s + Object.values(skuMonthly[k]).reduce((a, b) => a + b, 0), 0)]);
  const ws3 = XLSX.utils.aoa_to_sheet(skuRows);
  ws3['!cols'] = [{ wch: 45 }, ...months.map(() => ({ wch: 14 })), { wch: 16 }];
  applyDollarFormat(ws3);
  XLSX.utils.book_append_sheet(wb, ws3, 'Historical by SKU');

  // ── Sheet 4: Cloud → Domain → SKU ──
  const cdsRows: any[][] = [['Cloud', 'Domain', 'SKU', ...months, 'Total']];
  const cloudData: Record<string, Record<string, Record<string, Record<string, number>>>> = {};
  opts.historicalData.forEach(row => {
    const cloud = opts.wsCloud[row.workspace_name] || 'unknown';
    const domain = opts.domainMapping[row.workspace_name] || 'Unmapped';
    const sku = row.sku || row.sku_name || 'Unknown';
    const dbu = parseFloat(row.dollar_dbu_list) || 0;
    if (!cloudData[cloud]) cloudData[cloud] = {};
    if (!cloudData[cloud][domain]) cloudData[cloud][domain] = {};
    if (!cloudData[cloud][domain][sku]) cloudData[cloud][domain][sku] = {};
    cloudData[cloud][domain][sku][row.month] = (cloudData[cloud][domain][sku][row.month] || 0) + dbu;
  });
  Object.keys(cloudData).sort().forEach(cloud => {
    const cloudTotal: Record<string, number> = {};
    Object.values(cloudData[cloud]).forEach(domains =>
      Object.values(domains).forEach(skus =>
        Object.entries(skus).forEach(([m, v]) => { cloudTotal[m] = (cloudTotal[m] || 0) + v; })
      )
    );
    const cTotal = Object.values(cloudTotal).reduce((s, v) => s + v, 0);
    cdsRows.push([cloud.toUpperCase(), '', '', ...months.map(m => cloudTotal[m] || 0), cTotal]);
    Object.keys(cloudData[cloud]).sort().forEach(domain => {
      const domTotal: Record<string, number> = {};
      Object.values(cloudData[cloud][domain]).forEach(skus =>
        Object.entries(skus).forEach(([m, v]) => { domTotal[m] = (domTotal[m] || 0) + v; })
      );
      cdsRows.push(['', domain, '', ...months.map(m => domTotal[m] || 0), Object.values(domTotal).reduce((s, v) => s + v, 0)]);
      Object.keys(cloudData[cloud][domain]).sort().forEach(sku => {
        const skuData = cloudData[cloud][domain][sku];
        cdsRows.push(['', '', sku, ...months.map(m => skuData[m] || 0), Object.values(skuData).reduce((s, v) => s + v, 0)]);
      });
    });
  });
  const ws4 = XLSX.utils.aoa_to_sheet(cdsRows);
  ws4['!cols'] = [{ wch: 12 }, { wch: 25 }, { wch: 40 }, ...months.map(() => ({ wch: 14 })), { wch: 16 }];
  applyDollarFormat(ws4);
  XLSX.utils.book_append_sheet(wb, ws4, 'Cloud-Domain-SKU');

  // ── Sheets 5-7: One horizontal projection sheet per scenario ──
  for (const sd of opts.scenariosData) {
    buildProjectionSheet(wb, sd);
  }

  // ── Sheet 8: Use Case Details ──
  const ucRows: any[][] = [
    ['Use Case Details'],
    [''],
    ['Name', 'Domain', 'Steady-State $/mo', 'Onboarding Month', 'Live Month', 'Ramp Type', 'S1', 'S2', 'S3', 'Year 1', 'Year 2', 'Year 3', 'Total'],
  ];
  opts.allUseCases.forEach(uc => {
    const yT = [0, 0, 0];
    uc.monthlyProjection.forEach((v, i) => { yT[Math.floor(i / 12)] += v; });
    ucRows.push([
      uc.name, uc.domain, uc.steadyStateDbu,
      `M${uc.onboardingMonth}`, `M${uc.liveMonth}`, uc.rampType,
      uc.scenarios[0] ? 'Yes' : 'No',
      uc.scenarios[1] ? 'Yes' : 'No',
      uc.scenarios[2] ? 'Yes' : 'No',
      yT[0], yT[1], yT[2], yT.reduce((a, b) => a + b, 0),
    ]);
  });
  const ws8 = XLSX.utils.aoa_to_sheet(ucRows);
  ws8['!cols'] = [{ wch: 30 }, { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 14 }, { wch: 5 }, { wch: 5 }, { wch: 5 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
  applyDollarFormat(ws8);
  XLSX.utils.book_append_sheet(wb, ws8, 'Use Case Details');

  // ── Sheet 9: Domain Baseline ──
  const blRows: any[][] = [
    ['Domain Baseline Summary'], [''],
    ['Domain', 'T12M $DBU', 'Avg Monthly', '% of Total'],
  ];
  const totalBL = opts.domainBaselines.reduce((s, b) => s + b.t12m, 0);
  opts.domainBaselines.forEach(b => {
    blRows.push([b.domain, b.t12m, b.avgMonthly, totalBL > 0 ? b.t12m / totalBL : 0]);
  });
  blRows.push(['Grand Total', totalBL, totalBL / 12, 1]);
  const ws9 = XLSX.utils.aoa_to_sheet(blRows);
  ws9['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 18 }, { wch: 12 }];
  applyDollarFormat(ws9);
  applyPercentFormat(ws9, 3, 3);
  XLSX.utils.book_append_sheet(wb, ws9, 'Domain Baseline');

  // ── Sheet 10: SKU Breakdown ──
  const skuBdRows: any[][] = [
    ['Use Case SKU Breakdown'], [''],
    ['Use Case Name', 'SKU', 'Cloud', '% Split', 'DBUs/mo', '$/DBU', '$/month', 'Assumptions'],
  ];
  opts.allUseCases.forEach(uc => {
    if (!uc.skuBreakdown?.length) return;
    uc.skuBreakdown.forEach((alloc, idx) => {
      const price = alloc.dbus > 0 ? alloc.dollarDbu / alloc.dbus : 0;
      skuBdRows.push([
        idx === 0 ? uc.name : '', alloc.sku, uc.cloud || '',
        alloc.percentage / 100, Math.round(alloc.dbus), price, alloc.dollarDbu,
        idx === 0 ? (uc.assumptions || '') : '',
      ]);
    });
    const totDbus = uc.skuBreakdown.reduce((s, a) => s + a.dbus, 0);
    const totDollar = uc.skuBreakdown.reduce((s, a) => s + a.dollarDbu, 0);
    const totPct = uc.skuBreakdown.reduce((s, a) => s + a.percentage, 0);
    skuBdRows.push(['', 'SUBTOTAL', '', totPct / 100, Math.round(totDbus),
      totDbus > 0 ? totDollar / totDbus : 0, totDollar, '']);
  });
  const ws10 = XLSX.utils.aoa_to_sheet(skuBdRows);
  ws10['!cols'] = [{ wch: 30 }, { wch: 25 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 50 }];
  applyDollarFormat(ws10);
  applyPercentFormat(ws10, 3, 3);
  XLSX.utils.book_append_sheet(wb, ws10, 'SKU Breakdown');

  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const filename = `Demand_Plan_${opts.account}_AllScenarios_${new Date().toISOString().split('T')[0]}.xlsx`;
  saveAs(blob, filename);
  return filename;
}
