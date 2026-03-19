import React, { useState, useEffect, useCallback } from 'react';
import type { AccountConfig } from '../App';

// ─── API helpers ──────────────────────────────────────────────────────────────

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json();
}

// ─── Icon components ──────────────────────────────────────────────────────────

function CheckIcon() {
  return (
    <svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function SpinIcon() {
  return (
    <svg className="w-5 h-5 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function StepBadge({ n, done }: { n: number; done: boolean }) {
  if (done) return (
    <span className="flex items-center justify-center w-7 h-7 rounded-full bg-emerald-100">
      <CheckIcon />
    </span>
  );
  return (
    <span className="flex items-center justify-center w-7 h-7 rounded-full bg-blue-600 text-white text-sm font-bold">{n}</span>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SetupStatus {
  databricks: boolean;
  google: boolean;
  warehouse_id: string;
  host: string;
}

interface Warehouse {
  id: string;
  name: string;
  state: string;
}

interface LogfoodAccount {
  sfdc_account_name: string;
  sfdc_account_id: string;
}

interface Props {
  accounts: AccountConfig[];
  setAccounts: (a: AccountConfig[]) => void;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SetupTab({ accounts, setAccounts }: Props) {
  const [status, setStatus] = useState<SetupStatus | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await apiFetch('/api/setup/status');
      setStatus(s);
    } catch {}
  }, []);

  useEffect(() => { refreshStatus(); }, []);

  return (
    <div className="max-w-3xl mx-auto space-y-6 py-2">
      <div>
        <h2 className="text-xl font-bold text-slate-800">Setup</h2>
        <p className="text-sm text-slate-500 mt-1">
          Configure credentials and pick accounts before using the other tabs.
        </p>
      </div>

      <DatabricksStep status={status} onDone={refreshStatus} />
      <GoogleStep status={status} onDone={refreshStatus} />
      <AccountPickerStep
        databricksReady={status?.databricks ?? false}
        accounts={accounts}
        setAccounts={setAccounts}
      />
    </div>
  );
}

// ─── Step 1: Databricks ───────────────────────────────────────────────────────

function DatabricksStep({ status, onDone }: { status: SetupStatus | null; onDone: () => void }) {
  const done = status?.databricks ?? false;
  const [host, setHost] = useState(status?.host || '');
  const [token, setToken] = useState('');
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [selectedWarehouse, setSelectedWarehouse] = useState(status?.warehouse_id || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'creds' | 'warehouse'>('creds');

  useEffect(() => {
    if (status?.host) setHost(status.host);
    if (status?.warehouse_id) setSelectedWarehouse(status.warehouse_id);
    if (status?.databricks) setStep('warehouse');
  }, [status]);

  const handleConnect = async () => {
    if (!host.trim() || !token.trim()) { setError('Both fields are required.'); return; }
    setLoading(true); setError('');
    try {
      await apiFetch('/api/setup/databricks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: host.trim(), token: token.trim() }),
      });
      const wh = await apiFetch('/api/setup/warehouses');
      setWarehouses(wh.warehouses || []);
      // Auto-select first running warehouse
      const running = (wh.warehouses || []).find((w: Warehouse) => w.state === 'RUNNING');
      if (running) setSelectedWarehouse(running.id);
      setStep('warehouse');
      onDone();
    } catch (e: any) {
      setError(e.message || 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveWarehouse = async () => {
    if (!selectedWarehouse) { setError('Select a warehouse.'); return; }
    setLoading(true); setError('');
    try {
      await apiFetch('/api/setup/warehouse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ warehouse_id: selectedWarehouse }),
      });
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const loadWarehouses = async () => {
    try {
      const wh = await apiFetch('/api/setup/warehouses');
      setWarehouses(wh.warehouses || []);
    } catch {}
  };

  useEffect(() => {
    if (done && step === 'warehouse' && warehouses.length === 0) loadWarehouses();
  }, [done, step]);

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
        <StepBadge n={1} done={done && !!status?.warehouse_id} />
        <div>
          <h3 className="font-semibold text-slate-800">Databricks Workspace</h3>
          <p className="text-xs text-slate-500">Connect to the Logfood workspace to query account data</p>
        </div>
        {done && status?.warehouse_id && (
          <span className="ml-auto text-xs text-emerald-600 font-medium flex items-center gap-1">
            <CheckIcon /> Connected
          </span>
        )}
      </div>

      <div className="px-5 py-4 space-y-4">
        {step === 'creds' || !done ? (
          <>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Workspace URL</label>
              <input
                type="url"
                value={host}
                onChange={e => setHost(e.target.value)}
                placeholder="https://adb-1234567890.azuredatabricks.net"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Personal Access Token</label>
              <input
                type="password"
                value={token}
                onChange={e => setToken(e.target.value)}
                placeholder="dapi••••••••••••••••••••••••••••••••"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Generate in your workspace: User Settings → Developer → Access Tokens
              </p>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              onClick={handleConnect}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? <SpinIcon /> : null}
              {loading ? 'Connecting…' : 'Connect & Validate'}
            </button>
          </>
        ) : null}

        {(done || step === 'warehouse') && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-slate-600">SQL Warehouse</label>
              {done && (
                <button onClick={() => setStep('creds')} className="text-[11px] text-blue-500 hover:underline">
                  Change credentials
                </button>
              )}
            </div>
            {warehouses.length === 0 ? (
              <p className="text-xs text-slate-400 italic">Loading warehouses…</p>
            ) : (
              <select
                value={selectedWarehouse}
                onChange={e => setSelectedWarehouse(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="">— select a warehouse —</option>
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.state})
                  </option>
                ))}
              </select>
            )}
            {error && <p className="text-sm text-red-600 mt-1">{error}</p>}
            <button
              onClick={handleSaveWarehouse}
              disabled={loading || !selectedWarehouse}
              className="mt-3 flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? <SpinIcon /> : null}
              Save Warehouse
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Step 2: Google Drive OAuth ───────────────────────────────────────────────

function GoogleStep({ status, onDone }: { status: SetupStatus | null; onDone: () => void }) {
  const done = status?.google ?? false;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [method, setMethod] = useState<'gcloud' | 'device' | null>(null);
  const [gcloudMissing, setGcloudMissing] = useState(false);
  // Device flow state
  const [flowData, setFlowData] = useState<{ device_code: string; user_code: string; verification_url: string; expires_in: number; interval: number } | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollStatus, setPollStatus] = useState<'pending' | 'authorized' | 'expired' | 'error' | null>(null);

  // Try gcloud first, then device flow
  const handleAuthorize = async () => {
    setLoading(true); setError(''); setMethod(null);
    try {
      const gcloud = await apiFetch('/api/setup/google/check-gcloud', { method: 'POST' });
      if (gcloud.status === 'ok') {
        setMethod('gcloud');
        onDone();
        return;
      }
      // gcloud not available
      if (gcloud.detail?.includes('not installed')) {
        setGcloudMissing(true);
        setLoading(false);
        return;
      }
      // gcloud installed but not authenticated — try device flow
      setMethod('device');
      const data = await apiFetch('/api/setup/google/start', { method: 'POST' });
      if (data.error) throw new Error(data.error_description || data.error);
      setFlowData(data);
      startPolling(data.device_code, data.interval || 5);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const startPolling = (deviceCode: string, intervalSecs: number) => {
    setPolling(true);
    const timer = setInterval(async () => {
      try {
        const result = await apiFetch(`/api/setup/google/poll?device_code=${encodeURIComponent(deviceCode)}`);
        if (result.status === 'authorized') {
          clearInterval(timer);
          setPolling(false); setPollStatus('authorized'); setFlowData(null);
          onDone();
        } else if (result.status === 'expired' || result.status === 'error') {
          clearInterval(timer);
          setPolling(false); setPollStatus(result.status);
        }
      } catch {
        clearInterval(timer);
        setPolling(false); setPollStatus('error');
      }
    }, intervalSecs * 1000);
  };

  const handleDisconnect = async () => {
    try {
      await apiFetch('/api/setup/google', { method: 'DELETE' });
      setFlowData(null); setPollStatus(null); setMethod(null);
      onDone();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
        <StepBadge n={2} done={done} />
        <div>
          <h3 className="font-semibold text-slate-800">Google Drive Access</h3>
          <p className="text-xs text-slate-500">Required to read workspace domain mapping sheets from Google Sheets</p>
        </div>
        {done && (
          <span className="ml-auto text-xs text-emerald-600 font-medium flex items-center gap-1">
            <CheckIcon /> Authorized
          </span>
        )}
      </div>

      <div className="px-5 py-4 space-y-4">
        {done ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <span className="text-emerald-500">●</span>
              Google Sheets access is active {method === 'gcloud' ? '(via gcloud)' : '(OAuth token)'}.
            </div>
            <button onClick={handleDisconnect} className="text-xs text-red-500 hover:underline">
              Disconnect
            </button>
          </div>
        ) : (
          <>
            {gcloudMissing && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800 space-y-2">
                <p className="font-medium">gcloud not installed</p>
                <p className="text-xs">Install Google Cloud SDK to enable Google Sheets access:</p>
                <pre className="bg-amber-100 rounded px-3 py-2 text-xs font-mono overflow-x-auto">
                  {`# macOS (Homebrew)\nbrew install --cask google-cloud-sdk\n\n# Then authenticate:\ngcloud auth login --enable-gdrive-access`}
                </pre>
                <p className="text-xs">After installing, click "Authorize with Google" again.</p>
              </div>
            )}

            {!flowData && !polling && !gcloudMissing && (
              <>
                {error && <p className="text-sm text-red-600">{error}</p>}
                {pollStatus === 'expired' && <p className="text-sm text-amber-600">Code expired. Try again.</p>}
                <p className="text-xs text-slate-500">
                  Uses your existing <code className="bg-slate-100 px-1 rounded">gcloud</code> login if available, otherwise starts an OAuth device flow.
                </p>
                <button
                  onClick={handleAuthorize}
                  disabled={loading}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading ? <SpinIcon /> : (
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                    </svg>
                  )}
                  {loading ? 'Checking…' : 'Authorize with Google'}
                </button>
              </>
            )}

            {flowData && (
              <div className="border border-slate-200 rounded-xl p-4 space-y-3">
                <p className="text-sm text-slate-500">gcloud not available — complete OAuth below:</p>
                <p className="text-sm font-medium text-slate-700">
                  1. Go to{' '}
                  <a href={flowData.verification_url} target="_blank" rel="noopener noreferrer"
                    className="text-blue-600 underline font-mono">{flowData.verification_url}</a>
                </p>
                <p className="text-sm text-slate-700">2. Enter this code:</p>
                <div className="flex items-center gap-3">
                  <span className="text-2xl font-mono font-bold tracking-widest bg-slate-100 px-4 py-2 rounded-lg text-slate-800">
                    {flowData.user_code}
                  </span>
                  <button onClick={() => navigator.clipboard.writeText(flowData.user_code)}
                    className="text-xs text-slate-400 hover:text-slate-600">Copy</button>
                </div>
                {polling && (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <SpinIcon /> Waiting for authorization…
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Step 3: Account Picker from Logfood ─────────────────────────────────────

function AccountPickerStep({
  databricksReady,
  accounts,
  setAccounts,
}: {
  databricksReady: boolean;
  accounts: AccountConfig[];
  setAccounts: (a: AccountConfig[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LogfoodAccount[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true); setError('');
    try {
      const data = await apiFetch(`/api/accounts-search?q=${encodeURIComponent(query)}`);
      setResults(data.accounts || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSearching(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleAddAccounts = () => {
    const toAdd = results.filter(r => selected.has(r.sfdc_account_id));
    const existing = new Set(accounts.map(a => a.sfdc_id));
    const newAccounts: AccountConfig[] = toAdd
      .filter(r => !existing.has(r.sfdc_account_id))
      .map(r => ({
        name: r.sfdc_account_name,
        sfdc_id: r.sfdc_account_id,
        sheetUrl: '',
        contractStartDate: '',
      }));
    if (newAccounts.length > 0) {
      // Replace blank placeholder if present
      const filtered = accounts.filter(a => a.name.trim() || a.sfdc_id.trim());
      setAccounts([...filtered, ...newAccounts]);
    }
    setSelected(new Set());
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
        <StepBadge n={3} done={accounts.some(a => a.name.trim())} />
        <div>
          <h3 className="font-semibold text-slate-800">Pick Accounts</h3>
          <p className="text-xs text-slate-500">Search Logfood and add accounts to your demand plan</p>
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {!databricksReady ? (
          <p className="text-sm text-slate-400 italic">Complete Step 1 first to search accounts.</p>
        ) : (
          <>
            {/* Search bar */}
            <div className="flex gap-2">
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="Search by account name or SFDC ID…"
                className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
              <button
                onClick={handleSearch}
                disabled={searching || !query.trim()}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {searching ? <SpinIcon /> : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                )}
                Search
              </button>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            {/* Results */}
            {results.length > 0 && (
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <div className="bg-slate-50 px-3 py-2 flex items-center justify-between border-b border-slate-200">
                  <span className="text-xs font-medium text-slate-500">{results.length} results</span>
                  {selected.size > 0 && (
                    <button
                      onClick={handleAddAccounts}
                      className="text-xs px-3 py-1 bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700"
                    >
                      Add {selected.size} account{selected.size > 1 ? 's' : ''} →
                    </button>
                  )}
                </div>
                <div className="max-h-64 overflow-y-auto divide-y divide-slate-100">
                  {results.map(r => {
                    const isSelected = selected.has(r.sfdc_account_id);
                    const alreadyAdded = accounts.some(a => a.sfdc_id === r.sfdc_account_id);
                    return (
                      <div
                        key={r.sfdc_account_id}
                        onClick={() => !alreadyAdded && toggleSelect(r.sfdc_account_id)}
                        className={`flex items-center gap-3 px-3 py-2.5 text-sm cursor-pointer transition-colors ${
                          alreadyAdded
                            ? 'opacity-50 cursor-not-allowed bg-slate-50'
                            : isSelected
                            ? 'bg-blue-50'
                            : 'hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected || alreadyAdded}
                          readOnly
                          disabled={alreadyAdded}
                          className="w-4 h-4 rounded accent-blue-600"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-slate-800 truncate">{r.sfdc_account_name}</p>
                          <p className="text-[11px] text-slate-400 font-mono">{r.sfdc_account_id}</p>
                        </div>
                        {alreadyAdded && (
                          <span className="text-[10px] text-emerald-600 font-medium bg-emerald-50 px-1.5 py-0.5 rounded">
                            Added
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Current accounts */}
            {accounts.some(a => a.name.trim()) && (
              <div>
                <p className="text-xs font-medium text-slate-500 mb-2">Currently configured accounts</p>
                <div className="flex flex-wrap gap-2">
                  {accounts.filter(a => a.name.trim()).map(a => (
                    <span key={a.sfdc_id} className="flex items-center gap-1.5 px-3 py-1 bg-slate-100 rounded-full text-xs font-medium text-slate-700">
                      {a.name}
                      <button
                        onClick={() => setAccounts(accounts.filter(x => x.sfdc_id !== a.sfdc_id))}
                        className="text-slate-400 hover:text-red-500"
                      >×</button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
