import React, { useState, useEffect, useCallback } from 'react';
import { fetchConsumptionForecast, fetchScenario, saveScenario, formatCurrency, ConflictError } from '../api';
import type { AccountConfig } from '../App';

interface ForecastRow {
  type: 'baseline' | 'use_case';
  id: string;
  label: string;
  domain: string;
  values: number[];
  onboarding_month: number | null;
  live_month: number | null;
  steady_state_dbu: number | null;
}

interface ForecastData {
  account: string;
  scenario: number;
  month_labels: string[];
  rows: ForecastRow[];
  totals: number[];
  baseline_growth: number;
}

interface SKUAllocation {
  sku: string;
  percentage: number;
  dbus: number;
  dollarDbu: number;
}

interface UseCase {
  id: string;
  name: string;
  domain: string;
  steadyStateDbu: number;
  onboardingMonth: number;
  liveMonth: number;
  rampType: string;
  scenarios: [boolean, boolean, boolean];
  skuBreakdown?: SKUAllocation[];
}

interface ScenarioData {
  scenario_id: number;
  account: string;
  baseline_growth_rate: number;
  assumptions_text: string;
  new_use_cases: UseCase[];
  version: number;
}

const SCENARIO_COLORS = {
  1: { bg: 'bg-blue-600', text: 'text-blue-700', border: 'border-blue-300', light: 'bg-blue-50', badge: 'bg-blue-100 text-blue-800', check: 'accent-blue-600' },
  2: { bg: 'bg-purple-600', text: 'text-purple-700', border: 'border-purple-300', light: 'bg-purple-50', badge: 'bg-purple-100 text-purple-800', check: 'accent-purple-600' },
  3: { bg: 'bg-emerald-600', text: 'text-emerald-700', border: 'border-emerald-300', light: 'bg-emerald-50', badge: 'bg-emerald-100 text-emerald-800', check: 'accent-emerald-600' },
};

const SCENARIO_LABELS = { 1: 'S1', 2: 'S2', 3: 'S3' };
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Returns "M3Y1 (Jun'26)" for month n=3, given contractStartDate "2026-04" */
function getMonthLabel(n: number, contractStartDate?: string): string {
  const yearIdx = Math.floor((n - 1) / 12);
  const monthInYear = ((n - 1) % 12) + 1;
  const mLabel = `M${monthInYear}Y${yearIdx + 1}`;

  const csd = contractStartDate || (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  })();

  const [y, m] = csd.split('-').map(Number);
  const totalMonths = (y * 12 + m - 1) + (n - 1);
  const calYear = Math.floor(totalMonths / 12);
  const calMonth = (totalMonths % 12) + 1;
  return `${mLabel} (${MONTH_NAMES[calMonth - 1]}'${String(calYear).slice(2)})`;
}

/** Select dropdown options for months 1–36 */
function MonthSelect({ value, onChange, contractStartDate }: {
  value: number;
  onChange: (v: number) => void;
  contractStartDate?: string;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(Number(e.target.value))}
      className="w-full border border-slate-300 rounded px-1 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
    >
      {Array.from({ length: 36 }, (_, i) => i + 1).map(n => (
        <option key={n} value={n}>{getMonthLabel(n, contractStartDate)}</option>
      ))}
    </select>
  );
}
const SCENARIO_DESCS = {
  1: 'Existing + Baseline Growth',
  2: 'S1 + Mid-term Use Cases',
  3: 'S2 + Long-term Use Cases',
};


function CellValue({ value, highlight }: { value: number; highlight?: 'onboarding' | 'live' | null }) {
  const base = 'px-2 py-1.5 text-right text-xs font-mono whitespace-nowrap relative';
  if (highlight === 'onboarding') {
    return (
      <td className={`${base} bg-amber-200 text-amber-900 font-bold border-x-2 border-amber-500`} title="Onboarding month">
        <span className="block">{formatCurrency(value)}</span>
        <span className="absolute top-0 left-0 right-0 h-0.5 bg-amber-500" />
      </td>
    );
  }
  if (highlight === 'live') {
    return (
      <td className={`${base} bg-green-200 text-green-900 font-bold border-x-2 border-green-500`} title="Goes live (steady state)">
        <span className="block">{formatCurrency(value)}</span>
        <span className="absolute top-0 left-0 right-0 h-0.5 bg-green-500" />
      </td>
    );
  }
  return <td className={`${base} text-slate-700`}>{value > 0 ? formatCurrency(value) : <span className="text-slate-300">—</span>}</td>;
}

