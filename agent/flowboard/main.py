import asyncio
import logging
import mimetypes
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Header, Request as FastAPIRequest
from fastapi.middleware.cors import CORSMiddleware

from flowboard.config import WS_HOST

# Slim Docker images ship no /etc/mime.types: register what the UI serves.
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/svg+xml", ".svg")
from flowboard.db import get_session, init_db
from flowboard.db.models import Request
from flowboard.routes import activity, ai_chat, assets, assistant, auth, boards, chat, edges, flow_projects, llm, media, nodes, plans, projects, prompt, upload, upscale, vision
from flowboard.routes import sync as sync_route
from flowboard.routes import accounts as accounts_route
from flowboard.routes import session as session_route
from flowboard.routes import users as users_route
from flowboard.routes import templates as templates_route
from flowboard.routes import flow_import as flow_import_route
from flowboard.services import users as users_svc
from flowboard.services import sync as sync_state
from flowboard.routes import references as references_route
from flowboard.routes import requests as requests_route
from flowboard.services.flow_client import account_pool, flow_client
from flowboard.services.ws_server import run_ws_server
from flowboard.worker.processor import get_worker, reset_image_project_session

# Guard rail: the dedicated WS server is unauthenticated and would expose the
# callback secret to any process that can reach it. Refuse to boot if someone
# overrode WS_HOST to a non-loopback address.
if WS_HOST not in ("127.0.0.1", "localhost", "::1"):
    raise RuntimeError(
        f"FLOWBOARD_WS_HOST must be loopback (got {WS_HOST!r}); the extension WS "
        "is unauthenticated by design and must not be network-reachable."
    )

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")


def _recover_orphan_running_requests() -> int:
    """Mark any pre-existing 'running' requests as failed so a restart doesn't
    leave nodes polling a request that nobody is processing anymore."""
    from datetime import datetime, timezone
    from sqlmodel import select as _select

    touched = 0
    with get_session() as s:
        rows = s.exec(_select(Request).where(Request.status == "running")).all()
        for r in rows:
            r.status = "failed"
            r.error = "agent_restart_lost"
            r.finished_at = datetime.now(timezone.utc)
            s.add(r)
            touched += 1
        if touched:
            s.commit()
    return touched


