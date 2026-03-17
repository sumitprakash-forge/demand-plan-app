from pydantic import BaseModel
from typing import Optional


class ScenarioAssumptions(BaseModel):
    scenario_id: int  # 1, 2, or 3
    account: str
    growth_rates: dict[str, float]  # domain -> annual growth rate
    assumptions_text: str
    new_use_cases: list[dict]  # [{domain, name, year1_dbu, year2_dbu, year3_dbu}]
    serverless_uplift_pct: float  # e.g. 0.15 for 15%


class ForecastOverride(BaseModel):
    workspace: str
    domain: str
    cloud: str
    monthly_dbu: float


class ForecastUpdate(BaseModel):
    account: str
    overrides: list[ForecastOverride]
