"""Demand Plan App — FastAPI backend."""

import csv
import io
import json
import os
import traceback
from collections import defaultdict
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from models import ScenarioAssumptions, ForecastUpdate
from sheets import fetch_domain_mapping
from logfood import query_consumption, query_sku_prices
from sku_mapping import get_friendly_name

app = FastAPI(title="Demand Plan App")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory stores (persisted to JSON files in data/)
DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)

# Caches
_domain_mapping_cache: dict[str, list[dict]] = {}
_consumption_cache: dict[str, list[dict]] = {}
_scenarios: dict[str, ScenarioAssumptions] = {}
_forecast_overrides: dict[str, list[dict]] = {}
_sku_price_cache: dict[str, list[dict]] = {}


def _load_json(name: str) -> dict | list | None:
    p = DATA_DIR / f"{name}.json"
    if p.exists():
        return json.loads(p.read_text())
    return None


def _save_json(name: str, data):
    (DATA_DIR / f"{name}.json").write_text(json.dumps(data, default=str, indent=2))


# ---------------------------------------------------------------------------
# Domain Mapping
# ---------------------------------------------------------------------------

@app.get("/api/domain-mapping")
async def get_domain_mapping(sheet_url: str = Query(...)):
    """Read domain mapping from Google Sheets."""
    if sheet_url in _domain_mapping_cache:
        return {"mapping": _domain_mapping_cache[sheet_url]}

    try:
        mapping = await fetch_domain_mapping(sheet_url)
        _domain_mapping_cache[sheet_url] = mapping
        _save_json("domain_mapping", mapping)
        return {"mapping": mapping}
    except Exception as e:
        # Try loading from cache file
        cached = _load_json("domain_mapping")
        if cached:
            return {"mapping": cached, "warning": f"Using cached data. Error: {str(e)}"}
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Consumption Data
# ---------------------------------------------------------------------------

@app.get("/api/consumption")
async def get_consumption(account: str = Query(default="Walmart")):
    """Query Logfood for trailing 12 months consumption."""
    if account in _consumption_cache:
        return {"data": _consumption_cache[account]}

    try:
        rows = query_consumption(account)
        _consumption_cache[account] = rows
        _save_json(f"consumption_{account}", rows)
        return {"data": rows}
    except Exception as e:
        # Try loading from cache file
        cached = _load_json(f"consumption_{account}")
        if cached:
            return {"data": cached, "warning": f"Using cached data. Error: {str(e)}"}
        raise HTTPException(
            status_code=500,
            detail=f"Logfood query failed: {str(e)}. Use CSV upload as fallback.",
        )


@app.post("/api/consumption/upload")
async def upload_consumption(account: str = Query(default="Walmart"), file: UploadFile = File(...)):
    """Upload CSV as fallback for consumption data."""
    content = await file.read()
    text = content.decode("utf-8")
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for row in reader:
        parsed = {}
        for k, v in row.items():
            k = k.strip().lower().replace(" ", "_")
            try:
                parsed[k] = float(v)
            except (ValueError, TypeError):
                parsed[k] = v
        rows.append(parsed)

    _consumption_cache[account] = rows
    _save_json(f"consumption_{account}", rows)
    return {"data": rows, "count": len(rows)}


# ---------------------------------------------------------------------------
# SKU Prices
# ---------------------------------------------------------------------------

@app.get("/api/sku-prices")
async def get_sku_prices(account: str = Query(default="Walmart")):
    """Get distinct SKU + cloud + list_price from Logfood."""
    if account in _sku_price_cache:
        raw_rows = _sku_price_cache[account]
    else:
        try:
            raw_rows = query_sku_prices(account)
            _sku_price_cache[account] = raw_rows
            _save_json(f"sku_prices_{account}", raw_rows)
        except Exception as e:
            cached = _load_json(f"sku_prices_{account}")
            if cached:
                raw_rows = cached
                _sku_price_cache[account] = raw_rows
            else:
                raise HTTPException(
                    status_code=500,
                    detail=f"SKU price query failed: {str(e)}",
                )

    # Build sku_prices list with friendly names
    sku_prices = []
    clouds_set = set()
    for row in raw_rows:
        raw_sku = row.get("sku", "")
        cloud = row.get("cloud", "")
        list_price = row.get("list_price", 0)
        friendly = get_friendly_name(raw_sku)
        sku_prices.append({
            "raw_sku": raw_sku,
            "friendly_name": friendly,
            "cloud": cloud,
            "list_price": list_price,
        })
        clouds_set.add(cloud)

    # Group by friendly_name -> cloud -> price
    friendly_map: dict[str, dict[str, float]] = {}
    for sp in sku_prices:
        fn = sp["friendly_name"]
        if fn not in friendly_map:
            friendly_map[fn] = {}
        # Keep the max price if multiple raw SKUs map to same friendly name + cloud
        existing = friendly_map[fn].get(sp["cloud"], 0)
        friendly_map[fn][sp["cloud"]] = max(existing, sp["list_price"])

    friendly_skus = [
        {"friendly_name": fn, "clouds": clouds}
        for fn, clouds in sorted(friendly_map.items())
    ]

    return {
        "sku_prices": sku_prices,
        "clouds": sorted(clouds_set),
        "friendly_skus": friendly_skus,
    }


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

