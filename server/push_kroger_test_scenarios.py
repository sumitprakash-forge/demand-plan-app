#!/usr/bin/env python3
"""
Push 12 test use cases to Kroger account on the deployed app.
- Uses REAL Kroger UC names from Logfood
- Configures test scenario parameters per the test plan
- Adds test description explaining what each UC tests
- Pushes via authenticated API call to deployed app
"""

import json
import time
import sys
import ssl
import urllib.request
import urllib.parse
from pathlib import Path

_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE

# ── Auth ─────────────────────────────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent))
from jose import jwt

JWT_SECRET = "demand-plan-prod-secret-ncc-2025"
token = jwt.encode({
    "sub": "sumit.prakash@databricks.com",
    "host": "https://adb-2548836972759138.18.azuredatabricks.net",
    "pat": "demo",
    "exp": int(time.time()) + 7200,
    "iat": int(time.time()),
}, JWT_SECRET, algorithm="HS256")

BASE_URL = "https://demand-plan-app-1444828305810485.aws.databricksapps.com"
COOKIE   = f"dp_session={token}"

def api(method, path, body=None):
    url = BASE_URL + path
    data = json.dumps(body).encode() if body else None
    headers = {"Cookie": COOKIE, "Content-Type": "application/json"}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30, context=_ssl_ctx) as r:
        return json.loads(r.read())

# ── 12 Test Use Cases mapped to real Kroger Logfood UCs ──────────────────────

