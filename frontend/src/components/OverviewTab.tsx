import React, { useEffect, useState, useRef, useCallback } from 'react';
import { fetchAccountOverview, fetchContractHealth, formatCurrency } from '../api';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, LineChart, Line, ComposedChart, Area,
} from 'recharts';
import type { AccountConfig } from '../App';

/** Download a Recharts chart container (div wrapping ResponsiveContainer) as PNG */
function downloadChartAsPng(containerRef: React.RefObject<HTMLDivElement | null>, filename: string) {
  const svg = containerRef.current?.querySelector('svg');
  if (!svg) return;
  const svgData = new XMLSerializer().serializeToString(svg);
  const canvas = document.createElement('canvas');
  const scale = 2; // retina
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

const COLORS = [
  '#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899',
  '#06B6D4', '#84CC16', '#F97316', '#6366F1', '#14B8A6', '#E11D48',
  '#0EA5E9', '#A855F7', '#22C55E',
];

interface Props {
  accounts: AccountConfig[];
}

function OverviewAccountView({ account }: { account: string }) {
  const [data, setData] = useState<any>(null);
  const [contractHealth, setContractHealth] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [contractLoading, setContractLoading] = useState(false);
  const [error, setError] = useState('');
  const [contractError, setContractError] = useState('');
  const [selectedOppIdx, setSelectedOppIdx] = useState(0);
  const dataLoadedRef = useRef(false);

  useEffect(() => {
    if (dataLoadedRef.current) return;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetchAccountOverview(account);
        setData(res);
        dataLoadedRef.current = true;
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [account]);

  useEffect(() => {
    setContractHealth(null);
    setContractError('');
    setSelectedOppIdx(0);
    const load = async () => {
      setContractLoading(true);
      try {
        const res = await fetchContractHealth(account);
        setContractHealth(res);
      } catch (e: any) {
        setContractError(e.message);
      } finally {
        setContractLoading(false);
      }
    };
    load();
  }, [account]);

  if (loading) return <div className="text-center py-8 text-gray-500">Loading account overview...</div>;
  if (error) return <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">{error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <MetricCard label="Total T12M Consumption" value={formatCurrency(data.total_t12m)} />
        <MetricCard label="T3M Consumption" value={formatCurrency(data.total_t3m)} />
        <MetricCard
          label="QoQ Growth Rate"
          value={`${data.growth_rate > 0 ? '+' : ''}${data.growth_rate}%`}
          color={data.growth_rate >= 0 ? 'text-green-600' : 'text-red-600'}
        />
        <MetricCard label="Workspaces" value={data.workspace_count.toString()} />
        <MetricCard label="Domains" value={data.domain_count.toString()} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Monthly Trend */}
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Monthly $DBU Trend</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data.monthly_trend}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={(v: number) => formatCurrency(v)} />
              <Tooltip formatter={(v: number) => formatCurrency(v)} />
              <Line type="monotone" dataKey="value" stroke="#3B82F6" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Top Domains */}
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Top Domains by Consumption</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data.top_domains.slice(0, 10)} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" tickFormatter={(v: number) => formatCurrency(v)} />
              <YAxis dataKey="domain" type="category" width={120} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: number) => formatCurrency(v)} />
              <Bar dataKey="value" fill="#3B82F6" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Stacked charts — by Domain and by SKU */}
      <StackedConsumptionCharts data={data} accountName={data.account} />

      {/* Domain Breakdown Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b">
          <h3 className="text-sm font-semibold text-gray-700">Domain Breakdown</h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-gray-500">
              <th className="px-4 py-2 font-medium">#</th>
              <th className="px-4 py-2 font-medium">Domain</th>
              <th className="px-4 py-2 font-medium text-right">T12M $DBU</th>
              <th className="px-4 py-2 font-medium text-right">% of Total</th>
              <th className="px-4 py-2 font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            {data.domain_table.map((row: any, idx: number) => (
              <tr key={row.domain} className="border-t hover:bg-gray-50">
                <td className="px-4 py-2 text-gray-400">{idx + 1}</td>
                <td className="px-4 py-2 text-gray-900 font-medium">{row.domain}</td>
                <td className="px-4 py-2 text-right text-gray-700">{formatCurrency(row.total_dbu)}</td>
                <td className="px-4 py-2 text-right text-gray-700">{row.pct}%</td>
                <td className="px-4 py-2">
                  <div className="w-full bg-gray-100 rounded-full h-2">
                    <div
                      className="bg-blue-500 rounded-full h-2"
                      style={{ width: `${Math.min(row.pct, 100)}%` }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Contract Health */}
      <ContractHealthSection
        loading={contractLoading}
        error={contractError}
        contractHealth={contractHealth}
        selectedOppIdx={selectedOppIdx}
        onSelectOpp={setSelectedOppIdx}
      />
    </div>
  );
}

