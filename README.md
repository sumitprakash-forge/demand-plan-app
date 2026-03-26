# Demand Plan App

A Databricks consumption planning and forecasting tool for Field Engineering. Load historical Logfood data per account, build 3-scenario demand plans, and export to Excel.

---

## Quick Start

### 1. Clone

```bash
git clone https://github.com/sumitprakash-forge/demand-plan-app.git
cd demand-plan-app
```

### 2. Authenticate (one-time, per machine)

**Databricks (Logfood):**
```bash
databricks auth login https://adb-2548836972759138.18.azuredatabricks.net/ --profile=logfood
```

**Google (for domain mapping sheets):**
```bash
gcloud auth login --enable-gdrive-access
```

> If `gcloud` isn't installed: `brew install --cask google-cloud-sdk` (macOS)

### 3. Run

```bash
bash run.sh
```

`run.sh` installs dependencies automatically, then starts both servers.

Open **http://localhost:5173** in your browser. Press **Ctrl+C** to stop.

---

## Prerequisites

| Tool | Install |
|------|---------|
| Python 3.10+ | [python.org](https://python.org) |
| Node.js 18+ | [nodejs.org](https://nodejs.org) |
| Databricks CLI | `brew install databricks` |
| gcloud CLI | `brew install --cask google-cloud-sdk` |

---

## Domain Mapping Sheet

The app accepts a Google Sheets URL to map workspaces → business domains. Required columns:

| account_name | cloudtype | org | sfdc_workspace_name | Domain |
|---|---|---|---|---|
| Walmart | gcp | Sams Club | prod-sams-cdp-platform | CDP Platform |
| Walmart | azure | Sams Club | prod-supplychain-data | Supply Chain |

The sheet must be shared with your authenticated Google account.

---

## Tabs

| Tab | Description |
|-----|-------------|
| **Demand Plan Summary** | 3-scenario demand plan with Y1/Y2/Y3 totals and domain breakdown |
| **Historical Consumption** | T12M actuals from Logfood — by domain, SKU, cloud |
| **Scenario Builder** | Add/edit use cases with ramp curves across 3 scenarios |
| **Account Overview** | High-level T12M metrics — spend, workspaces, cloud mix |

---

## Export

Click **Export XLS → Scenario N** to download an Excel workbook with summary, historical data, 36-month projections, and pivot tables.

---

## Cache

- **Server cache**: `server/data/*.json`
- **Browser cache**: `localStorage['demandplan_accounts']`
- **Clear All** button wipes both and resets the app.

---

## Project Structure

```
demand-plan-app/
├── run.sh                  # One-command setup + start
├── frontend/src/
│   ├── App.tsx             # Main app, account config, header
│   ├── exportExcelJS.ts    # Excel export logic
│   └── components/         # SummaryTab, HistoricalTab, ScenarioTab, OverviewTab
└── server/
    ├── main.py             # FastAPI routes + cache
    ├── logfood.py          # Logfood SQL via Databricks SDK
    ├── sheets.py           # Google Sheets domain mapping
    └── models.py           # Pydantic models
```
