import React, { useState, useEffect, useCallback, useRef } from 'react';
import { fetchConsumptionForecast, fetchScenario, saveScenario, formatCurrency, ConflictError } from '../api';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import type { AccountConfig } from '../App';

const CHART_COLORS = [
  '#3B82F6','#10B981','#F59E0B','#8B5CF6','#EF4444','#EC4899',
  '#06B6D4','#84CC16','#F97316','#6366F1','#14B8A6','#E11D48',
];

function downloadChartAsPng(containerRef: React.RefObject<HTMLDivElement | null>, filename: string) {
  const svg = containerRef.current?.querySelector('svg');
  if (!svg) return;
  const svgData = new XMLSerializer().serializeToString(svg);
  const canvas = document.createElement('canvas');
  const scale = 2;
  canvas.width  = svg.clientWidth  * scale;
  canvas.height = svg.clientHeight * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const a = document.createElement('a');
    a.download = filename;
    a.href = canvas.toDataURL('image/png');
    a.click();
  };
  img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
}

interface AdhocPeriodRow {
  id: string;
  label: string;
  months: number[];
  skuAmounts: { sku: string; dbuPerMonth: number; dollarPerMonth: number; customDbuRate?: number }[];
}

interface ForecastRow {
  type: 'baseline' | 'use_case';
  id: string;
  label: string;
  domain: string;
  values: number[];
  onboarding_month: number | null;
  live_month: number | null;
  steady_state_dbu: number | null;
  overridden_month_indices?: number[];
  uplift_only?: boolean;
  adhoc_periods?: AdhocPeriodRow[];
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
  upliftOnly?: boolean;
  uplift_only?: boolean;
}

interface ScenarioData {
  scenario_id: number;
  account: string;
  baseline_growth_rate: number;
  assumptions_text: string;
  new_use_cases: UseCase[];
  baseline_overrides?: { month_index: number; value: number }[];
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

// ─── DBU conversion helpers ───────────────────────────────────────────────────

/** Returns DBUs/$ conversion rate for a use case (from SKU breakdown if available).
 *  Returns 0 for uplift-only use cases — they have no DBU volume impact. */
function dbuRate(ucData: UseCase | null | undefined): number {
  if (ucData?.upliftOnly || ucData?.uplift_only) return 0;
  if (ucData?.skuBreakdown?.length) {
    const totalDollar = ucData.skuBreakdown.reduce((s, a) => s + a.dollarDbu, 0);
    const totalDbu    = ucData.skuBreakdown.reduce((s, a) => s + a.dbus, 0);
    if (totalDollar > 0 && totalDbu > 0) return totalDbu / totalDollar;
  }
  return 1 / 0.20; // default: $0.20/DBU blended list price
}

function formatDbu(val: number): string {
  if (val === 0) return '';
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000)     return `${(val / 1_000).toFixed(1)}K`;
  return Math.round(val).toLocaleString();
}

// ─────────────────────────────────────────────────────────────────────────────