function ChartDownloadButton({ containerRef, filename }: { containerRef: React.RefObject<HTMLDivElement | null>; filename: string }) {
  return (
    <button
      onClick={() => downloadChartAsPng(containerRef, filename)}
      className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:text-slate-800 border border-slate-200 rounded hover:bg-slate-50 transition-colors"
      title="Download chart as PNG"
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
      </svg>
      PNG
    </button>
  );
}

function StackedConsumptionCharts({ data, accountName }: { data: any; accountName: string }) {
  const domainRef = useRef<HTMLDivElement>(null);
  const skuRef    = useRef<HTMLDivElement>(null);

  const domainKeys: string[] = data.top_domain_keys || [];
  const skuKeys: string[]    = data.top_sku_keys    || [];
  const monthlyByDomain      = data.monthly_by_domain || [];
  const monthlyBySku         = data.monthly_by_sku   || [];

  if (!monthlyByDomain.length && !monthlyBySku.length) return null;

  const shortMonth = (m: string) => {
    const [y, mo] = m.split('-');
    const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${names[parseInt(mo) - 1]}'${y.slice(2)}`;
  };

  const domainData = monthlyByDomain.map((r: any) => ({ ...r, month: shortMonth(r.month) }));
  const skuData    = monthlyBySku.map((r: any)    => ({ ...r, month: shortMonth(r.month) }));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* By Domain */}
      {monthlyByDomain.length > 0 && (
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-700">Monthly Consumption by Domain (T12M)</h3>
            <ChartDownloadButton containerRef={domainRef} filename={`${accountName}_monthly_by_domain.png`} />
          </div>
          <div ref={domainRef}>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={domainData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                <YAxis tickFormatter={(v: number) => formatCurrency(v)} tick={{ fontSize: 10 }} width={72} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {domainKeys.map((d, i) => (
                  <Bar key={d} dataKey={d} stackId="a" fill={COLORS[i % COLORS.length]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* By SKU */}
      {monthlyBySku.length > 0 && (
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-700">Monthly Consumption by SKU (T12M)</h3>
            <ChartDownloadButton containerRef={skuRef} filename={`${accountName}_monthly_by_sku.png`} />
          </div>
          <div ref={skuRef}>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={skuData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                <YAxis tickFormatter={(v: number) => formatCurrency(v)} tick={{ fontSize: 10 }} width={72} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {skuKeys.map((s, i) => (
                  <Bar key={s} dataKey={s} stackId="a" fill={COLORS[i % COLORS.length]}
                    name={s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

function BurnBadge({ pct }: { pct: number }) {
  if (pct >= 100) return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700">Over-consumed</span>;
  if (pct >= 80)  return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-orange-100 text-orange-700">At Risk</span>;
  if (pct >= 50)  return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-yellow-100 text-yellow-700">On Track</span>;
  return               <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-700">Under-consumed</span>;
}

function ContractHealthSection({
  loading, error, contractHealth, selectedOppIdx, onSelectOpp,
}: {
  loading: boolean;
  error: string;
  contractHealth: any;
  selectedOppIdx: number;
  onSelectOpp: (i: number) => void;
}) {
  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      {/* Section header */}
      <div className="px-4 py-3 bg-slate-800 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Contract Health</h3>
          <p className="text-xs text-slate-400 mt-0.5">Cumulative actuals vs. commit — source: gtm_gold.commit_consumption_cpq_monthly</p>
        </div>
        {contractHealth?.summary && (
          <BurnBadge pct={contractHealth.summary.burn_pct} />
        )}
      </div>

      {loading && (
        <div className="px-4 py-8 text-center text-slate-400 text-sm">Loading contract data...</div>
      )}

      {error && !loading && (
        <div className="px-4 py-4 text-sm text-red-600 bg-red-50 border-t border-red-100">
          Could not load contract data: {error}
        </div>
      )}

      {!loading && !error && contractHealth && contractHealth.opportunities.length === 0 && (
        <div className="px-4 py-8 text-center text-slate-400 text-sm">
          No contract data found in <code className="text-xs bg-slate-100 px-1 rounded">main.gtm_gold.commit_consumption_cpq_monthly</code> for this account.
        </div>
      )}

      {!loading && !error && contractHealth && contractHealth.opportunities.length > 0 && (() => {
        const opps = contractHealth.opportunities;
        const summary = contractHealth.summary;
        const opp = opps[Math.min(selectedOppIdx, opps.length - 1)];
        const burnColor = opp.burn_pct >= 100 ? '#EF4444' : opp.burn_pct >= 80 ? '#F97316' : '#3B82F6';

        return (
          <div className="divide-y divide-slate-100">
            {/* Overall KPI bar */}
            <div className="grid grid-cols-4 divide-x divide-slate-100">
              {[
                { label: 'Total Commit', value: formatCurrency(summary.total_commit), sub: 'across all contracts' },
                { label: 'Consumed (Cumulative)', value: formatCurrency(summary.total_consumed), sub: `${summary.burn_pct}% of commit` },
                { label: 'Remaining', value: formatCurrency(summary.total_remaining), sub: 'uncommitted balance' },
                { label: 'Burn Rate', value: `${summary.burn_pct}%`, sub: 'of total commit consumed' },
              ].map(({ label, value, sub }) => (
                <div key={label} className="px-4 py-3">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</p>
                  <p className="text-lg font-bold text-slate-800 mt-0.5">{value}</p>
                  <p className="text-[10px] text-slate-400">{sub}</p>
                </div>
              ))}
            </div>

            {/* Overall burn progress bar */}
            <div className="px-4 py-3 bg-slate-50">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-slate-500 uppercase tracking-wide">Overall Burn Progress</span>
                <span className="text-xs font-semibold text-slate-700">{summary.burn_pct}% consumed</span>
              </div>
              <div className="w-full bg-slate-200 rounded-full h-3">
                <div
                  className="h-3 rounded-full transition-all"
                  style={{
                    width: `${Math.min(summary.burn_pct, 100)}%`,
                    background: summary.burn_pct >= 100 ? '#EF4444' : summary.burn_pct >= 80 ? '#F97316' : '#3B82F6',
                  }}
                />
              </div>
            </div>

            {/* Opportunity selector tabs (if multiple) */}
            {opps.length > 1 && (
              <div className="flex gap-1 px-4 py-2 bg-white overflow-x-auto">
                {opps.map((o: any, i: number) => (
                  <button
                    key={i}
                    onClick={() => onSelectOpp(i)}
                    className={`px-3 py-1.5 rounded text-xs font-medium whitespace-nowrap transition-all ${
                      i === selectedOppIdx
                        ? 'bg-slate-800 text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {o.opportunity_name}
                  </button>
                ))}
              </div>
            )}

            {/* Burn curve chart */}
            <div className="px-4 py-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h4 className="text-sm font-semibold text-slate-700">{opp.opportunity_name}</h4>
                  <p className="text-xs text-slate-400">
                    {opp.contract_start} → {opp.contract_end}
                    &nbsp;·&nbsp; Commit: {formatCurrency(opp.commit_amount)}
                    &nbsp;·&nbsp; <BurnBadge pct={opp.burn_pct} />
                  </p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={opp.burn_curve} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 10 }}
                    tickFormatter={(v: string) => v ? v.slice(0, 7) : ''}
                  />
                  <YAxis
                    tickFormatter={(v: number) => formatCurrency(v)}
                    tick={{ fontSize: 10 }}
                    width={80}
                  />
                  <Tooltip
                    formatter={(value: number, name: string) => [
                      formatCurrency(value),
                      name === 'cumulative_actual' ? 'Cumulative Actuals'
                        : name === 'commit_amount' ? 'Total Commit'
                        : 'Monthly Actual',
                    ]}
                    labelFormatter={(l: string) => `Month: ${l}`}
                  />
                  {/* Commit reference area */}
                  <Area
                    type="monotone"
                    dataKey="commit_amount"
                    fill="#DBEAFE"
                    stroke="#93C5FD"
                    strokeWidth={1.5}
                    strokeDasharray="6 3"
                    fillOpacity={0.3}
                    name="commit_amount"
                  />
                  {/* Cumulative actuals line */}
                  <Line
                    type="monotone"
                    dataKey="cumulative_actual"
                    stroke={burnColor}
                    strokeWidth={2.5}
                    dot={{ r: 3, fill: burnColor }}
                    activeDot={{ r: 5 }}
                    name="cumulative_actual"
                  />
                  {/* Monthly actual bars */}
                  <Bar
                    dataKey="monthly_actual"
                    fill="#BFDBFE"
                    opacity={0.7}
                    radius={[2, 2, 0, 0]}
                    name="monthly_actual"
                  />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-4 mt-2 text-[10px] text-slate-500">
                <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-blue-400 border-dashed border-t-2 border-blue-300" /> Total Commit</span>
                <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5" style={{ backgroundColor: burnColor, height: 2 }} /> Cumulative Actuals</span>
                <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-blue-200 opacity-70" /> Monthly Actual</span>
              </div>
            </div>

            {/* Per-opportunity table */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 text-left border-t border-slate-100">
                    <th className="px-4 py-2 font-semibold">Opportunity</th>
                    <th className="px-4 py-2 font-semibold">Start</th>
                    <th className="px-4 py-2 font-semibold">End</th>
                    <th className="px-4 py-2 font-semibold text-right">Commit</th>
                    <th className="px-4 py-2 font-semibold text-right">Consumed</th>
                    <th className="px-4 py-2 font-semibold text-right">Remaining</th>
                    <th className="px-4 py-2 font-semibold text-right">Burn %</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {opps.map((o: any, i: number) => (
                    <tr
                      key={i}
                      className={`border-t border-slate-100 hover:bg-slate-50 cursor-pointer ${i === selectedOppIdx ? 'bg-blue-50' : ''}`}
                      onClick={() => onSelectOpp(i)}
                    >
                      <td className="px-4 py-2 font-medium text-slate-700">{o.opportunity_name}</td>
                      <td className="px-4 py-2 text-slate-500">{o.contract_start || '—'}</td>
                      <td className="px-4 py-2 text-slate-500">{o.contract_end || '—'}</td>
                      <td className="px-4 py-2 text-right font-mono text-slate-700">{formatCurrency(o.commit_amount)}</td>
                      <td className="px-4 py-2 text-right font-mono text-slate-700">{formatCurrency(o.cumulative_actual)}</td>
                      <td className="px-4 py-2 text-right font-mono text-slate-500">{formatCurrency(o.remaining_commit)}</td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-16 bg-slate-100 rounded-full h-1.5">
                            <div
                              className="h-1.5 rounded-full"
                              style={{
                                width: `${Math.min(o.burn_pct, 100)}%`,
                                background: o.burn_pct >= 100 ? '#EF4444' : o.burn_pct >= 80 ? '#F97316' : '#3B82F6',
                              }}
                            />
                          </div>
                          <span className="font-mono text-slate-700">{o.burn_pct}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-2"><BurnBadge pct={o.burn_pct} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color || 'text-gray-900'}`}>{value}</p>
    </div>
  );
}

export default function OverviewTab({ accounts }: Props) {
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
          <OverviewAccountView
            account={acct.sfdc_id}
          />
        </div>
      ))}
    </div>
  );
}
