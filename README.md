# Demand Plan App

A Databricks consumption planning and forecasting tool for Field Engineering. Load historical Logfood data per account, build 3-scenario demand plans, and export to Excel.

---

## Quick Start

### 1. Clone

```bash
git clone https://github.com/sumitprakash-forge/demand-plan-app.git
cd demand-plan-app
```

### 2. Run

```bash
bash run.sh
```

`run.sh` installs dependencies automatically, then starts both servers.

Open **http://localhost:5173** in your browser. Press **Ctrl+C** to stop.

### 3. Login

Enter your Logfood workspace host and Databricks PAT in the login screen.

---

## Prerequisites

| Tool | Install |
|------|---------|
| Python 3.10+ | [python.org](https://python.org) |
| Node.js 18+ | [nodejs.org](https://nodejs.org) |

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
    └── models.py           # Pydantic models
```