function ForecastDomainCharts({
  forecastData, activeAccounts, activeScenario, months,
}: {
  forecastData: Record<string, ForecastData>;
  activeAccounts: AccountConfig[];
  activeScenario: number;
  months: number;
}) {
  const [viewMode, setViewMode] = useState<'yearly' | 'monthly'>('yearly');
  const [metricMode, setMetricMode] = useState<'dollar' | 'dbu'>('dollar');
  const chartRef = useRef<HTMLDivElement>(null);

  const DBU_RATE = 1 / 0.20; // default $0.20/DBU blended

  // Build use case label → monthly values (Baseline as its own series)
  const ucMonthly: Record<string, number[]> = {};
  const monthLabels: string[] = [];

  activeAccounts.forEach(acc => {
    const fd = forecastData[acc.name];
    if (!fd) return;
    if (!monthLabels.length) fd.month_labels.slice(0, months).forEach(l => monthLabels.push(l));
    fd.rows.forEach(row => {
      const label = row.type === 'baseline' ? 'Baseline' : (row.label || 'Other');
      if (!ucMonthly[label]) ucMonthly[label] = new Array(months).fill(0);
      // uplift_only rows: dollar impact is real but DBU count is 0
      const isUpliftOnly = row.uplift_only === true;
      row.values.slice(0, months).forEach((v, i) => {
        ucMonthly[label][i] += (metricMode === 'dbu' && !isUpliftOnly) ? v * DBU_RATE : (metricMode === 'dbu' ? 0 : v);
      });
    });
  });

  // Baseline first, then sorted by total descending
  const labels = Object.keys(ucMonthly).sort((a, b) => {
    if (a === 'Baseline') return -1;
    if (b === 'Baseline') return 1;
    return ucMonthly[b].reduce((s, v) => s + v, 0) - ucMonthly[a].reduce((s, v) => s + v, 0);
  });

  // Only show years that have data based on `months`
  const numYears = Math.min(3, Math.ceil(months / 12));

  const yearlyData = Array.from({ length: numYears }, (_, yi) => {
    const entry: Record<string, any> = { period: `Year ${yi + 1}` };
    labels.forEach(l => {
      entry[l] = Math.round(ucMonthly[l].slice(yi * 12, (yi + 1) * 12).reduce((s, v) => s + v, 0));
    });
    return entry;
  });

  const monthlyData = monthLabels.map((label, i) => {
    const entry: Record<string, any> = { period: label };
    labels.forEach(l => { entry[l] = Math.round(ucMonthly[l][i] || 0); });
    return entry;
  });

  const chartData = viewMode === 'yearly' ? yearlyData : monthlyData;
  const scenarioLabel = `S${activeScenario}`;

  const fmtVal = (v: number) => metricMode === 'dbu' ? `${formatDbu(v)} DBUs` : formatCurrency(v);
  const yTickFmt = (v: number) => metricMode === 'dbu' ? formatDbu(v) : formatCurrency(v);

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">
            {scenarioLabel} — Forecast by Use Case
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">All accounts combined · {months}-month projection</p>
        </div>
        <div className="flex items-center gap-2">
          {/* $DBU / DBU toggle */}
          <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs">
            {(['dollar', 'dbu'] as const).map(m => (
              <button
                key={m}
                onClick={() => setMetricMode(m)}
                className={`px-3 py-1.5 font-medium transition-colors ${
                  metricMode === m ? 'bg-slate-800 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'
                }`}
              >
                {m === 'dollar' ? '$DBU' : 'DBU'}
              </button>
            ))}
          </div>
          {/* Yearly / Monthly toggle */}
          <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs">
            {(['yearly', 'monthly'] as const).map(m => (
              <button
                key={m}
                onClick={() => setViewMode(m)}
                className={`px-3 py-1.5 font-medium transition-colors capitalize ${
                  viewMode === m ? 'bg-slate-800 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          {/* Download */}
          <button
            onClick={() => downloadChartAsPng(chartRef, `S${activeScenario}_forecast_${viewMode}_${metricMode}.png`)}
            className="flex items-center gap-1 px-2 py-1.5 text-xs text-slate-500 hover:text-slate-800 border border-slate-200 rounded hover:bg-slate-50 transition-colors"
            title="Download chart as PNG"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            PNG
          </button>
        </div>
      </div>
      <div ref={chartRef}>
        <ResponsiveContainer width="100%" height={340}>
          <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: viewMode === 'monthly' ? 20 : 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
            <XAxis
              dataKey="period"
              tick={{ fontSize: viewMode === 'monthly' ? 9 : 11 }}
              angle={viewMode === 'monthly' ? -35 : 0}
              textAnchor={viewMode === 'monthly' ? 'end' : 'middle'}
              interval={viewMode === 'monthly' ? Math.floor(months / 12) : 0}
            />
            <YAxis tickFormatter={yTickFmt} tick={{ fontSize: 10 }} width={80} />
            <Tooltip formatter={(v: number, name: string) => [fmtVal(v), name]} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            {labels.map((l, i) => (
              <Bar key={l} dataKey={l} stackId="a" fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function ConsumptionForecastTab({ accounts }: { accounts: AccountConfig[] }) {
  const [activeScenario, setActiveScenario] = useState<1 | 2 | 3>(1);
  const [forecastData, setForecastData] = useState<Record<string, ForecastData>>({});
  const [scenarioData, setScenarioData] = useState<Record<string, ScenarioData>>({});
  // Merged use cases across all 3 scenarios per account
  const [mergedUseCases, setMergedUseCases] = useState<Record<string, UseCase[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [months, setMonths] = useState(() => accounts[0]?.contractMonths ?? 36);
  const [conflictAccount, setConflictAccount] = useState<string | null>(null);
  const [collapsedUCIds, setCollapsedUCIds] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<'dollar' | 'dbu'>('dollar');

  const toggleUCExpand = (id: string) => {
    setCollapsedUCIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const activeAccounts = accounts.filter(a => a.name);

  // Merge use cases from all 3 scenarios by ID — OR-ing scenario flags
  const mergeUseCases = (allScs: ScenarioData[]): UseCase[] => {
    const map = new Map<string, UseCase>();
    allScs.forEach(sc => {
      (sc.new_use_cases || []).forEach(uc => {
        if (!map.has(uc.id)) {
          map.set(uc.id, { ...uc, scenarios: [...uc.scenarios] as [boolean, boolean, boolean] });
        } else {
          const existing = map.get(uc.id)!;
          map.set(uc.id, {
            ...existing,
            scenarios: [
              existing.scenarios[0] || uc.scenarios[0],
              existing.scenarios[1] || uc.scenarios[1],
              existing.scenarios[2] || uc.scenarios[2],
            ],
          });
        }
      });
    });
    return Array.from(map.values());
  };

  // Load forecast + all 3 scenario files for all accounts
  const loadData = useCallback(async (scenario: number) => {
    if (!activeAccounts.length) return;
    setLoading(true);
    setError('');
    try {
      const results = await Promise.all(
        activeAccounts.map(async (acc) => {
          const [forecast, sc1, sc2, sc3] = await Promise.all([
            fetchConsumptionForecast(acc.sfdc_id, scenario, months, acc.contractStartDate || ''),
            fetchScenario(acc.sfdc_id, 1),
            fetchScenario(acc.sfdc_id, 2),
            fetchScenario(acc.sfdc_id, 3),
          ]);
          return { name: acc.name, forecast, sc1, sc2, sc3 };
        })
      );
      const fd: Record<string, ForecastData> = {};
      const sd: Record<string, ScenarioData> = {};
      const mu: Record<string, UseCase[]> = {};
      results.forEach(r => {
        fd[r.name] = r.forecast;
        // Active scenario data (used for baseline growth etc.)
        sd[r.name] = [r.sc1, r.sc2, r.sc3][scenario - 1];
        // Merged use cases from all 3 scenarios
        mu[r.name] = mergeUseCases([r.sc1, r.sc2, r.sc3]);
      });
      setForecastData(fd);
      setScenarioData(sd);
      setMergedUseCases(mu);
    } catch (e: any) {
      setError(e.message || 'Failed to load forecast');
    } finally {
      setLoading(false);
    }
  }, [activeAccounts.map(a => a.name).join(','), months]);

  useEffect(() => { loadData(activeScenario); }, [activeScenario, months]);

  // Save scenario and reload forecast + merged use cases for one account
  const saveAndReload = async (account: string, updated: ScenarioData) => {
    setSaving(true);
    try {
      const acctConfig = accounts.find(a => a.name === account);
      const sfdc = acctConfig?.sfdc_id || account;
      const res = await saveScenario({ ...updated, scenario_id: activeScenario, account: sfdc });
      const savedVersion = { ...updated, version: res.version };
      setScenarioData(prev => ({ ...prev, [account]: savedVersion }));
      // Reload forecast AND all 3 scenario files so mergedUseCases reflects deletions/changes
      const [forecast, sc1, sc2, sc3] = await Promise.all([
        fetchConsumptionForecast(sfdc, activeScenario, months, acctConfig?.contractStartDate || ''),
        fetchScenario(sfdc, 1),
        fetchScenario(sfdc, 2),
        fetchScenario(sfdc, 3),
      ]);
      setForecastData(prev => ({ ...prev, [account]: forecast }));
      setMergedUseCases(prev => ({ ...prev, [account]: mergeUseCases([sc1, sc2, sc3]) }));
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

  // Collect use cases active in the current scenario — from merged view across all 3 scenario files
  const allUseCases: Array<{ account: string; uc: UseCase }> = [];
  Object.entries(mergedUseCases).forEach(([account, ucs]) => {
    ucs
      .filter(uc => uc.scenarios[activeScenario - 1])
      .forEach(uc => allUseCases.push({ account, uc }));
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
          <button
            onClick={() => loadData(activeScenario)}
            disabled={loading}
            className="text-xs text-slate-500 hover:text-slate-700 border border-slate-200 rounded px-2 py-1 hover:bg-slate-50 disabled:opacity-40"
            title="Refresh data from scenario builder"
          >
            ↺ Refresh
          </button>

          {/* DBU / $DBU toggle */}
          <div className="flex items-center rounded-lg border border-slate-200 overflow-hidden shadow-sm">
            <button
              onClick={() => setViewMode('dollar')}
              className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                viewMode === 'dollar'
                  ? 'bg-slate-800 text-white'
                  : 'bg-white text-slate-500 hover:bg-slate-50'
              }`}
            >
              $DBU
            </button>
            <button
              onClick={() => setViewMode('dbu')}
              className={`px-3 py-1.5 text-xs font-semibold transition-colors border-l border-slate-200 ${
                viewMode === 'dbu'
                  ? 'bg-slate-800 text-white'
                  : 'bg-white text-slate-500 hover:bg-slate-50'
              }`}
            >
              DBUs
            </button>
          </div>

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
                  <th className="px-3 py-2 text-left font-semibold min-w-[160px]">Name / SKU Breakdown</th>
                  <th className="px-3 py-2 text-left font-semibold min-w-[110px]">Domain</th>
                  <th className="px-3 py-2 text-right font-semibold min-w-[110px]">
                    {viewMode === 'dbu' ? 'DBUs/mo (steady state)' : '$/mo (steady state)'}
                  </th>
                  <th className="px-3 py-2 text-center font-semibold min-w-[140px]">Onboard Month</th>
                  <th className="px-3 py-2 text-center font-semibold min-w-[140px]">Live Month</th>
                  <th className="px-3 py-2 text-center font-semibold">S1</th>
                  <th className="px-3 py-2 text-center font-semibold">S2</th>
                  <th className="px-3 py-2 text-center font-semibold">S3</th>
                </tr>
              </thead>
              <tbody>
                {allUseCases.map(({ account, uc }, idx) => {
                  const rowBg = idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/40';
                  const skus = (uc.skuBreakdown || []).filter(s => s.percentage > 0);
                  return (
                    <React.Fragment key={uc.id}>
                      <tr className={`border-b ${skus.length ? 'border-slate-50' : 'border-slate-100'} ${rowBg}`}>
                        {multiAccount && <td className="px-3 py-2 text-slate-500 font-medium" rowSpan={skus.length ? skus.length + 1 : 1}>{account}</td>}
                        <td className="px-3 py-2 font-medium text-slate-700">
                          <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 flex-shrink-0 ${colors.bg}`} />
                          {uc.name || <span className="text-slate-400 italic">Untitled</span>}
                        </td>
                        <td className="px-3 py-2 text-slate-500">{uc.domain || '—'}</td>
                        <td className="px-3 py-2 text-right font-mono text-slate-700 font-semibold">
                          {viewMode === 'dbu'
                            ? (uc.upliftOnly || uc.uplift_only
                                ? <span className="text-amber-600 text-xs font-semibold">$ uplift only</span>
                                : `${formatDbu(dbuRate(uc) * uc.steadyStateDbu)} DBUs`)
                            : formatCurrency(uc.steadyStateDbu)}
                        </td>
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
                            {uc.scenarios[si]
                              ? <span className="inline-flex items-center justify-center w-5 h-5 rounded-full" style={{ background: ['#DBEAFE','#F3E8FF','#D1FAE5'][si] }}>
                                  <svg className="w-3 h-3" style={{ color: ['#2563eb','#9333ea','#059669'][si] }} fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                  </svg>
                                </span>
                              : <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-slate-100">
                                  <span className="w-2 h-0.5 bg-slate-300 rounded" />
                                </span>
                            }
                          </td>
                        ))}
                      </tr>
                      {/* SKU sub-rows */}
                      {skus.map((alloc, si) => (
                        <tr key={`${uc.id}-sku-${si}`} className={`border-b border-slate-100 ${rowBg}`}>
                          {multiAccount && null}
                          <td className="pl-7 pr-3 py-1" colSpan={1}>
                            <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                              <span className="text-slate-300">└─</span>
                              <span className="font-medium">{alloc.sku}</span>
                              <span className="bg-slate-100 text-slate-500 rounded px-1">{alloc.percentage}%</span>
                              {viewMode === 'dbu' ? (
                                <>
                                  {alloc.dbus > 0 && <span className="text-slate-400">{Math.round(alloc.dbus).toLocaleString()} DBUs/mo</span>}
                                  {alloc.dollarDbu > 0 && <span className="text-slate-400">{formatCurrency(alloc.dollarDbu)}/mo</span>}
                                </>
                              ) : (
                                <>
                                  {alloc.dollarDbu > 0 && <span className="text-slate-400">{formatCurrency(alloc.dollarDbu)}/mo</span>}
                                  {alloc.dbus > 0 && <span className="text-slate-400">{Math.round(alloc.dbus).toLocaleString()} DBUs/mo</span>}
                                </>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-1 text-[11px] text-slate-400">{uc.domain || '—'}</td>
                          <td className="px-3 py-1 text-right font-mono text-[11px] text-slate-500">
                            {viewMode === 'dbu'
                              ? (uc.upliftOnly || uc.uplift_only
                                  ? <span className="text-amber-600 text-[10px]">0 DBUs</span>
                                  : (alloc.dbus > 0 ? `${Math.round(alloc.dbus).toLocaleString()} DBUs` : `${formatDbu(dbuRate(uc) * uc.steadyStateDbu * alloc.percentage / 100)} DBUs`))
                              : formatCurrency(uc.steadyStateDbu * alloc.percentage / 100)}
                          </td>
                          <td colSpan={5} />
                        </tr>
                      ))}
                    </React.Fragment>
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
        <span className="text-slate-400">Read-only — manage use cases in the Scenario Builder tab</span>
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
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block w-3 h-3 rounded-sm bg-amber-50 border-l-2 border-amber-400" />
                      Manual baseline override
                    </span>
                    <span className="flex items-center gap-1.5 text-slate-400">
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      SKU breakdown shown inline — click arrow to collapse
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
                          <th key={i} className="px-2 py-2 text-right font-medium text-slate-500 min-w-[80px] whitespace-nowrap">
                            {m}
                            {viewMode === 'dbu' && <div className="text-[10px] font-normal text-slate-400">DBUs</div>}
                          </th>
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
                          ? (scenarioData[acc.name]?.new_use_cases || mergedUseCases[acc.name] || []).find(u => u.id === row.id)
                          : null;
                        const skus = ucData?.skuBreakdown?.filter(a => a.percentage > 0) || [];
                        const hasSkus = skus.length > 0;
                        const isExpanded = !collapsedUCIds.has(row.id);
                        const rate = (row.uplift_only || ucData?.upliftOnly || ucData?.uplift_only) ? 0 : dbuRate(ucData);

                        const overriddenSet = isBaseline
                          ? new Set(row.overridden_month_indices || [])
                          : new Set<number>();

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
                                  {row.uplift_only && (
                                    <span className="text-[9px] font-semibold text-amber-600 bg-amber-50 border border-amber-200 rounded px-1 py-0.5 flex-shrink-0">$ uplift</span>
                                  )}
                                  {hasSkus && (
                                    <button
                                      onClick={() => toggleUCExpand(row.id)}
                                      className="flex-shrink-0 text-slate-400 hover:text-slate-700 transition-colors"
                                      title={isExpanded ? 'Collapse SKU breakdown' : 'Expand SKU breakdown'}
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
                                const isOverriddenCell = overriddenSet.has(i);
                                const highlight = !isBaseline
                                  ? (monthNum === om ? 'onboarding' : monthNum === lm ? 'live' : null)
                                  : null;
                                if (viewMode === 'dbu') {
                                  const dbuVal = v * rate;
                                  return (
                                    <td key={i} className={`px-2 py-1.5 text-right text-xs font-mono whitespace-nowrap ${
                                      highlight === 'onboarding' ? 'bg-amber-200 text-amber-900 font-bold border-x-2 border-amber-500'
                                      : highlight === 'live'     ? 'bg-green-200 text-green-900 font-bold border-x-2 border-green-500'
                                      : isOverriddenCell         ? 'bg-amber-50 text-amber-900 border-l-2 border-amber-400'
                                      : 'text-slate-600'
                                    }`} title={isOverriddenCell ? 'Manual override' : undefined}>
                                      {dbuVal > 0 ? formatDbu(dbuVal) : <span className="text-slate-300">—</span>}
                                    </td>
                                  );
                                }
                                if (isOverriddenCell) {
                                  return (
                                    <td key={i} className="px-2 py-1.5 text-right text-xs font-mono whitespace-nowrap bg-amber-50 text-amber-900 font-semibold border-l-2 border-amber-400" title="Manual override">
                                      {formatCurrency(v)}
                                    </td>
                                  );
                                }
                                return <CellValue key={i} value={v} highlight={highlight} />;
                              })}
                            </tr>

                            {/* SKU breakdown sub-rows + adhoc rows — show when either exists */}
                            {(hasSkus || (row.adhoc_periods && row.adhoc_periods.length > 0)) && isExpanded && (() => {
                              // Collect unique adhoc SKU rows: [periodLabel, sku, dbuPerMonth, dollarPerMonth, monthsSet]
                              const adhocSkuRows: { periodLabel: string; sku: string; dbuPerMonth: number; dollarPerMonth: number; monthsSet: Set<number> }[] = [];
                              (row.adhoc_periods || []).forEach(period => {
                                period.skuAmounts.forEach(sa => {
                                  if (!sa.dollarPerMonth && !sa.dbuPerMonth) return;
                                  const existing = adhocSkuRows.find(r => r.sku === sa.sku && r.periodLabel === period.label);
                                  if (existing) {
                                    period.months.forEach(m => existing.monthsSet.add(m));
                                    existing.dollarPerMonth = Math.max(existing.dollarPerMonth, sa.dollarPerMonth);
                                    existing.dbuPerMonth = Math.max(existing.dbuPerMonth, sa.dbuPerMonth || 0);
                                  } else {
                                    adhocSkuRows.push({ periodLabel: period.label, sku: sa.sku, dbuPerMonth: sa.dbuPerMonth || 0, dollarPerMonth: sa.dollarPerMonth, monthsSet: new Set(period.months) });
                                  }
                                });
                              });

                              return (
                                <>
                                  {skus.map((alloc, si) => (
                                    <tr key={`${row.id}-sku-${si}`} className="border-b border-slate-100 bg-slate-50/50">
                                      <td className="pl-8 pr-3 py-1 sticky left-0 z-10 bg-slate-50/50 border-r border-slate-100">
                                        <div className="flex items-center gap-1.5">
                                          <span className="text-slate-300 text-[10px]">└─</span>
                                          <span className="text-slate-600 text-[11px] font-medium">{alloc.sku}</span>
                                          <span className="text-[10px] text-slate-400 bg-slate-100 rounded px-1">{alloc.percentage}%</span>
                                          {alloc.dbus > 0 && !row.uplift_only && (
                                            <span className="text-[10px] text-slate-400">{Math.round(alloc.dbus).toLocaleString()} DBUs/mo</span>
                                          )}
                                          {alloc.dollarDbu > 0 && (
                                            <span className="text-[10px] text-slate-400 ml-1">{formatCurrency(alloc.dollarDbu)}/mo</span>
                                          )}
                                        </div>
                                      </td>
                                      <td className="px-2 py-1 text-slate-300 text-[11px]">—</td>
                                      {row.values.map((v, i) => {
                                        const skuFrac = alloc.percentage / 100;
                                        if (viewMode === 'dbu') {
                                          const skuDbu = v * skuFrac * (alloc.dbus > 0 && alloc.dollarDbu > 0 ? alloc.dbus / alloc.dollarDbu : rate);
                                          return (
                                            <td key={i} className="px-2 py-1 text-right text-[11px] font-mono text-slate-400 whitespace-nowrap">
                                              {skuDbu > 0 ? formatDbu(skuDbu) : <span className="text-slate-200">—</span>}
                                            </td>
                                          );
                                        }
                                        const skuVal = v * skuFrac;
                                        return (
                                          <td key={i} className="px-2 py-1 text-right text-[11px] font-mono text-slate-400 whitespace-nowrap">
                                            {skuVal > 0 ? formatCurrency(skuVal) : <span className="text-slate-200">—</span>}
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  ))}
                                  {/* Adhoc period SKU sub-rows — shown in indigo to distinguish from steady-state */}
                                  {adhocSkuRows.map((asr, ai) => (
                                    <tr key={`${row.id}-adhoc-${ai}`} className="border-b border-indigo-100 bg-indigo-50/30">
                                      <td className="pl-8 pr-3 py-1 sticky left-0 z-10 bg-indigo-50/40 border-r border-indigo-100">
                                        <div className="flex items-center gap-1.5">
                                          <span className="text-indigo-300 text-[10px]">⚡</span>
                                          <span className="text-indigo-700 text-[11px] font-medium">{asr.sku}</span>
                                          <span className="text-[10px] text-indigo-500 bg-indigo-100 rounded px-1">{asr.periodLabel}</span>
                                          {asr.dbuPerMonth > 0 && (
                                            <span className="text-[10px] text-indigo-400">{Math.round(asr.dbuPerMonth).toLocaleString()} DBUs/mo</span>
                                          )}
                                          <span className="text-[10px] text-indigo-400">({formatCurrency(asr.dollarPerMonth)}/mo)</span>
                                        </div>
                                      </td>
                                      <td className="px-2 py-1 text-indigo-300 text-[11px]">—</td>
                                      {row.values.map((_, i) => {
                                        const m = i + 1;
                                        if (!asr.monthsSet.has(m)) {
                                          return <td key={i} className="px-2 py-1 text-right text-[11px] font-mono whitespace-nowrap"><span className="text-slate-200">—</span></td>;
                                        }
                                        return (
                                          <td key={i} className="px-2 py-1 text-right text-[11px] font-mono text-indigo-500 whitespace-nowrap">
                                            {viewMode === 'dbu' && asr.dbuPerMonth > 0
                                              ? formatDbu(asr.dbuPerMonth)
                                              : formatCurrency(asr.dollarPerMonth)}
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  ))}
                                </>
                              );
                            })()}
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
                            {viewMode === 'dbu'
                              ? formatDbu(t * (1 / 0.20))
                              : formatCurrency(t)}
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

      {/* Domain Forecast Charts */}
      {!loading && Object.keys(forecastData).length > 0 && (
        <ForecastDomainCharts
          forecastData={forecastData}
          activeAccounts={activeAccounts}
          activeScenario={activeScenario}
          months={months}
        />
      )}
    </div>
  );
}
