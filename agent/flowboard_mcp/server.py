"""Flowboard MCP server — lets Claude, ChatGPT or any MCP client drive the
whole Flowboard app: boards, nodes, edges, image / video generation,
uploads, downloads, upscale, vision, prompt tools, reference library, and a
raw API escape hatch for anything else.

It talks to the local Flowboard agent over HTTP (default
http://127.0.0.1:8101), so the app must be running (MO-APP.bat).
"""
from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Literal, Optional

from mcp.server.mcpserver import Image, MCPServer
from mcp_types import ToolAnnotations

from flowboard_mcp.client import FlowboardClient, FlowboardError

INSTRUCTIONS = """\
Flowboard is the user's own local image/video generation board built on
Google Flow (Nano Banana image models, Veo / Omni Flash video). A board
holds nodes (image, video, visual_asset, character, prompt, note,
Storyboard, group) joined by edges; an edge from an image-bearing node into
an image/video node feeds it as a reference.

Typical workflow:
1. flowboard_status → check the app, Chrome extension and Flow account.
2. list_boards / get_board (or create_board) to find where to work.
3. upload_image to bring reference photos in, generate_image with
   ref_node_ids to compose from them, view_image to look at results.
4. edit_image to refine, generate_video to animate, save_media / upscale_image
   to export.
Generation spends the user's Google Flow credits: don't fire large batches
the user did not ask for. Long jobs return a request_id; call
wait_for_request to keep waiting. Results are written onto the node and the
open Flowboard UI refreshes on its own.
Anything not covered by a dedicated tool can be done with flowboard_api.
"""

logging.getLogger("httpx").setLevel(logging.WARNING)

mcp = MCPServer(
    name="flowboard",
    title="Flowboard",
    instructions=INSTRUCTIONS,
    version="1.0.0",
)
fb = FlowboardClient()

READ = ToolAnnotations(read_only_hint=True, open_world_hint=False)
WRITE = ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=False)
SPEND = ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=True)
DESTROY = ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False)

# ── constants / helpers ──────────────────────────────────────────────────

NODE_TYPES = ("image", "video", "visual_asset", "character", "prompt", "note",
              "Storyboard", "assistant", "group")
NodeType = Literal["image", "video", "visual_asset", "character", "prompt", "note",
                   "Storyboard", "assistant", "group"]
TYPE_TITLE = {
    "character": "Character", "image": "Image", "video": "Video", "prompt": "Prompt",
    "note": "Note", "visual_asset": "Visual asset", "Storyboard": "Storyboard",
    "assistant": "Assistant", "group": "New group",
}
MEDIA_TYPES = {"image", "character", "visual_asset", "Storyboard", "video"}
REF_SOURCE_TYPES = {"character", "image", "visual_asset", "Storyboard"}
TERMINAL = {"done", "failed", "timeout", "canceled"}

IMAGE_MODELS = {
    "NANO_BANANA_PRO": "NANO_BANANA_PRO", "PRO": "NANO_BANANA_PRO",
    "NANO_BANANA_2_1": "NANO_BANANA_2_1", "2_1": "NANO_BANANA_2_1",
    "NANO_BANANA_2": "NANO_BANANA_2", "2": "NANO_BANANA_2",
    "NANO_BANANA_2_LITE": "NANO_BANANA_2_LITE", "LITE": "NANO_BANANA_2_LITE",
    "2_LITE": "NANO_BANANA_2_LITE",
}
DEFAULT_IMAGE_MODEL = os.getenv("FLOWBOARD_MCP_IMAGE_MODEL", "NANO_BANANA_2")

IMAGE_ASPECTS = {
    "16:9": "IMAGE_ASPECT_RATIO_LANDSCAPE", "LANDSCAPE": "IMAGE_ASPECT_RATIO_LANDSCAPE",
    "9:16": "IMAGE_ASPECT_RATIO_PORTRAIT", "PORTRAIT": "IMAGE_ASPECT_RATIO_PORTRAIT",
    "1:1": "IMAGE_ASPECT_RATIO_SQUARE", "SQUARE": "IMAGE_ASPECT_RATIO_SQUARE",
    "4:3": "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE",
    "3:4": "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR",
}
VIDEO_ASPECTS = {
    "16:9": "VIDEO_ASPECT_RATIO_LANDSCAPE", "LANDSCAPE": "VIDEO_ASPECT_RATIO_LANDSCAPE",
    "4:3": "VIDEO_ASPECT_RATIO_LANDSCAPE",
    "9:16": "VIDEO_ASPECT_RATIO_PORTRAIT", "PORTRAIT": "VIDEO_ASPECT_RATIO_PORTRAIT",
    "3:4": "VIDEO_ASPECT_RATIO_PORTRAIT", "1:1": "VIDEO_ASPECT_RATIO_PORTRAIT",
}

EXPORT_DIR = Path(os.getenv("FLOWBOARD_EXPORT_DIR", str(Path.home() / "Pictures" / "Flowboard")))


def _image_aspect(value: Optional[str]) -> str:
    if not value:
        return "IMAGE_ASPECT_RATIO_SQUARE"
    v = value.strip().upper()
    if v.startswith("IMAGE_ASPECT_RATIO_"):
        return v
    if v.startswith("VIDEO_ASPECT_RATIO_"):
        return v.replace("VIDEO_", "IMAGE_", 1)
    if v in IMAGE_ASPECTS:
        return IMAGE_ASPECTS[v]
    raise FlowboardError(f"aspect_ratio không hợp lệ: {value!r}. Dùng 1:1, 16:9, 9:16, 4:3 hoặc 3:4.")


def _video_aspect(value: Optional[str]) -> str:
    if not value:
        return "VIDEO_ASPECT_RATIO_PORTRAIT"
    v = value.strip().upper()
    if v.startswith("VIDEO_ASPECT_RATIO_"):
        return v
    if v.startswith("IMAGE_ASPECT_RATIO_"):
        return "VIDEO_ASPECT_RATIO_PORTRAIT" if ("PORTRAIT" in v or "SQUARE" in v) else "VIDEO_ASPECT_RATIO_LANDSCAPE"
    if v in VIDEO_ASPECTS:
        return VIDEO_ASPECTS[v]
    raise FlowboardError(f"aspect_ratio video không hợp lệ: {value!r}. Dùng 16:9 hoặc 9:16.")


def _image_model(value: Optional[str]) -> str:
    if not value:
        return DEFAULT_IMAGE_MODEL
    key = re.sub(r"[\s.\-]+", "_", value.strip().upper()).replace("NANOBANANA", "NANO_BANANA")
    key = key.replace("🍌", "").strip("_")
    if key in IMAGE_MODELS:
        return IMAGE_MODELS[key]
    raise FlowboardError(
        f"model không hợp lệ: {value!r}. Dùng NANO_BANANA_PRO, NANO_BANANA_2_1, NANO_BANANA_2 hoặc NANO_BANANA_2_LITE."
    )


