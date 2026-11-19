"""Google Flow Music (www.flowmusic.app) client driven through the extension.

The extension only runs ``fetch`` with the Supabase Bearer inside a
flowmusic.app tab (WS command ``music_call``); all the product logic
(conversation, tool-call, polling, download) lives here so a change in the
Flow Music API never needs a new extension release.

``FlowMusic`` takes a ``call`` coroutine so tests can plug a fake bridge:
``call(path, method="GET", body=None, mode="json", timeout_ms=...)`` returns
``{ok, status, data, error}``.
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

logger = logging.getLogger(__name__)

LYRICS_NS = uuid.UUID("b8f9e3a1-7c2d-4f5e-9a8b-1c3d5e7f9a2b")
DEFAULT_MODEL = "Lyria 3.5"
CREDITS_PER_SONG = 5  # observed; used for the pre-check only
EXHAUSTED_HOLD_S = 6 * 3600

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_BLOCK_WORDS = ("blocked", "safety", "policy", "moderation", "copyright", "recitation", "prohibited")

Call = Callable[..., Awaitable[dict]]


class MusicError(Exception):
    """``code`` is one of the standard errors of the music API contract."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


def lyrics_id(text: Optional[str]) -> str:
    """Web app id for a lyrics text: uuid5(namespace, text); "" if none."""
    if not text or not text.strip() or text == "[Instrumental]":
        return ""
    return str(uuid.uuid5(LYRICS_NS, text))


def _looks_blocked(text: Any) -> bool:
    s = str(text or "").lower()
    return any(w in s for w in _BLOCK_WORDS)


def classify(r: Optional[dict], what: str) -> MusicError:
    """Map a failed bridge result to a standard error code."""
    if not r:
        return MusicError("flowmusic_api_changed", f"{what}: no result")
    err = str(r.get("error") or "")
    status = r.get("status")
    data = r.get("data")
    blob = f"{err} {json.dumps(data, ensure_ascii=False)[:400] if data is not None else ''}"
    if err in ("extension_disconnected", "INVALID_MUSIC_PATH") or err.startswith("MUSIC_CALL_"):
        return MusicError("extension_offline", f"{what}: {err}")
    if err in ("not_logged_in", "token_expired") or status in (401,):
        return MusicError("no_session", f"{what}: {err or status}")
    if err == "timeout":
        return MusicError("timeout", what)
    if status == 429:
        return MusicError("busy", what)
    if status in (402, 403) or "credit" in blob.lower():
        return MusicError("credits_exhausted", f"{what}: {blob[:200]}")
    if _looks_blocked(blob):
        return MusicError("blocked_content", f"{what}: {blob[:200]}")
    return MusicError("flowmusic_api_changed", f"{what}: {blob[:200]}")


def _unwrap(resp: Any) -> dict:
    """Extension reply -> ``{ok, status, data, error}``.

    The extension answers ``{id, status, data: <pageCall result>}`` or
    ``{id, error}``; pageCall results are themselves ``{ok, status, data}``.
    """
    if not isinstance(resp, dict):
        return {"ok": False, "error": "no_result"}
    inner = resp.get("data")
    if isinstance(inner, dict) and "ok" in inner:
        return inner
    if resp.get("error"):
        return {"ok": False, "error": str(resp["error"]), "status": resp.get("status")}
    return {"ok": False, "error": "no_result"}


def bridge_call(client: Any) -> Call:
    """``call`` bound to one connected Chrome profile."""

    async def call(path: str, method: str = "GET", body: Any = None, mode: str = "json",
                   timeout_ms: int = 120000) -> dict:
        resp = await client._send(
            "music_call",
            {"path": path, "method": method, "body": body, "mode": mode, "timeoutMs": timeout_ms},
            timeout=timeout_ms / 1000 + 20,
        )
        return _unwrap(resp)

    return call


