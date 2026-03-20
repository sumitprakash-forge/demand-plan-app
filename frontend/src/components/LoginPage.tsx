import React, { useState, useCallback } from 'react';

const DEFAULT_HOST = 'https://adb-2548836972759138.18.azuredatabricks.net';

interface Props {
  onLogin: (username: string, host: string) => void;
}

export default function LoginPage({ onLogin }: Props) {
  const [host] = useState(DEFAULT_HOST);
  const [copied, setCopied] = useState(false);

  const copyHost = useCallback(() => {
    navigator.clipboard.writeText(DEFAULT_HOST).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, []);
  const [pat, setPat] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: host.trim(), pat: pat.trim() }),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `HTTP ${res.status}`);
      }
      const data = await res.json();
      onLogin(data.username, data.host);
    } catch (e: any) {
      setError(e.message || 'Sign in failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Logo / title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[#FF3621] mb-4 shadow-lg">
            <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-slate-800">Demand Plan App</h1>
          <p className="text-sm text-slate-500 mt-1">Sign in with your Databricks PAT</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <form onSubmit={handleSubmit} className="space-y-5">

            {/* Host — fixed, read-only */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                Logfood Workspace URL
              </label>
              <div className="flex items-center gap-2">
                <div className="flex-1 border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-500 bg-slate-50 font-mono truncate">
                  {DEFAULT_HOST}
                </div>
                <button
                  type="button"
                  onClick={copyHost}
                  className="flex-shrink-0 flex items-center gap-1 px-2.5 py-2 text-xs border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-500 hover:text-slate-700 transition-colors"
                  title="Copy URL"
                >
                  {copied ? (
                    <>
                      <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="text-green-600">Copied</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* PAT */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                Personal Access Token
              </label>
              <input
                type="password"
                value={pat}
                onChange={e => setPat(e.target.value)}
                placeholder="dapi••••••••••••••••"
                required
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm text-slate-800 font-mono focus:outline-none focus:ring-2 focus:ring-[#FF3621]/30 focus:border-[#FF3621] transition"
              />
              <p className="text-[11px] text-slate-400 mt-1.5">
                Your identity is derived from this token. Data is isolated per user.
              </p>
            </div>

            {/* Error */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 text-sm text-red-700">
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || !pat.trim()}
              className="w-full bg-[#FF3621] hover:bg-[#e02d1b] disabled:bg-slate-300 text-white font-semibold py-2.5 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  Verifying...
                </>
              ) : 'Sign In'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-slate-400 mt-6">
          Generate a PAT in your Databricks workspace → User Settings → Access Tokens
        </p>
      </div>
    </div>
  );
}
