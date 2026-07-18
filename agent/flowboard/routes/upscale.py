"""Image upscale — Flow's upsampleImage (2K / 4K).

Synchronous: POST a source media_id + target resolution. Flow returns the
upscaled image's bytes INLINE (base64 in `data.encodedImage`), not a
media_id — so we decode and stream the bytes straight back to the
browser for download.
"""
import base64
import io
import logging
import os
import subprocess
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from flowboard.services import media as media_service
from flowboard.services.flow_client import flow_client
from flowboard.services.flow_sdk import get_flow_sdk, is_valid_project_id

logger = logging.getLogger(__name__)


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


# ── Real-ESRGAN (AI, natural sharpening) via the Windows ncnn-vulkan exe ─────
# Uses the standalone realesrgan-ncnn-vulkan.exe. We call the WINDOWS exe from
# the WSL agent so it runs on the machine's real GPU (AMD/NVIDIA/Intel) via
# Vulkan — WSL's own GPU passthrough for AMD is unreliable, but a native
# Windows exe invoked through WSL interop uses the GPU directly. Falls back to
# Lanczos when the binary isn't installed.
#   FLOWBOARD_REALESRGAN        — override the exe path
#   FLOWBOARD_REALESRGAN_MODEL  — override the model name (default: full
#                                  realesrgan-x4plus). Any ncnn model dropped
#                                  into the exe's models/ folder works here.
_REALESRGAN_DEFAULT_PATHS = [
    "/mnt/c/flowboard-tools/realesrgan/realesrgan-ncnn-vulkan.exe",
]
# Full Real-ESRGAN photo model — higher fidelity than the tiny "general" one.
# It's a fixed 4× model, so we run it at 4× then downscale to the 2K/4K target.
_REALESRGAN_MODEL = os.environ.get("FLOWBOARD_REALESRGAN_MODEL", "realesrgan-x4plus")
_REALESRGAN_NATIVE_SCALE = 4


def _find_realesrgan() -> Optional[str]:
    env = os.environ.get("FLOWBOARD_REALESRGAN")
    for cand in ([env] if env else []) + _REALESRGAN_DEFAULT_PATHS:
        if cand and os.path.isfile(cand):
            return cand
    return None


def _wslpath_w(path: str) -> str:
    """Translate a WSL path to a Windows path for the exe's arguments."""
    try:
        r = subprocess.run(
            ["wslpath", "-w", path], capture_output=True, text=True, timeout=10
        )
        out = r.stdout.strip()
        return out or path
    except Exception:  # noqa: BLE001
        return path


def _run_realesrgan(raw: bytes, in_ext: str) -> Optional[bytes]:
    """Run realesrgan-ncnn-vulkan on ``raw`` at the model's native scale and
    return the PNG bytes, or None if the binary is unavailable / the call
    failed (caller falls back). Downscaling to the final 2K/4K target happens
    in the endpoint after this."""
    exe = _find_realesrgan()
    if not exe:
        return None
    exe_dir = os.path.dirname(exe)
    work = os.path.join(exe_dir, "_fb_tmp")
    try:
        os.makedirs(work, exist_ok=True)
    except OSError:
        return None
    uid = uuid.uuid4().hex
    in_path = os.path.join(work, f"{uid}.{in_ext}")
    out_path = os.path.join(work, f"{uid}_out.png")
    models = os.path.join(exe_dir, "models")
    try:
        with open(in_path, "wb") as fh:
            fh.write(raw)
        args = [
            exe,
            "-i", _wslpath_w(in_path),
            "-o", _wslpath_w(out_path),
            "-n", _REALESRGAN_MODEL,
            "-s", str(_REALESRGAN_NATIVE_SCALE),
        ]
        if os.path.isdir(models):
            args += ["-m", _wslpath_w(models)]
        proc = subprocess.run(args, capture_output=True, timeout=180)
        if proc.returncode != 0 or not os.path.isfile(out_path):
            logger.warning(
                "realesrgan failed rc=%s stderr=%s",
                proc.returncode,
                proc.stderr.decode(errors="replace")[:300],
            )
            return None
        with open(out_path, "rb") as fh:
            return fh.read()
    except subprocess.TimeoutExpired:
        logger.warning("realesrgan timed out")
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning("realesrgan error: %s", exc)
        return None
    finally:
        for p in (in_path, out_path):
            try:
                os.remove(p)
            except OSError:
                pass


