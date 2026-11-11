"""Standalone WebSocket server on :9223 for the Chrome extension bridge.

Kept separate from the FastAPI :8101 app to match flowkit's pattern — the
extension's `background.js` connects to `ws://127.0.0.1:9223` only.

Every Chrome profile running the extension is one Google Flow account; all
of them may be connected at once (see account_pool.py).
"""
from __future__ import annotations

import asyncio
import json
import logging

import websockets

from flowboard.config import EXTENSION_WS_PORT, WS_HOST
from flowboard.services.flow_client import account_pool as pool

logger = logging.getLogger(__name__)


async def _handler(websocket) -> None:
    # Do not select a socket or accept identity before the versioned handshake.
    # Older profiles can reconnect at any time, including while generation runs.
    try:
        hello = json.loads(await asyncio.wait_for(websocket.recv(), timeout=8))
        valid = (isinstance(hello, dict) and hello.get("type") == "bridge_hello"
                 and hello.get("protocol") == 2
                 and isinstance(hello.get("instanceId"), str)
                 and 16 <= len(hello["instanceId"]) <= 80
                 and isinstance(hello.get("version"), str))
        if not valid:
            logger.warning("bridge rejected: bad hello (version=%r)", hello.get("version") if isinstance(hello, dict) else None)
            await websocket.send(json.dumps({"type": "bridge_rejected", "error": "EXTENSION_UPDATE_REQUIRED"}))
            await websocket.close(code=4002, reason="Flowboard Bridge 0.1.15+ required")
            return
    except (asyncio.TimeoutError, ValueError, websockets.ConnectionClosed):
        await websocket.close(code=4002, reason="Bridge handshake required")
        return
    # Server mode: the profile must be paired with a Flowboard user (pairing
    # code from the "Tài khoản Flow" page, pasted into the extension popup).
    owner = None
    from flowboard.services import users as users_svc

    if users_svc.auth_enabled():
        user = users_svc.user_for_token(hello.get("pairToken"), "bridge")
        if user is None:
            tok = str(hello.get("pairToken") or "")
            logger.warning("bridge rejected: pairing code %s (profile %s…, version %s)",
                           (tok[:8] + "…") if tok else "MISSING", hello["instanceId"][:8], hello.get("version"))
            await websocket.send(json.dumps({"type": "bridge_rejected", "error": "PAIRING_REQUIRED"}))
            await websocket.close(code=4004, reason="Pairing code required")
            return
        owner = user.id
    client = pool.attach(websocket, hello["instanceId"], hello["version"], owner_user_id=owner)
    if client is None:
        await websocket.send(json.dumps({"type": "bridge_rejected", "error": "BRIDGE_BUSY"}))
        await websocket.close(code=4003, reason="Bridge slot busy")
        return
    logger.info("extension connected (profile %s…)", hello["instanceId"][:8])
    nudger = asyncio.create_task(_nudge_identity(client, websocket))

    # Hand the extension the secret it needs to authenticate HTTP callbacks.
    try:
        await websocket.send(
            json.dumps({"type": "callback_secret", "secret": client.callback_secret})
        )
    except Exception:  # noqa: BLE001
        logger.exception("failed to send callback_secret")

    try:
        async for raw in websocket:
            if not client.owns_extension(websocket):
                break
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("invalid JSON from extension")
                continue
            try:
                await client.handle_message(data)
                if isinstance(data, dict) and data.get("type") == "user_info":
                    pool.note_identity(client)
            except Exception:  # noqa: BLE001
                logger.exception("error handling extension message")
    except websockets.ConnectionClosed:
        pass
    finally:
        nudger.cancel()
        pool.detach(websocket)
        logger.info("extension disconnected (profile %s…)", hello["instanceId"][:8])


async def _nudge_identity(client, websocket) -> None:
    """The extension reads the signed-in email from an open Flow project tab.
    Until it has one, ask again every few seconds (cheap, local)."""
    try:
        for i in range(720):  # ~1 hour
            await asyncio.sleep(5 if i < 12 else 15)
            if not client.owns_extension(websocket):
                return
            if pool.identified(client):
                continue
            await client.notify({"type": "please_resend_userinfo"})
    except asyncio.CancelledError:
        pass


async def run_ws_server() -> None:
    async with websockets.serve(_handler, WS_HOST, EXTENSION_WS_PORT):
        logger.info("WebSocket server listening on ws://%s:%d", WS_HOST, EXTENSION_WS_PORT)
        await asyncio.Future()  # run forever


class StarletteBridgeSocket:
    """Lets the same handler serve the bridge on the main HTTP app
    (``/ws/bridge``) — that is the path a server deploy exposes through
    Cloudflare as ``wss://<domain>/ws/bridge``."""

    def __init__(self, ws) -> None:
        self._ws = ws
        client = getattr(ws, "client", None)
        self.remote_address = (client.host, client.port) if client else None

    async def recv(self):
        from starlette.websockets import WebSocketDisconnect

        try:
            return await self._ws.receive_text()
        except WebSocketDisconnect as exc:
            raise websockets.ConnectionClosed(None, None) from exc

    async def send(self, raw) -> None:
        await self._ws.send_text(raw)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        try:
            await self._ws.close(code=code, reason=reason)
        except Exception:  # noqa: BLE001
            pass

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return await self.recv()
        except websockets.ConnectionClosed:
            raise StopAsyncIteration


async def serve_starlette(ws) -> None:
    await ws.accept()
    await _handler(StarletteBridgeSocket(ws))
