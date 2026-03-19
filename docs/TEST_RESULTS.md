# Demand Plan App — End-to-End Test Results

**Test Date:** 2026-03-19
**Accounts Tested:** Walmart (`0016100001TPKunAAH`), Vizio (Inscape dba Vizio LLC)
**Environment:** http://localhost:5173 (Vite dev server) + http://localhost:8000 (FastAPI backend)

---

## Test Summary

### Round 1 — Core Feature Tests

| # | Area | Test | Result |
|---|------|------|--------|
| 1 | Setup | App loads on Setup tab by default | ✅ Pass |
| 2 | Setup | Databricks connection status shown | ✅ Pass |
| 3 | Setup | Google OAuth authorization shown | ✅ Pass |
| 4 | Setup | Account search returns results | ✅ Pass |
| 5 | Setup | Search results close button works | ✅ Pass |
| 6 | Setup | Walmart account added successfully | ✅ Pass |
| 7 | Setup | Vizio account search and add | ✅ Pass |
| 8 | Setup | Walmart data loaded (Load button) | ✅ Pass |
| 9 | Setup | Vizio data loaded (Load button) | ✅ Pass |
| 10 | Demand Plan Summary | Summary tab shows both accounts | ✅ Pass |
| 11 | Demand Plan Summary | Scenario toggles work | ✅ Pass |
| 12 | Historical Consumption | Historical overview renders | ✅ Pass |
| 13 | Historical Consumption | Charts display correctly | ✅ Pass |
| 14 | Scenario Builder | Scenario builder loads | ✅ Pass |
| 15 | Scenario Builder | Add use case flow works | ✅ Pass |
| 16 | Consumption Forecast | Forecast tab renders | ✅ Pass |
| 17 | Account Overview | Account overview tab renders | ✅ Pass |
| 18 | Export | Export menu opens with 3 options | ✅ Pass |
| 19 | Export | Formatted Excel export (download) | ✅ Pass |
| 20 | Export | Upload to Google Drive | ✅ Pass |

**Round 1: 20/20 tests passed.**

### Round 2 — Use Case Addition Tests (2 Use Cases per Account)

| # | Area | Test | Result |
|---|------|------|--------|
| 21 | Setup | Both accounts present and loaded | ✅ Pass |
| 22 | Scenario Builder | Scenario Builder initial state | ✅ Pass |
| 23 | Scenario Builder | Walmart — Use Case 1 (Cloud Migration) added | ✅ Pass |
| 24 | Scenario Builder | Walmart — Use Case 2 (Data Integration Pipeline) added | ✅ Pass |
| 25 | Scenario Builder | Vizio — Use Case 1 (Cloud Migration) added | ✅ Pass |
| 26 | Scenario Builder | Vizio — Use Case 2 (Datalake Optimization) added | ✅ Pass |
| 27 | Scenario Builder | All 4 use cases visible in builder | ✅ Pass |
| 28 | Demand Plan Summary | Summary reflects new use case projections | ✅ Pass |
| 29 | Consumption Forecast | Forecast updated with use case data | ✅ Pass |
| 30 | Export | Export menu accessible | ✅ Pass |
| 31 | Export | Formatted Export with use cases | ✅ Pass |
| 32 | Export | Drive upload with use cases | ✅ Pass |
| 33 | Export | Drive URL shown in success toast | ✅ Pass |
| 34 | General | App stable after all operations | ✅ Pass |

**Round 2: 14/14 tests passed. Total: 34/34 tests passed.**

---

## Screenshots

### 1. Setup Tab — Initial Load
App opens on the Setup tab by default (not Summary).

![Setup Initial](test-screenshots/01_setup_initial.png)

---

### 2. Setup — Databricks Connected
Databricks connection status indicator is shown as connected.

![Databricks Connected](test-screenshots/02_setup_databricks_connected.png)

---

### 3. Setup — Google Authorized
Google OAuth authorization status displayed.

![Google Authorized](test-screenshots/03_setup_google_authorized.png)

---

### 4. Setup — Account Search Results
Searching for "Walmart" returns matching accounts. Results panel is shown with a close (×) button.

![Account Search](test-screenshots/04_setup_account_search.png)

---

### 5. Setup — Walmart Account Added
Walmart selected and added to the account list. Search results panel auto-closes after adding.

![Walmart Added](test-screenshots/05_setup_walmart_added.png)

---

### 6. Setup — Vizio Search
Searching for "Vizio" to add as the second account.

![Vizio Search](test-screenshots/06_setup_vizio_search.png)

---

### 7. Setup — Vizio Account Added
Vizio (Inscape dba Vizio LLC) added successfully. Two accounts now configured.

