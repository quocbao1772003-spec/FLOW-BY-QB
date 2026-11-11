"""Serve the Flowboard MCP server from the team server itself.

Each person's connector URL is ``https://<server>/mcp/<fbt_token>``: paste it
into claude.ai (Settings → Connectors), ChatGPT, or
``claude mcp add --transport http flowboard <url>``. Nothing to install.

The token in the path is the personal MCP token from "Kết nối Chrome"; it is
checked on every request and then used for the agent API calls the tools
make, so a connector sees exactly what its owner sees. Revoking the token
kills the link at once.
"""
from __future__ import annotations

import logging
import re

from flowboard.services import users as users_svc

logger = logging.getLogger(__name__)

_PATH = re.compile(r"^/mcp/(fbt_[A-Za-z0-9_\-]{16,})(/.*)?$")
_mcp_app = None


def mcp_server():
    from flowboard_mcp.server import mcp

    return mcp


def _inner():
    global _mcp_app
    if _mcp_app is None:
        from mcp.server.transport_security import TransportSecuritySettings

        _mcp_app = mcp_server().streamable_http_app(
            streamable_http_path="/mcp",
            stateless_http=True,
            json_response=True,
            transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
        )
    return _mcp_app


class McpMount:
    """ASGI middleware: /mcp/<token>[/...] → the MCP app, everything else → Flowboard."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/mcp/"):
            await self.app(scope, receive, send)
            return
        m = _PATH.match(scope["path"])
        user = users_svc.user_for_token(m.group(1), "api") if m else None
        if user is None:
            await _plain(send, 404, b'{"error":"not found"}')
            return
        from flowboard_mcp.client import request_token

        inner = _inner()
        scope = dict(scope)
        scope["path"] = "/mcp"
        scope["raw_path"] = b"/mcp"
        tok = request_token.set(m.group(1))
        try:
            await inner(scope, receive, send)
        finally:
            request_token.reset(tok)


async def _plain(send, status: int, body: bytes) -> None:
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": body})
