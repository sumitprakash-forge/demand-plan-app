"""Demand Plan App — FastAPI backend."""

import asyncio
import csv
import io
import json
import os
import traceback
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from models import ScenarioAssumptions, ForecastUpdate
from sheets import fetch_domain_mapping  # kept for legacy; CSV upload is primary path
from logfood import query_consumption, query_sku_prices, query_contract_health, query_sfdc_use_cases
from sku_mapping import get_friendly_name
from auth import (
    create_session_token, get_current_user, get_user_data_dir,
    set_session_cookie, clear_session_cookie, validate_pat_get_username,
    DEFAULT_HOST,
)

app = FastAPI(title="Demand Plan App")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Thread pool for blocking Logfood queries
_executor = ThreadPoolExecutor(max_workers=4)

# In-memory stores (persisted to JSON files in data/)
# Use env var so deployed app can point to a persistent workspace path
# that survives redeployments (set DEMAND_PLAN_DATA_DIR in app.yaml).
_default_data_dir = Path(__file__).parent / "data"
DATA_DIR = Path(os.environ.get("DEMAND_PLAN_DATA_DIR", str(_default_data_dir)))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Seed DATA_DIR from bundled seed_data/ on every startup (always overwrite so fresh deploy wins)
import shutil as _shutil
_seed_dir = Path(__file__).parent / "seed_data"
if _seed_dir.exists():
    for _user_seed in _seed_dir.iterdir():
        _dest = DATA_DIR / _user_seed.name
        _dest.mkdir(parents=True, exist_ok=True)
        for _f in _user_seed.iterdir():
            _shutil.copy2(_f, _dest / _f.name)  # always overwrite

# Caches
_domain_mapping_cache: dict[str, list[dict]] = {}
_consumption_cache: dict[str, list[dict]] = {}
_scenarios: dict[str, ScenarioAssumptions] = {}
_forecast_overrides: dict[str, list[dict]] = {}
_sku_price_cache: dict[str, list[dict]] = {}

# Databricks list prices by tier × cloud (source: databricks.com/product/pricing, Mar 2026).
# Standard tier is EOL (AWS/GCP upgraded Oct 2025, Azure Oct 2026) — kept for legacy workspaces.
# Azure note: Premium on Azure = Enterprise on AWS/GCP (same price shown for both tiers on Azure).
# friendly_name → tier → cloud → $/DBU
_TIER_SKU_PRICES: dict[str, dict[str, dict[str, float]]] = {
    "All Purpose Compute": {
        "standard":   {"AWS": 0.40, "Azure": 0.40, "GCP": 0.40},
        "premium":    {"AWS": 0.55, "Azure": 0.55, "GCP": 0.55},
        "enterprise": {"AWS": 0.65, "Azure": 0.55, "GCP": 0.55},
    },
    "All Purpose Compute (Photon)": {
        "standard":   {"AWS": 0.40, "Azure": 0.40, "GCP": 0.40},
        "premium":    {"AWS": 0.55, "Azure": 0.55, "GCP": 0.55},
        "enterprise": {"AWS": 0.65, "Azure": 0.55, "GCP": 0.55},
    },
    "Jobs Compute": {
        "standard":   {"AWS": 0.10, "Azure": 0.15, "GCP": 0.10},
        "premium":    {"AWS": 0.15, "Azure": 0.30, "GCP": 0.15},
        "enterprise": {"AWS": 0.20, "Azure": 0.30, "GCP": 0.15},
    },
    "Jobs Compute (Photon)": {
        "standard":   {"AWS": 0.10, "Azure": 0.15, "GCP": 0.10},
        "premium":    {"AWS": 0.15, "Azure": 0.30, "GCP": 0.15},
        "enterprise": {"AWS": 0.20, "Azure": 0.30, "GCP": 0.15},
    },
    "Serverless Jobs": {
        "standard":   {"AWS": 0.35, "Azure": 0.45, "GCP": 0.35},
        "premium":    {"AWS": 0.35, "Azure": 0.45, "GCP": 0.35},
        "enterprise": {"AWS": 0.45, "Azure": 0.45, "GCP": 0.35},
    },
    "SQL Warehouse": {
        "standard":   {"AWS": 0.22, "Azure": 0.22, "GCP": 0.22},
        "premium":    {"AWS": 0.22, "Azure": 0.22, "GCP": 0.22},
        "enterprise": {"AWS": 0.22, "Azure": 0.22, "GCP": 0.22},
    },
    "Serverless SQL": {
        "standard":   {"AWS": 0.70, "Azure": 0.70, "GCP": 0.70},
        "premium":    {"AWS": 0.70, "Azure": 0.70, "GCP": 0.70},
        "enterprise": {"AWS": 0.70, "Azure": 0.70, "GCP": 0.70},
    },
    "DLT Core": {
        "standard":   {"AWS": 0.20, "Azure": 0.20, "GCP": 0.20},
        "premium":    {"AWS": 0.20, "Azure": 0.30, "GCP": 0.20},
        "enterprise": {"AWS": 0.20, "Azure": 0.30, "GCP": 0.20},
    },
    "DLT Core (Photon)": {
        "standard":   {"AWS": 0.20, "Azure": 0.20, "GCP": 0.20},
        "premium":    {"AWS": 0.20, "Azure": 0.30, "GCP": 0.20},
        "enterprise": {"AWS": 0.20, "Azure": 0.30, "GCP": 0.20},
    },
    "DLT Advanced": {
        "standard":   {"AWS": 0.36, "Azure": 0.36, "GCP": 0.36},
        "premium":    {"AWS": 0.36, "Azure": 0.54, "GCP": 0.36},
        "enterprise": {"AWS": 0.36, "Azure": 0.54, "GCP": 0.36},
    },
    "DLT Advanced (Photon)": {
        "standard":   {"AWS": 0.36, "Azure": 0.36, "GCP": 0.36},
        "premium":    {"AWS": 0.36, "Azure": 0.54, "GCP": 0.36},
        "enterprise": {"AWS": 0.36, "Azure": 0.54, "GCP": 0.36},
    },
    "DLT Pro": {
        "standard":   {"AWS": 0.25, "Azure": 0.25, "GCP": 0.25},
        "premium":    {"AWS": 0.25, "Azure": 0.38, "GCP": 0.25},
        "enterprise": {"AWS": 0.25, "Azure": 0.38, "GCP": 0.25},
    },
    "Model Serving": {
        "standard":   {"AWS": 0.07, "Azure": 0.07, "GCP": 0.07},
        "premium":    {"AWS": 0.07, "Azure": 0.07, "GCP": 0.07},
        "enterprise": {"AWS": 0.07, "Azure": 0.07, "GCP": 0.07},
    },
    "Serverless Inference": {
        "standard":   {"AWS": 0.07, "Azure": 0.07, "GCP": 0.07},
        "premium":    {"AWS": 0.07, "Azure": 0.07, "GCP": 0.07},
        "enterprise": {"AWS": 0.07, "Azure": 0.07, "GCP": 0.07},
    },
    "Foundation Model API": {
        "standard":   {"AWS": 0.105, "Azure": 0.105, "GCP": 0.105},
        "premium":    {"AWS": 0.105, "Azure": 0.105, "GCP": 0.105},
        "enterprise": {"AWS": 0.105, "Azure": 0.105, "GCP": 0.105},
    },
    "Vector Search": {
        "standard":   {"AWS": 0.07, "Azure": 0.07, "GCP": 0.07},
        "premium":    {"AWS": 0.07, "Azure": 0.07, "GCP": 0.07},
        "enterprise": {"AWS": 0.07, "Azure": 0.07, "GCP": 0.07},
    },
}

