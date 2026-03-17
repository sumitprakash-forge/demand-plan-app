"""Google Sheets reader for domain mapping."""

import os
import re
import subprocess
import httpx
from typing import Optional


def get_google_token() -> str:
    """Get Google auth token using gcloud or the Claude plugin auth helper."""
    # Try Claude plugin auth helper first
    plugin_base = os.path.expanduser("~/.claude/plugins/cache/fe-vibe/fe-google-tools")
    if os.path.isdir(plugin_base):
        for entry in os.listdir(plugin_base):
            auth_script = os.path.join(plugin_base, entry, "skills", "google-auth", "resources", "google_auth.py")
            if os.path.isfile(auth_script):
                result = subprocess.run(
                    ["python3", auth_script, "token"],
                    capture_output=True, text=True, timeout=30,
                )
                if result.returncode == 0 and result.stdout.strip():
                    return result.stdout.strip()

    # Fallback to gcloud
    result = subprocess.run(
        ["gcloud", "auth", "print-access-token"],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()

    raise RuntimeError("Could not obtain Google auth token. Run 'gcloud auth login' first.")


def extract_sheet_id(url: str) -> str:
    """Extract spreadsheet ID from a Google Sheets URL."""
    m = re.search(r"/spreadsheets/d/([a-zA-Z0-9_-]+)", url)
    if not m:
        raise ValueError(f"Cannot extract sheet ID from URL: {url}")
    return m.group(1)


async def fetch_domain_mapping(sheet_url: str) -> list[dict]:
    """
    Fetch domain mapping from Google Sheets.
    Supports two formats:
    - New: account_name | cloudtype | org | sfdc_workspace_name | Domain
    - Legacy: sfdc_workspace_name | Domain
    Returns list of {workspace, domain, account_name, cloudtype, org}.
    """
    sheet_id = extract_sheet_id(sheet_url)
    token = get_google_token()

    # Read all columns from first sheet
    api_url = (
        f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}"
        f"/values/A:Z?majorDimension=ROWS"
    )
    headers = {
        "Authorization": f"Bearer {token}",
        "x-goog-user-project": "gcp-sandbox-field-eng",
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(api_url, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    rows = data.get("values", [])
    if not rows:
        return []

    # Detect header format
    header = [h.strip().lower() for h in rows[0]]
    results = []

    # Map column indices
    col_map = {}
    for i, h in enumerate(header):
        if h in ("sfdc_workspace_name", "workspacename", "workspace_name", "workspace"):
            col_map["workspace"] = i
        elif h == "domain":
            col_map["domain"] = i
        elif h in ("account_name", "salesforce_account_name"):
            col_map["account_name"] = i
        elif h in ("cloudtype", "cloud_type", "cloud"):
            col_map["cloudtype"] = i
        elif h == "org":
            col_map["org"] = i

    ws_col = col_map.get("workspace")
    dom_col = col_map.get("domain")

    if ws_col is None or dom_col is None:
        # Fallback: assume first two columns are workspace, domain
        ws_col = 0
        dom_col = 1

    for row in rows[1:]:
        if len(row) <= max(ws_col, dom_col):
            continue
        ws = row[ws_col].strip() if ws_col < len(row) else ""
        domain = row[dom_col].strip() if dom_col < len(row) else ""
        if not ws:
            continue

        entry = {
            "workspace": ws,
            "domain": domain or "Unmapped",
        }
        if "account_name" in col_map and col_map["account_name"] < len(row):
            entry["account_name"] = row[col_map["account_name"]].strip()
        if "cloudtype" in col_map and col_map["cloudtype"] < len(row):
            entry["cloudtype"] = row[col_map["cloudtype"]].strip()
        if "org" in col_map and col_map["org"] < len(row):
            entry["org"] = row[col_map["org"]].strip()

        results.append(entry)

    return results
