#!/usr/bin/env python3
"""
Comprehensive backend test: all test use cases + verify all sums add up.

Tests the computation logic extracted directly from main.py so no HTTP/auth needed.
Run: python3 test_use_cases.py
"""

import json
import math
from pathlib import Path


# ---------------------------------------------------------------------------
# Computation logic (copied verbatim from main.py _calc_use_case_monthly)
# ---------------------------------------------------------------------------

def _calc_use_case_monthly(uc: dict, total_months: int = 36) -> list:
    """Calculate monthly projection for a use case with ramp + adhoc periods."""
    result = [0.0] * total_months
    ss = uc.get("steadyStateDbu") or uc.get("steady_state_dbu") or 0
    om = uc.get("onboardingMonth") or uc.get("onboarding_month") or 1
    lm = uc.get("liveMonth") or uc.get("live_month") or 6
    ramp = uc.get("rampType") or uc.get("ramp_type") or "linear"
    if ss <= 0 or lm <= om:
        return result
    ramp_months = lm - om
    for i in range(total_months):
        m = i + 1
        if m < om:
            result[i] = 0
        elif m >= lm:
            result[i] = ss
        else:
            progress = (m - om + 1) / (ramp_months + 1)
            result[i] = ss * progress if ramp == "linear" else ss * (progress ** 2.5)
    return result


def calc_uc_totals(uc: dict, contract_months: int = 36) -> dict:
    """Return per-year totals (ramp + adhoc) for a use case."""
    num_years = contract_months // 12
    monthly = _calc_use_case_monthly(uc, contract_months)
    year_totals = [0.0] * num_years

    for i, v in enumerate(monthly):
        yr = i // 12
        if yr < num_years:
            year_totals[yr] += v

    # Add adhoc dollar amounts
    for period in (uc.get("adhocPeriods") or []):
        sku_amounts = period.get("skuAmounts") or []
        period_dollar = sum(sa.get("dollarPerMonth", 0) for sa in sku_amounts)
        for m in (period.get("months") or []):
            if isinstance(m, int) and 1 <= m <= contract_months:
                yr = (m - 1) // 12
                if yr < num_years:
                    year_totals[yr] += period_dollar

    return {
        "name": uc.get("name", "Unnamed"),
        "scenarios": uc.get("scenarios", [False, False, False]),
        "year_totals": [round(y) for y in year_totals],
        "ramp_total": sum(round(v) for v in monthly),
        "adhoc_total": sum(year_totals) - sum(monthly),
    }


def calc_scenario_totals(use_cases: list, scenario: int, contract_months: int = 36) -> list:
    """Return per-year UC totals for a given scenario (1-indexed)."""
    num_years = contract_months // 12
    scenario_year_totals = [0.0] * num_years
    active = [uc for uc in use_cases if uc.get("scenarios", [False, False, False])[scenario - 1]]
    for uc in active:
        yt = calc_uc_totals(uc, contract_months)["year_totals"]
        for y in range(num_years):
            scenario_year_totals[y] += yt[y]
    return [round(t) for t in scenario_year_totals]


# ---------------------------------------------------------------------------
# Test use case definitions
# ---------------------------------------------------------------------------

