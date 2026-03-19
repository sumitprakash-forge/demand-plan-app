import React, { useState, useCallback, useEffect } from 'react';
import SummaryTab from './components/SummaryTab';
import HistoricalTab from './components/HistoricalTab';
import ScenarioTab from './components/ScenarioTab';
// ForecastTab removed
import OverviewTab from './components/OverviewTab';
import ConsumptionForecastTab from './components/ConsumptionForecastTab';
import { exportToXLS } from './export';
import { exportToExcelJS } from './exportExcelJS';
import { fetchConsumption, fetchDomainMapping, fetchScenario } from './api';

export interface AccountConfig {
  name: string;        // Display name
  sfdc_id: string;     // SFDC Account ID — always used as the backend key for all data
  sheetUrl: string;
  contractStartDate: string; // YYYY-MM, e.g. "2026-04" — defines M1 of Year 1
}

const TABS = [
  { id: 'summary', label: 'Demand Plan Summary' },
  { id: 'historical', label: 'Historical Consumption (T12M)' },
  { id: 'scenario', label: 'Scenario Builder' },
  { id: 'consumption-forecast', label: 'Consumption Forecast' },
  { id: 'overview', label: 'Account Overview' },
];

const DEFAULT_ACCOUNTS: AccountConfig[] = [
  { name: 'Kroger', sfdc_id: 'Kroger', sheetUrl: '', contractStartDate: '' },
];

// Calculate use case monthly projection (same logic as ScenarioTab)
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
  return [{ name: '', sfdc_id: '', sheetUrl: '', contractStartDate: '' }];
}

