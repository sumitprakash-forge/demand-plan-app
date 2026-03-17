import React, { useEffect, useState } from 'react';
import { fetchSummaryAll, fetchDomainMapping, formatCurrency } from '../api';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';

const COLORS = [
  '#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899',
  '#06B6D4', '#84CC16', '#F97316', '#6366F1', '#14B8A6', '#E11D48',
  '#0EA5E9', '#A855F7', '#22C55E', '#D946EF', '#64748B', '#FB923C',
  '#2DD4BF', '#818CF8', '#F472B6', '#34D399', '#FACC15', '#C084FC',
  '#38BDF8', '#4ADE80', '#FB7185',
];

const SCENARIO_COLORS = ['#3B82F6', '#8B5CF6', '#10B981'];

interface Props {
  account: string;
  sheetUrl: string;
  setSheetUrl: (url: string) => void;
}

export default function SummaryTab({ account, sheetUrl, setSheetUrl }: Props) {
  const [allData, setAllData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mappingLoaded, setMappingLoaded] = useState(false);

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      if (!mappingLoaded && sheetUrl) {
        try {
          await fetchDomainMapping(sheetUrl);
          setMappingLoaded(true);
        } catch (e: any) {
          console.warn('Domain mapping load warning:', e.message);
        }
      }
      const result = await fetchSummaryAll(account);
      setAllData(result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [account]);

  // Build comparison bar chart data from all 3 scenarios
  const comparisonChartData = allData?.scenarios
    ? ['Year 1', 'Year 2', 'Year 3'].map((label, yi) => {
        const entry: any = { year: label };
        allData.scenarios.forEach((s: any, si: number) => {
          const grandTotal = s.summary_rows.find((r: any) => r.use_case_area === 'Grand Total');
          const yearKey = ['year1', 'year2', 'year3'][yi];
          entry[`scenario${si + 1}`] = grandTotal ? grandTotal[yearKey] : 0;
        });
        return entry;
      })
    : [];

  // Use domain breakdown from scenario 1 (baseline is the same for all)
  const domainBreakdown = allData?.scenarios?.[0]?.domain_breakdown || [];

  return (
    <div className="space-y-6">
      {/* Config Bar */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Account Name</label>
            <input
              type="text"
              value={account}
              readOnly
              className="w-full border border-gray-300 rounded-md px-3 py-2 bg-gray-50 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Domain Mapping Sheet URL</label>
            <input
              type="text"
              value={sheetUrl}
              onChange={(e) => setSheetUrl(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
              placeholder="Google Sheets URL"
            />
          </div>
          <div>
            <button
              onClick={loadData}
              className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      {loading && <div className="text-center py-8 text-gray-500">Loading summary data...</div>}
      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">{error}</div>}

      {allData && allData.scenarios && (
        <>
          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Domain Breakdown Pie */}
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Domain Breakdown (T12M)</h3>
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
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Yearly $DBU Comparison — All Scenarios</h3>
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
          {allData.scenarios.map((scenarioData: any, idx: number) => {
            const scenarioNum = idx + 1;
            const description = scenarioData.description || `Scenario ${scenarioNum}`;
            const grandTotal = scenarioData.summary_rows.find((r: any) => r.use_case_area === 'Grand Total');

            // Separate baseline and use case rows
            const baselineRow = scenarioData.summary_rows.find(
              (r: any) => !r.is_use_case && r.use_case_area !== 'Grand Total' && r.use_case_area !== 'New Use Cases'
            );
            const useCaseRows = scenarioData.summary_rows.filter((r: any) => r.is_use_case);

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

                {/* SUMMARY box */}
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
                      <tr className="border-t">
                        <td className="py-2 pr-4 text-sm font-medium text-gray-900">{account}</td>
                        <td className="py-2 text-sm text-right">{grandTotal ? formatCurrency(grandTotal.year1) : '$0'}</td>
                        <td className="py-2 text-sm text-right">{grandTotal ? formatCurrency(grandTotal.year2) : '$0'}</td>
                        <td className="py-2 text-sm text-right">{grandTotal ? formatCurrency(grandTotal.year3) : '$0'}</td>
                        <td className="py-2 text-sm text-right font-semibold">{grandTotal ? formatCurrency(grandTotal.total) : '$0'}</td>
                      </tr>
                      <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                        <td className="py-2 pr-4 text-sm">Grand Total</td>
                        <td className="py-2 text-sm text-right">{grandTotal ? formatCurrency(grandTotal.year1) : '$0'}</td>
                        <td className="py-2 text-sm text-right">{grandTotal ? formatCurrency(grandTotal.year2) : '$0'}</td>
                        <td className="py-2 text-sm text-right">{grandTotal ? formatCurrency(grandTotal.year3) : '$0'}</td>
                        <td className="py-2 text-sm text-right">{grandTotal ? formatCurrency(grandTotal.total) : '$0'}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Detail table: Use Case Areas */}
                <div className="px-4 pb-4">
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
                      {/* Use Case Areas header */}
                      <tr className="border-t bg-gray-50">
                        <td colSpan={5} className="py-2 text-sm font-semibold text-gray-700">
                          Use Case Areas ({account.toUpperCase()})
                        </td>
                      </tr>
                      {/* Existing - Live Use Cases (baseline) */}
                      {baselineRow && (
                        <tr className="border-t hover:bg-gray-50">
                          <td className="py-2 pr-4 text-sm text-gray-800">Existing - Live Use Cases</td>
                          <td className="py-2 text-sm text-right">{formatCurrency(baselineRow.year1)}</td>
                          <td className="py-2 text-sm text-right">{formatCurrency(baselineRow.year2)}</td>
                          <td className="py-2 text-sm text-right">{formatCurrency(baselineRow.year3)}</td>
                          <td className="py-2 text-sm text-right font-semibold">{formatCurrency(baselineRow.total)}</td>
                        </tr>
                      )}
                      {/* Each active use case */}
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
                      {/* Total row */}
                      <tr className="border-t-2 border-gray-300 bg-blue-50 font-bold">
                        <td className="py-2 pr-4 text-sm">Total $DBUs (DBCU at List)</td>
                        <td className="py-2 text-sm text-right">{grandTotal ? formatCurrency(grandTotal.year1) : '$0'}</td>
                        <td className="py-2 text-sm text-right">{grandTotal ? formatCurrency(grandTotal.year2) : '$0'}</td>
                        <td className="py-2 text-sm text-right">{grandTotal ? formatCurrency(grandTotal.year3) : '$0'}</td>
                        <td className="py-2 text-sm text-right">{grandTotal ? formatCurrency(grandTotal.total) : '$0'}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