class FlowMusic:
    def __init__(self, call: Call, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep) -> None:
        self.call = call
        self.sleep = sleep

    async def _must(self, what: str, path: str, **kw) -> Any:
        r = await self.call(path, **kw)
        if not r or not r.get("ok"):
            raise classify(r, what)
        return r.get("data")

    async def credits(self) -> Optional[int]:
        d = await self._must("credits", "/billing/credits")
        try:
            return d["data"]["credits_remaining"]
        except Exception:  # noqa: BLE001
            raise MusicError("flowmusic_api_changed", "credits shape")

    async def create_conversation(self) -> str:
        d = await self._must("conversation", "/conversation/create", method="POST", body={})
        cid = (d or {}).get("conversation_id") or (d or {}).get("id")
        if not cid:
            raise MusicError("flowmusic_api_changed", "no conversation_id")
        return cid

    async def start_song(self, *, sound_prompt: str, lyrics: Optional[str], instrumental: bool,
                         title: str, model: str, seed: Optional[int],
                         conversation_id: Optional[str] = None) -> tuple[str, str]:
        conv = conversation_id or await self.create_conversation()
        text = "" if instrumental else (lyrics or "").strip()
        lid = lyrics_id(text)
        body = {
            "conversation_id": conv,
            "part": {
                "tool_name": "audio__create_song",
                "part_kind": "tool-call",
                "tool_call_id": str(uuid.uuid4()),
                "args": {"sound_prompt": sound_prompt, "lyrics_id": lid,
                         "title": title or "Untitled", "seed": seed, "image_id": None},
            },
            "client_context": {
                "current_song_id": None,
                "song_queue": [],
                "selected_model": model or DEFAULT_MODEL,
                "lyrics_id_map": {lid: text} if lid else {},
                "client_platform": "web",
            },
        }
        d = await self._must("create song", "/producer/tool-call", method="POST", body=body)
        job = (d or {}).get("job_id")
        if not job:
            raise MusicError("flowmusic_api_changed", "no job_id")
        return conv, job

    async def read_job(self, job_id: str) -> dict:
        """SSE of a job. It may report an error while the song is still being
        created, so a missing operation is not a failure by itself."""
        r = await self.call(f"/messages/{job_id}/stream?last_id=0", mode="text", timeout_ms=240000)
        text = r.get("data") if r and isinstance(r.get("data"), str) else ""
        if r and not r.get("ok") and not text:
            err = classify(r, "stream")
            if err.code in ("no_session", "extension_offline", "busy"):
                raise err
        return {
            "ops": _uniq(re.findall(rf'"operation_id"\s*:\s*"({_UUID})"', text)),
            "clips": _uniq(re.findall(rf'"clip_id"\s*:\s*"({_UUID})"', text)),
            "errors": re.findall(r"event:\s*error\s*\r?\ndata:\s*(.+)", text),
            "blocked": _looks_blocked(text) and "operation_id" not in text,
        }

    async def find_in_conversation(self, conv: str) -> dict:
        r = await self.call(f"/conversations/{conv}")
        s = json.dumps((r or {}).get("data") or {})
        return {
            "ops": _uniq(re.findall(rf'"operation_id"\s*:\s*"({_UUID})"', s)),
            "clips": _uniq(re.findall(rf'"clip_id"\s*:\s*"({_UUID})"', s)),
        }

    async def resolve_operations(self, conv: str, job_id: str, *, tries: int = 6,
                                 gap_s: float = 3.0) -> list[str]:
        info = await self.read_job(job_id)
        if info["ops"]:
            return info["ops"]
        if info["blocked"]:
            raise MusicError("blocked_content", "; ".join(info["errors"])[:200])
        for i in range(tries):
            found = await self.find_in_conversation(conv)
            if found["ops"]:
                return found["ops"][-1:]
            if i < tries - 1:
                await self.sleep(gap_s)
        raise MusicError("flowmusic_api_changed", "operation_id not found: " + "; ".join(info["errors"])[:200])

    async def op_status(self, op: str) -> dict:
        return await self._must("status", f"/audio-create-song-status/{op}")

    async def wait_operation(self, op: str, *, timeout_s: float = 600, poll_s: float = 5,
                             is_canceled: Optional[Callable[[], bool]] = None) -> dict:
        end = time.monotonic() + timeout_s
        while True:
            s = await self.op_status(op)
            st = (s or {}).get("status")
            if st == "complete" and s.get("clip_id"):
                return s
            if st in ("failed", "error", "cancelled", "canceled"):
                msg = f"{s.get('error_type') or st} {s.get('error_message') or ''}".strip()
                raise MusicError("blocked_content" if _looks_blocked(msg) else "flowmusic_api_changed", msg)
            if is_canceled and is_canceled():
                raise MusicError("cancelled")
            if time.monotonic() > end:
                raise MusicError("timeout", "waiting for song")
            await self.sleep(poll_s)

    async def clips(self, ids: list[str]) -> dict:
        d = await self._must("clips", "/clips", method="POST", body={"clip_ids": ids})
        return (d or {}).get("clips") or {}

    async def download_audio(self, clip_id: str, fmt: str = "mp3") -> bytes:
        q = "" if fmt == "m4a" else f"?format={fmt}"
        r = await self.call(f"/download/audio/{clip_id}{q}", mode="base64", timeout_ms=180000)
        if not r or not r.get("ok"):
            raise classify(r, f"download {fmt}")
        return base64.b64decode(r.get("data") or "")

    async def stems(self, clip_id: str) -> dict[str, bytes]:
        d = await self._must("stems", f"/stems/clip/{clip_id}", timeout_ms=180000)
        out = {}
        for name, b64 in ((d or {}).get("stems") or {}).items():
            out[name] = base64.b64decode(b64)
        return out