def _calc_use_case_monthly(uc: dict) -> list[float]:
    """Calculate 36-month projection for a use case with ramp."""
    months = [0.0] * 36
    ss = uc.get("steadyStateDbu") or uc.get("steady_state_dbu") or 0
    om = uc.get("onboardingMonth") or uc.get("onboarding_month") or 1
    lm = uc.get("liveMonth") or uc.get("live_month") or 6
    ramp = uc.get("rampType") or uc.get("ramp_type") or "linear"
    if ss <= 0 or lm <= om:
        return months
    ramp_months = lm - om
    for i in range(36):
        m = i + 1
        if m < om:
            months[i] = 0
        elif m >= lm:
            months[i] = ss
        else:
            progress = (m - om + 1) / (ramp_months + 1)
            months[i] = ss * progress if ramp == "linear" else ss * (progress ** 2.5)
    return months


@app.get("/api/summary")
async def get_summary(account: str = Query(default="Walmart"), scenario: int = Query(default=1)):
    """Return demand plan summary — pulls projections from saved scenario config."""
    # Get consumption data for baseline
    consumption = _consumption_cache.get(account) or _load_json(f"consumption_{account}") or []

    # Get domain mapping
    mapping_list = None
    for v in _domain_mapping_cache.values():
        mapping_list = v
        break
    if not mapping_list:
        mapping_list = _load_json("domain_mapping") or []

    ws_to_domain = {m["workspace"]: m["domain"] for m in mapping_list}

    # Aggregate T12M by domain
    domain_totals: dict[str, float] = defaultdict(float)
    monthly_totals: dict[str, float] = defaultdict(float)
    for row in consumption:
        ws = row.get("workspace_name", "")
        domain = ws_to_domain.get(ws, "Unmapped")
        dbu = row.get("dollar_dbu_list", 0) or 0
        domain_totals[domain] += float(dbu)
        month = row.get("month", "")
        monthly_totals[month] += float(dbu)

    total_t12m = sum(domain_totals.values())
    months_count = max(len(monthly_totals), 1)
    avg_monthly = total_t12m / months_count

    # Get saved scenario config
    key = f"{account}_{scenario}"
    scenario_data = None
    if key in _scenarios:
        scenario_data = _scenarios[key].model_dump()
    else:
        scenario_data = _load_json(f"scenario_{key}")

    # Baseline growth rate
    baseline_growth = 0.02  # default 2% MoM
    if scenario_data:
        baseline_growth = scenario_data.get("baseline_growth_rate", 0.02)

    # Calculate baseline projection (compound monthly growth)
    mom_rate = baseline_growth / 12
    baseline_year_totals = [0.0, 0.0, 0.0]
    for i in range(36):
        monthly = avg_monthly * ((1 + mom_rate) ** (i + 1))
        baseline_year_totals[i // 12] += monthly

    # Calculate use case projections (only for this scenario)
    use_cases = (scenario_data or {}).get("new_use_cases", [])
    active_ucs = [uc for uc in use_cases if uc.get("scenarios", [False, False, False])[scenario - 1]]

    uc_rows = []
    uc_year_totals = [0.0, 0.0, 0.0]
    for uc in active_ucs:
        uc_monthly = _calc_use_case_monthly(uc)
        yt = [0.0, 0.0, 0.0]
        for i, v in enumerate(uc_monthly):
            yt[i // 12] += v
            uc_year_totals[i // 12] += v
        uc_rows.append({
            "use_case_area": f"  ↳ {uc.get('name', 'Unnamed')}",
            "year1": round(yt[0]),
            "year2": round(yt[1]),
            "year3": round(yt[2]),
            "total": round(sum(yt)),
            "is_use_case": True,
        })

    # Build summary rows
    summary_rows = [
        {
            "use_case_area": f"Existing Baseline ({baseline_growth*100:.1f}% MoM growth)",
            "year1": round(baseline_year_totals[0]),
            "year2": round(baseline_year_totals[1]),
            "year3": round(baseline_year_totals[2]),
            "total": round(sum(baseline_year_totals)),
        },
    ]

    # Add each use case as a sub-row
    if uc_rows:
        summary_rows.append({
            "use_case_area": "New Use Cases",
            "year1": round(uc_year_totals[0]),
            "year2": round(uc_year_totals[1]),
            "year3": round(uc_year_totals[2]),
            "total": round(sum(uc_year_totals)),
        })
        summary_rows.extend(uc_rows)

    # Grand total
    grand_y1 = baseline_year_totals[0] + uc_year_totals[0]
    grand_y2 = baseline_year_totals[1] + uc_year_totals[1]
    grand_y3 = baseline_year_totals[2] + uc_year_totals[2]
    summary_rows.append({
        "use_case_area": "Grand Total",
        "year1": round(grand_y1),
        "year2": round(grand_y2),
        "year3": round(grand_y3),
        "total": round(grand_y1 + grand_y2 + grand_y3),
    })

    # Domain breakdown for pie chart
    domain_breakdown = [
        {"domain": d, "value": round(v)}
        for d, v in sorted(domain_totals.items(), key=lambda x: -x[1])
    ]

    # Yearly trend — show baseline + use cases stacked
    yearly_trend = [
        {"year": "Year 1", "value": round(grand_y1), "baseline": round(baseline_year_totals[0]), "new_uc": round(uc_year_totals[0])},
        {"year": "Year 2", "value": round(grand_y2), "baseline": round(baseline_year_totals[1]), "new_uc": round(uc_year_totals[1])},
        {"year": "Year 3", "value": round(grand_y3), "baseline": round(baseline_year_totals[2]), "new_uc": round(uc_year_totals[2])},
    ]

    return {
        "account": account,
        "scenario": scenario,
        "total_t12m": round(total_t12m),
        "growth_rate": baseline_growth,
        "avg_monthly": round(avg_monthly),
        "summary_rows": summary_rows,
        "domain_breakdown": domain_breakdown,
        "yearly_trend": yearly_trend,
        "active_use_cases": len(active_ucs),
    }


# ---------------------------------------------------------------------------
# Scenario
# ---------------------------------------------------------------------------

@app.post("/api/scenario")
async def save_scenario(data: ScenarioAssumptions):
    """Save scenario assumptions."""
    key = f"{data.account}_{data.scenario_id}"
    _scenarios[key] = data
    _save_json(f"scenario_{key}", data.model_dump())
    return {"status": "ok", "key": key}


@app.get("/api/scenario")
async def get_scenario(account: str = Query(default="Walmart"), scenario: int = Query(default=1)):
    """Get scenario assumptions."""
    key = f"{account}_{scenario}"
    if key in _scenarios:
        return _scenarios[key].model_dump()

    cached = _load_json(f"scenario_{key}")
    if cached:
        return cached

    # Return defaults
    return {
        "scenario_id": scenario,
        "account": account,
        "growth_rates": {},
        "assumptions_text": "",
        "new_use_cases": [],
        "serverless_uplift_pct": 0.0,
    }


# ---------------------------------------------------------------------------
# Forecast
# ---------------------------------------------------------------------------

@app.post("/api/forecast")
async def save_forecast(data: ForecastUpdate):
    """Save/update forecast overrides."""
    _forecast_overrides[data.account] = [o.model_dump() for o in data.overrides]
    _save_json(f"forecast_{data.account}", _forecast_overrides[data.account])
    return {"status": "ok", "count": len(data.overrides)}


@app.get("/api/forecast")
async def get_forecast(account: str = Query(default="Walmart")):
    """Get workspace-level forecast data."""
    consumption = _consumption_cache.get(account) or _load_json(f"consumption_{account}") or []

    mapping_list = None
    for v in _domain_mapping_cache.values():
        mapping_list = v
        break
    if not mapping_list:
        mapping_list = _load_json("domain_mapping") or []

    ws_to_domain = {m["workspace"]: m["domain"] for m in mapping_list}

    # Aggregate by workspace
    ws_data: dict[str, dict] = {}
    for row in consumption:
        ws = row.get("workspace_name", "")
        if ws not in ws_data:
            ws_data[ws] = {
                "workspace": ws,
                "domain": ws_to_domain.get(ws, "Unmapped"),
                "cloud": "AWS",  # Default; can be overridden
                "monthly_dbu": 0.0,
                "total_dbu": 0.0,
            }
        ws_data[ws]["total_dbu"] += float(row.get("dollar_dbu_list", 0) or 0)

    # Calculate monthly average
    for ws in ws_data.values():
        ws["monthly_dbu"] = round(ws["total_dbu"] / 12, 2)
        ws["total_dbu"] = round(ws["total_dbu"], 2)

    # Apply overrides
    overrides = _forecast_overrides.get(account) or _load_json(f"forecast_{account}") or []
    override_map = {o["workspace"]: o for o in overrides}
    for ws in ws_data.values():
        if ws["workspace"] in override_map:
            ov = override_map[ws["workspace"]]
            ws["monthly_dbu"] = ov.get("monthly_dbu", ws["monthly_dbu"])
            ws["domain"] = ov.get("domain", ws["domain"])
            ws["cloud"] = ov.get("cloud", ws["cloud"])

    result = sorted(ws_data.values(), key=lambda x: -x["monthly_dbu"])
    return {"data": result}


# ---------------------------------------------------------------------------
# Account Overview
# ---------------------------------------------------------------------------

@app.get("/api/account-overview")
async def get_account_overview(account: str = Query(default="Walmart")):
    """High-level account metrics."""
    consumption = _consumption_cache.get(account) or _load_json(f"consumption_{account}") or []

    mapping_list = None
    for v in _domain_mapping_cache.values():
        mapping_list = v
        break
    if not mapping_list:
        mapping_list = _load_json("domain_mapping") or []

    ws_to_domain = {m["workspace"]: m["domain"] for m in mapping_list}

    # Aggregate by month and domain
    monthly_totals: dict[str, float] = defaultdict(float)
    domain_totals: dict[str, float] = defaultdict(float)

    for row in consumption:
        month = row.get("month", "")
        ws = row.get("workspace_name", "")
        domain = ws_to_domain.get(ws, "Unmapped")
        dbu = float(row.get("dollar_dbu_list", 0) or 0)
        monthly_totals[month] += dbu
        domain_totals[domain] += dbu

    sorted_months = sorted(monthly_totals.keys())
    total_t12m = sum(monthly_totals.values())

    # T3M = last 3 months
    t3m_months = sorted_months[-3:] if len(sorted_months) >= 3 else sorted_months
    total_t3m = sum(monthly_totals.get(m, 0) for m in t3m_months)

    # Growth rate (compare last 3 months to prior 3 months)
    if len(sorted_months) >= 6:
        prior_3m = sorted_months[-6:-3]
        prior_total = sum(monthly_totals.get(m, 0) for m in prior_3m)
        growth_rate = ((total_t3m - prior_total) / prior_total * 100) if prior_total else 0
    else:
        growth_rate = 0

    # Monthly trend
    monthly_trend = [
        {"month": m, "value": round(monthly_totals[m], 2)}
        for m in sorted_months
    ]

    # Top domains
    top_domains = [
        {"domain": d, "value": round(v, 2)}
        for d, v in sorted(domain_totals.items(), key=lambda x: -x[1])[:15]
    ]

    # Domain breakdown table
    domain_table = [
        {"domain": d, "total_dbu": round(v, 2), "pct": round(v / total_t12m * 100, 1) if total_t12m else 0}
        for d, v in sorted(domain_totals.items(), key=lambda x: -x[1])
    ]

    return {
        "account": account,
        "total_t12m": round(total_t12m, 2),
        "total_t3m": round(total_t3m, 2),
        "growth_rate": round(growth_rate, 1),
        "workspace_count": len(set(r.get("workspace_name", "") for r in consumption)),
        "domain_count": len(domain_totals),
        "monthly_trend": monthly_trend,
        "top_domains": top_domains,
        "domain_table": domain_table,
    }


# ---------------------------------------------------------------------------
# Serve frontend static files (after build)
# ---------------------------------------------------------------------------

FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"
if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