@asynccontextmanager
async def lifespan(app: FastAPI):
    reset_image_project_session()
    init_db()
    users_svc.ensure_bootstrap_admin()
    recovered = _recover_orphan_running_requests()
    if recovered:
        logger.info("recovered %d orphan running request(s) → failed", recovered)
    worker = get_worker()
    ws_task = asyncio.create_task(run_ws_server(), name="ext-ws-server")
    worker_task = asyncio.create_task(worker.start(), name="request-worker")
    logger.info("flowboard agent started (ws:9223 + worker)")
    # Hosted MCP (/mcp/<token>) needs its session manager running.
    from contextlib import AsyncExitStack

    stack = AsyncExitStack()
    try:
        from flowboard.mcp_mount import _inner, mcp_server

        _inner()
        await stack.enter_async_context(mcp_server().session_manager.run())
    except Exception:  # noqa: BLE001 — MCP is optional; never block the app
        logger.exception("hosted MCP disabled")
    try:
        yield
    finally:
        await stack.aclose()
        worker.request_shutdown()
        try:
            await asyncio.wait_for(worker.drain(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("worker drain timed out")
        for t in (ws_task, worker_task):
            t.cancel()
        await asyncio.gather(ws_task, worker_task, return_exceptions=True)
        logger.info("flowboard agent stopped")


app = FastAPI(title="Flowboard Agent", version="0.0.2", lifespan=lifespan)

_MUTATING = {"POST", "PUT", "PATCH", "DELETE"}


class _McpLiveSync:
    """Pure-ASGI middleware (doesn't buffer SSE streams): after a successful
    change made by an external controller — the MCP server tags its calls
    with ``X-Flowboard-Source: mcp`` — bump the live-sync revision so the
    open UI reloads the board."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (
            scope.get("type") != "http"
            or scope.get("method") not in _MUTATING
            or scope.get("path", "").startswith("/api/sync")
            or (b"x-flowboard-source", b"mcp") not in [
                (k.lower(), v) for k, v in scope.get("headers", [])
            ]
        ):
            await self.app(scope, receive, send)
            return

        status_holder = {"code": 500}

        async def _send(message):
            if message.get("type") == "http.response.start":
                status_holder["code"] = message.get("status", 500)
            await send(message)

        await self.app(scope, receive, _send)
        if status_holder["code"] < 400:
            sync_state.bump()


# ── Login (server mode) ───────────────────────────────────────────────────
# Open while no Flowboard user exists (single-user local app). Once the
# first admin is created every API, media file and the extension bridge
# need a session cookie or a personal API token.
_AUTH_OPEN = {
    "/api/health",
    "/api/session",
    "/api/session/login",
    "/api/session/logout",
    "/api/ext/callback",  # authenticated by the per-bridge callback secret
}


class _AuthGate:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        protected = path.startswith(("/api/", "/media/"))
        user = None
        if protected or path == "/api/session":
            headers = {k.lower(): v for k, v in scope.get("headers", [])}
            auth = headers.get(b"authorization", b"").decode("latin-1")
            if auth.lower().startswith("bearer "):
                user = users_svc.user_for_token(auth[7:].strip(), "api")
            if user is None:
                cookie = headers.get(b"cookie", b"").decode("latin-1")
                for part in cookie.split(";"):
                    name, _, value = part.strip().partition("=")
                    if name == users_svc.SESSION_COOKIE and value:
                        user = users_svc.user_for_session(value)
                        break
        if (
            protected
            and scope.get("method") != "OPTIONS"
            and path not in _AUTH_OPEN
            and user is None
            and users_svc.auth_enabled()
        ):
            body = b'{"detail":"login_required"}'
            await send({"type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"application/json"),
                                    (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        token = users_svc.current_user_id.set(user.id if user else None)
        try:
            await self.app(scope, receive, send)
        finally:
            users_svc.current_user_id.reset(token)


import os as _os  # noqa: E402

_EXTRA_ORIGINS = [o.strip() for o in _os.getenv("FLOWBOARD_ALLOWED_ORIGINS", "").split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    # Same-origin in production (the agent serves the UI); the Vite dev
    # server proxies /api. Only local dev origins + configured ones may
    # make credentialed cross-origin calls.
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_origins=_EXTRA_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(_McpLiveSync)
app.add_middleware(_AuthGate)
from flowboard.mcp_mount import McpMount  # noqa: E402

app.add_middleware(McpMount)

app.include_router(boards.router)
app.include_router(nodes.router)
app.include_router(edges.router)
app.include_router(chat.router)
app.include_router(projects.router)
app.include_router(flow_projects.router)
app.include_router(references_route.router)
app.include_router(requests_route.router)
app.include_router(media.bytes_router)
app.include_router(media.api_router)
app.include_router(upload.router)
app.include_router(plans.router)
app.include_router(vision.router)
app.include_router(prompt.router)
app.include_router(auth.router)
app.include_router(llm.router)
app.include_router(activity.router)
app.include_router(assistant.router)
app.include_router(assets.router)
app.include_router(upscale.router)
app.include_router(ai_chat.router)
app.include_router(sync_route.router)
app.include_router(accounts_route.router)
app.include_router(session_route.router)
app.include_router(users_route.router)
app.include_router(templates_route.router)
app.include_router(flow_import_route.router)


from fastapi import WebSocket as _WebSocket  # noqa: E402


@app.websocket("/ws/bridge")
async def bridge_socket(websocket: _WebSocket) -> None:
    from flowboard.services.ws_server import serve_starlette

    await serve_starlette(websocket)


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "extension_connected": flow_client.connected,
        "ws_stats": flow_client.ws_stats,
    }


@app.post("/api/ext/callback")
async def ext_callback(
    body: FastAPIRequest,
    x_callback_secret: str | None = Header(default=None, alias="X-Callback-Secret"),
) -> dict:
    """HTTP callback for the extension to deliver API responses. Each
    connected profile has its own secret; the matching one owns the call."""
    try:
        payload = await body.json()
    except Exception:
        payload = None
    if not x_callback_secret:
        raise HTTPException(status_code=401, detail="invalid callback secret")
    if not isinstance(payload, dict) or "id" not in payload:
        # Still reject a wrong secret before describing the body.
        if account_pool.resolve_callback({"id": None}, x_callback_secret) is None:
            raise HTTPException(status_code=401, detail="invalid callback secret")
        raise HTTPException(
            status_code=400,
            detail="invalid json body" if payload is None else "missing id",
        )

    matched = account_pool.resolve_callback(payload, x_callback_secret)
    if matched is None:
        raise HTTPException(status_code=401, detail="invalid callback secret")
    return {"ok": matched}


# ── Built web UI (server deploys) ─────────────────────────────────────────
# `npx vite build` in frontend/ produces frontend/dist; when it exists the
# agent serves the UI itself, so one container / one Cloudflare hostname
# carries UI, API, media and the extension bridge (/ws/bridge). Local dev
# keeps using the Vite dev server on :5173.
from pathlib import Path as _Path  # noqa: E402

from fastapi.responses import FileResponse as _FileResponse  # noqa: E402

from flowboard.config import ROOT as _ROOT  # noqa: E402

_UI_DIST = _Path(_os.getenv("FLOWBOARD_FRONTEND_DIST", str(_ROOT / "frontend" / "dist")))

if (_UI_DIST / "index.html").is_file():
    _UI_ROOT = _UI_DIST.resolve()

    @app.get("/{ui_path:path}", include_in_schema=False)
    def _web_ui(ui_path: str):
        if ui_path.startswith(("api/", "media/", "ws/")):
            raise HTTPException(404, "not found")
        target = (_UI_ROOT / ui_path).resolve()
        if ui_path and target.is_file() and _UI_ROOT in target.parents:
            return _FileResponse(str(target))
        return _FileResponse(str(_UI_ROOT / "index.html"), headers={"Cache-Control": "no-cache"})