def _node_media(node: dict) -> list[str]:
    data = node.get("data") or {}
    out = [m for m in (data.get("mediaIds") or []) if isinstance(m, str) and m]
    mid = data.get("mediaId")
    if isinstance(mid, str) and mid and mid not in out:
        out.insert(0, mid)
    return out


def _summarize_node(node: dict, full: bool = False) -> dict:
    data = node.get("data") or {}
    out: dict[str, Any] = {
        "id": node.get("id"),
        "short_id": node.get("short_id"),
        "type": node.get("type"),
        "title": data.get("title") or TYPE_TITLE.get(node.get("type", ""), ""),
        "status": node.get("status"),
        "x": node.get("x"), "y": node.get("y"), "w": node.get("w"), "h": node.get("h"),
    }
    prompt = data.get("prompt")
    if prompt:
        out["prompt"] = prompt if full or len(prompt) <= 300 else prompt[:300] + "…"
    media = _node_media(node)
    if media:
        out["media_ids"] = media
    for k in ("aspectRatio", "imageModel", "videoQuality", "error", "groupId", "imageInputs"):
        if data.get(k) not in (None, "", []):
            out[k] = data[k]
    if full:
        out["data"] = data
    return out


async def _board(board_id: int) -> dict:
    return await fb.get(f"/api/boards/{board_id}")


async def _node(node_id: int) -> dict:
    return await fb.get(f"/api/nodes/{node_id}")


async def _project_id(board_id: int) -> str:
    resp = await fb.post(f"/api/boards/{board_id}/project")
    pid = resp.get("flow_project_id")
    if not pid:
        raise FlowboardError(f"Không tạo được Flow project cho board {board_id}: {resp}")
    return pid


_GAP = 60.0
_MIN_H = 340.0  # image cards render taller than the stored 160px default


def _rect(n: dict) -> tuple[float, float, float, float]:
    x, y = float(n.get("x") or 0), float(n.get("y") or 0)
    w = max(float(n.get("w") or 240), 240.0)
    h = max(float(n.get("h") or 160), _MIN_H)
    return x, y, w, h


def _free_spot(nodes: list[dict], near: Optional[dict] = None, dy: float = 0.0) -> tuple[float, float]:
    """A spot that doesn't overlap existing cards: right of `near` (stepping
    down until clear), or right of everything on the board."""
    nodes = [n for n in nodes if n.get("type") != "group"]
    if near is not None:
        nx, ny, nw, _ = _rect(near)
        x, y = nx + nw + 120.0, ny + dy
    elif nodes:
        x = max(_rect(n)[0] + _rect(n)[2] for n in nodes) + 120.0
        y = min(_rect(n)[1] for n in nodes) + dy
    else:
        return 0.0, 0.0
    for _ in range(200):
        hit = next((n for n in nodes if _overlaps((x, y, 240.0, _MIN_H), _rect(n))), None)
        if hit is None:
            return x, y
        y = _rect(hit)[1] + _rect(hit)[3] + _GAP
    return x, y


def _overlaps(a: tuple, b: tuple) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return ax < bx + bw + _GAP and bx < ax + aw + _GAP and ay < by + bh + _GAP and by < ay + ah + _GAP


def _upstream_refs(board: dict, target: dict) -> list[str]:
    """Same rules as the UI (store/generation.ts collectUpstreamRefMediaIds)."""
    nodes = {n["id"]: n for n in board.get("nodes", [])}
    edges = board.get("edges", [])
    tid = target["id"]

    def pick(src: dict, pinned: Optional[int]) -> Optional[str]:
        data = src.get("data") or {}
        variants = data.get("mediaIds") or []
        if isinstance(pinned, int) and 0 <= pinned < len(variants) and isinstance(variants[pinned], str) and variants[pinned]:
            return variants[pinned]
        if isinstance(data.get("mediaId"), str) and data["mediaId"]:
            return data["mediaId"]
        for v in variants:
            if isinstance(v, str) and v:
                return v
        return None

    slots = (target.get("data") or {}).get("imageInputs")
    ids: list[str] = []
    if target.get("type") == "image" and isinstance(slots, list) and any(slots):
        for sid in slots:
            if not sid:
                continue
            try:
                src = nodes.get(int(sid))
            except (TypeError, ValueError):
                src = None
            if not src or src.get("type") not in REF_SOURCE_TYPES:
                continue
            edge = next((e for e in edges if e["source_id"] == src["id"] and e["target_id"] == tid), None)
            chosen = pick(src, edge.get("source_variant_idx") if edge else None)
            if chosen:
                ids.append(chosen)
        return ids
    for e in edges:
        if e["target_id"] != tid:
            continue
        src = nodes.get(e["source_id"])
        if not src or src.get("type") not in REF_SOURCE_TYPES:
            continue
        chosen = pick(src, e.get("source_variant_idx"))
        if chosen:
            ids.append(chosen)
    return ids


async def _connect(board_id: int, source: dict, target: dict, variant_index: Optional[int] = None,
                   slot: Optional[int] = None) -> dict:
    edge = await fb.post("/api/edges", json={
        "board_id": board_id, "source_id": source["id"], "target_id": target["id"],
        "kind": "ref", "source_variant_idx": variant_index,
    })
    if target.get("type") == "image" and source.get("type") in REF_SOURCE_TYPES:
        fresh = await _node(target["id"])
        data = fresh.get("data") or {}
        slots = list(data.get("imageInputs") or [])
        sid = str(source["id"])
        if sid not in slots:
            if slot is not None and slot >= 0:
                while len(slots) <= slot:
                    slots.append("")
                slots[slot] = sid
            else:
                try:
                    slots[slots.index("")] = sid
                except ValueError:
                    slots.append(sid)
            count = max(int(data.get("imageInputCount") or 3), len(slots))
            await fb.patch(f"/api/nodes/{target['id']}", json={"data": {"imageInputs": slots, "imageInputCount": count}})
    return edge


async def _thumb(media_id: str, max_size: int = 768) -> Optional[Image]:
    try:
        raw, ctype = await fb.media_bytes(media_id)
    except FlowboardError:
        return None
    if not ctype.startswith("image/"):
        return None
    try:
        from PIL import Image as PILImage

        im = PILImage.open(io.BytesIO(raw))
        im.load()
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        im.thumbnail((max_size, max_size))
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=85)
        return Image(data=buf.getvalue(), format="jpeg")
    except Exception:  # noqa: BLE001
        fmt = ctype.split("/", 1)[1].split(";")[0]
        return Image(data=raw, format=fmt)


