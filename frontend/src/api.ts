const BASE = '/api';

export async function fetchDomainMapping(sheetUrl: string) {
  const res = await fetch(`${BASE}/domain-mapping?sheet_url=${encodeURIComponent(sheetUrl)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchConsumption(account: string) {
  const res = await fetch(`${BASE}/consumption?account=${encodeURIComponent(account)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function uploadConsumptionCSV(account: string, file: File) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}/consumption/upload?account=${encodeURIComponent(account)}`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchSummary(account: string, scenario: number) {
  const res = await fetch(`${BASE}/summary?account=${encodeURIComponent(account)}&scenario=${scenario}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchScenario(account: string, scenario: number) {
  const res = await fetch(`${BASE}/scenario?account=${encodeURIComponent(account)}&scenario=${scenario}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function saveScenario(data: any) {
  const res = await fetch(`${BASE}/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchForecast(account: string) {
  const res = await fetch(`${BASE}/forecast?account=${encodeURIComponent(account)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function saveForecast(account: string, overrides: any[]) {
  const res = await fetch(`${BASE}/forecast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, overrides }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchAccountOverview(account: string) {
  const res = await fetch(`${BASE}/account-overview?account=${encodeURIComponent(account)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function formatCurrency(value: number): string {
  const rounded = Math.round(value);
  if (Math.abs(rounded) >= 1_000_000) return `$${(rounded / 1_000_000).toFixed(1)}M`;
  if (Math.abs(rounded) >= 1_000) return `$${Math.round(rounded / 1_000).toLocaleString()}K`;
  return `$${rounded.toLocaleString()}`;
}

export function formatCurrencyFull(value: number): string {
  return `$${Math.round(value).toLocaleString()}`;
}

export function formatNumber(value: number): string {
  return Math.round(value).toLocaleString();
}
