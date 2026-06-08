"""Assistant node — LLM chat with optional vision from upstream nodes.

When the Assistant node has upstream edges from a node carrying a
``mediaId`` (Image / Character / Visual asset / Storyboard), the backend
auto-attaches those images to the LLM call as multimodal input.

Routing
-------
- ``model`` starts with ``gemini-`` → Gemini REST/SDK (needs GEMINI_API_KEY)
- ``model`` starts with ``claude-`` (or alias opus/sonnet/haiku) → ``claude``
  CLI subprocess (no API key — uses the user's CLI login)

For images:
- Gemini: passed as inline_data Parts (SDK) or base64 in REST contents.
- Claude CLI: referenced via ``@/path`` syntax, which the CLI loads as
  multimodal attachments in --print mode.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Edge, Node

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/assistant", tags=["assistant"])

AssistantModel = Literal[
    # Gemini
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    # Claude (CLI subprocess)
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    "opus",
    "sonnet",
    "haiku",
]

# Where the agent caches downloaded media on disk. Resolved relative to
# the agent's CWD (which is `agent/` when started by the uvicorn cmd).
# NOTE: Flowboard's media route streams from Flow CDN but does NOT
# always write to this directory (the cache strategy is internal +
# variant-dependent). So we maintain our own temp cache below and use
# this only as an optional fast-path probe.
_MEDIA_STORAGE = Path("storage/media")

# Our own image cache — populated by fetching bytes via the agent's
# loopback /media endpoint. Lives in the OS temp dir so the OS cleans
# it up on reboot. Files are keyed by mediaId, so subsequent Assistant
# runs against the same image hit this cache and skip the HTTP roundtrip.
_ASSISTANT_TMP = Path(tempfile.gettempdir()) / "flowboard-assistant-images"

# Extensions we recognise as images. Order matters: most-common first
# to keep the resolution loop fast.
_IMAGE_EXTS: tuple[tuple[str, str], ...] = (
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".webp", "image/webp"),
    (".gif", "image/gif"),
)


class AssistantRunRequest(BaseModel):
    node_id: int
    prompt: str = Field(min_length=1, max_length=200_000)
    model: AssistantModel = "gemini-2.5-flash"


class AssistantRunResponse(BaseModel):
    node_id: int
    response: str
    model: str
    # How many upstream images we attached to this call. Surfaced so the
    # frontend can show "(with N images)" feedback after a run.
    attached_images: int = 0


# ─────────────────────────────────────────────────────────────────────────
# Auth + provider routing helpers
# ─────────────────────────────────────────────────────────────────────────


def _resolve_gemini_api_key() -> str:
    key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if not key:
        raise HTTPException(
            status_code=503,
            detail=(
                "GEMINI_API_KEY environment variable is not set. "
                "Get a free key at https://aistudio.google.com/apikey "
                "and export it before starting the agent. "
                "(Tip: switch the model to a Claude option to skip this — "
                "Claude uses your CLI login.)"
            ),
        )
    return key


def _is_claude_model(model: str) -> bool:
    return model.startswith("claude-") or model in ("opus", "sonnet", "haiku")


def _mime_for(p: Path) -> str:
    """Guess MIME from extension; defaults to image/png on unknown."""
    suf = p.suffix.lower()
    for ext, mime in _IMAGE_EXTS:
        if ext == suf:
            return mime
    return "image/png"


# ─────────────────────────────────────────────────────────────────────────
# Upstream image resolution — walk edges, find media files on disk
# ─────────────────────────────────────────────────────────────────────────


_MIME_TO_EXT: dict[str, str] = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def _check_local_caches(media_id: str) -> Path | None:
    """Look for the media file in either our temp cache or the agent's
    storage dir. Pure filesystem — no network."""
    clean = media_id.replace("media/", "").strip()
    if not clean:
        return None
    # Our temp cache first — most recent + closest to what we wrote.
    if _ASSISTANT_TMP.exists():
        for ext, _mime in _IMAGE_EXTS:
            p = _ASSISTANT_TMP / f"{clean}{ext}"
            if p.exists():
                return p
        matches = list(_ASSISTANT_TMP.glob(f"{clean}*"))
        if matches:
            return matches[0]
    # Then the agent's own storage (in case it does happen to cache).
    if _MEDIA_STORAGE.exists():
        for ext, _mime in _IMAGE_EXTS:
            p = _MEDIA_STORAGE / f"{clean}{ext}"
            if p.exists():
                return p
        matches = list(_MEDIA_STORAGE.glob(f"{clean}*"))
        if matches:
            return matches[0]
    return None


async def _resolve_media_file(media_id: str) -> Path | None:
    """Resolve a mediaId to a local image file. Strategy:

    1. Fast-path: check our own temp cache + agent storage dir for any
       existing file matching the mediaId.
    2. Slow-path: fetch bytes from the agent's loopback ``/media/{id}``
       endpoint (which streams from Flow CDN under the hood), write to
       our temp cache, and return that path.

    This is more robust than relying on the agent's internal cache —
    different node types / variants don't all persist to
    ``storage/media/`` consistently, but the ``/media/{id}`` route
    always returns bytes.
    """
    cached = _check_local_caches(media_id)
    if cached:
        return cached

    clean = media_id.replace("media/", "").strip()
    if not clean:
        return None

    # Fetch via loopback to our own /media endpoint.
    try:
        import httpx

        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.get(f"http://127.0.0.1:8101/media/{clean}")
    except Exception as e:
        logger.warning(
            "assistant: /media/%s fetch raised %s: %s",
            clean,
            type(e).__name__,
            e,
        )
        return None
    if r.status_code != 200:
        logger.warning(
            "assistant: /media/%s returned HTTP %d",
            clean,
            r.status_code,
        )
        return None

    # Pick the extension off the response's Content-Type header. Fall
    # back to .png when the header is missing / unrecognised.
    mime = (r.headers.get("content-type") or "image/png").split(";")[0].strip().lower()
    ext = _MIME_TO_EXT.get(mime, ".png")

    try:
        _ASSISTANT_TMP.mkdir(parents=True, exist_ok=True)
        tmp_path = _ASSISTANT_TMP / f"{clean}{ext}"
        tmp_path.write_bytes(r.content)
        logger.info(
            "assistant: cached media %s → %s (%d bytes, %s)",
            clean,
            tmp_path,
            len(r.content),
            mime,
        )
        return tmp_path
    except OSError as e:
        logger.warning("assistant: could not write temp file for %s: %s", clean, e)
        return None


# Matches @-mentions inserted by the frontend's MentionAutocomplete.
#
# Two formats supported (the regex captures both):
#   • NEW: ``@<DisplayName> #<shortId>`` with a space before ``#``.
#     DisplayName can contain unicode + spaces (e.g. "Cờ Argentina"),
#     so the name group accepts any char except @ / newline / #.
#   • LEGACY: ``@<Type>#<shortId>`` no space (older insertions before
#     the renamed-display feature).
#
# The leading lookbehind `(?:^|(?<=\s))` keeps us from matching email
# addresses like ``user@domain.com`` mid-prompt.
_MENTION_RE = re.compile(
    r"(?:^|(?<=\s))@([^@\n#]+?)\s?#([A-Za-z0-9_-]+)"
)


def _resolve_mentioned_nodes(prompt: str) -> tuple[list[Node], list[str]]:
    """Parse `@Type#shortId` tags out of the prompt and return the
    matching Node rows plus the original mention texts.

    Mentioned nodes are looked up by ``short_id`` ONLY (the type is a
    UI hint — we don't reject mismatches because the user might rename
    a node's type by editing data, and the shortId is the unique key).
    Returns a 2-tuple so the caller can build a context block that
    references each mention by its inline text.
    """
    mentions = _MENTION_RE.findall(prompt)
    if not mentions:
        return [], []
    short_ids = [sid for _, sid in mentions]
    matched: list[Node] = []
    with get_session() as s:
        rows = s.exec(
            select(Node).where(Node.short_id.in_(short_ids))  # type: ignore[attr-defined]
        ).all()
        # Preserve mention order so the upstream image-loader walks
        # them in the same order the user typed.
        by_id = {n.short_id: n for n in rows}
        for _, sid in mentions:
            n = by_id.get(sid)
            if n and n not in matched:
                matched.append(n)
    mention_texts = [f"@{t}#{sid}" for t, sid in mentions]
    return matched, mention_texts


async def _collect_mentioned_images(prompt: str) -> tuple[list[Path], list[Node]]:
    """For each node mentioned in the prompt, fetch its image bytes
    (if any) via the same lazy-cache path used for upstream walking.
    Returns (image_paths, mention_nodes) so the caller can also build
    a text context block from the non-image mentions."""
    nodes, _ = _resolve_mentioned_nodes(prompt)
    if not nodes:
        return [], []
    # Extract mediaIds the same way `_collect_upstream_images` does.
    mids: list[str] = []
    for n in nodes:
        data = n.data or {}
        mid: str | None = None
        if isinstance(data.get("mediaIds"), list) and data["mediaIds"]:
            first = data["mediaIds"][0]
            if isinstance(first, str):
                mid = first
        if not mid and isinstance(data.get("mediaId"), str):
            mid = data["mediaId"]
        if mid:
            mids.append(mid)
    results = await asyncio.gather(
        *(_resolve_media_file(mid) for mid in mids),
        return_exceptions=True,
    )
    paths: list[Path] = []
    for r in results:
        if isinstance(r, Path):
            paths.append(r)
    return paths, nodes


def _build_mention_context_block(mention_nodes: list[Node]) -> str:
    """Build a short context block that gets prepended to the user's
    prompt so the LLM knows what each @-mention refers to. Includes
    the node's aiBrief / response text inline; image bytes are
    attached separately as multimodal inputs."""
    if not mention_nodes:
        return ""
    lines: list[str] = ["[Context for @-mentions in the user's prompt:]"]
    for n in mention_nodes:
        data = n.data or {}
        # Pick the best text representation for each node type.
        text = ""
        if isinstance(data.get("assistantResponse"), str) and data["assistantResponse"]:
            text = data["assistantResponse"]
        elif isinstance(data.get("aiBrief"), str) and data["aiBrief"]:
            text = data["aiBrief"]
        elif isinstance(data.get("prompt"), str) and data["prompt"]:
            text = data["prompt"]
        else:
            text = "(no text content)"
        # Truncate to keep the context block bounded.
        if len(text) > 800:
            text = text[:800].rstrip() + "…"
        lines.append(f"  @{n.type}#{n.short_id}: {text}")
    lines.append("")
    return "\n".join(lines) + "\n"


async def _collect_upstream_images(node_id: int) -> list[Path]:
    """Walk inbound edges, gather media file paths for image-bearing
    source nodes. Triggers lazy-fetch from Flow CDN when the file isn't
    cached locally yet.

    Multi-variant images: when the source node has ``data.mediaIds``
    (a list, one entry per generated variant) we honour the edge's
    ``source_variant_idx`` to pick the correct one. Falls back to index
    0 when the edge isn't pinned.
    """
    # First gather mediaIds synchronously (DB ops are sync) so the DB
    # session closes before we start the async HTTP fetches.
    targets: list[tuple[int, str]] = []  # (source_node_id, media_id)
    with get_session() as s:
        edges = s.exec(select(Edge).where(Edge.target_id == node_id)).all()
        for edge in edges:
            src = s.get(Node, edge.source_id)
            if not src:
                continue
            data = src.data or {}
            media_id: str | None = None
            media_ids = data.get("mediaIds")
            if isinstance(media_ids, list) and media_ids:
                idx = edge.source_variant_idx if edge.source_variant_idx is not None else 0
                if 0 <= idx < len(media_ids) and isinstance(media_ids[idx], str):
                    media_id = media_ids[idx]
            if not media_id:
                mid = data.get("mediaId")
                if isinstance(mid, str):
                    media_id = mid
            if media_id:
                targets.append((src.id, media_id))

    # Now resolve them concurrently — each call may issue an HTTP
    # request to trigger lazy-fetch, so doing them in parallel keeps
    # the worst-case latency bounded.
    results = await asyncio.gather(
        *(_resolve_media_file(mid) for _, mid in targets),
        return_exceptions=True,
    )
    paths: list[Path] = []
    for (src_id, mid), result in zip(targets, results):
        if isinstance(result, Path):
            paths.append(result)
        else:
            logger.warning(
                "assistant: upstream node %s mediaId=%s could not be resolved",
                src_id,
                mid,
            )
    return paths


# ─────────────────────────────────────────────────────────────────────────
# Provider calls
# ─────────────────────────────────────────────────────────────────────────


async def _call_claude_cli(model: str, prompt: str, image_paths: list[Path]) -> str:
    """Run the user's ``claude`` CLI in --print mode. Images are passed
    via ``@/absolute/path`` references which Claude Code resolves as
    multimodal attachments.
    """
    if image_paths:
        # One @-reference per line, then a blank line, then the prompt.
        refs = "\n".join(f"@{p.resolve()}" for p in image_paths)
        full_prompt = f"{refs}\n\n{prompt}"
    else:
        full_prompt = prompt

    try:
        # `--dangerously-skip-permissions` is the headless equivalent of
        # the user clicking "Allow" on every tool-use prompt. Required
        # because Claude Code in `--print` mode routes `@/path/img.png`
        # references through the Read tool, which would otherwise pause
        # waiting for an interactive permission grant — and since we
        # have no TTY, Claude bails out with "need permission" text
        # while only seeing a partial / hallucinated version of the image.
        #
        # Safe in this context: the subprocess is spawned by the agent,
        # the file paths it operates on are inside our own temp dir
        # (`/tmp/flowboard-assistant-images/`), and Claude CLI uses
        # the user's auth — there's no privilege escalation surface.
        proc = await asyncio.create_subprocess_exec(
            "claude",
            "--print",
            "--model",
            model,
            "--dangerously-skip-permissions",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as e:
        raise HTTPException(
            status_code=503,
            detail=(
                "`claude` CLI not found on PATH. Install from "
                "https://docs.claude.com/claude-code/install and run "
                "`claude` once to log in."
            ),
        ) from e

    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(input=full_prompt.encode("utf-8")),
            timeout=300,
        )
    except asyncio.TimeoutError as e:
        try:
            proc.kill()
        except Exception:
            pass
        raise HTTPException(
            status_code=504,
            detail=f"Claude CLI timed out (>300s) for model '{model}'",
        ) from e

    if proc.returncode != 0:
        err = stderr.decode("utf-8", errors="replace").strip()[:1500]
        raise HTTPException(
            status_code=502,
            detail=(
                f"Claude CLI failed (exit {proc.returncode}): {err}. "
                "If 'authentication' is mentioned, run `claude` in a "
                "terminal and complete the login, then retry."
            ),
        )

    return stdout.decode("utf-8", errors="replace").strip()


async def _call_gemini(
    api_key: str, model: str, prompt: str, image_paths: list[Path]
) -> str:
    """Call Gemini with optional vision attachments. Prefers the
    google-genai SDK (typed multimodal Parts); falls back to raw REST
    when the SDK isn't installed."""
    # ── SDK path ─────────────────────────────────────────────────────
    try:
        from google import genai  # type: ignore
        from google.genai import types as genai_types  # type: ignore

        client = genai.Client(api_key=api_key)
        contents: list = []
        for p in image_paths:
            try:
                contents.append(
                    genai_types.Part.from_bytes(
                        data=p.read_bytes(), mime_type=_mime_for(p)
                    )
                )
            except Exception as e:
                logger.warning("assistant: skipping %s — could not read: %s", p, e)
        contents.append(prompt)
        result = client.models.generate_content(model=model, contents=contents)
        return result.text or ""
    except ImportError:
        pass
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gemini SDK error: {e}") from e

    # ── REST fallback ────────────────────────────────────────────────
    import httpx

    parts: list[dict] = []
    for p in image_paths:
        try:
            b64 = base64.b64encode(p.read_bytes()).decode("ascii")
            parts.append({"inline_data": {"mime_type": _mime_for(p), "data": b64}})
        except Exception as e:
            logger.warning("assistant: skipping %s in REST mode — %s", p, e)
    parts.append({"text": prompt})

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}"
        f":generateContent"
    )
    async with httpx.AsyncClient(timeout=180) as client:
        r = await client.post(
            url,
            params={"key": api_key},
            json={"contents": [{"parts": parts}]},
        )
    if r.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Gemini HTTP {r.status_code}: {r.text[:1024]}",
        )
    data = r.json()
    try:
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError) as e:
        raise HTTPException(
            status_code=502,
            detail=f"Unexpected Gemini response shape: {str(data)[:1024]}",
        ) from e


