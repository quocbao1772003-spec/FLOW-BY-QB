"""Flowboard user accounts, sessions and access tokens.

Login is OFF while the user table is empty (the original single-user local
app). Creating the first admin — ``python -m flowboard.manage create-admin``
or the FLOWBOARD_ADMIN_USER / FLOWBOARD_ADMIN_PASSWORD env vars at startup —
turns it on for every API, the media files and the extension bridge.

Passwords: PBKDF2-SHA256 with a per-user salt. Session cookies, pairing codes
and API tokens are random secrets stored only as SHA-256 hashes.
"""
from __future__ import annotations

import contextvars
import hashlib
import hmac
import logging
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import AccessToken, User, UserSession

logger = logging.getLogger(__name__)

SESSION_COOKIE = "fb_session"
SESSION_DAYS = 30
_PBKDF2_ROUNDS = 240_000

# The Flowboard user a request / job acts for (None = open local mode).
current_user_id: contextvars.ContextVar[Optional[int]] = contextvars.ContextVar(
    "flowboard_current_user", default=None
)

_auth_cache: dict[str, float] = {"checked_at": 0.0, "enabled": 0.0}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


# ── passwords ─────────────────────────────────────────────────────────────


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), _PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${_PBKDF2_ROUNDS}${salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, rounds, salt, digest = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), int(rounds))
        return hmac.compare_digest(dk.hex(), digest)
    except Exception:  # noqa: BLE001
        return False


def generate_password(n: int = 12) -> str:
    alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(n))


# ── users ─────────────────────────────────────────────────────────────────


def auth_enabled() -> bool:
    """True once at least one user exists. Cached for a few seconds."""
    now = time.monotonic()
    if now - _auth_cache["checked_at"] < 3.0:
        return bool(_auth_cache["enabled"])
    with get_session() as s:
        enabled = s.exec(select(User.id).limit(1)).first() is not None
    _auth_cache.update(checked_at=now, enabled=1.0 if enabled else 0.0)
    return enabled


def _invalidate_cache() -> None:
    _auth_cache["checked_at"] = 0.0


def public_user(u: User) -> dict:
    return {
        "id": u.id,
        "username": u.username,
        "display_name": u.display_name or u.username,
        "role": u.role,
        "disabled": u.disabled,
        "created_at": u.created_at,
        "last_login_at": u.last_login_at,
    }


def normalize_username(name: str) -> str:
    return (name or "").strip().lower()


def create_user(username: str, password: str, role: str = "staff", display_name: str = "") -> User:
    username = normalize_username(username)
    if not username or len(username) > 64:
        raise ValueError("Tên đăng nhập không hợp lệ")
    if len(password) < 6:
        raise ValueError("Mật khẩu tối thiểu 6 ký tự")
    if role not in ("admin", "staff"):
        raise ValueError("role phải là admin hoặc staff")
    with get_session() as s:
        if s.exec(select(User).where(User.username == username)).first():
            raise ValueError("Tên đăng nhập đã tồn tại")
        u = User(username=username, password_hash=hash_password(password), role=role,
                 display_name=display_name.strip() or username)
        s.add(u)
        s.commit()
        s.refresh(u)
    _invalidate_cache()
    return u


def get_user(user_id: Optional[int]) -> Optional[User]:
    if user_id is None:
        return None
    with get_session() as s:
        return s.get(User, user_id)


def ensure_bootstrap_admin() -> None:
    """Create the admin from env vars on first start (Docker deploys)."""
    user = os.getenv("FLOWBOARD_ADMIN_USER")
    pwd = os.getenv("FLOWBOARD_ADMIN_PASSWORD")
    if not user or not pwd:
        return
    with get_session() as s:
        if s.exec(select(User.id).limit(1)).first() is not None:
            return
    create_user(user, pwd, role="admin", display_name=user)
    logger.info("bootstrap admin %r created from environment", user)


# ── sessions ──────────────────────────────────────────────────────────────


def login(username: str, password: str, user_agent: str = "") -> Optional[tuple[str, User]]:
    username = normalize_username(username)
    with get_session() as s:
        u = s.exec(select(User).where(User.username == username)).first()
        if u is None or u.disabled or not verify_password(password, u.password_hash):
            return None
        token = secrets.token_urlsafe(32)
        s.add(UserSession(token_hash=_sha(token), user_id=u.id,
                          expires_at=_now() + timedelta(days=SESSION_DAYS),
                          user_agent=user_agent[:200]))
        u.last_login_at = _now()
        s.add(u)
        s.commit()
        s.refresh(u)
        return token, u


def logout(token: Optional[str]) -> None:
    if not token:
        return
    with get_session() as s:
        row = s.get(UserSession, _sha(token))
        if row:
            s.delete(row)
            s.commit()


def user_for_session(token: Optional[str]) -> Optional[User]:
    if not token:
        return None
    with get_session() as s:
        row = s.get(UserSession, _sha(token))
        if row is None:
            return None
        if _aware(row.expires_at) < _now():
            s.delete(row)
            s.commit()
            return None
        u = s.get(User, row.user_id)
        if u is None or u.disabled:
            return None
        return u


def drop_sessions(user_id: int) -> None:
    with get_session() as s:
        for row in s.exec(select(UserSession).where(UserSession.user_id == user_id)).all():
            s.delete(row)
        s.commit()


# ── access tokens (extension pairing codes, API tokens) ───────────────────


def create_token(user_id: int, kind: str, label: str = "") -> tuple[str, AccessToken]:
    prefix = "fbp_" if kind == "bridge" else "fbt_"
    token = prefix + secrets.token_urlsafe(24)
    with get_session() as s:
        row = AccessToken(user_id=user_id, kind=kind, label=label.strip()[:80],
                          token_hash=_sha(token), hint=token[:8])
        s.add(row)
        s.commit()
        s.refresh(row)
    return token, row


def user_for_token(token: Optional[str], kind: Optional[str] = None) -> Optional[User]:
    if not token:
        return None
    with get_session() as s:
        row = s.exec(select(AccessToken).where(AccessToken.token_hash == _sha(token.strip()))).first()
        if row is None or row.revoked or (kind and row.kind != kind):
            return None
        u = s.get(User, row.user_id)
        if u is None or u.disabled:
            return None
        row.last_used_at = _now()
        s.add(row)
        s.commit()
        s.refresh(u)
        return u


def list_tokens(user_id: Optional[int] = None) -> list[dict]:
    with get_session() as s:
        q = select(AccessToken).where(AccessToken.revoked == False)  # noqa: E712
        if user_id is not None:
            q = q.where(AccessToken.user_id == user_id)
        rows = s.exec(q.order_by(AccessToken.created_at.desc())).all()
        return [
            {"id": r.id, "user_id": r.user_id, "kind": r.kind, "label": r.label, "hint": r.hint,
             "created_at": r.created_at, "last_used_at": r.last_used_at}
            for r in rows
        ]


def revoke_token(token_id: int, user_id: Optional[int]) -> bool:
    with get_session() as s:
        row = s.get(AccessToken, token_id)
        if row is None or (user_id is not None and row.user_id != user_id):
            return False
        row.revoked = True
        s.add(row)
        s.commit()
        return True