# Flat list kept for legacy fallback (Logfood unavailable)
_STATIC_SKU_PRICES: list[dict] = [
    {"sku": fn, "cloud": cloud, "list_price": price}
    for fn, tiers in _TIER_SKU_PRICES.items()
    for cloud, price in tiers["premium"].items()
]


# Runtime config (credentials, warehouse) — persisted to config.json
_config: dict = {}

def _load_config():
    global _config
    data = _load_json("config")
    if data and isinstance(data, dict):
        _config = data

def _save_config():
    _save_json("config", _config)


def _preload_caches():
    """Preload all JSON file caches into memory on startup."""
    count = 0

    def _load_dir(scan_dir: Path, user_prefix: str | None = None):
        nonlocal count
        for f in scan_dir.glob("*.json"):
            try:
                with open(f) as fh:
                    data = json.load(fh)
                name = f.stem
                if name.startswith("consumption_") and isinstance(data, list) and len(data) > 0:
                    raw_key = name[len("consumption_"):]
                    cache_key = f"{user_prefix}:{raw_key}" if user_prefix else raw_key
                    _consumption_cache[cache_key] = data
                    count += 1
                elif name.startswith("sku_prices_") and isinstance(data, list):
                    raw_key = name[len("sku_prices_"):]
                    cache_key = f"{user_prefix}:{raw_key}" if user_prefix else raw_key
                    _sku_price_cache[cache_key] = data
                    count += 1
                elif name.startswith("scenario_") and isinstance(data, dict):
                    raw_key = name[len("scenario_"):]
                    ukey = f"{user_prefix}:{raw_key}" if user_prefix else raw_key
                    _scenarios[ukey] = ScenarioAssumptions(**data)
                    count += 1
                elif name == "domain_mapping" and isinstance(data, list) and not user_prefix:
                    _domain_mapping_cache["default"] = data
                    count += 1
            except Exception as e:
                print(f"[preload] WARNING: failed to load {f.name}: {e}")

    # Top-level files (legacy, no user prefix)
    _load_dir(DATA_DIR)

    # User subdirectories — reconstruct username from dir name (reverse safe_username)
    for user_dir in DATA_DIR.iterdir():
        if not user_dir.is_dir() or user_dir.name.startswith("."):
            continue
        username = user_dir.name.replace("_at_", "@")
        _load_dir(user_dir, username)

    print(f"[preload] Loaded {count} cached files into memory")


# Preload on module import
_preload_caches()


def _load_json(name: str, user_dir: Path | None = None) -> dict | list | None:
    base = user_dir if user_dir else DATA_DIR
    p = base / f"{name}.json"
    if p.exists():
        return json.loads(p.read_text())
    return None


def _save_json(name: str, data, user_dir: Path | None = None):
    base = user_dir if user_dir else DATA_DIR
    tmp = base / f"{name}.json.tmp"
    tmp.write_text(json.dumps(data, default=str, indent=2))
    tmp.replace(base / f"{name}.json")  # atomic


def _safe_name(name: str) -> str:
    """Sanitise a name for use as a filename key (no slashes, spaces, colons)."""
    for ch in ("/", "\\", " ", ":", "?", "*"):
        name = name.replace(ch, "_")
    return name


def _norm_account(account: str) -> str:
    """Normalise account name to lowercase for case-insensitive lookups."""
    return account.strip().lower()


def _get_mapping(account: str, ud: Path) -> list[dict]:
    """Load the per-account workspace→domain mapping from the user's data dir."""
    return _load_json(f"domain_mapping_{_safe_name(account)}", ud) or []


def _udir(user: dict) -> Path:
    """Shorthand: return per-user data directory from JWT user dict."""
    return get_user_data_dir(user["sub"], DATA_DIR)


def _ucfg(user: dict) -> dict:
    """Load per-user config (warehouse_id etc.)."""
    cfg = _load_json("config", _udir(user))
    return cfg if isinstance(cfg, dict) else {}


def _host(user: dict) -> str:
    return user.get("host", "")


def _token(user: dict) -> str:
    return user.get("pat", "")


def _warehouse(user: dict) -> str:
    return _ucfg(user).get("warehouse_id", "")


_load_config()


# ---------------------------------------------------------------------------
# Auth endpoints  (public — no session required)
# ---------------------------------------------------------------------------

from pydantic import BaseModel as _BM

class LoginRequest(_BM):
    host: str = DEFAULT_HOST
    pat: str
    email: str | None = None   # required when pat == "demo"


@app.post("/api/auth/login")
async def login(body: LoginRequest, response: Response):
    """Validate PAT against Databricks, issue session cookie.
    If pat == 'demo', skip SCIM and use provided email as identity.
    """
    from auth import DEMO_TOKEN
    host = body.host.rstrip("/")
    username = await asyncio.to_thread(validate_pat_get_username, host, body.pat, body.email)
    token = create_session_token(username, host, body.pat)
    set_session_cookie(response, token)
    return {"username": username, "host": host, "demo": body.pat == DEMO_TOKEN}


@app.get("/api/auth/me")
async def auth_me(user: dict = Depends(get_current_user)):
    """Return current user info (used by frontend to check session)."""
    from auth import DEMO_TOKEN
    return {"username": user["sub"], "host": user["host"], "demo": user.get("pat") == DEMO_TOKEN}


@app.post("/api/auth/logout")
async def logout(response: Response):
    clear_session_cookie(response)
    return {"status": "logged out"}


# ---------------------------------------------------------------------------
# Domain Mapping — CSV upload (per account, per user)
# ---------------------------------------------------------------------------