def _uniq(items: list[str]) -> list[str]:
    seen: dict[str, None] = {}
    for i in items:
        seen.setdefault(i)
    return list(seen)


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "song").lower()).strip("-")[:40] or "song"


def _sniff_ext(b: bytes) -> str:
    if b[:4] == b"RIFF":
        return "wav"
    if b[4:8] == b"ftyp":
        return "m4a"
    return "mp3"


async def generate_songs(fm: FlowMusic, params: dict, out_dir: Path, *,
                         is_canceled: Optional[Callable[[], bool]] = None,
                         timeout_s: float = 600, poll_s: float = 5,
                         busy_retries: int = 5, busy_wait_s: float = 15) -> dict:
    """Run one ``gen_music`` job on one account; returns the result dict.
    On failure raises MusicError with ``partial`` takes attached."""
    wanted = max(1, min(int(params.get("takes") or 1), 4))
    formats = [f for f in (params.get("formats") or ["mp3"]) if f in ("mp3", "wav", "m4a")] or ["mp3"]
    out_dir.mkdir(parents=True, exist_ok=True)
    before = await fm.credits()
    if before is not None and before < CREDITS_PER_SONG * wanted:
        raise MusicError("credits_exhausted", f"{before} credits left")
    takes: list[dict] = []
    seen_clips: set[str] = set()
    try:
        for n in range(wanted):
            if is_canceled and is_canceled():
                raise MusicError("cancelled")
            for attempt in range(busy_retries + 1):
                try:
                    conv, job = await fm.start_song(
                        sound_prompt=params["sound_prompt"], lyrics=params.get("lyrics"),
                        instrumental=bool(params.get("instrumental")),
                        title=params.get("title") or "Untitled",
                        model=params.get("model") or DEFAULT_MODEL, seed=params.get("seed"))
                    break
                except MusicError as e:
                    if e.code != "busy" or attempt >= busy_retries:
                        raise
                    await fm.sleep(busy_wait_s)
            ops = await fm.resolve_operations(conv, job)
            for op in ops:
                st = await fm.wait_operation(op, timeout_s=timeout_s, poll_s=poll_s, is_canceled=is_canceled)
                clip_id = st["clip_id"]
                if clip_id in seen_clips:
                    continue
                seen_clips.add(clip_id)
                info = (await fm.clips([clip_id])).get(clip_id) or {}
                title = info.get("title") or params.get("title") or "Untitled"
                base = f"{_slug(title)}-{len(takes) + 1}"
                files = {}
                for fmt in formats:
                    data = await fm.download_audio(clip_id, fmt)
                    p = out_dir / f"{base}.{fmt}"
                    p.write_bytes(data)
                    files[fmt] = p.name
                lyr = ((info.get("lyrics") or {}).get("value") or {}).get("text")
                takes.append({
                    "clip_id": clip_id, "op_id": op, "title": title,
                    "duration_s": (info.get("duration") or {}).get("value"),
                    "audio_url": info.get("audio_url"), "wav_url": info.get("wav_url"),
                    "image_url": info.get("image_url"), "lyrics": lyr, "files": files,
                })
            if len(takes) >= wanted:
                break
    except MusicError as e:
        e.partial = takes  # type: ignore[attr-defined]
        raise
    after = None
    try:
        after = await fm.credits()
    except MusicError:
        pass
    used = (before - after) if (before is not None and after is not None and before >= after) else None
    return {"takes": takes[:wanted] if takes else takes, "credits_used": used,
            "credits_remaining": after}