USE_CASES = [
    # UC1: Simple ETL Linear Single SKU — AWS Premium, $10K/mo, M1→M4 linear, S1 only
    {
        "id": "uc1",
        "name": "UC1 - Simple ETL Linear Single SKU",
        "cloud": "AWS", "tier": "premium",
        "steadyStateDbu": 10000,
        "onboardingMonth": 1, "liveMonth": 4,
        "rampType": "linear",
        "upliftOnly": False,
        "scenarios": [True, False, False],
        "skuBreakdown": [
            {"sku": "Jobs Compute",       "percentage": 50, "dollarDbu": 5000},
            {"sku": "Jobs Compute (Photon)", "percentage": 30, "dollarDbu": 3000},
            {"sku": "DLT Core",           "percentage": 20, "dollarDbu": 2000},
        ],
        "adhocPeriods": [],
        # M1=2500 M2=5000 M3=7500 M4-M12=10000×9 → Y1=105K Y2=120K Y3=120K
        "expected": {"Y1": 105000, "Y2": 120000, "Y3": 120000},
    },

    # UC2: BI Analytics Hockey Stick Azure — Azure Premium, $15K/mo, M1→M7 hockey_stick, S1+S2
    {
        "id": "uc2",
        "name": "UC2 - BI Analytics Hockey Stick Azure",
        "cloud": "Azure", "tier": "premium",
        "steadyStateDbu": 15000,
        "onboardingMonth": 1, "liveMonth": 7,
        "rampType": "hockey_stick",
        "upliftOnly": False,
        "scenarios": [True, True, False],
        "skuBreakdown": [
            {"sku": "SQL Warehouse",  "percentage": 60, "dollarDbu": 9000},
            {"sku": "Jobs Compute",   "percentage": 40, "dollarDbu": 6000},
        ],
        "adhocPeriods": [],
        # Y1 ~= sum(15000*(k/7)^2.5 for k=1..6) + 15000*6 ≈ 112948 Y2=180K Y3=180K
        "expected": {"Y1": 112948, "Y2": 180000, "Y3": 180000},
    },

    # UC3: ML Platform Linear AWS Enterprise — $25K/mo, M3→M9 linear, S2+S3
    {
        "id": "uc3",
        "name": "UC3 - ML Platform Linear AWS Enterprise",
        "cloud": "AWS", "tier": "enterprise",
        "steadyStateDbu": 25000,
        "onboardingMonth": 3, "liveMonth": 9,
        "rampType": "linear",
        "upliftOnly": False,
        "scenarios": [False, True, True],
        "skuBreakdown": [
            {"sku": "Model Serving",  "percentage": 60, "dollarDbu": 15000},
            {"sku": "Jobs Compute",   "percentage": 40, "dollarDbu": 10000},
        ],
        "adhocPeriods": [],
        # M1-M2=0, M3=25000*(1/7), ..., M8=25000*(6/7), M9+=25000
        # Y1 = 0+0+3571.4+7142.9+10714.3+14285.7+17857.1+21428.6+25000*4 = 175000
        "expected": {"Y1": 175000, "Y2": 300000, "Y3": 300000},
    },

    # UC4: Agentic AI Hockey Stick AWS Enterprise — $30K/mo, M6→M12 hockey_stick, S2+S3
    {
        "id": "uc4",
        "name": "UC4 - Agentic AI Hockey Stick AWS Enterprise",
        "cloud": "AWS", "tier": "enterprise",
        "steadyStateDbu": 30000,
        "onboardingMonth": 6, "liveMonth": 12,
        "rampType": "hockey_stick",
        "upliftOnly": False,
        "scenarios": [False, True, True],
        "skuBreakdown": [
            {"sku": "All Purpose Compute",   "percentage": 70, "dollarDbu": 21000},
            {"sku": "Serverless Jobs",       "percentage": 30, "dollarDbu": 9000},
        ],
        "adhocPeriods": [],
        # M1-M5=0, M6..M11 hockey, M12+=30000
        # Y1: sum of ramp M6-M11 + 30000
        "expected": {"Y1": 75895, "Y2": 360000, "Y3": 360000},
    },

    # UC5: Uplift Only Serverless Migration — AWS, $8K/mo, M1→M3 linear, upliftOnly=True, S2 only
    {
        "id": "uc5",
        "name": "UC5 - Uplift Only Serverless Migration",
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
        # M1=8000*(1/3)=2666.7, M2=5333.3, M3+=8000
        # Y1=2666.7+5333.3+8000*10=88000 Y2=96000 Y3=96000
        "expected": {"Y1": 88000, "Y2": 96000, "Y3": 96000},
    },

    # UC6: GCP Enterprise Custom SKU — $50K/mo, M4→M10 hockey_stick, S3 only
    {
        "id": "uc6",
        "name": "UC6 - GCP Enterprise Custom SKU",
        "cloud": "GCP", "tier": "enterprise",
        "steadyStateDbu": 50000,
        "onboardingMonth": 4, "liveMonth": 10,
        "rampType": "hockey_stick",
        "upliftOnly": False,
        "scenarios": [False, False, True],
        "skuBreakdown": [
            {"sku": "Serverless SQL",     "percentage": 50, "dollarDbu": 25000},
            {"sku": "Jobs Compute",       "percentage": 30, "dollarDbu": 15000},
            {"sku": "All Purpose Compute","percentage": 20, "dollarDbu": 10000},
        ],
        "adhocPeriods": [],
        # M1-M3=0, M4..M9 hockey (ramp_months=6), M10+=50000
        "expected": {"Y1": 226492, "Y2": 600000, "Y3": 600000},
    },

    # UC7: Ramp + Adhoc Dev Burst — AWS Premium, $20K/mo, M2→M6 linear, S1+S2, 2 adhoc periods
    # Adhoc P1: months [8,9],   skuAmounts Jobs=$1500/mo + APC=$500/mo  → $2K/mo × 2 = $4K Y1
    # Adhoc P2: months [16,17,18], skuAmounts Jobs=$2100/mo + APC=$900/mo → $3K/mo × 3 = $9K Y2
    {
        "id": "uc7",
        "name": "UC7 - Ramp + Adhoc Dev Burst",
        "cloud": "AWS", "tier": "premium",
        "steadyStateDbu": 20000,
        "onboardingMonth": 2, "liveMonth": 6,
        "rampType": "linear",
        "upliftOnly": False,
        "scenarios": [True, True, False],
        "skuBreakdown": [
            {"sku": "Jobs Compute",        "percentage": 70, "dollarDbu": 14000},
            {"sku": "All Purpose Compute", "percentage": 30, "dollarDbu": 6000},
        ],
        "adhocPeriods": [
            {
                "months": [8, 9],
                "skuAmounts": [
                    {"sku": "Jobs Compute",        "dbuPerMonth": 7000, "dollarPerMonth": 1500},
                    {"sku": "All Purpose Compute", "dbuPerMonth": 3000, "dollarPerMonth": 500},
                ],
            },
            {
                "months": [16, 17, 18],
                "skuAmounts": [
                    {"sku": "Jobs Compute",        "dbuPerMonth": 10500, "dollarPerMonth": 2100},
                    {"sku": "All Purpose Compute", "dbuPerMonth": 4500,  "dollarPerMonth": 900},
                ],
            },
        ],
        # Ramp: M1=0, M2=4000, M3=8000, M4=12000, M5=16000, M6+=20000
        # Y1 ramp = 0+4000+8000+12000+16000+20000*7 = 180000 + adhoc $4K = 184000
        # Y2 ramp = 240000 + adhoc $9K = 249000
        # Y3 = 240000
        "expected": {"Y1": 184000, "Y2": 249000, "Y3": 240000},
    },
]