async def _wait(request_id: int, timeout_s: float) -> dict:
    from flowboard_mcp.client import request_token

    if request_token.get():
        # Hosted behind Cloudflare: one HTTP response must finish < 100 s.
        # The tool then returns the request_id and the AI keeps waiting.
        timeout_s = min(timeout_s, 80.0)
    deadline = time.monotonic() + max(0.0, timeout_s)
    while True:
        req = await fb.get(f"/api/requests/{request_id}")
        if req.get("status") in TERMINAL or time.monotonic() >= deadline:
            return req
        await asyncio.sleep(2.0)


async def _report(req: dict, node_id: Optional[int], return_images: bool) -> list:
    status = req.get("status")
    result = req.get("result") or {}
    out: dict[str, Any] = {
        "request_id": req.get("id"),
        "status": status,
        "type": req.get("type"),
        "node_id": node_id,
    }
    if result.get("flow_account"):
        out["flow_account"] = result["flow_account"]
    if result.get("account_switches"):
        out["account_switches"] = result["account_switches"]
    if status == "done":
        out["media_ids"] = result.get("media_ids")
        if result.get("partial_error"):
            out["partial_error"] = result["partial_error"]
        if result.get("slot_errors") and any(result["slot_errors"]):
            out["slot_errors"] = result["slot_errors"]
    elif status in ("failed", "timeout"):
        out["error"] = req.get("error")
        out["hint"] = _error_hint(req.get("error") or "")
    elif status == "canceled":
        out["note"] = "Request đã bị huỷ."
    else:
        out["note"] = ("Vẫn đang chạy. Gọi wait_for_request(request_id) để chờ tiếp; "
                       "kết quả sẽ tự ghi vào node khi xong.")
    content: list = [out]
    if return_images and status == "done":
        for mid in [m for m in (result.get("media_ids") or []) if m][:4]:
            img = await _thumb(mid)
            if img is not None:
                content.append(img)
    return content


def _error_hint(err: str) -> str:
    e = err.upper()
    if "PAYGATE_TIER_UNKNOWN" in e:
        return "Mở labs.google/flow một lần trong Chrome để extension nhận diện gói Flow, rồi thử lại."
    if "ALL_ACCOUNTS_QUOTA" in e:
        return "Mọi tài khoản Flow đã hết lượt hôm nay. Thêm tài khoản (Chrome profile khác) hoặc chờ reset."
    if "QUOTA" in e:
        return "Hết hạn mức hôm nay. Bật tự đổi tài khoản (set_account_auto_switch) hoặc thử model khác."
    if "UNSAFE" in e or "FILTER" in e or "POLICY" in e:
        return "Bị bộ lọc nội dung của Google chặn. Sửa prompt hoặc ảnh tham chiếu."
    if "EXTENSION" in e or "NOT_CONNECTED" in e or "WS" in e:
        return "Chrome extension Flowboard Bridge chưa kết nối. Mở Chrome có extension và đăng nhập Flow."
    if "CAPTCHA" in e or "RECAPTCHA" in e:
        return "Flow yêu cầu captcha. Mở tab labs.google/flow trong Chrome rồi thử lại."
    return ""


async def _mark_queued(node_id: int, prompt: str, variants: int) -> None:
    await fb.patch(f"/api/nodes/{node_id}", json={
        "status": "queued",
        "data": {"prompt": prompt, "variantCount": variants, "error": None,
                 "mediaIds": None, "mediaId": None},
    })


async def _dispatch(node_id: int, rtype: str, params: dict) -> dict:
    params = {**params, "_finalize_node": True}
    try:
        return await fb.post("/api/requests", json={"type": rtype, "node_id": node_id, "params": params})
    except FlowboardError as exc:
        await fb.patch(f"/api/nodes/{node_id}", json={"status": "error", "data": {"error": str(exc)[:300]}})
        raise


def _resolve_media_from_node(node: dict, variant_index: Optional[int]) -> str:
    data = node.get("data") or {}
    variants = data.get("mediaIds") or []
    if variant_index is not None:
        if 0 <= variant_index < len(variants) and variants[variant_index]:
            return variants[variant_index]
        raise FlowboardError(f"Node {node['id']} không có variant {variant_index} (có {len(variants)}).")
    media = _node_media(node)
    if not media:
        raise FlowboardError(f"Node {node['id']} chưa có ảnh/video.")
    return media[0]


# ── status ───────────────────────────────────────────────────────────────


@mcp.tool(annotations=READ)
async def flowboard_status() -> dict:
    """Check that Flowboard is running: agent health, Chrome extension link,
    the signed-in Google Flow account / plan tier, and the list of boards."""
    health = await fb.get("/api/health")
    try:
        me = await fb.get("/api/auth/me")
    except FlowboardError as exc:
        me = {"error": str(exc)}
    boards = await fb.get("/api/boards")
    try:
        sync = await fb.get("/api/sync")
    except FlowboardError:
        sync = None
    try:
        acc = await fb.get("/api/accounts")
        accounts = {
            "auto_switch": acc.get("auto_rotate"),
            "active": acc.get("active"),
            "list": [{"email": a.get("key"), "connected": a.get("connected"),
                      "out_of_quota": a.get("exhausted")} for a in acc.get("accounts", [])],
        }
    except FlowboardError:
        accounts = None
    return {
        "flow_accounts": accounts,
        "agent": fb.base_url,
        "extension_connected": health.get("extension_connected"),
        "account": me,
        "boards": [{"id": b["id"], "name": b["name"]} for b in boards],
        "default_image_model": DEFAULT_IMAGE_MODEL,
        "export_folder": str(EXPORT_DIR),
        "ui_live_sync": sync is not None,
    }


# ── Google Flow accounts ─────────────────────────────────────────────────


@mcp.tool(annotations=READ)
async def list_flow_accounts() -> dict:
    """Google Flow accounts connected to Flowboard (one per Chrome profile
    running the extension): which one is in use, which are out of today's
    quota, and whether automatic switching is on."""
    return await fb.get("/api/accounts")


@mcp.tool(annotations=WRITE)
async def use_flow_account(email: Optional[str] = None) -> dict:
    """Prefer this Google Flow account for the next jobs (null = automatic).
    With automatic switching on, a preferred account that runs out of quota
    is still skipped."""
    return await fb.post("/api/accounts/select", json={"key": email})


@mcp.tool(annotations=WRITE)
async def set_account_auto_switch(enabled: bool) -> dict:
    """Turn automatic account switching on/off. On: an image job that hits
    the daily quota is re-run on the next account."""
    return await fb.post("/api/accounts/settings", json={"auto_rotate": enabled})


@mcp.tool(annotations=WRITE)
async def reset_account_quota(email: Optional[str] = None) -> dict:
    """Clear the "out of quota" mark on one account (or all when email is null)."""
    return await fb.post("/api/accounts/reset", json={"key": email})


# ── boards ───────────────────────────────────────────────────────────────


