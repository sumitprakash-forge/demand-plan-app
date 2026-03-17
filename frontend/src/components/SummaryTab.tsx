import React, { useEffect, useState } from 'react';
import { fetchSummary, fetchDomainMapping, formatCurrency } from '../api';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';

const COLORS = [
  '#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899',
  '#06B6D4', '#84CC16', '#F97316', '#6366F1', '#14B8A6', '#E11D48',
  '#0EA5E9', '#A855F7', '#22C55E', '#D946EF', '#64748B', '#FB923C',
  '#2DD4BF', '#818CF8', '#F472B6', '#34D399', '#FACC15', '#C084FC',
  '#38BDF8', '#4ADE80', '#FB7185',
];

interface Props {
  account: string;
  sheetUrl: string;
  setSheetUrl: (url: string) => void;
}

export default function SummaryTab({ account, sheetUrl, setSheetUrl }: Props) {
  const [scenario, setScenario] = useState(1);
  const [data, setData] = useState<any>(null);
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
      const result = await fetchSummary(account, scenario);
      setData(result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [account, scenario]);

  return (
    <div className="space-y-6">
      {/* Config Bar */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Scenario</label>
            <div className="flex gap-2">
              {[1, 2, 3].map((s) => (
                <button
                  key={s}
                  onClick={() => setScenario(s)}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                    scenario === s
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Scenario {s}
                </button>
              ))}
              <button
                onClick={loadData}
                className="ml-auto px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700"
              >
                Refresh
              </button>
            </div>
          </div>
        </div>
      </div>

      {loading && <div className="text-center py-8 text-gray-500">Loading summary data...</div>}
      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">{error}</div>}

      {data && (
        <>
          {/* Summary Table */}
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b">
              <h2 className="text-lg font-semibold text-gray-900">
                Demand Plan Summary — Scenario {scenario}
              </h2>
              <p className="text-sm text-gray-500">T12M Base: {formatCurrency(data.total_t12m)} | Growth Rate: {(data.growth_rate * 100).toFixed(0)}%</p>
            </div>
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 text-left text-sm font-medium text-gray-500">
                  <th className="px-4 py-3">Use Case Area</th>
                  <th className="px-4 py-3 text-right">$DBUs Year 1</th>
                  <th className="px-4 py-3 text-right">$DBUs Year 2</th>
                  <th className="px-4 py-3 text-right">$DBUs Year 3</th>
                  <th className="px-4 py-3 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.summary_rows.map((row: any, i: number) => (
                  <tr
                    key={i}
                    className={`border-t ${
                      row.use_case_area === 'Grand Total'
                        ? 'bg-blue-50 font-bold'
                        : 'hover:bg-gray-50'
                    }`}
                  >
                    <td className="px-4 py-3 text-sm">{row.use_case_area}</td>
                    <td className="px-4 py-3 text-sm text-right">{formatCurrency(row.year1)}</td>
                    <td className="px-4 py-3 text-sm text-right">{formatCurrency(row.year2)}</td>
                    <td className="px-4 py-3 text-sm text-right">{formatCurrency(row.year3)}</td>
                    <td className="px-4 py-3 text-sm text-right font-semibold">{formatCurrency(row.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Yearly Trend */}
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Yearly $DBU Trend</h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={data.yearly_trend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="year" />
                  <YAxis tickFormatter={(v: number) => formatCurrency(v)} />
                  <Tooltip formatter={(v: number) => formatCurrency(v)} />
                  <Bar dataKey="value" fill="#3B82F6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Domain Breakdown Pie */}
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Domain Breakdown (T12M)</h3>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={data.domain_breakdown.slice(0, 15)}
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
                    {data.domain_breakdown.slice(0, 15).map((_: any, idx: number) => (
                      <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => formatCurrency(v)} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
