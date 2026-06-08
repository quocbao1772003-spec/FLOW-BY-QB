"""Image upscale — Flow's upsampleImage (2K / 4K).

Synchronous: POST a source media_id + target resolution, get back the
upscaled image's new media_id (~10 s). The new bytes are lazily fetched
and re-served by the media byte server like any other Flow media.
"""
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from flowboard.services import media as media_service
from flowboard.services.flow_client import flow_client
from flowboard.services.flow_sdk import get_flow_sdk, is_valid_project_id

router = APIRouter(prefix="/api", tags=["upscale"])


class UpscaleBody(BaseModel):
    media_id: str
    project_id: str
    # "2K" or "4K".
    resolution: str = "2K"


@router.post("/upscale")
async def upscale_image(body: UpscaleBody):
    if not is_valid_project_id(body.project_id):
        raise HTTPException(status_code=400, detail="invalid project_id")
    if body.resolution.upper() not in ("2K", "4K"):
        raise HTTPException(status_code=400, detail="resolution must be 2K or 4K")

    tier = flow_client.paygate_tier
    if not tier:
        # Same recovery path as generation — the extension must observe a
        # paid plan first.
        raise HTTPException(
            status_code=409,
            detail="paygate_tier_unknown",
        )

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
    new_media_id: Optional[str] = resp.get("media_id")
    if not isinstance(new_media_id, str) or not media_service.is_valid_media_id(new_media_id):
        raise HTTPException(
            status_code=502,
            detail={"message": "invalid media_id from upscale", "raw": resp.get("raw")},
        )
    return {"media_id": new_media_id, "resolution": body.resolution.upper()}
