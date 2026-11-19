"""Flow Music REST API (see specs contracts/flowboard-music-api.md).

Thin view over the generic request queue: ``gen_music`` / ``stems_music``
requests are processed by worker/processor.py through the extension bridge.
"""
from __future__ import annotations

import mimetypes
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request as HttpRequest
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from sqlmodel import select

from flowboard.config import STORAGE_DIR
from flowboard.db import get_session
from flowboard.db.models import Node, Request
from flowboard.services.users import current_user_id
from flowboard.worker.processor import get_worker

router = APIRouter(prefix="/api/music", tags=["music"])

_MUSIC_TYPES = ("gen_music", "stems_music")


class MusicGenerate(BaseModel):
    sound_prompt: str = Field(min_length=1)
    lyrics: Optional[str] = None
    instrumental: bool = False
    title: str = "Untitled"
    model: str = "Lyria 3.5"
    seed: Optional[int] = None
    takes: int = Field(default=1, ge=1, le=4)
    mode: str = "create"
    base_clip_id: Optional[str] = None
    cover_strength: float = 0.5
    formats: list[str] = Field(default_factory=lambda: ["mp3"])
    stems: bool = False
    account: Optional[str] = None
    board_id: Optional[int] = None
    node_id: Optional[int] = None
    client_ref: Optional[str] = None


class StemsBody(BaseModel):
    clip_id: str = Field(min_length=1)
    account: Optional[str] = None
    node_id: Optional[int] = None
    client_ref: Optional[str] = None


def _enqueue(rtype: str, params: dict, node_id: Optional[int]) -> Request:
    uid = current_user_id.get()
    params = {k: v for k, v in params.items() if k != "_user_id"}
    if uid is not None:
        params["_user_id"] = uid
    if node_id is not None:
        params["_finalize_node"] = True
    with get_session() as s:
        ref = params.get("client_ref")
        if ref:
            for r in s.exec(select(Request).where(Request.type == rtype)).all():
                p = r.params or {}
                if p.get("client_ref") == ref and p.get("_user_id") == params.get("_user_id") \
                        and r.status != "failed":
                    return r
        if node_id is not None and not s.get(Node, node_id):
            raise HTTPException(404, "node not found")
        req = Request(node_id=node_id, type=rtype, params=params, status="queued")
        s.add(req)
        s.commit()
        s.refresh(req)
    get_worker().enqueue(req.id)
    return req


def _node_for(body: MusicGenerate) -> Optional[int]:
    """Create a ``song`` node when a board is given (UI shows the result)."""
    if body.node_id is not None or body.board_id is None:
        return body.node_id
    with get_session() as s:
        n = Node(board_id=body.board_id, type="song", status="queued",
                 data={"prompt": body.sound_prompt, "lyrics": body.lyrics,
                       "instrumental": body.instrumental, "title": body.title,
                       "model": body.model})
        s.add(n)
        s.commit()
        s.refresh(n)
        return n.id


@router.post("/generate", status_code=202)
def generate(body: MusicGenerate):
    if body.mode != "create":
        raise HTTPException(400, "only mode=create is supported yet")
    formats = [f for f in body.formats if f in ("mp3", "wav", "m4a")]
    if not formats:
        raise HTTPException(400, "formats must include mp3, wav or m4a")
    params = body.model_dump(exclude={"board_id", "node_id"})
    params["formats"] = formats
    req = _enqueue("gen_music", params, _node_for(body))
    return {"request_id": str(req.id), "status": req.status}


@router.post("/stems", status_code=202)
def stems(body: StemsBody):
    req = _enqueue("stems_music", body.model_dump(exclude={"node_id"}), body.node_id)
    return {"request_id": str(req.id), "status": req.status}


def _view(req: Request) -> dict[str, Any]:
    res = dict(req.result or {})
    status = {"canceled": "cancelled", "timeout": "failed"}.get(req.status, req.status)
    out: dict[str, Any] = {
        "request_id": str(req.id), "type": req.type, "status": status,
        "account": res.get("account"), "credits_used": res.get("credits_used"),
        "error": req.error, "takes": res.get("takes") or [],
    }
    if req.type == "stems_music":
        out["stems"] = res.get("stems") or {}
    if res.get("error_detail"):
        out["error_detail"] = res["error_detail"]
    return out


def _owned(req: Optional[Request]) -> Request:
    if req is None or req.type not in _MUSIC_TYPES:
        raise HTTPException(404, "request not found")
    uid = current_user_id.get()
    if uid is not None and (req.params or {}).get("_user_id") not in (None, uid):
        raise HTTPException(404, "request not found")
    return req


@router.get("/requests/{request_id}")
def get_music_request(request_id: int):
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


@router.get("/accounts")
def accounts():
    from flowboard.services import flow_music
    from flowboard.services.flow_client import account_pool

    return account_pool.music_snapshot(flow_music.is_busy)


@router.post("/accounts/refresh")
async def refresh_accounts():
    """Read credits + login state of every connected account's Flow Music."""
    from flowboard.services import flow_music
    from flowboard.services.flow_client import account_pool

    for c in flow_music.candidates(account_pool):
        key = account_pool.key_of(c)
        try:
            with account_pool.pin(c):
                credits = await flow_music.FlowMusic(flow_music.bridge_call(c)).credits()
            account_pool.note_music(key, credits=credits, session_ok=True)
        except flow_music.MusicError as e:
            account_pool.note_music(key, session_ok=e.code != "no_session" and None)
    return account_pool.music_snapshot(flow_music.is_busy)


_SAFE = re.compile(r"^[A-Za-z0-9._\-]+$")


@router.get("/media/{path:path}")
def media(path: str, request: HttpRequest):
    parts = path.split("/")
    if not parts or any(not _SAFE.match(p) or p in (".", "..") for p in parts):
        raise HTTPException(400, "bad path")
    base = (STORAGE_DIR / "music").resolve()
    f = (base / Path(*parts)).resolve()
    if base not in f.parents or not f.is_file():
        raise HTTPException(404, "not found")
    ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
    if f.suffix == ".mp3":
        ctype = "audio/mpeg"
    # FileResponse (starlette >= 0.39) honours Range requests.
    return FileResponse(f, media_type=ctype, headers={"Cache-Control": "no-store"})
