"""Side-panel AI chat — streams a reply from the local ``claude`` CLI.

Used for naming Handora products and drafting image prompts. Runs on the
user's own Claude subscription through the CLI (no API key), defaulting to
Sonnet to keep usage cheap.

Design notes
- The CLI is stateless in ``-p`` mode, so every turn sends the recent
  transcript. Long histories are trimmed from the front.
- The prompt goes in on **stdin** (never argv): on Windows the npm shim is a
  ``.cmd`` and cmd.exe re-parses argv, mangling newlines and quotes.
- The system prompt goes in through ``--system-prompt-file`` so it replaces
  Claude Code's large coding-agent prompt (fewer tokens per turn). Older CLIs
  without that flag fall back to carrying the instructions on stdin.
- Code-running and web tools are disabled; image attachments are read via
  ``@path`` with their folder allow-listed, as ``claude_cli.run_claude`` does.
- ``subprocess.Popen`` in a worker thread, not asyncio subprocesses: those
  fail on Windows under some event-loop policies.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import AsyncIterator, Optional

from flowboard.config import STORAGE_DIR
from flowboard.services.llm.cli_utils import CLI_PROBE_TIMEOUT, resolve_cli_binary

logger = logging.getLogger(__name__)

# Explicit ids first (what the user picked), CLI aliases as the fallback for
# CLIs / accounts that don't know the exact id.
MODELS: dict[str, tuple[str, str]] = {
    "sonnet": ("claude-sonnet-5-5", "sonnet"),
    "opus": ("claude-opus-5-5", "opus"),
    "haiku": ("claude-haiku-4-5-20251001", "haiku"),
}
DEFAULT_MODEL = "sonnet"

_DISALLOWED = "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,PowerShell"

MAX_TURNS = 24
MAX_CHARS_PER_TURN = 8000
TIMEOUT_S = 240.0

SYSTEM_PROMPT = """Bạn là trợ lý AI trong Flowboard — công cụ tạo ảnh sản phẩm của Handora Nails, \
thương hiệu móng tay giả (press-on nails) làm thủ công tại Việt Nam, bán cho khách Mỹ \
(website, Etsy, Shopify).

Hai việc chính:

1. ĐẶT TÊN SẢN PHẨM — theo đúng phong cách tên hiện có của Handora
- Luôn là 2 từ tiếng Anh, Title Case, ngắn, gợi hình, đọc lên thấy ngay bộ móng.
- Các kiểu tên Handora đang dùng:
  * [màu / chất liệu / cảm xúc] + [họa tiết chính]: Golden Ribbon, Pearl Berry, Frost Plaid, Rose Icing, Crimson Web, Gilded Pine, Sage Solstice, Azure Shell, Ruby Bloom, Ice Knit
  * [họa tiết] + [khoảnh khắc / bối cảnh / món đồ]: Puppy Stocking, Kitty Stocking, Gingerbread Lane, Christmas Morning, Fireside Mix, Peppermint Parlor, Fruit Picnic, Tartan Gift, String Lights
  * chơi chữ dễ thương, ấm áp: Beary Picnic, Ho Ho Pink, Tinsel Kiss, Jolly Mouse, Merry Kitty, Grape Prank
  * Halloween / goth: tối, mạnh, có kịch tính: Venom Bite, Blood Balance, Silent Maiden, Moon Ruler, Twin Skulls, Venus Rising, Silver Horn, Bloody Arrow
  * Summer: hay lặp từ chủ đạo của collection: Ocean …, Tropical …, Mermaid …, Siren … (Ocean Jelly, Tropical Pearl, Golden Mermaid, Mystic Siren)
- Tên phải bám vào chi tiết THẬT trong ảnh (màu chủ đạo, charm 3D, họa tiết, hiệu ứng chrome / cat eye / glitter / french tip, nhân vật dễ thương tự vẽ). Không dùng chữ "nails", "press-on", "set".
- Tuyệt đối không dùng tên thương hiệu hay nhân vật có bản quyền (Disney, Sanrio, Pokémon…) — gợi tinh thần bằng từ chung (vd: công chúa băng giá → "Frost Crown").
- Tránh trùng tên đã có; nếu người dùng dán danh sách tên cũ thì loại các tên đó.
- Mã SKU của Handora có dạng NGƯỜI_COLLECTION_SỐ, ví dụ PA_HLW26_01 (PA = người lên ý tưởng, HLW26 = collection, 01 = số thứ tự).
- Tên file ảnh: [SKU]-[ten-san-pham-viet-thuong-noi-gach-ngang]-[đuôi SEO cố định].
- Tag Shopify kiểu Handora: chữ thường, dạng "[đặc điểm] nails" + mùa, vd: christmas nails, bow nails, almond nails, 3d nail art, cat eye nails, goth nails, Christmas 2026.

