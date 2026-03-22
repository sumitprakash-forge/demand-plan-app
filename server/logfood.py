"""Logfood (Databricks) query helper for consumption data."""

import time
from typing import Optional


SKU_PRICES_SQL = """
SELECT DISTINCT sku, cloud, CAST(list_price AS DOUBLE) as list_price
FROM main.fin_live_gold.paid_usage_metering
WHERE ({account_filter})
    AND date >= date_add(current_date(), -90)
    AND list_price > 0
ORDER BY sku, cloud
"""


CONSUMPTION_SQL = """
SELECT
    sfdc_workspace_name as workspace_name,
    cloud,
    date_format(date, 'yyyy-MM') as month,
    sku,
    sum(usage_amount) as total_dbus,
    sum(usage_dollars_at_list) as dollar_dbu_list
FROM main.fin_live_gold.paid_usage_metering
WHERE ({account_filter})
    AND date >= date_add(current_date(), -365)
GROUP BY sfdc_workspace_name, cloud, date_format(date, 'yyyy-MM'), sku
ORDER BY month, sfdc_workspace_name
"""

ACCOUNT_NAME_SQL = """
SELECT DISTINCT sfdc_account_name
FROM main.fin_live_gold.paid_usage_metering
WHERE ({account_filter})
    AND date >= date_add(current_date(), -90)
LIMIT 5
"""


def _get_client(host: str = "", token: str = ""):
    """Return a WorkspaceClient using host+token if provided, else profile='logfood'."""
    from databricks.sdk import WorkspaceClient
    if host and token:
        return WorkspaceClient(host=host, token=token)
    return WorkspaceClient(profile="logfood")


def _build_account_filter(account: str) -> str:
    """Build SQL filter — detects if input is SFDC account ID (18-char alphanumeric) or name."""
    account = account.strip()
    # SFDC IDs are typically 15 or 18 chars, start with 001
    if len(account) in (15, 18) and account[:3] == '001':
        return f"sfdc_account_id = '{account}'"
    else:
        return f"sfdc_account_name = '{account}'"


def query_consumption(account: str = "Walmart", host: str = "", token: str = "", warehouse_id: str = "") -> list[dict]:
    """
    Query Logfood for trailing 12 months consumption.
    Accepts either SFDC account name or SFDC account ID (auto-detected).
    """
    w = _get_client(host, token)
    wh_id = warehouse_id if warehouse_id else "071969b1ec9a91ca"

    account_filter = _build_account_filter(account)
    sql = CONSUMPTION_SQL.format(account_filter=account_filter)

    result = w.statement_execution.execute_statement(
        warehouse_id=wh_id,
        statement=sql,
        wait_timeout="50s",
    )

    # If still running, poll until done
    if result.status and result.status.state and result.status.state.value in ("PENDING", "RUNNING"):
        import time as _time
        stmt_id = result.statement_id
        for _ in range(60):  # poll up to 5 min
            _time.sleep(5)
            result = w.statement_execution.get_statement(stmt_id)
            if result.status.state.value in ("SUCCEEDED", "FAILED", "CANCELED", "CLOSED"):
                break

    # Parse results
    if not result.result or not result.result.data_array:
        return []

    columns = [col.name for col in result.manifest.schema.columns]
    rows = []
    for row_data in result.result.data_array:
        row = {}
        for i, col_name in enumerate(columns):
            val = row_data[i]
            if col_name in ("total_dbus", "dollar_dbu_list") and val is not None:
                val = float(val)
            row[col_name] = val
        rows.append(row)

    return rows


