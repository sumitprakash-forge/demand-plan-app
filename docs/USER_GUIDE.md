# Demand Plan App — User Guide

**Databricks Consumption Planning & Forecasting**

---

## Table of Contents

1. [Overview](#overview)
2. [Setup & Deployment](#setup--deployment)
3. [Step-by-Step Walkthrough (Kroger Example)](#step-by-step-walkthrough)
   - [Step 1: Sign In](#step-1-sign-in)
   - [Step 2: Add an Account](#step-2-add-an-account)
   - [Step 3: Upload Domain Map](#step-3-upload-domain-map)
   - [Step 4: Load Consumption Data](#step-4-load-consumption-data)
4. [Tab: Historical Consumption (T12M)](#tab-historical-consumption-t12m)
5. [Tab: Account Overview](#tab-account-overview)
6. [Tab: Demand Plan Summary](#tab-demand-plan-summary)
7. [Tab: Scenario Builder](#tab-scenario-builder)
8. [Tab: Consumption Forecast](#tab-consumption-forecast)
9. [Export to Excel](#export-to-excel)

---

## Overview

The Demand Plan App is a Databricks Field Engineering tool for building structured, data-driven consumption forecasts for enterprise accounts. It:

- Pulls **trailing 12-month (T12M) actual consumption** from Logfood (Databricks internal billing system)
- Lets you build **3 forecast scenarios** with named use cases, ramp timelines, and SKU breakdowns
- Projects spend **month-by-month over 36 months** with visual charts
- Exports a **full Excel workbook** including historical data, use case detail, and forecast tables

---

## Setup & Deployment

### Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Python | 3.10+ | Backend (FastAPI) |
| Node.js | 18+ | Frontend (React + Vite) |
| Databricks CLI | Latest | Authenticated to Logfood workspace |
| `databricks-sdk` | 0.33.0+ | Installed via pip |
| Google Cloud SDK (`gcloud`) | Latest | For CSV domain map uploads |

### 1. Clone the Repository

```bash
git clone https://github.com/sumitprakash-forge/demand-plan-app.git
cd demand-plan-app
```

### 2. Install Backend Dependencies

```bash
cd server
pip install -r requirements.txt
cd ..
```

### 3. Install Frontend Dependencies

```bash
cd frontend
npm install
cd ..
```

### 4. Authenticate with Databricks (Logfood)

The app queries Logfood for consumption data. Check if the `logfood` profile is already set up:

```bash
databricks auth profiles | grep logfood
```

If not configured:

```bash
databricks auth login https://adb-2548836972759138.18.azuredatabricks.net/ --profile=logfood
```

### 5. Start the App

```bash
bash run.sh
```

This starts:
- **Backend** (FastAPI) → `http://localhost:8000`
- **Frontend** (React/Vite) → `http://localhost:5173`

Open **http://localhost:5173** in your browser.

---

## Step-by-Step Walkthrough

The following walkthrough uses **Kroger** as the example account.

---

### Step 1: Sign In

When you open the app, you'll see the login page:

![Login page](screenshots/guide/01_login.png)

Enter your **Databricks Personal Access Token (PAT)** — this is your `dapi...` token from the Databricks workspace settings.

![Login filled](screenshots/guide/01b_login_filled.png)

Click **Sign In**. You'll be taken to the Setup tab.

![Signed in — Setup tab](screenshots/guide/02_setup_signed_in.png)

---

### Step 2: Add an Account

On the **Setup** tab, search for the account you want to plan for.

Type the account name in the search box (e.g., `Kroger`):

![Search for Kroger](screenshots/guide/03_setup_search_kroger.png)

Results appear showing matching Salesforce accounts:

![Kroger search results](screenshots/guide/04_setup_kroger_results.png)

Check the box next to the correct account (use the 18-character Salesforce Account ID to confirm):

![Kroger selected](screenshots/guide/04b_setup_kroger_selected.png)

Click **Add Selected**. The account appears in the configured accounts list:

![Kroger added](screenshots/guide/05_setup_kroger_added.png)

---

### Step 3: Upload Domain Map

The domain map tells the app how to group Databricks workspaces into business domains (e.g., Supply Chain, Merchandising, DMP).

**CSV format:** Two columns — `workspace_name` and `domain`

```csv
workspace_name,domain
dbx-scg-paip-core-p-eus2,Supply Chain
merch-mira-prod-dbxws,Merchandising
dmp-orion-prod-dbxws,DMP
```

Upload the CSV using the **Upload Domain Map CSV** button:

![Domain map uploaded — 239 workspaces mapped](screenshots/guide/06_setup_domain_map_uploaded.png)

Once uploaded, you'll see a count of how many workspaces were successfully mapped (e.g., "239 workspaces mapped").

---

### Step 4: Load Consumption Data

Click **Load** next to the account name. The app queries Logfood for the trailing 12-month billing data:

![Loading data](screenshots/guide/07_setup_loading.png)

On success, the page refreshes and all tabs populate with Kroger's historical data.

> **Note:** Data is cached locally per account. Subsequent loads use the cache unless you force a refresh.

---

## Tab: Historical Consumption (T12M)

This tab shows Kroger's actual Databricks consumption over the trailing 12 months.

### By Domain View (default)

![Historical — By Domain](screenshots/guide/08_historical_by_domain.png)

The domain breakdown shows T12M spend by business domain. For Kroger, this shows **$12.5M T12M** across 22 domains, with Supply Chain ($4.5M, 36%) being the largest.

### By SKU View

Click **By SKU** to see spend broken down by Databricks SKU type:

![Historical — By SKU](screenshots/guide/09_historical_by_sku.png)

### Domain → Workspace Drilldown

Click on a domain row to expand it and see individual workspace consumption:

![Historical — Domain → Workspace](screenshots/guide/10_historical_domain_workspace.png)

### Cloud → Domain → SKU View

Switch grouping to **Cloud → Domain → SKU** for a full hierarchy view:

![Historical — Cloud → Domain → SKU](screenshots/guide/11_historical_cloud_domain_sku.png)

### DBU Mode

Toggle the **$DBU / DBUs** switch in the top-right to view consumption in raw DBU volume instead of dollars:

![Historical — DBU mode](screenshots/guide/12_historical_dbu_mode.png)

---

## Tab: Account Overview

The Account Overview tab gives a single-page summary of the account:

![Account Overview](screenshots/guide/13_account_overview.png)

Key metrics shown:
- **T12M Total Spend** — $12.5M for Kroger
- **Number of Workspaces** — 250 workspaces tracked
- **Number of Domains** — 22 business domains
- Domain spend breakdown table with T12M, Avg/Mo, and % share

---

## Tab: Demand Plan Summary

The Demand Plan Summary tab shows the 3-scenario high-level forecast:

![Demand Plan Summary](screenshots/guide/14_demand_plan_summary.png)

- **Scenario 1 (S1):** Existing baseline with 2% MoM growth
- **Scenario 2 (S2):** S1 + mid-term use cases (S2 use cases enabled in Scenario Builder)
- **Scenario 3 (S3):** S2 + long-term use cases (S3 use cases enabled)

Each scenario shows Year 1, Year 2, Year 3, and 3-Year Total columns. Use this tab to quickly compare how different use case portfolios affect total Databricks spend.

---

## Tab: Scenario Builder

The Scenario Builder is the core planning workspace. This is where you define use cases, timelines, sizes, and SKU breakdowns.

### Overview

![Scenario Builder — Overview](screenshots/guide/15_scenario_builder_overview.png)

The top section shows:
- **T12M Baseline** — actual historical monthly average
- **Year 1/2/3 Projected** — with UC breakdown
- **3-Year Total**
- **Historical Baseline table** — domain-by-domain breakdown used as the growth baseline
- **Baseline Growth Rate** — default is 2% MoM (editable)

### Adding a Use Case

Click **+ Add Use Case** to create a new forecast entry:

![Add Use Case](screenshots/guide/16_scenario_add_uc.png)

A new use case form opens:

![Use Case form expanded](screenshots/guide/17_scenario_uc_expanded.png)

### Filling in Use Case Details

![Filled use case — top](screenshots/guide/18_scenario_uc_filled_top.png)

Each use case has the following fields:

| Field | Description |
|-------|-------------|
| **Use Case Name** | Descriptive name (e.g., "Agentic AI Platform — Customer Personalization") |
| **Domain** | Business domain this use case belongs to (drives grouping in charts) |
| **Dollar uplift only** | Check if this is a pricing tier change with no new DBU volume |
| **Steady-State Size** | T-shirt size: XS ($3K/mo) → XXXL ($300K/mo) or Custom dollar amount |
| **Ramp Pattern** | Linear (even ramp) or Hockey Stick (slow then fast) |
| **Onboarding Month** | When development begins |
| **Live Month** | When the use case reaches full steady-state |
| **Include in Scenarios** | Which scenarios (S1/S2/S3) this use case contributes to |
| **Cloud** | Azure or GCP |
| **Workload Type** | ETL Pipeline, BI/Analytics, ML Platform, Agentic AI, Migration Workload, Custom |

### SKU Breakdown

![Workload type and SKU breakdown](screenshots/guide/18_scenario_uc_workload_sku.png)

After selecting a Workload Type and Size, a **SKU breakdown table** auto-populates with the typical SKU split for that workload. You can:

- **Change any SKU** from the dropdown (includes all Azure/GCP SKUs)
- **Adjust the % split** — must total 100%
- View auto-calculated **DBUs/month**, **$/DBU rate**, and **$/month** per SKU row
- **Add custom SKU rows** for new or emerging products

![SKU breakdown detail](screenshots/guide/19_scenario_sku_breakdown.png)

The total row shows:
- Total DBUs/month
- Weighted average $/DBU rate
- Total $/month (should match your selected size)

### Development Phase / Adhoc Usage

Use this section to model extra usage during development, POC, or pilot phases — on top of the steady-state ramp:

![Adhoc period](screenshots/guide/20_scenario_adhoc_period.png)

1. Click **+ Add Period**
2. Give the period a label (e.g., "Development Phase")
3. **Select the months** this extra usage applies to (blue = selected)
4. Click **Add SKU** and enter:
   - The **SKU type** for the extra usage
   - The **DBUs/month** amount
   - For standard SKUs: the list $/DBU rate is shown automatically
   - For custom SKUs: enter your $/DBU rate manually
5. The computed `$/mo` and total `($X total)` are shown read-only

The period summary badge updates live: **+20,000 DBUs/mo ($11K/mo) × 4 months = $44K**

### Saving a Scenario

Click **Save Scenario** (top-right of the Scenario Builder) to persist changes. The Consumption Forecast tab always reads from the last saved state.

![Scenario saved](screenshots/guide/21_scenario_saved.png)

> **Tip:** You can switch between S1, S2, S3 using the buttons at the top. Each scenario only includes use cases where you checked the corresponding scenario checkbox.

---

## Tab: Consumption Forecast

The Consumption Forecast tab shows a month-by-month table and chart built from the saved scenario.

### $ Mode (default)

![Consumption Forecast — S1](screenshots/guide/22_consumption_forecast_s1.png)

The table shows:
- **Use Cases section** (top) — read-only summary of active use cases and their SKU breakdowns with onboard/live month highlighted
- **Kroger forecast table** — monthly columns from the current month through 36 months out
  - **Existing Baseline** row — historical monthly spend grown at the configured MoM rate
  - **Use Case rows** — ramping from 0 at onboard to steady-state at live month, with SKU sub-rows expanded below
  - **⚡ Adhoc rows** — development/pilot periods shown inline with their DBU amounts and dollar equivalents
  - **Amber highlighting** on the onboarding month
  - **Green highlighting** on the go-live month
- **Total Forecast** row — sum of baseline + all active use cases

### DBU Mode

Toggle to **DBUs** to see all values in raw DBU volume instead of dollars:

![Consumption Forecast — DBU mode](screenshots/guide/23_consumption_forecast_dbu_mode.png)

The use case header shows **375K DBUs/mo** (the steady-state DBU equivalent of $75K/mo given the weighted average SKU rate).

### Forecast Chart

Scroll down to see the stacked bar chart:

![Consumption Forecast — Chart](screenshots/guide/24_consumption_forecast_chart.png)

The chart shows **Yearly $DBU** stacked by:
- Baseline (blue)
- Each active use case (green/other colors)

Toggle between **$DBU / DBU** and **Yearly / Monthly** views. Click **PNG** to download the chart.

### Scenario Switcher

Use the **S1 / S2 / S3** buttons at the top of the Consumption Forecast tab to switch between scenarios. S2 and S3 include progressively more use cases.

### Months Selector

The **Months** dropdown (12 / 24 / 36) controls how many months of columns are shown in the table.

---

## Export to Excel

Click **Export XLS** (top-right header) to download a full Excel workbook:

![Export XLS](screenshots/guide/26_export_xls.png)

The exported workbook contains multiple sheets:

| Sheet | Contents |
|-------|----------|
| **Historical** | T12M monthly actual consumption by domain and SKU |
| **Scenario 1 Forecast** | Month-by-month forecast table for S1 with SKU breakdown |
| **Scenario 2 Forecast** | Month-by-month forecast table for S2 |
| **Scenario 3 Forecast** | Month-by-month forecast table for S3 |
| **Use Cases** | All use case configurations — name, domain, size, ramp, SKUs, adhoc periods |

Adhoc periods in the Excel export show `+X,XXX DBUs/mo ($Y/mo)` format so all data is traceable back to DBU inputs.

---

## Tips & Best Practices

- **Use the Scenario flags (S1/S2/S3)** to separate committed use cases (S1) from pipeline/exploratory ones (S2/S3). This makes it easy to show a conservative vs. aggressive forecast to account teams.
- **Always click Save Scenario** before switching to the Consumption Forecast tab — the forecast is built from the last saved state.
- **Domain mapping drives everything** — a well-maintained domain CSV ensures Historical, Account Overview, and Scenario Builder all reflect accurate business domain groupings.
- **SKU breakdown accuracy** — using the actual SKUs a customer runs (e.g., Serverless vs. Classic All Purpose) gives more accurate $/DBU rates and DBU volumes.
- **Development Phase periods** are great for modeling POC burst spend, model training phases, or data migration windows that don't reflect steady-state usage.
