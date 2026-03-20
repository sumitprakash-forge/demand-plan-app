import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { AccountConfig } from '../App';
import { uploadDomainMap, fetchDomainMap, fetchWorkspaceList } from '../api';

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
  username: string;
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
  onLoadAccount: (acct: AccountConfig) => Promise<void>;
  loadingAccounts: Record<string, boolean>;
  loadStatus: Record<string, 'ok' | 'error'>;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SetupTab({ accounts, setAccounts, onLoadAccount, loadingAccounts, loadStatus }: Props) {
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
      <AccountPickerStep
        databricksReady={status?.databricks ?? false}
        accounts={accounts}
        setAccounts={setAccounts}
        onLoadAccount={onLoadAccount}
        loadingAccounts={loadingAccounts}
        loadStatus={loadStatus}
      />
    </div>
  );
}

// ─── Step 1: Databricks ───────────────────────────────────────────────────────

function DatabricksStep({ status, onDone }: { status: SetupStatus | null; onDone: () => void }) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [selectedWarehouse, setSelectedWarehouse] = useState(status?.warehouse_id || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (status?.warehouse_id) setSelectedWarehouse(status.warehouse_id);
  }, [status?.warehouse_id]);

  const loadWarehouses = async () => {
    try {
      const wh = await apiFetch('/api/setup/warehouses');
      setWarehouses(wh.warehouses || []);
      if (!selectedWarehouse) {
        const running = (wh.warehouses || []).find((w: Warehouse) => w.state === 'RUNNING');
        if (running) setSelectedWarehouse(running.id);
      }
    } catch {}
  };

  useEffect(() => { loadWarehouses(); }, []);

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

  const warehouseSaved = !!status?.warehouse_id;

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
        <StepBadge n={1} done={warehouseSaved} />
        <div>
          <h3 className="font-semibold text-slate-800">Logfood Workspace</h3>
          <p className="text-xs text-slate-500">Connected via your login session</p>
        </div>
        <span className="ml-auto text-xs text-emerald-600 font-medium flex items-center gap-1">
          <CheckIcon /> Authenticated
        </span>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Session info — read only */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wide mb-1">Signed in as</p>
            <p className="text-sm font-medium text-slate-700">{status?.username || '—'}</p>
          </div>
          <div>
            <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wide mb-1">Workspace</p>
            <p className="text-xs text-slate-500 font-mono truncate" title={status?.host}>{status?.host || '—'}</p>
          </div>
        </div>

        {/* Warehouse selection */}
        <div className="space-y-2">
          <label className="block text-xs font-medium text-slate-600">SQL Warehouse</label>
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
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            onClick={handleSaveWarehouse}
            disabled={loading || !selectedWarehouse}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? <SpinIcon /> : null}
            Save Warehouse
          </button>
        </div>
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

// ─── Domain Map Upload ────────────────────────────────────────────────────────