![Vizio Added](test-screenshots/06_setup_vizio_added.png)

---

### 8. Setup — Walmart Data Loaded
Walmart data loaded via the per-account Load button. Contract start date and use cases visible.

![Walmart Loaded](test-screenshots/07_setup_walmart_loaded.png)

---

### 9. Setup — Vizio Data Loaded
Vizio data loaded. Both accounts ready with historical and scenario data.

![Vizio Loaded](test-screenshots/08_setup_vizio_loaded.png)

---

### 10. Demand Plan Summary — Overview
Summary tab shows combined demand plan data for both Walmart and Vizio accounts.

![Summary Overview](test-screenshots/09_summary_overview.png)

---

### 11. Demand Plan Summary — Scenarios
Scenario comparison (S1/S2/S3) visible in the Summary tab.

![Summary Scenarios](test-screenshots/10_summary_scenarios.png)

---

### 12. Historical Consumption — Overview
Historical Consumption tab displays usage data overview for the loaded accounts.

![Historical Overview](test-screenshots/11_historical_overview.png)

---

### 13. Historical Consumption — Charts
Historical consumption charts rendered with domain and SKU breakdowns.

![Historical Charts](test-screenshots/12_historical_charts.png)

---

### 14. Scenario Builder — Main View
Scenario Builder tab loaded with S1/S2/S3 scenario configuration panels.

![Scenario Builder](test-screenshots/13_scenario_builder.png)

---

### 15. Scenario Builder — Add Use Case
Add Use Case dialog/flow works within the Scenario Builder.

![Add Use Case](test-screenshots/14_scenario_add_usecase.png)

---

### 16. Consumption Forecast
Consumption Forecast tab renders projected usage charts.

![Consumption Forecast](test-screenshots/15_consumption_forecast.png)

---

### 17. Account Overview
Account Overview tab shows account-level metadata and summary.

![Account Overview](test-screenshots/16_account_overview.png)

---

### 18. Export Menu
Export menu opens with all three options:
- **Formatted Export** (ExcelJS)
- **Basic Export** (SheetJS)
- **Upload to Google Drive**

![Export Menu](test-screenshots/17_export_menu.png)

---

### 19. Formatted Excel Export
Formatted Excel file downloaded successfully. File includes:
- Demand Plan Summary sheet
- S1 / S2 / S3 Projection sheets (all accounts, real calendar month headers)
- Per-account Historical sheets (Hist-Domain, Hist-SKU, Cloud-Domain-SKU)
- Per-account Use Case Details sheets with SKU sub-rows and assumptions

![Formatted Export](test-screenshots/18_export_formatted.png)

---

### 20. Upload to Google Drive
Excel file built and uploaded to Google Drive via the backend `/api/export/upload-to-drive` endpoint. Toast notification shows:
- Upload success confirmation
- Full Google Drive URL in a copyable monospace box
- "Open in Drive →" link for direct access

![Drive Upload](test-screenshots/19_export_drive_upload.png)

---

---

## Round 2 — Use Case Addition Screenshots

### 21. Initial App State (Round 2 Start)
App loaded with both accounts already configured.

![Initial State](test-screenshots/uc_01_initial_state.png)

---

### 22. Setup — Both Accounts Loaded
Walmart and Vizio both shown in Setup tab with data loaded.

![Accounts Loaded](test-screenshots/uc_02_setup_accounts_loaded.png)

---

### 23. Scenario Builder — Initial State
Scenario Builder tab before adding any use cases.

![Scenario Builder Initial](test-screenshots/uc_03_scenario_builder_initial.png)

---

### 24. Walmart — Use Case 1 Added (Cloud Migration)
**Cloud Migration** added to Walmart Scenario 1:
- Domain: Inscape | Size: M ($15K/mo, $180K/yr) | Ramp: Linear
- Onboarding: M3Y1 (Jul 2026) → Live: M8Y1 (Dec 2026)
- Y1: $113K | Y2: $180K | Y3: $180K | Total: $473K

![Walmart UC1](test-screenshots/uc_04_walmart_usecase1_added.png)

---

### 25. Walmart — Use Case 2 Added (Data Integration Pipeline)
**Data Integration Pipeline** added to Walmart Scenario 1:
- Domain: Unmapped | Size: XL ($75K/mo, $900K/yr) | Ramp: Linear
- Onboarding: M2Y1 (Jun 2026) → Live: M7Y1 (Nov 2026)
- Y1: $375K | Y2: $900K | Y3: $900K | Total: $2.175M

![Walmart UC2](test-screenshots/uc_05_walmart_usecase2_added.png)