export default function ConsumptionForecastTab({ accounts }: { accounts: AccountConfig[] }) {
  const [activeScenario, setActiveScenario] = useState<1 | 2 | 3>(1);
  const [forecastData, setForecastData] = useState<Record<string, ForecastData>>({});
  const [scenarioData, setScenarioData] = useState<Record<string, ScenarioData>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [months, setMonths] = useState(24);
  const [conflictAccount, setConflictAccount] = useState<string | null>(null);
  const [expandedUCIds, setExpandedUCIds] = useState<Set<string>>(new Set());

  const toggleUCExpand = (id: string) => {
    setExpandedUCIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const activeAccounts = accounts.filter(a => a.name);

  // Load forecast + scenario for all accounts
  const loadData = useCallback(async (scenario: number) => {
    if (!activeAccounts.length) return;
    setLoading(true);
    setError('');
    try {
      const results = await Promise.all(
        activeAccounts.map(async (acc) => {
          const [forecast, sc] = await Promise.all([
            fetchConsumptionForecast(acc.sfdc_id, scenario, months, acc.contractStartDate || ''),
            fetchScenario(acc.sfdc_id, scenario),
          ]);
          return { name: acc.name, forecast, scenario: sc };
        })
      );
      const fd: Record<string, ForecastData> = {};
      const sd: Record<string, ScenarioData> = {};
      results.forEach(r => {
        fd[r.name] = r.forecast;
        sd[r.name] = r.scenario;
      });
      setForecastData(fd);
      setScenarioData(sd);
    } catch (e: any) {
      setError(e.message || 'Failed to load forecast');
    } finally {
      setLoading(false);
    }
  }, [activeAccounts.map(a => a.name).join(','), months]);

  useEffect(() => { loadData(activeScenario); }, [activeScenario, months]);

  // Save scenario and reload forecast for one account (account = display name, used as state key)
  const saveAndReload = async (account: string, updated: ScenarioData) => {
    setSaving(true);
    try {
      const acctConfig = accounts.find(a => a.name === account);
      const sfdc = acctConfig?.sfdc_id || account;
      const res = await saveScenario({ ...updated, scenario_id: activeScenario, account: sfdc });
      setScenarioData(prev => ({ ...prev, [account]: { ...updated, version: res.version } }));
      const forecast = await fetchConsumptionForecast(sfdc, activeScenario, months, acctConfig?.contractStartDate || '');
      setForecastData(prev => ({ ...prev, [account]: forecast }));
    } catch (e) {
      if (e instanceof ConflictError) setConflictAccount(account);
    }
    setSaving(false);
  };

  const handleScenarioSwitch = async (s: 1 | 2 | 3) => {
    if (Object.keys(scenarioData).length > 0) {
      setSaving(true);
      try {
        await Promise.all(
          Object.entries(scenarioData).map(async ([account, sd]) => {
            const sfdc = accounts.find(a => a.name === account)?.sfdc_id || account;
            const res = await saveScenario({ ...sd, scenario_id: activeScenario, account: sfdc });
            setScenarioData(prev => ({ ...prev, [account]: { ...sd, version: res.version } }));
          })
        );
      } catch (e) { /* conflict on switch is non-critical; new scenario loads fresh */ }
      setSaving(false);
    }
    setActiveScenario(s);
  };

  // Toggle a scenario checkbox for a use case
  const toggleUcScenario = async (account: string, ucId: string, scenarioIdx: number) => {
    const sd = scenarioData[account];
    if (!sd) return;
    const updated = {
      ...sd,
      new_use_cases: sd.new_use_cases.map(uc => {
        if (uc.id !== ucId) return uc;
        const scens = [...uc.scenarios] as [boolean, boolean, boolean];
        scens[scenarioIdx] = !scens[scenarioIdx];
        return { ...uc, scenarios: scens };
      }),
    };
    setScenarioData(prev => ({ ...prev, [account]: updated }));
    await saveAndReload(account, updated);
  };

  const sc = activeScenario as 1 | 2 | 3;
  const colors = SCENARIO_COLORS[sc];

  // Collect all use cases across accounts for the panel
  const allUseCases: Array<{ account: string; uc: UseCase }> = [];
  Object.entries(scenarioData).forEach(([account, sd]) => {
    (sd.new_use_cases || []).forEach(uc => allUseCases.push({ account, uc }));
  });

  const multiAccount = activeAccounts.length > 1;

  return (
    <div className="space-y-4">
      {/* Conflict modal */}
      {conflictAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-semibold text-red-700 mb-2">Save conflict</h3>
            <p className="text-sm text-gray-600 mb-4">
              Another tab or user saved <strong>{conflictAccount}</strong>'s scenario while you were editing. Reload to get the latest version — your unsaved changes will be lost.
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConflictAccount(null)} className="px-3 py-1.5 text-sm rounded border border-gray-300 text-gray-700 hover:bg-gray-50">
                Keep editing
              </button>
              <button onClick={() => { setConflictAccount(null); loadData(activeScenario); }} className="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-700">
                Reload latest
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Consumption Forecast</h2>
          <p className="text-sm text-slate-500 mt-0.5">Month-over-month projection by use case</p>
        </div>
        <div className="flex items-center gap-3">
          {saving && <span className="text-xs text-slate-500 animate-pulse">Saving...</span>}
          <label className="text-xs text-slate-500 flex items-center gap-1.5">
            Months:
            <select
              value={months}
              onChange={e => setMonths(Number(e.target.value))}
              className="border border-slate-200 rounded px-2 py-1 text-xs"
            >
              <option value={12}>12</option>
              <option value={24}>24</option>
              <option value={36}>36</option>
            </select>
          </label>
        </div>
      </div>

      {/* Scenario tabs */}
      <div className="flex gap-2">
        {([1, 2, 3] as const).map(s => {
          const c = SCENARIO_COLORS[s];
          const active = s === activeScenario;
          return (
            <button
              key={s}
              onClick={() => handleScenarioSwitch(s)}
              className={`flex flex-col px-5 py-2.5 rounded-lg border-2 text-left transition-all ${
                active
                  ? `${c.bg} text-white border-transparent shadow-md`
                  : `bg-white ${c.border} ${c.text} hover:${c.light}`
              }`}
            >
              <span className="text-sm font-bold">{SCENARIO_LABELS[s]}</span>
              <span className={`text-xs ${active ? 'text-white/80' : 'text-slate-500'}`}>{SCENARIO_DESCS[s]}</span>
            </button>
          );
        })}
      </div>

      {/* ── Use Cases Panel ── */}
      <div className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
        <div className={`px-4 py-3 ${colors.light} border-b ${colors.border} flex items-center justify-between`}>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-bold px-2 py-0.5 rounded ${colors.badge}`}>Use Cases</span>
            <span className="text-sm font-semibold text-slate-700">From Scenario Builder</span>
          </div>
          <span className="text-xs text-slate-400 italic">Manage use cases in the Scenario Builder tab</span>
        </div>

        {allUseCases.length === 0 ? (
          <div className="px-6 py-8 text-center text-slate-400 text-sm">
            No use cases found. Add them in the <span className="font-medium">Scenario Builder</span> tab and save.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500">
                  {multiAccount && <th className="px-3 py-2 text-left font-semibold min-w-[100px]">Account</th>}
                  <th className="px-3 py-2 text-left font-semibold min-w-[160px]">Name</th>
                  <th className="px-3 py-2 text-left font-semibold min-w-[110px]">Domain</th>
                  <th className="px-3 py-2 text-right font-semibold min-w-[110px]">$/mo (steady state)</th>
                  <th className="px-3 py-2 text-center font-semibold min-w-[140px]">Onboard Month</th>
                  <th className="px-3 py-2 text-center font-semibold min-w-[140px]">Live Month</th>
                  <th className="px-3 py-2 text-center font-semibold">S1</th>
                  <th className="px-3 py-2 text-center font-semibold">S2</th>
                  <th className="px-3 py-2 text-center font-semibold">S3</th>
                  <th className="px-3 py-2 w-8" />
                </tr>
              </thead>
              <tbody>
                {allUseCases.map(({ account, uc }, idx) => {
                  const rowBg = idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/40';
                  return (
                    <tr key={uc.id} className={`border-b border-slate-100 ${rowBg}`}>
                      {multiAccount && <td className="px-3 py-2 text-slate-500 font-medium">{account}</td>}
                      <td className="px-3 py-2 font-medium text-slate-700">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 flex-shrink-0 ${colors.bg}`} />
                        {uc.name || <span className="text-slate-400 italic">Untitled</span>}
                      </td>
                      <td className="px-3 py-2 text-slate-500">{uc.domain || '—'}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-700">{formatCurrency(uc.steadyStateDbu)}</td>
                      <td className="px-3 py-2 text-center">
                        <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-medium text-xs whitespace-nowrap">
                          {getMonthLabel(uc.onboardingMonth, accounts.find(a => a.name === account)?.contractStartDate)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className="px-2 py-0.5 rounded bg-green-100 text-green-800 font-medium text-xs whitespace-nowrap">
                          {getMonthLabel(uc.liveMonth, accounts.find(a => a.name === account)?.contractStartDate)}
                        </span>
                      </td>
                      {([0, 1, 2] as const).map(si => (
                        <td key={si} className="px-3 py-2 text-center">
                          <input type="checkbox" checked={uc.scenarios[si]}
                            onChange={() => toggleUcScenario(account, uc.id, si)}
                            className="w-4 h-4 rounded cursor-pointer"
                            style={{ accentColor: ['#2563eb', '#9333ea', '#059669'][si] }} />
                        </td>
                      ))}
                      <td />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-slate-500">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-amber-100 border-l-2 border-amber-400" />
          <span>Onboarding month</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-green-100 border-l-2 border-green-400" />
          <span>Goes live</span>
        </div>
        <span className="text-slate-300">|</span>
        <span className="text-slate-400">Click a use case name to edit inline</span>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>}

      {/* Forecast tables */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400 text-sm">Loading forecast...</div>
      ) : (
        <div className="space-y-6">
          {activeAccounts.map(acc => {
            const fd = forecastData[acc.name];
            if (!fd) return null;
            const monthLabels = fd.month_labels;

            return (
              <div key={acc.name} className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                {/* Account header */}
                <div className={`px-4 py-3 ${colors.light} border-b ${colors.border} flex items-center justify-between`}>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded ${colors.badge}`}>{SCENARIO_LABELS[sc]}</span>
                    <span className="font-semibold text-slate-800">{acc.name}</span>
                    <span className="text-xs text-slate-500">• {(fd.baseline_growth * 100).toFixed(1)}% MoM baseline growth</span>
                  </div>
                  <span className="text-xs text-slate-500">{fd.rows.filter(r => r.type === 'use_case').length} use cases active</span>
                </div>

                {/* Legend */}
                {fd.rows.some(r => r.type === 'use_case') && (
                  <div className="px-4 py-2 bg-white border-b border-slate-100 flex items-center gap-4 text-xs text-slate-500">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block w-3 h-3 rounded-sm bg-amber-200 border border-amber-500" />
                      Onboarding month
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block w-3 h-3 rounded-sm bg-green-200 border border-green-500" />
                      Goes live (steady state)
                    </span>
                    <span className="flex items-center gap-1.5 text-slate-400">
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      Click arrow on use cases to expand SKU breakdown
                    </span>
                  </div>
                )}

                {/* Forecast table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200">
                        <th className="px-3 py-2 text-left font-semibold text-slate-600 sticky left-0 bg-slate-50 z-10 min-w-[180px] border-r border-slate-200">
                          Use Case / Line Item
                        </th>
                        <th className="px-2 py-2 text-left font-semibold text-slate-500 min-w-[90px]">Domain</th>
                        {monthLabels.map((m, i) => (
                          <th key={i} className="px-2 py-2 text-right font-medium text-slate-500 min-w-[80px] whitespace-nowrap">{m}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {fd.rows.map((row, ri) => {
                        const isBaseline = row.type === 'baseline';
                        const om = row.onboarding_month;
                        const lm = row.live_month;

                        // Find matching UC for SKU breakdown
                        const ucData = !isBaseline
                          ? (scenarioData[acc.name]?.new_use_cases || []).find(u => u.id === row.id)
                          : null;
                        const skus = ucData?.skuBreakdown?.filter(a => a.percentage > 0) || [];
                        const hasSkus = skus.length > 0;
                        const isExpanded = expandedUCIds.has(row.id);

                        return (
                          <React.Fragment key={row.id}>
                            <tr
                              className={`border-b border-slate-100 ${
                                isBaseline
                                  ? 'bg-slate-50 font-medium'
                                  : ri % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'
                              } hover:bg-blue-50/30 transition-colors`}
                            >
                              <td className={`px-3 py-1.5 font-medium sticky left-0 z-10 border-r border-slate-100 ${isBaseline ? 'bg-slate-50 text-slate-800' : 'bg-white text-slate-700'}`}>
                                <div className="flex items-center gap-1.5">
                                  {!isBaseline && <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${colors.bg}`} />}
                                  <span className="flex-1">{row.label}</span>
                                  {hasSkus && (
                                    <button
                                      onClick={() => toggleUCExpand(row.id)}
                                      className="flex-shrink-0 text-slate-400 hover:text-slate-700 transition-colors"
                                      title={isExpanded ? 'Hide SKU breakdown' : 'Show SKU breakdown'}
                                    >
                                      <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                      </svg>
                                    </button>
                                  )}
                                </div>
                              </td>
                              <td className="px-2 py-1.5 text-slate-400 whitespace-nowrap">{row.domain}</td>
                              {row.values.map((v, i) => {
                                const monthNum = i + 1;
                                const highlight = !isBaseline
                                  ? (monthNum === om ? 'onboarding' : monthNum === lm ? 'live' : null)
                                  : null;
                                return <CellValue key={i} value={v} highlight={highlight} />;
                              })}
                            </tr>

                            {/* SKU breakdown sub-rows */}
                            {hasSkus && isExpanded && skus.map((alloc, si) => (
                              <tr key={`${row.id}-sku-${si}`} className="border-b border-slate-100 bg-slate-50/60">
                                <td className="pl-8 pr-3 py-1 sticky left-0 z-10 bg-slate-50/60 border-r border-slate-100">
                                  <div className="flex items-center gap-1.5">
                                    <span className="w-1 h-1 rounded-full bg-slate-300 flex-shrink-0" />
                                    <span className="text-slate-500 text-[11px] font-normal">{alloc.sku}</span>
                                    <span className="text-[10px] text-slate-400 ml-auto">{alloc.percentage}%</span>
                                  </div>
                                </td>
                                <td className="px-2 py-1 text-slate-300 text-[11px]">—</td>
                                {row.values.map((v, i) => {
                                  const skuVal = v * alloc.percentage / 100;
                                  return (
                                    <td key={i} className="px-2 py-1 text-right text-[11px] font-mono text-slate-400 whitespace-nowrap">
                                      {skuVal > 0 ? formatCurrency(skuVal) : <span className="text-slate-200">—</span>}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </React.Fragment>
                        );
                      })}

                      {/* Total row */}
                      <tr className={`border-t-2 ${colors.border} font-bold`}>
                        <td className={`px-3 py-2 sticky left-0 z-10 ${colors.light} ${colors.text} border-r border-slate-200`}>
                          Total Forecast
                        </td>
                        <td className={`px-2 py-2 ${colors.light}`} />
                        {fd.totals.map((t, i) => (
                          <td key={i} className={`px-2 py-2 text-right text-xs font-bold ${colors.text} ${colors.light}`}>
                            {formatCurrency(t)}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}

          {activeAccounts.length === 0 && (
            <div className="text-center py-16 text-slate-400 text-sm">
              Add an account in the header to see the consumption forecast.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