@mcp.tool(annotations=READ)
async def list_boards() -> dict:
    """List all boards (projects) with id, name and node count."""
    boards = await fb.get("/api/boards")
    out = []
    for b in boards:
        try:
            detail = await _board(b["id"])
            count = len(detail.get("nodes", []))
        except FlowboardError:
            count = None
        out.append({"id": b["id"], "name": b["name"], "nodes": count, "created_at": b.get("created_at")})
    return {"boards": out}


@mcp.tool(annotations=READ)
async def get_board(board_id: int, full: bool = False) -> dict:
    """Get a board's nodes and edges. Each node shows id, type, title, status,
    prompt, media_ids and position. full=true includes every raw data field."""
    detail = await _board(board_id)
    return {
        "board": detail["board"],
        "nodes": [_summarize_node(n, full) for n in detail.get("nodes", [])],
        "edges": [
            {"id": e["id"], "source_id": e["source_id"], "target_id": e["target_id"],
             "kind": e.get("kind"), "variant_index": e.get("source_variant_idx")}
            for e in detail.get("edges", [])
        ],
    }


@mcp.tool(annotations=WRITE)
async def create_board(name: str, open_in_ui: bool = True) -> dict:
    """Create a new board. open_in_ui switches the open Flowboard window to it."""
    board = await fb.post("/api/boards", json={"name": name})
    if open_in_ui:
        await fb.post("/api/sync/focus", json={"board_id": board["id"]})
    return board


@mcp.tool(annotations=WRITE)
async def rename_board(board_id: int, name: str) -> dict:
    """Rename a board."""
    return await fb.patch(f"/api/boards/{board_id}", json={"name": name})


@mcp.tool(annotations=DESTROY)
async def delete_board(board_id: int, confirm: bool = False) -> dict:
    """Permanently delete a board with all its nodes, edges and history.
    Only call after the user clearly asked for it; pass confirm=true."""
    if not confirm:
        raise FlowboardError("Xoá board là vĩnh viễn. Hỏi lại người dùng rồi gọi với confirm=true.")
    return await fb.delete(f"/api/boards/{board_id}")


@mcp.tool(annotations=WRITE)
async def open_board_in_ui(board_id: int) -> dict:
    """Switch the open Flowboard browser window to this board."""
    await fb.post("/api/sync/focus", json={"board_id": board_id})
    return {"ok": True, "board_id": board_id}


# ── nodes & edges ────────────────────────────────────────────────────────


@mcp.tool(annotations=READ)
async def get_node(node_id: int) -> dict:
    """Get one node with all of its data fields."""
    return _summarize_node(await _node(node_id), full=True)


@mcp.tool(annotations=WRITE)
async def create_node(
    board_id: int,
    type: NodeType = "image",
    title: Optional[str] = None,
    prompt: Optional[str] = None,
    text: Optional[str] = None,
    x: Optional[float] = None,
    y: Optional[float] = None,
    w: Optional[float] = None,
    h: Optional[float] = None,
    data: Optional[dict] = None,
) -> dict:
    """Create a node. Types: image (generate images), video, visual_asset /
    character (hold uploaded reference images), prompt, note, Storyboard,
    group. Position is chosen automatically when x/y are omitted. text is the
    body of a note/prompt node (a prompt node connected into an image node
    supplies its prompt); data sets any extra raw field."""
    payload_data: dict[str, Any] = {"title": title or TYPE_TITLE.get(type, type)}
    if prompt:
        payload_data["prompt"] = prompt
    if text:
        payload_data["prompt"] = text
    if data:
        payload_data.update(data)
    if x is None or y is None:
        detail = await _board(board_id)
        ax, ay = _free_spot(detail.get("nodes", []))
        x = ax if x is None else x
        y = ay if y is None else y
    body: dict[str, Any] = {"board_id": board_id, "type": type, "x": x, "y": y, "data": payload_data}
    if w:
        body["w"] = w
    if h:
        body["h"] = h
    return _summarize_node(await fb.post("/api/nodes", json=body), full=True)


@mcp.tool(annotations=WRITE)
async def update_node(
    node_id: int,
    title: Optional[str] = None,
    prompt: Optional[str] = None,
    text: Optional[str] = None,
    x: Optional[float] = None,
    y: Optional[float] = None,
    w: Optional[float] = None,
    h: Optional[float] = None,
    status: Optional[Literal["idle", "queued", "running", "done", "error"]] = None,
    data_patch: Optional[dict] = None,
) -> dict:
    """Edit a node: title, prompt, note text, position, size, status, or any
    raw data field via data_patch (shallow merge; a null value deletes a key)."""
    data: dict[str, Any] = dict(data_patch or {})
    if title is not None:
        data["title"] = title
    if prompt is not None:
        data["prompt"] = prompt
    if text is not None:
        data["prompt"] = text
    body: dict[str, Any] = {k: v for k, v in {"x": x, "y": y, "w": w, "h": h, "status": status}.items() if v is not None}
    if data:
        body["data"] = data
    if not body:
        raise FlowboardError("Không có gì để cập nhật.")
    return _summarize_node(await fb.patch(f"/api/nodes/{node_id}", json=body), full=True)


@mcp.tool(annotations=DESTROY)
async def delete_node(node_id: int) -> dict:
    """Delete a node and its edges (generation history and media stay)."""
    return await fb.delete(f"/api/nodes/{node_id}")


@mcp.tool(annotations=WRITE)
async def connect_nodes(
    source_node_id: int,
    target_node_id: int,
    slot: Optional[int] = None,
    variant_index: Optional[int] = None,
) -> dict:
    """Draw an edge so the source's image feeds the target as a reference.
    slot = 0-based image input slot on an image node ("Image 1" = 0);
    variant_index pins which variant of a multi-variant source is used."""
    src = await _node(source_node_id)
    tgt = await _node(target_node_id)
    if src["board_id"] != tgt["board_id"]:
        raise FlowboardError("Hai node phải cùng board.")
    return await _connect(src["board_id"], src, tgt, variant_index, slot)


@mcp.tool(annotations=WRITE)
async def set_edge_variant(edge_id: int, variant_index: Optional[int]) -> dict:
    """Change which variant of the source node an existing edge uses (null = default)."""
    return await fb.patch(f"/api/edges/{edge_id}", json={"source_variant_idx": variant_index})


@mcp.tool(annotations=DESTROY)
async def delete_edge(edge_id: int) -> dict:
    """Remove an edge between two nodes."""
    resp = await fb.delete(f"/api/edges/{edge_id}")
    return resp


# ── generation ───────────────────────────────────────────────────────────