# ─────────────────────────────────────────────────────────────────────────
# Route handler
# ─────────────────────────────────────────────────────────────────────────


@router.post("/run", response_model=AssistantRunResponse)
async def run_assistant(body: AssistantRunRequest) -> AssistantRunResponse:
    """Run the Assistant node's prompt + upstream images, persist response."""
    # Validate the target node.
    with get_session() as s:
        node = s.get(Node, body.node_id)
        if not node:
            raise HTTPException(status_code=404, detail="node not found")
        if node.type not in ("assistant", "Assistant"):
            raise HTTPException(
                status_code=400,
                detail=f"node is type '{node.type}', not 'assistant'",
            )
        node.status = "running"
        s.add(node)
        s.commit()

    # Gather upstream image files. Done OUTSIDE the DB write transaction
    # above so the slow HTTP lazy-fetch doesn't block the status update
    # the UI is polling for. May make loopback HTTP calls to trigger
    # cache population from Flow CDN.
    upstream_paths = await _collect_upstream_images(body.node_id)

    # Also gather @-mentioned nodes from the prompt. These are explicit
    # references the user typed (e.g. "@Image#xqj1") and should override
    # / augment the implicit upstream walking. Images attach as multimodal
    # input; non-image mentions get folded into the prompt as a context
    # block so the LLM sees them inline.
    mention_paths, mention_nodes = await _collect_mentioned_images(body.prompt)

    # De-duplicate file paths — if a mention also happens to be an
    # upstream node, attach it once. Order: upstream first (matches the
    # implicit walk order users are used to), then mentions in the
    # order they appear in the prompt.
    seen: set[str] = set()
    image_paths: list[Path] = []
    for p in upstream_paths + mention_paths:
        key = str(p.resolve())
        if key not in seen:
            seen.add(key)
            image_paths.append(p)

    # Build the augmented prompt: mention context (if any) + user text.
    mention_block = _build_mention_context_block(mention_nodes)
    effective_prompt = mention_block + body.prompt if mention_block else body.prompt

    logger.info(
        "assistant.run node_id=%s model=%s upstream=%d mentions=%d images=%d",
        body.node_id,
        body.model,
        len(upstream_paths),
        len(mention_nodes),
        len(image_paths),
    )

    # Dispatch to the right backend.
    try:
        if _is_claude_model(body.model):
            response_text = await _call_claude_cli(
                body.model, effective_prompt, image_paths
            )
        else:
            api_key = _resolve_gemini_api_key()
            response_text = await _call_gemini(
                api_key, body.model, effective_prompt, image_paths
            )
    except HTTPException:
        # Surface the error visually on the canvas before re-raising.
        with get_session() as s:
            node = s.get(Node, body.node_id)
            if node:
                node.status = "error"
                s.add(node)
                s.commit()
        raise

    # Persist + transition to done.
    #
    # We mirror ``response_text`` to TWO fields on the node:
    #   - ``assistantResponse`` — the canonical place the AssistantNodeCard
    #     reads from to render its Result tab.
    #   - ``aiBrief`` — the field Flowboard's existing auto-prompt
    #     synthesiser already walks for when a downstream Image / Video
    #     node is generated with an empty prompt. Tagging the Assistant's
    #     response into ``aiBrief`` makes its analysis "flow downstream"
    #     into image / video generation without any other route changes.
    with get_session() as s:
        node = s.get(Node, body.node_id)
        if node:
            new_data = dict(node.data or {})
            new_data["prompt"] = body.prompt
            new_data["assistantResponse"] = response_text
            new_data["assistantModel"] = body.model
            new_data["assistantAttachedImages"] = len(image_paths)
            new_data["aiBrief"] = response_text
            # Clear any stale "pending" status the vision pipeline might
            # have set on this field — we're definitively done.
            new_data["aiBriefStatus"] = "done"
            node.data = new_data
            node.status = "done"
            s.add(node)
            s.commit()

    return AssistantRunResponse(
        node_id=body.node_id,
        response=response_text,
        model=body.model,
        attached_images=len(image_paths),
    )
