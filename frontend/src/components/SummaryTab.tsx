import React, { useEffect, useState, useCallback, useRef } from 'react';
import { fetchSummaryAll, fetchConsumption, formatCurrency } from '../api';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import type { AccountConfig } from '../App';

const COLORS = [
  '#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899',
  '#06B6D4', '#84CC16', '#F97316', '#6366F1', '#14B8A6', '#E11D48',
  '#0EA5E9', '#A855F7', '#22C55E', '#D946EF', '#64748B', '#FB923C',
  '#2DD4BF', '#818CF8', '#F472B6', '#34D399', '#FACC15', '#C084FC',
  '#38BDF8', '#4ADE80', '#FB7185',
];

// Distinct account colors — bold, easy to distinguish
const ACCOUNT_COLORS = [
  '#3B82F6', // blue
  '#F97316', // orange
  '#10B981', // emerald
  '#A855F7', // purple
  '#EF4444', // red
  '#14B8A6', // teal
  '#F59E0B', // amber
  '#EC4899', // pink
  '#6366F1', // indigo
  '#84CC16', // lime
];

const SCENARIO_COLORS = ['#3B82F6', '#8B5CF6', '#10B981'];

interface Props {
  accounts: AccountConfig[];
  setAccounts: (accounts: AccountConfig[]) => void;
}

interface AccountSummaryData {
  accountName: string;
  data: any;
  error?: string;
}

interface LoadingStep {
  step: string;
  done: boolean;
  error?: string;
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function getYearLabel(contractStartDate: string, yearIdx: number): string {
  if (!contractStartDate) return `Year ${yearIdx + 1}`;
  const [y, m] = contractStartDate.split('-').map(Number);
  const startY = y + yearIdx;
  const startM = m - 1; // 0-indexed
  const endM = (startM + 11) % 12;
  const endY = startY + (startM + 11 >= 12 ? 1 : 0);
  return `Y${yearIdx + 1} (${MONTH_NAMES[startM]}'${String(startY).slice(2)}–${MONTH_NAMES[endM]}'${String(endY).slice(2)})`;
}

export default function SummaryTab({ accounts, setAccounts }: Props) {
  const [accountDataMap, setAccountDataMap] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadingSteps, setLoadingSteps] = useState<Record<string, LoadingStep>>({});
  const [mappingLoadedFor, setMappingLoadedFor] = useState<Set<string>>(new Set());
  const loadedAccountsRef = useRef<Set<string>>(new Set());

  // Discount state: current + per-scenario
  const [currentDiscount, setCurrentDiscount] = useState(0);
  const [s1Discount, setS1Discount] = useState(0);
  const [s2Discount, setS2Discount] = useState(0);
  const [s3Discount, setS3Discount] = useState(0);
  const scenarioDiscounts = [s1Discount, s2Discount, s3Discount];

  const updateStep = (key: string, update: Partial<LoadingStep>) => {
    setLoadingSteps(prev => ({
      ...prev,
      [key]: { ...prev[key], ...update },
    }));
  };

