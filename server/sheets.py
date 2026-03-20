"""Google Sheets reader for domain mapping."""

import os
import re
import json
import subprocess
import httpx
from pathlib import Path
from typing import Optional


_TOKEN_PATH = Path.home() / ".demand-plan-app" / "google_tokens.json"


def get_stored_google_token() -> dict | None:
    """Return stored tokens dict or None."""
    if _TOKEN_PATH.exists():
        try:
            with open(_TOKEN_PATH) as f:
                return json.load(f)
        except Exception:
            return None
    return None


def clear_google_tokens():
    """Delete ~/.demand-plan-app/google_tokens.json"""
    if _TOKEN_PATH.exists():
        _TOKEN_PATH.unlink()


def get_google_token() -> str:
    """Get Google auth token. Tries stored refresh token first, then falls back to gcloud."""
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")

    # 1. Try stored refresh token
    stored = get_stored_google_token()
    if stored and stored.get("refresh_token") and client_id and client_secret:
        try:
            resp = httpx.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "grant_type": "refresh_token",
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "refresh_token": stored["refresh_token"],
                },
                timeout=30,
            )
            if resp.status_code == 200:
                data = resp.json()
                access_token = data.get("access_token")
                if access_token:
                    return access_token
        except Exception:
            pass

    # 2. Fall back to gcloud
    result = subprocess.run(
        ["gcloud", "auth", "print-access-token"],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()

    raise RuntimeError(
        "Could not obtain Google auth token. "
        "Either set up OAuth tokens via the device flow or run "
        "'gcloud auth login --enable-gdrive-access' first."
    )


async def start_device_flow() -> dict:
    """Start Google OAuth 2.0 device flow. Returns {device_code, user_code, verification_url, expires_in, interval}"""
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/device/code",
            data={
                "client_id": client_id,
                "scope": "https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly",
            },
        )
        resp.raise_for_status()
        return resp.json()


async def poll_device_flow(device_code: str) -> dict:
    """Poll for device flow completion. Returns {status: 'pending'|'authorized'|'expired'|'error'} — when authorized also returns access_token, refresh_token"""
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "client_id": client_id,
                "client_secret": client_secret,
                "device_code": device_code,
            },
        )
        data = resp.json()

    if "access_token" in data:
        # Save tokens to disk
        _TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(_TOKEN_PATH, "w") as f:
            json.dump(data, f)
        return {
            "status": "authorized",
            "access_token": data["access_token"],
            "refresh_token": data.get("refresh_token"),
        }

    error = data.get("error", "")
    if error == "authorization_pending":
        return {"status": "pending"}
    if error == "expired_token":
        return {"status": "expired"}
    return {"status": "error", "detail": data}


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
            "domain": domain or "Untagged",
        }
        if "account_name" in col_map and col_map["account_name"] < len(row):
            entry["account_name"] = row[col_map["account_name"]].strip()
        if "cloudtype" in col_map and col_map["cloudtype"] < len(row):
            entry["cloudtype"] = row[col_map["cloudtype"]].strip()
        if "org" in col_map and col_map["org"] < len(row):
            entry["org"] = row[col_map["org"]].strip()

        results.append(entry)

    return results
