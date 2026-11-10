"""Google Flow accounts connected through Chrome profiles (see account_pool.py)."""
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from flowboard.services.flow_client import account_pool

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


@router.get("")
def list_accounts() -> dict:
    return account_pool.snapshot()


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