@mcp.tool(annotations=SPEND, structured_output=False)
async def generate_image(
    prompt: str,
    board_id: Optional[int] = None,
    node_id: Optional[int] = None,
    ref_node_ids: Optional[list[int]] = None,
    ref_media_ids: Optional[list[str]] = None,
    aspect_ratio: str = "1:1",
    variants: int = 1,
    variant_prompts: Optional[list[str]] = None,
    model: Optional[str] = None,
    title: Optional[str] = None,
    wait_seconds: int = 90,
    return_images: bool = True,
) -> list:
    """Generate images with Google Flow (Nano Banana) onto an image node.

    Give node_id to (re)generate an existing image node, or board_id to make
    a new image node. ref_node_ids are wired in as references (Image 1, 2, 3…
    in that order, so the prompt can say "image 1", "image 2"); when omitted
    the node's existing upstream connections are used. ref_media_ids adds raw
    media ids. aspect_ratio: 1:1, 16:9, 9:16, 4:3, 3:4. variants: 1–4.
    variant_prompts gives each variant its own prompt. model:
    NANO_BANANA_PRO, NANO_BANANA_2_1, NANO_BANANA_2 (default) or
    NANO_BANANA_2_LITE. Waits up to wait_seconds, then returns request_id if
    still running. Spends Flow credits."""
    if not prompt.strip():
        raise FlowboardError("prompt trống.")
    variants = max(1, min(int(variants or 1), 4))
    aspect = _image_aspect(aspect_ratio)
    image_model = _image_model(model)

    if node_id is None:
        if board_id is None:
            raise FlowboardError("Cần node_id hoặc board_id.")
        detail = await _board(board_id)
        near = None
        if ref_node_ids:
            near = next((n for n in detail["nodes"] if n["id"] == ref_node_ids[0]), None)
        x, y = _free_spot(detail.get("nodes", []), near)
        target = await fb.post("/api/nodes", json={
            "board_id": board_id, "type": "image", "x": x, "y": y,
            "data": {"title": title or "Image", "prompt": prompt, "aspectRatio": aspect},
        })
    else:
        target = await _node(node_id)
        if target.get("type") not in ("image", "Storyboard", "character", "visual_asset"):
            raise FlowboardError(f"Node {node_id} là {target.get('type')}, không tạo ảnh được.")
        if title:
            await fb.patch(f"/api/nodes/{node_id}", json={"data": {"title": title}})
    board_id = target["board_id"]

    if ref_node_ids:
        existing = await _board(board_id)
        by_id = {n["id"]: n for n in existing["nodes"]}
        have = {(e["source_id"], e["target_id"]) for e in existing["edges"]}
        for rid in ref_node_ids:
            src = by_id.get(rid)
            if src is None:
                raise FlowboardError(f"Ref node {rid} không có trên board {board_id}.")
            if not _node_media(src):
                raise FlowboardError(f"Ref node {rid} chưa có ảnh.")
            if (rid, target["id"]) not in have:
                await fb.post("/api/edges", json={
                    "board_id": board_id, "source_id": rid, "target_id": target["id"], "kind": "ref",
                })
        if target.get("type") == "image":
            # Slot order = ref_node_ids order → "image 1, image 2…" in the prompt.
            fresh = await _node(target["id"])
            slots = [str(r) for r in ref_node_ids]
            others = [s for s in ((fresh.get("data") or {}).get("imageInputs") or []) if s and s not in slots]
            await fb.patch(f"/api/nodes/{target['id']}", json={"data": {
                "imageInputs": slots + others,
                "imageInputCount": max(3, len(slots) + len(others)),
            }})

    board = await _board(board_id)
    fresh_target = next(n for n in board["nodes"] if n["id"] == target["id"])
    refs = _upstream_refs(board, fresh_target)
    for m in ref_media_ids or []:
        if m and m not in refs:
            refs.append(m)

    await _project_id(board_id)
    await _mark_queued(target["id"], prompt, variants)
    params: dict[str, Any] = {
        "prompt": prompt,
        "aspect_ratio": aspect,
        "variant_count": variants,
        "image_model": image_model,
    }
    if refs:
        params["ref_media_ids"] = refs
    if variant_prompts:
        params["prompts"] = [p for p in variant_prompts if p and p.strip()]
    req = await _dispatch(target["id"], "gen_image", params)
    req = await _wait(req["id"], wait_seconds)
    content = await _report(req, target["id"], return_images)
    content[0]["board_id"] = board_id
    content[0]["refs_used"] = len(refs)
    content[0]["model"] = image_model
    return content


@mcp.tool(annotations=SPEND, structured_output=False)
async def edit_image(
    node_id: int,
    prompt: str,
    variant_index: Optional[int] = None,
    ref_node_ids: Optional[list[int]] = None,
    aspect_ratio: Optional[str] = None,
    model: Optional[str] = None,
    as_new_node: bool = True,
    wait_seconds: int = 90,
    return_images: bool = True,
) -> list:
    """Edit / refine an existing image with an instruction ("make the nails
    glossy red", "remove the background text"). variant_index picks which
    variant to edit. as_new_node=true (default) keeps the original and puts
    the result in a new connected node; false replaces the node's image.
    ref_node_ids add extra reference images. Spends Flow credits."""
    src = await _node(node_id)
    source_media = _resolve_media_from_node(src, variant_index)
    data = src.get("data") or {}
    aspect = _image_aspect(aspect_ratio or data.get("aspectRatio") or "1:1")
    image_model = _image_model(model)
    board_id = src["board_id"]

    refs: list[str] = []
    if ref_node_ids:
        for rid in ref_node_ids:
            refs.append(_resolve_media_from_node(await _node(rid), None))

    if as_new_node:
        detail = await _board(board_id)
        x, y = _free_spot(detail["nodes"], src)
        target = await fb.post("/api/nodes", json={
            "board_id": board_id, "type": "image", "x": x, "y": y,
            "data": {"title": f"{data.get('title') or 'Image'} (edit)", "prompt": prompt, "aspectRatio": aspect},
        })
        await fb.post("/api/edges", json={
            "board_id": board_id, "source_id": src["id"], "target_id": target["id"],
            "kind": "ref", "source_variant_idx": variant_index,
        })
    else:
        target = src

    await _project_id(board_id)
    await _mark_queued(target["id"], prompt, 1)
    req = await _dispatch(target["id"], "edit_image", {
        "prompt": prompt,
        "source_media_id": source_media,
        "ref_media_ids": refs,
        "aspect_ratio": aspect,
        "image_model": image_model,
    })
    req = await _wait(req["id"], wait_seconds)
    content = await _report(req, target["id"], return_images)
    content[0]["source_media_id"] = source_media
    return content


