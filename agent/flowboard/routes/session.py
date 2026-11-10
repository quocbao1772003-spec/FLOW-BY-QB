"""Login, logout, current user, password change and personal tokens."""
from __future__ import annotations

import time
from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from flowboard.db import get_session
from flowboard.db.models import User
from flowboard.services import users as svc

router = APIRouter(prefix="/api/session", tags=["session"])

# Simple brute-force brake: 8 failed logins per username+IP per 10 minutes.
_fails: dict[str, list[float]] = defaultdict(list)
_WINDOW_S = 600
_MAX_FAILS = 8


def _client_ip(request: Request) -> str:
    return (request.headers.get("cf-connecting-ip")
            or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
            or (request.client.host if request.client else "?"))


def _cookie_secure(request: Request) -> bool:
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    return proto == "https"


@router.get("")
def me(request: Request) -> dict:
    enabled = svc.auth_enabled()
    user = svc.get_user(svc.current_user_id.get()) if enabled else None
    return {
        "auth_required": enabled,
        "user": svc.public_user(user) if user else None,
    }


class LoginBody(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginBody, request: Request, response: Response) -> dict:
    key = f"{svc.normalize_username(body.username)}|{_client_ip(request)}"
    now = time.time()
    _fails[key] = [t for t in _fails[key] if now - t < _WINDOW_S]
    if len(_fails[key]) >= _MAX_FAILS:
        raise HTTPException(429, "Sai quá nhiều lần, thử lại sau 10 phút")
    res = svc.login(body.username, body.password, request.headers.get("user-agent", ""))
    if res is None:
        _fails[key].append(now)
        raise HTTPException(401, "Sai tên đăng nhập hoặc mật khẩu")
    _fails.pop(key, None)
    token, user = res
    response.set_cookie(
        svc.SESSION_COOKIE, token, max_age=svc.SESSION_DAYS * 86400,
        httponly=True, samesite="lax", secure=_cookie_secure(request), path="/",
    )
    return {"auth_required": True, "user": svc.public_user(user)}


@router.post("/logout")
def logout(request: Request, response: Response) -> dict:
    svc.logout(request.cookies.get(svc.SESSION_COOKIE))
    response.delete_cookie(svc.SESSION_COOKIE, path="/")
    return {"ok": True}


class PasswordBody(BaseModel):
    current_password: str
    new_password: str


@router.post("/password")
def change_password(body: PasswordBody) -> dict:
    uid = svc.current_user_id.get()
    if uid is None:
        raise HTTPException(400, "Chưa bật đăng nhập")
    with get_session() as s:
        u = s.get(User, uid)
        if u is None or not svc.verify_password(body.current_password, u.password_hash):
            raise HTTPException(400, "Mật khẩu hiện tại không đúng")
        if len(body.new_password) < 6:
            raise HTTPException(400, "Mật khẩu mới tối thiểu 6 ký tự")
        u.password_hash = svc.hash_password(body.new_password)
        s.add(u)
        s.commit()
    return {"ok": True}


# ── personal tokens: Chrome extension pairing codes and API tokens ──────


class TokenBody(BaseModel):
    kind: str = "bridge"  # bridge | api
    label: Optional[str] = ""


def _need_user() -> int:
    uid = svc.current_user_id.get()
    if uid is None:
        raise HTTPException(400, "Chưa bật đăng nhập: tạo tài khoản admin trước")
    return uid


@router.get("/tokens")
def my_tokens() -> list[dict]:
    return svc.list_tokens(_need_user())


@router.post("/tokens")
def new_token(body: TokenBody) -> dict:
    if body.kind not in ("bridge", "api"):
        raise HTTPException(400, "kind phải là bridge hoặc api")
    token, row = svc.create_token(_need_user(), body.kind, body.label or "")
    return {"token": token, "id": row.id, "kind": row.kind, "label": row.label, "hint": row.hint}


@router.delete("/tokens/{token_id}")
def drop_token(token_id: int) -> dict:
    if not svc.revoke_token(token_id, _need_user()):
        raise HTTPException(404, "Không thấy mã")
    return {"ok": True}