ALL_UCS = [

    # UC1 — Simple Linear Ramp, Single SKU
    # Real UC: Kroger - AI Factory - DMP Build out
    {
        "id": "aAvVp000000Yi1pKAC",
        "name": "Kroger - AI Factory - DMP Build out",
        "domain": "Data Engineering",
        "cloud": "AWS", "tier": "premium",
        "steadyStateDbu": 10000,
        "onboardingMonth": 1, "liveMonth": 4,
        "rampType": "linear",
        "upliftOnly": False,
        "scenarios": [True, False, False],
        "skuBreakdown": [
            {"sku": "Jobs Compute", "percentage": 100, "dollarDbu": 10000},
        ],
        "adhocPeriods": [],
        "description": (
            "TEST UC1 — Simple Linear Ramp, Single SKU (Baseline check). "
            "Steady-state $10K/mo, AWS Premium, M1→M4 linear, Jobs Compute 100%, S1 only. "
            "Tests: Simplest possible case. "
            "Expected: Y1=$105K (2.5K+5K+7.5K + 9×10K), Y2=$120K, Y3=$120K."
        ),
    },

    # UC2 — Hockey Stick Ramp, Single SKU
    # Real UC: Kroger - Retail Sales - Customer Platform Analytics
    {
        "id": "aAvVp000000WfEXKA0",
        "name": "Kroger - Retail Sales - Customer Platform Analytics",
        "domain": "Analytics",
        "cloud": "Azure", "tier": "premium",
        "steadyStateDbu": 15000,
        "onboardingMonth": 1, "liveMonth": 7,
        "rampType": "hockey_stick",
        "upliftOnly": False,
        "scenarios": [True, True, False],
        "skuBreakdown": [
            {"sku": "Serverless SQL", "percentage": 100, "dollarDbu": 15000},
        ],
        "adhocPeriods": [],
        "description": (
            "TEST UC2 — Hockey Stick Ramp, Single SKU. "
            "Steady-state $15K/mo, Azure Premium, M1→M7 hockey stick, Serverless SQL 100%, S1+S2. "
            "Tests: Non-linear ramp curve; verify progress^2.5 formula. "
            "Expected: Y1≈$112,948, Y2=$180K, Y3=$180K."
        ),
    },

    # UC3 — Multi-SKU Blended Rate (ETL Preset)
    # Real UC: Kroger - Associate Experience Phase 2 - Production HR Marketplace Hub
    {
        "id": "aAvVp000000gkT3KAI",
        "name": "Kroger - Associate Experience Phase 2 - Production HR Marketplace Hub",
        "domain": "Data Engineering",
        "cloud": "AWS", "tier": "premium",
        "steadyStateDbu": 20000,
        "onboardingMonth": 2, "liveMonth": 6,
        "rampType": "linear",
        "upliftOnly": False,
        "scenarios": [True, True, True],
        "skuBreakdown": [
            {"sku": "Jobs Compute",          "percentage": 50, "dollarDbu": 10000},
            {"sku": "Jobs Compute (Photon)",  "percentage": 30, "dollarDbu":  6000},
            {"sku": "DLT Core",               "percentage": 20, "dollarDbu":  4000},
        ],
        "adhocPeriods": [],
        "description": (
            "TEST UC3 — Multi-SKU Blended Rate (ETL Preset). "
            "Steady-state $20K/mo, AWS Premium, M2→M6 linear, "
            "Jobs Compute 50% + Photon 30% + DLT Core 20%, S1+S2+S3. "
            "Tests: Blended DBU rate = sum(dbus)/sum(dollarDbu) across different SKU prices. "
            "Expected: Y1=$220K (0+4K+8K+12K+16K + 7×20K), Y2=$240K, Y3=$240K."
        ),
    },

    # UC4 — ML Platform, All Scenarios
    # Real UC: Kroger - DIEM - In-Store Messages / Zerobus
    {
        "id": "aAvVp00000159N3KAI",
        "name": "Kroger - DIEM - In-Store Messages / Zerobus",
        "domain": "AI/ML",
        "cloud": "GCP", "tier": "enterprise",
        "steadyStateDbu": 50000,
        "onboardingMonth": 3, "liveMonth": 9,
        "rampType": "linear",
        "upliftOnly": False,
        "scenarios": [True, True, True],
        "skuBreakdown": [
            {"sku": "All Purpose Compute", "percentage": 35, "dollarDbu": 17500},
            {"sku": "Model Serving",        "percentage": 30, "dollarDbu": 15000},
            {"sku": "Jobs Compute",         "percentage": 25, "dollarDbu": 12500},
            {"sku": "Serverless SQL",       "percentage": 10, "dollarDbu":  5000},
        ],
        "adhocPeriods": [],
        "description": (
            "TEST UC4 — ML Platform, All Scenarios. "
            "Steady-state $50K/mo, GCP Enterprise, M3→M9 linear, "
            "APC 35% + Model Serving 30% + Jobs 25% + Serverless SQL 10%, S1+S2+S3. "
            "Tests: Enterprise tier pricing, 4-SKU blended rate, late onboarding. "
            "Expected: Y1=$475K (0+0 + 6 ramp months + 4×50K), Y2=$600K, Y3=$600K."
        ),
    },

    # UC5 — Uplift Only — Serverless Migration
    # Real UC: Kroger - All domains - Serverless Interactive Adoption - Phase 1
    {
        "id": "aAvVp000000jUgHKAU",
        "name": "Kroger - All domains - Serverless Interactive Adoption - Phase 1",
        "domain": "Platform",
        "cloud": "AWS", "tier": "premium",
        "steadyStateDbu": 8000,
        "onboardingMonth": 1, "liveMonth": 3,
        "rampType": "linear",
        "upliftOnly": True,
        "scenarios": [False, True, False],
        "skuBreakdown": [
            {"sku": "Serverless SQL", "percentage": 100, "dollarDbu": 8000},
        ],
        "adhocPeriods": [],
        "description": (
            "TEST UC5 — Uplift Only, Serverless Migration. "
            "Steady-state $8K/mo uplift, AWS Premium, M1→M3 linear, Serverless SQL 100%, S2 only. "
            "upliftOnly=TRUE — dollar uplift shows but DBU=0 everywhere. "
            "Tests: Critical DBU total accuracy — no new DBU volume added. "
            "Expected: Y1=$88K, Y2=$96K, Y3=$96K; DBU rows all zero."
        ),
    },

    # UC6 — Adhoc Period Only (No Ramp)
    # Real UC: Kroger - DIEM - Netezza Migration
    {
        "id": "aAvVp000000kLkbKAE",
        "name": "Kroger - DIEM - Netezza Migration",
        "domain": "Data Engineering",
        "cloud": "AWS", "tier": "premium",
        "steadyStateDbu": 1,        # near-zero so ramp contributes nothing
        "onboardingMonth": 1, "liveMonth": 1,
        "rampType": "linear",
        "upliftOnly": False,
        "scenarios": [True, False, False],
        "skuBreakdown": [
            {"sku": "Jobs Compute", "percentage": 100, "dollarDbu": 1},
        ],
        "adhocPeriods": [
            {
                "label": "Migration Sprint",
                "months": [1, 2, 3],
                "skuAmounts": [
                    {"sku": "Jobs Compute", "dbuPerMonth": 33333, "dollarPerMonth": 5000},
                ],
            },
        ],
        "description": (
            "TEST UC6 — Adhoc Period Only (No Ramp). "
            "Steady-state ~$0 (set to $1), M1=M1 (instant-on), Jobs Compute, S1 only. "
            "Adhoc 'Migration Sprint': months 1-3, $5K/mo + 33,333 DBU/mo. "
            "Tests: Pure adhoc scenario — $ from dollarPerMonth, DBU from dbuPerMonth directly. "
            "Expected: Y1=$15K adhoc only, consumption forecast shows indigo sub-rows M1-M3."
        ),
    },

    # UC7 — Ramp + Adhoc (Combined)
    # Real UC: Kroger - AI/ML - Data Science Fulfillment Team
    {
        "id": "aAvVp000001LNp3KAG",
        "name": "Kroger - AI/ML - Data Science Fulfillment Team",
        "domain": "AI/ML",
        "cloud": "AWS", "tier": "premium",
        "steadyStateDbu": 25000,
        "onboardingMonth": 4, "liveMonth": 10,
        "rampType": "hockey_stick",
        "upliftOnly": False,
        "scenarios": [True, True, False],
        "skuBreakdown": [
            {"sku": "Foundation Model API", "percentage": 40, "dollarDbu": 10000},
            {"sku": "Model Serving",         "percentage": 25, "dollarDbu":  6250},
            {"sku": "Vector Search",         "percentage": 20, "dollarDbu":  5000},
            {"sku": "Serverless SQL",        "percentage": 15, "dollarDbu":  3750},
        ],
        "adhocPeriods": [
            {
                "label": "Dev Phase",
                "months": [1, 2, 3],
                "skuAmounts": [
                    {"sku": "Foundation Model API", "dbuPerMonth": 28571, "dollarPerMonth": 3000},
                ],
            },
            {
                "label": "Pilot Acceleration",
                "months": [5, 6],
                "skuAmounts": [
                    {"sku": "Foundation Model API", "dbuPerMonth": 71428, "dollarPerMonth": 7500},
                ],
            },
        ],
        "description": (
            "TEST UC7 — Ramp + Adhoc (Combined). "
            "Steady-state $25K/mo, AWS Premium, M4→M10 hockey stick, "
            "FM API 40% + Model Serving 25% + Vector Search 20% + SQL 15%, S1+S2. "
            "Adhoc 'Dev Phase': M1-M3 $3K/mo + 28,571 DBU/mo. "
            "Adhoc 'Pilot Acceleration': M5-M6 $7.5K/mo + 71,428 DBU/mo. "
            "Tests: Adhoc before ramp + adhoc mid-ramp. Hardest case for export DBU fix."
        ),
    },

    # UC8 — Starts Live (Month 1, No Ramp)
    # Real UC: Kroger - Store Associate - DBSQL BI reporting
    {
        "id": "aAvVp000000jWq9KAE",
        "name": "Kroger - Store Associate - DBSQL BI reporting",
        "domain": "Analytics",
        "cloud": "Azure", "tier": "premium",
        "steadyStateDbu": 30000,
        "onboardingMonth": 1, "liveMonth": 1,
        "rampType": "linear",
        "upliftOnly": False,
        "scenarios": [False, False, True],
        "skuBreakdown": [
            {"sku": "Serverless SQL",  "percentage": 60, "dollarDbu": 18000},
            {"sku": "SQL Warehouse",   "percentage": 40, "dollarDbu": 12000},
        ],
        "adhocPeriods": [],
        "description": (
            "TEST UC8 — Starts Live (Month 1, No Ramp). "
            "Steady-state $30K/mo, Azure Premium, M1=M1 (instant-on, no ramp), "
            "Serverless SQL 60% + SQL Warehouse 40%, S3 only. "
            "Tests: Edge case where onboarding=live month. "
            "Expected: All 36 months exactly $30K → Y1=$360K, Y2=$360K, Y3=$360K."
        ),
    },

    # UC9 — Starts Late (M24) — Short Contribution
    # Real UC: Kroger - DIEM - Phase 2 Migrate on-prem Informatica
    {
        "id": "aAvVp000001H5abKAC",
        "name": "Kroger - DIEM - Phase 2 Migrate on-prem Informatica",
        "domain": "Data Engineering",
        "cloud": "AWS", "tier": "enterprise",
        "steadyStateDbu": 40000,
        "onboardingMonth": 24, "liveMonth": 30,
        "rampType": "linear",
        "upliftOnly": False,
        "scenarios": [True, True, True],
        "skuBreakdown": [
            {"sku": "DLT Advanced",    "percentage": 60, "dollarDbu": 24000},
            {"sku": "Serverless Jobs", "percentage": 40, "dollarDbu": 16000},
        ],
        "adhocPeriods": [],
        "description": (
            "TEST UC9 — Starts Late (M24), Short Contribution. "
            "Steady-state $40K/mo, AWS Enterprise, M24→M30 linear, "
            "DLT Advanced 60% + Serverless Jobs 40%, S1+S2+S3. "
            "Tests: Late-starting UC — Y1 and Y2 must be $0, "
            "Y3 has partial ramp (M25-M29) + 1 live month (M30-M36). "
            "Expected: Y1=$0, Y2=$0, Y3 = ramp sum M25-M29 + 7×$40K."
        ),
    },

    # UC10 — Custom SKU with Override Price
    # Real UC: Kroger - Platform Consolidation & Cost Reduction
    {
        "id": "aAvVp000001Nu49KAC",
        "name": "Kroger - Platform Consolidation & Cost Reduction (Hub‑and‑Spoke + ADF/Synapse)",
        "domain": "Platform",
        "cloud": "AWS", "tier": "premium",
        "steadyStateDbu": 12000,
        "onboardingMonth": 2, "liveMonth": 5,
        "rampType": "linear",
        "upliftOnly": False,
        "scenarios": [False, True, False],
        "skuBreakdown": [
            {"sku": "All Purpose Compute (Photon)", "percentage": 70, "dollarDbu": 8400},
            {"sku": "Jobs Compute",                  "percentage": 30, "dollarDbu": 3600,
             "priceOverride": 0.10},
        ],
        "adhocPeriods": [],
        "description": (
            "TEST UC10 — Custom SKU with Price Override. "
            "Steady-state $12K/mo, AWS Premium, M2→M5 linear, "
            "APC Photon 70% + Jobs Compute 30% at $0.10/DBU override, S2 only. "
            "Tests: Custom price override changes blended DBU rate for that SKU slot. "
            "Blended rate will differ significantly from default $0.15 Jobs Compute price."
        ),
    },

    # UC11 — Two Adhoc Periods, Overlapping Months
    # Real UC: Kroger - Streaming Ingestion & Data Quality (Kafka, DB2, DQX)
    {
        "id": "aAvVp000001O2BNKA0",
        "name": "Kroger - Streaming Ingestion & Data Quality (Kafka, DB2, DQX) - Prathap",
        "domain": "AI/ML",
        "cloud": "GCP", "tier": "standard",
        "steadyStateDbu": 18000,
        "onboardingMonth": 1, "liveMonth": 4,
        "rampType": "linear",
        "upliftOnly": False,
        "scenarios": [True, False, False],
        "skuBreakdown": [
            {"sku": "All Purpose Compute", "percentage": 100, "dollarDbu": 18000},
        ],
        "adhocPeriods": [
            {
                "label": "Sprint A",
                "months": [3, 4, 5],
                "skuAmounts": [
                    {"sku": "All Purpose Compute", "dbuPerMonth": 5000, "dollarPerMonth": 2000},
                ],
            },
            {
                "label": "Sprint B",
                "months": [4, 5, 6],
                "skuAmounts": [
                    {"sku": "All Purpose Compute", "dbuPerMonth": 7500, "dollarPerMonth": 3000},
                ],
            },
        ],
        "description": (
            "TEST UC11 — Two Adhoc Periods, Overlapping Months. "
            "Steady-state $18K/mo, GCP Standard, M1→M4 linear, APC 100%, S1 only. "
            "Sprint A: M3-M5 $2K/mo + 5,000 DBU/mo. "
            "Sprint B: M4-M6 $3K/mo + 7,500 DBU/mo. "
            "M4 & M5 both periods active → must total $5K + 12,500 DBU those months. "
            "Tests: Additive adhoc across overlapping periods in all tabs."
        ),
    },

    # UC12 — Uplift Only + Adhoc DBU
    # Real UC: Kroger - DMP + DIEM + MX - Serverless Jobs/Workflows - Phase 1
    {
        "id": "aAvVp000000jWTZKA2",
        "name": "Kroger - DMP + DIEM + MX - Serverless Jobs/Workflows - Phase 1",
        "domain": "Platform",
        "cloud": "AWS", "tier": "premium",
        "steadyStateDbu": 5000,
        "onboardingMonth": 1, "liveMonth": 2,
        "rampType": "linear",
        "upliftOnly": True,
        "scenarios": [True, True, False],
        "skuBreakdown": [
            {"sku": "Serverless SQL", "percentage": 100, "dollarDbu": 5000},
        ],
        "adhocPeriods": [
            {
                "label": "Launch Week",
                "months": [1],
                "skuAmounts": [
                    {"sku": "Serverless SQL", "dbuPerMonth": 100000, "dollarPerMonth": 10000},
                ],
            },
        ],
        "description": (
            "TEST UC12 — Uplift Only + Adhoc DBU (Most Complex Edge Case). "
            "Steady-state $5K/mo uplift, AWS Premium, M1→M2 linear, Serverless SQL 100%, S1+S2. "
            "upliftOnly=TRUE + Adhoc 'Launch Week' M1: $10K + 100,000 DBU. "
            "Tests: upliftOnly ramp DBU=0, but adhoc DBU must still appear. "
            "Most complex edge case for DBU computation accuracy."
        ),
    },
]