@mcp.tool(annotations=SPEND, structured_output=False)
async def generate_video(
    prompt: str,
    source_node_ids: list[int],
    model: Literal["veo", "omni_flash"] = "veo",
    quality: Literal["fast", "lite", "quality", "lite_relaxed"] = "fast",
    duration_s: Literal[4, 6, 8, 10] = 8,
    aspect_ratio: str = "9:16",
    variant_index: Optional[int] = None,
    all_variants: bool = False,
    node_id: Optional[int] = None,
    title: Optional[str] = None,
    wait_seconds: int = 50,
) -> dict:
    """Make a video from images. model="veo" (Veo 3.1 image→video): the
    first source node's image is the start frame; all_variants=true makes
    one clip per variant; quality fast/lite/quality/lite_relaxed.
    model="omni_flash": every source node is an ingredient reference;
    duration_s 4/6/8/10. aspect_ratio 9:16 or 16:9. A new video node is
    created and connected unless node_id is given. Videos take minutes:
    use wait_for_request with the returned request_id. Spends Flow credits."""
    if not source_node_ids:
        raise FlowboardError("Cần ít nhất 1 source node có ảnh.")
    sources = [await _node(i) for i in source_node_ids]
    board_id = sources[0]["board_id"]
    aspect = _video_aspect(aspect_ratio)

    if node_id is None:
        detail = await _board(board_id)
        x, y = _free_spot(detail["nodes"], sources[0])
        target = await fb.post("/api/nodes", json={
            "board_id": board_id, "type": "video", "x": x, "y": y,
            "data": {"title": title or "Video", "prompt": prompt},
        })
        for s in sources:
            await fb.post("/api/edges", json={
                "board_id": board_id, "source_id": s["id"], "target_id": target["id"],
                "kind": "ref", "source_variant_idx": variant_index if s is sources[0] else None,
            })
    else:
        target = await _node(node_id)

    project_id = await _project_id(board_id)
    params: dict[str, Any] = {"prompt": prompt, "project_id": project_id, "aspect_ratio": aspect}
    if model == "omni_flash":
        rtype = "gen_video_omni"
        params["ref_media_ids"] = [_resolve_media_from_node(s, None) for s in sources]
        params["duration_s"] = int(duration_s)
        variants = 1
    else:
        rtype = "gen_video"
        params["video_quality"] = quality
        first = sources[0]
        if all_variants:
            starts = [m for m in ((first.get("data") or {}).get("mediaIds") or []) if m] or _node_media(first)
            params["start_media_ids"] = starts
            variants = len(starts)
        else:
            params["start_media_id"] = _resolve_media_from_node(first, variant_index)
            variants = 1
    await _mark_queued(target["id"], prompt, variants)
    req = await _dispatch(target["id"], rtype, params)
    req = await _wait(req["id"], wait_seconds)
    out = (await _report(req, target["id"], False))[0]
    out["board_id"] = board_id
    return out


@mcp.tool(annotations=READ, structured_output=False)
async def wait_for_request(request_id: int, timeout_seconds: int = 55, return_images: bool = True) -> list:
    """Keep waiting for a generation request (image or video) to finish and
    return its result. Call again if it is still running."""
    req = await _wait(request_id, timeout_seconds)
    return await _report(req, req.get("node_id"), return_images)


@mcp.tool(annotations=READ)
async def get_request(request_id: int) -> dict:
    """Raw status, params, result and error of a generation request."""
    return await fb.get(f"/api/requests/{request_id}")


@mcp.tool(annotations=WRITE)
async def cancel_request(request_id: int) -> dict:
    """Cancel a queued or running generation request."""
    return await fb.post(f"/api/requests/{request_id}/cancel")


@mcp.tool(annotations=READ)
async def list_activity(limit: int = 20, types: Optional[str] = None) -> dict:
    """Recent generation history (newest first). types filters by request
    type, comma separated: gen_image, edit_image, gen_video, gen_video_omni."""
    params: dict[str, Any] = {"limit": max(1, min(limit, 200))}
    if types:
        params["type"] = types
    return await fb.get("/api/activity", params=params)


# ── media ────────────────────────────────────────────────────────────────


@mcp.tool(annotations=READ, structured_output=False)
async def view_image(
    node_id: Optional[int] = None,
    media_id: Optional[str] = None,
    variant_index: Optional[int] = None,
    all_variants: bool = False,
    max_size: int = 1024,
) -> list:
    """Look at an image: a node's image (variant_index picks one,
    all_variants shows all) or any media_id. Returns the picture so you can
    judge it."""
    ids: list[str]
    if media_id:
        ids = [media_id]
    elif node_id is not None:
        node = await _node(node_id)
        if all_variants:
            ids = _node_media(node)
            if not ids:
                raise FlowboardError(f"Node {node_id} chưa có ảnh.")
        else:
            ids = [_resolve_media_from_node(node, variant_index)]
    else:
        raise FlowboardError("Cần node_id hoặc media_id.")
    content: list = [{"media_ids": ids}]
    for mid in ids[:6]:
        img = await _thumb(mid, max(256, min(max_size, 2048)))
        if img is None:
            content.append(f"{mid}: không xem được (video hoặc chưa tải xong).")
        else:
            content.append(img)
    return content


_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
        "video/mp4": ".mp4", "video/webm": ".webm"}


def _safe_name(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    return name or "flowboard"


@mcp.tool(annotations=WRITE)
async def save_media(
    node_id: Optional[int] = None,
    media_id: Optional[str] = None,
    all_variants: bool = True,
    folder: Optional[str] = None,
    filename: Optional[str] = None,
    format: Literal["original", "png", "jpg", "webp"] = "original",
    quality: int = 92,
    max_long_edge: Optional[int] = None,
) -> dict:
    """Save a node's images/videos (or one media_id) as files on this
    computer. Default folder: Pictures\\Flowboard. filename is the base name
    (variants get _1, _2…). format converts images; max_long_edge resizes."""
    if media_id:
        ids, base = [media_id], filename or media_id[:12]
    elif node_id is not None:
        node = await _node(node_id)
        ids = _node_media(node) if all_variants else [_resolve_media_from_node(node, None)]
        if not ids:
            raise FlowboardError(f"Node {node_id} chưa có media.")
        data = node.get("data") or {}
        base = filename or f"{data.get('title') or node.get('type')}_{node.get('short_id') or node_id}"
    else:
        raise FlowboardError("Cần node_id hoặc media_id.")
    out_dir = Path(folder).expanduser() if folder else EXPORT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    for i, mid in enumerate(ids, 1):
        raw, ctype = await fb.media_bytes(mid)
        ctype = ctype.split(";")[0]
        ext = _EXT.get(ctype, ".bin")
        if ctype.startswith("image/") and (format != "original" or max_long_edge):
            from PIL import Image as PILImage

            im = PILImage.open(io.BytesIO(raw))
            im.load()
            if max_long_edge and max(im.size) > max_long_edge:
                im.thumbnail((max_long_edge, max_long_edge), PILImage.LANCZOS)
            fmt = {"png": "PNG", "jpg": "JPEG", "webp": "WEBP"}.get(format, (im.format or "PNG"))
            if fmt == "JPEG" and im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            buf = io.BytesIO()
            im.save(buf, format=fmt, **({"quality": quality} if fmt in ("JPEG", "WEBP") else {}))
            raw = buf.getvalue()
            ext = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}.get(fmt, ext)
        name = _safe_name(base) + (f"_{i}" if len(ids) > 1 else "") + ext
        path = out_dir / name
        path.write_bytes(raw)
        saved.append({"media_id": mid, "path": str(path), "bytes": len(raw)})
    return {"saved": saved, "folder": str(out_dir)}


