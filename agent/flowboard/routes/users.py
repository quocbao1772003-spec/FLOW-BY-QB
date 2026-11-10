"""Admin: manage Flowboard user accounts."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import User
from flowboard.services import users as svc
from flowboard.services.flow_client import account_pool

router = APIRouter(prefix="/api/users", tags=["users"])


def _admin() -> User:
    uid = svc.current_user_id.get()
    u = svc.get_user(uid)
    if u is None or u.role != "admin":
        raise HTTPException(403, "Chỉ admin")
    return u


def _accounts_by_user() -> dict[int, list[dict]]:
    out: dict[int, list[dict]] = {}
    for a in account_pool.snapshot(all_users=True)["accounts"]:
        if a.get("owner_user_id") is not None:
            out.setdefault(a["owner_user_id"], []).append(
                {"email": a["email"] or a["key"], "connected": a["connected"], "exhausted": a["exhausted"]})
    return out


@router.get("")
def list_users() -> list[dict]:
    _admin()
    accts = _accounts_by_user()
    tokens = svc.list_tokens()
    with get_session() as s:
        rows = s.exec(select(User).order_by(User.created_at)).all()
    out = []
    for u in rows:
        d = svc.public_user(u)
        d["flow_accounts"] = accts.get(u.id, [])
        d["paired_profiles"] = len([t for t in tokens if t["user_id"] == u.id and t["kind"] == "bridge"])
        out.append(d)
    return out


class CreateBody(BaseModel):
    username: str
    display_name: Optional[str] = ""
    password: Optional[str] = None  # empty → generated
    role: str = "staff"


def _local_request(request: Request) -> bool:
    host = request.client.host if request.client else ""
    proxied = any(h in request.headers for h in ("cf-connecting-ip", "x-forwarded-for", "cf-ray"))
    return host in ("127.0.0.1", "::1", "localhost") and not proxied


@router.post("")
def create(body: CreateBody, request: Request) -> dict:
    if not svc.auth_enabled():
        # First account: only from this computer (never through a tunnel),
        # and it is always the admin. It switches login on.
        if not _local_request(request):
            raise HTTPException(403, "Tạo admin đầu tiên trên máy chạy Flowboard hoặc bằng biến môi trường")
        body.role = "admin"
        if not body.password or len(body.password) < 6:
            raise HTTPException(400, "Đặt mật khẩu cho admin (tối thiểu 6 ký tự)")
    else:
        _admin()
    password = body.password or svc.generate_password()
    try:
        u = svc.create_user(body.username, password, body.role, body.display_name or "")
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"user": svc.public_user(u), "password": password}


class PatchBody(BaseModel):
    display_name: Optional[str] = None
    role: Optional[str] = None
    disabled: Optional[bool] = None
    reset_password: Optional[bool] = None
    password: Optional[str] = None


@router.patch("/{user_id}")
def update(user_id: int, body: PatchBody) -> dict:
    me = _admin()
    new_password = None
    with get_session() as s:
        u = s.get(User, user_id)
        if u is None:
            raise HTTPException(404, "Không thấy nhân viên")
        if body.display_name is not None:
            u.display_name = body.display_name.strip() or u.username
        if body.role is not None:
            if body.role not in ("admin", "staff"):
                raise HTTPException(400, "role phải là admin hoặc staff")
            if u.id == me.id and body.role != "admin":
                raise HTTPException(400, "Không tự bỏ quyền admin của chính mình")
            u.role = body.role
        if body.disabled is not None:
            if u.id == me.id and body.disabled:
                raise HTTPException(400, "Không tự khoá chính mình")
            u.disabled = body.disabled
        if body.reset_password or body.password:
            new_password = body.password or svc.generate_password()
            if len(new_password) < 6:
                raise HTTPException(400, "Mật khẩu tối thiểu 6 ký tự")
            u.password_hash = svc.hash_password(new_password)
        s.add(u)
        s.commit()
        s.refresh(u)
        result = svc.public_user(u)
    if body.disabled or new_password:
        svc.drop_sessions(user_id)
    return {"user": result, "password": new_password}
