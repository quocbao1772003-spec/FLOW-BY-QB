"""Library listing — every media asset the agent has seen.

GET /api/assets returns the newest-first list of image/video assets
(the same rows the /media/<id> byte server reads from), powering the
frontend's Library page. Thumbnails are excluded — they're internal
poster crops, not user creations.
"""
from typing import Optional

from fastapi import APIRouter, Query
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Asset

router = APIRouter(prefix="/api/assets", tags=["assets"])


@router.get("")
def list_assets(
    kind: Optional[str] = Query(default=None, pattern="^(image|video)$"),
    limit: int = Query(default=500, ge=1, le=2000),
) -> list[dict]:
    with get_session() as s:
        q = select(Asset).where(Asset.uuid_media_id.is_not(None))  # type: ignore[union-attr]
        if kind:
            q = q.where(Asset.kind == kind)
        else:
            q = q.where(Asset.kind.in_(["image", "video"]))  # type: ignore[attr-defined]
        q = q.order_by(Asset.id.desc()).limit(limit)  # type: ignore[union-attr]
        rows = s.exec(q).all()
    return [
        {
            "id": a.id,
            "media_id": a.uuid_media_id,
            "kind": a.kind,
            "mime": a.mime,
            "node_id": a.node_id,
            "created_at": a.created_at.isoformat() if a.created_at else None,
        }
        for a in rows
    ]