def query_sku_prices(account: str = "Walmart", host: str = "", token: str = "", warehouse_id: str = "") -> list[dict]:
    """
    Query Logfood for distinct SKU + cloud + list_price (last 90 days).
    Returns list of dicts with keys: sku, cloud, list_price
    """
    w = _get_client(host, token)

    wh_id = warehouse_id if warehouse_id else "071969b1ec9a91ca"
    if not warehouse_id:
        try:
            warehouses = list(w.warehouses.list())
            for wh in warehouses:
                if wh.state and wh.state.value == "RUNNING":
                    wh_id = wh.id
                    break
        except Exception:
            pass

    account_filter = _build_account_filter(account)
    sql = SKU_PRICES_SQL.format(account_filter=account_filter)

    result = w.statement_execution.execute_statement(
        warehouse_id=wh_id,
        statement=sql,
        wait_timeout="50s",
    )

    if result.status and result.status.state and result.status.state.value in ("PENDING", "RUNNING"):
        import time as _time
        stmt_id = result.statement_id
        for _ in range(60):
            _time.sleep(5)
            result = w.statement_execution.get_statement(stmt_id)
            if result.status.state.value in ("SUCCEEDED", "FAILED", "CANCELED", "CLOSED"):
                break

    if not result.result or not result.result.data_array:
        return []

    columns = [col.name for col in result.manifest.schema.columns]
    rows = []
    for row_data in result.result.data_array:
        row = {}
        for i, col_name in enumerate(columns):
            val = row_data[i]
            if col_name == "list_price" and val is not None:
                val = float(val)
            row[col_name] = val
        rows.append(row)

    return rows


CONTRACT_HEALTH_SQL = """
SELECT
    account_id,
    contract_number,
    contract_id,
    calendar_year_month                                                     AS usage_month,
    CAST(contract_start_date AS STRING)                                     AS contract_start_date,
    CAST(contract_end_date AS STRING)                                       AS contract_end_date,
    COALESCE(commit_amount_customer, 0)                                     AS commit_amount_usd,
    COALESCE(commit_consumed_dollar_dbus, 0)                                AS monthly_actual,
    COALESCE(cum_commit_consumed_dollar_dbus, 0)                            AS cumulative_actual,
    GREATEST(COALESCE(commit_amount_customer, 0)
             - COALESCE(cum_commit_consumed_dollar_dbus, 0), 0)             AS remaining_commit,
    COALESCE(cum_pct_burn_down_actual, 0) * 100                             AS burn_pct,
    is_primary_contract_ind,
    contract_rank
FROM main.gtm_gold.commit_consumption_cpq_monthly
WHERE account_id = '{account_id}'
  AND is_contract_cancelled_ind = false
ORDER BY contract_rank, usage_month
"""


def query_contract_health(account: str, host: str = "", token: str = "", warehouse_id: str = "") -> list[dict]:
    """
    Query contract burn curve data from main.gtm_gold.commit_consumption_cpq_monthly.
    Returns monthly rows with cumulative actuals vs. commit amount.
    """
    w = _get_client(host, token)
    wh_id = warehouse_id if warehouse_id else "071969b1ec9a91ca"

    sql = CONTRACT_HEALTH_SQL.format(account_id=account.strip())

    result = w.statement_execution.execute_statement(
        warehouse_id=wh_id,
        statement=sql,
        wait_timeout="30s",
    )

    if result.status and result.status.state and result.status.state.value in ("PENDING", "RUNNING"):
        import time as _time
        stmt_id = result.statement_id
        for _ in range(6):  # max 30s additional poll
            _time.sleep(5)
            result = w.statement_execution.get_statement(stmt_id)
            if result.status.state.value in ("SUCCEEDED", "FAILED", "CANCELED", "CLOSED"):
                break

    if result.status and result.status.state and result.status.state.value != "SUCCEEDED":
        raise RuntimeError(f"Query {result.status.state.value}: {getattr(result.status.error, 'message', '')}")

    if not result.result or not result.result.data_array:
        return []

    columns = [col.name for col in result.manifest.schema.columns]
    rows = []
    numeric_cols = {"commit_amount_usd", "monthly_actual", "cumulative_actual", "remaining_commit", "burn_pct"}
    for row_data in result.result.data_array:
        row = {}
        for i, col_name in enumerate(columns):
            val = row_data[i]
            if col_name in numeric_cols and val is not None:
                val = float(val)
            row[col_name] = val
        rows.append(row)

    return rows


