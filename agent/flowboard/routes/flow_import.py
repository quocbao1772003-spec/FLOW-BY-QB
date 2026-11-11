"""Bring flows from a local (single-user) Flowboard into this server.

The local app's `XUAT-FLOW.bat` writes `flowboard-export.zip`:

    flows.json              [{"name", "nodes": [...], "edges": [...]}]
    media/<uuid>.<ext>      images the nodes point at

Each flow becomes a new board owned by the person who uploads it, exactly as
it was (prompts, positions, wiring, result images), so they can keep working.
Media ids are kept: the bytes land in this server's media cache, and the
first generation that uses one as a reference re-uploads it to that person's
Google Flow project automatically.
"""
from __future__ import annotations

import io
import json
import logging
import re
import zipfile

from fastapi import APIRouter, File, HTTPException, UploadFile

from flowboard.db import get_session
from flowboard.db.models import Board, Edge, Node
from flowboard.services import access
from flowboard.services.media import MEDIA_CACHE_DIR, is_valid_media_id
from flowboard.short_id import generate_unique_short_id

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/flows", tags=["flows"])

MAX_ZIP_BYTES = 95 * 1024 * 1024  # Cloudflare caps a request at 100 MB
MAX_FILES = 5000
_MEDIA_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".webm"}
_NAME_RE = re.compile(r"^media/([0-9a-fA-F-]{36})(\.[A-Za-z0-9]{2,5})$")
_DROP_DATA = {"autoPromptStatus", "aiBriefStatus", "error", "slotErrors", "renderedAt"}


def _import_board(flow: dict, owner_id) -> tuple[int, int]:
    nodes = flow.get("nodes") or []
    edges = flow.get("edges") or []
    with get_session() as s:
        board = Board(name=str(flow.get("name") or "Flow")[:120], owner_user_id=owner_id)
        s.add(board)
        s.commit()
        s.refresh(board)
        id_map: dict[str, int] = {}
        created: list[Node] = []
        for n in nodes:
            if not isinstance(n, dict) or not n.get("type"):
                continue
            data = {k: v for k, v in (n.get("data") or {}).items() if k not in _DROP_DATA}
            status = n.get("status") or ("done" if data.get("mediaId") else "idle")
            if status not in ("done", "idle"):
                status = "done" if data.get("mediaId") else "idle"
            node = Node(
                board_id=board.id,
                short_id=generate_unique_short_id(s, board.id),
                type=str(n["type"]), x=float(n.get("x") or 0), y=float(n.get("y") or 0),
                w=float(n.get("w") or 240), h=float(n.get("h") or 160),
                data=data, status=status,
            )
            s.add(node)
            s.flush()
            id_map[str(n.get("id"))] = node.id
            created.append(node)
        for node in created:
            data = dict(node.data or {})
            if isinstance(data.get("imageInputs"), list):
                data["imageInputs"] = [str(id_map.get(str(x), "")) if x else x for x in data["imageInputs"]]
            if data.get("groupId") is not None:
                gid = id_map.get(str(data["groupId"]))
                if gid is None:
                    data.pop("groupId")
                else:
                    data["groupId"] = str(gid)
            node.data = data
            s.add(node)
        for e in edges:
            src, dst = id_map.get(str(e.get("source"))), id_map.get(str(e.get("target")))
            if src and dst:
                s.add(Edge(board_id=board.id, source_id=src, target_id=dst,
                           kind=e.get("kind") or "ref",
                           source_variant_idx=e.get("source_variant_idx")))
        s.commit()
        return board.id, len(created)


@router.post("/import-zip")
async def import_zip(file: UploadFile = File(...)) -> dict:
    user = access.me()
    raw = await file.read(MAX_ZIP_BYTES + 1)
    if len(raw) > MAX_ZIP_BYTES:
        raise HTTPException(413, "File quá lớn (tối đa 95 MB). Xuất ít flow hơn mỗi lần.")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise HTTPException(400, "Không phải file .zip hợp lệ")
    names = zf.namelist()
    if len(names) > MAX_FILES:
        raise HTTPException(400, "File zip có quá nhiều tệp")
    if "flows.json" not in names:
        raise HTTPException(400, "Thiếu flows.json — hãy tạo file bằng XUAT-FLOW.bat")
    try:
        flows = json.loads(zf.read("flows.json").decode("utf-8"))
    except Exception:
        raise HTTPException(400, "flows.json bị hỏng")
    if not isinstance(flows, list):
        raise HTTPException(400, "flows.json sai định dạng")

    MEDIA_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    media_added = 0
    for name in names:
        m = _NAME_RE.match(name)
        if not m or m.group(2).lower() not in _MEDIA_EXT or not is_valid_media_id(m.group(1)):
            continue
        mid = m.group(1)
        if any(MEDIA_CACHE_DIR.glob(f"{mid}.*")):
            continue
        info = zf.getinfo(name)
        if info.file_size > 60 * 1024 * 1024:
            continue
        (MEDIA_CACHE_DIR / f"{mid}{m.group(2).lower()}").write_bytes(zf.read(name))
        media_added += 1

    boards = []
    owner_id = user.id if user else None
    for flow in flows:
        if not isinstance(flow, dict) or not flow.get("nodes"):
            continue
        bid, count = _import_board(flow, owner_id)
        boards.append({"id": bid, "name": str(flow.get("name") or "Flow")[:120], "node_count": count})
    logger.info("flow import: %d boards, %d media by user %s", len(boards), media_added, owner_id)
    return {"boards": boards, "media_added": media_added}
