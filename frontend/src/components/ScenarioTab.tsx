import React, { useEffect, useState } from 'react';
import { fetchScenario, saveScenario, fetchConsumption, fetchDomainMapping, fetchSkuPrices, formatCurrency } from '../api';

interface Props {
  account: string;
  sheetUrl: string;
}

type RampType = 'linear' | 'hockey_stick';

const TSHIRT_SIZES = [
  { key: 'xs',   label: 'XS',   value: 2500,   desc: 'POC / Experiment' },
  { key: 's',    label: 'S',    value: 5000,   desc: 'Single pipeline or dashboard' },
  { key: 'm',    label: 'M',    value: 15000,  desc: 'Team workload — ETL + BI' },
  { key: 'l',    label: 'L',    value: 35000,  desc: 'Multi-pipeline ETL + ML' },
  { key: 'xl',   label: 'XL',   value: 75000,  desc: 'Department — heavy ETL + ML + BI' },
  { key: 'xxl',  label: 'XXL',  value: 150000, desc: 'Business unit — full platform' },
  { key: 'xxxl', label: 'XXXL', value: 300000, desc: 'Enterprise — org-wide workload' },
] as const;

function getTshirtKey(value: number): string {
  const match = TSHIRT_SIZES.find(s => s.value === value);
  return match ? match.key : 'custom';
}

function fmtShort(v: number): string {
  if (v >= 1000000) return `$${(v/1000000).toFixed(1)}M`;
  if (v >= 1000) return `$${Math.round(v/1000)}K`;
  return `$${v}`;
}

interface SKUAllocation {
  sku: string;        // friendly name
  percentage: number; // 0-100
  dbus: number;       // monthly DBU volume (auto-calc from percentage x total DBUs)
  dollarDbu: number;  // auto-calc: percentage x steadyStateDbu / 100
}

interface NewUseCase {
  id: string;
  domain: string;
  name: string;
  steadyStateDbu: number;  // $/month at full run-rate
  onboardingMonth: number; // 1-36
  liveMonth: number;       // 1-36, must be >= onboarding
  rampType: RampType;
  scenarios: boolean[];    // [scenario1, scenario2, scenario3]
  cloud: string;           // which cloud this use case runs on
  assumptions: string;     // free text per use case
  skuBreakdown: SKUAllocation[];  // per-SKU split
}

interface DomainBaseline {
  domain: string;
  monthlyActuals: Record<string, number>;
  t12m: number;
  t3m: number;
  avgMonthly: number;
}

const WORKLOAD_PRESETS = [
  {
    key: 'etl', label: 'ETL Pipeline',
    skus: [
      { sku: 'Jobs Compute', percentage: 50 },
      { sku: 'Jobs Compute (Photon)', percentage: 30 },
      { sku: 'DLT Core', percentage: 20 },
    ]
  },
  {
    key: 'bi', label: 'BI / Analytics',
    skus: [
      { sku: 'Serverless SQL', percentage: 60 },
      { sku: 'All Purpose Compute', percentage: 25 },
      { sku: 'Jobs Compute', percentage: 15 },
    ]
  },
  {
    key: 'ml', label: 'ML Platform',
    skus: [
      { sku: 'All Purpose Compute', percentage: 35 },
      { sku: 'Model Serving', percentage: 30 },
      { sku: 'Jobs Compute', percentage: 25 },
      { sku: 'Serverless SQL', percentage: 10 },
    ]
  },
  {
    key: 'agentic', label: 'Agentic AI',
    skus: [
      { sku: 'Foundation Model API', percentage: 40 },
      { sku: 'Model Serving', percentage: 25 },
      { sku: 'Vector Search', percentage: 20 },
      { sku: 'Serverless SQL', percentage: 15 },
    ]
  },
  {
    key: 'migration', label: 'Migration Workload',
    skus: [
      { sku: 'Jobs Compute (Photon)', percentage: 45 },
      { sku: 'Serverless SQL', percentage: 30 },
      { sku: 'DLT Advanced', percentage: 25 },
    ]
  },
  {
    key: 'custom', label: 'Custom',
    skus: []
  },
];

function generateId() {
  return Math.random().toString(36).substring(2, 9);
}

// Calculate monthly DBU for a use case based on ramp type
function calcUseCaseMonthly(uc: NewUseCase): number[] {
  const months = new Array(36).fill(0);
  if (uc.steadyStateDbu <= 0 || uc.liveMonth <= uc.onboardingMonth) return months;

  const rampMonths = uc.liveMonth - uc.onboardingMonth;

  for (let i = 0; i < 36; i++) {
    const m = i + 1; // 1-indexed month
    if (m < uc.onboardingMonth) {
      months[i] = 0;
    } else if (m >= uc.liveMonth) {
      months[i] = uc.steadyStateDbu;
    } else {
      // Ramp period
      const progress = (m - uc.onboardingMonth + 1) / (rampMonths + 1);
      if (uc.rampType === 'linear') {
        months[i] = uc.steadyStateDbu * progress;
      } else {
        // Hockey stick: exponential curve -- slow start, fast finish
        months[i] = uc.steadyStateDbu * Math.pow(progress, 2.5);
      }
    }
  }
  return months;
}

