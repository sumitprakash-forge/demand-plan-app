import React, { useEffect, useState, useRef } from 'react';
import { fetchConsumption, fetchDomainMapping, uploadConsumptionCSV, formatCurrency, formatNumber } from '../api';
import type { AccountConfig } from '../App';

interface Props {
  accounts: AccountConfig[];
}

type ViewMode = 'sku' | 'domain' | 'domain-workspace' | 'cloud-domain-sku';

function HistoricalAccountView({ account, sheetUrl }: { account: string; sheetUrl: string }) {
  const [data, setData] = useState<any[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [wsCloud, setWsCloud] = useState<Record<string, string>>({});
  const [wsOrg, setWsOrg] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('domain');
  const [metric, setMetric] = useState<'dollar' | 'dbu'>('dollar');
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set());
  const [expandedClouds, setExpandedClouds] = useState<Set<string>>(new Set());
  const [expandedCloudDomains, setExpandedCloudDomains] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  const loadData = async () => {
    setLoading(true);
    setError('');
    setWarning('');
    try {
      if (sheetUrl) {
        try {
          const mapRes = await fetchDomainMapping(sheetUrl);
          const m: Record<string, string> = {};
          const cloud: Record<string, string> = {};
          const org: Record<string, string> = {};
          (mapRes.mapping || []).forEach((r: any) => {
            m[r.workspace] = r.domain;
            if (r.cloudtype) cloud[r.workspace] = r.cloudtype;
            if (r.org) org[r.workspace] = r.org;
          });
          setMapping(m);
          setWsCloud(cloud);
          setWsOrg(org);
          if (mapRes.warning) setWarning(mapRes.warning);
        } catch (e: any) {
          console.warn('Domain mapping error:', e.message);
        }
      }
      const res = await fetchConsumption(account);
      setData(res.data || []);
      if (res.warning) setWarning(res.warning);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [account]);

  const handleCSVUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    try {
      const res = await uploadConsumptionCSV(account, file);
      setData(res.data || []);
      setError('');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const months = [...new Set(data.map((r: any) => r.month))].sort();
  const getVal = (row: any) => parseFloat(metric === 'dollar' ? row.dollar_dbu_list : row.total_dbus) || 0;
  const fmt = metric === 'dollar' ? formatCurrency : formatNumber;
  const metricLabel = metric === 'dollar' ? '$DBU at List' : 'DBUs';

  // Build workspace→cloud mapping from consumption data (Logfood is source of truth for cloud)
  const wsCloudFromData: Record<string, string> = {};
  data.forEach((row: any) => {
    if (row.cloud && row.workspace_name) {
      wsCloudFromData[row.workspace_name] = row.cloud;
    }
  });

  // ── SKU Group pivot ──
  const skuMonthly: Record<string, Record<string, number>> = {};
  data.forEach((row: any) => {
    const sku = row.sku || row.sku_name || 'Unknown';
    const month = row.month || '';
    if (!skuMonthly[sku]) skuMonthly[sku] = {};
    skuMonthly[sku][month] = (skuMonthly[sku][month] || 0) + getVal(row);
  });
  const skus = Object.keys(skuMonthly).sort((a, b) => {
    const totalA = Object.values(skuMonthly[a]).reduce((s, v) => s + v, 0);
    const totalB = Object.values(skuMonthly[b]).reduce((s, v) => s + v, 0);
    return totalB - totalA;
  });

  // ── Domain pivot ──
  const domainMonthly: Record<string, Record<string, number>> = {};
  data.forEach((row: any) => {
    const ws = row.workspace_name || '';
    const domain = mapping[ws] || 'Unmapped';
    const month = row.month || '';
    if (!domainMonthly[domain]) domainMonthly[domain] = {};
    domainMonthly[domain][month] = (domainMonthly[domain][month] || 0) + getVal(row);
  });
  const domains = Object.keys(domainMonthly).sort((a, b) => {
    const totalA = Object.values(domainMonthly[a]).reduce((s, v) => s + v, 0);
    const totalB = Object.values(domainMonthly[b]).reduce((s, v) => s + v, 0);
    return totalB - totalA;
  });

  // ── Domain → Workspace pivot ──
  const domainWsMonthly: Record<string, Record<string, Record<string, number>>> = {};
  data.forEach((row: any) => {
    const ws = row.workspace_name || 'Unknown';
    const domain = mapping[ws] || 'Unmapped';
    const month = row.month || '';
    if (!domainWsMonthly[domain]) domainWsMonthly[domain] = {};
    if (!domainWsMonthly[domain][ws]) domainWsMonthly[domain][ws] = {};
    domainWsMonthly[domain][ws][month] = (domainWsMonthly[domain][ws][month] || 0) + getVal(row);
  });

  // ── Cloud → Domain → SKU pivot ──
  const cloudDomainSkuMonthly: Record<string, Record<string, Record<string, Record<string, number>>>> = {};
  const cloudMonthly: Record<string, Record<string, number>> = {};
  const cloudDomainMonthly: Record<string, Record<string, Record<string, number>>> = {};

  data.forEach((row: any) => {
    const ws = row.workspace_name || '';
    const domain = mapping[ws] || 'Unmapped';
    const cloud = wsCloudFromData[ws] || wsCloud[ws] || 'unknown';
    const sku = row.sku || row.sku_name || 'Unknown';
    const month = row.month || '';
    const val = getVal(row);

    if (!cloudDomainSkuMonthly[cloud]) cloudDomainSkuMonthly[cloud] = {};
    if (!cloudDomainSkuMonthly[cloud][domain]) cloudDomainSkuMonthly[cloud][domain] = {};
    if (!cloudDomainSkuMonthly[cloud][domain][sku]) cloudDomainSkuMonthly[cloud][domain][sku] = {};
    cloudDomainSkuMonthly[cloud][domain][sku][month] = (cloudDomainSkuMonthly[cloud][domain][sku][month] || 0) + val;

    if (!cloudMonthly[cloud]) cloudMonthly[cloud] = {};
    cloudMonthly[cloud][month] = (cloudMonthly[cloud][month] || 0) + val;

    if (!cloudDomainMonthly[cloud]) cloudDomainMonthly[cloud] = {};
    if (!cloudDomainMonthly[cloud][domain]) cloudDomainMonthly[cloud][domain] = {};
    cloudDomainMonthly[cloud][domain][month] = (cloudDomainMonthly[cloud][domain][month] || 0) + val;
  });

  const clouds = Object.keys(cloudMonthly).sort((a, b) => {
    const tA = Object.values(cloudMonthly[a]).reduce((s, v) => s + v, 0);
    const tB = Object.values(cloudMonthly[b]).reduce((s, v) => s + v, 0);
    return tB - tA;
  });

  const toggleCloud = (cloud: string) => {
    setExpandedClouds(prev => { const n = new Set(prev); n.has(cloud) ? n.delete(cloud) : n.add(cloud); return n; });
  };
  const toggleCloudDomain = (key: string) => {
    setExpandedCloudDomains(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  };

  const toggleDomain = (domain: string) => {
    setExpandedDomains(prev => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  };

  const expandAll = () => {
    setExpandedDomains(new Set(domains));
    setExpandedClouds(new Set(clouds));
    const allCdKeys: string[] = [];
    clouds.forEach(c => Object.keys(cloudDomainMonthly[c] || {}).forEach(d => allCdKeys.push(`${c}|${d}`)));
    setExpandedCloudDomains(new Set(allCdKeys));
  };
  const collapseAll = () => {
    setExpandedDomains(new Set());
    setExpandedClouds(new Set());
    setExpandedCloudDomains(new Set());
  };

  const grandTotal = (pivotData: Record<string, Record<string, number>>) =>
    Object.values(pivotData).reduce((s, months) => s + Object.values(months).reduce((a, b) => a + b, 0), 0);

  // Render a pivot table
  const renderPivotTable = (
    rowData: Record<string, Record<string, number>>,
    rowKeys: string[],
    label: string
  ) => (
    <div className="bg-white rounded-lg shadow overflow-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-gray-50 text-left">
            <th className="px-3 py-2 font-medium text-gray-700 sticky left-0 bg-gray-50 z-10 min-w-[200px]">{label}</th>
            {months.map((m) => (
              <th key={m} className="px-2 py-2 font-medium text-gray-700 text-right whitespace-nowrap">{m}</th>
            ))}
            <th className="px-3 py-2 font-medium text-gray-700 text-right bg-gray-100">Total</th>
          </tr>
        </thead>
        <tbody>
          {rowKeys.map((key) => {
            const total = Object.values(rowData[key]).reduce((s, v) => s + v, 0);
            return (
              <tr key={key} className="border-t hover:bg-gray-50">
                <td className="px-3 py-1.5 font-medium text-gray-900 sticky left-0 bg-white z-10 whitespace-nowrap truncate max-w-[250px]" title={key}>{key}</td>
                {months.map((m) => (
                  <td key={m} className="px-2 py-1.5 text-right text-gray-600 whitespace-nowrap">
                    {rowData[key][m] ? fmt(rowData[key][m]) : '-'}
                  </td>
                ))}
                <td className="px-3 py-1.5 text-right font-semibold text-gray-900 whitespace-nowrap bg-gray-50">{fmt(total)}</td>
              </tr>
            );
          })}
          <tr className="border-t-2 border-gray-300 bg-blue-50 font-bold">
            <td className="px-3 py-2 sticky left-0 bg-blue-50 z-10">Grand Total</td>
            {months.map((m) => {
              const monthTotal = rowKeys.reduce((s, k) => s + (rowData[k][m] || 0), 0);
              return <td key={m} className="px-2 py-2 text-right whitespace-nowrap">{fmt(monthTotal)}</td>;
            })}
            <td className="px-3 py-2 text-right whitespace-nowrap bg-blue-100">{fmt(grandTotal(rowData))}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );

  // Domain → Workspace collapsible view
  const renderDomainWorkspaceView = () => (
    <div className="bg-white rounded-lg shadow overflow-auto">
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b">
        <button onClick={expandAll} className="text-xs text-blue-600 hover:text-blue-800 font-medium">Expand All</button>
        <span className="text-gray-300">|</span>
        <button onClick={collapseAll} className="text-xs text-blue-600 hover:text-blue-800 font-medium">Collapse All</button>
        <span className="text-xs text-gray-400 ml-2">{domains.length} domains, {Object.values(domainWsMonthly).reduce((s, ws) => s + Object.keys(ws).length, 0)} workspaces</span>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-gray-50 text-left">
            <th className="px-3 py-2 font-medium text-gray-700 sticky left-0 bg-gray-50 z-10 min-w-[280px]">Domain / Workspace</th>
            {months.map((m) => (
              <th key={m} className="px-2 py-2 font-medium text-gray-700 text-right whitespace-nowrap">{m}</th>
            ))}
            <th className="px-3 py-2 font-medium text-gray-700 text-right bg-gray-100">Total</th>
          </tr>
        </thead>
        <tbody>
          {domains.map((domain) => {
            const isExpanded = expandedDomains.has(domain);
            const domainTotal = Object.values(domainMonthly[domain]).reduce((s, v) => s + v, 0);
            const workspaces = Object.keys(domainWsMonthly[domain] || {}).sort((a, b) => {
              const tA = Object.values(domainWsMonthly[domain][a]).reduce((s, v) => s + v, 0);
              const tB = Object.values(domainWsMonthly[domain][b]).reduce((s, v) => s + v, 0);
              return tB - tA;
            });

            return (
              <React.Fragment key={domain}>
                {/* Domain row */}
                <tr
                  className="border-t bg-slate-50 hover:bg-slate-100 cursor-pointer"
                  onClick={() => toggleDomain(domain)}
                >
                  <td className="px-3 py-2 font-semibold text-gray-900 sticky left-0 bg-slate-50 hover:bg-slate-100 z-10 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <svg className={`w-3.5 h-3.5 text-gray-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      {domain}
                      <span className="text-[10px] font-normal text-gray-400 ml-1">({workspaces.length} ws)</span>
                    </span>
                  </td>
                  {months.map((m) => (
                    <td key={m} className="px-2 py-2 text-right font-semibold text-gray-800 whitespace-nowrap">
                      {domainMonthly[domain][m] ? fmt(domainMonthly[domain][m]) : '-'}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-bold text-gray-900 whitespace-nowrap bg-slate-100">{fmt(domainTotal)}</td>
                </tr>

                {/* Workspace rows (collapsed by default) */}
                {isExpanded && workspaces.map((ws) => {
                  const wsTotal = Object.values(domainWsMonthly[domain][ws]).reduce((s, v) => s + v, 0);
                  return (
                    <tr key={ws} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-1 text-gray-600 sticky left-0 bg-white z-10 whitespace-nowrap pl-8" title={ws}>
                        <span className="inline-flex items-center gap-1.5">
                          <span className="truncate max-w-[180px]">{ws}</span>
                          {(wsCloudFromData[ws] || wsCloud[ws]) && (
                            <span className={`inline-block px-1 py-0 text-[9px] font-medium rounded ${
                              (wsCloudFromData[ws] || wsCloud[ws]) === 'azure' ? 'bg-blue-100 text-blue-700' :
                              (wsCloudFromData[ws] || wsCloud[ws]) === 'aws' ? 'bg-amber-100 text-amber-700' :
                              (wsCloudFromData[ws] || wsCloud[ws]) === 'gcp' ? 'bg-green-100 text-green-700' :
                              'bg-gray-100 text-gray-600'
                            }`}>{wsCloudFromData[ws] || wsCloud[ws]}</span>
                          )}
                          {wsOrg[ws] && (
                            <span className="inline-block px-1 py-0 text-[9px] font-medium rounded bg-purple-100 text-purple-700">{wsOrg[ws]}</span>
                          )}
                        </span>
                      </td>
                      {months.map((m) => (
                        <td key={m} className="px-2 py-1 text-right text-gray-500 whitespace-nowrap">
                          {domainWsMonthly[domain][ws][m] ? fmt(domainWsMonthly[domain][ws][m]) : '-'}
                        </td>
                      ))}
                      <td className="px-3 py-1 text-right font-medium text-gray-700 whitespace-nowrap bg-gray-50">{fmt(wsTotal)}</td>
                    </tr>
                  );
                })}
              </React.Fragment>
            );
          })}
          <tr className="border-t-2 border-gray-300 bg-blue-50 font-bold">
            <td className="px-3 py-2 sticky left-0 bg-blue-50 z-10">Grand Total</td>
            {months.map((m) => {
              const monthTotal = domains.reduce((s, d) => s + (domainMonthly[d][m] || 0), 0);
              return <td key={m} className="px-2 py-2 text-right whitespace-nowrap">{fmt(monthTotal)}</td>;
            })}
            <td className="px-3 py-2 text-right whitespace-nowrap bg-blue-100">{fmt(grandTotal(domainMonthly))}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );

  // Cloud → Domain → SKU collapsible view
  const renderCloudDomainSkuView = () => {
    const cloudBg: Record<string, string> = { azure: 'bg-blue-50', aws: 'bg-amber-50', gcp: 'bg-green-50' };
    const cloudText: Record<string, string> = { azure: 'text-blue-800', aws: 'text-amber-800', gcp: 'text-green-800' };
    const cloudBadge: Record<string, string> = { azure: 'bg-blue-100 text-blue-700', aws: 'bg-amber-100 text-amber-700', gcp: 'bg-green-100 text-green-700' };

    return (
      <div className="bg-white rounded-lg shadow overflow-auto">
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b">
          <button onClick={expandAll} className="text-xs text-blue-600 hover:text-blue-800 font-medium">Expand All</button>
          <span className="text-gray-300">|</span>
          <button onClick={collapseAll} className="text-xs text-blue-600 hover:text-blue-800 font-medium">Collapse All</button>
          <span className="text-xs text-gray-400 ml-2">{clouds.length} clouds, {domains.length} domains</span>
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 text-left">
              <th className="px-3 py-2 font-medium text-gray-700 sticky left-0 bg-gray-50 z-10 min-w-[300px]">Cloud / Domain / SKU</th>
              {months.map((m) => (
                <th key={m} className="px-2 py-2 font-medium text-gray-700 text-right whitespace-nowrap">{m}</th>
              ))}
              <th className="px-3 py-2 font-medium text-gray-700 text-right bg-gray-100">Total</th>
            </tr>
          </thead>
          <tbody>
            {clouds.map((cloud) => {
              const isCloudExpanded = expandedClouds.has(cloud);
              const cloudTotal = Object.values(cloudMonthly[cloud]).reduce((s, v) => s + v, 0);
              const domainsInCloud = Object.keys(cloudDomainMonthly[cloud] || {}).sort((a, b) => {
                const tA = Object.values(cloudDomainMonthly[cloud][a]).reduce((s, v) => s + v, 0);
                const tB = Object.values(cloudDomainMonthly[cloud][b]).reduce((s, v) => s + v, 0);
                return tB - tA;
              });

              return (
                <React.Fragment key={cloud}>
                  {/* Cloud row */}
                  <tr className={`border-t ${cloudBg[cloud] || 'bg-gray-50'} hover:opacity-90 cursor-pointer`}
                    onClick={() => toggleCloud(cloud)}>
                    <td className={`px-3 py-2 font-bold sticky left-0 z-10 ${cloudBg[cloud] || 'bg-gray-50'} ${cloudText[cloud] || 'text-gray-900'}`}>
                      <span className="inline-flex items-center gap-1.5">
                        <svg className={`w-3.5 h-3.5 transition-transform ${isCloudExpanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${cloudBadge[cloud] || 'bg-gray-200 text-gray-700'}`}>{cloud.toUpperCase()}</span>
                        <span className="text-[10px] font-normal text-gray-400">({domainsInCloud.length} domains)</span>
                      </span>
                    </td>
                    {months.map((m) => (
                      <td key={m} className="px-2 py-2 text-right font-bold whitespace-nowrap">
                        {cloudMonthly[cloud][m] ? fmt(cloudMonthly[cloud][m]) : '-'}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right font-bold whitespace-nowrap bg-gray-100">{fmt(cloudTotal)}</td>
                  </tr>

                  {/* Domain rows within cloud */}
                  {isCloudExpanded && domainsInCloud.map((domain) => {
                    const cdKey = `${cloud}|${domain}`;
                    const isDomainExpanded = expandedCloudDomains.has(cdKey);
                    const domTotal = Object.values(cloudDomainMonthly[cloud][domain]).reduce((s, v) => s + v, 0);
                    const skusInDomain = Object.keys(cloudDomainSkuMonthly[cloud]?.[domain] || {}).sort((a, b) => {
                      const tA = Object.values(cloudDomainSkuMonthly[cloud][domain][a]).reduce((s, v) => s + v, 0);
                      const tB = Object.values(cloudDomainSkuMonthly[cloud][domain][b]).reduce((s, v) => s + v, 0);
                      return tB - tA;
                    });

                    return (
                      <React.Fragment key={cdKey}>
                        <tr className="border-t border-gray-100 bg-slate-50 hover:bg-slate-100 cursor-pointer"
                          onClick={() => toggleCloudDomain(cdKey)}>
                          <td className="px-3 py-1.5 font-semibold text-gray-800 sticky left-0 bg-slate-50 hover:bg-slate-100 z-10 pl-8">
                            <span className="inline-flex items-center gap-1.5">
                              <svg className={`w-3 h-3 text-gray-400 transition-transform ${isDomainExpanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                              </svg>
                              {domain}
                              <span className="text-[10px] font-normal text-gray-400">({skusInDomain.length} SKUs)</span>
                            </span>
                          </td>
                          {months.map((m) => (
                            <td key={m} className="px-2 py-1.5 text-right font-semibold text-gray-700 whitespace-nowrap">
                              {cloudDomainMonthly[cloud][domain][m] ? fmt(cloudDomainMonthly[cloud][domain][m]) : '-'}
                            </td>
                          ))}
                          <td className="px-3 py-1.5 text-right font-bold text-gray-900 whitespace-nowrap bg-gray-50">{fmt(domTotal)}</td>
                        </tr>

                        {/* SKU rows within domain */}
                        {isDomainExpanded && skusInDomain.map((sku) => {
                          const skuTotal = Object.values(cloudDomainSkuMonthly[cloud][domain][sku]).reduce((s, v) => s + v, 0);
                          return (
                            <tr key={sku} className="border-t border-gray-50 hover:bg-gray-50">
                              <td className="px-3 py-1 text-gray-500 sticky left-0 bg-white z-10 pl-14 truncate max-w-[300px]" title={sku}>
                                {sku}
                              </td>
                              {months.map((m) => (
                                <td key={m} className="px-2 py-1 text-right text-gray-400 whitespace-nowrap">
                                  {cloudDomainSkuMonthly[cloud][domain][sku][m] ? fmt(cloudDomainSkuMonthly[cloud][domain][sku][m]) : '-'}
                                </td>
                              ))}
                              <td className="px-3 py-1 text-right font-medium text-gray-600 whitespace-nowrap bg-gray-50">{fmt(skuTotal)}</td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </React.Fragment>
              );
            })}
            <tr className="border-t-2 border-gray-300 bg-blue-50 font-bold">
              <td className="px-3 py-2 sticky left-0 bg-blue-50 z-10">Grand Total</td>
              {months.map((m) => {
                const monthTotal = clouds.reduce((s, c) => s + (cloudMonthly[c][m] || 0), 0);
                return <td key={m} className="px-2 py-2 text-right whitespace-nowrap">{fmt(monthTotal)}</td>;
              })}
              <td className="px-3 py-2 text-right whitespace-nowrap bg-blue-100">
                {fmt(clouds.reduce((s, c) => s + Object.values(cloudMonthly[c]).reduce((a, b) => a + b, 0), 0))}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  };

  const views: { key: ViewMode; label: string; desc: string }[] = [
    { key: 'domain', label: 'By Domain', desc: 'Aggregated by domain' },
    { key: 'sku', label: 'By SKU', desc: 'Aggregated by SKU group' },
    { key: 'domain-workspace', label: 'Domain → Workspace', desc: 'Expandable domain/workspace drill-down' },
    { key: 'cloud-domain-sku', label: 'Cloud → Domain → SKU', desc: '3-level hierarchy: cloud, domain, SKU with totals' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Historical Consumption — {account}</h2>
        <div className="flex items-center gap-3">
          <button onClick={loadData} disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {loading ? 'Loading...' : 'Refresh from Logfood'}
          </button>
          <div>
            <input type="file" accept=".csv" ref={fileRef} onChange={handleCSVUpload} className="hidden" />
            <button onClick={() => fileRef.current?.click()}
              className="px-4 py-2 bg-gray-600 text-white rounded-md text-sm font-medium hover:bg-gray-700">
              Upload CSV
            </button>
          </div>
        </div>
      </div>

      {loading && <div className="text-center py-8 text-gray-500">Querying Logfood for consumption data...</div>}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          <p className="font-medium">Error loading data</p>
          <p>{error}</p>
          <p className="mt-2 text-gray-600">Use the "Upload CSV" button to load data manually.</p>
        </div>
      )}
      {warning && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-yellow-700 text-sm">{warning}</div>
      )}

      {/* View mode tabs */}
      {data.length > 0 && (
        <>
          <div className="flex items-center justify-between flex-wrap gap-3">
            {/* View mode tabs */}
            <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-lg">
              {views.map((v) => (
                <button
                  key={v.key}
                  onClick={() => setViewMode(v.key)}
                  className={`px-4 py-2 text-sm font-medium rounded-md transition-all ${
                    viewMode === v.key
                      ? 'bg-white text-blue-700 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                  title={v.desc}
                >
                  {v.label}
                </button>
              ))}
            </div>

            {/* Metric toggle: DBUs vs $DBUs */}
            <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-lg">
              <button
                onClick={() => setMetric('dbu')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                  metric === 'dbu'
                    ? 'bg-white text-emerald-700 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                DBUs
              </button>
              <button
                onClick={() => setMetric('dollar')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                  metric === 'dollar'
                    ? 'bg-white text-blue-700 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                $DBU at List
              </button>
            </div>
          </div>

          {/* Data summary bar */}
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span>{data.length.toLocaleString()} rows</span>
            <span>{months.length} months ({months[0]} — {months[months.length - 1]})</span>
            <span>{new Set(data.map((r: any) => r.workspace_name)).size} workspaces</span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${metric === 'dollar' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>{metricLabel}</span>
            <span>Total: <span className="font-semibold text-gray-700">{fmt(grandTotal(domainMonthly))}</span></span>
          </div>

          {/* Render selected view */}
          {viewMode === 'sku' && renderPivotTable(skuMonthly, skus, 'SKU Group')}
          {viewMode === 'domain' && renderPivotTable(domainMonthly, domains, 'Domain')}
          {viewMode === 'domain-workspace' && renderDomainWorkspaceView()}
          {viewMode === 'cloud-domain-sku' && renderCloudDomainSkuView()}
        </>
      )}

      {!loading && data.length === 0 && !error && (
        <div className="bg-gray-50 rounded-lg p-8 text-center text-gray-500">
          <p>No consumption data loaded. Click "Refresh from Logfood" or upload a CSV file.</p>
        </div>
      )}
    </div>
  );
}

export default function HistoricalTab({ accounts }: Props) {
  const [selectedAccountIdx, setSelectedAccountIdx] = useState(0);

  // Clamp index if accounts change
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

      {selectedAccount && (
        <HistoricalAccountView
          key={selectedAccount.name}
          account={selectedAccount.name}
          sheetUrl={selectedAccount.sheetUrl}
        />
      )}
    </div>
  );
}