UCO_SQL = """
SELECT
    u.Id,
    u.Name,
    u.Stages__c          AS stage,
    u.DemandPlanStage__c AS demand_plan_stage,
    u.MonthlyTotalDollarDBUs__c AS monthly_dollar,
    u.T_Shirt_Size_Estimate__c  AS t_shirt_size,
    u.Solution_Architect__c     AS solution_architect,
    u.Go_Live_Date__c           AS go_live_date,
    u.Business_Use_Case__c      AS business_use_case,
    u.Use_Case_Area__c          AS use_case_area,
    u.Status__c                 AS status,
    u.OnboardingDate__c         AS onboarding_date
FROM main.sfdc_bronze.usecase__c u
JOIN main.sfdc_bronze.account a ON u.Account__c = a.Id
WHERE a.Name ILIKE '%{account_name}%'
  AND u.Stages__c IN ('U1','U2','U3','U4')
  AND u.Active__c = 'true'
  AND u.processDate >= current_date() - INTERVAL 7 DAYS
GROUP BY ALL
ORDER BY u.Stages__c, u.Name
"""


def query_logfood_use_cases(account: str, host: str = "", token: str = "", warehouse_id: str = "") -> list[dict]:
    """
    Query Salesforce UCOs (U1–U4) for an account from main.sfdc_bronze.usecase__c.
    account can be an account name or SFDC account ID (looked up via account table).
    Returns list of dicts with UCO details.
    """
    w = _get_client(host, token)
    wh_id = warehouse_id if warehouse_id else "071969b1ec9a91ca"

    # If it looks like an SFDC ID, resolve the account name first
    account_name = account.strip()
    if len(account_name) in (15, 18) and account_name[:3] == '001':
        resolve_sql = f"SELECT Name FROM main.sfdc_bronze.account WHERE Id = '{account_name}' AND processDate >= current_date() - INTERVAL 7 DAYS LIMIT 1"
        r = w.statement_execution.execute_statement(warehouse_id=wh_id, statement=resolve_sql, wait_timeout="30s")
        if r.result and r.result.data_array:
            account_name = r.result.data_array[0][0]

    sql = UCO_SQL.format(account_name=account_name.replace("'", "''"))

    result = w.statement_execution.execute_statement(
        warehouse_id=wh_id,
        statement=sql,
        wait_timeout="50s",
    )

    if result.status and result.status.state and result.status.state.value in ("PENDING", "RUNNING"):
        import time as _time
        stmt_id = result.statement_id
        for _ in range(24):
            _time.sleep(5)
            result = w.statement_execution.get_statement(stmt_id)
            if result.status.state.value in ("SUCCEEDED", "FAILED", "CANCELED", "CLOSED"):
                break

    if not result.result or not result.result.data_array:
        return []

    columns = [col.name for col in result.manifest.schema.columns]
    rows = []
    for row_data in result.result.data_array:
        row = dict(zip(columns, row_data))
        if row.get("monthly_dollar") is not None:
            row["monthly_dollar"] = float(row["monthly_dollar"])
        rows.append(row)
    return rows


def search_accounts(query: str, host: str, token: str, warehouse_id: str) -> list[dict]:
    """
    Search for accounts by name or ID (last 90 days).
    Returns list of dicts with keys: sfdc_account_name, sfdc_account_id
    """
    w = _get_client(host, token)
    query = query.strip()

    sql = f"""
SELECT DISTINCT sfdc_account_name, sfdc_account_id
FROM main.fin_live_gold.paid_usage_metering
WHERE date >= date_add(current_date(), -90)
  AND (sfdc_account_name ILIKE '%{query}%' OR sfdc_account_id ILIKE '%{query}%')
ORDER BY sfdc_account_name
LIMIT 50
"""

    result = w.statement_execution.execute_statement(
        warehouse_id=warehouse_id,
        statement=sql,
        wait_timeout="50s",
    )

    if result.status and result.status.state and result.status.state.value in ("PENDING", "RUNNING"):
        import time as _time
        stmt_id = result.statement_id
        for _ in range(60):
            _time.sleep(5)
            result = w.statement_execution.get_statement(stmt_id)
            if result.status.state.value in ("SUCCEEDED", "FAILED", "CANCELED", "CLOSED"):
                break

    if not result.result or not result.result.data_array:
        return []

    columns = [col.name for col in result.manifest.schema.columns]
    rows = []
    for row_data in result.result.data_array:
        row = {col_name: row_data[i] for i, col_name in enumerate(columns)}
        rows.append(row)

    return rows
