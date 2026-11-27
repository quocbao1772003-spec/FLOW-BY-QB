"""Flow Video qua tab Flow REST API (contract flowboard-video-ui-api.md).

Thin view over the generic request queue: ``gen_video_ui`` requests are run by
worker/processor.py through the extension bridge (``video_ui_call``).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request as HttpRequest
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlmodel import select

from flowboard.config import STORAGE_DIR
from flowboard.db import get_session
from flowboard.db.models import Node, Request
from flowboard.services import flow_video_ui as fv
from flowboard.services.users import current_user_id
from flowboard.worker.processor import get_worker

router = APIRouter(prefix="/api/video-ui", tags=["video-ui"])

RTYPE = "gen_video_ui"

class StartImage(BaseModel):
    media_id: Optional[str] = None
    node_id: Optional[int] = None
    url: Optional[str] = None
    b64: Optional[str] = None
    name: Optional[str] = None

class VideoGenerate(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    start_image: StartImage
    model: str = fv.DEFAULT_MODEL
    aspect: str = "16:9"
    resolution: Optional[str] = None
    duration_s: Optional[int] = Field(default=None, ge=4, le=10)
    ref_images: Optional[list[StartImage]] = None
    max_credits: Optional[int] = Field(default=None, ge=0)
    download_quality: str = "1080p"
    variants: int = Field(default=1, ge=1, le=4)
    account: Optional[str] = None
    board_id: Optional[int] = None
    node_id: Optional[int] = None
    client_ref: Optional[str] = None
    silent: bool = True

def _iso(d: Optional[datetime]) -> Optional[str]:
    if d is None:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.isoformat()

def blank_steps() -> list[dict]:
    return [{"key": k, "label": lbl, "at": None, "ok": None} for k, lbl in fv.STEPS]

def _owned(req: Optional[Request]) -> Request:
    if req is None or req.type != RTYPE:
        raise HTTPException(404, "request not found")
    uid = current_user_id.get()
    if uid is not None and (req.params or {}).get("_user_id") not in (None, uid):
        raise HTTPException(404, "request not found")
    return req

def _view(req: Request) -> dict[str, Any]:
    p = req.params or {}
    res = dict(req.result or {})
    status = {"canceled": "cancelled", "timeout": "failed"}.get(req.status, req.status)
    steps = p.get("steps") or blank_steps()
    done = [i + 1 for i, s in enumerate(steps) if s.get("ok")]
    err = fv.error_obj(req.error, res.get("error_detail")) if status == "failed" else None
    out: dict[str, Any] = {
        "id": req.id, "status": status, "client_ref": p.get("client_ref"),
        "prompt": p.get("prompt"), "model": p.get("model"),
        "account": res.get("account"), "source": p.get("source") or "api",
        "credits": res.get("credits") or fv.CREDITS.get(p.get("model") or fv.DEFAULT_MODEL, 10),
        "created_at": _iso(req.created_at), "finished_at": _iso(req.finished_at),
        "step": max(done) if done else 0, "steps": steps, "error": err, "result": None,
        "deprecated": (p.get("model") in fv.DEPRECATED_MODELS),
        "resolution": p.get("resolution"), "duration_s": p.get("duration_s"),
    }
    if req.status == "done":
        out["result"] = {"media_url": f"/api/video-ui/requests/{req.id}/media",
                         "size": res.get("size"), "duration_s": res.get("duration_s"),
                         "node_id": req.node_id}
    return out

def _image_source(si: StartImage) -> dict:
    given = {k: v for k, v in si.model_dump().items() if k in ("media_id", "node_id", "url", "b64") and v}
    if len(given) != 1:
        raise HTTPException(422, "start_image needs exactly one of media_id, node_id, url, b64")
    return given

def enqueue(body: VideoGenerate, source: str = "api") -> tuple[Request, bool]:
    from flowboard.services.flow_client import account_pool

    src = _image_source(body.start_image)
    if not fv.candidates(account_pool, body.account):
        raise HTTPException(503, {"code": "EXTENSION_OFFLINE"})
    uid = current_user_id.get()
    params = body.model_dump(exclude={"board_id", "node_id"})
    params["start_image"] = {**src, "name": body.start_image.name}
    params["ref_images"] = [r.model_dump(exclude_none=True) for r in (body.ref_images or [])] or None
    params["source"] = source
    params["steps"] = blank_steps()
    if uid is not None:
        params["_user_id"] = uid
    if body.node_id is not None:
        params["_finalize_node"] = True
    with get_session() as s:
        ref = body.client_ref
        if ref:
            q = select(Request).where(Request.type == RTYPE).order_by(Request.id.desc())
            for r in s.exec(q).all():
                p = r.params or {}
                if p.get("client_ref") == ref and p.get("_user_id") == params.get("_user_id") \
                        and r.status not in ("failed", "canceled", "timeout"):
                    return r, True
        if body.node_id is not None and not s.get(Node, body.node_id):
            raise HTTPException(404, "node not found")
        req = Request(node_id=body.node_id, type=RTYPE, params=params, status="queued")
        s.add(req)
        s.commit()
        s.refresh(req)
    get_worker().enqueue(req.id)
    return req, False

@router.post("/generate", status_code=201)
def generate(body: VideoGenerate):
    if body.model not in fv.MODELS:
        raise HTTPException(422, "model must be one of " + ", ".join(fv.MODELS))
    if body.resolution is not None:
        allowed = ("360p", "720p") if body.model == "omni_flash" else ("720p", "1080p")
        if body.resolution not in allowed:
            raise HTTPException(422, f"resolution must be one of {allowed} for {body.model}")
    if body.duration_s is not None and body.model != "omni_flash":
        raise HTTPException(422, "duration_s is only for omni_flash")
    if body.download_quality not in ("1080p", "720p"):
        raise HTTPException(422, "download_quality must be 1080p or 720p")
    if body.aspect not in ("16:9", "9:16"):
        raise HTTPException(422, "aspect must be 16:9 or 9:16")
    req, dedup = enqueue(body, "board" if body.board_id or body.node_id else "api")
    return {"request_id": req.id, "status": req.status, "dedup": dedup}

@router.get("/requests")
def list_requests(limit: int = 50, before: Optional[int] = None, status: Optional[str] = None):
    limit = max(1, min(limit, 200))
    uid = current_user_id.get()
    want = {x.strip() for x in status.split(",")} if status else None
    if want:
        if "cancelled" in want:
            want.add("canceled")
        if "failed" in want:
            want.add("timeout")
    items: list[dict] = []
    with get_session() as s:
        q = select(Request).where(Request.type == RTYPE).order_by(Request.id.desc())
        if before is not None:
            q = q.where(Request.id < before)
        for req in s.exec(q):
            if uid is not None and (req.params or {}).get("_user_id") not in (None, uid):
                continue
            if want and req.status not in want:
                continue
            items.append(_view(req))
            if len(items) >= limit + 1:
                break
    more = len(items) > limit
    items = items[:limit]
    return {"items": items, "next_before": items[-1]["id"] if more else None}

@router.get("/requests/{request_id}")
def get_request(request_id: int):
    with get_session() as s:
        return _view(_owned(s.get(Request, request_id)))

@router.post("/requests/{request_id}/cancel")
def cancel(request_id: int):
    with get_session() as s:
        req = _owned(s.get(Request, request_id))
        if req.status not in ("queued", "running"):
            raise HTTPException(409, f"only queued or running requests can be cancelled (status={req.status})")
        req.status = "canceled"
        req.error = "canceled"
        req.finished_at = datetime.now(timezone.utc)
        s.add(req)
        s.commit()
        s.refresh(req)
        return _view(req)

def media_path(rid: int):
    return STORAGE_DIR / "video_ui" / f"{rid}.mp4"

@router.get("/requests/{request_id}/media")
def media(request_id: int, request: HttpRequest):
    with get_session() as s:
        req = _owned(s.get(Request, request_id))
    f = media_path(req.id)
    if not f.is_file():
        raise HTTPException(404, "not found")
    # FileResponse honours Range requests.
    return FileResponse(f, media_type="video/mp4", headers={"Cache-Control": "no-store"})

@router.get("/selectors")
def get_selectors():
    return fv.load_selectors()

@router.put("/selectors")
def put_selectors(body: dict):
    from flowboard.services import users as users_svc

    uid = current_user_id.get()
    if uid is not None:
        u = users_svc.get_user(uid)
        if not u or getattr(u, "role", "admin") != "admin":
            raise HTTPException(403, "admin only")
    return fv.save_selectors(body)

class ProbeBody(BaseModel):
    account: Optional[str] = None

@router.post("/probe")
async def probe(body: Optional[ProbeBody] = None):
    from flowboard.services.flow_client import account_pool

    try:
        return await fv.probe(account_pool, body.account if body else None)
    except fv.VideoUiError as e:
        return JSONResponse(status_code=503 if e.code == "EXTENSION_OFFLINE" else 502,
                            content={"code": e.code, "message": fv.ERROR_MESSAGES[e.code], "detail": e.detail})

@router.get("/accounts")
def accounts():
    from flowboard.services.flow_client import account_pool

    return fv.accounts_snapshot(account_pool)
