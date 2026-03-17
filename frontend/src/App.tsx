import React, { useState, useCallback } from 'react';
import SummaryTab from './components/SummaryTab';
import HistoricalTab from './components/HistoricalTab';
import ScenarioTab from './components/ScenarioTab';
// ForecastTab removed
import OverviewTab from './components/OverviewTab';
import { exportToXLS } from './export';
import { fetchConsumption, fetchDomainMapping, fetchScenario } from './api';

export interface AccountConfig {
  name: string;
  sheetUrl: string;
}

const TABS = [
  { id: 'summary', label: 'Demand Plan Summary' },
  { id: 'historical', label: 'Historical Consumption (T12M)' },
  { id: 'scenario', label: 'Scenario Builder' },
  { id: 'overview', label: 'Account Overview' },
];

const DEFAULT_ACCOUNTS: AccountConfig[] = [
  { name: 'Kroger', sheetUrl: '' },
  { name: '84.51', sheetUrl: '' },
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

export default function App() {
  const [activeTab, setActiveTab] = useState('summary');
  const [accounts, setAccounts] = useState<AccountConfig[]>(DEFAULT_ACCOUNTS);
  const [exporting, setExporting] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  const updateAccount = (index: number, field: keyof AccountConfig, value: string) => {
    setAccounts(prev => prev.map((a, i) => i === index ? { ...a, [field]: value } : a));
  };

  const addAccount = () => {
    setAccounts(prev => [...prev, { name: '', sheetUrl: '' }]);
  };

  const removeAccount = (index: number) => {
    if (accounts.length <= 1) return;
    setAccounts(prev => prev.filter((_, i) => i !== index));
  };

  const handleExportXLS = useCallback(async (scenarioNum: number) => {
    setExporting(true);
    setShowExportMenu(false);
    try {
      // Export using the first account for historical data (summary sheet shows all)
      const account = accounts[0]?.name || 'Unknown';
      const sheetUrl = accounts[0]?.sheetUrl || '';

      // Fetch all data
      const [consumptionRes, mappingRes, scenarioRes] = await Promise.all([
        fetchConsumption(account),
        sheetUrl ? fetchDomainMapping(sheetUrl) : Promise.resolve({ mapping: [] }),
        fetchScenario(account, scenarioNum),
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

      // Build domain baselines
      const domMonthly: Record<string, Record<string, number>> = {};
      historicalData.forEach((row: any) => {
        const domain = domainMapping[row.workspace_name] || 'Unmapped';
        if (!domMonthly[domain]) domMonthly[domain] = {};
        domMonthly[domain][row.month] = (domMonthly[domain][row.month] || 0) + (parseFloat(row.dollar_dbu_list) || 0);
      });
      const domainBaselines = Object.entries(domMonthly).map(([domain, mData]) => {
        const t12m = Object.values(mData).reduce((s, v) => s + v, 0);
        const monthCount = Object.keys(mData).length;
        return { domain, t12m, avgMonthly: t12m / Math.max(monthCount, 1) };
      }).sort((a, b) => b.t12m - a.t12m);

      // Build use cases with monthly projections
      const useCases = (scenarioRes.new_use_cases || []).map((uc: any) => ({
        ...uc,
        steadyStateDbu: uc.steadyStateDbu || uc.steady_state_dbu || 0,
        onboardingMonth: uc.onboardingMonth || uc.onboarding_month || 1,
        liveMonth: uc.liveMonth || uc.live_month || 6,
        rampType: uc.rampType || uc.ramp_type || 'linear',
        scenarios: uc.scenarios || [true, false, false],
        monthlyProjection: calcUseCaseMonthly(uc),
      }));

      // Build projections
      const growthRate = scenarioRes.baseline_growth_rate || 0.02;
      const momRate = growthRate / 12;
      const totalBaseMonthly = domainBaselines.reduce((s, b) => s + b.avgMonthly, 0);
      const baselineMonths = Array.from({ length: 36 }, (_, i) => totalBaseMonthly * Math.pow(1 + momRate, i + 1));

      const ucMonths = new Array(36).fill(0);
      useCases.filter((uc: any) => uc.scenarios[scenarioNum - 1]).forEach((uc: any) => {
        const ucM = calcUseCaseMonthly(uc);
        ucM.forEach((v: number, i: number) => { ucMonths[i] += v; });
      });

      const totalMonths = baselineMonths.map((b, i) => b + ucMonths[i]);
      const baseYearTotals = [0, 0, 0];
      const ucYearTotals = [0, 0, 0];
      const yearTotals = [0, 0, 0];
      for (let i = 0; i < 36; i++) {
        const y = Math.floor(i / 12);
        baseYearTotals[y] += baselineMonths[i];
        ucYearTotals[y] += ucMonths[i];
        yearTotals[y] += totalMonths[i];
      }

      const filename = await exportToXLS({
        accounts,
        account,
        scenario: scenarioNum,
        historicalData,
        domainMapping,
        wsCloud,
        wsOrg,
        baselineGrowthRate: growthRate * 100,
        assumptions: scenarioRes.assumptions_text || '',
        domainBaselines,
        useCases,
        projections: { baseYearTotals, ucYearTotals, yearTotals, baselineMonths, totalMonths },
      });

      console.log('Exported:', filename);
    } catch (e: any) {
      console.error('Export failed:', e);
      alert('Export failed: ' + e.message);
    } finally {
      setExporting(false);
    }
  }, [accounts]);

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
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={acct.name}
                      onChange={(e) => updateAccount(idx, 'name', e.target.value)}
                      placeholder="Account name"
                      className="border border-gray-300 rounded-md px-3 py-1.5 text-sm font-semibold text-blue-700 bg-blue-50 w-32"
                    />
                    <input
                      type="text"
                      value={acct.sheetUrl}
                      onChange={(e) => updateAccount(idx, 'sheetUrl', e.target.value)}
                      placeholder="Sheet URL (optional)"
                      className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-64"
                    />
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
                  <div className="absolute right-0 mt-1 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
                    <div className="px-3 py-2 text-xs font-medium text-gray-400 uppercase">Download as Excel</div>
                    {[1, 2, 3].map(s => (
                      <button key={s} onClick={() => handleExportXLS(s)}
                        className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                        <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Scenario {s} — Full Export
                      </button>
                    ))}
                    <div className="border-t my-1" />
                    <div className="px-3 py-1.5 text-[10px] text-gray-400">
                      Includes: Summary, Historical (Domain/SKU/Cloud), 36-Month Projections, Use Cases, Baselines
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
        {activeTab === 'overview' && <OverviewTab accounts={accounts} />}
      </main>
    </div>
  );
}
