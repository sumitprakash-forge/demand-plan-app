from pydantic import BaseModel
from typing import Optional


class ScenarioAssumptions(BaseModel):
    scenario_id: int  # 1, 2, or 3
    account: str
    baseline_growth_rate: float = 0.005  # MoM growth rate (e.g., 0.005 = 0.5% MoM)
    baseline_adjustment: float = 0.0  # level adjustment to avg_monthly before compounding (+0.10 = +10%)
    growth_rates: dict[str, float] = {}  # legacy: domain -> growth rate (optional)
    assumptions_text: str = ""
    new_use_cases: list[dict] = []  # [{id, name, domain, steadyStateDbu, onboardingMonth, liveMonth, rampType, scenarios}]
    baseline_overrides: list[dict] = []  # [{month_index: int (0-35), value: float}]
    serverless_uplift_pct: float = 0.0  # legacy (optional)
    global_growth_rate: float = 0.02  # legacy alias (optional)
    version: int = 0  # optimistic locking — incremented on each save


class ForecastOverride(BaseModel):
    workspace: str
    domain: str
    cloud: str
    monthly_dbu: float


class ForecastUpdate(BaseModel):
    account: str
    overrides: list[ForecastOverride] = []
