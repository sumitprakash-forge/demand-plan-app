import React, { useEffect, useState } from 'react';
import { fetchScenario, saveScenario, fetchConsumption, fetchDomainMap, fetchSkuPrices, formatCurrency, ConflictError } from '../api';
import type { AccountConfig } from '../App';

interface Props {
  accounts: AccountConfig[];
}

interface InnerProps {
  account: string;
  contractStartDate?: string;
  contractMonths?: number;
}

const MONTH_NAMES_S = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

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
  return `${mLabel} (${MONTH_NAMES_S[calMonth - 1]}'${String(calYear).slice(2)})`;
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
  sku: string;        // friendly name (or '__custom__' sentinel while editing)
  percentage: number; // 0-100
  dbus: number;       // monthly DBU volume (auto-calc from percentage x total DBUs)
  dollarDbu: number;  // auto-calc: percentage x steadyStateDbu / 100
  overridePrice?: number; // set when SKU is not in price list — user-defined $/DBU
}

interface AdhocUsagePeriod {
  id: string;
  label: string;         // e.g., "Development Phase", "Pilot Acceleration"
  months: number[];      // 1-indexed selected months where this extra usage applies
  skuAmounts: { sku: string; dbuPerMonth: number; dollarPerMonth: number; customDbuRate?: number }[];  // per-SKU additional DBUs/month; dollarPerMonth is computed
}

