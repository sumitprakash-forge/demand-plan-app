import React, { useState, useCallback, useEffect } from 'react';
import SummaryTab from './components/SummaryTab';
import HistoricalTab from './components/HistoricalTab';
import ScenarioTab from './components/ScenarioTab';
// ForecastTab removed
import OverviewTab from './components/OverviewTab';
import ConsumptionForecastTab from './components/ConsumptionForecastTab';
import SetupTab from './components/SetupTab';
import LoginPage from './components/LoginPage';
import { exportToExcelJS } from './exportExcelJS';
import { fetchConsumption, fetchDomainMap, fetchScenario } from './api';

export interface AccountConfig {
  name: string;        // Display name
  sfdc_id: string;     // SFDC Account ID — always used as the backend key for all data
  contractStartDate: string; // YYYY-MM, e.g. "2026-04" — defines M1 of Year 1
  contractMonths: number;   // 12 = 1yr, 36 = 3yr, 60 = 5yr
}

const TABS = [
  { id: 'setup', label: 'Setup' },
  { id: 'summary', label: 'Demand Plan Summary' },
  { id: 'historical', label: 'Historical Consumption (T12M)' },
  { id: 'scenario', label: 'Scenario Builder' },
  { id: 'consumption-forecast', label: 'Consumption Forecast' },
  { id: 'overview', label: 'Account Overview' },
];

const DEFAULT_ACCOUNTS: AccountConfig[] = [
  { name: 'Kroger', sfdc_id: 'Kroger', contractStartDate: '', contractMonths: 36 },
];

// Calculate use case monthly projection (same logic as ScenarioTab, includes adhoc periods)
function calcUseCaseMonthly(uc: any): number[] {
  const months = new Array(36).fill(0);
  const ss = uc.steadyStateDbu || 0;
  const om = uc.onboardingMonth || 1;
  const lm = uc.liveMonth || 6;
  if (ss <= 0 || lm <= om) return months;
  const rampMonths = lm - om;
  for (let i = 0; i < 36; i++) {
    const m = i + 1;
    if (m < om) months[i] = 0;
    else if (m >= lm) months[i] = ss;
    else {
      const progress = (m - om + 1) / (rampMonths + 1);
      months[i] = (uc.rampType || 'linear') === 'linear' ? ss * progress : ss * Math.pow(progress, 2.5);
    }
    // Add adhoc period amounts
    const adhocPeriods = uc.adhocPeriods || uc.adhoc_periods || [];
    for (const period of adhocPeriods) {
      if ((period.months || []).includes(m)) {
        months[i] += (period.skuAmounts || []).reduce((s: number, sa: any) => s + (sa.dollarPerMonth || 0), 0);
      }
    }
  }
  return months;
}

function loadSavedAccounts(): AccountConfig[] {
  try {
    const saved = localStorage.getItem('demandplan_accounts');
    if (saved) {
      const parsed = JSON.parse(saved) as AccountConfig[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* ignore */ }
  return [{ name: '', sfdc_id: '', contractStartDate: '', contractMonths: 36 }];
}

export default function App() {
  const [authState, setAuthState] = useState<'checking' | 'unauthenticated' | 'authenticated'>('checking');
  const [currentUser, setCurrentUser] = useState<{ username: string; host: string; demo?: boolean } | null>(null);

  // Check session on mount
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => { setCurrentUser(data); setAuthState('authenticated'); })
      .catch(() => setAuthState('unauthenticated'));
  }, []);

  const handleLogin = (username: string, host: string, demo?: boolean) => {
    setCurrentUser({ username, host, demo });
    setAuthState('authenticated');
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setCurrentUser(null);
    setAuthState('unauthenticated');
  };

  if (authState === 'checking') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-slate-400 text-sm animate-pulse">Loading...</div>
      </div>
    );
  }
  if (authState === 'unauthenticated') {
    return <LoginPage onLogin={handleLogin} />;
  }

  return <AppShell currentUser={currentUser!} onLogout={handleLogout} />;
}

