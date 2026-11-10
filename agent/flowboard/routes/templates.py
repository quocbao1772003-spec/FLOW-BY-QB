"""Shared template library.

Publishing freezes a copy of a flow (nodes + edges + their prompts and
example media). "Use" turns that frozen copy into a brand-new flow owned by
the person who clicked it — independent from the template and from every
other copy, the way templates work in Canva / Magnific.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Board, Edge, FlowTemplate, Node, User
from flowboard.services import access
from flowboard.services import users as users_svc
from flowboard.short_id import generate_unique_short_id

router = APIRouter(prefix="/api/templates", tags=["templates"])

# Transient fields that make no sense in a copy.
_DROP_DATA = {"autoPromptStatus", "aiBriefStatus", "error", "slotErrors"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _snapshot(board_id: int) -> tuple[dict, Optional[str]]:
    with get_session() as s:
        nodes = s.exec(select(Node).where(Node.board_id == board_id)).all()
        edges = s.exec(select(Edge).where(Edge.board_id == board_id)).all()
    snap_nodes, cover = [], None
    for n in nodes:
        data = {k: v for k, v in (n.data or {}).items() if k not in _DROP_DATA}
        if cover is None and n.type in ("image", "visual_asset", "character", "Storyboard"):
            mid = data.get("mediaId")
            if isinstance(mid, str) and mid:
                cover = mid
        snap_nodes.append({
            "id": n.id, "type": n.type, "x": n.x, "y": n.y, "w": n.w, "h": n.h,
            "status": "done" if data.get("mediaId") else "idle",
            "data": data,
        })
    snap_edges = [
        {"source": e.source_id, "target": e.target_id, "kind": e.kind,
         "source_variant_idx": e.source_variant_idx}
        for e in edges
    ]
    return {"nodes": snap_nodes, "edges": snap_edges}, cover


def _authors() -> dict[int, str]:
    with get_session() as s:
        return {u.id: (u.display_name or u.username) for u in s.exec(select(User)).all()}


def _row(t: FlowTemplate, authors: dict[int, str]) -> dict:
    me = access.me()
    return {
        "id": t.id,
        "name": t.name,
        "description": t.description,
        "cover_media_id": t.cover_media_id,
        "node_count": t.node_count,
        "source_board_id": t.source_board_id,
        "created_by": t.created_by,
        "author": authors.get(t.created_by or -1),
        "created_at": t.created_at,
        "updated_at": t.updated_at,
        "use_count": t.use_count,
        "can_edit": _can_edit(t, me),
    }


def _can_edit(t: FlowTemplate, user) -> bool:
    if not users_svc.auth_enabled():
        return True
    if user is None:
        return False
    return user.role == "admin" or t.created_by == user.id


def _require(template_id: int, edit: bool = False) -> FlowTemplate:
    with get_session() as s:
        t = s.get(FlowTemplate, template_id)
    if t is None:
        raise HTTPException(404, "Không thấy mẫu")
    if edit and not _can_edit(t, access.me()):
        raise HTTPException(403, "Chỉ người đăng mẫu hoặc admin được sửa")
    return t


@router.get("")
def list_templates(q: Optional[str] = None) -> list[dict]:
    authors = _authors()
    with get_session() as s:
        rows = s.exec(select(FlowTemplate).order_by(FlowTemplate.updated_at.desc())).all()
    if q:
        ql = q.lower()
        rows = [t for t in rows if ql in t.name.lower() or ql in (t.description or "").lower()]
    return [_row(t, authors) for t in rows]


@router.get("/by-board/{board_id}")
def template_of_board(board_id: int) -> dict:
    access.require_board(board_id)
    with get_session() as s:
        t = s.exec(select(FlowTemplate).where(FlowTemplate.source_board_id == board_id)).first()
    return {"template": _row(t, _authors()) if t else None}


@router.get("/{template_id}")
def get_template(template_id: int) -> dict:
    t = _require(template_id)
    out = _row(t, _authors())
    out["snapshot"] = t.snapshot
    return out


class PublishBody(BaseModel):
    board_id: int
    name: Optional[str] = None
    description: str = ""
    cover_media_id: Optional[str] = None


@router.post("")
def publish(body: PublishBody) -> dict:
    board = access.require_board(body.board_id)
    snap, cover = _snapshot(body.board_id)
    if not snap["nodes"]:
        raise HTTPException(400, "Flow đang trống, chưa có gì để đưa vào thư viện")
    user = access.me()
    t = FlowTemplate(
        name=(body.name or board.name or "Mẫu").strip()[:120],
        description=body.description.strip()[:1000],
        cover_media_id=body.cover_media_id or cover,
        snapshot=snap, node_count=len(snap["nodes"]),
        source_board_id=body.board_id, created_by=user.id if user else None,
    )
    with get_session() as s:
        s.add(t)
        s.commit()
        s.refresh(t)
    return _row(t, _authors())


class UpdateBody(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    cover_media_id: Optional[str] = None
    refresh_from_board: bool = False


@router.patch("/{template_id}")
def update(template_id: int, body: UpdateBody) -> dict:
    t = _require(template_id, edit=True)
    with get_session() as s:
        t = s.get(FlowTemplate, template_id)
        if body.name is not None and body.name.strip():
            t.name = body.name.strip()[:120]
        if body.description is not None:
            t.description = body.description.strip()[:1000]
        if body.cover_media_id is not None:
            t.cover_media_id = body.cover_media_id or None
        if body.refresh_from_board:
            if t.source_board_id is None or s.get(Board, t.source_board_id) is None:
                raise HTTPException(400, "Flow gốc của mẫu này không còn")
            access.require_board(t.source_board_id)
            snap, cover = _snapshot(t.source_board_id)
            t.snapshot, t.node_count = snap, len(snap["nodes"])
            if body.cover_media_id is None and cover:
                t.cover_media_id = cover
        t.updated_at = _now()
        s.add(t)
        s.commit()
        s.refresh(t)
    return _row(t, _authors())


@router.delete("/{template_id}")
def remove(template_id: int) -> dict:
    _require(template_id, edit=True)
    with get_session() as s:
        t = s.get(FlowTemplate, template_id)
        s.delete(t)
        s.commit()
    return {"ok": True}


class UseBody(BaseModel):
    name: Optional[str] = None


@router.post("/{template_id}/use")
def use(template_id: int, body: Optional[UseBody] = None) -> dict:
    """Clone the template into a new flow of the current user."""
    t = _require(template_id)
    user = access.me()
    snap = t.snapshot or {}
    with get_session() as s:
        board = Board(name=((body.name if body else None) or t.name)[:120],
                      owner_user_id=user.id if user else None)
        s.add(board)
        s.commit()
        s.refresh(board)
        id_map: dict[int, int] = {}
        created: list[Node] = []
        for n in snap.get("nodes", []):
            node = Node(
                board_id=board.id,
                short_id=generate_unique_short_id(s, board.id),
                type=n["type"], x=n.get("x", 0), y=n.get("y", 0),
                w=n.get("w", 240), h=n.get("h", 160),
                data=dict(n.get("data") or {}), status=n.get("status") or "idle",
            )
            s.add(node)
            s.flush()
            id_map[n["id"]] = node.id
            created.append(node)
        # Node data that points at other nodes (image input slots, group).
        str_map = {str(k): str(v) for k, v in id_map.items()}
        for node in created:
            data = dict(node.data or {})
            if isinstance(data.get("imageInputs"), list):
                data["imageInputs"] = [str_map.get(str(x), "") if x else x for x in data["imageInputs"]]
            if data.get("groupId") is not None:
                data["groupId"] = str_map.get(str(data["groupId"]))
                if data["groupId"] is None:
                    data.pop("groupId")
            node.data = data
            s.add(node)
        for e in snap.get("edges", []):
            src, dst = id_map.get(e.get("source")), id_map.get(e.get("target"))
            if src and dst:
                s.add(Edge(board_id=board.id, source_id=src, target_id=dst,
                           kind=e.get("kind") or "ref", source_variant_idx=e.get("source_variant_idx")))
        tpl = s.get(FlowTemplate, template_id)
        tpl.use_count = (tpl.use_count or 0) + 1
        s.add(tpl)
        s.commit()
        s.refresh(board)
        return {"board": board, "node_count": len(created)}