export default function App() {
  const [activeTab, setActiveTab] = useState('summary');
  const [accounts, setAccounts] = useState<AccountConfig[]>(loadSavedAccounts);
  const [exporting, setExporting] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
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

  const updateAccount = (index: number, field: keyof AccountConfig, value: string) => {
    setAccounts(prev => prev.map((a, i) => i === index ? { ...a, [field]: value } : a));
  };

  const addAccount = () => {
    setAccounts(prev => [...prev, { name: '', sfdc_id: '', sheetUrl: '', contractStartDate: '' }]);
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
      if (acct.sheetUrl) await fetchDomainMapping(acct.sheetUrl);
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
    setAccounts([{ name: '', sfdc_id: '', sheetUrl: '', contractStartDate: '' }]);
    setClearing(false);
    window.location.reload();
  }, []);

  // Shared data-fetch + projection builder used by both export handlers
  const buildExportPayload = useCallback(async () => {
    const account = accounts[0]?.sfdc_id || 'Unknown';
    const sheetUrl = accounts[0]?.sheetUrl || '';

    const [consumptionRes, mappingRes, s1Res, s2Res, s3Res] = await Promise.all([
      fetchConsumption(account),
      sheetUrl ? fetchDomainMapping(sheetUrl) : Promise.resolve({ mapping: [] }),
      fetchScenario(account, 1),
      fetchScenario(account, 2),
      fetchScenario(account, 3),
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
    const domainBaselines = Object.entries(domMonthly).map(([domain, mData]) => {
      const t12m = Object.values(mData).reduce((s, v) => s + v, 0);
      return { domain, t12m, avgMonthly: t12m / Math.max(Object.keys(mData).length, 1) };
    }).sort((a, b) => b.t12m - a.t12m);

    const totalBaseMonthly = domainBaselines.reduce((s, b) => s + b.avgMonthly, 0);

    const scenarioRess = [s1Res, s2Res, s3Res];
    const scenariosData = ([1, 2, 3] as const).map((sNum, idx) => {
      const sr = scenarioRess[idx];
      const growthRate = sr.baseline_growth_rate || 0.02;
      const momRate = growthRate / 12;
      const baselineMonths = Array.from({ length: 36 }, (_, i) => totalBaseMonthly * Math.pow(1 + momRate, i + 1));

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

      return {
        scenarioNum: sNum,
        assumptions: sr.assumptions_text || '',
        baselineGrowthRate: growthRate * 100,
        activeUseCases,
        baselineMonths, totalMonths, baseYearTotals, ucYearTotals, yearTotals,
      };
    });

    // allUseCases: use S1's list (most complete — others copy from it)
    const allUseCases = (s1Res.new_use_cases || []).map((uc: any) => ({
      ...uc,
      steadyStateDbu: uc.steadyStateDbu || uc.steady_state_dbu || 0,
      onboardingMonth: uc.onboardingMonth || uc.onboarding_month || 1,
      liveMonth: uc.liveMonth || uc.live_month || 6,
      rampType: uc.rampType || uc.ramp_type || 'linear',
      scenarios: uc.scenarios || [true, false, false],
      monthlyProjection: calcUseCaseMonthly(uc),
    }));

    return { account, historicalData, domainMapping, wsCloud, wsOrg, domainBaselines, allUseCases, scenariosData };
  }, [accounts]);

  const handleExportFormatted = useCallback(async () => {
    setExporting(true);
    setShowExportMenu(false);
    try {
      const payload = await buildExportPayload();
      const filename = await exportToExcelJS({ accounts, ...payload });
      console.log('Formatted export:', filename);
    } catch (e: any) {
      console.error('Formatted export failed:', e);
      alert('Export failed: ' + e.message);
    } finally {
      setExporting(false);
    }
  }, [accounts, buildExportPayload]);

  const handleExportXLS = useCallback(async () => {
    setExporting(true);
    setShowExportMenu(false);
    try {
      const payload = await buildExportPayload();
      const filename = await exportToXLS({ accounts, ...payload });
      console.log('Basic export:', filename);
    } catch (e: any) {
      console.error('Basic export failed:', e);
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
            <div className="flex items-start gap-4">
              {/* Multi-Account Configuration */}
              <div className="space-y-2">
                <label className="block text-xs font-medium text-gray-500 mb-1">Accounts</label>
                {accounts.map((acct, idx) => (
                  <div key={idx} className="flex items-center gap-2 mb-1">
                    <input
                      type="text"
                      value={acct.name}
                      onChange={(e) => updateAccount(idx, 'name', e.target.value)}
                      placeholder="Display name"
                      className="border border-gray-300 rounded-md px-3 py-1.5 text-sm font-semibold text-blue-700 bg-blue-50 w-28"
                      title="Display name for this account"
                    />
                    <input
                      type="text"
                      value={acct.sfdc_id}
                      onChange={(e) => updateAccount(idx, 'sfdc_id', e.target.value)}
                      placeholder="SFDC Account ID or Name"
                      className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-48 font-mono text-xs"
                      title="SFDC Account ID (18-char) or exact account name in Logfood"
                    />
                    <input
                      type="text"
                      value={acct.sheetUrl}
                      onChange={(e) => updateAccount(idx, 'sheetUrl', e.target.value)}
                      placeholder="Domain Mapping Sheet URL"
                      className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-56"
                    />
                    <button
                      onClick={() => handleLoadAccount(acct)}
                      disabled={!acct.sfdc_id.trim() || loadingAccounts[acct.sfdc_id]}
                      className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors
                        ${loadStatus[acct.sfdc_id] === 'ok' ? 'bg-green-50 text-green-700 border-green-300' :
                          loadStatus[acct.sfdc_id] === 'error' ? 'bg-red-50 text-red-600 border-red-300' :
                          'bg-blue-50 text-blue-700 border-blue-300 hover:bg-blue-100'}
                        disabled:opacity-40`}
                      title="Load data for this account"
                    >
                      {loadingAccounts[acct.sfdc_id] ? (
                        <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                      ) : loadStatus[acct.sfdc_id] === 'ok' ? (
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : loadStatus[acct.sfdc_id] === 'error' ? (
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      ) : (
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                        </svg>
                      )}
                      {loadingAccounts[acct.sfdc_id] ? 'Loading…' : loadStatus[acct.sfdc_id] === 'ok' ? 'Loaded' : loadStatus[acct.sfdc_id] === 'error' ? 'Failed' : 'Load'}
                    </button>
                    {accounts.length > 1 && (
                      <button
                        onClick={() => removeAccount(idx)}
                        className="text-red-400 hover:text-red-600 text-sm px-1"
                        title="Remove account"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
                <button
                  onClick={addAccount}
                  className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                >
                  + Add Account
                </button>
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

              {/* Export Button */}
              <div className="relative">
                <button
                  onClick={() => setShowExportMenu(!showExportMenu)}
                  disabled={exporting}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50 mt-4"
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
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </>
                  )}
                </button>

                {showExportMenu && (
                  <div className="absolute right-0 mt-1 w-60 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
                    <button onClick={handleExportFormatted}
                      className="w-full text-left px-4 py-3 text-sm text-gray-700 hover:bg-indigo-50 flex items-center gap-3">
                      <svg className="w-5 h-5 text-indigo-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                      </svg>
                      <div>
                        <div className="font-medium text-indigo-700">Formatted Export</div>
                        <div className="text-[11px] text-gray-400">Colors, headers, freeze panes</div>
                      </div>
                    </button>
                    <div className="border-t border-gray-100" />
                    <button onClick={handleExportXLS}
                      className="w-full text-left px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-3">
                      <svg className="w-5 h-5 text-green-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <div>
                        <div className="font-medium">Basic Export</div>
                        <div className="text-[11px] text-gray-400">Plain data, all scenarios</div>
                      </div>
                    </button>
                    <div className="border-t border-gray-100 mt-1" />
                    <div className="px-4 py-1.5 text-[10px] text-gray-400">
                      Exports all 3 scenarios · 10 sheets
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Click outside to close menu */}
      {showExportMenu && <div className="fixed inset-0 z-40" onClick={() => setShowExportMenu(false)} />}

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
        {activeTab === 'summary' && <SummaryTab accounts={accounts} setAccounts={setAccounts} />}
        {activeTab === 'historical' && <HistoricalTab accounts={accounts} />}
        {activeTab === 'scenario' && <ScenarioTab accounts={accounts} />}
        {activeTab === 'consumption-forecast' && <ConsumptionForecastTab accounts={accounts} />}
        {activeTab === 'overview' && <OverviewTab accounts={accounts} />}
      </main>
    </div>
  );
}
