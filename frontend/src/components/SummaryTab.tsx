import React, { useEffect, useState, useCallback, useRef } from 'react';
import { fetchSummaryAll, fetchDomainMapping, fetchConsumption, formatCurrency } from '../api';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import type { AccountConfig } from '../App';

const COLORS = [
  '#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899',
  '#06B6D4', '#84CC16', '#F97316', '#6366F1', '#14B8A6', '#E11D48',
  '#0EA5E9', '#A855F7', '#22C55E', '#D946EF', '#64748B', '#FB923C',
  '#2DD4BF', '#818CF8', '#F472B6', '#34D399', '#FACC15', '#C084FC',
  '#38BDF8', '#4ADE80', '#FB7185',
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

export default function SummaryTab({ accounts, setAccounts }: Props) {
  const [accountDataMap, setAccountDataMap] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadingSteps, setLoadingSteps] = useState<Record<string, LoadingStep>>({});
  const [mappingLoadedFor, setMappingLoadedFor] = useState<Set<string>>(new Set());
  const loadedAccountsRef = useRef<Set<string>>(new Set());

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
      if (a.sheetUrl && !mappingLoadedFor.has(a.name)) {
        initialSteps[`${a.name}-mapping`] = { step: `${a.name} — loading domain mapping...`, done: false };
      }
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
        // Step 1: Load domain mapping if needed
        if (a.sheetUrl && !mappingLoadedFor.has(a.name)) {
          try {
            await fetchDomainMapping(a.sheetUrl);
            updateStep(`${a.name}-mapping`, { step: `${a.name} — domain mapping loaded`, done: true });
            setMappingLoadedFor(prev => {
              const next = new Set(prev);
              next.add(a.name);
              return next;
            });
          } catch (e: any) {
            updateStep(`${a.name}-mapping`, { step: `${a.name} — domain mapping failed: ${e.message}`, done: true, error: e.message });
            console.warn(`Domain mapping load warning for ${a.name}:`, e.message);
          }
        }

        // Step 2: Fetch consumption data (for row count display)
        let rowCount = 0;
        try {
          const consumptionRes = await fetchConsumption(a.sfdc_id || a.name);
          rowCount = consumptionRes?.data?.length || 0;
          updateStep(`${a.name}-consumption`, { step: `${a.name} — consumption data (${rowCount.toLocaleString()} rows)`, done: true });
        } catch (e: any) {
          updateStep(`${a.name}-consumption`, { step: `${a.name} — consumption fetch failed: ${e.message}`, done: true, error: e.message });
        }

        // Step 3: Fetch summary
        updateStep(`${a.name}-summary`, { step: `${a.name} — building summary...`, done: false });
        try {
          const result = await fetchSummaryAll(a.sfdc_id || a.name);
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

  // Build comparison bar chart data from all 3 scenarios (aggregated across all accounts)
  const comparisonChartData = (() => {
    const hasAnyData = Object.keys(accountDataMap).length > 0;
    if (!hasAnyData) return [];
    return ['Year 1', 'Year 2', 'Year 3'].map((label, yi) => {
      const entry: any = { year: label };
      for (let si = 0; si < 3; si++) {
        let total = 0;
        Object.values(accountDataMap).forEach((ad: any) => {
          const scenarioData = ad?.scenarios?.[si];
          const grandTotal = scenarioData?.summary_rows?.find((r: any) => r.use_case_area === 'Grand Total');
          const yearKey = ['year1', 'year2', 'year3'][yi];
          total += grandTotal ? grandTotal[yearKey] : 0;
        });
        entry[`scenario${si + 1}`] = total;
      }
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

  const activeAccounts = accounts.filter(a => a.name.trim() && accountDataMap[a.name]);

  return (
    <div className="space-y-6">
      {/* Config Bar */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-gray-700">Account Configuration</label>
            <button
              onClick={() => {
                // Force refresh all loaded accounts
                loadedAccountsRef.current.clear();
                loadData();
              }}
              className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700"
            >
              Refresh All
            </button>
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
                <label className="block text-xs font-medium text-gray-500 mb-1">Domain Mapping Sheet URL — {acct.name}</label>
                <input
                  type="text"
                  value={acct.sheetUrl}
                  onChange={(e) => {
                    const updated = [...accounts];
                    updated[idx] = { ...updated[idx], sheetUrl: e.target.value };
                    setAccounts(updated);
                  }}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  placeholder="Google Sheets URL"
                />
              </div>
              <div className="flex items-end gap-1">
                {loadedAccountsRef.current.has(acct.name) ? (
                  <button
                    onClick={() => loadData(acct.name)}
                    disabled={loading}
                    className="px-3 py-2 bg-blue-100 text-blue-700 rounded-md text-sm font-medium hover:bg-blue-200 disabled:opacity-50"
                    title={`Refresh ${acct.name}`}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                ) : (
                  <button
                    onClick={() => loadData(acct.name)}
                    disabled={loading || !acct.sfdc_id?.trim()}
                    className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
                    title={`Load data for ${acct.name}`}
                  >
                    Load
                  </button>
                )}
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

            {/* Yearly Trend - All 3 scenarios side by side */}
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Yearly $DBU Comparison — All Scenarios (All Accounts)</h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={comparisonChartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="year" />
                  <YAxis tickFormatter={(v: number) => formatCurrency(v)} />
                  <Tooltip formatter={(v: number) => formatCurrency(v)} />
                  <Legend />
                  <Bar dataKey="scenario1" name="Scenario 1" fill={SCENARIO_COLORS[0]} />
                  <Bar dataKey="scenario2" name="Scenario 2" fill={SCENARIO_COLORS[1]} />
                  <Bar dataKey="scenario3" name="Scenario 3" fill={SCENARIO_COLORS[2]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Header */}
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-lg font-bold text-gray-900">Databricks Pricing:</h2>
            <p className="text-sm text-gray-500">Note: All Prices are Databricks List Price.</p>
          </div>

          {/* All 3 Scenarios stacked */}
          {[0, 1, 2].map((idx) => {
            const scenarioNum = idx + 1;
            // Get description from first account's scenario
            const firstScenarioData = accountDataMap[activeAccounts[0]?.name]?.scenarios?.[idx];
            const description = firstScenarioData?.description || `Scenario ${scenarioNum}`;

            // Compute per-account grand totals and cross-account grand total
            const accountTotals = activeAccounts.map(a => {
              const gt = getAccountGrandTotal(a.name, idx);
              return {
                name: a.name,
                year1: gt?.year1 || 0,
                year2: gt?.year2 || 0,
                year3: gt?.year3 || 0,
                total: gt?.total || 0,
              };
            });

            const crossTotal = {
              year1: accountTotals.reduce((s, a) => s + a.year1, 0),
              year2: accountTotals.reduce((s, a) => s + a.year2, 0),
              year3: accountTotals.reduce((s, a) => s + a.year3, 0),
              total: accountTotals.reduce((s, a) => s + a.total, 0),
            };

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
                        <td className="py-2 pr-4" style={{ width: '40%' }}>Total $DBUs (DBCU at List)</td>
                        <td className="py-2 text-right" style={{ width: '15%' }}>Year 1</td>
                        <td className="py-2 text-right" style={{ width: '15%' }}>Year 2</td>
                        <td className="py-2 text-right" style={{ width: '15%' }}>Year 3</td>
                        <td className="py-2 text-right" style={{ width: '15%' }}>Grand Total</td>
                      </tr>
                    </thead>
                    <tbody>
                      {accountTotals.map((at) => (
                        <tr key={at.name} className="border-t">
                          <td className="py-2 pr-4 text-sm font-medium text-gray-900">{at.name}</td>
                          <td className="py-2 text-sm text-right">{formatCurrency(at.year1)}</td>
                          <td className="py-2 text-sm text-right">{formatCurrency(at.year2)}</td>
                          <td className="py-2 text-sm text-right">{formatCurrency(at.year3)}</td>
                          <td className="py-2 text-sm text-right font-semibold">{formatCurrency(at.total)}</td>
                        </tr>
                      ))}
                      <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                        <td className="py-2 pr-4 text-sm">Grand Total</td>
                        <td className="py-2 text-sm text-right">{formatCurrency(crossTotal.year1)}</td>
                        <td className="py-2 text-sm text-right">{formatCurrency(crossTotal.year2)}</td>
                        <td className="py-2 text-sm text-right">{formatCurrency(crossTotal.year3)}</td>
                        <td className="py-2 text-sm text-right">{formatCurrency(crossTotal.total)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Detail tables: Side by side if 2+ accounts, single if 1 */}
                <div className="px-4 pb-4">
                  {activeAccounts.length === 1 ? (
                    // Single account detail table
                    (() => {
                      const acctName = activeAccounts[0].name;
                      const { baselineRow, useCaseRows } = getAccountDetailRows(acctName, idx);
                      const gt = getAccountGrandTotal(acctName, idx);
                      return (
                        <table className="w-full">
                          <thead>
                            <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                              <td className="py-2 pr-4" style={{ width: '40%' }}>$DBUs List</td>
                              <td className="py-2 text-right" style={{ width: '15%' }}>Year 1</td>
                              <td className="py-2 text-right" style={{ width: '15%' }}>Year 2</td>
                              <td className="py-2 text-right" style={{ width: '15%' }}>Year 3</td>
                              <td className="py-2 text-right" style={{ width: '15%' }}>Total</td>
                            </tr>
                          </thead>
                          <tbody>
                            <tr className="border-t bg-gray-50">
                              <td colSpan={5} className="py-2 text-sm font-semibold text-gray-700">
                                Use Case Areas ({acctName.toUpperCase()})
                              </td>
                            </tr>
                            {baselineRow && (
                              <tr className="border-t hover:bg-gray-50">
                                <td className="py-2 pr-4 text-sm text-gray-800">Existing - Live Use Cases</td>
                                <td className="py-2 text-sm text-right">{formatCurrency(baselineRow.year1)}</td>
                                <td className="py-2 text-sm text-right">{formatCurrency(baselineRow.year2)}</td>
                                <td className="py-2 text-sm text-right">{formatCurrency(baselineRow.year3)}</td>
                                <td className="py-2 text-sm text-right font-semibold">{formatCurrency(baselineRow.total)}</td>
                              </tr>
                            )}
                            {useCaseRows.map((row: any, ri: number) => (
                              <tr key={ri} className="border-t hover:bg-gray-50">
                                <td className="py-2 pr-4 text-sm text-gray-600 pl-2">
                                  {row.use_case_area.replace(/^\s*↳\s*/, '')}
                                </td>
                                <td className="py-2 text-sm text-right">{formatCurrency(row.year1)}</td>
                                <td className="py-2 text-sm text-right">{formatCurrency(row.year2)}</td>
                                <td className="py-2 text-sm text-right">{formatCurrency(row.year3)}</td>
                                <td className="py-2 text-sm text-right font-semibold">{formatCurrency(row.total)}</td>
                              </tr>
                            ))}
                            <tr className="border-t-2 border-gray-300 bg-blue-50 font-bold">
                              <td className="py-2 pr-4 text-sm">Total $DBUs (DBCU at List)</td>
                              <td className="py-2 text-sm text-right">{gt ? formatCurrency(gt.year1) : '$0'}</td>
                              <td className="py-2 text-sm text-right">{gt ? formatCurrency(gt.year2) : '$0'}</td>
                              <td className="py-2 text-sm text-right">{gt ? formatCurrency(gt.year3) : '$0'}</td>
                              <td className="py-2 text-sm text-right">{gt ? formatCurrency(gt.total) : '$0'}</td>
                            </tr>
                          </tbody>
                        </table>
                      );
                    })()
                  ) : (
                    // Side-by-side detail tables for multiple accounts
                    <div className="flex gap-4 overflow-x-auto">
                      {activeAccounts.map((acct) => {
                        const { baselineRow, useCaseRows } = getAccountDetailRows(acct.name, idx);
                        const gt = getAccountGrandTotal(acct.name, idx);
                        return (
                          <div key={acct.name} className="flex-1 min-w-[400px]">
                            <table className="w-full">
                              <thead>
                                <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                                  <td className="py-2 pr-2" style={{ width: '40%' }}>$DBUs List ({acct.name.toUpperCase()})</td>
                                  <td className="py-2 text-right" style={{ width: '15%' }}>Y1</td>
                                  <td className="py-2 text-right" style={{ width: '15%' }}>Y2</td>
                                  <td className="py-2 text-right" style={{ width: '15%' }}>Y3</td>
                                  <td className="py-2 text-right" style={{ width: '15%' }}>Total</td>
                                </tr>
                              </thead>
                              <tbody>
                                {baselineRow && (
                                  <tr className="border-t hover:bg-gray-50">
                                    <td className="py-2 pr-2 text-sm text-gray-800">Existing - Live Use Cases</td>
                                    <td className="py-2 text-sm text-right">{formatCurrency(baselineRow.year1)}</td>
                                    <td className="py-2 text-sm text-right">{formatCurrency(baselineRow.year2)}</td>
                                    <td className="py-2 text-sm text-right">{formatCurrency(baselineRow.year3)}</td>
                                    <td className="py-2 text-sm text-right font-semibold">{formatCurrency(baselineRow.total)}</td>
                                  </tr>
                                )}
                                {useCaseRows.map((row: any, ri: number) => (
                                  <tr key={ri} className="border-t hover:bg-gray-50">
                                    <td className="py-2 pr-2 text-sm text-gray-600 pl-2">
                                      {row.use_case_area.replace(/^\s*↳\s*/, '')}
                                    </td>
                                    <td className="py-2 text-sm text-right">{formatCurrency(row.year1)}</td>
                                    <td className="py-2 text-sm text-right">{formatCurrency(row.year2)}</td>
                                    <td className="py-2 text-sm text-right">{formatCurrency(row.year3)}</td>
                                    <td className="py-2 text-sm text-right font-semibold">{formatCurrency(row.total)}</td>
                                  </tr>
                                ))}
                                <tr className="border-t-2 border-gray-300 bg-blue-50 font-bold">
                                  <td className="py-2 pr-2 text-sm">Total</td>
                                  <td className="py-2 text-sm text-right">{gt ? formatCurrency(gt.year1) : '$0'}</td>
                                  <td className="py-2 text-sm text-right">{gt ? formatCurrency(gt.year2) : '$0'}</td>
                                  <td className="py-2 text-sm text-right">{gt ? formatCurrency(gt.year3) : '$0'}</td>
                                  <td className="py-2 text-sm text-right">{gt ? formatCurrency(gt.total) : '$0'}</td>
                                </tr>
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
