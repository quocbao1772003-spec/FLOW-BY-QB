"""Google Flow accounts connected through Chrome profiles (see account_pool.py)."""
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from flowboard.services.flow_client import account_pool

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


def _extension_dir() -> str:
    from flowboard.config import ROOT

    return str(ROOT / "extension")


_GEN_TYPES = {"gen_image", "edit_image", "gen_video", "gen_video_omni"}


def _usage_today() -> dict[str, dict]:
    """Per account: generation jobs finished since local midnight."""
    from datetime import datetime, timezone

    from sqlmodel import select

    from flowboard.db import get_session
    from flowboard.db.models import Request

    start = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    out: dict[str, dict] = {}
    with get_session() as s:
        rows = s.exec(select(Request).order_by(Request.id.desc()).limit(3000)).all()
    for r in rows:
        if r.type not in _GEN_TYPES:
            continue
        created = r.created_at
        if created is not None:
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            if created < start:
                continue
        res = r.result or {}
        acct = res.get("flow_account")
        if not acct:
            continue
        u = out.setdefault(acct, {"jobs": 0, "done": 0, "failed": 0, "media": 0, "switched_away": 0})
        u["jobs"] += 1
        if r.status == "done":
            u["done"] += 1
            u["media"] += len([m for m in (res.get("media_ids") or []) if m])
        elif r.status in ("failed", "timeout"):
            u["failed"] += 1
        for sw in res.get("account_switches") or []:
            src = sw.get("from")
            if src:
                out.setdefault(src, {"jobs": 0, "done": 0, "failed": 0, "media": 0, "switched_away": 0})
                out[src]["switched_away"] += 1
    return out


@router.get("")
def list_accounts() -> dict:
    snap = account_pool.snapshot()
    try:
        usage = _usage_today()
    except Exception:  # noqa: BLE001
        usage = {}
    for a in snap["accounts"]:
        a["today"] = usage.get(a["key"], {"jobs": 0, "done": 0, "failed": 0, "media": 0, "switched_away": 0})
    return {**snap, "extension_dir": _extension_dir()}


class SelectBody(BaseModel):
    key: Optional[str] = None  # email; null = automatic


@router.post("/select")
def select_account(body: SelectBody) -> dict:
    if body.key:
        known = {r["key"] for r in account_pool.snapshot()["accounts"]}
        if body.key.lower() not in known:
            raise HTTPException(404, "account not connected")
    account_pool.select(body.key)
    return account_pool.snapshot()


class SettingsBody(BaseModel):
    auto_rotate: bool


@router.post("/settings")
def update_settings(body: SettingsBody) -> dict:
    account_pool.set_auto_rotate(body.auto_rotate)
    return account_pool.snapshot()


class ResetBody(BaseModel):
    key: Optional[str] = None  # null = every account


@router.post("/reset")
def reset_quota(body: ResetBody) -> dict:
    """Forget the "out of quota" mark (e.g. after buying more credits)."""
    account_pool.clear_exhausted(body.key)
    return account_pool.snapshot()


class OrderBody(BaseModel):
    keys: list[str]


@router.post("/order")
def set_order(body: OrderBody) -> dict:
    account_pool.set_order(body.keys)
    return account_pool.snapshot()


@router.post("/scan")
async def scan_accounts() -> dict:
    """Ask profiles with an unknown Google account to read it again."""
    asked = await account_pool.ask_identities()
    return {**account_pool.snapshot(), "asked": asked}
