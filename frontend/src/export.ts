import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import { formatCurrency } from './api';

interface ExportOptions {
  account: string;
  scenario: number;
  // Historical data
  historicalData: any[];
  domainMapping: Record<string, string>;
  wsCloud: Record<string, string>;
  wsOrg: Record<string, string>;
  // Scenario data
  baselineGrowthRate: number;
  assumptions: string;
  domainBaselines: { domain: string; t12m: number; avgMonthly: number }[];
  useCases: {
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
    skuBreakdown?: {
      sku: string;
      percentage: number;
      dbus: number;
      dollarDbu: number;
    }[];
  }[];
  projections: {
    baseYearTotals: number[];
    ucYearTotals: number[];
    yearTotals: number[];
    baselineMonths: number[];
    totalMonths: number[];
  };
}

function numFmt(v: number): string {
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

// Apply $#,##0 format to all numeric cells in a worksheet
function applyDollarFormat(ws: XLSX.WorkSheet) {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (cell && cell.t === 'n' && typeof cell.v === 'number') {
        // Round to integer and apply dollar format
        cell.v = Math.round(cell.v);
        cell.z = '$#,##0';
      }
    }
  }
}

// Apply percentage format to cells that look like percentages (0-1 range)
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

export function exportToXLS(opts: ExportOptions) {
  const wb = XLSX.utils.book_new();
  const months = [...new Set(opts.historicalData.map(r => r.month))].sort();

  // ── Sheet 1: Demand Plan Summary ──
  const summaryRows: any[][] = [
    ['Demand Plan Summary'],
    ['Account', opts.account],
    ['Scenario', `Scenario ${opts.scenario}`],
    ['Baseline Growth Rate', `${opts.baselineGrowthRate}% MoM`],
    [''],
    ['', '', 'Year 1', 'Year 2', 'Year 3', 'Total'],
    [
      'Existing Baseline',
      `(with ${opts.baselineGrowthRate}% MoM growth)`,
      opts.projections.baseYearTotals[0],
      opts.projections.baseYearTotals[1],
      opts.projections.baseYearTotals[2],
      opts.projections.baseYearTotals.reduce((a, b) => a + b, 0),
    ],
  ];

  // Add each use case
  opts.useCases.filter(uc => uc.scenarios[opts.scenario - 1]).forEach(uc => {
    const yT = [0, 0, 0];
    uc.monthlyProjection.forEach((v, i) => { yT[Math.floor(i / 12)] += v; });
    summaryRows.push([
      `  ${uc.name}`,
      `${uc.domain} | ${uc.rampType} | M${uc.onboardingMonth}→M${uc.liveMonth}`,
      yT[0], yT[1], yT[2], yT.reduce((a, b) => a + b, 0),
    ]);
  });

  summaryRows.push([
    'Grand Total', '',
    opts.projections.yearTotals[0],
    opts.projections.yearTotals[1],
    opts.projections.yearTotals[2],
    opts.projections.yearTotals.reduce((a, b) => a + b, 0),
  ]);

  summaryRows.push(['']);
  summaryRows.push(['Assumptions']);
  summaryRows.push([opts.assumptions]);

  const ws1 = XLSX.utils.aoa_to_sheet(summaryRows);
  // Set column widths
  ws1['!cols'] = [{ wch: 40 }, { wch: 35 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
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
    const total = Object.values(domainMonthly[d]).reduce((s, v) => s + v, 0);
    domRows.push([d, ...months.map(m => domainMonthly[d][m] || 0), total]);
  });
  // Grand total
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
    const total = Object.values(skuMonthly[s]).reduce((sv, v) => sv + v, 0);
    skuRows.push([s, ...months.map(m => skuMonthly[s][m] || 0), total]);
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
    const ws = row.workspace_name || '';
    const cloud = opts.wsCloud[ws] || 'unknown';
    const domain = opts.domainMapping[ws] || 'Unmapped';
    const sku = row.sku || row.sku_name || 'Unknown';
    const dbu = parseFloat(row.dollar_dbu_list) || 0;
    if (!cloudData[cloud]) cloudData[cloud] = {};
    if (!cloudData[cloud][domain]) cloudData[cloud][domain] = {};
    if (!cloudData[cloud][domain][sku]) cloudData[cloud][domain][sku] = {};
    cloudData[cloud][domain][sku][row.month] = (cloudData[cloud][domain][sku][row.month] || 0) + dbu;
  });

  Object.keys(cloudData).sort().forEach(cloud => {
    // Cloud total row
    const cloudTotal: Record<string, number> = {};
    Object.values(cloudData[cloud]).forEach(domains =>
      Object.values(domains).forEach(skus =>
        Object.entries(skus).forEach(([m, v]) => { cloudTotal[m] = (cloudTotal[m] || 0) + v; })
      )
    );
    const cTotal = Object.values(cloudTotal).reduce((s, v) => s + v, 0);
    cdsRows.push([cloud.toUpperCase(), '', '', ...months.map(m => cloudTotal[m] || 0), cTotal]);

    Object.keys(cloudData[cloud]).sort().forEach(domain => {
      // Domain total row
      const domTotal: Record<string, number> = {};
      Object.values(cloudData[cloud][domain]).forEach(skus =>
        Object.entries(skus).forEach(([m, v]) => { domTotal[m] = (domTotal[m] || 0) + v; })
      );
      const dTotal = Object.values(domTotal).reduce((s, v) => s + v, 0);
      cdsRows.push(['', domain, '', ...months.map(m => domTotal[m] || 0), dTotal]);

      Object.keys(cloudData[cloud][domain]).sort().forEach(sku => {
        const skuData = cloudData[cloud][domain][sku];
        const sTotal = Object.values(skuData).reduce((s, v) => s + v, 0);
        cdsRows.push(['', '', sku, ...months.map(m => skuData[m] || 0), sTotal]);
      });
    });
  });

  const ws4 = XLSX.utils.aoa_to_sheet(cdsRows);
  ws4['!cols'] = [{ wch: 12 }, { wch: 25 }, { wch: 40 }, ...months.map(() => ({ wch: 14 })), { wch: 16 }];
  applyDollarFormat(ws4);
  XLSX.utils.book_append_sheet(wb, ws4, 'Cloud-Domain-SKU');

  // ── Sheet 5: 36-Month Projection ──
  const projRows: any[][] = [
    ['36-Month Projection', `Scenario ${opts.scenario}`, `Baseline Growth: ${opts.baselineGrowthRate}% MoM`],
    [''],
    ['Month', 'Baseline', ...opts.useCases.filter(uc => uc.scenarios[opts.scenario - 1]).map(uc => uc.name), 'Total'],
  ];

  for (let i = 0; i < 36; i++) {
    const year = Math.floor(i / 12) + 1;
    const row: any[] = [`M${i + 1} (Y${year})`, opts.projections.baselineMonths[i]];
    opts.useCases.filter(uc => uc.scenarios[opts.scenario - 1]).forEach(uc => {
      row.push(uc.monthlyProjection[i] || 0);
    });
    row.push(opts.projections.totalMonths[i]);
    projRows.push(row);
  }

  // Year totals
  projRows.push(['']);
  ['Year 1', 'Year 2', 'Year 3'].forEach((label, yi) => {
    const row: any[] = [label, opts.projections.baseYearTotals[yi]];
    opts.useCases.filter(uc => uc.scenarios[opts.scenario - 1]).forEach(uc => {
      const yTotal = uc.monthlyProjection.slice(yi * 12, (yi + 1) * 12).reduce((s, v) => s + v, 0);
      row.push(yTotal);
    });
    row.push(opts.projections.yearTotals[yi]);
    projRows.push(row);
  });

  const ws5 = XLSX.utils.aoa_to_sheet(projRows);
  ws5['!cols'] = [{ wch: 14 }, { wch: 16 }, ...opts.useCases.map(() => ({ wch: 16 })), { wch: 16 }];
  applyDollarFormat(ws5);
  XLSX.utils.book_append_sheet(wb, ws5, '36-Month Projection');

  // ── Sheet 6: Use Case Details ──
  const ucRows: any[][] = [
    ['Use Case Details'],
    [''],
    ['Name', 'Domain', 'Steady-State $/mo', 'Onboarding Month', 'Live Month', 'Ramp Type', 'S1', 'S2', 'S3', 'Year 1', 'Year 2', 'Year 3', 'Total'],
  ];
  opts.useCases.forEach(uc => {
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

  const ws6 = XLSX.utils.aoa_to_sheet(ucRows);
  ws6['!cols'] = [{ wch: 30 }, { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 14 }, { wch: 5 }, { wch: 5 }, { wch: 5 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
  applyDollarFormat(ws6);
  XLSX.utils.book_append_sheet(wb, ws6, 'Use Case Details');

  // ── Sheet 7: Domain Baseline ──
  const blRows: any[][] = [
    ['Domain Baseline Summary'],
    [''],
    ['Domain', 'T12M $DBU', 'Avg Monthly', '% of Total'],
  ];
  const totalBL = opts.domainBaselines.reduce((s, b) => s + b.t12m, 0);
  opts.domainBaselines.forEach(b => {
    blRows.push([b.domain, b.t12m, b.avgMonthly, totalBL > 0 ? b.t12m / totalBL : 0]);
  });
  blRows.push(['Grand Total', totalBL, totalBL / 12, 1]);

  const ws7 = XLSX.utils.aoa_to_sheet(blRows);
  ws7['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 18 }, { wch: 12 }];
  applyDollarFormat(ws7);
  applyPercentFormat(ws7, 3, 3);
  XLSX.utils.book_append_sheet(wb, ws7, 'Domain Baseline');

  // ── Sheet 8: Use Case SKU Breakdown ──
  const skuBdRows: any[][] = [
    ['Use Case SKU Breakdown'],
    [''],
    ['Use Case Name', 'SKU', 'Cloud', '% Split', 'DBUs/mo', '$/DBU', '$/month', 'Assumptions'],
  ];
  opts.useCases.forEach(uc => {
    if (uc.skuBreakdown && uc.skuBreakdown.length > 0) {
      uc.skuBreakdown.forEach((alloc, idx) => {
        const price = alloc.dbus > 0 ? alloc.dollarDbu / alloc.dbus : 0;
        skuBdRows.push([
          idx === 0 ? uc.name : '',
          alloc.sku,
          uc.cloud || '',
          alloc.percentage / 100,
          Math.round(alloc.dbus),
          price,
          alloc.dollarDbu,
          idx === 0 ? (uc.assumptions || '') : '',
        ]);
      });
      // Subtotal row per use case
      const totalDbus = uc.skuBreakdown.reduce((s, a) => s + a.dbus, 0);
      const totalDollar = uc.skuBreakdown.reduce((s, a) => s + a.dollarDbu, 0);
      const totalPct = uc.skuBreakdown.reduce((s, a) => s + a.percentage, 0);
      const avgPrice = totalDbus > 0 ? totalDollar / totalDbus : 0;
      skuBdRows.push([
        '', 'SUBTOTAL', '', totalPct / 100, Math.round(totalDbus), avgPrice, totalDollar, '',
      ]);
    }
  });

  const ws8 = XLSX.utils.aoa_to_sheet(skuBdRows);
  ws8['!cols'] = [{ wch: 30 }, { wch: 25 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 50 }];
  applyDollarFormat(ws8);
  // Apply % format to column D (index 3) from row 3 onward
  applyPercentFormat(ws8, 3, 3);
  XLSX.utils.book_append_sheet(wb, ws8, 'Use Case SKU Breakdown');

  // Generate and save
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const filename = `Demand_Plan_${opts.account}_Scenario${opts.scenario}_${new Date().toISOString().split('T')[0]}.xlsx`;
  saveAs(blob, filename);

  return filename;
}

export async function exportToGoogleSheet(opts: ExportOptions): Promise<string> {
  // Call backend to create Google Sheet
  const resp = await fetch('/api/export-gsheet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!resp.ok) throw new Error('Export failed');
  const data = await resp.json();
  return data.url;
}