# ── account selection (1 running music job per account) ───────────────────
_locks: dict[str, asyncio.Lock] = {}


def lock_for(key: str) -> asyncio.Lock:
    return _locks.setdefault(key, asyncio.Lock())


def is_busy(key: str) -> bool:
    lk = _locks.get(key)
    return bool(lk and lk.locked())


def music_key(pool: Any, client: Any) -> str:
    return "music:" + pool.key_of(client)


def candidates(pool: Any, only: Optional[str] = None) -> list[Any]:
    out = []
    for c in pool.connected_clients():
        k = pool.key_of(c)
        if not pool.identified(c):
            continue
        if only and k != only.lower():
            continue
        out.append(c)
    return out


async def run_job(params: dict, pool: Any, out_dir: Path, *, is_canceled=None,
                  fm_factory: Callable[[Any], FlowMusic] = lambda c: FlowMusic(bridge_call(c)),
                  **kw) -> tuple[dict, Optional[str]]:
    """Pick an account, hold its music lock, generate; on credits_exhausted or
    no_session move on to the next account. Returns (result, error_code)."""
    cands = candidates(pool, params.get("account"))
    if not cands:
        return {}, "extension_offline"
    tried: list[str] = []
    last: Optional[MusicError] = None
    while True:
        now = time.time()
        avail = [c for c in cands
                 if music_key(pool, c) not in tried and pool._exhausted(music_key(pool, c), now) is None]
        if not avail:
            return ({"tried": tried}, last.code if last else "credits_exhausted")
        # prefer an idle account; otherwise queue on the first one
        client = next((c for c in avail if not is_busy(music_key(pool, c))), avail[0])
        mkey = music_key(pool, client)
        async with lock_for(mkey):
            try:
                with pool.pin(client):
                    res = await generate_songs(fm_factory(client), params, out_dir, is_canceled=is_canceled, **kw)
                res["account"] = pool.key_of(client)
                return res, None
            except MusicError as e:
                last = e
                partial = getattr(e, "partial", [])
                if e.code == "credits_exhausted":
                    pool.mark_exhausted_key(mkey, e.detail, EXHAUSTED_HOLD_S)
                    tried.append(mkey)
                    continue
                if e.code in ("no_session", "extension_offline"):
                    tried.append(mkey)
                    if len(tried) < len(cands):
                        continue
                return ({"takes": partial, "account": pool.key_of(client),
                         "error_detail": e.detail}, e.code)


async def run_stems(params: dict, pool: Any, out_dir: Path, *,
                    fm_factory: Callable[[Any], FlowMusic] = lambda c: FlowMusic(bridge_call(c))
                    ) -> tuple[dict, Optional[str]]:
    cands = candidates(pool, params.get("account"))
    if not cands:
        return {}, "extension_offline"
    client = cands[0]
    async with lock_for(music_key(pool, client)):
        try:
            with pool.pin(client):
                stems = await fm_factory(client).stems(params["clip_id"])
        except MusicError as e:
            return {"error_detail": e.detail}, e.code
    out_dir.mkdir(parents=True, exist_ok=True)
    files = {}
    for name, data in stems.items():
        p = out_dir / f"{_slug(name)}.{_sniff_ext(data)}"
        p.write_bytes(data)
        files[name] = p.name
    return {"clip_id": params["clip_id"], "stems": files, "account": pool.key_of(client)}, None