// Recalculate SKU breakdown based on steadyStateDbu, percentages, and prices
function recalcSkuBreakdown(
  skuBreakdown: SKUAllocation[],
  steadyStateDbu: number,
  cloud: string,
  skuPriceMap: Record<string, Record<string, number>>
): SKUAllocation[] {
  return skuBreakdown.map(alloc => {
    const dollarDbu = steadyStateDbu * alloc.percentage / 100;
    const price = skuPriceMap[alloc.sku]?.[cloud] || 0;
    const dbus = price > 0 ? dollarDbu / price : 0;
    return { ...alloc, dollarDbu, dbus };
  });
}

export default function ScenarioTab({ account, sheetUrl }: Props) {
  const [scenario, setScenario] = useState(1);
  const [baselineGrowthRate, setBaselineGrowthRate] = useState(2); // % MoM
  const [assumptionsText, setAssumptionsText] = useState('');
  const [newUseCases, setNewUseCases] = useState<NewUseCase[]>([]);
  const [domainBaselines, setDomainBaselines] = useState<DomainBaseline[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expandedBaseline, setExpandedBaseline] = useState(true);
  const [expandedUC, setExpandedUC] = useState<string | null>(null);

  // SKU price data
  const [skuPriceData, setSkuPriceData] = useState<any>(null);

  // Build a lookup: friendly_name -> { cloud -> price }
  const skuPriceMap: Record<string, Record<string, number>> = React.useMemo(() => {
    if (!skuPriceData?.friendly_skus) return {};
    const map: Record<string, Record<string, number>> = {};
    for (const item of skuPriceData.friendly_skus) {
      map[item.friendly_name] = item.clouds;
    }
    return map;
  }, [skuPriceData]);

  const availableClouds: string[] = skuPriceData?.clouds || ['azure', 'aws', 'gcp'];
  const availableSkuNames: string[] = React.useMemo(() => {
    if (!skuPriceData?.friendly_skus) return [];
    return skuPriceData.friendly_skus.map((s: any) => s.friendly_name);
  }, [skuPriceData]);

  // Load SKU prices on mount / account change
  useEffect(() => {
    fetchSkuPrices(account).then(setSkuPriceData).catch(console.error);
  }, [account]);

  const loadScenario = async () => {
    setLoading(true);
    try {
      const data = await fetchScenario(account, scenario);
      setBaselineGrowthRate((data.baseline_growth_rate || 0.02) * 100);
      setAssumptionsText(data.assumptions_text || '');
      // Restore use cases with proper types
      const savedUCs = (data.new_use_cases || []).map((uc: any) => ({
        id: uc.id || generateId(),
        domain: uc.domain || '',
        name: uc.name || '',
        steadyStateDbu: uc.steadyStateDbu || uc.steady_state_dbu || 0,
        onboardingMonth: uc.onboardingMonth || uc.onboarding_month || 1,
        liveMonth: uc.liveMonth || uc.live_month || 6,
        rampType: (uc.rampType || uc.ramp_type || 'linear') as RampType,
        scenarios: uc.scenarios || [true, false, false],
        cloud: uc.cloud || 'azure',
        assumptions: uc.assumptions || '',
        skuBreakdown: (uc.skuBreakdown || uc.sku_breakdown || []).map((s: any) => ({
          sku: s.sku || '',
          percentage: s.percentage || 0,
          dbus: s.dbus || 0,
          dollarDbu: s.dollarDbu || s.dollar_dbu || 0,
        })),
      }));
      setNewUseCases(savedUCs);

      // Load historical consumption as baseline
      let mapping: Record<string, string> = {};
      if (sheetUrl) {
        try {
          const mapRes = await fetchDomainMapping(sheetUrl);
          (mapRes.mapping || []).forEach((r: any) => { mapping[r.workspace] = r.domain; });
        } catch (e) { console.warn('Mapping error:', e); }
      }

      const consumption = await fetchConsumption(account);
      const consumptionData = consumption.data || [];

      const domainMonthly: Record<string, Record<string, number>> = {};
      consumptionData.forEach((row: any) => {
        const ws = row.workspace_name || '';
        const domain = mapping[ws] || 'Unmapped';
        const month = row.month || '';
        const dbu = parseFloat(row.dollar_dbu_list) || 0;
        if (!domainMonthly[domain]) domainMonthly[domain] = {};
        domainMonthly[domain][month] = (domainMonthly[domain][month] || 0) + dbu;
      });

      const baselines: DomainBaseline[] = Object.entries(domainMonthly)
        .map(([domain, monthData]) => {
          const months = Object.keys(monthData).sort();
          const t12m = Object.values(monthData).reduce((s, v) => s + v, 0);
          const last3 = months.slice(-3);
          const t3m = last3.reduce((s, m) => s + (monthData[m] || 0), 0);
          return { domain, monthlyActuals: monthData, t12m, t3m, avgMonthly: t12m / Math.max(months.length, 1) };
        })
        .sort((a, b) => b.t12m - a.t12m);

      setDomainBaselines(baselines);
      setDomains(baselines.map(b => b.domain));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadScenario(); }, [account, scenario, sheetUrl]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await saveScenario({
        scenario_id: scenario,
        account,
        baseline_growth_rate: baselineGrowthRate / 100,
        assumptions_text: assumptionsText,
        new_use_cases: newUseCases,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) { console.error(e); }
    finally { setSaving(false); }
  };

  const addNewUseCase = () => {
    setNewUseCases([...newUseCases, {
      id: generateId(),
      domain: domains[0] || '',
      name: '',
      steadyStateDbu: 0,
      onboardingMonth: 3,
      liveMonth: 8,
      rampType: 'linear',
      scenarios: [scenario === 1, scenario === 2, scenario === 3],
      cloud: availableClouds[0] || 'azure',
      assumptions: '',
      skuBreakdown: [],
    }]);
  };

  const removeNewUseCase = (id: string) => setNewUseCases(newUseCases.filter(uc => uc.id !== id));

  const updateUC = (id: string, updates: Partial<NewUseCase>) => {
    setNewUseCases(prev => prev.map(uc => {
      if (uc.id !== id) return uc;
      const updated = { ...uc, ...updates };
      // Recalc SKU breakdown when steadyStateDbu, cloud, or skuBreakdown percentages change
      if ('steadyStateDbu' in updates || 'cloud' in updates || 'skuBreakdown' in updates) {
        updated.skuBreakdown = recalcSkuBreakdown(
          updated.skuBreakdown,
          updated.steadyStateDbu,
          updated.cloud,
          skuPriceMap
        );
      }
      return updated;
    }));
  };

  const applyWorkloadPreset = (ucId: string, presetKey: string) => {
    const preset = WORKLOAD_PRESETS.find(p => p.key === presetKey);
    if (!preset) return;
    const uc = newUseCases.find(u => u.id === ucId);
    if (!uc) return;

    const breakdown: SKUAllocation[] = preset.skus.map(s => ({
      sku: s.sku,
      percentage: s.percentage,
      dbus: 0,
      dollarDbu: 0,
    }));

    updateUC(ucId, { skuBreakdown: breakdown });
  };

  const addSkuRow = (ucId: string) => {
    const uc = newUseCases.find(u => u.id === ucId);
    if (!uc) return;
    const newRow: SKUAllocation = { sku: availableSkuNames[0] || 'Jobs Compute', percentage: 0, dbus: 0, dollarDbu: 0 };
    updateUC(ucId, { skuBreakdown: [...uc.skuBreakdown, newRow] });
  };

  const removeSkuRow = (ucId: string, idx: number) => {
    const uc = newUseCases.find(u => u.id === ucId);
    if (!uc) return;
    const updated = uc.skuBreakdown.filter((_, i) => i !== idx);
    updateUC(ucId, { skuBreakdown: updated });
  };

  const updateSkuRow = (ucId: string, idx: number, field: 'sku' | 'percentage', value: string | number) => {
    const uc = newUseCases.find(u => u.id === ucId);
    if (!uc) return;
    const updated = uc.skuBreakdown.map((row, i) => {
      if (i !== idx) return row;
      return { ...row, [field]: value };
    });
    updateUC(ucId, { skuBreakdown: updated });
  };

  // Filter use cases for current scenario
  const activeUseCases = newUseCases.filter(uc => uc.scenarios[scenario - 1]);

  // Projections
  const projections = React.useMemo(() => {
    const momRate = baselineGrowthRate / 100 / 12;
    const totalBaselineMonthly = domainBaselines.reduce((s, b) => s + b.avgMonthly, 0);

    // Baseline projection (all historical consumption with growth)
    const baselineMonths = new Array(36).fill(0);
    for (let i = 0; i < 36; i++) {
      baselineMonths[i] = totalBaselineMonthly * Math.pow(1 + momRate, i + 1);
    }

    // New use case projections (only for current scenario)
    const ucMonths = new Array(36).fill(0);
    activeUseCases.forEach(uc => {
      const ucM = calcUseCaseMonthly(uc);
      for (let i = 0; i < 36; i++) ucMonths[i] += ucM[i];
    });

    // Totals
    const totalMonths = baselineMonths.map((b, i) => b + ucMonths[i]);
    const yearTotals = [0, 0, 0];
    const baseYearTotals = [0, 0, 0];
    const ucYearTotals = [0, 0, 0];
    for (let i = 0; i < 36; i++) {
      const y = Math.floor(i / 12);
      yearTotals[y] += totalMonths[i];
      baseYearTotals[y] += baselineMonths[i];
      ucYearTotals[y] += ucMonths[i];
    }

    return { baselineMonths, ucMonths, totalMonths, yearTotals, baseYearTotals, ucYearTotals };
  }, [domainBaselines, baselineGrowthRate, activeUseCases]);

  const totalBaseline = domainBaselines.reduce((s, b) => s + b.t12m, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {[1, 2, 3].map((s) => (
            <button key={s} onClick={() => setScenario(s)}
              className={`px-4 py-2 rounded-md text-sm font-medium ${
                scenario === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}>
              Scenario {s}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {saved && <span className="text-green-600 text-sm font-medium">Saved!</span>}
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50">
            {saving ? 'Saving...' : 'Save Scenario'}
          </button>
        </div>
      </div>

      {loading && <div className="text-center py-8 text-gray-500">Loading historical baseline + scenario...</div>}

      {!loading && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-5 gap-4">
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-[10px] text-gray-500 uppercase">T12M Baseline</div>
              <div className="text-lg font-bold text-gray-900 mt-1">{formatCurrency(totalBaseline)}</div>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-[10px] text-gray-500 uppercase">Year 1 Projected</div>
              <div className="text-lg font-bold text-blue-600 mt-1">{formatCurrency(projections.yearTotals[0])}</div>
              <div className="text-[10px] text-gray-400">Base: {formatCurrency(projections.baseYearTotals[0])} + UC: {formatCurrency(projections.ucYearTotals[0])}</div>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-[10px] text-gray-500 uppercase">Year 2 Projected</div>
              <div className="text-lg font-bold text-blue-600 mt-1">{formatCurrency(projections.yearTotals[1])}</div>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-[10px] text-gray-500 uppercase">Year 3 Projected</div>
              <div className="text-lg font-bold text-blue-600 mt-1">{formatCurrency(projections.yearTotals[2])}</div>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-[10px] text-gray-500 uppercase">3-Year Total</div>
              <div className="text-lg font-bold text-purple-600 mt-1">{formatCurrency(projections.yearTotals.reduce((a, b) => a + b, 0))}</div>
            </div>
          </div>

          {/* Baseline + Growth Config */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Baseline */}
            <div className="bg-white rounded-lg shadow">
              <button onClick={() => setExpandedBaseline(!expandedBaseline)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50">
                <h3 className="text-sm font-semibold text-gray-700">
                  Historical Baseline ({domainBaselines.length} domains, {formatCurrency(totalBaseline)} T12M)
                </h3>
                <svg className={`w-4 h-4 text-gray-400 transition-transform ${expandedBaseline ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {expandedBaseline && (
                <div className="border-t overflow-auto max-h-72">
                  <table className="w-full text-xs">
                    <thead><tr className="bg-gray-50">
                      <th className="px-3 py-2 text-left">Domain</th>
                      <th className="px-3 py-2 text-right">T12M</th>
                      <th className="px-3 py-2 text-right">Avg/Mo</th>
                      <th className="px-3 py-2 text-right">%</th>
                    </tr></thead>
                    <tbody>
                      {domainBaselines.map(b => (
                        <tr key={b.domain} className="border-t hover:bg-gray-50">
                          <td className="px-3 py-1 font-medium">{b.domain}</td>
                          <td className="px-3 py-1 text-right">{formatCurrency(b.t12m)}</td>
                          <td className="px-3 py-1 text-right">{formatCurrency(b.avgMonthly)}</td>
                          <td className="px-3 py-1 text-right">{((b.t12m / totalBaseline) * 100).toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Growth + Assumptions */}
            <div className="bg-white rounded-lg shadow p-4 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Baseline Growth Rate (Applied to All Historical Consumption)</h3>
                <div className="flex items-center gap-3">
                  <input type="number" step="0.5" value={baselineGrowthRate}
                    onChange={(e) => setBaselineGrowthRate(parseFloat(e.target.value) || 0)}
                    className="w-20 border border-gray-300 rounded px-2 py-1.5 text-sm text-right" />
                  <span className="text-sm text-gray-500">% MoM</span>
                  <span className="text-xs text-gray-400">
                    = {((Math.pow(1 + baselineGrowthRate / 100 / 12, 12) - 1) * 100).toFixed(1)}% annual
                  </span>
                </div>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Assumptions</h3>
                <textarea value={assumptionsText} onChange={(e) => setAssumptionsText(e.target.value)} rows={4}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  placeholder="e.g., 2% MoM organic growth from data volume increase, new workloads ramping Q2..." />
              </div>
            </div>
          </div>

          {/* New Use Cases */}
          <div className="bg-white rounded-lg shadow">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h3 className="text-sm font-semibold text-gray-700">
                New Use Cases ({activeUseCases.length} active in Scenario {scenario}, {newUseCases.length} total)
              </h3>
              <button onClick={addNewUseCase} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
                + Add Use Case
              </button>
            </div>

            {newUseCases.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-400">No use cases added yet. Click "+ Add Use Case" to project incremental workloads.</div>
            ) : (
              <div className="divide-y">
                {newUseCases.map((uc) => {
                  const isActive = uc.scenarios[scenario - 1];
                  const isExpanded = expandedUC === uc.id;
                  const ucMonthly = calcUseCaseMonthly(uc);
                  const ucYearTotals = [0, 0, 0];
                  ucMonthly.forEach((v, i) => { ucYearTotals[Math.floor(i / 12)] += v; });

                  return (
                    <div key={uc.id} className={`${isActive ? '' : 'opacity-50'}`}>
                      {/* Use Case Header */}
                      <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer"
                        onClick={() => setExpandedUC(isExpanded ? null : uc.id)}>
                        <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
                          fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-gray-900">{uc.name || 'Unnamed Use Case'}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{uc.domain}</span>
                            {uc.cloud && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">{uc.cloud}</span>}
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                              uc.rampType === 'hockey_stick' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'
                            }`}>{uc.rampType === 'hockey_stick' ? 'Hockey Stick' : 'Linear'} ramp</span>
                            {uc.scenarios.map((on, i) => on && (
                              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700">S{i + 1}</span>
                            ))}
                          </div>
                          <div className="text-xs text-gray-400 mt-0.5">
                            {formatCurrency(uc.steadyStateDbu)}/mo steady state | Onboard M{uc.onboardingMonth} {'>'} Live M{uc.liveMonth} |
                            Y1: {formatCurrency(ucYearTotals[0])} | Y2: {formatCurrency(ucYearTotals[1])} | Y3: {formatCurrency(ucYearTotals[2])}
                            {uc.skuBreakdown.length > 0 && ` | ${uc.skuBreakdown.length} SKUs`}
                          </div>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); removeNewUseCase(uc.id); }}
                          className="text-red-400 hover:text-red-600 text-xs flex-shrink-0">Remove</button>
                      </div>

                      {/* Expanded Form */}
                      {isExpanded && (
                        <div className="px-4 pb-4 pt-0 ml-8 space-y-4">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Use Case Name</label>
                              <input value={uc.name} onChange={(e) => updateUC(uc.id, { name: e.target.value })}
                                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" placeholder="e.g., Informatica Migration" />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Domain</label>
                              <select value={uc.domain} onChange={(e) => updateUC(uc.id, { domain: e.target.value })}
                                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm">
                                {domains.map(d => <option key={d} value={d}>{d}</option>)}
                              </select>
                            </div>
                            <div className="col-span-2 md:col-span-4">
                              <label className="block text-xs font-medium text-gray-600 mb-1.5">Steady-State Size</label>
                              <div className="flex flex-wrap gap-1.5">
                                {TSHIRT_SIZES.map((size) => {
                                  const isSelected = getTshirtKey(uc.steadyStateDbu) === size.key;
                                  return (
                                    <button key={size.key}
                                      onClick={() => updateUC(uc.id, { steadyStateDbu: size.value })}
                                      className={`flex flex-col items-center px-2.5 py-1.5 rounded-lg border text-center transition-all min-w-[72px] ${
                                        isSelected
                                          ? 'bg-blue-50 border-blue-400 ring-1 ring-blue-200'
                                          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                                      }`}>
                                      <span className={`text-xs font-bold ${isSelected ? 'text-blue-700' : 'text-gray-700'}`}>{size.label}</span>
                                      <span className={`text-[10px] font-medium ${isSelected ? 'text-blue-600' : 'text-gray-500'}`}>{fmtShort(size.value)}/mo</span>
                                      <span className={`text-[9px] ${isSelected ? 'text-blue-400' : 'text-gray-400'}`}>{fmtShort(size.value * 12)}/yr</span>
                                    </button>
                                  );
                                })}
                                {/* Custom option */}
                                <button
                                  onClick={() => {
                                    if (getTshirtKey(uc.steadyStateDbu) !== 'custom') updateUC(uc.id, { steadyStateDbu: 0 });
                                  }}
                                  className={`flex flex-col items-center px-2.5 py-1.5 rounded-lg border text-center transition-all min-w-[72px] ${
                                    getTshirtKey(uc.steadyStateDbu) === 'custom'
                                      ? 'bg-purple-50 border-purple-400 ring-1 ring-purple-200'
                                      : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                                  }`}>
                                  <span className={`text-xs font-bold ${getTshirtKey(uc.steadyStateDbu) === 'custom' ? 'text-purple-700' : 'text-gray-700'}`}>Custom</span>
                                  <span className={`text-[10px] ${getTshirtKey(uc.steadyStateDbu) === 'custom' ? 'text-purple-500' : 'text-gray-400'}`}>Enter value</span>
                                </button>
                              </div>
                              {/* Custom value input or selected summary */}
                              <div className="mt-2 flex items-center gap-3">
                                {getTshirtKey(uc.steadyStateDbu) === 'custom' ? (
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-gray-500">$</span>
                                    <input type="number" value={uc.steadyStateDbu || ''}
                                      onChange={(e) => updateUC(uc.id, { steadyStateDbu: parseFloat(e.target.value) || 0 })}
                                      className="w-32 border border-purple-300 rounded px-2 py-1 text-sm text-right bg-purple-50"
                                      placeholder="Enter $/month" />
                                    <span className="text-xs text-gray-500">/month</span>
                                    {uc.steadyStateDbu > 0 && (
                                      <span className="text-xs text-gray-400">= {fmtShort(uc.steadyStateDbu * 12)}/yr</span>
                                    )}
                                  </div>
                                ) : (
                                  <div className="text-xs text-gray-500">
                                    {formatCurrency(uc.steadyStateDbu)}/month {'>'} {fmtShort(uc.steadyStateDbu * 12)}/year
                                    <span className="text-gray-400 ml-2">
                                      ({TSHIRT_SIZES.find(s => s.value === uc.steadyStateDbu)?.desc})
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Ramp Pattern</label>
                              <div className="flex gap-2 mt-1">
                                <button onClick={() => updateUC(uc.id, { rampType: 'linear' })}
                                  className={`flex-1 px-2 py-1.5 text-xs rounded border ${
                                    uc.rampType === 'linear' ? 'bg-blue-50 border-blue-300 text-blue-700 font-medium' : 'border-gray-200 text-gray-500'
                                  }`}>Linear</button>
                                <button onClick={() => updateUC(uc.id, { rampType: 'hockey_stick' })}
                                  className={`flex-1 px-2 py-1.5 text-xs rounded border ${
                                    uc.rampType === 'hockey_stick' ? 'bg-orange-50 border-orange-300 text-orange-700 font-medium' : 'border-gray-200 text-gray-500'
                                  }`}>Hockey Stick</button>
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Onboarding Month</label>
                              <select value={uc.onboardingMonth} onChange={(e) => updateUC(uc.id, { onboardingMonth: parseInt(e.target.value) })}
                                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm">
                                {Array.from({ length: 36 }, (_, i) => (
                                  <option key={i + 1} value={i + 1}>Month {i + 1} (Y{Math.floor(i / 12) + 1})</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Live Month (Steady State)</label>
                              <select value={uc.liveMonth} onChange={(e) => updateUC(uc.id, { liveMonth: parseInt(e.target.value) })}
                                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm">
                                {Array.from({ length: 36 }, (_, i) => (
                                  <option key={i + 1} value={i + 1} disabled={i + 1 <= uc.onboardingMonth}>
                                    Month {i + 1} (Y{Math.floor(i / 12) + 1})
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="col-span-2">
                              <label className="block text-xs font-medium text-gray-600 mb-1">Include in Scenarios</label>
                              <div className="flex gap-4 mt-1">
                                {[0, 1, 2].map(i => (
                                  <label key={i} className="flex items-center gap-1.5 cursor-pointer">
                                    <input type="checkbox" checked={uc.scenarios[i]}
                                      onChange={(e) => {
                                        const s = [...uc.scenarios];
                                        s[i] = e.target.checked;
                                        updateUC(uc.id, { scenarios: s });
                                      }}
                                      className="w-3.5 h-3.5 text-blue-600 border-gray-300 rounded" />
                                    <span className="text-xs text-gray-600">Scenario {i + 1}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                          </div>

                          {/* Cloud Selector */}
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1.5">Cloud</label>
                            <div className="flex gap-2">
                              {availableClouds.map(c => (
                                <button key={c} onClick={() => updateUC(uc.id, { cloud: c })}
                                  className={`px-3 py-1.5 text-xs rounded border capitalize ${
                                    uc.cloud === c
                                      ? 'bg-indigo-50 border-indigo-400 text-indigo-700 font-medium ring-1 ring-indigo-200'
                                      : 'border-gray-200 text-gray-500 hover:border-gray-300'
                                  }`}>
                                  {c.toUpperCase()}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* Workload Type Presets */}
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1.5">Workload Type</label>
                            <div className="flex flex-wrap gap-1.5">
                              {WORKLOAD_PRESETS.map(preset => (
                                <button key={preset.key}
                                  onClick={() => applyWorkloadPreset(uc.id, preset.key)}
                                  className="px-3 py-1.5 text-xs rounded border border-gray-200 text-gray-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors">
                                  {preset.label}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* SKU Breakdown Table */}
                          {uc.skuBreakdown.length > 0 && (
                            <div className="border rounded-lg overflow-hidden">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="bg-gray-50">
                                    <th className="px-3 py-2 text-left font-medium text-gray-600">SKU</th>
                                    <th className="px-3 py-2 text-right font-medium text-gray-600 w-20">% Split</th>
                                    <th className="px-3 py-2 text-right font-medium text-gray-600">DBUs/month</th>
                                    <th className="px-3 py-2 text-right font-medium text-gray-600">$/DBU (list)</th>
                                    <th className="px-3 py-2 text-right font-medium text-gray-600">$/month</th>
                                    <th className="px-3 py-2 w-8"></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {uc.skuBreakdown.map((alloc, idx) => {
                                    const price = skuPriceMap[alloc.sku]?.[uc.cloud] || 0;
                                    return (
                                      <tr key={idx} className="border-t hover:bg-gray-50">
                                        <td className="px-3 py-1.5">
                                          <select value={alloc.sku}
                                            onChange={(e) => updateSkuRow(uc.id, idx, 'sku', e.target.value)}
                                            className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs">
                                            {availableSkuNames.length > 0
                                              ? availableSkuNames.map(name => (
                                                  <option key={name} value={name}>{name}</option>
                                                ))
                                              : /* Fallback: show common SKU names when price data not loaded */
                                                ['All Purpose Compute', 'All Purpose Compute (Photon)', 'Jobs Compute',
                                                 'Jobs Compute (Photon)', 'Serverless Jobs', 'SQL Warehouse',
                                                 'Serverless SQL', 'DLT Core', 'DLT Core (Photon)', 'DLT Advanced',
                                                 'DLT Advanced (Photon)', 'DLT Pro', 'Model Serving',
                                                 'Serverless Inference', 'Foundation Model API', 'Vector Search',
                                                ].map(name => (
                                                  <option key={name} value={name}>{name}</option>
                                                ))
                                            }
                                          </select>
                                        </td>
                                        <td className="px-3 py-1.5 text-right">
                                          <div className="flex items-center justify-end gap-1">
                                            <input type="number" min={0} max={100} value={alloc.percentage}
                                              onChange={(e) => updateSkuRow(uc.id, idx, 'percentage', parseFloat(e.target.value) || 0)}
                                              className="w-14 border border-gray-200 rounded px-1.5 py-1 text-xs text-right" />
                                            <span className="text-gray-400">%</span>
                                          </div>
                                        </td>
                                        <td className="px-3 py-1.5 text-right text-gray-700">
                                          {alloc.dbus > 0 ? Math.round(alloc.dbus).toLocaleString() : '-'}
                                        </td>
                                        <td className="px-3 py-1.5 text-right text-gray-500">
                                          {price > 0 ? `$${price.toFixed(2)}` : '-'}
                                        </td>
                                        <td className="px-3 py-1.5 text-right font-medium text-gray-900">
                                          {alloc.dollarDbu > 0 ? formatCurrency(alloc.dollarDbu) : '-'}
                                        </td>
                                        <td className="px-1 py-1.5 text-center">
                                          <button onClick={() => removeSkuRow(uc.id, idx)}
                                            className="text-red-300 hover:text-red-500 text-[10px]">x</button>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                  {/* Total row */}
                                  <tr className="border-t-2 border-gray-300 bg-gray-50 font-medium">
                                    <td className="px-3 py-2 text-gray-700">Total</td>
                                    <td className="px-3 py-2 text-right">
                                      <span className={uc.skuBreakdown.reduce((s, a) => s + a.percentage, 0) === 100
                                        ? 'text-green-600' : 'text-red-500'}>
                                        {uc.skuBreakdown.reduce((s, a) => s + a.percentage, 0)}%
                                      </span>
                                    </td>
                                    <td className="px-3 py-2 text-right text-gray-700">
                                      {Math.round(uc.skuBreakdown.reduce((s, a) => s + a.dbus, 0)).toLocaleString()}
                                    </td>
                                    <td className="px-3 py-2 text-right text-gray-500">
                                      {(() => {
                                        const totalDollar = uc.skuBreakdown.reduce((s, a) => s + a.dollarDbu, 0);
                                        const totalDbus = uc.skuBreakdown.reduce((s, a) => s + a.dbus, 0);
                                        const avg = totalDbus > 0 ? totalDollar / totalDbus : 0;
                                        return avg > 0 ? `avg $${avg.toFixed(2)}` : '-';
                                      })()}
                                    </td>
                                    <td className="px-3 py-2 text-right font-bold text-gray-900">
                                      {formatCurrency(uc.skuBreakdown.reduce((s, a) => s + a.dollarDbu, 0))}
                                    </td>
                                    <td></td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          )}

                          <button onClick={() => addSkuRow(uc.id)}
                            className="text-xs text-blue-600 hover:text-blue-800 font-medium">
                            + Add SKU Row
                          </button>

                          {/* Per-use-case Assumptions */}
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Use Case Assumptions</label>
                            <textarea value={uc.assumptions || ''}
                              onChange={(e) => updateUC(uc.id, { assumptions: e.target.value })}
                              rows={2}
                              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                              placeholder="e.g., Migrating 50 Informatica jobs, expected 10TB daily ingestion..." />
                          </div>

                          {/* Ramp Preview */}
                          <div className="bg-gray-50 rounded-lg p-3">
                            <div className="text-[10px] font-medium text-gray-500 uppercase mb-2">Monthly Ramp Preview</div>
                            <div className="flex items-end gap-px h-16">
                              {ucMonthly.slice(0, 36).map((v, i) => {
                                const maxVal = Math.max(...ucMonthly, 1);
                                const pct = (v / maxVal) * 100;
                                const isOnboard = i + 1 === uc.onboardingMonth;
                                const isLive = i + 1 === uc.liveMonth;
                                return (
                                  <div key={i} className="flex-1 flex flex-col items-center" title={`M${i + 1}: ${formatCurrency(v)}`}>
                                    <div
                                      className={`w-full rounded-t-sm ${
                                        v === 0 ? 'bg-gray-200' :
                                        i + 1 >= uc.liveMonth ? 'bg-green-400' :
                                        uc.rampType === 'hockey_stick' ? 'bg-orange-400' : 'bg-blue-400'
                                      }`}
                                      style={{ height: `${Math.max(pct, 2)}%` }}
                                    />
                                    {(isOnboard || isLive || (i + 1) % 6 === 1) && (
                                      <span className={`text-[7px] mt-0.5 ${isOnboard || isLive ? 'font-bold text-gray-700' : 'text-gray-400'}`}>
                                        {isOnboard ? '^' : isLive ? 'o' : `M${i + 1}`}
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                            <div className="flex justify-between text-[9px] text-gray-400 mt-1">
                              <span>^ Onboard (M{uc.onboardingMonth})</span>
                              <span>o Live (M{uc.liveMonth}): {formatCurrency(uc.steadyStateDbu)}/mo</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Projection Summary */}
          <div className="bg-white rounded-lg shadow overflow-auto">
            <div className="px-4 py-3 bg-gray-50 border-b">
              <h3 className="text-sm font-semibold text-gray-700">Scenario {scenario} -- 3-Year Projection</h3>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50">
                  <th className="px-3 py-2 text-left font-medium text-gray-600 sticky left-0 bg-gray-50 min-w-[140px]">Category</th>
                  <th className="px-3 py-2 text-right font-medium text-blue-600 bg-blue-50">Year 1</th>
                  <th className="px-3 py-2 text-right font-medium text-blue-600 bg-blue-50">Year 2</th>
                  <th className="px-3 py-2 text-right font-medium text-blue-600 bg-blue-50">Year 3</th>
                  <th className="px-3 py-2 text-right font-medium text-purple-600 bg-purple-50">Total</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium sticky left-0 bg-white">Existing Baseline (with {baselineGrowthRate}% MoM growth)</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(projections.baseYearTotals[0])}</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(projections.baseYearTotals[1])}</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(projections.baseYearTotals[2])}</td>
                  <td className="px-3 py-2 text-right font-medium bg-gray-50">{formatCurrency(projections.baseYearTotals.reduce((a, b) => a + b, 0))}</td>
                </tr>
                {activeUseCases.map(uc => {
                  const ucM = calcUseCaseMonthly(uc);
                  const yT = [0, 0, 0];
                  ucM.forEach((v, i) => { yT[Math.floor(i / 12)] += v; });
                  return (
                    <tr key={uc.id} className="border-t hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-700 sticky left-0 bg-white pl-6">{'>'} {uc.name || 'Unnamed'}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(yT[0])}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(yT[1])}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(yT[2])}</td>
                      <td className="px-3 py-2 text-right bg-gray-50">{formatCurrency(yT.reduce((a, b) => a + b, 0))}</td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-gray-300 bg-blue-50 font-bold">
                  <td className="px-3 py-2 sticky left-0 bg-blue-50">Grand Total</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(projections.yearTotals[0])}</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(projections.yearTotals[1])}</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(projections.yearTotals[2])}</td>
                  <td className="px-3 py-2 text-right bg-purple-100">{formatCurrency(projections.yearTotals.reduce((a, b) => a + b, 0))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
