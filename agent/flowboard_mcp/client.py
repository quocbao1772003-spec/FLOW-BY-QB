"""Thin async client for the local Flowboard agent (FastAPI on :8101).

Every call is tagged ``X-Flowboard-Source: mcp`` so the agent bumps its
live-sync revision and the open browser UI reloads the board.
"""
from __future__ import annotations

import contextvars
import os
from typing import Any, Optional

import httpx

try:  # mcp 2.x
    from mcp.server.mcpserver.exceptions import ToolError as _ToolError
except ImportError:  # pragma: no cover
    _ToolError = RuntimeError  # type: ignore[misc,assignment]

AGENT_URL = os.getenv("FLOWBOARD_URL", "http://127.0.0.1:8101").rstrip("/")
# Personal MCP token (fbt_…) from the "Kết nối Chrome" box. Needed once the
# Flowboard has user accounts (always the case on a team server).
AGENT_TOKEN = os.getenv("FLOWBOARD_TOKEN", "").strip()
# Hosted mode (MCP served by the Flowboard server itself at /mcp/<token>):
# the token of the caller, set per request by flowboard.mcp_mount.
request_token: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "flowboard_mcp_token", default=None
)


class FlowboardError(_ToolError):
    """Raised with a readable message the AI sees (ToolError is passed
    through to the client instead of being masked as a crash)."""


class FlowboardClient:
    def __init__(self, base_url: str = AGENT_URL, timeout: float = 180.0,
                 token: str = AGENT_TOKEN) -> None:
        self.base_url = base_url
        self._token = token
        self._timeout = timeout
        self._client: Optional[httpx.AsyncClient] = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self._timeout,
                headers={
                    "X-Flowboard-Source": "mcp",
                    **({"Authorization": f"Bearer {self._token}"} if self._token else {}),
                },
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Optional[dict] = None,
        files: Any = None,
        data: Any = None,
        raw: bool = False,
    ) -> Any:
        try:
            tok = request_token.get()
            resp = await self._http().request(
                method.upper(), path, json=json, params=params, files=files, data=data,
                headers={"Authorization": f"Bearer {tok}"} if tok else None,
            )
        except httpx.ConnectError as exc:
            raise FlowboardError(
                f"Không kết nối được Flowboard agent ở {self.base_url}. "
                "Hãy mở app Flowboard (MO-APP.bat) rồi thử lại."
            ) from exc
        except httpx.TimeoutException as exc:
            raise FlowboardError(f"Flowboard agent không phản hồi kịp ({method} {path}).") from exc
        if resp.status_code == 401:
            raise FlowboardError(
                "Flowboard yêu cầu đăng nhập. Tạo token MCP ở trang Tài khoản Flow → Kết nối Chrome "
                "rồi đặt biến môi trường FLOWBOARD_TOKEN (hoặc chạy lại: python -m flowboard_mcp "
                "install --server <URL> --token <fbt_...>)."
            )
        if resp.status_code >= 400:
            try:
                detail = resp.json()
            except Exception:  # noqa: BLE001
                detail = resp.text[:500]
            raise FlowboardError(f"{method.upper()} {path} → HTTP {resp.status_code}: {detail}")
        if raw:
            return resp
        if resp.status_code == 204 or not resp.content:
            return {"ok": True}
        ctype = resp.headers.get("content-type", "")
        if "application/json" in ctype:
            return resp.json()
        return {"content_type": ctype, "size": len(resp.content)}

    async def get(self, path: str, **kw: Any) -> Any:
        return await self.request("GET", path, **kw)

    async def post(self, path: str, **kw: Any) -> Any:
        return await self.request("POST", path, **kw)

    async def patch(self, path: str, **kw: Any) -> Any:
        return await self.request("PATCH", path, **kw)

    async def put(self, path: str, **kw: Any) -> Any:
        return await self.request("PUT", path, **kw)

    async def delete(self, path: str, **kw: Any) -> Any:
        return await self.request("DELETE", path, **kw)

    async def media_bytes(self, media_id: str) -> tuple[bytes, str]:
        resp = await self.request("GET", f"/media/{media_id}", raw=True)
        return resp.content, resp.headers.get("content-type", "application/octet-stream")