# ---------------------------------------------------------------------------
# Scenario membership summary
# ---------------------------------------------------------------------------

SCENARIO_NAMES = {1: "S1 (Existing + Mid-term)", 2: "S2 (S1 + Mid-term)", 3: "S3 (S2 + Long-term)"}

# ---------------------------------------------------------------------------
# Run tests
# ---------------------------------------------------------------------------

PASS = "PASS"
FAIL = "FAIL"
TOLERANCE = 5  # rounding tolerance in dollars

def run_tests():
    print("=" * 70)
    print("Demand Plan App — Backend Use Case Computation Tests")
    print("=" * 70)

    all_pass = True
    uc_results = []

    # 1. Per-UC year total verification
    print("\n--- Individual Use Case Year Totals ---")
    for uc in USE_CASES:
        yt = calc_uc_totals(uc)
        expected = uc["expected"]
        results = {}
        for i, yr_key in enumerate(["Y1", "Y2", "Y3"]):
            actual = yt["year_totals"][i]
            exp = expected[yr_key]
            ok = abs(actual - exp) <= TOLERANCE
            results[yr_key] = {"actual": actual, "expected": exp, "ok": ok}
            if not ok:
                all_pass = False

        uc_pass = all(r["ok"] for r in results.values())
        status = PASS if uc_pass else FAIL
        print(f"\n  [{status}] {uc['name']}")
        print(f"         Scenarios: S1={uc['scenarios'][0]} S2={uc['scenarios'][1]} S3={uc['scenarios'][2]}")
        for yr_key, r in results.items():
            marker = "✓" if r["ok"] else "✗"
            print(f"         {yr_key}: actual=${r['actual']:>10,}  expected=${r['expected']:>10,}  {marker}")

        uc_results.append((uc, yt))

    # 2. Per-scenario totals
    print("\n--- Per-Scenario Use Case Totals ---")
    # Expected scenario totals (no baseline — UC-only)
    EXPECTED_SCENARIO = {
        1: {"Y1": 105000 + 112948 + 184000,    "Y2": 120000 + 180000 + 249000,    "Y3": 120000 + 180000 + 240000},
        2: {"Y1": 112948 + 175000 + 75895 + 88000 + 184000,
            "Y2": 180000 + 300000 + 360000 + 96000 + 249000,
            "Y3": 180000 + 300000 + 360000 + 96000 + 240000},
        3: {"Y1": 175000 + 75895 + 226492,     "Y2": 300000 + 360000 + 600000,    "Y3": 300000 + 360000 + 600000},
    }

    for s in [1, 2, 3]:
        actual_yt = calc_scenario_totals(USE_CASES, s)
        exp = EXPECTED_SCENARIO[s]
        pass_all = True
        details = []
        for i, yr_key in enumerate(["Y1", "Y2", "Y3"]):
            ok = abs(actual_yt[i] - exp[yr_key]) <= TOLERANCE
            if not ok:
                all_pass = False
                pass_all = False
            details.append(f"{yr_key}: ${actual_yt[i]:>10,} (exp ${exp[yr_key]:>10,}) {'✓' if ok else '✗'}")

        status = PASS if pass_all else FAIL
        ucs_in_s = [uc["name"].split(" - ")[0] for uc in USE_CASES if uc["scenarios"][s-1]]
        print(f"\n  [{status}] {SCENARIO_NAMES[s]}")
        print(f"         UCs in scenario: {', '.join(ucs_in_s)}")
        for d in details:
            print(f"         {d}")

    # 3. Adhoc period isolation check
    print("\n--- Adhoc Period Isolation (UC7) ---")
    uc7 = next(uc for uc in USE_CASES if uc["id"] == "uc7")
    monthly = _calc_use_case_monthly(uc7, 36)
    ramp_y1 = sum(round(monthly[i]) for i in range(12))
    ramp_y2 = sum(round(monthly[i]) for i in range(12, 24))
    ramp_y3 = sum(round(monthly[i]) for i in range(24, 36))
    adhoc_y1 = sum(
        sum(sa["dollarPerMonth"] for sa in p["skuAmounts"])
        for p in uc7["adhocPeriods"]
        for m in p["months"] if 1 <= m <= 12
    )
    adhoc_y2 = sum(
        sum(sa["dollarPerMonth"] for sa in p["skuAmounts"])
        for p in uc7["adhocPeriods"]
        for m in p["months"] if 13 <= m <= 24
    )

    tests = [
        ("Ramp Y1",   ramp_y1,  180000),
        ("Adhoc Y1",  adhoc_y1, 4000),
        ("Ramp Y2",   ramp_y2,  240000),
        ("Adhoc Y2",  adhoc_y2, 9000),
        ("Ramp Y3",   ramp_y3,  240000),
        ("Ramp+Adhoc Y1", ramp_y1 + adhoc_y1, 184000),
        ("Ramp+Adhoc Y2", ramp_y2 + adhoc_y2, 249000),
    ]
    for label, actual, expected in tests:
        ok = abs(actual - expected) <= TOLERANCE
        if not ok:
            all_pass = False
        print(f"  {'✓' if ok else '✗'} {label}: ${actual:,} (expected ${expected:,})")

    # 4. upliftOnly flag check (UC5 should have ss>0 but upliftOnly=True)
    print("\n--- upliftOnly Flag Check (UC5) ---")
    uc5 = next(uc for uc in USE_CASES if uc["id"] == "uc5")
    monthly5 = _calc_use_case_monthly(uc5, 36)
    y1_5 = sum(round(v) for v in monthly5[:12])
    uplift_flag = uc5.get("upliftOnly", False)
    print(f"  {'✓' if uplift_flag else '✗'} upliftOnly=True set correctly: {uplift_flag}")
    ok5 = abs(y1_5 - 88000) <= TOLERANCE
    if not ok5:
        all_pass = False
    print(f"  {'✓' if ok5 else '✗'} UC5 Y1 ramp = ${y1_5:,} (expected $88,000)")

    # 5. Save test scenarios to JSON files for the API to use
    print("\n--- Saving Scenario JSON Files ---")
    data_dir = Path(__file__).parent / "data" / "sumit.prakash_at_databricks.com"
    data_dir.mkdir(parents=True, exist_ok=True)

    # Build scenario assignments
    s1_ucs = [uc for uc in USE_CASES if uc["scenarios"][0]]
    s2_ucs = [uc for uc in USE_CASES if uc["scenarios"][1]]
    s3_ucs = [uc for uc in USE_CASES if uc["scenarios"][2]]

    # Build shared UC list (all UCs) for scenario_1 — scenarios field controls active/inactive
    all_uc_dicts = [
        {k: v for k, v in uc.items() if k != "expected"}  # strip test-only key
        for uc in USE_CASES
    ]

    for sid, scenario_ucs in [(1, s1_ucs), (2, s2_ucs), (3, s3_ucs)]:
        scenario_json = {
            "scenario_id": sid,
            "account": "testaccount",
            "baseline_growth_rate": 0.0,      # zero baseline so UC totals = grand totals
            "baseline_adjustment": 0.0,
            "growth_rates": {},
            "assumptions_text": f"Test scenario {sid} — auto-generated by test_use_cases.py",
            "new_use_cases": all_uc_dicts,    # all UCs; scenarios[] field gates active ones
            "baseline_overrides": [],
            "serverless_uplift_pct": 0.0,
            "global_growth_rate": 0.0,
            "version": 1,
        }
        out_path = data_dir / f"scenario_testaccount_{sid}.json"
        out_path.write_text(json.dumps(scenario_json, indent=2))
        active_names = [uc["name"].split(" - ")[0] for uc in scenario_ucs]
        print(f"  Wrote {out_path.name}  (active: {', '.join(active_names)})")

    # Also write a minimal empty consumption file so the API won't complain
    consumption_path = data_dir / "consumption_testaccount.json"
    if not consumption_path.exists():
        consumption_path.write_text("[]")
        print(f"  Wrote {consumption_path.name}  (empty — no historical data)")

    # 6. Final summary
    print("\n" + "=" * 70)
    if all_pass:
        print("ALL TESTS PASSED ✓")
    else:
        print("SOME TESTS FAILED ✗  — see details above")
    print("=" * 70)

    # Print a clean summary table
    print("\nUse Case Summary Table:")
    print(f"{'UC':<45} {'S1':^4} {'S2':^4} {'S3':^4}  {'Y1':>12} {'Y2':>12} {'Y3':>12}")
    print("-" * 100)
    for uc, yt in uc_results:
        s = uc["scenarios"]
        yt_vals = yt["year_totals"]
        print(f"{uc['name']:<45} {'Y':^4} {' ':^4} {' ':^4}  {yt_vals[0]:>12,} {yt_vals[1]:>12,} {yt_vals[2]:>12,}"
              .replace("('Y' if s[0] else ' ')", "Y" if s[0] else " "))
        # Redo cleanly
    print()
    for uc, yt in uc_results:
        s = uc["scenarios"]
        yt_vals = yt["year_totals"]
        s1 = "Y" if s[0] else " "
        s2 = "Y" if s[1] else " "
        s3 = "Y" if s[2] else " "
        print(f"{uc['name']:<45} {s1:^4} {s2:^4} {s3:^4}  ${yt_vals[0]:>11,} ${yt_vals[1]:>11,} ${yt_vals[2]:>11,}")

    print("\nScenario Totals (UC-only, zero baseline):")
    print(f"{'Scenario':<30} {'Y1':>12} {'Y2':>12} {'Y3':>12}")
    print("-" * 70)
    for s in [1, 2, 3]:
        yt = calc_scenario_totals(USE_CASES, s)
        print(f"{SCENARIO_NAMES[s]:<30} ${yt[0]:>11,} ${yt[1]:>11,} ${yt[2]:>11,}")

    return all_pass


if __name__ == "__main__":
    success = run_tests()
    exit(0 if success else 1)
