"""Many Google Flow accounts at once, with automatic switching.

Each Chrome profile that runs the Flowboard Bridge extension is one Google
Flow account. Before this module the agent accepted exactly one profile and
refused the rest; now every profile connects and is kept as its own
``FlowClient`` (one bridge = one account), and the pool decides which one a
call goes through:

1. a pin set for the current job (``pool.pin(client)``) — a generation job
   stays on one account from project creation to the last poll;
2. the account the user selected, if it is connected and not out of quota;
3. otherwise the first connected account that still has quota (in the
   user's saved order), then any connected account.

When a job fails with the daily-quota error (the extension only reports it
after it has already tried every image model on that account) the worker
calls ``mark_exhausted`` and re-runs the job on ``next_account``.

The module-level ``flow_client`` (see flow_client.py) is a proxy that forwards
everything to ``pool.current()``, so existing code keeps working unchanged.

Persistent bits (selected account, auto-rotate switch, saved order, quota
state) live in ``storage/accounts.json``. No tokens or passwords are stored:
each account stays signed in inside its own Chrome profile.
"""
from __future__ import annotations

import contextlib
import contextvars
import json
import logging
import threading
import time
from datetime import datetime, timedelta
from typing import Any, Iterator, Optional

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

# A spent account is re-tried after this long even before the daily reset —
# a refusal costs nothing, and Google's reset time isn't documented.
RECHECK_AFTER_S = 30 * 60
# Google Flow's daily quota appears to roll over at midnight Pacific time.
_RESET_TZ = "America/Los_Angeles"


def _next_reset(now: Optional[float] = None) -> float:
    now = time.time() if now is None else now
    try:
        tz = ZoneInfo(_RESET_TZ) if ZoneInfo else None
    except Exception:  # noqa: BLE001
        tz = None
    if tz is None:
        return now + 24 * 3600
    local = datetime.fromtimestamp(now, tz)
    midnight = (local + timedelta(days=1)).replace(hour=0, minute=5, second=0, microsecond=0)
    return midnight.timestamp()


def is_quota_error(err: Any) -> bool:
    s = str(err or "").upper()
    return "QUOTA" in s or "RESOURCE_EXHAUSTED" in s