@mcp.tool(annotations=WRITE)
async def upload_image(
    board_id: int,
    file_path: Optional[str] = None,
    url: Optional[str] = None,
    base64_data: Optional[str] = None,
    node_id: Optional[int] = None,
    node_type: Literal["visual_asset", "character", "image"] = "visual_asset",
    title: Optional[str] = None,
    x: Optional[float] = None,
    y: Optional[float] = None,
) -> dict:
    """Bring an image into Flowboard from a file on this computer, a public
    URL or base64 data. It is uploaded to Google Flow and placed on a node
    (new node of node_type, or the existing node_id) so it can be used as a
    reference. Returns node id and media_id."""
    project_id = await _project_id(board_id)
    if node_id is None:
        detail = await _board(board_id)
        ax, ay = _free_spot(detail["nodes"])
        node = await fb.post("/api/nodes", json={
            "board_id": board_id, "type": node_type,
            "x": ax if x is None else x, "y": ay if y is None else y,
            "data": {"title": title or TYPE_TITLE[node_type]},
        })
        node_id = node["id"]
    elif title:
        await fb.patch(f"/api/nodes/{node_id}", json={"data": {"title": title}})

    try:
        if url:
            resp = await fb.post("/api/upload-url", json={"url": url, "project_id": project_id, "node_id": node_id})
        else:
            if file_path:
                p = Path(file_path).expanduser()
                if not p.is_file():
                    raise FlowboardError(f"Không thấy file: {p}")
                raw, fname = p.read_bytes(), p.name
            elif base64_data:
                b64 = base64_data.split(",", 1)[1] if base64_data.startswith("data:") else base64_data
                raw, fname = base64.b64decode(b64), "upload.png"
            else:
                raise FlowboardError("Cần file_path, url hoặc base64_data.")
            mime = ("image/png" if raw[:8] == b"\x89PNG\r\n\x1a\n" else
                    "image/jpeg" if raw[:3] == b"\xff\xd8\xff" else
                    "image/webp" if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP" else
                    "image/gif" if raw[:4] == b"GIF8" else "application/octet-stream")
            resp = await fb.post("/api/upload", data={"project_id": project_id, "node_id": str(node_id)},
                                 files={"file": (fname, raw, mime)})
    except FlowboardError as exc:
        await fb.patch(f"/api/nodes/{node_id}", json={"status": "error", "data": {"error": str(exc)[:300]}})
        raise
    media_id = resp["media_id"]
    await fb.patch(f"/api/nodes/{node_id}", json={"status": "done", "data": {
        "mediaId": media_id, "aspectRatio": resp.get("aspect_ratio"), "aiBrief": None,
        "renderedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "error": None,
    }})
    return {"node_id": node_id, "media_id": media_id, "width": resp.get("width"),
            "height": resp.get("height"), "aspect_ratio": resp.get("aspect_ratio")}


@mcp.tool(annotations=SPEND)
async def upscale_image(
    node_id: Optional[int] = None,
    media_id: Optional[str] = None,
    variant_index: Optional[int] = None,
    resolution: Literal["2K", "4K"] = "2K",
    engine: Literal["flow", "local"] = "flow",
    folder: Optional[str] = None,
    filename: Optional[str] = None,
) -> dict:
    """Upscale an image to 2K/4K and save it to a file. engine="flow" uses
    Google Flow's upscaler (may spend credits); "local" runs on this PC."""
    if media_id is None:
        if node_id is None:
            raise FlowboardError("Cần node_id hoặc media_id.")
        node = await _node(node_id)
        media_id = _resolve_media_from_node(node, variant_index)
        board_id = node["board_id"]
    else:
        board_id = None
    if engine == "flow":
        if board_id is None:
            boards = await fb.get("/api/boards")
            board_id = boards[0]["id"]
        project_id = await _project_id(board_id)
        resp = await fb.request("POST", "/api/upscale", json={
            "media_id": media_id, "project_id": project_id, "resolution": resolution}, raw=True)
    else:
        resp = await fb.request("POST", "/api/upscale-local", json={
            "media_id": media_id, "resolution": resolution}, raw=True)
    ctype = resp.headers.get("content-type", "image/png").split(";")[0]
    out_dir = Path(folder).expanduser() if folder else EXPORT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    name = _safe_name(filename or f"{media_id[:12]}_{resolution}") + _EXT.get(ctype, ".png")
    path = out_dir / name
    path.write_bytes(resp.content)
    return {"path": str(path), "bytes": len(resp.content), "resolution": resolution, "engine": engine}


@mcp.tool(annotations=READ)
async def describe_image(node_id: Optional[int] = None, media_id: Optional[str] = None,
                         save_to_node: bool = False) -> dict:
    """Get Flowboard's AI description of an image (the same "AI brief" the
    app uses for auto prompts). save_to_node stores it on the node."""
    if media_id is None:
        if node_id is None:
            raise FlowboardError("Cần node_id hoặc media_id.")
        media_id = _resolve_media_from_node(await _node(node_id), None)
    resp = await fb.post("/api/vision/describe", json={"media_id": media_id})
    if save_to_node and node_id is not None:
        await fb.patch(f"/api/nodes/{node_id}", json={"data": {"aiBrief": resp.get("description"), "aiBriefStatus": "done"}})
    return resp


@mcp.tool(annotations=READ)
async def list_assets(kind: Optional[Literal["image", "video"]] = None, limit: int = 100) -> dict:
    """List every generated / uploaded media in the library (all boards)."""
    params: dict[str, Any] = {"limit": max(1, min(limit, 2000))}
    if kind:
        params["kind"] = kind
    return {"assets": await fb.get("/api/assets", params=params)}


# ── prompt tools ─────────────────────────────────────────────────────────


@mcp.tool(annotations=READ)
async def enhance_prompt(prompt: str, kind: Literal["image", "video"] = "image") -> dict:
    """Rewrite a rough prompt into a detailed Nano Banana (image) or Veo
    (video) prompt using Flowboard's own prompt engine."""
    return await fb.post("/api/prompt/enhance", json={"prompt": prompt, "kind": kind})