function AppShell({ currentUser, onLogout }: { currentUser: { username: string; host: string; demo?: boolean }; onLogout: () => void }) {
  const [activeTab, setActiveTab] = useState('setup');
  const [accounts, setAccounts] = useState<AccountConfig[]>(loadSavedAccounts);
  const [exporting, setExporting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [loadingAccounts, setLoadingAccounts] = useState<Record<string, boolean>>({});
  const [loadStatus, setLoadStatus] = useState<Record<string, 'ok' | 'error'>>({});

  // Persist accounts to localStorage whenever they change
  useEffect(() => {
    const valid = accounts.filter(a => a.name.trim());
    if (valid.length > 0) {
      localStorage.setItem('demandplan_accounts', JSON.stringify(accounts));
    }
  }, [accounts]);

  // On startup, check each saved account for cached data and restore loadStatus
  useEffect(() => {
    const validAccounts = accounts.filter(a => (a.sfdc_id || a.name).trim());
    if (validAccounts.length === 0) return;
    validAccounts.forEach(async (acct) => {
      const key = acct.sfdc_id || acct.name;
      try {
        const res = await fetchConsumption(key); // no refresh — uses server cache/disk
        if (res.data && res.data.length > 0) {
          setLoadStatus(prev => ({ ...prev, [key]: 'ok' }));
        }
      } catch { /* ignore — account just won't show as loaded */ }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

  const updateAccount = (index: number, field: keyof AccountConfig, value: string) => {
    setAccounts(prev => prev.map((a, i) => i === index ? { ...a, [field]: value } : a));
  };

  const addAccount = () => {
    setAccounts(prev => [...prev, { name: '', sfdc_id: '', contractStartDate: '', contractMonths: 36 }]);
  };

  const removeAccount = (index: number) => {
    if (accounts.length <= 1) return;
    setAccounts(prev => prev.filter((_, i) => i !== index));
  };

  const handleLoadAccount = useCallback(async (acct: AccountConfig) => {
    const key = acct.sfdc_id;
    setLoadingAccounts(prev => ({ ...prev, [key]: true }));
    setLoadStatus(prev => { const n = { ...prev }; delete n[key]; return n; });
    try {
      await fetchConsumption(acct.sfdc_id, true);
      setLoadStatus(prev => ({ ...prev, [key]: 'ok' }));
      window.location.reload();
    } catch {
      setLoadStatus(prev => ({ ...prev, [key]: 'error' }));
    } finally {
      setLoadingAccounts(prev => ({ ...prev, [key]: false }));
    }
  }, []);

  const handleClearAll = useCallback(async () => {
    if (!window.confirm('Clear all cached data and reset accounts? This cannot be undone.')) return;
    setClearing(true);
    try {
      await fetch('/api/clear-data', { method: 'DELETE' });
    } catch { /* ignore network errors */ }
    localStorage.removeItem('demandplan_accounts');
    setAccounts([{ name: '', sfdc_id: '', contractStartDate: '', contractMonths: 36 }]);
    setClearing(false);
    window.location.reload();
  }, []);

  // Shared data-fetch + projection builder used by both export handlers
  const buildExportPayload = useCallback(async () => {
    const activeAccounts = accounts.filter(a => a.name.trim() || a.sfdc_id.trim());

    const buildAccountData = async (acct: AccountConfig) => {
      const accountId = acct.sfdc_id || acct.name;

      const [consumptionRes, mappingRes, s1Res, s2Res, s3Res] = await Promise.all([
        fetchConsumption(accountId),
        fetchDomainMap(accountId),
        fetchScenario(accountId, 1),
        fetchScenario(accountId, 2),
        fetchScenario(accountId, 3),
      ]);

      const historicalData = consumptionRes.data || [];
      const domainMapping: Record<string, string> = {};
      const wsCloud: Record<string, string> = {};
      const wsOrg: Record<string, string> = {};
      (mappingRes.mapping || []).forEach((r: any) => {
        domainMapping[r.workspace] = r.domain;
        if (r.cloudtype) wsCloud[r.workspace] = r.cloudtype;
        if (r.org) wsOrg[r.workspace] = r.org;
      });

      const domMonthly: Record<string, Record<string, number>> = {};
      historicalData.forEach((row: any) => {
        const domain = domainMapping[row.workspace_name] || 'Unmapped';
        if (!domMonthly[domain]) domMonthly[domain] = {};
        domMonthly[domain][row.month] = (domMonthly[domain][row.month] || 0) + (parseFloat(row.dollar_dbu_list) || 0);
      });
      // Find last complete month (exclude current in-flight partial month)
      const currentMonthStr = new Date().toISOString().slice(0, 7);
      const allDataMonths = new Set<string>();
      historicalData.forEach((row: any) => { if (row.month) allDataMonths.add(row.month); });
      const completeMonths = [...allDataMonths].filter(m => m < currentMonthStr).sort();
      const useMonths = completeMonths.length > 0 ? completeMonths : [...allDataMonths].sort();
      const lastCompleteMonth = useMonths[useMonths.length - 1] || '';
      // Last complete month totals — both $ and DBU
      const lastCompleteValue = historicalData
        .filter((r: any) => r.month === lastCompleteMonth)
        .reduce((s: number, r: any) => s + (parseFloat(r.dollar_dbu_list) || 0), 0);
      const lastCompleteDbu = historicalData
        .filter((r: any) => r.month === lastCompleteMonth)
        .reduce((s: number, r: any) => s + (parseFloat(r.total_dbus) || 0), 0);

      const domainBaselines = Object.entries(domMonthly).map(([domain, mData]) => {
        const t12m = Object.values(mData).reduce((s, v) => s + v, 0);
        return { domain, t12m, avgMonthly: t12m / Math.max(Object.keys(mData).length, 1) };
      }).sort((a, b) => b.t12m - a.t12m);

      // n_offset: gap from last complete month to contract start date
      const contractStart = acct.contractStartDate || '';
      let nOffset = 1; // default: 1 month forward
      if (lastCompleteMonth && contractStart) {
        const [fy, fm] = lastCompleteMonth.split('-').map(Number);
        const [ty, tm] = contractStart.split('-').map(Number);
        nOffset = Math.max((ty * 12 + tm) - (fy * 12 + fm), 0);
      }

      const scenarioRess = [s1Res, s2Res, s3Res];
      const scenariosData = ([1, 2, 3] as const).map((sNum, idx) => {
        const sr = scenarioRess[idx];
        const growthRate = sr.baseline_growth_rate || 0.005;
        const momRate = growthRate;
        const baselineAdj = sr.baseline_adjustment || 0;
        const adjustedBase = lastCompleteValue * (1 + baselineAdj);
        const adjustedBaseDbu = lastCompleteDbu * (1 + baselineAdj);
        const overridesMap: Record<number, number> = {};
        (sr.baseline_overrides || []).forEach((o: any) => { overridesMap[o.month_index] = o.value; });
        // overrides store % — apply same % to both $ and DBU
        const baselineMonths = Array.from({ length: 36 }, (_, i) => {
          const computed = adjustedBase * Math.pow(1 + momRate, nOffset + i);
          return i in overridesMap ? computed * (1 + overridesMap[i] / 100) : computed;
        });
        const baselineDbuMonths = Array.from({ length: 36 }, (_, i) => {
          const computed = adjustedBaseDbu * Math.pow(1 + momRate, nOffset + i);
          return i in overridesMap ? computed * (1 + overridesMap[i] / 100) : computed;
        });

        const allUCs = (sr.new_use_cases || []).map((uc: any) => ({
          ...uc,
          steadyStateDbu: uc.steadyStateDbu || uc.steady_state_dbu || 0,
          onboardingMonth: uc.onboardingMonth || uc.onboarding_month || 1,
          liveMonth: uc.liveMonth || uc.live_month || 6,
          rampType: uc.rampType || uc.ramp_type || 'linear',
          scenarios: uc.scenarios || [true, false, false],
          monthlyProjection: calcUseCaseMonthly(uc),
        }));
        const activeUseCases = allUCs.filter((uc: any) => uc.scenarios[sNum - 1]);

        const ucMonths = new Array(36).fill(0);
        activeUseCases.forEach((uc: any) => {
          uc.monthlyProjection.forEach((v: number, i: number) => { ucMonths[i] += v; });
        });

        const totalMonths = baselineMonths.map((b, i) => b + ucMonths[i]);
        const baseYearTotals = [0, 0, 0], ucYearTotals = [0, 0, 0], yearTotals = [0, 0, 0];
        for (let i = 0; i < 36; i++) {
          const y = Math.floor(i / 12);
          baseYearTotals[y] += baselineMonths[i];
          ucYearTotals[y] += ucMonths[i];
          yearTotals[y] += totalMonths[i];
        }

        const baselineOverrides: Record<number, number> = {};
        (sr.baseline_overrides || []).forEach((o: any) => { baselineOverrides[o.month_index] = o.value; });

        return {
          scenarioNum: sNum,
          assumptions: sr.assumptions_text || '',
          baselineGrowthRate: growthRate * 100,
          activeUseCases,
          baselineMonths, baselineDbuMonths, totalMonths, baseYearTotals, ucYearTotals, yearTotals,
          baselineOverrides,
        };
      });

      const allUseCases = (s1Res.new_use_cases || []).map((uc: any) => ({
        ...uc,
        steadyStateDbu: uc.steadyStateDbu || uc.steady_state_dbu || 0,
        onboardingMonth: uc.onboardingMonth || uc.onboarding_month || 1,
        liveMonth: uc.liveMonth || uc.live_month || 6,
        rampType: uc.rampType || uc.ramp_type || 'linear',
        scenarios: uc.scenarios || [true, false, false],
        upliftOnly: uc.upliftOnly ?? uc.uplift_only ?? false,
        description: uc.description || '',
        assumptions: uc.assumptions || '',
        adhocPeriods: (uc.adhocPeriods || uc.adhoc_periods || []).map((p: any) => ({
          id: p.id || '',
          label: p.label || '',
          months: p.months || [],
          skuAmounts: (p.skuAmounts || p.sku_amounts || []).map((sa: any) => ({
            sku: sa.sku || '',
            dbuPerMonth: sa.dbuPerMonth || sa.dbu_per_month || 0,
            dollarPerMonth: sa.dollarPerMonth || sa.dollar_per_month || 0,
          })),
        })),
        skuBreakdown: (uc.skuBreakdown || uc.sku_breakdown || []).map((s: any) => ({
          sku: s.sku || '',
          percentage: s.percentage || 0,
          dbus: s.dbus || 0,
          dollarDbu: s.dollarDbu || s.dollar_dbu || 0,
          overridePrice: s.overridePrice ?? s.override_price ?? undefined,
        })),
        monthlyProjection: calcUseCaseMonthly(uc),
      }));

      return { accountName: acct.name, contractStartDate: acct.contractStartDate || '', historicalData, domainMapping, wsCloud, wsOrg, domainBaselines, allUseCases, scenariosData };
    };

    const accountsData = await Promise.all(activeAccounts.map(buildAccountData));
    const account = activeAccounts[0]?.name || 'Unknown';
    return { account, accountsData };
  }, [accounts]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const payload = await buildExportPayload();
      await exportToExcelJS({ accounts, ...payload });
    } catch (e: any) {
      console.error('Export failed:', e);
      alert('Export failed: ' + e.message);
    } finally {
      setExporting(false);
    }
  }, [accounts, buildExportPayload]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Demand Plan App</h1>
              <p className="text-sm text-gray-500 mt-1">Databricks Consumption Planning & Forecasting</p>
            </div>
            {/* User badge + logout */}
            <div className="flex items-center gap-2 ml-auto mr-4 mt-1">
              <span className="text-xs text-slate-500">Signed in as</span>
              <span className="text-xs font-semibold text-slate-700 bg-slate-100 px-2 py-1 rounded-full">{currentUser.username}</span>
              <button
                onClick={onLogout}
                className="text-xs text-slate-400 hover:text-red-600 transition-colors ml-1"
                title="Sign out"
              >
                Sign out
              </button>
            </div>
            <div className="flex items-start gap-4">
              {/* Accounts — read-only chips, managed in Setup tab */}
              <div className="flex items-center gap-2 mt-4">
                <span className="text-xs font-medium text-gray-500">Accounts:</span>
                {accounts.filter(a => a.name.trim()).map((acct, idx) => (
                  <span key={idx} className="px-3 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-full text-xs font-semibold">
                    {acct.name}
                  </span>
                ))}
              </div>

              {/* Clear All Data Button */}
              <div className="mt-4">
                <button
                  onClick={handleClearAll}
                  disabled={clearing}
                  className="flex items-center gap-2 px-4 py-2 bg-red-50 text-red-600 border border-red-200 rounded-md text-sm font-medium hover:bg-red-100 disabled:opacity-50"
                  title="Clear all cached data and reset accounts"
                >
                  {clearing ? (
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  )}
                  Clear All
                </button>
              </div>

              {/* Feedback + Export Buttons */}
              <div className="mt-4 flex items-center gap-2">
                <a
                  href="https://docs.google.com/forms/d/e/1FAIpQLSefrzCnnS27vwSL2Bcr-uRbjwHgkbrh4GJW4qTadpOFlQue8A/viewform"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-4 py-2 border border-slate-300 text-slate-600 rounded-md text-sm font-medium hover:bg-slate-50 hover:border-slate-400 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                  </svg>
                  Feedback
                </a>
                <button
                  onClick={handleExport}
                  disabled={exporting}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
                >
                  {exporting ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Exporting...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      Export XLS
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>



      {/* Tab Bar */}
      <nav className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex space-x-1 overflow-x-auto">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </nav>

      {/* Tab Content */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        {activeTab === 'setup' && <SetupTab accounts={accounts} setAccounts={setAccounts} onLoadAccount={handleLoadAccount} loadingAccounts={loadingAccounts} loadStatus={loadStatus} isDemo={currentUser.demo ?? false} />}
        {activeTab === 'summary' && <SummaryTab accounts={accounts} setAccounts={setAccounts} />}
        {activeTab === 'historical' && <HistoricalTab accounts={accounts} />}
        {activeTab === 'scenario' && <ScenarioTab accounts={accounts} isDemo={currentUser.demo ?? false} />}
        {activeTab === 'consumption-forecast' && <ConsumptionForecastTab accounts={accounts} />}
        {activeTab === 'overview' && <OverviewTab accounts={accounts} />}
      </main>
    </div>
  );
}