  const loadData = useCallback(async (forceRefreshAccount?: string) => {
    const accountsToFetch = forceRefreshAccount
      ? accounts.filter(a => a.name === forceRefreshAccount)
      : accounts.filter(a => a.name.trim() && !loadedAccountsRef.current.has(a.name));

    if (accountsToFetch.length === 0 && !forceRefreshAccount) return;

    setLoading(true);
    setError('');

    // Initialize loading steps for accounts being fetched
    const initialSteps: Record<string, LoadingStep> = {};
    accountsToFetch.forEach(a => {
      initialSteps[`${a.name}-consumption`] = { step: `${a.name} — fetching consumption from Logfood...`, done: false };
      initialSteps[`${a.name}-summary`] = { step: `${a.name} — building summary...`, done: false };
    });
    setLoadingSteps(prev => {
      // Keep completed steps from previously loaded accounts
      const kept: Record<string, LoadingStep> = {};
      Object.entries(prev).forEach(([k, v]) => {
        if (v.done && !accountsToFetch.some(a => k.startsWith(a.name))) {
          kept[k] = v;
        }
      });
      return { ...kept, ...initialSteps };
    });

    try {
      // Process each account sequentially for clear progress, but could be parallel
      const newDataMap: Record<string, any> = {};
      const errors: string[] = [];

      await Promise.all(accountsToFetch.map(async (a) => {
        // Step 1: Fetch consumption data (for row count display)
        let rowCount = 0;
        try {
          const consumptionRes = await fetchConsumption(a.sfdc_id);
          rowCount = consumptionRes?.data?.length || 0;
          updateStep(`${a.name}-consumption`, { step: `${a.name} — consumption data (${rowCount.toLocaleString()} rows)`, done: true });
        } catch (e: any) {
          updateStep(`${a.name}-consumption`, { step: `${a.name} — consumption fetch failed: ${e.message}`, done: true, error: e.message });
        }

        // Step 3: Fetch summary
        updateStep(`${a.name}-summary`, { step: `${a.name} — building summary...`, done: false });
        try {
          const result = await fetchSummaryAll(a.sfdc_id, a.contractMonths ?? 36, a.contractStartDate ?? '');
          newDataMap[a.name] = result;
          updateStep(`${a.name}-summary`, { step: `${a.name} — summary ready`, done: true });
          loadedAccountsRef.current.add(a.name);
        } catch (e: any) {
          updateStep(`${a.name}-summary`, { step: `${a.name} — summary failed: ${e.message}`, done: true, error: e.message });
          errors.push(`${a.name}: ${e.message}`);
        }
      }));

      // Merge new data into existing map (don't replace existing data for accounts we didn't fetch)
      setAccountDataMap(prev => {
        const merged = { ...prev };
        // If force refreshing, replace that account's data
        if (forceRefreshAccount) {
          if (newDataMap[forceRefreshAccount]) {
            merged[forceRefreshAccount] = newDataMap[forceRefreshAccount];
          }
        } else {
          Object.entries(newDataMap).forEach(([k, v]) => {
            merged[k] = v;
          });
        }
        return merged;
      });

      if (errors.length > 0) setError(errors.join('; '));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [accounts, mappingLoadedFor]);

  // Track previous account names to detect additions/removals
  const prevAccountNamesRef = useRef<string>(accounts.map(a => a.name).join(','));

  useEffect(() => {
    const currentNames = accounts.map(a => a.name).join(',');
    const prevNames = prevAccountNamesRef.current;
    prevAccountNamesRef.current = currentNames;

    // On initial load, or when account names change
    if (prevNames !== currentNames) {
      // Clean up removed accounts
      const currentNameSet = new Set(accounts.map(a => a.name));
      setAccountDataMap(prev => {
        const cleaned: Record<string, any> = {};
        Object.entries(prev).forEach(([k, v]) => {
          if (currentNameSet.has(k)) cleaned[k] = v;
        });
        return cleaned;
      });
      // Remove from loadedAccountsRef
      loadedAccountsRef.current.forEach(name => {
        if (!currentNameSet.has(name)) loadedAccountsRef.current.delete(name);
      });
    }

    // Don't auto-fetch on account name change — wait for explicit Load button click
    // Only auto-load on initial mount for accounts that have sfdc_id set
  }, []);

  // Auto-load on mount for pre-configured accounts
  useEffect(() => {
    const preConfigured = accounts.filter(a => a.sfdc_id?.trim());
    if (preConfigured.length > 0) {
      loadData();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Use the first account's data for charts (domain breakdown)
  const firstAccountName = accounts[0]?.name || '';
  const firstData = accountDataMap[firstAccountName];

  // activeAccounts must be defined before chart data that uses it
  const activeAccounts = accounts.filter(a => a.name.trim() && accountDataMap[a.name]);

  // Map each account name to its color index
  const accountColorMap: Record<string, string> = {};
  accounts.forEach((a, i) => {
    accountColorMap[a.name] = ACCOUNT_COLORS[i % ACCOUNT_COLORS.length];
  });

  // Determine max years across active accounts
  const maxYears = Math.max(
    1,
    ...activeAccounts.map(a => Math.max(1, Math.floor((a.contractMonths ?? 36) / 12)))
  );

  // Build comparison bar chart data — per-account bars per year
  const comparisonChartData = (() => {
    const hasAnyData = Object.keys(accountDataMap).length > 0;
    if (!hasAnyData) return [];
    return Array.from({ length: maxYears }, (_, yi) => {
      const yearKey = `year${yi + 1}`;
      const entry: any = { year: `Year ${yi + 1}` };
      activeAccounts.forEach((a) => {
        for (let si = 0; si < 3; si++) {
          const scenarioData = (accountDataMap[a.name] as any)?.scenarios?.[si];
          const grandTotal = scenarioData?.summary_rows?.find((r: any) => r.use_case_area === 'Grand Total');
          entry[`${a.name}_s${si + 1}`] = grandTotal ? grandTotal[yearKey] : 0;
        }
      });
      return entry;
    });
  })();

  const domainBreakdown = firstData?.scenarios?.[0]?.domain_breakdown || [];

  // Helper to get grand total for an account + scenario
  const getAccountGrandTotal = (accountName: string, scenarioIdx: number) => {
    const ad = accountDataMap[accountName];
    return ad?.scenarios?.[scenarioIdx]?.summary_rows?.find((r: any) => r.use_case_area === 'Grand Total');
  };

  // Helper to get scenario detail rows for an account
  const getAccountDetailRows = (accountName: string, scenarioIdx: number) => {
    const ad = accountDataMap[accountName];
    const scenarioData = ad?.scenarios?.[scenarioIdx];
    if (!scenarioData) return { baselineRow: null, useCaseRows: [] };
    const baselineRow = scenarioData.summary_rows.find(
      (r: any) => !r.is_use_case && r.use_case_area !== 'Grand Total' && r.use_case_area !== 'New Use Cases'
    );
    const useCaseRows = scenarioData.summary_rows.filter((r: any) => r.is_use_case);
    return { baselineRow, useCaseRows };
  };

  return (
    <div className="space-y-6">
      {/* Config Bar */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-gray-700">Account Configuration</label>
          </div>
          {accounts.map((acct, idx) => (
            <div key={idx} className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-4 items-end">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Account Name</label>
                <input
                  type="text"
                  value={acct.name}
                  readOnly
                  className="w-full border border-gray-300 rounded-md px-3 py-2 bg-gray-50 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Contract Start (M1)</label>
                <input
                  type="month"
                  value={acct.contractStartDate || ''}
                  readOnly
                  className="w-full border border-gray-300 rounded-md px-3 py-2 bg-gray-50 text-sm"
                  title="Contract start month — used as M1 of Year 1"
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Loading Progress Steps */}
      {loading && (
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Loading Demand Plan...</h3>
          <div className="space-y-2">
            {Object.entries(loadingSteps).map(([key, step]) => (
              <div key={key} className="flex items-center gap-2 text-sm">
                {step.done ? (
                  step.error ? (
                    <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  )
                ) : (
                  <svg className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                <span className={step.error ? 'text-red-600' : step.done ? 'text-gray-600' : 'text-blue-600'}>
                  {step.step}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">{error}</div>}

      {activeAccounts.length > 0 && (
        <>
          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Domain Breakdown Pie */}
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Domain Breakdown (T12M) — {firstAccountName}</h3>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={domainBreakdown.slice(0, 15)}
                    dataKey="value"
                    nameKey="domain"
                    cx="50%"
                    cy="50%"
                    outerRadius={100}
                    label={({ domain, percent }: any) =>
                      percent > 0.03 ? `${domain} (${(percent * 100).toFixed(0)}%)` : ''
                    }
                    labelLine={false}
                  >
                    {domainBreakdown.slice(0, 15).map((_: any, idx: number) => (
                      <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => formatCurrency(v)} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Yearly Trend - Per-account bars, grouped by scenario */}
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Yearly $DBU — By Account &amp; Scenario</h3>
              {/* Account color legend */}
              <div className="flex flex-wrap gap-3 mb-3">
                {activeAccounts.map((a) => (
                  <div key={a.name} className="flex items-center gap-1.5 text-xs font-medium">
                    <span className="w-3 h-3 rounded-sm inline-block" style={{ backgroundColor: accountColorMap[a.name] }} />
                    {a.name}
                  </div>
                ))}
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={comparisonChartData} barCategoryGap="20%" barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="year" />
                  <YAxis tickFormatter={(v: number) => formatCurrency(v)} />
                  <Tooltip
                    formatter={(v: number, name: string) => {
                      const parts = name.split('_s');
                      const acct = parts[0];
                      const s = parts[1];
                      return [formatCurrency(v), `${acct} – Scenario ${s}`];
                    }}
                  />
                  <Legend
                    formatter={(value: string) => {
                      const parts = value.split('_s');
                      return `${parts[0]} S${parts[1]}`;
                    }}
                  />
                  {activeAccounts.flatMap((a) =>
                    [1, 2, 3].map((s) => {
                      const baseColor = accountColorMap[a.name];
                      // Lighten for S2, lighten more for S3 using opacity
                      const opacity = s === 1 ? 1 : s === 2 ? 0.7 : 0.45;
                      return (
                        <Bar
                          key={`${a.name}_s${s}`}
                          dataKey={`${a.name}_s${s}`}
                          name={`${a.name}_s${s}`}
                          fill={baseColor}
                          fillOpacity={opacity}
                        />
                      );
                    })
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Header + Discount Panel */}
          <div className="bg-white rounded-lg shadow p-4 space-y-4">
            <div>
              <h2 className="text-lg font-bold text-gray-900">Databricks Pricing:</h2>
              <p className="text-sm text-gray-500">Note: All Prices are Databricks List Price.</p>
            </div>

            {/* Discount inputs */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Discount Configuration</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {([
                  { label: 'Current Discount', value: currentDiscount, set: setCurrentDiscount, color: '#64748B' },
                  { label: 'Scenario 1 Discount', value: s1Discount, set: setS1Discount, color: SCENARIO_COLORS[0] },
                  { label: 'Scenario 2 Discount', value: s2Discount, set: setS2Discount, color: SCENARIO_COLORS[1] },
                  { label: 'Scenario 3 Discount', value: s3Discount, set: setS3Discount, color: SCENARIO_COLORS[2] },
                ] as { label: string; value: number; set: (v: number) => void; color: string }[]).map(({ label, value, set, color }) => (
                  <div key={label} className="space-y-1">
                    <label className="block text-xs font-medium" style={{ color }}>{label}</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0} max={100} step={0.5}
                        value={value}
                        onChange={e => set(parseFloat(e.target.value))}
                        className="flex-1 h-1.5 rounded-full accent-blue-600"
                        style={{ accentColor: color }}
                      />
                      <div className="flex items-center border border-gray-300 rounded-md overflow-hidden w-16">
                        <input
                          type="number"
                          min={0} max={100} step={0.5}
                          value={value}
                          onChange={e => set(Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)))}
                          className="w-full px-1.5 py-1 text-xs text-right focus:outline-none"
                        />
                        <span className="text-xs text-gray-400 pr-1.5">%</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Summary chips */}
              {(currentDiscount > 0 || s1Discount > 0 || s2Discount > 0 || s3Discount > 0) && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {currentDiscount > 0 && (
                    <span className="text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded-full font-medium">
                      Current: {currentDiscount}% off list
                    </span>
                  )}
                  {[s1Discount, s2Discount, s3Discount].map((d, i) => d > 0 && (
                    <span key={i} className="text-xs px-2 py-1 rounded-full font-medium" style={{ backgroundColor: `${SCENARIO_COLORS[i]}18`, color: SCENARIO_COLORS[i] }}>
                      S{i + 1}: {d}% off list
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* All 3 Scenarios stacked */}
          {[0, 1, 2].map((idx) => {
            const scenarioNum = idx + 1;
            const firstScenarioData = accountDataMap[activeAccounts[0]?.name]?.scenarios?.[idx];
            const description = firstScenarioData?.description || `Scenario ${scenarioNum}`;

            return (
              <div key={scenarioNum} className="bg-white rounded-lg shadow overflow-hidden">
                {/* Scenario header */}
                <div
                  className="px-4 py-3 border-b-2"
                  style={{ borderColor: SCENARIO_COLORS[idx], backgroundColor: `${SCENARIO_COLORS[idx]}10` }}
                >
                  <h2 className="text-lg font-bold" style={{ color: SCENARIO_COLORS[idx] }}>
                    Scenario {scenarioNum} ({description})
                  </h2>
                </div>

                {/* SUMMARY box — multi-account rows */}
                <div className="px-4 pt-4 pb-2">
                  <h3 className="text-sm font-bold text-gray-800 mb-2 uppercase tracking-wide">Summary</h3>
                  <table className="w-full mb-4">
                    <thead>
                      <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        <td className="py-2 pr-4" style={{ width: '35%' }}>Total $DBUs (DBCU at List)</td>
                        {Array.from({ length: maxYears }, (_, yi) => {
                          const csd = accounts.find(a => a.name === activeAccounts[0]?.name)?.contractStartDate || '';
                          return <td key={yi} className="py-2 text-right text-xs">{getYearLabel(csd, yi)}</td>;
                        })}
                        <td className="py-2 text-right">Grand Total</td>
                      </tr>
                    </thead>
                    <tbody>
                      {activeAccounts.map((a) => {
                        const gt = getAccountGrandTotal(a.name, idx);
                        const numYears = Math.max(1, Math.floor((a.contractMonths ?? 36) / 12));
                        return (
                          <tr key={a.name} className="border-t">
                            <td className="py-2 pr-4 text-sm font-medium text-gray-900">
                              <div className="flex items-center gap-2">
                                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: accountColorMap[a.name] }} />
                                {a.name}
                              </div>
                            </td>
                            {Array.from({ length: maxYears }, (_, yi) => {
                              const val = yi < numYears ? (gt?.[`year${yi + 1}`] || 0) : null;
                              return <td key={yi} className="py-2 text-sm text-right">{val !== null ? formatCurrency(val) : '—'}</td>;
                            })}
                            <td className="py-2 text-sm text-right font-semibold">{formatCurrency(gt?.total || 0)}</td>
                          </tr>
                        );
                      })}
                      <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                        <td className="py-2 pr-4 text-sm">Grand Total (List)</td>
                        {Array.from({ length: maxYears }, (_, yi) => {
                          const colTotal = activeAccounts.reduce((s, a) => {
                            const numYears = Math.max(1, Math.floor((a.contractMonths ?? 36) / 12));
                            if (yi >= numYears) return s;
                            const gt = getAccountGrandTotal(a.name, idx);
                            return s + (gt?.[`year${yi + 1}`] || 0);
                          }, 0);
                          return <td key={yi} className="py-2 text-sm text-right">{formatCurrency(colTotal)}</td>;
                        })}
                        <td className="py-2 text-sm text-right">{formatCurrency(
                          activeAccounts.reduce((s, a) => s + (getAccountGrandTotal(a.name, idx)?.total || 0), 0)
                        )}</td>
                      </tr>
                      {scenarioDiscounts[idx] > 0 && (
                        <tr className="border-t font-bold" style={{ backgroundColor: `${SCENARIO_COLORS[idx]}12` }}>
                          <td className="py-2 pr-4 text-sm" style={{ color: SCENARIO_COLORS[idx] }}>
                            Discounted Total ({scenarioDiscounts[idx]}% off)
                          </td>
                          {Array.from({ length: maxYears }, (_, yi) => {
                            const colTotal = activeAccounts.reduce((s, a) => {
                              const numYears = Math.max(1, Math.floor((a.contractMonths ?? 36) / 12));
                              if (yi >= numYears) return s;
                              const gt = getAccountGrandTotal(a.name, idx);
                              return s + (gt?.[`year${yi + 1}`] || 0);
                            }, 0);
                            return <td key={yi} className="py-2 text-sm text-right" style={{ color: SCENARIO_COLORS[idx] }}>{formatCurrency(colTotal * (1 - scenarioDiscounts[idx] / 100))}</td>;
                          })}
                          <td className="py-2 text-sm text-right" style={{ color: SCENARIO_COLORS[idx] }}>{formatCurrency(
                            activeAccounts.reduce((s, a) => s + (getAccountGrandTotal(a.name, idx)?.total || 0), 0) * (1 - scenarioDiscounts[idx] / 100)
                          )}</td>
                        </tr>
                      )}
                      {currentDiscount > 0 && (
                        <tr className="border-t" style={{ backgroundColor: '#64748B0D' }}>
                          <td className="py-2 pr-4 text-sm font-medium text-slate-600">
                            Current Discount ({currentDiscount}% off)
                          </td>
                          {Array.from({ length: maxYears }, (_, yi) => {
                            const colTotal = activeAccounts.reduce((s, a) => {
                              const numYears = Math.max(1, Math.floor((a.contractMonths ?? 36) / 12));
                              if (yi >= numYears) return s;
                              const gt = getAccountGrandTotal(a.name, idx);
                              return s + (gt?.[`year${yi + 1}`] || 0);
                            }, 0);
                            return <td key={yi} className="py-2 text-sm text-right text-slate-600">{formatCurrency(colTotal * (1 - currentDiscount / 100))}</td>;
                          })}
                          <td className="py-2 text-sm text-right text-slate-600 font-semibold">{formatCurrency(
                            activeAccounts.reduce((s, a) => s + (getAccountGrandTotal(a.name, idx)?.total || 0), 0) * (1 - currentDiscount / 100)
                          )}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Detail tables: Side by side if 2+ accounts, single if 1 */}
                <div className="px-4 pb-4">
                  {activeAccounts.length === 1 ? (
                    (() => {
                      const acct = activeAccounts[0];
                      const { baselineRow, useCaseRows } = getAccountDetailRows(acct.name, idx);
                      const gt = getAccountGrandTotal(acct.name, idx);
                      const numYears = Math.max(1, Math.floor((acct.contractMonths ?? 36) / 12));
                      const csd = acct.contractStartDate || '';
                      return (
                        <table className="w-full">
                          <thead>
                            <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                              <td className="py-2 pr-2" style={{ width: '110px' }}>Type</td>
                              <td className="py-2 pr-4">$DBUs List</td>
                              {Array.from({ length: numYears }, (_, yi) => (
                                <td key={yi} className="py-2 text-right text-xs">{getYearLabel(csd, yi)}</td>
                              ))}
                              <td className="py-2 text-right">Total</td>
                            </tr>
                          </thead>
                          <tbody>
                            <tr className="border-t bg-gray-50">
                              <td colSpan={numYears + 3} className="py-2 text-sm font-semibold text-gray-700">
                                Use Case Areas ({acct.name.toUpperCase()})
                              </td>
                            </tr>
                            {baselineRow && (
                              <tr className="border-t hover:bg-gray-50">
                                <td colSpan={2} className="py-2 pr-4 text-sm font-medium text-gray-800">Existing — Live Use Cases</td>
                                {Array.from({ length: numYears }, (_, yi) => (
                                  <td key={yi} className="py-2 text-sm text-right">{formatCurrency(baselineRow[`year${yi + 1}`] || 0)}</td>
                                ))}
                                <td className="py-2 text-sm text-right font-semibold">{formatCurrency(baselineRow.total)}</td>
                              </tr>
                            )}
                            {useCaseRows.map((row: any, ri: number) => (
                              <tr key={ri} className="border-t hover:bg-gray-50">
                                <td className="py-2 pr-2">
                                  <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-700 whitespace-nowrap">New Use Case</span>
                                </td>
                                <td className="py-2 pr-4 text-sm text-gray-700">
                                  {row.use_case_area.replace(/^\s*↳\s*/, '')}
                                </td>
                                {Array.from({ length: numYears }, (_, yi) => (
                                  <td key={yi} className="py-2 text-sm text-right">{formatCurrency(row[`year${yi + 1}`] || 0)}</td>
                                ))}
                                <td className="py-2 text-sm text-right font-semibold">{formatCurrency(row.total)}</td>
                              </tr>
                            ))}
                            <tr className="border-t-2 border-gray-300 bg-blue-50 font-bold">
                              <td colSpan={2} className="py-2 pr-4 text-sm">Total $DBUs (DBCU at List)</td>
                              {Array.from({ length: numYears }, (_, yi) => (
                                <td key={yi} className="py-2 text-sm text-right">{formatCurrency(gt?.[`year${yi + 1}`] || 0)}</td>
                              ))}
                              <td className="py-2 text-sm text-right">{formatCurrency(gt?.total || 0)}</td>
                            </tr>
                            {scenarioDiscounts[idx] > 0 && (
                              <tr className="border-t font-bold" style={{ backgroundColor: `${SCENARIO_COLORS[idx]}12` }}>
                                <td colSpan={2} className="py-2 pr-4 text-sm" style={{ color: SCENARIO_COLORS[idx] }}>
                                  Discounted Total ({scenarioDiscounts[idx]}% off list)
                                </td>
                                {Array.from({ length: numYears }, (_, yi) => (
                                  <td key={yi} className="py-2 text-sm text-right" style={{ color: SCENARIO_COLORS[idx] }}>
                                    {formatCurrency((gt?.[`year${yi + 1}`] || 0) * (1 - scenarioDiscounts[idx] / 100))}
                                  </td>
                                ))}
                                <td className="py-2 text-sm text-right" style={{ color: SCENARIO_COLORS[idx] }}>
                                  {formatCurrency((gt?.total || 0) * (1 - scenarioDiscounts[idx] / 100))}
                                </td>
                              </tr>
                            )}
                            {currentDiscount > 0 && (
                              <tr className="border-t" style={{ backgroundColor: '#64748B0D' }}>
                                <td colSpan={2} className="py-2 pr-4 text-sm font-medium text-slate-600">
                                  Current Discount ({currentDiscount}% off)
                                </td>
                                {Array.from({ length: numYears }, (_, yi) => (
                                  <td key={yi} className="py-2 text-sm text-right text-slate-600">
                                    {formatCurrency((gt?.[`year${yi + 1}`] || 0) * (1 - currentDiscount / 100))}
                                  </td>
                                ))}
                                <td className="py-2 text-sm text-right text-slate-600 font-semibold">
                                  {formatCurrency((gt?.total || 0) * (1 - currentDiscount / 100))}
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      );
                    })()
                  ) : (
                    <div className="flex gap-4 overflow-x-auto">
                      {activeAccounts.map((acct) => {
                        const { baselineRow, useCaseRows } = getAccountDetailRows(acct.name, idx);
                        const gt = getAccountGrandTotal(acct.name, idx);
                        const acctColor = accountColorMap[acct.name];
                        const numYears = Math.max(1, Math.floor((acct.contractMonths ?? 36) / 12));
                        const csd = acct.contractStartDate || '';
                        return (
                          <div
                            key={acct.name}
                            className="flex-1 min-w-[400px] rounded-lg overflow-hidden border"
                            style={{ borderColor: acctColor }}
                          >
                            <div
                              className="px-3 py-2 flex items-center gap-2"
                              style={{ backgroundColor: `${acctColor}18`, borderBottom: `2px solid ${acctColor}` }}
                            >
                              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: acctColor }} />
                              <span className="text-sm font-bold" style={{ color: acctColor }}>{acct.name}</span>
                              <span className="text-xs text-gray-400 ml-1">{numYears}Y contract</span>
                            </div>
                            <table className="w-full">
                              <thead>
                                <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                                  <td className="py-2 px-3" style={{ width: '90px' }}>Type</td>
                                  <td className="py-2 px-3">$DBUs List</td>
                                  {Array.from({ length: numYears }, (_, yi) => (
                                    <td key={yi} className="py-2 text-right text-xs">{getYearLabel(csd, yi)}</td>
                                  ))}
                                  <td className="py-2 pr-3 text-right">Total</td>
                                </tr>
                              </thead>
                              <tbody>
                                {baselineRow && (
                                  <tr className="border-t hover:bg-gray-50">
                                    <td colSpan={2} className="py-2 px-3 text-sm font-medium text-gray-800">Existing — Live Use Cases</td>
                                    {Array.from({ length: numYears }, (_, yi) => (
                                      <td key={yi} className="py-2 text-sm text-right">{formatCurrency(baselineRow[`year${yi + 1}`] || 0)}</td>
                                    ))}
                                    <td className="py-2 pr-3 text-sm text-right font-semibold">{formatCurrency(baselineRow.total)}</td>
                                  </tr>
                                )}
                                {useCaseRows.map((row: any, ri: number) => (
                                  <tr key={ri} className="border-t hover:bg-gray-50">
                                    <td className="py-2 px-3">
                                      <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-700 whitespace-nowrap">New Use Case</span>
                                    </td>
                                    <td className="py-2 px-3 text-sm text-gray-700">
                                      {row.use_case_area.replace(/^\s*↳\s*/, '')}
                                    </td>
                                    {Array.from({ length: numYears }, (_, yi) => (
                                      <td key={yi} className="py-2 text-sm text-right">{formatCurrency(row[`year${yi + 1}`] || 0)}</td>
                                    ))}
                                    <td className="py-2 pr-3 text-sm text-right font-semibold">{formatCurrency(row.total)}</td>
                                  </tr>
                                ))}
                                <tr className="border-t-2 font-bold" style={{ backgroundColor: `${acctColor}12` }}>
                                  <td colSpan={2} className="py-2 px-3 text-sm" style={{ color: acctColor }}>Total (List)</td>
                                  {Array.from({ length: numYears }, (_, yi) => (
                                    <td key={yi} className="py-2 text-sm text-right">{formatCurrency(gt?.[`year${yi + 1}`] || 0)}</td>
                                  ))}
                                  <td className="py-2 pr-3 text-sm text-right">{formatCurrency(gt?.total || 0)}</td>
                                </tr>
                                {scenarioDiscounts[idx] > 0 && (
                                  <tr className="border-t font-bold" style={{ backgroundColor: `${SCENARIO_COLORS[idx]}12` }}>
                                    <td colSpan={2} className="py-2 px-3 text-sm" style={{ color: SCENARIO_COLORS[idx] }}>
                                      Discounted ({scenarioDiscounts[idx]}% off)
                                    </td>
                                    {Array.from({ length: numYears }, (_, yi) => (
                                      <td key={yi} className="py-2 text-sm text-right" style={{ color: SCENARIO_COLORS[idx] }}>
                                        {formatCurrency((gt?.[`year${yi + 1}`] || 0) * (1 - scenarioDiscounts[idx] / 100))}
                                      </td>
                                    ))}
                                    <td className="py-2 pr-3 text-sm text-right" style={{ color: SCENARIO_COLORS[idx] }}>
                                      {formatCurrency((gt?.total || 0) * (1 - scenarioDiscounts[idx] / 100))}
                                    </td>
                                  </tr>
                                )}
                                {currentDiscount > 0 && (
                                  <tr className="border-t" style={{ backgroundColor: '#64748B0D' }}>
                                    <td colSpan={2} className="py-2 px-3 text-sm font-medium text-slate-600">
                                      Current Discount ({currentDiscount}% off)
                                    </td>
                                    {Array.from({ length: numYears }, (_, yi) => (
                                      <td key={yi} className="py-2 text-sm text-right text-slate-600">
                                        {formatCurrency((gt?.[`year${yi + 1}`] || 0) * (1 - currentDiscount / 100))}
                                      </td>
                                    ))}
                                    <td className="py-2 pr-3 text-sm text-right text-slate-600 font-semibold">
                                      {formatCurrency((gt?.total || 0) * (1 - currentDiscount / 100))}
                                    </td>
                                  </tr>
                                )}
                              </tbody>
                            </table>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