---

### 26. Vizio — Use Case 1 Added (Cloud Migration)
**Cloud Migration** added to Vizio Scenario 1:
- Domain: Inscape | Size: M ($15K/mo, $180K/yr) | Ramp: Linear
- Onboarding: M3Y1 → Live: M8Y1
- Y1: $113K | Y2: $180K | Y3: $180K | Total: $473K

![Vizio UC1](test-screenshots/uc_06_vizio_usecase1_added.png)

---

### 27. Vizio — Use Case 2 Added (Datalake Optimization)
**Datalake Optimization** added to Vizio Scenario 1:
- Domain: Datalake | Size: S ($5K/mo, $60K/yr) | Ramp: Linear
- Onboarding: M3Y1 → Live: M8Y1
- Y1: $38K | Y2: $60K | Y3: $60K | Total: $158K

![Vizio UC2](test-screenshots/uc_07_vizio_usecase2_added.png)

---

### 28. All Use Cases Added (4 Total)
Scenario Builder showing all 4 use cases — 2 per account.

![All Use Cases](test-screenshots/uc_08_all_usecases_added.png)

---

### 29. Demand Plan Summary — With Use Cases
Summary tab updated with projections including the new use cases.

| Account | Year 1 | Year 2 | Year 3 | Total |
|---------|--------|--------|--------|-------|
| Walmart | $26.9M | $27.5M | $28.0M | $82.4M |
| Vizio | $12.4M | $12.7M | $13.0M | $38.1M |
| **Combined** | **$39.3M** | **$40.2M** | **$41.0M** | **$120.5M** |

![Summary with Use Cases](test-screenshots/uc_09_summary_with_usecases.png)

---

### 30. Consumption Forecast — With Use Cases
Monthly forecast updated to reflect added use cases.

![Forecast with Use Cases](test-screenshots/uc_10_forecast_with_usecases.png)

---

### 31. Export Menu (Round 2)
All 3 export options remain accessible after adding use cases.

![Export Menu](test-screenshots/uc_11_export_menu.png)

---

### 32. Formatted Export — With Use Cases
Excel file downloaded including all 4 use cases (2 per account) in projection and detail sheets.

![Formatted Export](test-screenshots/uc_12_formatted_export.png)

---

### 33. Google Drive Upload — Success Toast
Excel file with use cases uploaded to Drive. Drive URL shown in copyable toast.

- **File:** `Demand_Plan_Walmart_Inscape dba Vizio LLC_AllScenarios_2026-03-19.xlsx`
- **Drive URL:** https://drive.google.com/file/d/1Fb5DooKeUf7Bc7eI76nULSoOPuxjA962/view

![Drive Upload Success](test-screenshots/uc_13_drive_upload_success.png)

---

### 34. Final App State
App remains stable and responsive after all operations.

![Final State](test-screenshots/uc_14_final_state.png)

---

## Export Sheet Structure (Verified)

| Order | Sheet Name | Description |
|-------|-----------|-------------|
| 1 | Demand Plan Summary | Combined summary for all accounts |
| 2 | S1 - Projection | Scenario 1: all accounts, real month headers, SKU rows |
| 3 | S2 - Projection | Scenario 2: same structure |
| 4 | S3 - Projection | Scenario 3: same structure |
| 5 | `<Account> Hist-Domain` | Per-account historical by domain |
| 6 | `<Account> Hist-SKU` | Per-account historical by SKU |
| 7 | `<Account> Cloud-Domain-SKU` | Per-account cloud/domain/SKU breakdown |
| 8 | `<Account> Use Cases` | Use case details with SKU sub-rows |
| 9 | `<Account> Baseline` | Baseline consumption data |
| 10 | `<Account> SKU Detail` | SKU-level detail sheet |
| *(repeats 5–10 for each additional account)* | | |

## Key Features Verified

- **Default Setup Tab**: App opens on Setup tab, not Summary
- **Account Search Close Button**: × button in search results panel, auto-closes after adding
- **Real Calendar Month Headers**: `May_2026`, `Jun_2026` format replaces `M1`, `M2` placeholders
- **Multi-Account Projection Sheets**: All accounts appear as sections within S1/S2/S3 sheets
- **SKU Breakdown Rows**: `└─ SKU Name (N%)` sub-rows under each use case in projection sheets
- **Per-Account Historical Sheets**: Named `Walmart Hist-Domain`, `Vizio Hist-Domain`, etc.
- **Vizio Data in Summary**: Fixed — lookup uses `sfdc_id` not display name
- **Google Drive Upload**: Backend multipart upload with Drive URL returned and displayed in toast
