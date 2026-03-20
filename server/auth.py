"""Authentication — PAT validation + JWT session management."""

import os
import time
from pathlib import Path

import requests as _req
from fastapi import Depends, HTTPException, Request, Response
from jose import JWTError, jwt

JWT_SECRET = os.environ.get(
    "JWT_SECRET", "demand-plan-dev-secret-change-in-prod-0000"
)
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_SECONDS = 8 * 3600   # 8 hours
COOKIE_NAME = "dp_session"

DEFAULT_HOST = "https://adb-2548836972759138.18.azuredatabricks.net"
DEMO_TOKEN = "demo"


# ---------------------------------------------------------------------------
# PAT validation
# ---------------------------------------------------------------------------

def validate_pat_get_username(host: str, pat: str, demo_email: str | None = None) -> str:
    """Call Databricks SCIM /Me endpoint with the PAT.
    Returns the userName (email) of the authenticated user.
    If pat == DEMO_TOKEN, skip SCIM and return the provided demo_email.
    Raises HTTPException 401 if invalid.
    """
    if pat == DEMO_TOKEN:
        if not demo_email or "@" not in demo_email:
            raise HTTPException(status_code=401, detail="A valid email is required for demo access")
        return demo_email.strip().lower()

    host = host.rstrip("/")
    try:
        r = _req.get(
            f"{host}/api/2.0/preview/scim/v2/Me",
            headers={"Authorization": f"Bearer {pat}"},
            timeout=10,
        )
        if r.status_code == 401:
            raise HTTPException(status_code=401, detail="Invalid PAT — Unauthorized")
        if not r.ok:
            raise HTTPException(
                status_code=401,
                detail=f"PAT validation failed: HTTP {r.status_code}",
            )
        data = r.json()
        username = data.get("userName") or data.get("displayName") or ""
        if not username:
            raise HTTPException(
                status_code=401, detail="Could not determine user identity from PAT"
            )
        return username
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Connection failed: {e}")


# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------

def create_session_token(username: str, host: str, pat: str) -> str:
    payload = {
        "sub": username,
        "host": host,
        "pat": pat,
        "exp": int(time.time()) + JWT_EXPIRY_SECONDS,
        "iat": int(time.time()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_session_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired session")


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

def get_current_user(request: Request) -> dict:
    """Inject authenticated user into route handlers.
    Returns dict with keys: sub (username), host, pat.
    """
    session = request.cookies.get(COOKIE_NAME)
    if not session:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return decode_session_token(session)


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=JWT_EXPIRY_SECONDS,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=COOKIE_NAME, path="/")


# ---------------------------------------------------------------------------
# Per-user data directory
# ---------------------------------------------------------------------------

def safe_username(username: str) -> str:
    """Make username safe for use as a directory name."""
    return username.replace("@", "_at_").replace("/", "_").replace("\\", "_")


def get_user_data_dir(username: str, base: Path) -> Path:
    """Returns (and creates) server/data/{safe_username}/"""
    d = base / safe_username(username)
    d.mkdir(parents=True, exist_ok=True)
    return d