function DomainMapUpload({ account }: { account: string }) {
  const [mapping, setMapping] = useState<{ workspace: string; domain: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [loadingTemplate, setLoadingTemplate] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [showFormat, setShowFormat] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchDomainMap(account)
      .then(d => setMapping(d.mapping || []))
      .catch(() => {});
  }, [account]);

  const handleFile = async (file: File) => {
    setUploading(true); setError(''); setWarnings([]);
    try {
      const result = await uploadDomainMap(account, file);
      setMapping(result.mapping || []);
      setWarnings(result.warnings || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const handleDownloadTemplate = async () => {
    setLoadingTemplate(true);
    try {
      const result = await fetchWorkspaceList(account);
      const workspaces: string[] = result.workspaces || [];
      const rows = workspaces.length > 0
        ? workspaces.map(ws => `${ws},`)
        : ['example-workspace-prod,', 'analytics-workspace,', 'ml-platform,'];
      const csv = ['workspace_name,domain', ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `domain_map_template_${account}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch {
      // fallback: blank template
      const csv = 'workspace_name,domain\nexample-workspace,\n';
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `domain_map_template_${account}.csv`; a.click();
      URL.revokeObjectURL(url);
    } finally {
      setLoadingTemplate(false);
    }
  };

  const preview = showAll ? mapping : mapping.slice(0, 5);

  return (
    <div className="space-y-2">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
            Domain Mapping
          </label>
          {mapping.length > 0 && (
            <span className="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded-full font-medium">
              {mapping.length} workspaces
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Format guide toggle */}
          <button
            type="button"
            onClick={() => setShowFormat(v => !v)}
            className="text-[10px] text-slate-400 hover:text-blue-600 flex items-center gap-0.5"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 110 20A10 10 0 0112 2z" />
            </svg>
            {showFormat ? 'Hide format' : 'What format?'}
          </button>
          {/* Template download */}
          <button
            type="button"
            onClick={handleDownloadTemplate}
            disabled={loadingTemplate}
            className="text-[10px] text-slate-400 hover:text-blue-600 flex items-center gap-0.5 disabled:opacity-50"
            title="Download CSV template pre-filled with workspace names"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {loadingTemplate ? 'Generating…' : 'Template'}
          </button>
        </div>
      </div>

      {/* Format guide (collapsible) */}
      {showFormat && (
        <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2.5 text-xs text-slate-700 space-y-1.5">
          <p className="font-semibold text-blue-800">CSV format — two columns required:</p>
          <ul className="space-y-0.5 text-slate-600 list-disc list-inside">
            <li><code className="bg-white px-1 rounded text-[11px]">workspace_name</code> — Databricks workspace name (case-insensitive)</li>
            <li><code className="bg-white px-1 rounded text-[11px]">domain</code> — business domain label, e.g. <em>Data Engineering</em>, <em>Analytics</em>, <em>ML & AI</em></li>
          </ul>
          <p className="font-semibold text-blue-800 pt-1">Example:</p>
          <pre className="bg-white border border-blue-100 rounded px-2 py-1.5 text-[11px] font-mono leading-relaxed overflow-x-auto">
{`workspace_name,domain
prod-analytics,Analytics
ml-platform,ML & AI
data-eng-prod,Data Engineering`}
          </pre>
          <p className="text-[10px] text-slate-500">
            Steps: Open your mapping sheet → File → Download → CSV → upload below.<br/>
            Or click <strong>Template</strong> above to get a pre-filled CSV with your workspace names.
          </p>
        </div>
      )}

      {/* Upload button */}
      <div className="flex items-center gap-2">
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white hover:bg-slate-50 text-slate-600 disabled:opacity-50 font-medium"
        >
          {uploading ? (
            <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
          )}
          {uploading ? 'Uploading…' : mapping.length > 0 ? 'Re-upload CSV' : 'Upload CSV'}
        </button>
        {mapping.length === 0 && !uploading && (
          <span className="text-[10px] text-slate-400 italic">No mapping uploaded yet — workspaces will show as "Unmapped"</span>
        )}
      </div>

      {/* Error */}
      {error && <p className="text-xs text-red-600">{error}</p>}

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5 text-xs text-amber-800 space-y-0.5">
          <p className="font-semibold">⚠ {warnings.length} row{warnings.length > 1 ? 's' : ''} skipped:</p>
          {warnings.map((w, i) => <p key={i} className="text-[11px]">{w}</p>)}
        </div>
      )}

      {/* Preview table */}
      {mapping.length > 0 && (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <div className="bg-slate-50 px-3 py-1.5 flex items-center justify-between border-b border-slate-200">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
              Mapping preview — {mapping.length} workspace{mapping.length > 1 ? 's' : ''}
            </span>
            <span className="text-[10px] text-emerald-600 flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Loaded
            </span>
          </div>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-100">
              <tr>
                <th className="text-left px-3 py-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Workspace</th>
                <th className="text-left px-3 py-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Domain</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {preview.map((row, i) => (
                <tr key={i} className="hover:bg-slate-50">
                  <td className="px-3 py-1.5 font-mono text-slate-700 truncate max-w-[160px]" title={row.workspace}>{row.workspace}</td>
                  <td className="px-3 py-1.5 text-slate-600">{row.domain}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {mapping.length > 5 && (
            <div className="px-3 py-1.5 border-t border-slate-100 bg-slate-50">
              <button
                type="button"
                onClick={() => setShowAll(v => !v)}
                className="text-[10px] text-blue-600 hover:underline"
              >
                {showAll ? 'Show less ▲' : `Show all ${mapping.length} rows ▼`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Step 3: Account Picker from Logfood ─────────────────────────────────────

function AccountPickerStep({
  databricksReady,
  accounts,
  setAccounts,
  onLoadAccount,
  loadingAccounts,
  loadStatus,
}: {
  databricksReady: boolean;
  accounts: AccountConfig[];
  setAccounts: (a: AccountConfig[]) => void;
  onLoadAccount: (acct: AccountConfig) => Promise<void>;
  loadingAccounts: Record<string, boolean>;
  loadStatus: Record<string, 'ok' | 'error'>;
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
        contractStartDate: '',
      }));
    if (newAccounts.length > 0) {
      // Replace blank placeholder if present
      const filtered = accounts.filter(a => a.name.trim() || a.sfdc_id.trim());
      setAccounts([...filtered, ...newAccounts]);
    }
    setSelected(new Set());
    setResults([]);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
        <StepBadge n={2} done={accounts.some(a => a.name.trim())} />
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
                  <div className="flex items-center gap-2">
                    {selected.size > 0 && (
                      <button
                        onClick={handleAddAccounts}
                        className="text-xs px-3 py-1 bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700"
                      >
                        Add {selected.size} account{selected.size > 1 ? 's' : ''} →
                      </button>
                    )}
                    <button
                      onClick={() => { setResults([]); setSelected(new Set()); }}
                      className="text-slate-400 hover:text-slate-600 p-0.5 rounded"
                      title="Close results"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
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
              <div className="space-y-2">
                <p className="text-xs font-medium text-slate-500">Configured accounts</p>
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
                  {accounts.filter(a => a.name.trim()).map((acct, idx) => {
                    const key = acct.sfdc_id;
                    const isLoading = loadingAccounts[key];
                    const status = loadStatus[key];
                    return (
                      <div key={key} className="p-3 bg-white space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-full text-xs font-semibold">{acct.name}</span>
                            <span className="text-[11px] text-slate-400 font-mono truncate max-w-[180px]">{acct.sfdc_id}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => onLoadAccount(acct)}
                              disabled={!acct.sfdc_id.trim() || isLoading}
                              className={`flex items-center gap-1 px-3 py-1 rounded-md text-xs font-medium border transition-colors disabled:opacity-40 ${
                                status === 'ok' ? 'bg-green-50 text-green-700 border-green-300' :
                                status === 'error' ? 'bg-red-50 text-red-600 border-red-300' :
                                'bg-blue-50 text-blue-700 border-blue-300 hover:bg-blue-100'
                              }`}
                            >
                              {isLoading ? (
                                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                              ) : status === 'ok' ? (
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/></svg>
                              ) : status === 'error' ? (
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                              ) : (
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
                              )}
                              {isLoading ? 'Loading…' : status === 'ok' ? 'Loaded' : status === 'error' ? 'Failed' : 'Load'}
                            </button>
                            <button
                              onClick={() => setAccounts(accounts.filter(a => a.sfdc_id !== acct.sfdc_id))}
                              className="text-slate-400 hover:text-red-500 text-sm px-1"
                            >×</button>
                          </div>
                        </div>
                        <div className="space-y-3">
                          <div>
                            <label className="block text-[10px] font-medium text-slate-400 mb-0.5">Contract Start (M1)</label>
                            <input
                              type="month"
                              value={acct.contractStartDate || ''}
                              onChange={e => {
                                const updated = [...accounts];
                                const realIdx = accounts.findIndex(a => a.sfdc_id === acct.sfdc_id);
                                updated[realIdx] = { ...updated[realIdx], contractStartDate: e.target.value };
                                setAccounts(updated);
                              }}
                              className="border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                            />
                          </div>
                          <DomainMapUpload account={acct.sfdc_id || acct.name} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
