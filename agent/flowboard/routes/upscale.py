"""Image upscale — Flow's upsampleImage (2K / 4K).

Synchronous: POST a source media_id + target resolution. Flow returns the
upscaled image's bytes INLINE (base64 in `data.encodedImage`), not a
media_id — so we decode and stream the bytes straight back to the
browser for download.
"""
import base64

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from flowboard.services import media as media_service
from flowboard.services.flow_client import flow_client
from flowboard.services.flow_sdk import get_flow_sdk, is_valid_project_id


def _sniff_image_mime(raw: bytes) -> str:
    if raw[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


router = APIRouter(prefix="/api", tags=["upscale"])


class UpscaleBody(BaseModel):
    media_id: str
    project_id: str
    resolution: str = "2K"  # "2K" or "4K"


@router.post("/upscale")
async def upscale_image(body: UpscaleBody):
    if not is_valid_project_id(body.project_id):
        raise HTTPException(status_code=400, detail="invalid project_id")
    if not media_service.is_valid_media_id(body.media_id):
        raise HTTPException(status_code=400, detail="invalid media_id")
    if body.resolution.upper() not in ("2K", "4K"):
        raise HTTPException(status_code=400, detail="resolution must be 2K or 4K")

    tier = flow_client.paygate_tier
    if not tier:
        raise HTTPException(status_code=409, detail="paygate_tier_unknown")

    resp = await get_flow_sdk().upsample_image(
        media_id=body.media_id,
        project_id=body.project_id,
        target_resolution=body.resolution,
        paygate_tier=tier,
    )
    if resp.get("error"):
        raise HTTPException(
            status_code=502,
            detail={"message": resp["error"], "raw": resp.get("raw")},
        )
    b64 = resp.get("image_b64")
    if not isinstance(b64, str) or not b64:
        raise HTTPException(status_code=502, detail={"message": "empty upscale result"})
    try:
        raw = base64.b64decode(b64)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"bad base64 from Flow: {exc}")

    mime = _sniff_image_mime(raw)
    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}.get(mime, "jpg")
    return Response(
        content=raw,
        media_type=mime,
        headers={
            "Content-Disposition": f'attachment; filename="upscaled-{body.resolution.upper()}.{ext}"',
        },
    )
