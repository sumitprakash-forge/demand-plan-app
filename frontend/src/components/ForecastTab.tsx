import React, { useEffect, useState } from 'react';
import { fetchForecast, saveForecast, formatCurrency } from '../api';

interface Props {
  account: string;
}

interface ForecastRow {
  workspace: string;
  domain: string;
  cloud: string;
  monthly_dbu: number;
  total_dbu: number;
  edited?: boolean;
}

export default function ForecastTab({ account }: Props) {
  const [data, setData] = useState<ForecastRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [filter, setFilter] = useState('');
  const [domainFilter, setDomainFilter] = useState('');

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await fetchForecast(account);
      setData((res.data || []).map((r: any) => ({ ...r, edited: false })));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [account]);

  const handleEdit = (idx: number, field: string, value: any) => {
    const updated = [...data];
    (updated[idx] as any)[field] = value;
    updated[idx].edited = true;
    setData(updated);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const overrides = data.filter((r) => r.edited).map((r) => ({
        workspace: r.workspace,
        domain: r.domain,
        cloud: r.cloud,
        monthly_dbu: r.monthly_dbu,
      }));
      await saveForecast(account, overrides);
      setSaved(true);
      setData(data.map((r) => ({ ...r, edited: false })));
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const domains = [...new Set(data.map((r) => r.domain))].sort();

  const filtered = data.filter((r) => {
    if (filter && !r.workspace.toLowerCase().includes(filter.toLowerCase())) return false;
    if (domainFilter && r.domain !== domainFilter) return false;
    return true;
  });

  // Domain aggregates
  const domainAgg: Record<string, { count: number; monthly: number; total: number }> = {};
  data.forEach((r) => {
    if (!domainAgg[r.domain]) domainAgg[r.domain] = { count: 0, monthly: 0, total: 0 };
    domainAgg[r.domain].count++;
    domainAgg[r.domain].monthly += r.monthly_dbu;
    domainAgg[r.domain].total += r.total_dbu;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Forecast Base — Workspace Level</h2>
        <div className="flex items-center gap-3">
          {saved && <span className="text-green-600 text-sm font-medium">Saved!</span>}
          <button
            onClick={handleSave}
            disabled={saving || !data.some((r) => r.edited)}
            className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Overrides'}
          </button>
          <button
            onClick={loadData}
            className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search workspaces..."
          className="border border-gray-300 rounded-md px-3 py-2 text-sm w-64"
        />
        <select
          value={domainFilter}
          onChange={(e) => setDomainFilter(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm"
        >
          <option value="">All Domains</option>
          {domains.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <span className="text-sm text-gray-500 self-center">{filtered.length} workspaces</span>
      </div>

      {/* Domain Aggregates */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b">
          <h3 className="text-sm font-semibold text-gray-700">Domain Aggregates</h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-gray-500">
              <th className="px-4 py-2 font-medium">Domain</th>
              <th className="px-4 py-2 font-medium text-right">Workspaces</th>
              <th className="px-4 py-2 font-medium text-right">Monthly $DBU</th>
              <th className="px-4 py-2 font-medium text-right">T12M $DBU</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(domainAgg)
              .sort((a, b) => b[1].total - a[1].total)
              .map(([domain, agg]) => (
                <tr key={domain} className="border-t hover:bg-gray-50 cursor-pointer" onClick={() => setDomainFilter(domain === domainFilter ? '' : domain)}>
                  <td className="px-4 py-2 text-gray-900">{domain}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{agg.count}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{formatCurrency(agg.monthly)}</td>
                  <td className="px-4 py-2 text-right font-semibold text-gray-900">{formatCurrency(agg.total)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {loading && <div className="text-center py-8 text-gray-500">Loading workspace data...</div>}

      {/* Workspace Table */}
      {!loading && (
        <div className="bg-white rounded-lg shadow overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-gray-500">
                <th className="px-3 py-2 font-medium">Workspace</th>
                <th className="px-3 py-2 font-medium">Domain</th>
                <th className="px-3 py-2 font-medium">Cloud</th>
                <th className="px-3 py-2 font-medium text-right">Monthly $DBU</th>
                <th className="px-3 py-2 font-medium text-right">T12M $DBU</th>
                <th className="px-3 py-2 font-medium text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, idx) => {
                const actualIdx = data.indexOf(row);
                return (
                  <tr key={row.workspace} className={`border-t ${row.edited ? 'bg-yellow-50' : 'hover:bg-gray-50'}`}>
                    <td className="px-3 py-2 text-gray-900 font-mono text-xs">{row.workspace}</td>
                    <td className="px-3 py-2">
                      <input
                        value={row.domain}
                        onChange={(e) => handleEdit(actualIdx, 'domain', e.target.value)}
                        className="border border-gray-200 rounded px-2 py-0.5 text-sm w-36"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={row.cloud}
                        onChange={(e) => handleEdit(actualIdx, 'cloud', e.target.value)}
                        className="border border-gray-200 rounded px-2 py-0.5 text-sm"
                      >
                        <option value="AWS">AWS</option>
                        <option value="Azure">Azure</option>
                        <option value="GCP">GCP</option>
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        value={row.monthly_dbu}
                        onChange={(e) => handleEdit(actualIdx, 'monthly_dbu', parseFloat(e.target.value) || 0)}
                        className="border border-gray-200 rounded px-2 py-0.5 text-sm w-28 text-right"
                      />
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600">{formatCurrency(row.total_dbu)}</td>
                    <td className="px-3 py-2 text-center">
                      {row.edited && <span className="text-yellow-600 text-xs font-medium">Modified</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