@mcp.tool(annotations=WRITE)
async def auto_prompt(node_id: int, count: int = 1, camera: Optional[str] = None,
                      save_to_node: bool = True) -> dict:
    """Let Flowboard compose a prompt for a node from its upstream
    references (count>1 gives distinct prompts per variant). camera="static"
    for locked-camera video prompts. save_to_node writes the first prompt."""
    if count > 1:
        resp = await fb.post("/api/prompt/auto-batch", json={"node_id": node_id, "count": count, "camera": camera})
        first = (resp.get("prompts") or [None])[0]
    else:
        resp = await fb.post("/api/prompt/auto", json={"node_id": node_id, "camera": camera})
        first = resp.get("prompt")
    if save_to_node and first:
        await fb.patch(f"/api/nodes/{node_id}", json={"data": {"prompt": first}})
    return resp


# ── reference library ────────────────────────────────────────────────────


@mcp.tool(annotations=READ)
async def list_references(query: Optional[str] = None, limit: int = 100) -> dict:
    """List saved references in the shared library (search by label/tag)."""
    params: dict[str, Any] = {"limit": limit}
    if query:
        params["q"] = query
    return {"references": await fb.get("/api/references", params=params)}


@mcp.tool(annotations=WRITE)
async def save_reference(
    node_id: Optional[int] = None,
    media_id: Optional[str] = None,
    kind: Literal["image", "character", "visual_asset", "storyboard_shot"] = "image",
    label: Optional[str] = None,
    tags: Optional[list[str]] = None,
) -> dict:
    """Save an image to the reference library so it can be reused on any board."""
    body: dict[str, Any] = {"kind": kind, "label": label, "tags": tags}
    if media_id is None:
        if node_id is None:
            raise FlowboardError("Cần node_id hoặc media_id.")
        node = await _node(node_id)
        media_id = _resolve_media_from_node(node, None)
        body.update({"source_board_id": node["board_id"], "source_node_short_id": node.get("short_id"),
                     "aspect_ratio": (node.get("data") or {}).get("aspectRatio")})
    body["media_id"] = media_id
    return await fb.post("/api/references", json={k: v for k, v in body.items() if v is not None})


@mcp.tool(annotations=WRITE)
async def update_reference(ref_id: int, label: Optional[str] = None, pinned: Optional[bool] = None,
                           tags: Optional[list[str]] = None) -> dict:
    """Rename, pin or retag a saved reference."""
    body = {k: v for k, v in {"label": label, "pinned": pinned, "tags": tags}.items() if v is not None}
    return await fb.patch(f"/api/references/{ref_id}", json=body)


@mcp.tool(annotations=DESTROY)
async def delete_reference(ref_id: int) -> dict:
    """Remove a saved reference from the library."""
    return await fb.delete(f"/api/references/{ref_id}")


@mcp.tool(annotations=WRITE)
async def place_reference(board_id: int, ref_id: int, x: Optional[float] = None, y: Optional[float] = None) -> dict:
    """Put a saved library reference onto a board as a node."""
    items = await fb.get("/api/references", params={"limit": 2000})
    ref = next((r for r in (items or []) if r.get("id") == ref_id), None)
    if ref is None:
        raise FlowboardError(f"Không thấy reference {ref_id}.")
    kind = ref.get("kind")
    ntype = kind if kind in ("character", "visual_asset", "image") else "image"
    if x is None or y is None:
        detail = await _board(board_id)
        x, y = _free_spot(detail["nodes"])
    node = await fb.post("/api/nodes", json={
        "board_id": board_id, "type": ntype, "x": x, "y": y, "status": "done",
        "data": {"title": ref.get("label") or TYPE_TITLE[ntype], "mediaId": ref["media_id"],
                 "aspectRatio": ref.get("aspect_ratio"), "aiBrief": ref.get("ai_brief")},
    })
    return _summarize_node(node)


# ── everything else ──────────────────────────────────────────────────────


@mcp.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=True))
async def flowboard_api(
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"],
    path: str,
    body: Optional[dict] = None,
    query: Optional[dict] = None,
) -> dict:
    """Full-access escape hatch: call any Flowboard agent endpoint directly.
    path must start with /api/. Useful endpoints: /api/llm/config and
    /api/llm/providers (AI settings), /api/auth/me, /api/auth/scan,
    /api/plans/{id}, /api/plans/{id}/run, /api/assistant/run, /api/chat,
    /api/flow/projects, /api/media/{id}/status. GET /openapi.json lists all."""
    if not (path.startswith("/api/") or path == "/openapi.json"):
        raise FlowboardError("path phải bắt đầu bằng /api/")
    resp = await fb.request(method, path, json=body, params=query)
    if isinstance(resp, list):
        return {"items": resp}
    if not isinstance(resp, dict):
        return {"value": resp}
    if path == "/openapi.json":
        return {"paths": {p: sorted(v.keys()) for p, v in (resp.get("paths") or {}).items()}}
    return resp


# ── ChatGPT-compatible search / fetch ────────────────────────────────────


@mcp.tool(annotations=READ)
async def search(query: str) -> dict:
    """Search boards and nodes (titles and prompts). Returns ids like
    "board:3" or "node:42" that fetch() can open."""
    q = query.lower().strip()
    results = []
    for b in await fb.get("/api/boards"):
        detail = await _board(b["id"])
        if not q or q in b["name"].lower():
            results.append({"id": f"board:{b['id']}", "title": f"Board: {b['name']}",
                            "url": f"flowboard://board/{b['id']}"})
        for n in detail.get("nodes", []):
            data = n.get("data") or {}
            hay = " ".join(str(data.get(k) or "") for k in ("title", "prompt", "text")).lower()
            if q and q in hay:
                results.append({"id": f"node:{n['id']}",
                                "title": f"{data.get('title') or n['type']} ({b['name']})",
                                "url": f"flowboard://board/{b['id']}/node/{n['id']}"})
        if len(results) >= 50:
            break
    return {"results": results[:50]}


@mcp.tool(annotations=READ)
async def fetch(id: str) -> dict:
    """Open a search result by id ("board:3" or "node:42")."""
    kind, _, raw = id.partition(":")
    if kind == "board":
        detail = await get_board(int(raw))
        text = "\n".join(
            f"- node {n['id']} [{n['type']}] {n['title']} status={n['status']}"
            + (f" prompt={n['prompt']!r}" if n.get("prompt") else "")
            for n in detail["nodes"]
        )
        return {"id": id, "title": detail["board"]["name"], "text": text or "(empty board)",
                "url": f"flowboard://board/{raw}", "metadata": {"edges": len(detail["edges"])}}
    if kind == "node":
        node = _summarize_node(await _node(int(raw)), full=True)
        return {"id": id, "title": node["title"], "text": str(node),
                "url": f"flowboard://node/{raw}", "metadata": {"type": node["type"]}}
    raise FlowboardError("id phải có dạng board:<id> hoặc node:<id>")
