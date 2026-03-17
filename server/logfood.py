"""Logfood (Databricks) query helper for consumption data."""

import time
from typing import Optional


SKU_PRICES_SQL = """
SELECT DISTINCT sku, cloud, CAST(list_price AS DOUBLE) as list_price
FROM main.fin_live_gold.paid_usage_metering
WHERE sfdc_account_name = '{account}'
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
WHERE sfdc_account_name = '{account}'
    AND date >= date_add(current_date(), -365)
GROUP BY sfdc_workspace_name, cloud, date_format(date, 'yyyy-MM'), sku
ORDER BY month, sfdc_workspace_name
"""


def query_consumption(account: str = "Walmart") -> list[dict]:
    """
    Query Logfood for trailing 12 months consumption.
    Uses Databricks SDK with profile 'logfood'.
    Returns list of dicts with keys: workspace_name, month, sku_name, total_dbus, dollar_dbu_list
    """
    from databricks.sdk import WorkspaceClient

    w = WorkspaceClient(profile="logfood")

    # Find a running SQL warehouse — prefer the shared endpoint
    warehouse_id = "071969b1ec9a91ca"  # Shared SQL Endpoint - Cutting Edge
    try:
        warehouses = list(w.warehouses.list())
        for wh in warehouses:
            if wh.state and wh.state.value == "RUNNING":
                warehouse_id = wh.id
                break
    except Exception:
        pass  # use default

    sql = CONSUMPTION_SQL.format(account=account)

    result = w.statement_execution.execute_statement(
        warehouse_id=warehouse_id,
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


def query_sku_prices(account: str = "Walmart") -> list[dict]:
    """
    Query Logfood for distinct SKU + cloud + list_price (last 90 days).
    Returns list of dicts with keys: sku, cloud, list_price
    """
    from databricks.sdk import WorkspaceClient

    w = WorkspaceClient(profile="logfood")

    warehouse_id = "071969b1ec9a91ca"
    try:
        warehouses = list(w.warehouses.list())
        for wh in warehouses:
            if wh.state and wh.state.value == "RUNNING":
                warehouse_id = wh.id
                break
    except Exception:
        pass

    sql = SKU_PRICES_SQL.format(account=account)

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
        row = {}
        for i, col_name in enumerate(columns):
            val = row_data[i]
            if col_name == "list_price" and val is not None:
                val = float(val)
            row[col_name] = val
        rows.append(row)

    return rows
