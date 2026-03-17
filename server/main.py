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
from logfood import query_consumption

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
# Summary
# ---------------------------------------------------------------------------

@app.get("/api/summary")
async def get_summary(account: str = Query(default="Walmart"), scenario: int = Query(default=1)):
    """Return demand plan summary for the given account and scenario."""
    # Get consumption data
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
    for row in consumption:
        ws = row.get("workspace_name", "")
        domain = ws_to_domain.get(ws, "Unmapped")
        dbu = row.get("dollar_dbu_list", 0) or 0
        domain_totals[domain] += float(dbu)

    total_t12m = sum(domain_totals.values())

    # Get scenario assumptions if any
    key = f"{account}_{scenario}"
    scenario_data = _scenarios.get(key)

    # Default growth rates per scenario
    default_growth = {1: 0.10, 2: 0.20, 3: 0.30}
    growth = default_growth.get(scenario, 0.10)
    serverless_uplift = 0.0
    new_use_case_total = [0.0, 0.0, 0.0]

    if scenario_data:
        growth = sum(scenario_data.growth_rates.values()) / max(len(scenario_data.growth_rates), 1)
        serverless_uplift = scenario_data.serverless_uplift_pct
        for uc in scenario_data.new_use_cases:
            new_use_case_total[0] += uc.get("year1_dbu", 0)
            new_use_case_total[1] += uc.get("year2_dbu", 0)
            new_use_case_total[2] += uc.get("year3_dbu", 0)

    # Build summary rows
    existing_y1 = total_t12m * (1 + growth)
    existing_y2 = existing_y1 * (1 + growth)
    existing_y3 = existing_y2 * (1 + growth)

    serverless_y1 = existing_y1 * serverless_uplift
    serverless_y2 = existing_y2 * serverless_uplift
    serverless_y3 = existing_y3 * serverless_uplift

    summary_rows = [
        {
            "use_case_area": "Existing Live Use Cases",
            "year1": round(existing_y1, 2),
            "year2": round(existing_y2, 2),
            "year3": round(existing_y3, 2),
            "total": round(existing_y1 + existing_y2 + existing_y3, 2),
        },
        {
            "use_case_area": "Serverless Optimization Uplift",
            "year1": round(serverless_y1, 2),
            "year2": round(serverless_y2, 2),
            "year3": round(serverless_y3, 2),
            "total": round(serverless_y1 + serverless_y2 + serverless_y3, 2),
        },
        {
            "use_case_area": "New Use Cases",
            "year1": round(new_use_case_total[0], 2),
            "year2": round(new_use_case_total[1], 2),
            "year3": round(new_use_case_total[2], 2),
            "total": round(sum(new_use_case_total), 2),
        },
    ]

    grand_total = {
        "use_case_area": "Grand Total",
        "year1": round(sum(r["year1"] for r in summary_rows), 2),
        "year2": round(sum(r["year2"] for r in summary_rows), 2),
        "year3": round(sum(r["year3"] for r in summary_rows), 2),
        "total": round(sum(r["total"] for r in summary_rows), 2),
    }
    summary_rows.append(grand_total)

    # Domain breakdown for pie chart
    domain_breakdown = [
        {"domain": d, "value": round(v, 2)}
        for d, v in sorted(domain_totals.items(), key=lambda x: -x[1])
    ]

    # Yearly trend for chart
    yearly_trend = [
        {"year": "Year 1", "value": grand_total["year1"]},
        {"year": "Year 2", "value": grand_total["year2"]},
        {"year": "Year 3", "value": grand_total["year3"]},
    ]

    return {
        "account": account,
        "scenario": scenario,
        "total_t12m": round(total_t12m, 2),
        "growth_rate": growth,
        "summary_rows": summary_rows,
        "domain_breakdown": domain_breakdown,
        "yearly_trend": yearly_trend,
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