def _resize_png_to_long_edge(png_bytes: bytes, target: int) -> bytes:
    """Downscale (never upscale) a PNG so its long edge == target, using
    Lanczos. Used to bring the model's 4× output down to the 2K/4K target.
    If Pillow is missing or the image is already ≤ target, returns the input
    unchanged."""
    try:
        from PIL import Image
    except ImportError:
        return png_bytes
    try:
        img = Image.open(io.BytesIO(png_bytes))
        img.load()
    except Exception:  # noqa: BLE001
        return png_bytes
    w, h = img.size
    long_edge = max(w, h)
    if long_edge <= target or long_edge == 0:
        return png_bytes
    scale = target / long_edge
    img = img.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


# ── Local, faithful upscale (Real-ESRGAN if available, else Lanczos) ─────────
# Runs entirely on the local machine, instant-ish, no quota. Real-ESRGAN gives
# natural AI sharpening (faithful photo model); when its binary isn't present
# we fall back to Lanczos resampling + a light unsharp mask — bigger + crisper
# with zero invented detail. Either way, nothing is sent to Flow.
_LOCAL_TARGET_LONG_EDGE = {"2K": 2048, "4K": 3840}


class LocalUpscaleBody(BaseModel):
    media_id: str
    resolution: str = "2K"  # "2K" or "4K" — target for the image's long edge


@router.post("/upscale-local")
async def upscale_image_local(body: LocalUpscaleBody):
    if not media_service.is_valid_media_id(body.media_id):
        raise HTTPException(status_code=400, detail="invalid media_id")
    res = body.resolution.upper()
    target = _LOCAL_TARGET_LONG_EDGE.get(res)
    if target is None:
        raise HTTPException(status_code=400, detail="resolution must be 2K or 4K")

    # Prefer the locally cached file — Flow's signed source URLs expire after
    # a short TTL, so fetch_and_cache re-downloading would 404 on older images
    # even though we still have the bytes on disk (that's what the <img> shows).
    raw: Optional[bytes] = None
    cp = media_service.cached_path(body.media_id)
    if cp is not None:
        try:
            raw = cp.read_bytes()
        except OSError:
            raw = None
    if not raw:
        fetched = await media_service.fetch_and_cache(body.media_id)
        if fetched:
            raw = fetched[0]
    if not raw:
        raise HTTPException(status_code=404, detail="media not found")

    # Try Real-ESRGAN first (AI detail). Runs at the model's native 4×, then we
    # downscale to the requested 2K/4K long edge for a clean, sharp result.
    # Falls through to Lanczos when the binary isn't installed.
    in_ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}.get(
        _sniff_image_mime(raw), "png"
    )
    ai = _run_realesrgan(raw, in_ext)
    if ai is not None:
        out_bytes = _resize_png_to_long_edge(ai, target)
        return Response(
            content=out_bytes,
            media_type="image/png",
            headers={
                "Content-Disposition": f'attachment; filename="upscaled-{res}-ai.png"',
            },
        )

    try:
        from PIL import Image, ImageFilter
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="Pillow chưa cài — chạy lại cài đặt agent (make upgrade).",
        )

    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"cannot open image: {exc}")

    # Normalise to a saveable mode (keep alpha if present).
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() else "RGB")

    w, h = img.size
    long_edge = max(w, h)
    if long_edge > 0:
        scale = target / long_edge
        # Only ever enlarge — never shrink an already-large source below itself.
        if scale > 1.0:
            img = img.resize((round(w * scale), round(h * scale)), Image.LANCZOS)

    # Light unsharp mask: makes edges crisp without fabricating detail.
    img = img.filter(ImageFilter.UnsharpMask(radius=2, percent=90, threshold=2))

    out = io.BytesIO()
    img.save(out, format="PNG")
    data = out.getvalue()
    return Response(
        content=data,
        media_type="image/png",
        headers={
            "Content-Disposition": f'attachment; filename="upscaled-{res}-local.png"',
        },
    )
