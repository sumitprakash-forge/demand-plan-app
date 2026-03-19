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