class AccountPool:
    def __init__(self, state_path=None) -> None:
        from flowboard.services.flow_client import FlowClient

        self._FlowClient = FlowClient
        self._lock = threading.RLock()
        # instance_id -> FlowClient (kept after disconnect so a reconnect of
        # the same profile resumes, and so its label stays in the list)
        self._clients: dict[str, Any] = {}
        self._connected_order: list[str] = []
        # Used when nothing is connected; keeps the old single-client
        # behaviour (tests poke attributes on it through the proxy).
        self._idle = FlowClient()
        self._pinned: contextvars.ContextVar[Optional[Any]] = contextvars.ContextVar(
            "flowboard_pinned_account", default=None
        )
        self._state_path = state_path
        self._state: dict[str, Any] = {
            "auto_rotate": True,
            "selected": None,        # account key the user picked
            "order": [],             # account keys in preferred order
            "exhausted": {},         # key -> {"at": ts, "until": ts, "reason": str}
            "labels": {},            # instance_id -> last known email
            "primary": None,         # first account ever seen (owns legacy projects)
            "events": [],            # recent automatic switches, newest last
        }
        self._load()

    # ── persistence ───────────────────────────────────────────────────────
    def _path(self):
        if self._state_path is not None:
            return self._state_path
        from flowboard.config import STORAGE_DIR

        return STORAGE_DIR / "accounts.json"

    def _load(self) -> None:
        try:
            p = self._path()
            if p.is_file():
                data = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    for k in self._state:
                        if k in data:
                            self._state[k] = data[k]
        except Exception as exc:  # noqa: BLE001
            logger.warning("accounts.json unreadable, starting fresh: %s", exc)

    def _save(self) -> None:
        try:
            p = self._path()
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._state, indent=2, ensure_ascii=False), encoding="utf-8")
            tmp.replace(p)
        except Exception as exc:  # noqa: BLE001
            logger.warning("could not save accounts.json: %s", exc)

    # ── identity ──────────────────────────────────────────────────────────
    def key_of(self, client: Any) -> str:
        """Account key = Google email, or the last email this Chrome profile
        reported (the extension replays it a moment after reconnecting)."""
        info = getattr(client, "user_info", None) or {}
        email = info.get("email") if isinstance(info, dict) else None
        if email:
            return str(email).lower()
        inst = getattr(client, "_extension_instance", None)
        if inst and self._state["labels"].get(inst):
            return self._state["labels"][inst]
        return f"profile:{inst}" if inst else "profile:unknown"

    def note_identity(self, client: Any) -> None:
        """Called after a bridge reports its Google account."""
        key = self.key_of(client)
        if key.startswith("profile:"):
            return
        with self._lock:
            inst = getattr(client, "_extension_instance", None)
            changed = False
            if inst and self._state["labels"].get(inst) != key:
                self._state["labels"][inst] = key
                changed = True
            if key not in self._state["order"]:
                self._state["order"].append(key)
                changed = True
            if not self._state.get("primary"):
                self._state["primary"] = key
                changed = True
            if changed:
                self._save()

    @property
    def primary(self) -> Optional[str]:
        return self._state.get("primary")

    # ── bridge lifecycle (called by ws_server) ────────────────────────────
    def attach(self, ws: Any, instance_id: str, version: Optional[str]) -> Any:
        with self._lock:
            client = self._clients.get(instance_id)
            if client is None:
                client = self._FlowClient()
                self._clients[instance_id] = client
            elif client.connected and not client.owns_extension(ws):
                # Same profile reconnecting (service worker restart): the new
                # socket replaces the old one; in-flight calls on the old
                # socket fail and are retried by their callers.
                client.clear_extension()
            client._extension_instance = instance_id
            if not client.set_extension(ws, instance_id=instance_id, version=version):
                return None
            if instance_id in self._connected_order:
                self._connected_order.remove(instance_id)
            self._connected_order.append(instance_id)
            return client

    def client_for_ws(self, ws: Any) -> Optional[Any]:
        with self._lock:
            for c in self._clients.values():
                if c.owns_extension(ws):
                    return c
        return None

    def detach(self, ws: Any) -> None:
        with self._lock:
            for inst, c in self._clients.items():
                if c.owns_extension(ws):
                    c.clear_extension(ws)
                    if inst in self._connected_order:
                        self._connected_order.remove(inst)
                    return

    def resolve_callback(self, payload: dict, secret: Optional[str]) -> Optional[bool]:
        """Route an extension HTTP callback to the bridge that issued the
        request. None = secret matched no bridge (401)."""
        import hmac

        if not secret:
            return None
        with self._lock:
            clients = [c for c in self._clients.values() if c.connected] or [self._idle]
        owner = None
        for c in clients:
            if hmac.compare_digest(secret, c.callback_secret):
                owner = c
                break
        if owner is None:
            return None
        return owner.resolve_callback(payload)

    # ── selection ─────────────────────────────────────────────────────────
    def connected_clients(self) -> list[Any]:
        with self._lock:
            out = [self._clients[i] for i in self._connected_order
                   if i in self._clients and self._clients[i].connected]
        order = self._state.get("order") or []

        def rank(c):
            k = self.key_of(c)
            # Profiles that haven't told us their Google account yet go last.
            return (not self.identified(c), order.index(k) if k in order else len(order))

        return sorted(out, key=rank)

    def identified(self, client: Any) -> bool:
        return not self.key_of(client).startswith("profile:")

    def _exhausted(self, key: str, now: Optional[float] = None) -> Optional[dict]:
        now = time.time() if now is None else now
        info = (self._state.get("exhausted") or {}).get(key)
        if not info:
            return None
        if now >= float(info.get("until") or 0):
            return None
        return info

    def is_available(self, client: Any, now: Optional[float] = None) -> bool:
        return client.connected and self._exhausted(self.key_of(client), now) is None

    def _select(self, exclude: tuple = ()) -> Optional[Any]:
        now = time.time()
        conn = [c for c in self.connected_clients() if self.key_of(c) not in exclude]
        if not conn:
            return None
        # A profile whose Google account is unknown (no Flow project tab open
        # yet) is only used when nothing else is connected.
        known = [c for c in conn if self.identified(c)]
        if known:
            conn = known
        sel = self._state.get("selected")
        chosen = next((c for c in conn if self.key_of(c) == sel), None)
        if chosen is not None and (not self._state.get("auto_rotate") or self.is_available(chosen, now)):
            return chosen
        if not self._state.get("auto_rotate"):
            return chosen or conn[0]
        fresh = [c for c in conn if self.is_available(c, now)]
        if fresh:
            return fresh[0]
        # Everyone is spent: retry the one that was marked longest ago, once
        # the recheck window has passed (a refusal costs nothing).
        def at(c):
            return float((self._state["exhausted"].get(self.key_of(c)) or {}).get("at") or 0)

        oldest = min(conn, key=at)
        if now - at(oldest) >= RECHECK_AFTER_S:
            return oldest
        return None if exclude else (chosen or oldest)

    def current(self) -> Any:
        pinned = self._pinned.get()
        if pinned is not None:
            return pinned
        return self._select() or self._idle

    def next_account(self, exclude: set[str]) -> Optional[Any]:
        """A connected account not in ``exclude`` that still has quota."""
        if not self._state.get("auto_rotate"):
            return None
        now = time.time()
        for c in self.connected_clients():
            k = self.key_of(c)
            if k in exclude or not self.identified(c):
                continue
            if self.is_available(c, now):
                return c
            info = self._state["exhausted"].get(k) or {}
            if now - float(info.get("at") or 0) >= RECHECK_AFTER_S:
                return c
        return None

    def client_for_key(self, key: Optional[str]) -> Optional[Any]:
        if not key:
            return None
        for c in self.connected_clients():
            if self.key_of(c) == key.lower():
                return c
        return None

    async def ask_identities(self) -> int:
        """Ask every connected profile that hasn't reported its Google
        account to read it again from its Flow tab."""
        n = 0
        for c in self.connected_clients():
            if not self.identified(c):
                if await c.notify({"type": "please_resend_userinfo"}):
                    n += 1
        return n

    @contextlib.contextmanager
    def pin(self, client: Any) -> Iterator[Any]:
        token = self._pinned.set(client)
        try:
            yield client
        finally:
            self._pinned.reset(token)

    # ── state changes ─────────────────────────────────────────────────────
    def mark_exhausted(self, client: Any, reason: str = "") -> None:
        key = self.key_of(client)
        now = time.time()
        with self._lock:
            self._state.setdefault("exhausted", {})[key] = {
                "at": now, "until": _next_reset(now), "reason": str(reason)[:200],
            }
            self._save()
        logger.info("account %s marked out of quota until reset", key)

    def record_switch(self, from_key: str, to_key: str, reason: str = "") -> None:
        with self._lock:
            ev = self._state.setdefault("events", [])
            ev.append({"at": time.time(), "from": from_key, "to": to_key, "reason": str(reason)[:160]})
            del ev[:-50]
            self._save()

    def clear_exhausted(self, key: Optional[str] = None) -> None:
        with self._lock:
            if key is None:
                self._state["exhausted"] = {}
            else:
                self._state.setdefault("exhausted", {}).pop(key.lower(), None)
            self._save()

    def select(self, key: Optional[str]) -> None:
        with self._lock:
            self._state["selected"] = key.lower() if key else None
            self._save()

    def set_auto_rotate(self, on: bool) -> None:
        with self._lock:
            self._state["auto_rotate"] = bool(on)
            self._save()

    def set_order(self, keys: list[str]) -> None:
        with self._lock:
            keys = [k.lower() for k in keys if isinstance(k, str) and k]
            rest = [k for k in self._state.get("order", []) if k not in keys]
            self._state["order"] = keys + rest
            self._save()

    @property
    def auto_rotate(self) -> bool:
        return bool(self._state.get("auto_rotate"))

    # ── reporting ─────────────────────────────────────────────────────────
    def snapshot(self) -> dict:
        now = time.time()
        current = self.current()
        cur_key = self.key_of(current) if current is not self._idle else None
        rows: dict[str, dict] = {}
        with self._lock:
            clients = dict(self._clients)
        for inst, c in clients.items():
            key = self.key_of(c)
            ex = self._exhausted(key, now)
            row = rows.get(key)
            if row is not None and row["connected"] and not c.connected:
                continue
            stats = c.ws_stats
            rows[key] = {
                "key": key,
                "email": (c.user_info or {}).get("email") or (None if key.startswith("profile:") else key),
                "name": (c.user_info or {}).get("name"),
                "picture": (c.user_info or {}).get("picture"),
                "connected": c.connected,
                "identified": not key.startswith("profile:"),
                "instance": inst[:8],
                "active": key == cur_key,
                "selected": key == self._state.get("selected"),
                "primary": key == self._state.get("primary"),
                "exhausted": bool(ex),
                "exhausted_reason": (ex or {}).get("reason"),
                "exhausted_until": (ex or {}).get("until"),
                "requests": stats.get("request_count", 0),
                "failed": stats.get("failed_count", 0),
                "last_error": stats.get("last_error"),
                "extension_version": stats.get("extension_version"),
            }
        order = self._state.get("order") or []
        listed = sorted(rows.values(), key=lambda r: (not r["connected"],
                                                     order.index(r["key"]) if r["key"] in order else 999))
        return {
            "auto_rotate": self.auto_rotate,
            "selected": self._state.get("selected"),
            "active": cur_key,
            "primary": self._state.get("primary"),
            "accounts": listed,
            "events": list(reversed(self._state.get("events") or []))[:20],
        }

    # test helper
    def _reset_for_tests(self) -> None:
        with self._lock:
            self._clients.clear()
            self._connected_order.clear()
            self._state.update({"auto_rotate": True, "selected": None, "order": [],
                                "exhausted": {}, "labels": {}, "primary": None, "events": []})


class FlowClientProxy:
    """Stand-in for the old ``flow_client`` singleton: every attribute read
    or write goes to the account the pool currently routes to."""

    __slots__ = ("_pool",)

    def __init__(self, pool: AccountPool) -> None:
        object.__setattr__(self, "_pool", pool)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._pool.current(), name)

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(self._pool.current(), name, value)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<FlowClientProxy current={self._pool.key_of(self._pool.current())}>"