@app.post("/api/accounts/{account_name}/domain-map")
async def upload_domain_map(
    account_name: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Upload a CSV (workspace_name,domain) and store it for this account."""
    account_name = _norm_account(account_name)
    content = await file.read()
    try:
        text = content.decode("utf-8-sig")   # handle Excel BOM
    except UnicodeDecodeError:
        text = content.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text))
    rows: list[dict] = []
    warnings: list[str] = []

    for i, row in enumerate(reader):
        norm = {k.strip().lower().replace(" ", "_"): (v or "").strip() for k, v in row.items()}
        ws = norm.get("workspace_name") or norm.get("workspace") or ""
        domain = norm.get("domain") or norm.get("domain_name") or ""
        if ws and domain:
            rows.append({"workspace": ws, "domain": domain})
        elif ws:
            warnings.append(f"Row {i + 2}: missing domain for workspace '{ws}'")

    if not rows:
        raise HTTPException(
            status_code=400,
            detail="No valid rows found. CSV must have columns: workspace_name, domain",
        )

    ud = _udir(user)
    _save_json(f"domain_mapping_{_safe_name(account_name)}", rows, ud)
    return {"status": "ok", "count": len(rows), "warnings": warnings[:10], "mapping": rows}


@app.get("/api/accounts/{account_name}/domain-map")
async def get_domain_map(
    account_name: str,
    user: dict = Depends(get_current_user),
):
    """Return the stored domain mapping for an account."""
    account_name = _norm_account(account_name)
    rows = _get_mapping(account_name, _udir(user))
    return {"mapping": rows, "count": len(rows)}


@app.get("/api/accounts/{account_name}/workspaces")
async def get_account_workspaces(
    account_name: str,
    user: dict = Depends(get_current_user),
):
    """Return unique workspace names seen in consumption data — used to seed the CSV template."""
    account_name = _norm_account(account_name)
    ud = _udir(user)
    ck = f"{user['sub']}:{account_name}"
    consumption = _consumption_cache.get(ck) or _load_json(f"consumption_{account_name}", ud) or []
    workspaces = sorted({r.get("workspace_name", "") for r in consumption if r.get("workspace_name")})
    return {"workspaces": workspaces}


# ---------------------------------------------------------------------------
# Consumption Data
# ---------------------------------------------------------------------------

@app.get("/api/consumption")
async def get_consumption(
    account: str = Query(default="Walmart"),
    refresh: bool = Query(default=False),
    user: dict = Depends(get_current_user),
):
    """Query Logfood for trailing 12 months consumption. Uses cache by default."""
    account_raw = account.strip()          # preserve original case for SFDC ID queries
    account = _norm_account(account)       # lowercase key for cache / filenames
    ud = _udir(user)
    cache_key = f"{user['sub']}:{account}"

    if cache_key in _consumption_cache and not refresh:
        cached_data = _consumption_cache[cache_key]
        if cached_data:  # don't serve empty results from in-memory cache
            return {"data": cached_data}

    if not refresh:
        cached = _load_json(f"consumption_{account}", ud)
        if cached:
            _consumption_cache[cache_key] = cached
            return {"data": cached, "source": "cached"}

    # Demo mode — never call Logfood; return only what was uploaded via smoke-test
    from auth import DEMO_TOKEN
    if user.get("pat") == DEMO_TOKEN:
        return {"data": [], "source": "demo"}

    try:
        loop = asyncio.get_event_loop()
        rows = await loop.run_in_executor(
            _executor,
            lambda: query_consumption(account_raw, host=_host(user), token=_token(user), warehouse_id=_warehouse(user)),
        )
        _consumption_cache[cache_key] = rows
        _save_json(f"consumption_{account}", rows, ud)
        return {"data": rows, "source": "logfood"}
    except Exception as e:
        cached = _load_json(f"consumption_{account}", ud)
        if cached:
            _consumption_cache[cache_key] = cached
            return {"data": cached, "warning": f"Using cached data. Error: {str(e)}"}
        raise HTTPException(status_code=500, detail=f"Logfood query failed: {str(e)}. Use CSV upload as fallback.")


@app.post("/api/consumption/upload")
async def upload_consumption(
    account: str = Query(default="Walmart"),
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Upload CSV as fallback for consumption data."""
    account = _norm_account(account)
    ud = _udir(user)
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

    _consumption_cache[f"{user['sub']}:{account}"] = rows
    _save_json(f"consumption_{account}", rows, ud)
    return {"data": rows, "count": len(rows)}


# ---------------------------------------------------------------------------
# SKU Prices
# ---------------------------------------------------------------------------

@app.get("/api/sku-prices")
async def get_sku_prices(
    account: str = Query(default="Walmart"),
    tier: str = Query(default="premium"),
    user: dict = Depends(get_current_user),
):
    """Get distinct SKU + cloud + list_price from Logfood."""
    account_raw = account.strip()          # preserve original case for SFDC ID queries
    account = _norm_account(account)       # lowercase key for cache / filenames
    ud = _udir(user)
    cache_key = f"{user['sub']}:{account}"
    if cache_key in _sku_price_cache:
        raw_rows = _sku_price_cache[cache_key]
    else:
        cached = _load_json(f"sku_prices_{account}", ud)
        if cached:
            raw_rows = cached
            _sku_price_cache[cache_key] = raw_rows
        else:
            try:
                raw_rows = query_sku_prices(account_raw, host=_host(user), token=_token(user), warehouse_id=_warehouse(user))
                _sku_price_cache[cache_key] = raw_rows
                _save_json(f"sku_prices_{account}", raw_rows, ud)
            except Exception:
                # Logfood unavailable (demo/smoke-test mode) — return static SKU list
                raw_rows = _STATIC_SKU_PRICES

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

    # All tier prices keyed by tier -> friendly_name -> cloud -> price
    # Returned in full so the frontend can apply per-UC tier without extra API calls.
    all_tier_prices = {
        t: {fn: dict(tiers.get(t, tiers["premium"])) for fn, tiers in _TIER_SKU_PRICES.items()}
        for t in ("standard", "premium", "enterprise")
    }

    # friendly_skus uses premium tier for the SKU/cloud dropdown population
    friendly_skus = [
        {"friendly_name": fn, "clouds": dict(tiers["premium"])}
        for fn, tiers in sorted(_TIER_SKU_PRICES.items())
    ]

    return {
        "sku_prices": sku_prices,
        "clouds": ["AWS", "Azure", "GCP"],  # always all 3 clouds
        "friendly_skus": friendly_skus,
        "tier_prices": all_tier_prices,
    }


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

def _calc_use_case_monthly(uc: dict, total_months: int = 36) -> list[float]:
    """Calculate monthly projection for a use case with ramp + adhoc periods."""
    result = [0.0] * total_months
    ss = uc.get("steadyStateDbu") or uc.get("steady_state_dbu") or 0
    om = uc.get("onboardingMonth") or uc.get("onboarding_month") or 1
    lm = uc.get("liveMonth") or uc.get("live_month") or 6
    ramp = uc.get("rampType") or uc.get("ramp_type") or "linear"
    adhoc_periods = uc.get("adhocPeriods") or uc.get("adhoc_periods") or []
    if ss <= 0 or lm < om:
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


@app.get("/api/summary")
async def get_summary(
    account: str = Query(default="Walmart"),
    scenario: int = Query(default=1),
    contract_months: int = Query(default=36),
    contract_start_date: str = Query(default=""),  # YYYY-MM — used to bridge gap from last complete month
    user: dict = Depends(get_current_user),
):
    """Return demand plan summary — pulls projections from saved scenario config."""
    account = _norm_account(account)
    ud = _udir(user)
    ck = f"{user['sub']}:{account}"
    consumption = _consumption_cache.get(ck)
    if not consumption:
        consumption = _load_json(f"consumption_{account}", ud)
    if not consumption:
        from auth import DEMO_TOKEN
        if user.get("pat") == DEMO_TOKEN:
            consumption = []
        else:
            try:
                loop = asyncio.get_event_loop()
                consumption = await loop.run_in_executor(
                    _executor,
                    lambda: query_consumption(account, host=_host(user), token=_token(user), warehouse_id=_warehouse(user)),
                )
                _consumption_cache[ck] = consumption
                _save_json(f"consumption_{account}", consumption, ud)
            except Exception as e:
                print(f"[summary] WARNING: could not fetch consumption for {account}: {e}")
                consumption = []
                _consumption_cache[ck] = []

    mapping_list = _get_mapping(account, ud)
    ws_to_domain = {m["workspace"].lower(): m["domain"] for m in mapping_list}

    # Aggregate T12M by domain
    domain_totals: dict[str, float] = defaultdict(float)
    monthly_totals: dict[str, float] = defaultdict(float)
    for row in consumption:
        ws = row.get("workspace_name") or ""
        domain = ws_to_domain.get(ws.lower(), "Untagged")
        dbu = row.get("dollar_dbu_list", 0) or 0
        domain_totals[domain] += float(dbu)
        month = row.get("month", "")
        monthly_totals[month] += float(dbu)

    # Use last complete month as baseline starting point (exclude current partial month)
    current_month_str = date.today().strftime("%Y-%m")
    complete_monthly = {m: v for m, v in monthly_totals.items() if m < current_month_str}
    if not complete_monthly:
        complete_monthly = monthly_totals  # fallback
    last_complete_month = max(complete_monthly.keys()) if complete_monthly else ""
    last_complete_value = complete_monthly.get(last_complete_month, 0)
    total_t12m = sum(monthly_totals.values())
    avg_monthly = total_t12m / len(monthly_totals) if monthly_totals else 0

    # n_offset: months from last_complete_month to contract_start_date (for gap bridging)
    def _months_diff(from_ym: str, to_ym: str) -> int:
        fy, fm = int(from_ym[:4]), int(from_ym[5:7])
        ty, tm = int(to_ym[:4]), int(to_ym[5:7])
        return max((ty * 12 + tm) - (fy * 12 + fm), 0)

    if contract_start_date and last_complete_month:
        n_offset = _months_diff(last_complete_month, contract_start_date)
    else:
        n_offset = 1  # default: one month forward

    # Get saved scenario config
    key = f"{account}_{scenario}"
    ukey = f"{user['sub']}:{key}"
    scenario_data = None
    if ukey in _scenarios:
        scenario_data = _scenarios[ukey].model_dump()
    else:
        scenario_data = _load_json(f"scenario_{key}", ud)

    # Derive number of contract years
    num_years = max(1, contract_months // 12)

    # Baseline growth rate (MoM directly, e.g. 0.005 = 0.5% MoM)
    baseline_growth = 0.005  # default 0.5% MoM
    baseline_adjustment = 0.0  # level adjustment (e.g. 0.10 = +10%)
    if scenario_data:
        baseline_growth = scenario_data.get("baseline_growth_rate", 0.005)
        baseline_adjustment = scenario_data.get("baseline_adjustment", 0.0)

    # Apply level adjustment to last complete month value
    mom_rate = baseline_growth
    adjusted_base = last_complete_value * (1 + baseline_adjustment)

    # Apply per-month baseline overrides (same as get_consumption_forecast)
    overrides_raw = (scenario_data or {}).get("baseline_overrides", [])
    overrides_map = {int(o["month_index"]): float(o["value"]) for o in overrides_raw}

    # Baseline: compound from last_complete_month forward, bridging gap to contract M1
    # M1 = adjusted_base × (1+r)^n_offset, M2 = adjusted_base × (1+r)^(n_offset+1), …
    baseline_year_totals = [0.0] * num_years
    for i in range(contract_months):
        computed = adjusted_base * ((1 + mom_rate) ** (n_offset + i))
        if i in overrides_map:
            monthly = computed * (1 + overrides_map[i] / 100)
        else:
            monthly = computed
        if i // 12 < num_years:
            baseline_year_totals[i // 12] += monthly

    # Calculate use case projections (only for this scenario)
    use_cases = (scenario_data or {}).get("new_use_cases", [])
    active_ucs = [uc for uc in use_cases if uc.get("scenarios", [False, False, False])[scenario - 1]]

    uc_rows = []
    uc_year_totals = [0.0] * num_years
    for uc in active_ucs:
        uc_monthly = _calc_use_case_monthly(uc, total_months=contract_months)
        yt = [0.0] * num_years
        for i, v in enumerate(uc_monthly):
            if i // 12 < num_years:
                yt[i // 12] += v
                uc_year_totals[i // 12] += v
        # Add adhoc amounts (no longer baked into _calc_use_case_monthly)
        for period in (uc.get("adhocPeriods") or uc.get("adhoc_periods") or []):
            for m in (period.get("months") or []):
                if isinstance(m, int) and 1 <= m <= contract_months:
                    adhoc_total = sum(
                        sa.get("dollarPerMonth") or sa.get("dollar_per_month") or 0
                        for sa in (period.get("skuAmounts") or period.get("sku_amounts") or [])
                    )
                    yr = (m - 1) // 12
                    if yr < num_years:
                        yt[yr] += adhoc_total
                        uc_year_totals[yr] += adhoc_total
        row: dict = {
            "use_case_area": f"  ↳ {uc.get('name', 'Unnamed')}",
            "total": round(sum(yt)),
            "is_use_case": True,
        }
        for y in range(num_years):
            row[f"year{y+1}"] = round(yt[y])
        uc_rows.append(row)

    # Build summary rows dynamically
    baseline_row: dict = {
        "use_case_area": f"Existing Baseline ({last_complete_month}, {baseline_growth*100:.2f}% MoM)",
        "total": round(sum(baseline_year_totals)),
    }
    for y in range(num_years):
        baseline_row[f"year{y+1}"] = round(baseline_year_totals[y])
    summary_rows = [baseline_row]

    if uc_rows:
        uc_header: dict = {
            "use_case_area": "New Use Cases",
            "total": round(sum(uc_year_totals)),
        }
        for y in range(num_years):
            uc_header[f"year{y+1}"] = round(uc_year_totals[y])
        summary_rows.append(uc_header)
        summary_rows.extend(uc_rows)

    grand_year_totals = [baseline_year_totals[y] + uc_year_totals[y] for y in range(num_years)]
    grand_row: dict = {
        "use_case_area": "Grand Total",
        "total": round(sum(grand_year_totals)),
    }
    for y in range(num_years):
        grand_row[f"year{y+1}"] = round(grand_year_totals[y])
    summary_rows.append(grand_row)

    # Domain breakdown for pie chart
    domain_breakdown = [
        {"domain": d, "value": round(v)}
        for d, v in sorted(domain_totals.items(), key=lambda x: -x[1])
    ]

    # Yearly trend — show baseline + use cases stacked
    yearly_trend = [
        {
            "year": f"Year {y+1}",
            "value": round(grand_year_totals[y]),
            "baseline": round(baseline_year_totals[y]),
            "new_uc": round(uc_year_totals[y]),
        }
        for y in range(num_years)
    ]

    # Scenario description from assumptions_text or defaults
    default_descriptions = {
        1: "Existing Live Use Cases + Baseline Growth",
        2: "Scenario 1 + Mid-term Use Cases",
        3: "Scenario 2 + Long-term Use Cases",
    }
    description = (scenario_data or {}).get("assumptions_text", "").strip()
    if not description:
        description = default_descriptions.get(scenario, f"Scenario {scenario}")

    return {
        "account": account,
        "scenario": scenario,
        "description": description,
        "total_t12m": round(total_t12m),
        "growth_rate": baseline_growth,
        "avg_monthly": round(avg_monthly),
        "summary_rows": summary_rows,
        "domain_breakdown": domain_breakdown,
        "yearly_trend": yearly_trend,
        "active_use_cases": len(active_ucs),
    }


@app.get("/api/consumption-forecast")
async def get_consumption_forecast(
    account: str = Query(default="Walmart"),
    scenario: int = Query(default=1),
    months: int = Query(default=24),
    start_date: str = Query(default=""),
    user: dict = Depends(get_current_user),
):
    """Return month-by-month consumption forecast rows for a scenario.

    Each row is either the baseline or a single use case.
    Months are calendar months starting from start_date (YYYY-MM) if provided,
    otherwise from next month.
    """
    account = _norm_account(account)
    from datetime import date, timedelta
    import calendar

    # Build month labels — use start_date if provided, else next calendar month
    if start_date:
        try:
            y, m = map(int, start_date.split("-"))
            start = date(y, m, 1)
        except Exception:
            start = None
    else:
        start = None

    if start is None:
        today = date.today()
        if today.month == 12:
            start = date(today.year + 1, 1, 1)
        else:
            start = date(today.year, today.month + 1, 1)

    month_labels = []
    d = start
    for _ in range(months):
        month_labels.append(d.strftime("%b %Y"))
        if d.month == 12:
            d = date(d.year + 1, 1, 1)
        else:
            d = date(d.year, d.month + 1, 1)

    # Get consumption for baseline
    ud = _udir(user)
    ck = f"{user['sub']}:{account}"
    consumption = _consumption_cache.get(ck) or _load_json(f"consumption_{account}", ud) or []

    # Build monthly totals and exclude current in-flight (partial) month from avg
    monthly_map: dict[str, float] = defaultdict(float)
    for r in consumption:
        m = r.get("month", "")
        if m:
            monthly_map[m] += float(r.get("dollar_dbu_list", 0) or 0)
    current_month_str = date.today().strftime("%Y-%m")
    complete_months = {m: v for m, v in monthly_map.items() if m < current_month_str}
    baseline_monthly = complete_months if complete_months else monthly_map
    last_complete_month = max(baseline_monthly.keys()) if baseline_monthly else ""
    last_complete_value = baseline_monthly.get(last_complete_month, 0)

    # Get scenario config
    key = f"{account}_{scenario}"
    ukey = f"{user['sub']}:{key}"
    scenario_data = None
    if ukey in _scenarios:
        scenario_data = _scenarios[ukey].model_dump()
    else:
        scenario_data = _load_json(f"scenario_{key}", ud)

    baseline_growth = (scenario_data or {}).get("baseline_growth_rate", 0.005)
    baseline_adjustment = (scenario_data or {}).get("baseline_adjustment", 0.0)
    mom_rate = baseline_growth
    adjusted_base = last_complete_value * (1 + baseline_adjustment)

    # n_offset: gap from last complete month to contract start (start_date = contract M1)
    def _months_diff_fc(from_ym: str, to_ym: str) -> int:
        fy, fm = int(from_ym[:4]), int(from_ym[5:7])
        ty, tm = int(to_ym[:4]), int(to_ym[5:7])
        return max((ty * 12 + tm) - (fy * 12 + fm), 0)

    if start_date and last_complete_month:
        n_offset = _months_diff_fc(last_complete_month, start_date)
    else:
        n_offset = 1  # default: one month forward

    # Apply per-month baseline overrides
    overrides_raw = (scenario_data or {}).get("baseline_overrides", [])
    overrides_map = {int(o["month_index"]): float(o["value"]) for o in overrides_raw}
    baseline_values = []
    overridden_month_indices = []
    for i in range(months):
        computed = adjusted_base * ((1 + mom_rate) ** (n_offset + i))
        if i in overrides_map:
            pct = overrides_map[i]  # stored as % (e.g. -10 for -10%), applied to both $ and DBU
            baseline_values.append(round(computed * (1 + pct / 100)))
            overridden_month_indices.append(i)
        else:
            baseline_values.append(round(computed))

    rows = [{
        "type": "baseline",
        "id": "baseline",
        "label": f"Existing Baseline ({last_complete_month}, {baseline_growth * 100:.2f}% MoM)",
        "domain": "",
        "values": baseline_values,
        "onboarding_month": None,
        "live_month": None,
        "steady_state_dbu": None,
        "overridden_month_indices": overridden_month_indices,
    }]

    # Use case rows — only active in this scenario
    use_cases = (scenario_data or {}).get("new_use_cases", [])
    active_ucs = [uc for uc in use_cases if uc.get("scenarios", [False, False, False])[scenario - 1]]

    for uc in active_ucs:
        uc_monthly_full = _calc_use_case_monthly(uc)  # 36 months
        uc_values = [round(uc_monthly_full[i]) if i < 36 else 0 for i in range(months)]
        rows.append({
            "type": "use_case",
            "id": uc.get("id", ""),
            "label": uc.get("name", "Unnamed"),
            "domain": uc.get("domain", ""),
            "values": uc_values,
            "onboarding_month": uc.get("onboardingMonth") or uc.get("onboarding_month"),
            "live_month": uc.get("liveMonth") or uc.get("live_month"),
            "steady_state_dbu": uc.get("steadyStateDbu") or uc.get("steady_state_dbu"),
            "uplift_only": uc.get("upliftOnly") or uc.get("uplift_only") or False,
            "description": uc.get("description") or "",
            "adhoc_periods": uc.get("adhocPeriods") or uc.get("adhoc_periods") or [],
        })

    # Total row — sum ramp rows + adhoc amounts (adhoc displayed as sub-rows, not in uc_values)
    totals = [sum(row["values"][i] for row in rows) for i in range(months)]
    for uc in active_ucs:
        for period in (uc.get("adhocPeriods") or uc.get("adhoc_periods") or []):
            for m in (period.get("months") or []):
                if isinstance(m, int) and 1 <= m <= months:
                    adhoc_total = sum(
                        sa.get("dollarPerMonth") or sa.get("dollar_per_month") or 0
                        for sa in (period.get("skuAmounts") or period.get("sku_amounts") or [])
                    )
                    totals[m - 1] += adhoc_total

    return {
        "account": account,
        "scenario": scenario,
        "month_labels": month_labels,
        "rows": rows,
        "totals": [round(t) for t in totals],
        "baseline_growth": baseline_growth,
    }


@app.get("/api/summary-all")
async def get_summary_all(
    account: str = Query(default="Walmart"),
    contract_months: int = Query(default=36),
    contract_start_date: str = Query(default=""),
    user: dict = Depends(get_current_user),
):
    """Return summary for all 3 scenarios (fetched in parallel)."""
    account = _norm_account(account)
    results = await asyncio.gather(
        get_summary(account, 1, contract_months, contract_start_date, user),
        get_summary(account, 2, contract_months, contract_start_date, user),
        get_summary(account, 3, contract_months, contract_start_date, user),
    )
    return {"account": account, "scenarios": list(results)}


# ---------------------------------------------------------------------------
# Scenario
# ---------------------------------------------------------------------------

@app.post("/api/scenario")
async def save_scenario(data: ScenarioAssumptions, user: dict = Depends(get_current_user)):
    """Save scenario assumptions with optimistic locking."""
    data.account = _norm_account(data.account)
    ud = _udir(user)
    key = f"{data.account}_{data.scenario_id}"
    ukey = f"{user['sub']}:{key}"
    # Always read from disk for the conflict check — in-memory cache is stale across workers
    cached = _load_json(f"scenario_{key}", ud)
    current = ScenarioAssumptions(**cached) if cached else _scenarios.get(ukey)
    if current is not None and data.version != current.version:
        raise HTTPException(
            status_code=409,
            detail=f"Conflict: scenario was modified by another session (your version: {data.version}, current: {current.version})",
        )
    data.version = (current.version if current else 0) + 1
    _scenarios[ukey] = data
    _save_json(f"scenario_{key}", data.model_dump(), ud)
    return {"status": "ok", "key": key, "version": data.version}


@app.get("/api/scenario")
async def get_scenario(
    account: str = Query(default="Walmart"),
    scenario: int = Query(default=1),
    user: dict = Depends(get_current_user),
):
    """Get scenario assumptions."""
    account = _norm_account(account)
    ud = _udir(user)
    key = f"{account}_{scenario}"
    ukey = f"{user['sub']}:{key}"
    if ukey in _scenarios:
        return _scenarios[ukey].model_dump()

    cached = _load_json(f"scenario_{key}", ud)
    if cached:
        return cached

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
async def save_forecast(data: ForecastUpdate, user: dict = Depends(get_current_user)):
    """Save/update forecast overrides."""
    data.account = _norm_account(data.account)
    ud = _udir(user)
    fk = f"{user['sub']}:{data.account}"
    _forecast_overrides[fk] = [o.model_dump() for o in data.overrides]
    _save_json(f"forecast_{data.account}", _forecast_overrides[fk], ud)
    return {"status": "ok", "count": len(data.overrides)}


@app.get("/api/forecast")
async def get_forecast(
    account: str = Query(default="Walmart"),
    user: dict = Depends(get_current_user),
):
    """Get workspace-level forecast data."""
    account = _norm_account(account)
    ud = _udir(user)
    ck = f"{user['sub']}:{account}"
    consumption = _consumption_cache.get(ck) or _load_json(f"consumption_{account}", ud) or []

    mapping_list = _get_mapping(account, ud)
    ws_to_domain = {m["workspace"].lower(): m["domain"] for m in mapping_list}

    ws_data: dict[str, dict] = {}
    for row in consumption:
        ws = row.get("workspace_name") or ""
        if ws not in ws_data:
            ws_data[ws] = {
                "workspace": ws,
                "domain": ws_to_domain.get(ws.lower(), "Untagged"),
                "cloud": "AWS",
                "monthly_dbu": 0.0,
                "total_dbu": 0.0,
            }
        ws_data[ws]["total_dbu"] += float(row.get("dollar_dbu_list", 0) or 0)

    for ws in ws_data.values():
        ws["monthly_dbu"] = round(ws["total_dbu"] / 12, 2)
        ws["total_dbu"] = round(ws["total_dbu"], 2)

    fk = f"{user['sub']}:{account}"
    overrides = _forecast_overrides.get(fk) or _load_json(f"forecast_{account}", ud) or []
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
# Clear All Data
# ---------------------------------------------------------------------------

@app.delete("/api/clear-data")
async def clear_all_data(user: dict = Depends(get_current_user)):
    """Delete ONLY the current user's cached JSON files and clear their in-memory caches.
    Other users' data is never touched."""
    ud = _udir(user)
    prefix = f"{user['sub']}:"
    for k in list(_consumption_cache.keys()):
        if k.startswith(prefix): del _consumption_cache[k]
    for k in list(_scenarios.keys()):
        if k.startswith(prefix): del _scenarios[k]
    for k in list(_forecast_overrides.keys()):
        if k.startswith(prefix): del _forecast_overrides[k]
    for k in list(_sku_price_cache.keys()):
        if k.startswith(prefix): del _sku_price_cache[k]
    for k in list(_domain_mapping_cache.keys()):
        if k.startswith(prefix): del _domain_mapping_cache[k]
    deleted = []
    for f in ud.glob("*.json"):
        if f.name != "config.json":  # preserve warehouse_id / PAT config
            f.unlink()
            deleted.append(f.name)
    return {"deleted": deleted, "count": len(deleted), "user": user["sub"]}

# ---------------------------------------------------------------------------

@app.get("/api/account-overview")
async def get_account_overview(
    account: str = Query(default="Walmart"),
    user: dict = Depends(get_current_user),
):
    """High-level account metrics."""
    account = _norm_account(account)
    ud = _udir(user)
    ck = f"{user['sub']}:{account}"
    consumption = _consumption_cache.get(ck) or _load_json(f"consumption_{account}", ud) or []

    mapping_list = _get_mapping(account, ud)
    ws_to_domain = {m["workspace"].lower(): m["domain"] for m in mapping_list}

    # Aggregate by month, domain, and SKU
    monthly_totals: dict[str, float] = defaultdict(float)
    domain_totals: dict[str, float] = defaultdict(float)
    month_domain: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    month_sku: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    sku_totals: dict[str, float] = defaultdict(float)

    for row in consumption:
        month = row.get("month", "")
        ws = row.get("workspace_name") or ""
        sku = row.get("sku", "Unknown") or "Unknown"
        domain = ws_to_domain.get(ws.lower(), "Untagged")
        dbu = float(row.get("dollar_dbu_list", 0) or 0)
        monthly_totals[month] += dbu
        domain_totals[domain] += dbu
        month_domain[month][domain] += dbu
        month_sku[month][sku] += dbu
        sku_totals[sku] += dbu

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

    # Top domains + SKUs for stacked chart keys
    top_domain_keys = [d for d, _ in sorted(domain_totals.items(), key=lambda x: -x[1])[:10]]
    top_sku_keys    = [s for s, _ in sorted(sku_totals.items(),    key=lambda x: -x[1])[:10]]

    # Monthly by domain — [{month, domain1: v, domain2: v, ...}]
    monthly_by_domain = [
        {"month": m, **{d: round(month_domain[m].get(d, 0), 2) for d in top_domain_keys}}
        for m in sorted_months
    ]

    # Monthly by SKU — [{month, sku1: v, sku2: v, ...}]
    monthly_by_sku = [
        {"month": m, **{s: round(month_sku[m].get(s, 0), 2) for s in top_sku_keys}}
        for m in sorted_months
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
        "monthly_by_domain": monthly_by_domain,
        "monthly_by_sku": monthly_by_sku,
        "top_domain_keys": top_domain_keys,
        "top_sku_keys": top_sku_keys,
    }


# ── Contract Health ────────────────────────────────────────────────────────────
@app.get("/api/contract-health")
async def get_contract_health(
    account: str = Query(default=""),
    user: dict = Depends(get_current_user),
):
    """
    Fetch contract burn curve data from main.gtm_gold.commit_consumption_cpq_monthly.
    Returns monthly rows aggregated by opportunity, plus a derived summary.
    """
    account_raw = account.strip()          # preserve original case for SFDC ID queries
    account = _norm_account(account)       # lowercase key for cache / filenames
    if not account:
        return {"account": account, "opportunities": [], "summary": None}

    host = _host(user)
    token = _token(user)
    warehouse_id = _warehouse(user)

    try:
        import asyncio as _aio
        rows = await _aio.wait_for(
            _aio.to_thread(query_contract_health, account_raw, host, token, warehouse_id),
            timeout=45,
        )
    except TimeoutError:
        raise HTTPException(status_code=504, detail="Contract health query timed out (>45s)")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Contract health query failed: {str(e)}")

    if not rows:
        return {"account": account, "opportunities": [], "summary": None}

    # Group by contract_number — each is a separate contract line
    from collections import defaultdict
    contract_rows: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        label = r.get("contract_number") or r.get("contract_id") or "Contract"
        contract_rows[label].append(r)

    opportunities = []
    for contract_label, opp_data in contract_rows.items():
        opp_data_sorted = sorted(opp_data, key=lambda x: x.get("usage_month") or "")
        commit_amount = float(opp_data_sorted[0].get("commit_amount_usd") or 0)
        contract_start = opp_data_sorted[0].get("contract_start_date") or ""
        contract_end   = opp_data_sorted[0].get("contract_end_date") or ""

        # Build monthly burn curve
        burn_curve = []
        for r in opp_data_sorted:
            burn_curve.append({
                "month":            r.get("usage_month", ""),
                "monthly_actual":   round(float(r.get("monthly_actual") or 0), 2),
                "cumulative_actual":round(float(r.get("cumulative_actual") or 0), 2),
                "commit_amount":    round(commit_amount, 2),
                "remaining_commit": round(float(r.get("remaining_commit") or 0), 2),
            })

        latest = opp_data_sorted[-1]
        cumulative_consumed = float(latest.get("cumulative_actual") or 0)
        remaining = float(latest.get("remaining_commit") or max(commit_amount - cumulative_consumed, 0))
        burn_pct = round(float(latest.get("burn_pct") or 0), 1)

        opportunities.append({
            "opportunity_name": contract_label,
            "contract_start":   str(contract_start)[:10] if contract_start else "",
            "contract_end":     str(contract_end)[:10] if contract_end else "",
            "commit_amount":    round(commit_amount, 2),
            "cumulative_actual":round(cumulative_consumed, 2),
            "remaining_commit": round(remaining, 2),
            "burn_pct":         burn_pct,
            "burn_curve":       burn_curve,
        })

    # Sort by contract_start descending so the latest contract is always first
    opportunities.sort(key=lambda o: o.get("contract_start") or "", reverse=True)

    # Overall summary across all opportunities
    total_commit = sum(o["commit_amount"] for o in opportunities)
    total_consumed = sum(o["cumulative_actual"] for o in opportunities)
    total_remaining = sum(o["remaining_commit"] for o in opportunities)
    overall_burn_pct = round(total_consumed / total_commit * 100, 1) if total_commit else 0

    return {
        "account": account,
        "opportunities": opportunities,
        "summary": {
            "total_commit":    round(total_commit, 2),
            "total_consumed":  round(total_consumed, 2),
            "total_remaining": round(total_remaining, 2),
            "burn_pct":        overall_burn_pct,
        },
    }


# ── SFDC Use Cases (UCOs) ────────────────────────────────────────────────────
_sfdc_ucos_cache: dict[str, list[dict]] = {}

_UCO_CSV_COLUMNS = [
    "Id", "Name", "stage", "use_case_area", "monthly_dollar",
    "t_shirt_size", "go_live_date", "onboarding_date",
    "solution_architect", "status", "business_use_case", "demand_plan_stage",
]


@app.get("/api/sfdc-use-cases")
async def get_sfdc_use_cases(
    account: str = Query(default=""),
    user: dict = Depends(get_current_user),
):
    """Fetch active U1-U4 UCOs. In demo/testing mode returns uploaded JSON data (if any)."""
    account_raw = account.strip()          # preserve original case for Logfood SFDC ID lookup
    account_key = _norm_account(account)   # lowercase key for cache / filenames
    if not account_key:
        return {"account": account_key, "use_cases": []}

    ud = _udir(user)
    cache_key = f"{user['sub']}:{account_key}"

    # Check in-memory cache first
    if cache_key in _sfdc_ucos_cache:
        return {"account": account_key, "use_cases": _sfdc_ucos_cache[cache_key]}

    # Check disk cache (covers uploaded data + previously fetched data)
    stored = _load_json(f"sfdc_ucos_{account_key}", ud)
    if stored is not None:
        _sfdc_ucos_cache[cache_key] = stored
        return {"account": account_key, "use_cases": stored}

    # Demo mode with no uploaded data — return empty
    if user.get("demo"):
        return {"account": account_key, "use_cases": []}

    host = _host(user)
    token = _token(user)
    warehouse_id = _warehouse(user)

    try:
        import asyncio as _aio
        rows = await _aio.wait_for(
            # Pass account_raw (original case) so SFDC ID resolves correctly
            _aio.to_thread(query_sfdc_use_cases, account_raw, host, token, warehouse_id),
            timeout=60,
        )
    except TimeoutError:
        raise HTTPException(status_code=504, detail="UCO query timed out (>60s)")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"UCO query failed: {str(e)}")

    # Only persist non-empty results — empty results might indicate a query glitch
    if rows:
        _sfdc_ucos_cache[cache_key] = rows
        _save_json(f"sfdc_ucos_{account_key}", rows, ud)
    return {"account": account_key, "use_cases": rows}


@app.post("/api/sfdc-use-cases/upload")
async def upload_sfdc_use_cases(
    account: str = Query(...),
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Upload a JSON array of UCOs for demo/testing mode.
    Each object must have: Id, Name, stage (U1-U4)
    Optional fields: use_case_area, monthly_dollar, t_shirt_size, go_live_date,
                     onboarding_date, solution_architect, status, business_use_case,
                     demand_plan_stage
    """
    account_key = _norm_account(account)
    ud = _udir(user)
    content = await file.read()
    try:
        rows_raw = json.loads(content)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {e}")

    if not isinstance(rows_raw, list) or len(rows_raw) == 0:
        raise HTTPException(status_code=400, detail="File must be a non-empty JSON array")

    required = {"Id", "Name", "stage"}
    missing = required - set(rows_raw[0].keys())
    if missing:
        raise HTTPException(status_code=400, detail=f"Missing required fields: {missing}")

    rows = []
    for r in rows_raw:
        monthly = r.get("monthly_dollar")
        rows.append({
            "Id": str(r.get("Id", "")).strip(),
            "Name": str(r.get("Name", "")).strip(),
            "stage": str(r.get("stage", "")).strip().upper(),
            "use_case_area": r.get("use_case_area") or None,
            "monthly_dollar": float(monthly) if monthly is not None else None,
            "t_shirt_size": r.get("t_shirt_size") or None,
            "go_live_date": r.get("go_live_date") or None,
            "onboarding_date": r.get("onboarding_date") or None,
            "solution_architect": r.get("solution_architect") or None,
            "status": r.get("status") or None,
            "business_use_case": r.get("business_use_case") or None,
            "demand_plan_stage": r.get("demand_plan_stage") or None,
        })

    cache_key = f"{user['sub']}:{account_key}"
    _sfdc_ucos_cache[cache_key] = rows
    _save_json(f"sfdc_ucos_{account_key}", rows, ud)

    return {"status": "ok", "account": account_key, "records": len(rows)}


# ── Setup: status ──────────────────────────────────────────────────────────────
@app.get("/api/setup/status")
async def setup_status(user: dict = Depends(get_current_user)):
    """Return which setup steps are complete."""
    import subprocess
    from sheets import get_stored_google_token
    google_ok = get_stored_google_token() is not None
    if not google_ok:
        try:
            r = subprocess.run(["gcloud", "auth", "print-access-token"],
                               capture_output=True, text=True, timeout=10)
            google_ok = r.returncode == 0 and bool(r.stdout.strip())
        except Exception:
            pass
    ucfg = _ucfg(user)
    return {
        "databricks": True,  # credentials come from login session
        "google": google_ok,
        "warehouse_id": ucfg.get("warehouse_id", ""),
        "host": _host(user),
        "username": user["sub"],
    }

@app.get("/api/setup/warehouses")
async def list_warehouses(user: dict = Depends(get_current_user)):
    """List available SQL warehouses in the configured workspace."""
    import requests as _req
    try:
        r = _req.get(
            f"{_host(user)}/api/2.0/sql/warehouses",
            headers={"Authorization": f"Bearer {_token(user)}"},
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
        warehouses = [
            {"id": wh["id"], "name": wh["name"], "state": wh.get("state", "UNKNOWN")}
            for wh in data.get("warehouses", [])
        ]
        return {"warehouses": warehouses}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/setup/warehouse")
async def save_warehouse(data: dict, user: dict = Depends(get_current_user)):
    """Save selected warehouse ID per user."""
    ud = _udir(user)
    ucfg = _ucfg(user)
    ucfg["warehouse_id"] = data.get("warehouse_id", "")
    _save_json("config", ucfg, ud)
    return {"status": "ok"}

# ── Setup: Google — try gcloud first, then device flow ─────────────────────────
@app.post("/api/setup/google/check-gcloud")
async def google_check_gcloud():
    """Check if gcloud auth is available and working."""
    import subprocess
    try:
        result = subprocess.run(
            ["gcloud", "auth", "print-access-token"],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode == 0 and result.stdout.strip():
            return {"status": "ok", "method": "gcloud"}
        return {"status": "unavailable", "detail": result.stderr.strip()}
    except FileNotFoundError:
        return {"status": "unavailable", "detail": "gcloud not installed"}
    except Exception as e:
        return {"status": "unavailable", "detail": str(e)}

@app.post("/api/setup/google/start")
async def google_oauth_start():
    """Start Google OAuth 2.0 device flow."""
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    if not client_id:
        raise HTTPException(
            status_code=400,
            detail="GOOGLE_CLIENT_ID environment variable not set. Use gcloud auth instead.",
        )
    from sheets import start_device_flow
    try:
        result = await start_device_flow()
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/setup/google/poll")
async def google_oauth_poll(device_code: str = Query(...)):
    """Poll for device flow completion."""
    from sheets import poll_device_flow
    result = await poll_device_flow(device_code)
    return result

@app.delete("/api/setup/google")
async def google_disconnect():
    """Remove stored Google tokens."""
    from sheets import clear_google_tokens
    clear_google_tokens()
    return {"status": "ok"}

# ── Account search ──────────────────────────────────────────────────────────────
@app.get("/api/accounts-search")
async def accounts_search(
    q: str = Query(default=""),
    user: dict = Depends(get_current_user),
):
    """Search Logfood for accounts matching query."""
    from auth import DEMO_TOKEN
    if user.get("pat") == DEMO_TOKEN:
        return {"accounts": []}
    from logfood import search_accounts
    try:
        loop = asyncio.get_event_loop()
        results = await loop.run_in_executor(
            _executor,
            search_accounts,
            q,
            _host(user),
            _token(user),
            _warehouse(user),
        )
        return {"accounts": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Upload formatted export to Google Drive
# ---------------------------------------------------------------------------

@app.post("/api/export/upload-to-drive")
async def upload_export_to_drive(
    filename: str = Query(...),
    file: UploadFile = File(...),
):
    """Receive an .xlsx blob from the frontend and upload it to Google Drive."""
    import httpx
    from sheets import get_google_token

    try:
        token = get_google_token()
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Google auth not available: {e}")

    content = await file.read()
    mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

    # Multipart upload to Drive
    metadata = json.dumps({"name": filename, "mimeType": mime})
    boundary = "boundary_demand_plan"
    body = (
        f"--{boundary}\r\n"
        f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{metadata}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: {mime}\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--".encode()

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": f"multipart/related; boundary={boundary}",
        "Content-Length": str(len(body)),
    }

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
            headers=headers,
            content=body,
        )

    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"Drive upload failed: {resp.text}")

    file_id = resp.json().get("id")
    url = f"https://drive.google.com/file/d/{file_id}/view"
    return {"url": url, "file_id": file_id}


# ---------------------------------------------------------------------------
# Smoke Test — upload consumption JSON to bypass Logfood
# ---------------------------------------------------------------------------

@app.post("/api/smoke-test/load")
async def smoke_test_load(
    account: str = Query(..., description="Account name / display name"),
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Load a pre-exported consumption JSON for smoke testing without Logfood access.
    The file must be a JSON array with the same schema as Logfood exports:
      [{workspace_name, cloud, month, sku, total_dbus, dollar_dbu_list}, ...]
    The account name is used as-is for all subsequent queries.
    """
    account = _norm_account(account)
    ud = _udir(user)
    content = await file.read()
    try:
        rows = json.loads(content)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {e}")

    if not isinstance(rows, list) or len(rows) == 0:
        raise HTTPException(status_code=400, detail="File must be a non-empty JSON array")

    required_fields = {"workspace_name", "cloud", "month", "sku", "total_dbus", "dollar_dbu_list"}
    sample = rows[0]
    missing = required_fields - set(sample.keys())
    if missing:
        raise HTTPException(status_code=400, detail=f"Missing required fields: {missing}")

    cache_key = f"{user['sub']}:{account}"
    _consumption_cache[cache_key] = rows
    _save_json(f"consumption_{account}", rows, ud)

    return {"status": "ok", "account": account, "records": len(rows)}


# ---------------------------------------------------------------------------
# Serve frontend static files (must be LAST — catches all unmatched routes)
# ---------------------------------------------------------------------------

FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"
if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, workers=4)