interface NewUseCase {
  id: string;
  domain: string;
  name: string;
  steadyStateDbu: number;  // $/month at full run-rate (or $/month uplift when upliftOnly=true)
  onboardingMonth: number; // 1-36
  liveMonth: number;       // 1-36, must be >= onboarding
  rampType: RampType;
  scenarios: boolean[];    // [scenario1, scenario2, scenario3]
  cloud: string;           // which cloud this use case runs on
  description: string;     // what this use case is / business context
  assumptions: string;     // caveats, dependencies, notes
  skuBreakdown: SKUAllocation[];  // per-SKU split
  upliftOnly: boolean;     // true = dollar uplift only (e.g. Serverless migration), no new DBUs
  adhocPeriods: AdhocUsagePeriod[];  // development phase / one-time bursts on top of steady-state
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

// Calculate monthly $/month for a use case based on ramp type + adhoc periods
function calcUseCaseMonthly(uc: NewUseCase, totalMonths = 36): number[] {
  const months = new Array(totalMonths).fill(0);
  if (uc.steadyStateDbu <= 0 || uc.liveMonth <= uc.onboardingMonth) return months;

  const rampMonths = uc.liveMonth - uc.onboardingMonth;

  for (let i = 0; i < totalMonths; i++) {
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
    // Add adhoc usage for this month (development phase / acceleration bursts)
    if (uc.adhocPeriods?.length) {
      for (const period of uc.adhocPeriods) {
        if (period.months.includes(m)) {
          const adhocTotal = period.skuAmounts.reduce((s, sa) => s + (sa.dollarPerMonth || 0), 0);
          months[i] += adhocTotal;
        }
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
  skuPriceMap: Record<string, Record<string, number>>,
  upliftOnly: boolean = false
): SKUAllocation[] {
  return skuBreakdown.map(alloc => {
    const dollarDbu = steadyStateDbu * alloc.percentage / 100;
    const price = alloc.overridePrice ?? skuPriceMap[alloc.sku]?.[cloud] ?? 0;
    // upliftOnly = price tier / Serverless migration — dollar impact is real but DBU count is 0
    const dbus = upliftOnly ? 0 : (price > 0 ? dollarDbu / price : 0);
    return { ...alloc, dollarDbu, dbus };
  });
}

function ScenarioAccountView({ account, contractStartDate, contractMonths = 36 }: InnerProps) {
  const [scenario, setScenario] = useState(1);
  const [baselineGrowthRate, setBaselineGrowthRate] = useState(2); // % MoM
  const [assumptionsText, setAssumptionsText] = useState('');
  const [newUseCases, setNewUseCases] = useState<NewUseCase[]>([]);
  const [domainBaselines, setDomainBaselines] = useState<DomainBaseline[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  const [conflictError, setConflictError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expandedBaseline, setExpandedBaseline] = useState(true);
  const [expandedOverrides, setExpandedOverrides] = useState(false);
  const [baselineOverrides, setBaselineOverrides] = useState<Record<number, number>>({}); // monthIndex(0-35) -> value
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

  const parseUCs = (raw: any[]): NewUseCase[] => raw.map((uc: any) => ({
    id: uc.id || generateId(),
    domain: uc.domain || '',
    name: uc.name || '',
    steadyStateDbu: uc.steadyStateDbu || uc.steady_state_dbu || 0,
    onboardingMonth: uc.onboardingMonth || uc.onboarding_month || 1,
    liveMonth: uc.liveMonth || uc.live_month || 6,
    rampType: (uc.rampType || uc.ramp_type || 'linear') as RampType,
    scenarios: uc.scenarios || [true, false, false],
    cloud: uc.cloud || 'azure',
    description: uc.description || '',
    assumptions: uc.assumptions || '',
    upliftOnly: uc.upliftOnly ?? uc.uplift_only ?? false,
    skuBreakdown: (uc.skuBreakdown || uc.sku_breakdown || []).map((s: any) => ({
      sku: s.sku || '',
      percentage: s.percentage || 0,
      dbus: s.dbus || 0,
      dollarDbu: s.dollarDbu || s.dollar_dbu || 0,
      overridePrice: s.overridePrice ?? s.override_price ?? undefined,
    })),
    adhocPeriods: (uc.adhocPeriods || uc.adhoc_periods || []).map((p: any) => ({
      id: p.id || generateId(),
      label: p.label || 'Development Phase',
      months: p.months || [],
      skuAmounts: (p.skuAmounts || p.sku_amounts || []).map((sa: any) => ({
        sku: sa.sku || '',
        dbuPerMonth: sa.dbuPerMonth || sa.dbu_per_month || 0,
        dollarPerMonth: sa.dollarPerMonth || sa.dollar_per_month || 0,
        customDbuRate: sa.customDbuRate ?? sa.custom_dbu_rate ?? undefined,
      })),
    })),
  }));

  // Full load: use cases + consumption baseline. Called when account changes.
  const loadFull = async () => {
    setLoading(true);
    try {
      // Load the current scenario's use cases (each scenario maintains its own list)
      const data = await fetchScenario(account, scenario);
      setBaselineGrowthRate((data.baseline_growth_rate || 0.02) * 100);
      setAssumptionsText(data.assumptions_text || '');
      setNewUseCases(parseUCs(data.new_use_cases || []));
      const ovMap: Record<number, number> = {};
      (data.baseline_overrides || []).forEach((o: any) => { ovMap[o.month_index] = o.value; });
      setBaselineOverrides(ovMap);
      setVersion(data.version || 0);
      setIsDirty(false);

      // Load historical consumption as baseline
      let mapping: Record<string, string> = {};
      try {
        const mapRes = await fetchDomainMap(account);
        (mapRes.mapping || []).forEach((r: any) => { mapping[r.workspace] = r.domain; });
      } catch (e) { console.warn('Mapping error:', e); }
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

  // Scenario-only switch: reload growth rate + assumptions for the new scenario,
  // but KEEP current use cases in memory (they are shared across scenarios).
  const loadScenarioSettings = async (s: number, currentUCs: NewUseCase[]) => {
    try {
      const data = await fetchScenario(account, s);
      setBaselineGrowthRate((data.baseline_growth_rate || 0.02) * 100);
      setAssumptionsText(data.assumptions_text || '');
      const ovMap: Record<number, number> = {};
      (data.baseline_overrides || []).forEach((o: any) => { ovMap[o.month_index] = o.value; });
      setBaselineOverrides(ovMap);
      setVersion(data.version || 0);
      // If the new scenario has no use cases saved yet, propagate current ones to it
      if ((data.new_use_cases || []).length === 0 && currentUCs.length > 0) {
        const res = await saveScenario({ scenario_id: s, account, baseline_growth_rate: (data.baseline_growth_rate || 0.02), assumptions_text: data.assumptions_text || '', new_use_cases: currentUCs, version: data.version || 0 });
        setVersion(res.version);
      }
    } catch (e) {
      if (e instanceof ConflictError) setConflictError(true);
      else console.error(e);
    }
  };

  useEffect(() => { loadFull(); }, [account]);

  const handleScenarioSwitch = async (s: number) => {
    if (s === scenario) return;
    // Auto-save current use cases before switching — skip if still loading to avoid wiping data
    if (!loading) {
      try {
        const overridesArr = Object.entries(baselineOverrides).map(([k, v]) => ({ month_index: Number(k), value: v }));
      const res = await saveScenario({ scenario_id: scenario, account, baseline_growth_rate: baselineGrowthRate / 100, assumptions_text: assumptionsText, new_use_cases: newUseCases, baseline_overrides: overridesArr, version });
        setVersion(res.version);
      } catch (e) {
        if (e instanceof ConflictError) { setConflictError(true); return; }
        console.error(e);
      }
    }
    setScenario(s);
    await loadScenarioSettings(s, newUseCases);
    setIsDirty(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const overridesArr = Object.entries(baselineOverrides).map(([k, v]) => ({ month_index: Number(k), value: v }));
      // Save current scenario
      const res = await saveScenario({ scenario_id: scenario, account, baseline_growth_rate: baselineGrowthRate / 100, assumptions_text: assumptionsText, new_use_cases: newUseCases, baseline_overrides: overridesArr, version });
      setVersion(res.version);

      // Propagate updated UC list to the other 2 scenario files so all scenarios stay in sync.
      // Use cases are shared across S1/S2/S3 — only the scenarios[] flag differs per UC.
      // Each file keeps its own baseline_growth_rate / assumptions_text / baseline_overrides.
      const otherScenarios = ([1, 2, 3] as const).filter(s => s !== scenario);
      await Promise.all(otherScenarios.map(async (s) => {
        try {
          const other = await fetchScenario(account, s);
          await saveScenario({
            scenario_id: s, account,
            baseline_growth_rate: other.baseline_growth_rate ?? 0.02,
            assumptions_text: other.assumptions_text ?? '',
            new_use_cases: newUseCases,
            baseline_overrides: other.baseline_overrides ?? [],
            version: other.version ?? 0,
          });
        } catch (e) {
          // Don't block the primary save if a sibling scenario fails
          console.warn(`Could not sync UCs to scenario ${s}:`, e);
        }
      }));

      setSaved(true);
      setIsDirty(false);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      if (e instanceof ConflictError) setConflictError(true);
      else console.error(e);
    } finally { setSaving(false); }
  };

  const addNewUseCase = () => {
    setIsDirty(true);
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
      description: '',
      assumptions: '',
      upliftOnly: false,
      skuBreakdown: [],
      adhocPeriods: [],
    }]);
  };

  const removeNewUseCase = async (id: string) => {
    const updated = newUseCases.filter(uc => uc.id !== id);
    setNewUseCases(updated);
    setIsDirty(false);
    // Auto-save immediately so dependent tabs see the removal — sync all 3 scenario files
    try {
      const overridesArr = Object.entries(baselineOverrides).map(([k, v]) => ({ month_index: Number(k), value: v }));
      const res = await saveScenario({ scenario_id: scenario, account, baseline_growth_rate: baselineGrowthRate / 100, assumptions_text: assumptionsText, new_use_cases: updated, baseline_overrides: overridesArr, version });
      setVersion(res.version);
      // Propagate to sibling scenarios
      const others = ([1, 2, 3] as const).filter(s => s !== scenario);
      await Promise.all(others.map(async (s) => {
        try {
          const other = await fetchScenario(account, s);
          await saveScenario({ scenario_id: s, account, baseline_growth_rate: other.baseline_growth_rate ?? 0.02, assumptions_text: other.assumptions_text ?? '', new_use_cases: updated, baseline_overrides: other.baseline_overrides ?? [], version: other.version ?? 0 });
        } catch (e) { console.warn(`Could not sync UC removal to scenario ${s}:`, e); }
      }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      if (e instanceof ConflictError) setConflictError(true);
      else console.error('Auto-save after UC delete failed:', e);
    }
  };

  const updateUC = (id: string, updates: Partial<NewUseCase>) => {
    setIsDirty(true);
    setNewUseCases(prev => prev.map(uc => {
      if (uc.id !== id) return uc;
      const updated = { ...uc, ...updates };
      // Recalc SKU breakdown when steadyStateDbu, cloud, skuBreakdown percentages, or upliftOnly changes
      if ('steadyStateDbu' in updates || 'cloud' in updates || 'skuBreakdown' in updates || 'upliftOnly' in updates) {
        updated.skuBreakdown = recalcSkuBreakdown(
          updated.skuBreakdown,
          updated.steadyStateDbu,
          updated.cloud,
          skuPriceMap,
          updated.upliftOnly
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
    const newRow: SKUAllocation = { sku: availableSkuNames[0] || 'Jobs Compute', percentage: 0, dbus: 0, dollarDbu: 0, overridePrice: undefined };
    updateUC(ucId, { skuBreakdown: [...uc.skuBreakdown, newRow] });
  };

  const removeSkuRow = (ucId: string, idx: number) => {
    const uc = newUseCases.find(u => u.id === ucId);
    if (!uc) return;
    const updated = uc.skuBreakdown.filter((_, i) => i !== idx);
    updateUC(ucId, { skuBreakdown: updated });
  };

  const updateSkuRow = (ucId: string, idx: number, field: 'sku' | 'percentage' | 'overridePrice' | 'customName', value: string | number) => {
    const uc = newUseCases.find(u => u.id === ucId);
    if (!uc) return;
    const updated = uc.skuBreakdown.map((row, i) => {
      if (i !== idx) return row;
      if (field === 'customName') return { ...row, sku: value as string };
      if (field === 'sku') {
        // When switching back to a known SKU, clear overridePrice
        return { ...row, sku: value as string, overridePrice: value === '__custom__' ? (row.overridePrice ?? 0) : undefined };
      }
      return { ...row, [field]: value };
    });
    updateUC(ucId, { skuBreakdown: updated });
  };

  // Adhoc period helpers
  const addAdhocPeriod = (ucId: string) => {
    const uc = newUseCases.find(u => u.id === ucId);
    if (!uc) return;
    const newPeriod: AdhocUsagePeriod = {
      id: generateId(),
      label: 'Development Phase',
      months: [],
      skuAmounts: [],
    };
    updateUC(ucId, { adhocPeriods: [...(uc.adhocPeriods || []), newPeriod] });
  };

  const removeAdhocPeriod = (ucId: string, periodId: string) => {
    const uc = newUseCases.find(u => u.id === ucId);
    if (!uc) return;
    updateUC(ucId, { adhocPeriods: (uc.adhocPeriods || []).filter(p => p.id !== periodId) });
  };

  const updateAdhocPeriod = (ucId: string, periodId: string, updates: Partial<AdhocUsagePeriod>) => {
    const uc = newUseCases.find(u => u.id === ucId);
    if (!uc) return;
    updateUC(ucId, {
      adhocPeriods: (uc.adhocPeriods || []).map(p => p.id === periodId ? { ...p, ...updates } : p),
    });
  };

  const toggleAdhocMonth = (ucId: string, periodId: string, month: number) => {
    const uc = newUseCases.find(u => u.id === ucId);
    if (!uc) return;
    const period = (uc.adhocPeriods || []).find(p => p.id === periodId);
    if (!period) return;
    const months = period.months.includes(month)
      ? period.months.filter(m => m !== month)
      : [...period.months, month].sort((a, b) => a - b);
    updateAdhocPeriod(ucId, periodId, { months });
  };

  const addAdhocSkuRow = (ucId: string, periodId: string) => {
    const uc = newUseCases.find(u => u.id === ucId);
    if (!uc) return;
    const period = (uc.adhocPeriods || []).find(p => p.id === periodId);
    if (!period) return;
    const defaultSku = availableSkuNames[0] || 'Jobs Compute';
    updateAdhocPeriod(ucId, periodId, {
      skuAmounts: [...period.skuAmounts, { sku: defaultSku, dbuPerMonth: 0, dollarPerMonth: 0 }],
    });
  };

  const removeAdhocSkuRow = (ucId: string, periodId: string, rowIdx: number) => {
    const uc = newUseCases.find(u => u.id === ucId);
    if (!uc) return;
    const period = (uc.adhocPeriods || []).find(p => p.id === periodId);
    if (!period) return;
    updateAdhocPeriod(ucId, periodId, {
      skuAmounts: period.skuAmounts.filter((_, i) => i !== rowIdx),
    });
  };

  const updateAdhocSkuRow = (ucId: string, periodId: string, rowIdx: number, field: 'sku' | 'dbuPerMonth' | 'customDbuRate', value: string | number) => {
    const uc = newUseCases.find(u => u.id === ucId);
    if (!uc) return;
    const period = (uc.adhocPeriods || []).find(p => p.id === periodId);
    if (!period) return;
    const skuAmounts = period.skuAmounts.map((sa, i) => {
      if (i !== rowIdx) return sa;
      const updated = { ...sa, [field]: value };
      // Recompute dollarPerMonth: dbuPerMonth × effective $/DBU price
      const listPrice = skuPriceMap[updated.sku]?.[uc.cloud] ?? 0;
      const effectivePrice = listPrice > 0 ? listPrice : (updated.customDbuRate ?? 0.20);
      updated.dollarPerMonth = (updated.dbuPerMonth || 0) * effectivePrice;
      return updated;
    });
    updateAdhocPeriod(ucId, periodId, { skuAmounts });
  };

  // Filter use cases for current scenario
  const activeUseCases = newUseCases.filter(uc => uc.scenarios[scenario - 1]);

  const numYears = Math.max(1, Math.floor(contractMonths / 12));

  // Projections
  const projections = React.useMemo(() => {
    const momRate = baselineGrowthRate / 100 / 12;
    const totalBaselineMonthly = domainBaselines.reduce((s, b) => s + b.avgMonthly, 0);

    // Baseline projection (all historical consumption with growth, overrides applied)
    const baselineMonths = new Array(contractMonths).fill(0);
    for (let i = 0; i < contractMonths; i++) {
      const computed = totalBaselineMonthly * Math.pow(1 + momRate, i + 1);
      baselineMonths[i] = i in baselineOverrides ? baselineOverrides[i] : computed;
    }

    // New use case projections (only for current scenario)
    const ucMonths = new Array(contractMonths).fill(0);
    activeUseCases.forEach(uc => {
      const ucM = calcUseCaseMonthly(uc, contractMonths);
      for (let i = 0; i < contractMonths; i++) ucMonths[i] += ucM[i];
    });

    // Totals
    const totalMonths = baselineMonths.map((b, i) => b + ucMonths[i]);
    const yearTotals = new Array(numYears).fill(0);
    const baseYearTotals = new Array(numYears).fill(0);
    const ucYearTotals = new Array(numYears).fill(0);
    for (let i = 0; i < contractMonths; i++) {
      const y = Math.floor(i / 12);
      yearTotals[y] += totalMonths[i];
      baseYearTotals[y] += baselineMonths[i];
      ucYearTotals[y] += ucMonths[i];
    }

    return { baselineMonths, ucMonths, totalMonths, yearTotals, baseYearTotals, ucYearTotals };
  }, [domainBaselines, baselineGrowthRate, activeUseCases, baselineOverrides, contractMonths]);

  const totalBaseline = domainBaselines.reduce((s, b) => s + b.t12m, 0);

  return (
    <div className="space-y-6">
      {/* Conflict modal */}
      {conflictError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-semibold text-red-700 mb-2">Save conflict</h3>
            <p className="text-sm text-gray-600 mb-4">
              Another tab or user saved this scenario while you were editing. Reload to get the latest version — your unsaved changes will be lost.
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConflictError(false)} className="px-3 py-1.5 text-sm rounded border border-gray-300 text-gray-700 hover:bg-gray-50">
                Keep editing
              </button>
              <button onClick={() => { setConflictError(false); loadFull(); }} className="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-700">
                Reload latest
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {[1, 2, 3].map((s) => (
            <button key={s} onClick={() => handleScenarioSwitch(s)}
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

      {isDirty && !saving && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-50 border border-amber-300 rounded-lg text-amber-800 text-sm">
          <svg className="w-4 h-4 flex-shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <span>You have unsaved changes. <strong>Save Scenario</strong> before switching to Consumption Forecast — the forecast table is built from the last saved state.</span>
          <button onClick={handleSave} disabled={saving}
            className="ml-auto flex-shrink-0 px-3 py-1 bg-amber-500 text-white rounded text-xs font-semibold hover:bg-amber-600">
            Save Now
          </button>
        </div>
      )}

      {loading && <div className="text-center py-8 text-gray-500">Loading historical baseline + scenario...</div>}

      {!loading && (
        <>
          {/* Summary Cards */}
          <div className={`grid gap-4`} style={{ gridTemplateColumns: `repeat(${numYears + 2}, minmax(0, 1fr))` }}>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-[10px] text-gray-500 uppercase">T12M Baseline</div>
              <div className="text-lg font-bold text-gray-900 mt-1">{formatCurrency(totalBaseline)}</div>
            </div>
            {projections.yearTotals.map((val, yi) => (
              <div key={yi} className="bg-white rounded-lg shadow p-4">
                <div className="text-[10px] text-gray-500 uppercase">Year {yi + 1} Projected</div>
                <div className="text-lg font-bold text-blue-600 mt-1">{formatCurrency(val)}</div>
                {yi === 0 && <div className="text-[10px] text-gray-400">Base: {formatCurrency(projections.baseYearTotals[0])} + UC: {formatCurrency(projections.ucYearTotals[0])}</div>}
              </div>
            ))}
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-[10px] text-gray-500 uppercase">{numYears}-Year Total</div>
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
                    onChange={(e) => { setIsDirty(true); setBaselineGrowthRate(parseFloat(e.target.value) || 0); }}
                    className="w-20 border border-gray-300 rounded px-2 py-1.5 text-sm text-right" />
                  <span className="text-sm text-gray-500">% MoM</span>
                  <span className="text-xs text-gray-400">
                    = {((Math.pow(1 + baselineGrowthRate / 100 / 12, 12) - 1) * 100).toFixed(1)}% annual
                  </span>
                </div>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Assumptions</h3>
                <textarea value={assumptionsText} onChange={(e) => { setIsDirty(true); setAssumptionsText(e.target.value); }} rows={4}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  placeholder="e.g., 2% MoM organic growth from data volume increase, new workloads ramping Q2..." />
              </div>
            </div>
          </div>

          {/* Monthly Baseline Overrides */}
          <div className="bg-white rounded-lg shadow">
            <button
              onClick={() => setExpandedOverrides(!expandedOverrides)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50"
            >
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-700">Monthly Baseline Overrides</h3>
                {Object.keys(baselineOverrides).length > 0 && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                    {Object.keys(baselineOverrides).length} overridden
                  </span>
                )}
                <span className="text-xs text-gray-400">Override specific months — overridden cells shown in amber everywhere</span>
              </div>
              <div className="flex items-center gap-2">
                {Object.keys(baselineOverrides).length > 0 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setIsDirty(true); setBaselineOverrides({}); }}
                    className="text-xs text-red-500 hover:text-red-700 px-2 py-0.5 rounded border border-red-200 hover:bg-red-50"
                  >
                    Clear All
                  </button>
                )}
                <svg className={`w-4 h-4 text-gray-400 transition-transform ${expandedOverrides ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </button>
            {expandedOverrides && (
              <div className="border-t px-4 py-4">
                <div className="overflow-x-auto">
                  <div className="flex gap-1 pb-2" style={{ minWidth: 'max-content' }}>
                    {Array.from({ length: contractMonths }, (_, i) => {
                      const monthLabel = getMonthLabel(i + 1, contractStartDate);
                      const isOverridden = i in baselineOverrides;
                      const totalBaselineMonthly = domainBaselines.reduce((s, b) => s + b.avgMonthly, 0);
                      const momRate = baselineGrowthRate / 100 / 12;
                      const computed = totalBaselineMonthly * Math.pow(1 + momRate, i + 1);
                      return (
                        <div key={i} className="flex flex-col items-center" style={{ minWidth: 72 }}>
                          <div className="text-[9px] text-gray-400 text-center mb-1 leading-tight whitespace-pre-line">
                            {monthLabel.replace(' (', '\n(').replace(')', '')}
                          </div>
                          <input
                            type="number"
                            value={isOverridden ? baselineOverrides[i] : ''}
                            placeholder={Math.round(computed).toLocaleString()}
                            onChange={(e) => {
                              setIsDirty(true);
                              const val = e.target.value.trim();
                              if (val === '') {
                                const next = { ...baselineOverrides };
                                delete next[i];
                                setBaselineOverrides(next);
                              } else {
                                setBaselineOverrides(prev => ({ ...prev, [i]: parseFloat(val) || 0 }));
                              }
                            }}
                            className={`w-full text-xs text-right rounded border px-1 py-1 font-mono focus:outline-none focus:ring-1 ${
                              isOverridden
                                ? 'bg-amber-50 border-amber-400 text-amber-900 font-semibold focus:ring-amber-400'
                                : 'bg-white border-gray-200 text-gray-400 focus:ring-blue-400'
                            }`}
                          />
                          {isOverridden && (
                            <button
                              onClick={() => {
                                setIsDirty(true);
                                const next = { ...baselineOverrides };
                                delete next[i];
                                setBaselineOverrides(next);
                              }}
                              className="text-[9px] text-amber-600 hover:text-red-600 mt-0.5"
                              title="Reset to computed"
                            >
                              ✕ reset
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <p className="text-[10px] text-gray-400 mt-2">
                  Type a value to override that month's baseline. Leave blank to use the computed growth-rate projection. Clear individual cells with ✕ reset or use Clear All above.
                </p>
              </div>
            )}
          </div>

          {/* Projection Summary */}
          <div className="bg-white rounded-lg shadow overflow-auto">
            <div className="px-4 py-3 bg-gray-50 border-b">
              <h3 className="text-sm font-semibold text-gray-700">Scenario {scenario} — {numYears}-Year Projection</h3>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50">
                  <th className="px-3 py-2 text-left font-medium text-gray-600 sticky left-0 bg-gray-50 min-w-[140px]">Category</th>
                  {Array.from({ length: numYears }, (_, yi) => (
                    <th key={yi} className="px-3 py-2 text-right font-medium text-blue-600 bg-blue-50">Year {yi + 1}</th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium text-purple-600 bg-purple-50">Total</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium sticky left-0 bg-white">Existing Baseline (with {baselineGrowthRate}% MoM growth)</td>
                  {projections.baseYearTotals.map((v, yi) => (
                    <td key={yi} className="px-3 py-2 text-right">{formatCurrency(v)}</td>
                  ))}
                  <td className="px-3 py-2 text-right font-medium bg-gray-50">{formatCurrency(projections.baseYearTotals.reduce((a, b) => a + b, 0))}</td>
                </tr>
                {activeUseCases.map(uc => {
                  const ucM = calcUseCaseMonthly(uc, contractMonths);
                  const yT = new Array(numYears).fill(0);
                  ucM.forEach((v, i) => { yT[Math.floor(i / 12)] += v; });
                  return (
                    <tr key={uc.id} className="border-t hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-700 sticky left-0 bg-white pl-6">{'>'} {uc.name || 'Unnamed'}</td>
                      {yT.map((v, yi) => <td key={yi} className="px-3 py-2 text-right">{formatCurrency(v)}</td>)}
                      <td className="px-3 py-2 text-right bg-gray-50">{formatCurrency(yT.reduce((a, b) => a + b, 0))}</td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-gray-300 bg-blue-50 font-bold">
                  <td className="px-3 py-2 sticky left-0 bg-blue-50">Grand Total</td>
                  {projections.yearTotals.map((v, yi) => (
                    <td key={yi} className="px-3 py-2 text-right">{formatCurrency(v)}</td>
                  ))}
                  <td className="px-3 py-2 text-right bg-purple-100">{formatCurrency(projections.yearTotals.reduce((a, b) => a + b, 0))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Use Cases — independent panel, shared across S1/S2/S3 */}
      <div className="rounded-xl border-2 border-blue-200 shadow-sm mt-6 overflow-hidden">
        {/* Panel header */}
        <div className="flex items-center justify-between px-5 py-3.5 bg-gradient-to-r from-blue-600 to-blue-500">
          <div className="flex items-center gap-3">
            <span className="text-white font-bold text-sm tracking-wide">Use Cases</span>
            <span className="bg-white/20 text-white text-xs font-semibold px-2 py-0.5 rounded-full">
              {newUseCases.length} total
            </span>
            {newUseCases.length > 0 && (
              <div className="flex items-center gap-2 text-blue-100 text-xs">
                <span className="bg-white/10 px-1.5 py-0.5 rounded">S1: {newUseCases.filter(u => u.scenarios[0]).length}</span>
                <span className="bg-white/10 px-1.5 py-0.5 rounded">S2: {newUseCases.filter(u => u.scenarios[1]).length}</span>
                <span className="bg-white/10 px-1.5 py-0.5 rounded">S3: {newUseCases.filter(u => u.scenarios[2]).length}</span>
              </div>
            )}
          </div>
          <button onClick={addNewUseCase}
            className="flex items-center gap-1.5 px-3.5 py-1.5 bg-white text-blue-700 rounded-lg text-xs font-bold hover:bg-blue-50 transition shadow-sm">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
            </svg>
            Add Use Case
          </button>
        </div>

        {newUseCases.length === 0 ? (
          <div className="p-8 text-center bg-white">
            <div className="text-gray-300 mb-2">
              <svg className="w-10 h-10 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <p className="text-sm text-gray-400">No use cases added yet.</p>
            <p className="text-xs text-gray-300 mt-1">Click <strong className="text-blue-500">Add Use Case</strong> to project incremental workloads.</p>
          </div>
        ) : (
          <div className="bg-white divide-y divide-gray-100">
            {newUseCases.map((uc, ucIdx) => {
              const UC_COLORS = [
                { border: 'border-l-blue-500',   bg: 'bg-blue-50',   badge: 'bg-blue-500',   text: 'text-blue-700',   light: 'bg-blue-50',   ring: 'ring-blue-200'   },
                { border: 'border-l-violet-500',  bg: 'bg-violet-50', badge: 'bg-violet-500', text: 'text-violet-700', light: 'bg-violet-50', ring: 'ring-violet-200' },
                { border: 'border-l-emerald-500', bg: 'bg-emerald-50',badge: 'bg-emerald-500',text: 'text-emerald-700',light: 'bg-emerald-50',ring: 'ring-emerald-200'},
                { border: 'border-l-orange-500',  bg: 'bg-orange-50', badge: 'bg-orange-500', text: 'text-orange-700', light: 'bg-orange-50', ring: 'ring-orange-200' },
                { border: 'border-l-rose-500',    bg: 'bg-rose-50',   badge: 'bg-rose-500',   text: 'text-rose-700',  light: 'bg-rose-50',   ring: 'ring-rose-200'   },
                { border: 'border-l-cyan-500',    bg: 'bg-cyan-50',   badge: 'bg-cyan-500',   text: 'text-cyan-700',  light: 'bg-cyan-50',   ring: 'ring-cyan-200'   },
                { border: 'border-l-teal-500',    bg: 'bg-teal-50',   badge: 'bg-teal-500',   text: 'text-teal-700',  light: 'bg-teal-50',   ring: 'ring-teal-200'   },
              ];
              const ucColor = UC_COLORS[ucIdx % UC_COLORS.length];
              const isExpanded = expandedUC === uc.id;
              const ucMonthly = calcUseCaseMonthly(uc, contractMonths);
              const ucYearTotals = new Array(numYears).fill(0);
              ucMonthly.forEach((v, i) => { ucYearTotals[Math.floor(i / 12)] += v; });
              return (
                <div key={uc.id} className={`border-l-4 ${ucColor.border}`}>
                  {/* Header row */}
                  <div className={`flex items-center gap-3 px-4 py-3 ${isExpanded ? ucColor.bg : 'bg-white hover:' + ucColor.bg} transition-colors`}>
                    <div className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer"
                      onClick={() => setExpandedUC(isExpanded ? null : uc.id)}>
                      {/* UC number badge */}
                      <span className={`flex-shrink-0 w-6 h-6 rounded-full ${ucColor.badge} text-white text-[10px] font-bold flex items-center justify-center`}>
                        {ucIdx + 1}
                      </span>
                      <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-sm font-semibold ${ucColor.text}`}>{uc.name || 'Unnamed Use Case'}</span>
                          {uc.domain && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{uc.domain}</span>}
                          {uc.cloud && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">{uc.cloud.toUpperCase()}</span>}
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${uc.rampType === 'hockey_stick' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'}`}>
                            {uc.rampType === 'hockey_stick' ? 'Hockey Stick' : 'Linear'} ramp
                          </span>
                          {uc.upliftOnly && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold">
                              $ uplift only
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          <span className={uc.upliftOnly ? 'text-amber-600 font-medium' : ''}>
                            {formatCurrency(uc.steadyStateDbu)}/mo{uc.upliftOnly ? ' $ uplift' : ''}
                          </span>
                          &nbsp;·&nbsp;
                          <span className="text-amber-600 font-medium">Onboard: {getMonthLabel(uc.onboardingMonth, contractStartDate)}</span>
                          &nbsp;→&nbsp;
                          <span className="text-green-600 font-medium">Live: {getMonthLabel(uc.liveMonth, contractStartDate)}</span>
                          {ucYearTotals.map((v, yi) => (
                            <span key={yi}>&nbsp;·&nbsp; Y{yi + 1}: {formatCurrency(v)}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                    {/* S1/S2/S3 inline checkboxes */}
                    <div className="flex items-center gap-2 flex-shrink-0 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1">
                      {[0, 1, 2].map(i => (
                        <label key={i} className="flex items-center gap-1 cursor-pointer">
                          <input type="checkbox" checked={uc.scenarios[i]}
                            onChange={(e) => {
                              const s = [...uc.scenarios];
                              s[i] = e.target.checked;
                              updateUC(uc.id, { scenarios: s });
                            }}
                            className="w-3.5 h-3.5 rounded" />
                          <span className={`text-xs font-semibold ${uc.scenarios[i] ? ['text-blue-600','text-violet-600','text-emerald-600'][i] : 'text-gray-300'}`}>S{i + 1}</span>
                        </label>
                      ))}
                    </div>
                    <button onClick={() => removeNewUseCase(uc.id)}
                      className="text-gray-300 hover:text-red-500 transition-colors flex-shrink-0" title="Remove">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  {/* Expanded Form */}
                  {isExpanded && (
                    <div className={`px-5 pb-5 pt-3 ml-10 space-y-4 border-t border-dashed ${ucColor.ring.replace('ring','border')}`}>
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
                          {/* Uplift-only toggle */}
                          <div className="flex items-center gap-3 mb-3 p-2.5 rounded-lg border border-amber-200 bg-amber-50">
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={uc.upliftOnly}
                                onChange={(e) => updateUC(uc.id, { upliftOnly: e.target.checked })}
                                className="w-4 h-4 rounded accent-amber-500"
                              />
                              <span className="text-xs font-semibold text-amber-800">Dollar uplift only (no new DBUs)</span>
                            </label>
                            <span className="text-[10px] text-amber-700 leading-tight">
                              Use for Serverless migrations, price tier changes — impacts $DBU spend but not DBU volume
                            </span>
                          </div>
                          <label className="block text-xs font-medium text-gray-600 mb-1.5">
                            {uc.upliftOnly ? 'Monthly $ Uplift' : 'Steady-State Size'}
                          </label>
                          <div className="flex flex-wrap gap-1.5">
                            {TSHIRT_SIZES.map((size) => {
                              const isSelected = getTshirtKey(uc.steadyStateDbu) === size.key;
                              return (
                                <button key={size.key} onClick={() => updateUC(uc.id, { steadyStateDbu: size.value })}
                                  className={`flex flex-col items-center px-2.5 py-1.5 rounded-lg border text-center transition-all min-w-[72px] ${isSelected ? 'bg-blue-50 border-blue-400 ring-1 ring-blue-200' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'}`}>
                                  <span className={`text-xs font-bold ${isSelected ? 'text-blue-700' : 'text-gray-700'}`}>{size.label}</span>
                                  <span className={`text-[10px] font-medium ${isSelected ? 'text-blue-600' : 'text-gray-500'}`}>{fmtShort(size.value)}/mo</span>
                                  <span className={`text-[9px] ${isSelected ? 'text-blue-400' : 'text-gray-400'}`}>{fmtShort(size.value * 12)}/yr</span>
                                </button>
                              );
                            })}
                            <button onClick={() => { if (getTshirtKey(uc.steadyStateDbu) !== 'custom') updateUC(uc.id, { steadyStateDbu: 0 }); }}
                              className={`flex flex-col items-center px-2.5 py-1.5 rounded-lg border text-center transition-all min-w-[72px] ${getTshirtKey(uc.steadyStateDbu) === 'custom' ? 'bg-purple-50 border-purple-400 ring-1 ring-purple-200' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'}`}>
                              <span className={`text-xs font-bold ${getTshirtKey(uc.steadyStateDbu) === 'custom' ? 'text-purple-700' : 'text-gray-700'}`}>Custom</span>
                              <span className={`text-[10px] ${getTshirtKey(uc.steadyStateDbu) === 'custom' ? 'text-purple-500' : 'text-gray-400'}`}>Enter value</span>
                            </button>
                          </div>
                          <div className="mt-2 flex items-center gap-3">
                            {getTshirtKey(uc.steadyStateDbu) === 'custom' ? (
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-gray-500">$</span>
                                <input type="number" value={uc.steadyStateDbu || ''}
                                  onChange={(e) => updateUC(uc.id, { steadyStateDbu: parseFloat(e.target.value) || 0 })}
                                  className="w-32 border border-purple-300 rounded px-2 py-1 text-sm text-right bg-purple-50" placeholder="Enter $/month" />
                                <span className="text-xs text-gray-500">/month</span>
                                {uc.steadyStateDbu > 0 && <span className="text-xs text-gray-400">= {fmtShort(uc.steadyStateDbu * 12)}/yr</span>}
                              </div>
                            ) : (
                              <div className="text-xs text-gray-500">
                                {formatCurrency(uc.steadyStateDbu)}/month {'>'} {fmtShort(uc.steadyStateDbu * 12)}/year
                                <span className="text-gray-400 ml-2">({TSHIRT_SIZES.find(s => s.value === uc.steadyStateDbu)?.desc})</span>
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
                              className={`flex-1 px-2 py-1.5 text-xs rounded border ${uc.rampType === 'linear' ? 'bg-blue-50 border-blue-300 text-blue-700 font-medium' : 'border-gray-200 text-gray-500'}`}>Linear</button>
                            <button onClick={() => updateUC(uc.id, { rampType: 'hockey_stick' })}
                              className={`flex-1 px-2 py-1.5 text-xs rounded border ${uc.rampType === 'hockey_stick' ? 'bg-orange-50 border-orange-300 text-orange-700 font-medium' : 'border-gray-200 text-gray-500'}`}>Hockey Stick</button>
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Onboarding Month</label>
                          <select value={uc.onboardingMonth} onChange={(e) => updateUC(uc.id, { onboardingMonth: parseInt(e.target.value) })}
                            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm">
                            {Array.from({ length: contractMonths }, (_, i) => (
                              <option key={i + 1} value={i + 1}>{getMonthLabel(i + 1, contractStartDate)}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Live Month (Steady State)</label>
                          <select value={uc.liveMonth} onChange={(e) => updateUC(uc.id, { liveMonth: parseInt(e.target.value) })}
                            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm">
                            {Array.from({ length: contractMonths }, (_, i) => (
                              <option key={i + 1} value={i + 1} disabled={i + 1 <= uc.onboardingMonth}>
                                {getMonthLabel(i + 1, contractStartDate)}
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

                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1.5">Cloud</label>
                        <div className="flex gap-2">
                          {availableClouds.map(c => (
                            <button key={c} onClick={() => updateUC(uc.id, { cloud: c })}
                              className={`px-3 py-1.5 text-xs rounded border capitalize ${uc.cloud === c ? 'bg-indigo-50 border-indigo-400 text-indigo-700 font-medium ring-1 ring-indigo-200' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                              {c.toUpperCase()}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1.5">Workload Type</label>
                        <div className="flex flex-wrap gap-1.5">
                          {WORKLOAD_PRESETS.map(preset => (
                            <button key={preset.key} onClick={() => applyWorkloadPreset(uc.id, preset.key)}
                              className="px-3 py-1.5 text-xs rounded border border-gray-200 text-gray-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors">
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {uc.skuBreakdown.length > 0 && (
                        <div className="border rounded-lg overflow-hidden">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="bg-gray-50">
                                <th className="px-3 py-2 text-left font-medium text-gray-600">SKU</th>
                                <th className="px-3 py-2 text-right font-medium text-gray-600 w-20">% Split</th>
                                {!uc.upliftOnly && <th className="px-3 py-2 text-right font-medium text-gray-600">DBUs/month</th>}
                                <th className="px-3 py-2 text-right font-medium text-gray-600">{uc.upliftOnly ? '$/month split' : '$/DBU'}</th>
                                <th className="px-3 py-2 text-right font-medium text-gray-600">$/month</th>
                                <th className="px-3 py-2 w-8"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {uc.skuBreakdown.map((alloc, idx) => {
                                const isCustom = alloc.overridePrice !== undefined;
                                const listPrice = skuPriceMap[alloc.sku]?.[uc.cloud] ?? 0;
                                const effectivePrice = isCustom ? (alloc.overridePrice ?? 0) : listPrice;
                                return (
                                  <tr key={idx} className={`border-t hover:bg-gray-50 ${isCustom ? 'bg-amber-50' : ''}`}>
                                    <td className="px-3 py-1.5">
                                      <div className="flex flex-col gap-1">
                                        <select
                                          value={isCustom ? '__custom__' : alloc.sku}
                                          onChange={(e) => updateSkuRow(uc.id, idx, 'sku', e.target.value)}
                                          className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs">
                                          {(availableSkuNames.length > 0
                                            ? availableSkuNames
                                            : ['All Purpose Compute', 'Jobs Compute', 'Serverless SQL', 'DLT Core', 'Model Serving', 'Foundation Model API', 'Vector Search']
                                          ).map(name => <option key={name} value={name}>{name}</option>)}
                                          <option value="__custom__">+ Custom SKU (new product)</option>
                                        </select>
                                        {isCustom && (
                                          <input
                                            type="text"
                                            placeholder="Enter SKU name…"
                                            value={alloc.sku === '__custom__' ? '' : alloc.sku}
                                            onChange={(e) => updateSkuRow(uc.id, idx, 'customName', e.target.value)}
                                            className="w-full border border-amber-300 rounded px-1.5 py-1 text-xs bg-white placeholder-amber-400"
                                          />
                                        )}
                                      </div>
                                    </td>
                                    <td className="px-3 py-1.5 text-right">
                                      <div className="flex items-center justify-end gap-1">
                                        <input type="number" min={0} max={100} value={alloc.percentage}
                                          onChange={(e) => updateSkuRow(uc.id, idx, 'percentage', parseFloat(e.target.value) || 0)}
                                          className="w-14 border border-gray-200 rounded px-1.5 py-1 text-xs text-right" />
                                        <span className="text-gray-400">%</span>
                                      </div>
                                    </td>
                                    {!uc.upliftOnly && (
                                      <td className="px-3 py-1.5 text-right text-gray-700">{alloc.dbus > 0 ? Math.round(alloc.dbus).toLocaleString() : '-'}</td>
                                    )}
                                    <td className="px-3 py-1.5 text-right">
                                      {uc.upliftOnly ? (
                                        <span className="text-gray-500">{alloc.dollarDbu > 0 ? formatCurrency(alloc.dollarDbu) : '-'}</span>
                                      ) : isCustom ? (
                                        <div className="flex items-center justify-end gap-0.5">
                                          <span className="text-amber-500 text-[10px]">$</span>
                                          <input
                                            type="number" min={0} step={0.01}
                                            value={alloc.overridePrice ?? ''}
                                            placeholder="0.00"
                                            onChange={(e) => updateSkuRow(uc.id, idx, 'overridePrice', parseFloat(e.target.value) || 0)}
                                            className="w-16 border border-amber-300 rounded px-1 py-0.5 text-xs text-right bg-white"
                                            title="Custom $/DBU price"
                                          />
                                          <span className="text-amber-500 text-[10px]">*</span>
                                        </div>
                                      ) : (
                                        <span className="text-gray-500">{effectivePrice > 0 ? `$${effectivePrice.toFixed(2)}` : '-'}</span>
                                      )}
                                    </td>
                                    <td className="px-3 py-1.5 text-right font-medium text-gray-900">{alloc.dollarDbu > 0 ? formatCurrency(alloc.dollarDbu) : '-'}</td>
                                    <td className="px-1 py-1.5 text-center">
                                      <button onClick={() => removeSkuRow(uc.id, idx)} className="text-red-300 hover:text-red-500 text-[10px]">x</button>
                                    </td>
                                  </tr>
                                );
                              })}
                              <tr className="border-t-2 border-gray-300 bg-gray-50 font-medium">
                                <td className="px-3 py-2 text-gray-700">Total</td>
                                <td className="px-3 py-2 text-right">
                                  <span className={uc.skuBreakdown.reduce((s, a) => s + a.percentage, 0) === 100 ? 'text-green-600' : 'text-red-500'}>
                                    {uc.skuBreakdown.reduce((s, a) => s + a.percentage, 0)}%
                                  </span>
                                </td>
                                {!uc.upliftOnly && (
                                  <td className="px-3 py-2 text-right text-gray-700">{Math.round(uc.skuBreakdown.reduce((s, a) => s + a.dbus, 0)).toLocaleString()}</td>
                                )}
                                <td className="px-3 py-2 text-right text-gray-500">
                                  {uc.upliftOnly ? '—' : (() => {
                                    const td = uc.skuBreakdown.reduce((s, a) => s + a.dollarDbu, 0);
                                    const tdb = uc.skuBreakdown.reduce((s, a) => s + a.dbus, 0);
                                    const avg = tdb > 0 ? td / tdb : 0;
                                    return avg > 0 ? `avg $${avg.toFixed(2)}` : '-';
                                  })()}
                                </td>
                                <td className="px-3 py-2 text-right font-bold text-gray-900">{formatCurrency(uc.skuBreakdown.reduce((s, a) => s + a.dollarDbu, 0))}</td>
                                <td></td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      )}

                      <button onClick={() => addSkuRow(uc.id)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">
                        + Add SKU Row
                      </button>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
                          <textarea value={uc.description || ''} onChange={(e) => updateUC(uc.id, { description: e.target.value })}
                            rows={2} className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                            placeholder="What is this use case? e.g., Migrating 50 Informatica jobs to DLT pipelines for Finance domain" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Assumptions</label>
                          <textarea value={uc.assumptions || ''} onChange={(e) => updateUC(uc.id, { assumptions: e.target.value })}
                            rows={2} className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                            placeholder="Caveats, dependencies, notes… e.g., 10TB daily ingestion, assumes Photon enabled" />
                        </div>
                      </div>

                      {/* Development Phase / Adhoc Usage */}
                      <div className="border border-dashed border-indigo-300 rounded-lg overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-2 bg-indigo-50">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-indigo-700">Development Phase / Adhoc Usage</span>
                            <span className="text-[10px] text-indigo-500">Add extra DBUs/month for specific months on top of steady-state ramp</span>
                          </div>
                          <button onClick={() => addAdhocPeriod(uc.id)}
                            className="flex items-center gap-1 text-xs font-medium text-indigo-700 hover:text-indigo-900 border border-indigo-300 rounded px-2 py-0.5 hover:bg-indigo-100">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                            Add Period
                          </button>
                        </div>
                        {(uc.adhocPeriods || []).length === 0 ? (
                          <div className="px-3 py-2 text-[11px] text-gray-400 bg-white">
                            No adhoc periods. Use "Add Period" to layer additional usage acceleration (e.g., dev burst, pilot) on specific months.
                          </div>
                        ) : (
                          <div className="divide-y divide-indigo-100 bg-white">
                            {(uc.adhocPeriods || []).map((period) => {
                              const periodTotalDbu = period.skuAmounts.reduce((s, sa) => s + (sa.dbuPerMonth || 0), 0);
                              const periodTotalDollar = period.skuAmounts.reduce((s, sa) => s + (sa.dollarPerMonth || 0), 0);
                              return (
                                <div key={period.id} className="px-3 py-3 space-y-2">
                                  {/* Period header */}
                                  <div className="flex items-center gap-2">
                                    <input
                                      type="text"
                                      value={period.label}
                                      onChange={(e) => updateAdhocPeriod(uc.id, period.id, { label: e.target.value })}
                                      className="flex-1 border border-indigo-200 rounded px-2 py-1 text-xs font-medium text-indigo-800 bg-indigo-50 placeholder-indigo-300"
                                      placeholder="Period label e.g. Development Phase"
                                    />
                                    {periodTotalDbu > 0 && (
                                      <span className="text-[10px] text-indigo-600 font-medium bg-indigo-100 px-1.5 py-0.5 rounded">
                                        +{Math.round(periodTotalDbu).toLocaleString()} DBUs/mo ({formatCurrency(periodTotalDollar)}/mo) × {period.months.length} months = {formatCurrency(periodTotalDollar * period.months.length)}
                                      </span>
                                    )}
                                    <button onClick={() => removeAdhocPeriod(uc.id, period.id)} className="text-red-300 hover:text-red-500 text-xs">✕</button>
                                  </div>
                                  {/* Month picker */}
                                  <div>
                                    <div className="text-[10px] font-medium text-gray-500 mb-1">Select months where this extra usage applies:</div>
                                    <div className="flex flex-wrap gap-1">
                                      {Array.from({ length: contractMonths }, (_, i) => {
                                        const m = i + 1;
                                        const isSelected = period.months.includes(m);
                                        const lbl = getMonthLabel(m, contractStartDate).split(' (')[0]; // just MxYy
                                        return (
                                          <button key={m} onClick={() => toggleAdhocMonth(uc.id, period.id, m)}
                                            className={`px-1.5 py-0.5 rounded text-[9px] font-mono border transition-colors ${
                                              isSelected
                                                ? 'bg-indigo-500 text-white border-indigo-500'
                                                : 'border-gray-200 text-gray-400 hover:border-indigo-300 hover:text-indigo-600'
                                            }`}
                                            title={getMonthLabel(m, contractStartDate)}>
                                            {lbl}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  </div>
                                  {/* Per-SKU amounts */}
                                  <div>
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="text-[10px] font-medium text-gray-500">Additional DBUs/month per SKU{period.months.length > 0 ? ` (applied to ${period.months.length} selected month${period.months.length !== 1 ? 's' : ''})` : ''}:</span>
                                      <button onClick={() => addAdhocSkuRow(uc.id, period.id)}
                                        className="flex items-center gap-0.5 text-[10px] font-medium text-indigo-600 hover:text-indigo-800 border border-indigo-200 rounded px-1.5 py-0.5 hover:bg-indigo-50">
                                        <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                                        Add SKU
                                      </button>
                                    </div>
                                    {period.skuAmounts.length === 0 ? (
                                      <div className="text-[10px] text-gray-400 italic py-1">No SKUs added. Click "Add SKU" to specify additional usage per SKU.</div>
                                    ) : (
                                      <div className="space-y-1">
                                        {period.skuAmounts.map((sa, saIdx) => {
                                          const listPrice = skuPriceMap[sa.sku]?.[uc.cloud] ?? 0;
                                          const isCustomSku = listPrice === 0;
                                          const effectivePrice = isCustomSku ? (sa.customDbuRate ?? 0.20) : listPrice;
                                          return (
                                            <div key={saIdx} className="flex items-center gap-1.5 flex-wrap">
                                              <select
                                                value={sa.sku}
                                                onChange={(e) => updateAdhocSkuRow(uc.id, period.id, saIdx, 'sku', e.target.value)}
                                                className="flex-1 min-w-[120px] border border-indigo-200 rounded px-1.5 py-0.5 text-xs bg-white">
                                                {(availableSkuNames.length > 0
                                                  ? availableSkuNames
                                                  : ['All Purpose Compute', 'Jobs Compute', 'Serverless SQL', 'DLT Core', 'Model Serving', 'Foundation Model API', 'Vector Search']
                                                ).map(name => <option key={name} value={name}>{name}</option>)}
                                              </select>
                                              <input
                                                type="number" min={0}
                                                value={sa.dbuPerMonth || ''}
                                                placeholder="0"
                                                onChange={(e) => updateAdhocSkuRow(uc.id, period.id, saIdx, 'dbuPerMonth', parseFloat(e.target.value) || 0)}
                                                className="w-24 flex-shrink-0 border border-indigo-200 rounded px-1.5 py-0.5 text-xs text-right"
                                              />
                                              <span className="text-[10px] text-gray-400 flex-shrink-0">DBUs/mo</span>
                                              {isCustomSku ? (
                                                <div className="flex items-center gap-0.5 flex-shrink-0">
                                                  <span className="text-[10px] text-gray-400">@$</span>
                                                  <input
                                                    type="number" min={0} step={0.01}
                                                    value={sa.customDbuRate ?? ''}
                                                    placeholder="0.20"
                                                    onChange={(e) => updateAdhocSkuRow(uc.id, period.id, saIdx, 'customDbuRate', parseFloat(e.target.value) || 0)}
                                                    className="w-14 border border-indigo-200 rounded px-1 py-0.5 text-xs text-right"
                                                    title="$/DBU rate for this custom SKU"
                                                  />
                                                  <span className="text-[10px] text-gray-400">/DBU</span>
                                                </div>
                                              ) : (
                                                <span className="text-[10px] text-gray-400 flex-shrink-0 bg-gray-100 px-1 rounded" title="List price $/DBU">
                                                  @${listPrice.toFixed(2)}/DBU
                                                </span>
                                              )}
                                              {sa.dbuPerMonth > 0 && (
                                                <span className="text-[10px] text-indigo-500 flex-shrink-0">
                                                  = {formatCurrency(sa.dollarPerMonth)}/mo
                                                  {period.months.length > 0 && ` (${formatCurrency(sa.dollarPerMonth * period.months.length)} total)`}
                                                </span>
                                              )}
                                              <button onClick={() => removeAdhocSkuRow(uc.id, period.id, saIdx)}
                                                className="text-red-300 hover:text-red-500 flex-shrink-0 text-[10px]">✕</button>
                                            </div>
                                          );
                                        })}
                                        {period.skuAmounts.length > 1 && (
                                          <div className="flex items-center justify-end gap-2 pt-1 border-t border-indigo-100">
                                            <span className="text-[10px] text-indigo-600 font-medium">
                                              Total: {Math.round(periodTotalDbu).toLocaleString()} DBUs/mo ({formatCurrency(periodTotalDollar)}/mo)
                                              {period.months.length > 0 && ` = ${formatCurrency(periodTotalDollar * period.months.length)} over ${period.months.length}mo`}
                                            </span>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="bg-gray-50 rounded-lg p-3">
                        <div className="text-[10px] font-medium text-gray-500 uppercase mb-2">Monthly Ramp Preview</div>
                        <div className="flex items-end gap-px h-16">
                          {ucMonthly.map((v, i) => {
                            const maxVal = Math.max(...ucMonthly, 1);
                            const pct = (v / maxVal) * 100;
                            const isOnboard = i + 1 === uc.onboardingMonth;
                            const isLive = i + 1 === uc.liveMonth;
                            return (
                              <div key={i} className="flex-1 flex flex-col items-center" title={`${getMonthLabel(i + 1, contractStartDate)}: ${formatCurrency(v)}`}>
                                <div className={`w-full rounded-t-sm ${v === 0 ? 'bg-gray-200' : i + 1 >= uc.liveMonth ? 'bg-green-400' : uc.rampType === 'hockey_stick' ? 'bg-orange-400' : 'bg-blue-400'}`}
                                  style={{ height: `${Math.max(pct, 2)}%` }} />
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
                          <span>^ Onboard ({getMonthLabel(uc.onboardingMonth, contractStartDate)})</span>
                          <span>o Live ({getMonthLabel(uc.liveMonth, contractStartDate)}): {formatCurrency(uc.steadyStateDbu)}/mo</span>
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
    </div>
  );
}

export default function ScenarioTab({ accounts }: Props) {
  const [selectedAccountIdx, setSelectedAccountIdx] = useState(0);

  const idx = Math.min(selectedAccountIdx, accounts.length - 1);
  const selectedAccount = accounts[idx];

  return (
    <div className="space-y-4">
      {/* Account sub-tabs */}
      {accounts.length > 1 && (
        <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-lg w-fit">
          {accounts.map((acct, i) => (
            <button
              key={i}
              onClick={() => setSelectedAccountIdx(i)}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-all ${
                idx === i
                  ? 'bg-white text-blue-700 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {acct.name || `Account ${i + 1}`}
            </button>
          ))}
        </div>
      )}

      {accounts.map((acct, i) => (
        <div key={acct.name} style={{ display: idx === i ? 'block' : 'none' }}>
          <ScenarioAccountView
            account={acct.sfdc_id}
            contractStartDate={acct.contractStartDate}
            contractMonths={acct.contractMonths ?? 36}
          />
        </div>
      ))}
    </div>
  );
}
