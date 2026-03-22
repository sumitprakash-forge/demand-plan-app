const BASE = '/api';

export class ConflictError extends Error {
  constructor() { super('conflict'); this.name = 'ConflictError'; }
}

export async function uploadDomainMap(account: string, file: File) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}/accounts/${encodeURIComponent(account)}/domain-map`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json(); // { count, mapping, warnings }
}

export async function fetchDomainMap(account: string) {
  const res = await fetch(`${BASE}/accounts/${encodeURIComponent(account)}/domain-map`);
  if (!res.ok) throw new Error(await res.text());
  return res.json(); // { count, mapping }
}

export async function fetchWorkspaceList(account: string) {
  const res = await fetch(`${BASE}/accounts/${encodeURIComponent(account)}/workspaces`);
  if (!res.ok) throw new Error(await res.text());
  return res.json(); // { workspaces: string[] }
}

export async function fetchConsumption(account: string, refresh = false) {
  const url = `${BASE}/consumption?account=${encodeURIComponent(account)}${refresh ? '&refresh=true' : ''}`;
  const res = await fetch(url);
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

export async function fetchSummary(account: string, scenario: number, contractMonths = 36) {
  const res = await fetch(`${BASE}/summary?account=${encodeURIComponent(account)}&scenario=${scenario}&contract_months=${contractMonths}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchSummaryAll(account: string, contractMonths = 36) {
  const res = await fetch(`${BASE}/summary-all?account=${encodeURIComponent(account)}&contract_months=${contractMonths}`);
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
  if (res.status === 409) throw new ConflictError();
  if (!res.ok) throw new Error(await res.text());
  return res.json(); // includes { version: number }
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

export async function fetchSkuPrices(account: string, tier = 'premium') {
  const res = await fetch(`${BASE}/sku-prices?account=${encodeURIComponent(account)}&tier=${encodeURIComponent(tier)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchConsumptionForecast(account: string, scenario: number, months = 24, startDate = '') {
  const params = new URLSearchParams({ account, scenario: String(scenario), months: String(months) });
  if (startDate) params.set('start_date', startDate);
  const res = await fetch(`${BASE}/consumption-forecast?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchAccountOverview(account: string) {
  const res = await fetch(`${BASE}/account-overview?account=${encodeURIComponent(account)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchLogfoodUseCases(account: string) {
  const res = await fetch(`${BASE}/logfood-use-cases?account=${encodeURIComponent(account)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json(); // { account, use_cases: [...] }
}

export async function uploadLogfoodUseCases(account: string, file: File) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}/logfood-use-cases/upload?account=${encodeURIComponent(account)}`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json(); // { status, account, records }
}

export async function refreshLogfoodUseCases(account: string) {
  // Force re-fetch by calling with a cache-busting param the server ignores
  const res = await fetch(`${BASE}/logfood-use-cases?account=${encodeURIComponent(account)}&refresh=1`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchContractHealth(account: string) {
  const res = await fetch(`${BASE}/contract-health?account=${encodeURIComponent(account)}`);
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
