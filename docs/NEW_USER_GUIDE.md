# Demand Plan App — New User Documentation Guide

**Last Updated:** March 19, 2026  
**Version:** 1.0  
**Status:** Production-Ready

---

## Table of Contents
1. [Getting Started](#getting-started)
2. [Setup Tab Walkthrough](#setup-tab-walkthrough)
3. [Adding Your First Account](#adding-your-first-account)
4. [Historical Consumption Review](#historical-consumption-review)
5. [Creating Scenarios](#creating-scenarios)
6. [Viewing Summaries](#viewing-summaries)
7. [Exporting Results](#exporting-results)
8. [Troubleshooting](#troubleshooting)

---

## Getting Started

### Access the App
Navigate to your Demand Plan App instance (e.g., `http://localhost:5173`)

You'll see the **Setup** tab by default. This is where you configure everything before analyzing demand plans.

**Screenshot:** `01_app_landing.png`

### The Six Main Tabs
```
Setup → Historical Consumption → Scenario Builder → Summary → Forecast → Overview
```

Each tab builds on the previous steps. You must complete Setup before accessing other features.

---

## Setup Tab Walkthrough

The Setup tab has three sequential steps. Complete them in order.

### Step 1: Connect to Databricks Workspace

**Screenshot:** `03_databricks_connection.png`

1. Enter your **Databricks Workspace URL**
   - Example: `https://adb-1234567890.azuredatabricks.net`
   - Find this in your Databricks account

2. Generate a **Personal Access Token**
   - In Databricks: Settings → Developer → Access Tokens
   - Create a new token (30-90 day expiration recommended)
   - Copy the full token value

3. Paste the token into the password field
   - The field masks the token for security

4. Click **"Connect & Validate"**
   - The app will test the connection
   - You'll see a warehouse dropdown if successful
   - Select your preferred SQL warehouse
   - Click "Save Warehouse"

**Status indicator:** When complete, Step 1 shows a green checkmark

### Step 2: Authorize Google Drive Access

**Screenshot:** `04_google_auth.png`

This step enables reading domain mapping sheets from Google Sheets.

1. Click **"Authorize with Google"**
2. The app tries your local `gcloud` login first
   - If you have Google Cloud SDK installed and logged in, authorization happens automatically
3. If `gcloud` isn't available:
   - You'll see an OAuth device flow code
   - Visit the provided URL in your browser
   - Enter the code shown
   - Approve access to Google Sheets
   - Return to the app (it auto-detects authorization)

**Status indicator:** When complete, Step 2 shows a green checkmark and "Google Sheets access is active"

### Step 3: Pick Accounts

**Screenshot:** `05_kroger_search.png`

This step becomes available only after Step 1 is complete.

1. Enter an account name in the search box (e.g., "Kroger", "84.51")
2. Results appear from your Logfood database
3. Click to select an account
4. Fill in two required fields:
   - **SFDC ID:** Salesforce Account ID (e.g., `0016100001IwIDPAA3`)
   - **Domain Mapping URL:** Google Sheet URL with field mappings
5. Click **"Load"** to import account data
   - First load may take 1-2 minutes
   - Progress appears while loading

**Example accounts:**
```
Kroger
  SFDC ID: 0016100001IwIDPAA3
  Mapping: https://docs.google.com/spreadsheets/d/1W963Md2JOecit2OcQkbZSo2e3ksYLAxkKVoj-hPjaF8/edit

84.51
  SFDC ID: 0016100000afNAcAAM
  Mapping: https://docs.google.com/spreadsheets/d/1Q1ijklacquNupKmETUV7kFX9G2ls-Zl05tSE9eLdmA0/edit
```

Repeat Step 3 for each account you want to analyze.

---

## Adding Your First Account

### Complete Workflow

1. **Setup Prerequisites** (all 3 steps above)

2. **Search for Account**
   - Type account name in Step 3 search box
   - Results load from Logfood

3. **Select Account**
   - Click on the account name in results
   - Fields appear for SFDC ID and Domain Mapping URL

4. **Fill Account Details**
   - **SFDC ID:** Paste the Salesforce Account ID
   - **Domain Mapping URL:** Paste the Google Sheet URL
   - These map your database fields to consumption metrics

5. **Load Account Data**
   - Click "Load" button
   - Status shows "Loading..." with a spinner
   - Once complete (1-2 minutes):
     - Data is cached locally
     - Other tabs become populated
     - Account appears in Account Overview

6. **Add More Accounts** (optional)
   - Repeat Steps 2-5 for additional accounts
   - Each loads independently
   - You can analyze multiple accounts simultaneously

---

## Historical Consumption Review

**Screenshot:** `12_historical_tab.png`

### What You'll See

After adding accounts, this tab shows:
- **12-month consumption history** for each account
- **Trend lines** showing growth/decline patterns
- **Seasonal variations** and cyclical patterns
- **Baseline data** used for scenario projections

### How to Use This Tab

1. **Review baselines** before creating scenarios
2. **Identify seasonal patterns** (Q4 peaks, summer dips, etc.)
3. **Note growth trends** year-over-year
4. **Understand consumption drivers** before modeling
5. **Share with stakeholders** as context for projections

### Key Metrics
- Total consumption by month
- Year-to-date (YTD) consumption
- Month-over-month (MoM) growth rate
- Comparison to previous year (YoY)

---

## Creating Scenarios

**Screenshot:** `14_scenario_builder_overview.png`

### Overview

The Scenario Builder lets you model different demand plans using "use cases" — workloads or features that drive additional consumption.

### Three Scenarios
- **S1 (Scenario 1):** Baseline/conservative case
- **S2 (Scenario 2):** Expected/most likely case
- **S3 (Scenario 3):** Aggressive/upside case

Use these for sensitivity analysis and planning under different conditions.

### Adding a Use Case

1. **Select a scenario** (click S1, S2, or S3 tab)
2. **Click "Add Use Case"** button
3. **Choose use case type** from dropdown:
   - Data Lakehouse
   - ML/AI
   - Delta Sharing
   - ETL Migration
   - (and others)
4. **Enter parameters:**
   - Name/description
   - Start date
   - Growth rate or flat consumption
   - Affected domains
5. **System calculates** incremental consumption impact
6. **Click "Save Scenario"** to persist

### Example Scenario

**S1 (Conservative):**
- Data Lakehouse (low usage)
- Small ETL migration

**S2 (Expected):**
- Data Lakehouse (medium usage)
- ETL Migration (full)
- ML/AI pilots

**S3 (Aggressive):**
- Data Lakehouse (full)
- Complete Delta Sharing
- Full ML/AI platform
- ETL migration + legacy replacement

---

## Viewing Summaries

**Screenshot:** `24_summary_tab.png`

### What This Tab Shows

After adding accounts and scenarios, the Summary tab displays:
- **Consumption by year** (Y1, Y2, Y3)
- **Scenario comparison** (S1 vs S2 vs S3)
- **Use case breakdown** (which features drive consumption)
- **Cost projections** (if pricing is configured)
- **Export-ready format** (ready for presentations)

### How to Use This Tab

1. **Switch between scenarios** using tabs (S1, S2, S3)
2. **Review totals** to validate projections
3. **Identify hotspots** (which use cases drive most consumption)
4. **Compare scenarios** to guide planning decisions
5. **Note deltas** from baseline to scenario
6. **Prepare for export** to stakeholders

### Metrics Shown

| Metric | Meaning |
|--------|---------|
| Baseline | Current 12-month consumption |
| S1 Total | Conservative scenario total |
| S2 Total | Expected scenario total |
| S3 Total | Aggressive scenario total |
| Y1 Delta | Year 1 change vs baseline |
| Y2 Delta | Year 2 change vs baseline |
| Y3 Delta | Year 3 change vs baseline |

---

## Exporting Results

**Screenshot:** `30_export_menu.png`

### Export Options

Click the **"Export XLS"** button in the header to see three options:

#### 1. Formatted Export
- **Output:** Colored Excel workbook
- **Includes:** Headers, formatting, freeze panes
- **Content:** All 3 scenarios across 10 sheets
- **Use case:** Presentations, executive reports, stakeholder sharing
- **Size:** 2-5 MB depending on account count

#### 2. Basic Export
- **Output:** Plain Excel file, no formatting
- **Includes:** All data, all scenarios
- **Use case:** Data analysis, manipulation, imports
- **Size:** Smaller file size

#### 3. Upload to Google Drive
- **Output:** Formatted export saved to your Google Drive
- **Includes:** Same as Formatted Export
- **Use case:** Collaboration, version control, cloud backup
- **Requires:** Google authorization completed (Step 2)
- **Result:** You receive a shareable Google Drive URL

### Export Workflow

1. **Click "Export XLS"** in top right
2. **Select export type** from dropdown
3. **Wait for processing** (shows "Exporting..." status)
4. **For local download:** File downloads to your default Downloads folder
5. **For Google Drive:** Upload completes, toast shows Drive URL
6. **Share results:** Use the exported file/URL with stakeholders

### What's Included

Each export contains:
- **Summary sheet** with all scenarios and total consumption
- **Scenario sheets** (one per scenario) with use case details
- **Historical sheet** with baseline consumption data
- **Forecast sheets** (if applicable) with projections

---

## Consumption Forecast Tab

**Screenshot:** `28_consumption_forecast.png`

### Features (When Data Loaded)

- **Trend visualization** showing consumption over time
- **Forecast lines** extending beyond historical period
- **Confidence intervals** showing uncertainty ranges
- **Sensitivity analysis** for key drivers
- **What-if scenarios** for planning

### Using Forecasts

1. Review the historical trend (blue line)
2. Examine the forecast (projected forward)
3. Check confidence intervals (gray shaded area)
4. Adjust scenarios if forecast seems off
5. Use for budget planning and capacity requests

---

## Account Overview Tab

**Screenshot:** `29_account_overview.png`

### Dashboard View

This tab provides a dashboard of all configured accounts:
- **Account list** with status indicators
- **Current consumption** metrics
- **Growth trend** visualization
- **Quick actions** (Load, Configure, Edit)
- **Performance indicators** (on-track, at-risk, etc.)

### Key Actions

- **Load:** Update account data
- **Configure:** Edit SFDC ID or mapping URL
- **Edit:** Modify account name or settings
- **Delete:** Remove account from analysis

---

## Troubleshooting

### Issue: Account Search Not Working

**Cause:** Step 1 (Databricks connection) not completed

**Solution:**
1. Go to Setup tab
2. Complete Step 1 (Databricks connection)
3. Select and save a warehouse
4. Return to Step 3 — search should now work

### Issue: "Loading..." Appears but Doesn't Complete

**Cause:** Databricks or network timeout

**Solution:**
1. Check your internet connection
2. Verify Databricks workspace is accessible
3. Confirm personal access token is valid
4. Try clicking "Load" again
5. If persistent, contact support

### Issue: Export Button Disabled

**Cause:** Export in progress or no data to export

**Solution:**
1. Wait for "Exporting..." to complete
2. Add at least one account first
3. Create at least one scenario before exporting

### Issue: Google Drive Upload Fails

**Cause:** Google authorization not completed

**Solution:**
1. Go to Setup tab
2. Complete Step 2 (Google authorization)
3. Try export again

### Issue: Data Appears Incorrect

**Cause:** Domain mapping sheet has errors

**Solution:**
1. Verify the domain mapping URL is correct
2. Check the Google Sheet has proper column headers
3. Ensure SFDC ID matches Logfood records
4. Contact data team to validate mapping

---

## Best Practices

### For Accurate Planning
1. **Start with historical analysis** — understand your baseline
2. **Create conservative scenario (S1)** — minimum expected growth
3. **Create expected scenario (S2)** — most likely case
4. **Create aggressive scenario (S3)** — opportunity case
5. **Validate assumptions** with stakeholders

### For Stakeholder Sharing
1. **Export formatted** for presentations
2. **Share via Google Drive** for feedback
3. **Include historical context** (why these scenarios)
4. **Highlight key drivers** (which use cases matter most)
5. **Note assumptions** clearly

### For Regular Use
1. **Update monthly** after new consumption data arrives
2. **Track actuals vs forecast** to improve accuracy
3. **Adjust scenarios quarterly** based on business changes
4. **Archive exports** for audit trail
5. **Review with finance** before budget submission

---

## FAQ

**Q: Can I have multiple scenarios per account?**  
A: Yes! S1, S2, and S3 are all analyzed per account.

**Q: Can I edit a scenario after saving?**  
A: Yes, click on the scenario and modify use cases, then click "Save Scenario" again.

**Q: What if I added the wrong account?**  
A: Go to Account Overview, find the account, and click Delete. Then add the correct one.

**Q: How often should I update the data?**  
A: Monthly after new consumption metrics are available in Databricks.

**Q: Can I compare accounts across scenarios?**  
A: Yes! The Summary tab shows all scenarios for all accounts.

**Q: What formats can I export?**  
A: Excel (.xlsx) locally or Google Drive for cloud backup/sharing.

---

## Support & Documentation

- **Full Technical Report:** See `WALKTHROUGH_REPORT.md`
- **JSON Summary:** See `WALKTHROUGH_SUMMARY.json`
- **Screenshots:** See `/guide-screenshots/` folder

For issues, contact your Databricks administrator or data team.

---

**End of Guide**

Version 1.0 — March 19, 2026