# ── Build and push scenarios ──────────────────────────────────────────────────

def push_scenarios():
    print("Pushing 12 test UCs to Kroger account on deployed app...")
    print(f"  Target: {BASE_URL}")
    print()

    for sid in [1, 2, 3]:
        payload = {
            "scenario_id": sid,
            "account": "kroger",
            "baseline_growth_rate": 0.0,
            "baseline_adjustment": 0.0,
            "growth_rates": {},
            "assumptions_text": f"Test scenario {sid} — 12 UC full coverage test (real Kroger Logfood UCs)",
            "new_use_cases": ALL_UCS,
            "baseline_overrides": [],
            "serverless_uplift_pct": 0.0,
            "global_growth_rate": 0.0,
            "version": 0,
        }
        result = api("POST", "/api/scenario", payload)
        active = [uc["name"].split(" - ")[1] if " - " in uc["name"] else uc["name"]
                  for uc in ALL_UCS if uc["scenarios"][sid-1]]
        print(f"  S{sid}: {result} — {len(active)} active UCs")

    print()
    print("Verifying via summary-all API...")
    summary = api("GET", "/api/summary-all?account=kroger&contract_months=36")
    for sc in summary["scenarios"]:
        sid = sc["scenario"]
        uc_header = next((r for r in sc["summary_rows"] if r.get("use_case_area") == "New Use Cases"), None)
        if uc_header:
            print(f"  S{sid}: Y1=${uc_header.get('year1',0):>10,}  Y2=${uc_header.get('year2',0):>10,}  Y3=${uc_header.get('year3',0):>10,}")
        uc_rows = [r for r in sc["summary_rows"] if r.get("is_use_case")]
        for r in uc_rows:
            name = r["use_case_area"][3:]
            print(f"       {name[:55]:<55} Y1=${r.get('year1',0):>8,}")

    print()
    print("Done. Load 'Kroger' account in the app to see all 12 test UCs.")


if __name__ == "__main__":
    push_scenarios()