2. VIẾT PROMPT TẠO ẢNH
- Prompt dùng cho Google Flow (model Nano Banana Pro / GemPix 2), thường là chỉnh/ghép \
ảnh sản phẩm từ ảnh tham chiếu (@tên-node).
- Cấu trúc rõ: giữ nguyên gì, thay gì; mô tả bộ móng (dáng, độ dài, màu, họa tiết, charm, \
độ bóng), bối cảnh, ánh sáng, góc máy, chất ảnh thật. Giữ đúng sản phẩm, không bịa chi tiết.
- Viết prompt bằng ngôn ngữ người dùng yêu cầu (mặc định tiếng Việt nếu họ viết tiếng Việt).
- Luôn đặt prompt hoàn chỉnh trong MỘT khối ``` để người dùng copy hoặc đưa thẳng vào node.

Cách trả lời: ngắn gọn, đi thẳng vào việc, dùng ngôn ngữ của người dùng. \
Không dùng công cụ, không đọc file nào ngoài ảnh được đính kèm."""


def _cwd() -> str:
    # A neutral working dir so the CLI doesn't pick up the repo's CLAUDE.md
    # (wasted tokens) or wander around the project files.
    d = STORAGE_DIR / "ai-chat"
    d.mkdir(parents=True, exist_ok=True)
    return str(d)


def build_transcript(messages: list[dict], context: Optional[str]) -> str:
    turns = [
        m for m in messages
        if isinstance(m, dict) and m.get("role") in ("user", "assistant")
        and isinstance(m.get("content"), str) and m["content"].strip()
    ][-MAX_TURNS:]
    parts: list[str] = []
    if context and context.strip():
        parts.append(f"<boi_canh_tu_flowboard>\n{context.strip()[:6000]}\n</boi_canh_tu_flowboard>")
    if len(turns) > 1:
        lines = []
        for m in turns[:-1]:
            who = "Người dùng" if m["role"] == "user" else "Trợ lý"
            lines.append(f"{who}: {m['content'][:MAX_CHARS_PER_TURN]}")
        parts.append("<lich_su_tro_chuyen>\n" + "\n\n".join(lines) + "\n</lich_su_tro_chuyen>")
    last = turns[-1]["content"][:MAX_CHARS_PER_TURN] if turns else ""
    parts.append(last)
    return "\n\n".join(parts)


def resolve_attachments(media_ids: list[str]) -> list[str]:
    from flowboard.services import media as media_service

    paths: list[str] = []
    for mid in media_ids[:6]:
        if not isinstance(mid, str) or not media_service.is_valid_media_id(mid):
            continue
        p = media_service.cached_path(mid)
        if p is not None and p.exists():
            paths.append(str(p.resolve()))
    return paths


def _args(model_id: str, sys_file: Optional[str], attachments: list[str], full: bool) -> list[str]:
    claude_bin = resolve_cli_binary("claude", CLI_PROBE_TIMEOUT)
    args = [claude_bin, "-p", "--output-format", "stream-json", "--verbose", "--model", model_id,
            "--disallowedTools", _DISALLOWED]
    if full:
        args += ["--include-partial-messages", "--no-session-persistence"]
        if sys_file:
            args += ["--system-prompt-file", sys_file]
    if attachments:
        for parent in sorted({os.path.dirname(p) for p in attachments}):
            args += ["--add-dir", parent]
        args += ["--permission-mode", "bypassPermissions"]
    return args


def _is_flag_error(text: str) -> bool:
    t = text.lower()
    return "unknown option" in t or "unknown argument" in t or "unexpected argument" in t


def _is_model_error(text: str) -> bool:
    t = text.lower()
    return "model" in t and ("not found" in t or "invalid" in t or "not_found" in t or "does not exist" in t)


async def stream_reply(
    messages: list[dict],
    *,
    model: str = DEFAULT_MODEL,
    context: Optional[str] = None,
    attachment_ids: Optional[list[str]] = None,
) -> AsyncIterator[dict]:
    """Yield ``{"type": "delta", "text"}`` chunks, then ``{"type": "done"}``
    or ``{"type": "error", "message"}``."""
    explicit, alias = MODELS.get(model, MODELS[DEFAULT_MODEL])
    attachments = resolve_attachments(attachment_ids or [])
    transcript = build_transcript(messages, context)
    if attachments:
        transcript += "\n\nẢnh đính kèm: " + " ".join(f"@{p}" for p in attachments)

    fd, sys_file = tempfile.mkstemp(prefix="flowboard-chat-", suffix=".txt")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(SYSTEM_PROMPT)

    # Attempt ladder: newest flags + exact model id → older-CLI flags with
    # instructions on stdin → model alias. Only retried when nothing has been
    # streamed yet, so a reply is never duplicated.
    attempts = [
        (explicit, True, transcript),
        (explicit, False, f"{SYSTEM_PROMPT}\n\n---\n\n{transcript}"),
        (alias, False, f"{SYSTEM_PROMPT}\n\n---\n\n{transcript}"),
    ]
    try:
        last_error = "Không gọi được Claude CLI"
        for model_id, full, stdin_text in attempts:
            emitted = False
            failed: Optional[str] = None
            async for ev in _run_once(_args(model_id, sys_file if full else None, attachments, full), stdin_text):
                if ev["type"] == "delta":
                    emitted = True
                    yield ev
                elif ev["type"] == "error":
                    failed = ev["message"]
                    break
                elif ev["type"] == "done":
                    break
            if failed is None:
                yield {"type": "done", "model": model_id}
                return
            last_error = failed
            if emitted:
                break
            if not (_is_flag_error(failed) or _is_model_error(failed)):
                break
            logger.info("ai_chat: retrying with a simpler CLI call (%s)", failed[:120])
        yield {"type": "error", "message": last_error[:600]}
    finally:
        try:
            os.unlink(sys_file)
        except OSError:
            pass


async def _run_once(args: list[str], stdin_text: str) -> AsyncIterator[dict]:
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    proc_box: dict = {}

    def worker() -> None:
        def put(item: dict) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, item)

        try:
            proc = subprocess.Popen(
                args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=_cwd(),
            )
        except FileNotFoundError:
            put({"type": "error", "message": "Không tìm thấy Claude CLI (lệnh `claude`). Cài Claude Code và đăng nhập trước."})
            put({"type": "_end"})
            return
        except Exception as exc:  # noqa: BLE001
            put({"type": "error", "message": f"Lỗi khi chạy Claude CLI: {exc}"})
            put({"type": "_end"})
            return
        proc_box["proc"] = proc
        try:
            assert proc.stdin is not None
            proc.stdin.write(stdin_text.encode("utf-8"))
            proc.stdin.close()
        except Exception:  # noqa: BLE001
            pass

        got_partial = False
        got_text = False
        result_error: Optional[str] = None
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = ev.get("type")
            if t == "stream_event":
                inner = ev.get("event") or {}
                delta = inner.get("delta") or {}
                if inner.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
                    text = delta.get("text") or ""
                    if text:
                        got_partial = got_text = True
                        put({"type": "delta", "text": text})
            elif t == "assistant" and not got_partial:
                # CLI without --include-partial-messages: whole message at once.
                msg = ev.get("message") or {}
                for block in msg.get("content") or []:
                    if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
                        got_text = True
                        put({"type": "delta", "text": block["text"]})
            elif t == "result":
                if ev.get("is_error"):
                    result_error = str(ev.get("result") or ev.get("subtype") or "Claude báo lỗi")
                elif not got_text and isinstance(ev.get("result"), str) and ev["result"]:
                    got_text = True
                    put({"type": "delta", "text": ev["result"]})
        rc = proc.wait()
        stderr = b""
        try:
            stderr = proc.stderr.read() if proc.stderr else b""
        except Exception:  # noqa: BLE001
            pass
        if result_error:
            put({"type": "error", "message": result_error})
        elif rc != 0 and not got_text:
            msg = stderr.decode("utf-8", errors="replace").strip() or f"Claude CLI thoát với mã {rc}"
            put({"type": "error", "message": msg})
        else:
            put({"type": "done"})
        put({"type": "_end"})

    thread = threading.Thread(target=worker, name="ai-chat-cli", daemon=True)
    thread.start()
    try:
        deadline = loop.time() + TIMEOUT_S
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                yield {"type": "error", "message": f"Claude CLI không trả lời sau {int(TIMEOUT_S)} giây"}
                return
            item = await asyncio.wait_for(queue.get(), timeout=remaining)
            if item["type"] == "_end":
                return
            yield item
    except asyncio.TimeoutError:
        yield {"type": "error", "message": f"Claude CLI không trả lời sau {int(TIMEOUT_S)} giây"}
    finally:
        proc = proc_box.get("proc")
        if proc is not None and proc.poll() is None:
            # Client stopped / disconnected — don't leave the CLI running.
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
