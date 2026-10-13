"""Standalone WebSocket server on :9223 for the Chrome extension bridge.

Kept separate from the FastAPI :8101 app to match flowkit's pattern — the
extension's `background.js` connects to `ws://127.0.0.1:9223` only.
"""
from __future__ import annotations

import asyncio
import json
import logging

import websockets

from flowboard.config import EXTENSION_WS_PORT, WS_HOST
from flowboard.services.flow_client import flow_client

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
            await websocket.send(json.dumps({"type": "bridge_rejected", "error": "EXTENSION_UPDATE_REQUIRED"}))
            await websocket.close(code=4002, reason="Flowboard Bridge 0.1.15+ required")
            return
    except (asyncio.TimeoutError, ValueError, websockets.ConnectionClosed):
        await websocket.close(code=4002, reason="Bridge handshake required")
        return
    if not flow_client.set_extension(websocket, instance_id=hello["instanceId"], version=hello["version"]):
        await websocket.send(json.dumps({"type": "bridge_rejected", "error": "ANOTHER_PROFILE_SELECTED"}))
        await websocket.close(code=4003, reason="Another browser profile owns this agent session")
        return
    logger.info("extension connected from %s", getattr(websocket, "remote_address", "?"))

    # Hand the extension the secret it needs to authenticate HTTP callbacks.
    try:
        await websocket.send(
            json.dumps({"type": "callback_secret", "secret": flow_client.callback_secret})
        )
    except Exception:  # noqa: BLE001
        logger.exception("failed to send callback_secret")

    try:
        async for raw in websocket:
            if not flow_client.owns_extension(websocket):
                break
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("invalid JSON from extension")
                continue
            try:
                await flow_client.handle_message(data)
            except Exception:  # noqa: BLE001
                logger.exception("error handling extension message")
    except websockets.ConnectionClosed:
        pass
    finally:
        flow_client.clear_extension(websocket)
        logger.info("extension disconnected")


async def run_ws_server() -> None:
    async with websockets.serve(_handler, WS_HOST, EXTENSION_WS_PORT):
        logger.info("WebSocket server listening on ws://%s:%d", WS_HOST, EXTENSION_WS_PORT)
        await asyncio.Future()  # run forever
