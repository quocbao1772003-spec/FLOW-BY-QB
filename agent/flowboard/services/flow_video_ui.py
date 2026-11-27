"""Flow Video driven through a signed-in Flow tab (extension ``video_ui_call``).

The extension clicks the real Flow UI (upload, ingredient, prompt, approve,
download) and streams the finished mp4 back in base64 chunks over the bridge
WebSocket (``video_ui_chunk``); progress per step arrives as ``video_ui_progress``.
Selectors/regex live in DEFAULT_SELECTORS (overridable by
``storage/video_ui_selectors.json``) so a Flow UI change needs no new release.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from flowboard.config import STORAGE_DIR

logger = logging.getLogger(__name__)

STEPS: list[tuple[str, str]] = [
    ("open_tab", "Mở tab"),
    ("manual_mode", "Chế độ tay"),
    ("upload", "Tải ảnh"),
    ("ingredient", "Ảnh đầu"),
    ("submit", "Gửi"),
    ("approve", "Duyệt credit"),
    ("generating", "Đang tạo"),
    ("download", "Tải về"),
]
STEP_KEYS = [k for k, _ in STEPS]
# Fallback only: the real cost is read from Flow ("Generating will use N credits").
MODELS = ("veo_lite", "veo_lite_lowprio", "omni_flash", "veo_fast", "veo_quality")
DEFAULT_MODEL = "veo_lite"
DEPRECATED_MODELS = ("veo_fast", "veo_quality")  # "Leaving Dec 5"
CREDITS = {"veo_lite": 10, "veo_lite_lowprio": 0, "omni_flash": 20, "veo_fast": 20, "veo_quality": 100}
CHUNK_BYTES = 8 * 1024 * 1024
JOB_TIMEOUT_S = 15 * 60

ERROR_MESSAGES = {
    "FLOW_REJECTED": "Flow từ chối prompt hoặc ảnh (vi phạm chính sách / không tạo được).",
    "NO_CREDITS": "Tài khoản Flow không đủ credit để tạo video.",
    "UI_NOT_FOUND": "Không tìm thấy nút/ô trên giao diện Flow (Flow có thể đã đổi UI). Dùng Kiểm tra để lấy ảnh DOM và sửa selector.",
    "TIMEOUT": "Quá thời gian chờ Flow tạo hoặc tải video.",
    "DOWNLOAD_FAILED": "Tạo xong nhưng không tải được file video về.",
    "EXTENSION_OFFLINE": "Extension Flowboard chưa kết nối. Mở Chrome có extension và tab Flow.",
    "OVER_BUDGET": "Chi phí credit Flow báo vượt mức tối đa cho phép của yêu cầu; chưa gửi.",
    "DEBUGGER_BUSY": "Tab Flow đang bị DevTools/extension khác gỡ lỗi. Đóng DevTools của tab đó rồi chạy lại.",
}
ERROR_CODES = set(ERROR_MESSAGES)

DEFAULT_SELECTORS: dict[str, Any] = {
    "prompt_box": 'div.ProseMirror[aria-label="What do you want to create?"]',
    "start_button": 'button[aria-label="Start generation"]',
    "add_ingredients": 'button[aria-label="Add ingredients to the prompt box"]',
    "upload_media": 'button[aria-label="Upload media"]',
    "add_media_menu": 'button[aria-label="Add media menu"]',
    "settings_button": 'button[aria-label="Settings"]',
    "asset_list": '[aria-label="Asset list"]',
    "asset_item": ".asset-item",
    "add_to_prompt_text": "^Add to prompt$",
    "download_button": 'button[aria-label="Download"]',
    "file_input": 'input[type="file"]',
    "approve_text": r"^Approve( \d+)? credits?",
    "always_approve_text": r"Always approve in project",
    "silent_toggle_text": r"Return silent videos",
    "no_credits_text": r"not enough credits|insufficient",
    "rejected_text": r"couldn.t generate|violat|policy",
    "credits_text": r"([\d,]+)\s*credits?",
    "approve_timeout_s": 5,
    "generate_timeout_s": 480,
    "flow_agent_text": "Flow Agent",
    "settings_trigger": 'button[aria-label="Settings trigger"]',
    "mode_video_text": "^Video$",
    "video_type_frames_text": "^Frames$",
    "video_type_ingredients_text": "^Ingredients$",
    "aspect_text": {"16:9": "^16:9$|Landscape", "9:16": "^9:16$|Portrait"},
    "model_text": {
        "veo_lite": "Veo 3\.1 - Lite(?! \[)",
        "veo_lite_lowprio": "Veo 3\.1 - Lite \[Lower Priority\]",
        "omni_flash": "Omni 1\.2 Flash",
        "veo_fast": "Veo 3\.1 - Fast",
        "veo_quality": "Veo 3\.1 - Quality",
    },
    "model_scan_text": "Veo 3\.1 - [A-Za-z]+(?: \[[^\]]+\])?|Omni [\d.]+ Flash",
    "leaving_text": "Leaving[^\n]*",
    "resolution_text": "^{res}$",
    "duration_text": "^{n}s?$",
    "count_text": "^x?1$",
    "start_frame_text": "^Start$",
    "cost_text": "Generating will use (\d+) credits?",
    "more_options": 'button[aria-label="More options"]',
    "download_1080": "1080p Upscaled",
    "download_720": "720p Original",
    "download_menu_text": "^Download$",
}

def selectors_path() -> Path:
    return STORAGE_DIR / "video_ui_selectors.json"

def load_selectors() -> dict[str, Any]:
    out = json.loads(json.dumps(DEFAULT_SELECTORS))
    try:
        p = selectors_path()
        if p.is_file():
            over = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(over, dict):
                out.update(over)
    except Exception:  # noqa: BLE001
        logger.exception("bad video_ui_selectors.json")
    return out

def save_selectors(data: dict[str, Any]) -> dict[str, Any]:
    p = selectors_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return load_selectors()

class VideoUiError(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code if code in ERROR_CODES else "UI_NOT_FOUND"
        self.detail = detail

def error_obj(code: Optional[str], detail: Optional[str] = None) -> Optional[dict]:
    if not code or code == "canceled":
        return None
    c = code if code in ERROR_CODES else "UI_NOT_FOUND"
    return {"code": c, "message": ERROR_MESSAGES[c], "detail": detail or (code if c != code else "")}

def map_extension_error(r: Optional[dict]) -> VideoUiError:
    """Failed ``video_ui_call`` result -> standard error."""
    if not r:
        return VideoUiError("EXTENSION_OFFLINE", "no result")
    err = str(r.get("code") or r.get("error") or "")
    detail = str(r.get("detail") or r.get("message") or err)
    if err in ERROR_CODES:
        return VideoUiError(err, detail)
    if err == "timeout":
        return VideoUiError("TIMEOUT", detail)
    if err in ("extension_disconnected", "no_result") or err.startswith("VIDEO_UI_CALL_"):
        return VideoUiError("EXTENSION_OFFLINE", detail)
    low = f"{err} {detail}".lower()
    if "already attached" in low or "another debugger" in low:
        return VideoUiError("DEBUGGER_BUSY", detail)
    return VideoUiError("UI_NOT_FOUND", detail)

# ── per-call registry: progress + chunk assembly (fed by WS messages) ─────
class CallState:
    def __init__(self, call_id: str, out_path: Path,
                 on_step: Optional[Callable[[str, Optional[bool]], None]] = None):
        self.call_id = call_id
        self.out_path = out_path
        self.on_step = on_step
        self.next_seq = 0
        self.size = 0
        self.complete = asyncio.Event()
        self.error: Optional[str] = None
        self.tmp = out_path.with_suffix(".part")

_calls: dict[str, CallState] = {}

def register_call(state: CallState) -> None:
    state.out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        state.tmp.unlink()
    except FileNotFoundError:
        pass
    _calls[state.call_id] = state

def unregister_call(call_id: str) -> None:
    st = _calls.pop(call_id, None)
    if st:
        try:
            st.tmp.unlink()
        except FileNotFoundError:
            pass

def on_progress(data: dict) -> None:
    st = _calls.get(str(data.get("call")))
    if st and st.on_step and data.get("step") in STEP_KEYS:
        st.on_step(data["step"], data.get("ok"))

def on_chunk(data: dict) -> None:
    st = _calls.get(str(data.get("call")))
    if not st:
        return
    try:
        seq = int(data.get("seq"))
        if seq != st.next_seq:
            st.error = f"chunk order {seq} != {st.next_seq}"
            st.complete.set()
            return
        raw = base64.b64decode(data.get("b64") or "")
        with open(st.tmp, "ab") as f:
            f.write(raw)
        st.size += len(raw)
        st.next_seq += 1
        if data.get("last"):
            st.tmp.replace(st.out_path)
            st.complete.set()
    except Exception as e:  # noqa: BLE001
        st.error = str(e)[:200]
        st.complete.set()

# ── bridge ────────────────────────────────────────────────────────────────
def _unwrap(resp: Any) -> dict:
    if not isinstance(resp, dict):
        return {"ok": False, "error": "no_result"}
    inner = resp.get("data")
    if isinstance(inner, dict) and "ok" in inner:
        return inner
    if resp.get("error"):
        return {"ok": False, "error": str(resp["error"])}
    return {"ok": False, "error": "no_result"}

def bridge_call(client: Any) -> Callable[..., Awaitable[dict]]:
    """``call(params, timeout_s)`` bound to one connected Chrome profile."""
    async def call(params: dict, timeout_s: float = JOB_TIMEOUT_S) -> dict:
        resp = await client._send("video_ui_call", params, timeout=timeout_s + 30)
        return _unwrap(resp)
    return call

# ── account state (from probes/jobs) ──────────────────────────────────────
_acct: dict[str, dict] = {}
_locks: dict[str, asyncio.Lock] = {}

def lock_for(key: str) -> asyncio.Lock:
    return _locks.setdefault("video:" + key, asyncio.Lock())

def is_busy(key: str) -> bool:
    lk = _locks.get("video:" + key)
    return bool(lk and lk.locked())

def note_account(key: str, **kw: Any) -> None:
    row = _acct.setdefault(key, {})
    row.update({k: v for k, v in kw.items() if v is not None})
    row["checked_at"] = time.time()

def candidates(pool: Any, only: Optional[str] = None) -> list[Any]:
    out = []
    for c in pool.connected_clients():
        if not pool.identified(c):
            continue
        if only and pool.key_of(c) != only.lower():
            continue
        out.append(c)
    return out

def accounts_snapshot(pool: Any) -> list[dict]:
    out = []
    for c in candidates(pool):
        key = pool.key_of(c)
        row = _acct.get(key, {})
        out.append({
            "email": key, "tab_open": row.get("tab_open"), "silent_on": row.get("silent_on"),
            "always_approve": row.get("always_approve"), "credits": row.get("credits"),
            "busy": is_busy(key), "checked_at": row.get("checked_at"),
            "models": row.get("models") or [],
        })
    return sorted(out, key=lambda r: r["email"])

def safe_name(ref: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", ref or "frame")[:60] or "frame"

async def probe(pool: Any, account: Optional[str], *, call_factory=bridge_call) -> dict:
    cands = candidates(pool, account)
    if not cands:
        raise VideoUiError("EXTENSION_OFFLINE", "no connected account")
    c = cands[0]
    key = pool.key_of(c)
    with pool.pin(c):
        r = await call_factory(c)({"probe": True, "selectors": load_selectors()}, 90)
    if not r.get("ok"):
        raise map_extension_error(r)
    d = r.get("data") if isinstance(r.get("data"), dict) else r
    note_account(key, tab_open=d.get("tab_open"), silent_on=d.get("silent_on"),
                 always_approve=d.get("always_approve"), credits=d.get("credits"),
                 models=d.get("models") if isinstance(d.get("models"), list) else None)
    return {"account": key, **d}

async def run_job(params: dict, pool: Any, out_path: Path, *,
                  on_step: Optional[Callable[[str, Optional[bool]], None]] = None,
                  is_canceled: Optional[Callable[[], bool]] = None,
                  call_factory=bridge_call, poll_s: float = 2.0,
                  chunk_wait_s: float = 60.0) -> tuple[dict, Optional[str]]:
    """Run one ``gen_video_ui`` job. Returns (result, error_code)."""
    cands = candidates(pool, params.get("account"))
    if not cands:
        return {"error_detail": "no connected account"}, "EXTENSION_OFFLINE"
    client = next((c for c in cands if not is_busy(pool.key_of(c))), cands[0])
    key = pool.key_of(client)
    call_id = uuid.uuid4().hex
    state = CallState(call_id, out_path, on_step)
    model = params.get("model") if params.get("model") in MODELS else DEFAULT_MODEL
    variants = max(1, int(params.get("variants") or 1))
    fallback_credits = CREDITS[model] * variants
    payload = {
        "call": call_id, "prompt": params["prompt"], "image": params.get("image"),
        "model": model, "aspect": params.get("aspect") or "16:9", "variants": variants,
        "silent": params.get("silent", True) is not False, "account": key,
        "name": params.get("name"), "selectors": load_selectors(), "chunk_bytes": CHUNK_BYTES,
        "resolution": params.get("resolution"), "duration_s": params.get("duration_s"),
        "ref_images": params.get("ref_images"), "max_credits": params.get("max_credits"),
        "download_quality": params.get("download_quality") or "1080p",
    }
    async with lock_for(key):
        register_call(state)
        try:
            with pool.pin(client):
                send = call_factory(client)
                task = asyncio.ensure_future(send(payload, JOB_TIMEOUT_S))
                while not task.done():
                    await asyncio.wait({task}, timeout=poll_s)
                    if task.done():
                        break
                    if is_canceled and is_canceled():
                        try:
                            await send({"cancel": call_id}, 15)
                        except Exception:  # noqa: BLE001
                            pass
                        task.cancel()
                        return {"account": key}, "canceled"
                r = task.result()
            if not r.get("ok"):
                e = map_extension_error(r)
                return {"account": key, "error_detail": e.detail}, e.code
            try:
                await asyncio.wait_for(state.complete.wait(), timeout=chunk_wait_s)
            except asyncio.TimeoutError:
                return {"account": key, "error_detail": "chunks not complete"}, "DOWNLOAD_FAILED"
            data = r.get("data") if isinstance(r.get("data"), dict) else {}
            expect = r.get("size") or data.get("size")
            if state.error or not out_path.is_file() or (expect and int(expect) != state.size):
                return ({"account": key, "error_detail": state.error or f"size {state.size} != {expect}"},
                        "DOWNLOAD_FAILED")
            real = r.get("cost") or data.get("cost")
            credits = int(real) if isinstance(real, (int, float)) and real >= 0 else fallback_credits
            note_account(key, tab_open=True, silent_on=r.get("silent_on"),
                         always_approve=r.get("always_approve"), credits=r.get("credits_after"))
            return ({"account": key, "size": state.size,
                     "duration_s": r.get("duration_s") or data.get("duration_s"),
                     "credits": credits, "credits_real": isinstance(real, (int, float)),
                     "file": out_path.name}, None)
        finally:
            unregister_call(call_id)
