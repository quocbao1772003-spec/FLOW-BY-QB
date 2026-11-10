"""In-process worker that drains queued generation requests.

Scope for Run 3 (Phase 2 bridge): a single handler type `"proxy"` that
forwards `params = {url, method?, headers?, body?}` through the extension
via ``flow_client.api_request``. Further types (gen_image, gen_video,
upload_image, etc.) land in later runs once the full Flow protocol + captcha
round-trip is ported.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

from flowboard.db import get_session
from flowboard.db.models import Request
from flowboard.services import media as media_service
from flowboard.services.flow_client import flow_client
from flowboard.services.flow_sdk import get_flow_sdk

logger = logging.getLogger(__name__)


# type → coroutine(params) → (result_dict, error_or_None)
Handler = Callable[[dict], Awaitable[tuple[dict, Optional[str]]]]


_ALLOWED_URL_PREFIXES: tuple[str, ...] = (
    "https://aisandbox-pa.googleapis.com/",
)


async def _handle_proxy(params: dict) -> tuple[dict, Optional[str]]:
    url = params.get("url")
    method = params.get("method", "POST")
    if not isinstance(url, str) or not url:
        return {}, "missing_url"
    # Defense-in-depth: refuse to proxy URLs outside the expected allowlist
    # even if the extension's own check was somehow bypassed.
    if not any(url.startswith(p) for p in _ALLOWED_URL_PREFIXES):
        return {}, "url_not_allowed"
    resp = await flow_client.api_request(
        url=url,
        method=method,
        headers=params.get("headers") or {},
        body=params.get("body"),
    )
    if not isinstance(resp, dict):
        return {"value": resp}, None
    if resp.get("error"):
        return resp, str(resp["error"])[:200]
    status = resp.get("status")
    if isinstance(status, int) and status >= 400:
        return resp, f"API_{status}"
    return resp, None


# ── stale reference recovery ──────────────────────────────────────────────
# Flow answers a generate whose reference image it can no longer see with
# boq status 5 (NOT_FOUND) and no media — surfaced here as
# `BOQ_RPC_5_NOT_FOUND …` (new extension) or as a raw
# `["wrb.fr","ogiZ0b",null,null,null,[5],…]` head inside BOQ_NO_MEDIA_URL
# (older extension). The board still holds the dead id, so every retry fails
# the same way. Recovery: re-upload the refs from the local cache under the
# project and try once more.
_NOT_FOUND_MARKERS = (
    "RPC_5_NOT_FOUND",
    "Requested entity was not found",
)


def _is_ref_not_found(err: Optional[str]) -> bool:
    if not isinstance(err, str) or not err:
        return False
    if any(m in err for m in _NOT_FOUND_MARKERS):
        return True
    # Raw boq envelope: wrb.fr frame with a null payload and status [5].
    return '"wrb.fr"' in err and ",null,[5]," in err.replace(" ", "")


async def _with_ref_recovery(
    project_id: str,
    ref_ids: list[str],
    dispatch: Callable[[list[str]], Awaitable[dict]],
    initial_refs: Optional[list[str]] = None,
) -> dict:
    """Run ``dispatch(refs)``; on a NOT_FOUND failure re-upload ``ref_ids``
    under the project and dispatch once more with the fresh ids."""
    from flowboard.services.media_project_sync import force_reupload, substitute_cached

    if not ref_ids:
        return await dispatch([])
    first_try = initial_refs if initial_refs is not None else substitute_cached(ref_ids, project_id)
    resp = await dispatch(first_try)
    if not _is_ref_not_found(resp.get("error")):
        return resp
    logger.warning(
        "Flow could not find a reference image (%s) — re-uploading %d ref(s) to project %s",
        str(resp.get("error"))[:120], len(ref_ids), project_id,
    )
    new_ids, failures = await force_reupload(ref_ids, project_id)
    if failures:
        detail = "; ".join(f"{m[:8]}: {e}" for m, e in failures)[:150]
        resp = dict(resp)
        resp["error"] = f"REF_NOT_FOUND_REUPLOAD_FAILED ({detail}) — {resp.get('error')}"
        return resp
    retry = await dispatch(new_ids)
    if retry.get("error"):
        retry = dict(retry)
        retry["error"] = f"{retry['error']} (still failing after re-uploading refs)"
    return retry


async def _handle_create_project(params: dict) -> tuple[dict, Optional[str]]:
    name = params.get("name") or params.get("title") or "Untitled"
    if not isinstance(name, str) or not name.strip():
        return {}, "missing_name"
    tool = params.get("tool", "PINHOLE")
    resp = await get_flow_sdk().create_project(name.strip(), tool)
    if resp.get("error"):
        return resp, str(resp["error"])[:200]
    return resp, None


# One Flow project per Google account per app session for image generation.
_image_sessions: dict[str, str] = {}
_image_session_lock: Optional[asyncio.Lock] = None


def reset_image_project_session() -> None:
    global _image_session_lock
    _image_sessions.clear()
    _image_session_lock = None


async def _new_image_project(ref_ids: list[str]) -> dict:
    """Create lazily once per app session and account; sync references into
    that project (re-uploading from the local cache when they live in another
    project or another account)."""
    global _image_session_lock
    from flowboard.services import account_projects
    from flowboard.services.flow_sdk import is_valid_project_id
    from flowboard.services.media_project_sync import ensure_media_ids_in_project

    if _image_session_lock is None:
        _image_session_lock = asyncio.Lock()
    async with _image_session_lock:
        account = account_projects.current_account() or "_"
        project_id = _image_sessions.get(account)
        if project_id is None:
            created = await get_flow_sdk().create_project(
                "Flowboard Session " + datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                "PINHOLE",
            )
            project_id = created.get("project_id")
            if created.get("error") or not isinstance(project_id, str) or not is_valid_project_id(project_id):
                return {"error": "NEW_IMAGE_PROJECT_FAILED: " + str(created.get("error") or "invalid_project_id"), "raw": created}
            _image_sessions[account] = project_id
            account_projects.record_project(project_id, None if account == "_" else account)
    synced, failures = await ensure_media_ids_in_project(ref_ids, project_id)
    if failures or len(synced) != len(ref_ids):
        return {"project_id": project_id, "sync_failures": failures,
                "error": "NEW_IMAGE_PROJECT_REF_SYNC_FAILED: " + str(failures)[:150]}
    return {"project_id": project_id, "ref_media_ids": synced}


async def _project_for_this_account(params: dict, project_id: str) -> tuple[str, Optional[str]]:
    """Video jobs arrive with the board's project id from the UI. If that
    project belongs to another Google account than the one this job runs on,
    switch to (or create) the board's project for this account."""
    from flowboard.db.models import Node
    from flowboard.services import account_projects

    if account_projects.project_usable(project_id):
        return project_id, None
    node_id = params.get("__node_id")
    board_id = None
    if isinstance(node_id, int):
        with get_session() as s:
            node = s.get(Node, node_id)
            board_id = node.board_id if node else None
    if board_id is None:
        return project_id, None
    try:
        pid, _ = await account_projects.ensure_board_project(board_id)
        return pid, None
    except Exception as exc:  # noqa: BLE001
        return project_id, f"account_project_failed: {exc}"[:200]


async def _media_for_project(media_ids: list[str], project_id: str) -> tuple[list[str], Optional[str]]:
    """Make start images from another account usable in ``project_id``."""
    from flowboard.services import account_projects
    from flowboard.services.media_project_sync import ensure_media_ids_in_project

    if all(account_projects.media_usable(m) for m in media_ids):
        return media_ids, None
    synced, failures = await ensure_media_ids_in_project(media_ids, project_id)
    if failures or len(synced) != len(media_ids):
        return media_ids, "START_IMAGE_SYNC_FAILED: " + str(failures)[:150]
    return synced, None


async def _handle_gen_image(params: dict) -> tuple[dict, Optional[str]]:
    prompt = params.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    aspect = params.get("aspect_ratio") or "IMAGE_ASPECT_RATIO_LANDSCAPE"
    # Tier resolution: caller-stamped value first (set at dispatch time),
    # then the live value from `flow_client` (resolved authoritatively
    # via /v1/credits on token capture). NO silent default — if both
    # are absent we fail loud with `paygate_tier_unknown`. The old
    # behaviour (default `PAYGATE_TIER_ONE`) silently downgraded Ultra
    # users to Pro and stamped the wrong tier into request.params, which
    # then fed back through `_last_observed_paygate_tier_from_db()` and
    # corrupted /api/auth/me responses for the rest of the session.
    tier = params.get("paygate_tier") or flow_client.paygate_tier
    if tier is None:
        return {}, "paygate_tier_unknown"
    # `ref_media_ids` is the broader name (any upstream image / character /
    # visual_asset feeds in as IMAGE_INPUT_TYPE_REFERENCE). Older callers used
    # `character_media_ids` — accept both.
    raw_ref_ids = params.get("ref_media_ids")
    if not isinstance(raw_ref_ids, list):
        raw_ref_ids = params.get("character_media_ids")
    ref_media_ids: Optional[list[str]] = None
    if isinstance(raw_ref_ids, list):
        cleaned = [m for m in raw_ref_ids if isinstance(m, str) and m]
        ref_media_ids = cleaned or None
    raw_count = params.get("variant_count")
    variant_count = 1
    if isinstance(raw_count, int) and raw_count > 0:
        variant_count = raw_count
    # Per-variant prompts (optional). When provided, each variant gets its
    # own text — used by auto-prompt batch mode so variants don't collapse
    # to the same stance.
    raw_prompts = params.get("prompts")
    per_variant_prompts: Optional[list[str]] = None
    if isinstance(raw_prompts, list):
        cleaned = [p for p in raw_prompts if isinstance(p, str) and p.strip()]
        per_variant_prompts = cleaned or None
    image_model = params.get("image_model")
    if not isinstance(image_model, str) or not image_model.strip():
        image_model = None
    prepared = await _new_image_project(ref_media_ids or [])
    if prepared.get("error"):
        return prepared, str(prepared["error"])[:200]
    project_id = prepared["project_id"]
    async def _dispatch(refs: list[str]) -> dict:
        return await get_flow_sdk().gen_image(
            prompt=prompt.strip(),
            project_id=project_id,
            aspect_ratio=aspect,
            paygate_tier=tier,
            ref_media_ids=refs or None,
            variant_count=variant_count,
            prompts=per_variant_prompts,
            image_model=image_model,
        )

    # Keep original IDs for recovery: the synced IDs have no local files.
    # _with_ref_recovery resolves the project mapping before dispatching.
    resp = await _with_ref_recovery(
        project_id, ref_media_ids or [], _dispatch, prepared["ref_media_ids"]
    )
    resp["project_id"] = project_id
    if resp.get("error"):
        return resp, str(resp["error"])[:200]
    # Flow returns signed fifeUrls directly in the response — persist them
    # immediately so `/media/:id` can serve bytes without any extra round-trip.
    entries_with_urls = [
        e for e in (resp.get("media_entries") or []) if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from gen_image response failed")
    return resp, None


# Video polling knobs — overridable in tests. 15-minute hard deadline
# (90 cycles × 10s). Omni Flash (and longer Veo clips) routinely render for
# 6–10+ minutes server-side, so the previous 5-minute budget timed out on
# videos that Google was still producing (the batch was already accepted +
# credits charged — we just gave up polling too early). When the budget runs
# out without all ops finishing the handler returns the
# ``timeout_waiting_video`` sentinel and the worker stamps the row as
# ``status='timeout'`` (distinct from ``failed``) so the UI can render it as a
# soft auto-cancel rather than a generation error.
VIDEO_POLL_INTERVAL_S = 10.0
VIDEO_POLL_MAX_CYCLES = 90


def _is_request_canceled(rid: Optional[int]) -> bool:
    """Return True iff the cancel endpoint flipped this row to canceled.

    Long-running handlers call this between polls so a user-initiated
    cancel takes effect mid-flight (we can't abort the Flow HTTP calls
    themselves, but we can stop polling and let _process_one keep the
    canceled status intact).
    """
    if not isinstance(rid, int):
        return False
    with get_session() as s:
        req = s.get(Request, rid)
        if req is None:
            return True
        return req.status == "canceled"


async def _handle_gen_video(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services.flow_sdk import is_valid_project_id

    prompt = params.get("prompt")
    project_id = params.get("project_id")
    start_media_id = params.get("start_media_id") or params.get("startMediaId")
    raw_starts = params.get("start_media_ids")
    start_media_ids: Optional[list[str]] = None
    if isinstance(raw_starts, list):
        cleaned = [m for m in raw_starts if isinstance(m, str) and m.strip()]
        start_media_ids = [m.strip() for m in cleaned] or None

    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    # Either a single start_media_id OR a non-empty start_media_ids list.
    if start_media_ids is None and (
        not isinstance(start_media_id, str) or not start_media_id.strip()
    ):
        return {}, "missing_start_media_id"
    aspect = params.get("aspect_ratio") or "VIDEO_ASPECT_RATIO_LANDSCAPE"
    # Tier resolution — see the matching block in _handle_gen_image for
    # the rationale. No silent default; missing tier is a hard error so
    # we never dispatch an Ultra user's video at the Pro checkpoint.
    tier = params.get("paygate_tier") or flow_client.paygate_tier
    if tier is None:
        return {}, "paygate_tier_unknown"
    video_quality = params.get("video_quality")
    if not isinstance(video_quality, str) or not video_quality.strip():
        video_quality = None

    project_id, perr = await _project_for_this_account(params, project_id)
    if perr:
        return {}, perr
    single = start_media_id.strip() if isinstance(start_media_id, str) and start_media_id.strip() else None
    starts, serr = await _media_for_project(start_media_ids or ([single] if single else []), project_id)
    if serr:
        return {}, serr
    if start_media_ids:
        start_media_ids = starts
    else:
        single = starts[0] if starts else single

    sdk = get_flow_sdk()
    dispatch = await sdk.gen_video(
        prompt=prompt.strip(),
        project_id=project_id,
        start_media_id=single,
        start_media_ids=start_media_ids,
        aspect_ratio=aspect,
        paygate_tier=tier,
        video_quality=video_quality,
    )
    if dispatch.get("error"):
        return dispatch, str(dispatch["error"])[:200]

    op_names = dispatch.get("operation_names") or []
    if not op_names:
        return dispatch, "no_operations_returned"
    # NEW low-priority models return workflows (`{name, primary_media_id}`)
    # instead of operations; the SDK surfaces them on `dispatch["workflows"]`
    # so we can route the poll to /v1/media/<id> instead of batchCheckAsync.
    workflows = dispatch.get("workflows") or None

    poll_attempts = 0
    last_poll: dict = {}
    done_by_name: dict[str, bool] = {name: False for name in op_names}
    entry_by_name: dict[str, dict] = {}
    op_errors: dict[str, str] = {}
    rid = params.get("__request_id")

    # Per-op resolution: each operation in the batch resolves
    # independently (success, content-filter rejection, or timeout). We
    # used to break the whole loop on the first per-op error, which
    # collapsed a 4-variant gen into a hard failure even when 3/4 clips
    # had already rendered. Now we let every op terminate on its own
    # and aggregate the outcome at the end so partial batches still
    # surface the variants that did succeed.
    while (
        poll_attempts < VIDEO_POLL_MAX_CYCLES
        and not all(done_by_name.values())
    ):
        await asyncio.sleep(VIDEO_POLL_INTERVAL_S)
        poll_attempts += 1
        if _is_request_canceled(rid):
            # User canceled mid-poll. Bail with the special error code
            # so _process_one knows to leave the row's canceled status
            # intact (the cancel endpoint already stamped finished_at +
            # error='canceled'). Any partial state we collected is
            # preserved on `result` for the detail viewer.
            return (
                {
                    "raw_dispatch": dispatch,
                    "last_poll": last_poll,
                    "operation_names": op_names,
                    "done": done_by_name,
                    "canceled": True,
                },
                "canceled",
            )
        last_poll = await sdk.check_async(op_names, workflows=workflows)
        if last_poll.get("error"):
            continue
        for op in last_poll.get("operations") or []:
            if not isinstance(op, dict):
                continue
            name = op.get("name")
            if not isinstance(name, str) or done_by_name.get(name, False):
                continue
            # Per-op terminal failure (e.g. content filter
            # PUBLIC_ERROR_UNSAFE_GENERATION / PUBLIC_ERROR_AUDIO_FILTERED).
            # Mark this op resolved-with-error and keep polling the rest.
            err = op.get("error")
            if isinstance(err, str) and err:
                done_by_name[name] = True
                op_errors[name] = err
                continue
            if op.get("done"):
                done_by_name[name] = True
                # Each op is expected to yield exactly one media entry
                # on success; capture the first valid one.
                for e in op.get("media_entries") or []:
                    if isinstance(e, dict) and e.get("media_id"):
                        entry_by_name[name] = e
                        break

    # Slots still unresolved after the max cycles — record as timeout
    # so the partial summary names them alongside any filter failures.
    for name in op_names:
        if not done_by_name.get(name) and name not in op_errors:
            op_errors[name] = "timeout_waiting_video"

    # Build positional outcome aligned to dispatch order. Slot i in
    # `media_ids` corresponds to slot i in the original
    # `start_media_ids` array, so the frontend can keep upstream-image
    # variant ↔ video-variant alignment even when middle slots fail.
    # `slot_errors` mirrors the same indexing — `None` for succeeded
    # slots, error code for blocked ones — so the detail viewer can
    # render the exact filter reason on the blocked tile without
    # having to know the internal Flow op-name keys.
    positional_ids: list[Optional[str]] = []
    slot_errors: list[Optional[str]] = []
    succeeded_entries: list[dict] = []
    for name in op_names:
        e = entry_by_name.get(name)
        if isinstance(e, dict) and isinstance(e.get("media_id"), str):
            positional_ids.append(e["media_id"])
            succeeded_entries.append(e)
            slot_errors.append(None)
        else:
            positional_ids.append(None)
            slot_errors.append(op_errors.get(name))

    success_count = sum(1 for x in positional_ids if x)
    total = len(op_names)

    if success_count == 0:
        # No op produced a clip — surface the first error verbatim.
        # When all errors are "timeout_waiting_video" this matches the
        # legacy single-op timeout contract; tests rely on it.
        first_err = next(iter(op_errors.values()), "timeout_waiting_video")
        return (
            {
                "raw_dispatch": dispatch,
                "last_poll": last_poll,
                "operation_names": op_names,
                "done": done_by_name,
                "op_errors": op_errors,
            },
            first_err,
        )

    # ≥1 op succeeded — ingest only the bytes we actually have.
    entries_with_urls = [
        e for e in succeeded_entries if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from gen_video response failed")
    # Workflow-mode (Low Priority) deliveries arrive inline as base64 MP4
    # bytes on the `/v1/media/<id>` poll — there is no GCS URL to chase.
    # Plant the bytes in the local cache directly so the `/media/<id>` route
    # serves them like any URL-backed asset.
    for entry in succeeded_entries:
        if not isinstance(entry, dict):
            continue
        encoded = entry.get("encoded_video")
        mid = entry.get("media_id")
        if not isinstance(encoded, str) or not isinstance(mid, str):
            continue
        try:
            import base64 as _b64
            media_service.ingest_inline_bytes(
                mid, _b64.b64decode(encoded, validate=False),
                kind="video", mime="video/mp4",
            )
        except Exception:  # noqa: BLE001
            logger.exception("inline ingest from workflow-mode poll failed for %s", mid)

    partial_error: Optional[str] = None
    if op_errors:
        # De-dup distinct error codes for a compact one-line summary
        # (e.g. "1/4 variants blocked: PUBLIC_ERROR_UNSAFE_GENERATION").
        unique_errs = sorted({err for err in op_errors.values()})
        partial_error = (
            f"{len(op_errors)}/{total} variants blocked: {', '.join(unique_errs)}"
        )

    return (
        {
            "raw_dispatch": dispatch,
            "last_poll": last_poll,
            "operation_names": op_names,
            "media_ids": positional_ids,
            "media_entries": succeeded_entries,
            "op_errors": op_errors,
            "slot_errors": slot_errors,
            "partial_error": partial_error,
        },
        None,
    )


async def _handle_edit_image(params: dict) -> tuple[dict, Optional[str]]:
    prompt = params.get("prompt")
    source_media_id = params.get("source_media_id") or params.get("sourceMediaId")
    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if not isinstance(source_media_id, str) or not source_media_id.strip():
        return {}, "missing_source_media_id"
    aspect = params.get("aspect_ratio") or "IMAGE_ASPECT_RATIO_LANDSCAPE"
    # Tier resolution — see _handle_gen_image for rationale. Fail loud,
    # no silent fallback to Pro.
    tier = params.get("paygate_tier") or flow_client.paygate_tier
    if tier is None:
        return {}, "paygate_tier_unknown"
    raw_refs = params.get("ref_media_ids")
    ref_ids: Optional[list[str]] = None
    if isinstance(raw_refs, list):
        cleaned = [m for m in raw_refs if isinstance(m, str) and m]
        ref_ids = cleaned or None
    image_model = params.get("image_model")
    if not isinstance(image_model, str) or not image_model.strip():
        image_model = None

    prepared = await _new_image_project([source_media_id.strip(), *(ref_ids or [])])
    if prepared.get("error"):
        return prepared, str(prepared["error"])[:200]
    project_id = prepared["project_id"]

    # The source image is a reference too as far as Flow's lookup goes, so
    # it rides along in the recovery list (first slot) and is split back out.
    async def _dispatch(refs: list[str]) -> dict:
        return await get_flow_sdk().edit_image(
            prompt=prompt.strip(),
            project_id=project_id,
            source_media_id=refs[0],
            ref_media_ids=refs[1:] or None,
            aspect_ratio=aspect,
            paygate_tier=tier,
            image_model=image_model,
        )

    resp = await _with_ref_recovery(
        project_id, [source_media_id.strip(), *(ref_ids or [])], _dispatch,
        prepared["ref_media_ids"],
    )
    resp["project_id"] = project_id
    if resp.get("error"):
        return resp, str(resp["error"])[:200]
    entries_with_urls = [
        e for e in (resp.get("media_entries") or []) if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from edit_image response failed")
    return resp, None



# ── Omni Flash r2v ────────────────────────────────────────────────────────
# Variable-duration video model with a distinct endpoint + body shape from
# Veo i2v. See agent/flowboard/services/flow_sdk.py::gen_video_omni for the
# request assembly. Single operation per request (no multi-source batching
# like Veo's start_media_ids), so the polling logic collapses to a single
# op + first-error-wins, simpler than _handle_gen_video.

async def _handle_gen_video_omni(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services.flow_sdk import is_valid_project_id
    from flowboard.services.media_project_sync import (
        MediaSyncError,
        ensure_media_ids_in_project,
    )

    prompt = params.get("prompt")
    project_id = params.get("project_id")
    raw_refs = params.get("ref_media_ids")
    if not isinstance(raw_refs, list):
        # Also accept the legacy single-source field for symmetry with
        # Veo's start_media_id, so the same upstream-walk on the frontend
        # works without a special-case.
        raw_refs = (
            [params.get("start_media_id")]
            if isinstance(params.get("start_media_id"), str)
            else []
        )
    ref_media_ids = [m for m in raw_refs if isinstance(m, str) and m.strip()]
    duration_s = params.get("duration_s")

    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    if not ref_media_ids:
        return {}, "missing_ref_media_ids"
    if not isinstance(duration_s, int) or duration_s not in (4, 6, 8, 10):
        return {}, "invalid_duration_s"
    aspect = params.get("aspect_ratio") or "VIDEO_ASPECT_RATIO_PORTRAIT"
    tier = params.get("paygate_tier") or flow_client.paygate_tier
    if tier is None:
        return {}, "paygate_tier_unknown"

    project_id, perr = await _project_for_this_account(params, project_id)
    if perr:
        return {}, perr

    # ── Cross-project ref sync ────────────────────────────────────────
    # Flow scopes mediaIds to the project they were uploaded in. When
    # the user references media generated under another board's project
    # (the cross-board Reference library case), Flow returns 404 because
    # the asset is unknown in this project. Re-upload bytes from the
    # local cache and substitute the project-local id before dispatch.
    # First sync hits the Flow upload endpoint per ref; subsequent
    # syncs use the MediaProjectMapping cache and are free.
    try:
        synced_refs, sync_failures = await ensure_media_ids_in_project(
            ref_media_ids, project_id
        )
    except MediaSyncError as exc:
        return {}, f"sync_failed: {exc}"[:200]
    if not synced_refs:
        # Every ref failed to sync — surface the first reason.
        first = sync_failures[0][1] if sync_failures else "no_refs_synced"
        return (
            {"sync_failures": sync_failures},
            f"sync_failed: {first}"[:200],
        )
    if sync_failures:
        # Partial sync — log; proceed with the refs that worked.
        logger.warning(
            "gen_video_omni: %d ref(s) failed to sync, proceeding with %d",
            len(sync_failures), len(synced_refs),
        )

    sdk = get_flow_sdk()
    dispatch = await sdk.gen_video_omni(
        prompt=prompt.strip(),
        project_id=project_id,
        ref_media_ids=synced_refs,
        duration_s=duration_s,
        aspect_ratio=aspect,
        paygate_tier=tier,
    )
    if dispatch.get("error"):
        return dispatch, str(dispatch["error"])[:200]

    op_names = dispatch.get("operation_names") or []
    if not op_names:
        return dispatch, "no_operations_returned"
    workflows = dispatch.get("workflows") or None

    poll_attempts = 0
    last_poll: dict = {}
    done_by_name: dict[str, bool] = {name: False for name in op_names}
    entry_by_name: dict[str, dict] = {}
    op_errors: dict[str, str] = {}
    rid = params.get("__request_id")

    while (
        poll_attempts < VIDEO_POLL_MAX_CYCLES
        and not all(done_by_name.values())
    ):
        await asyncio.sleep(VIDEO_POLL_INTERVAL_S)
        poll_attempts += 1
        if _is_request_canceled(rid):
            return (
                {
                    "raw_dispatch": dispatch,
                    "last_poll": last_poll,
                    "operation_names": op_names,
                    "done": done_by_name,
                    "canceled": True,
                },
                "canceled",
            )
        last_poll = await sdk.check_async(op_names, workflows=workflows)
        if last_poll.get("error"):
            continue
        for op in last_poll.get("operations") or []:
            if not isinstance(op, dict):
                continue
            name = op.get("name")
            if not isinstance(name, str) or done_by_name.get(name, False):
                continue
            err = op.get("error")
            if isinstance(err, str) and err:
                done_by_name[name] = True
                op_errors[name] = err
                continue
            if op.get("done"):
                done_by_name[name] = True
                for e in op.get("media_entries") or []:
                    if isinstance(e, dict) and e.get("media_id"):
                        entry_by_name[name] = e
                        break

    for name in op_names:
        if not done_by_name.get(name) and name not in op_errors:
            op_errors[name] = "timeout_waiting_video"

    positional_ids: list[Optional[str]] = []
    slot_errors: list[Optional[str]] = []
    succeeded_entries: list[dict] = []
    for name in op_names:
        e = entry_by_name.get(name)
        if isinstance(e, dict) and isinstance(e.get("media_id"), str):
            positional_ids.append(e["media_id"])
            succeeded_entries.append(e)
            slot_errors.append(None)
        else:
            positional_ids.append(None)
            slot_errors.append(op_errors.get(name))

    if not any(positional_ids):
        first_err = next(iter(op_errors.values()), "timeout_waiting_video")
        return (
            {
                "raw_dispatch": dispatch,
                "last_poll": last_poll,
                "operation_names": op_names,
                "done": done_by_name,
                "op_errors": op_errors,
            },
            first_err,
        )

    entries_with_urls = [
        e for e in succeeded_entries if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from gen_video_omni response failed")
    # Omni Flash uses workflow-mode polling: Flow delivers the rendered MP4
    # inline as base64 on `/v1/media/<id>` with no signed GCS URL. Plant the
    # bytes in the local cache so `/media/<id>` can serve them.
    for entry in succeeded_entries:
        if not isinstance(entry, dict):
            continue
        encoded = entry.get("encoded_video")
        mid = entry.get("media_id")
        if not isinstance(encoded, str) or not isinstance(mid, str):
            continue
        try:
            import base64 as _b64
            media_service.ingest_inline_bytes(
                mid, _b64.b64decode(encoded, validate=False),
                kind="video", mime="video/mp4",
            )
        except Exception:  # noqa: BLE001
            logger.exception("inline ingest from omni workflow poll failed for %s", mid)

    return (
        {
            "raw_dispatch": dispatch,
            "last_poll": last_poll,
            "operation_names": op_names,
            "media_ids": positional_ids,
            "media_entries": succeeded_entries,
            "op_errors": op_errors,
            "slot_errors": slot_errors,
            "duration_s": duration_s,
        },
        None,
    )


_DEFAULT_HANDLERS: dict[str, Handler] = {
    "proxy": _handle_proxy,
    "create_project": _handle_create_project,
    "gen_image": _handle_gen_image,
    "gen_video": _handle_gen_video,
    "gen_video_omni": _handle_gen_video_omni,
    "edit_image": _handle_edit_image,
}


def _request_user(rid: int) -> Optional[int]:
    try:
        with get_session() as s:
            req = s.get(Request, rid)
            uid = (req.params or {}).get("_user_id") if req else None
            return uid if isinstance(uid, int) else None
    except Exception:  # noqa: BLE001
        return None


class WorkerController:
    """Single-consumer async queue worker."""

    def __init__(self, handlers: Optional[dict[str, Handler]] = None) -> None:
        self._queue: asyncio.Queue[int] = asyncio.Queue()
        self._handlers = dict(handlers or _DEFAULT_HANDLERS)
        self._shutdown = asyncio.Event()
        self._active = 0
        self._started_at: Optional[float] = None
        # Server mode: jobs of different Flowboard users run side by side
        # (each on their own Google accounts / Chrome); one at a time per user.
        self._user_locks: dict[int, asyncio.Lock] = {}
        self._tasks: set[asyncio.Task] = set()

    # ── enqueue ────────────────────────────────────────────────────────────
    def enqueue(self, request_id: int) -> None:
        self._queue.put_nowait(request_id)

    # ── lifecycle ──────────────────────────────────────────────────────────
    async def start(self) -> None:
        self._started_at = time.time()
        logger.info("worker started")
        while not self._shutdown.is_set():
            try:
                rid = await asyncio.wait_for(self._queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            uid = _request_user(rid)
            if uid is None:
                await self._process_one(rid)
                continue
            lock = self._user_locks.setdefault(uid, asyncio.Lock())
            task = asyncio.create_task(self._run_for_user(lock, rid))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _run_for_user(self, lock: asyncio.Lock, rid: int) -> None:
        async with lock:
            await self._process_one(rid)

    def request_shutdown(self) -> None:
        self._shutdown.set()

    async def drain(self) -> None:
        # Wait for any in-flight task to finish.
        while self._active > 0:
            await asyncio.sleep(0.05)

    @property
    def active_count(self) -> int:
        return self._active

    @property
    def uptime_s(self) -> Optional[float]:
        if self._started_at is None:
            return None
        return time.time() - self._started_at

    # ── execution ──────────────────────────────────────────────────────────
    async def _process_one(self, rid: int) -> None:
        self._active += 1
        try:
            with get_session() as s:
                req = s.get(Request, rid)
                if req is None:
                    logger.warning("worker: request %s not found", rid)
                    return
                # Drift guard — the row might have been canceled (or
                # otherwise transitioned out of queued) between enqueue
                # and pop. The cancel endpoint mutates the DB row only;
                # it can't yank the rid back off the in-memory queue, so
                # we re-check here and bail without flipping status.
                if req.status != "queued":
                    logger.info(
                        "worker: skipping rid=%s (status=%s)", rid, req.status
                    )
                    return
                handler = self._handlers.get(req.type)
                if handler is None:
                    req.status = "failed"
                    req.error = f"unknown_request_type:{req.type}"
                    req.finished_at = datetime.now(timezone.utc)
                    s.add(req)
                    s.commit()
                    return

                req.status = "running"
                s.add(req)
                s.commit()
                req_type = req.type
                params = dict(req.params or {})
                # Enrich with the request's node_id so handlers that need
                # to look up Node.data don't depend on the caller copying
                # it into params explicitly. Underscore prefix avoids
                # colliding with handler-defined fields.
                if req.node_id is not None and "__node_id" not in params:
                    params["__node_id"] = req.node_id
                # Long-running handlers re-check this rid between polls
                # to honor user-initiated cancels.
                params["__request_id"] = rid

            # Release the session during the possibly-long RPC.
            from flowboard.services.users import current_user_id

            utoken = current_user_id.set(params.get("_user_id"))
            try:
                result, err = await _run_on_accounts(handler, req_type, params)
            finally:
                current_user_id.reset(utoken)

            with get_session() as s:
                req = s.get(Request, rid)
                if req is None:
                    return
                # Don't overwrite a canceled row with a late-arriving
                # done/failed stamp. The cancel endpoint already set
                # status='canceled' and finished_at; we only persist the
                # partial result for debugging visibility.
                if req.status == "canceled":
                    if isinstance(result, dict):
                        req.result = result
                        s.add(req)
                        s.commit()
                    return
                req.result = result if isinstance(result, dict) else {"value": result}
                req.finished_at = datetime.now(timezone.utc)
                if err:
                    # Video-poll exhaustion gets its own status so the UI
                    # can render "TIMEOUT" instead of a generic failure.
                    req.status = "timeout" if err == "timeout_waiting_video" else "failed"
                    req.error = err
                else:
                    req.status = "done"
                    req.error = None
                s.add(req)
                s.commit()
        except Exception as exc:  # noqa: BLE001
            logger.exception("worker exception on rid=%s", rid)
            try:
                with get_session() as s:
                    req = s.get(Request, rid)
                    if req is not None and req.status != "canceled":
                        req.status = "failed"
                        req.error = str(exc)[:500]
                        req.finished_at = datetime.now(timezone.utc)
                        s.add(req)
                        s.commit()
            except Exception:  # noqa: BLE001
                logger.exception("worker: failed to record failure for rid=%s", rid)
        finally:
            try:
                finalize_node_for_request(rid)
            except Exception:  # noqa: BLE001
                logger.exception("worker: node finalize failed for rid=%s", rid)
            self._active -= 1


# ── Several Google Flow accounts ──────────────────────────────────────────
# A job runs start to finish on one account (project, uploads, generation and
# polling all have to happen under the same Google login). Image jobs that
# fail because the account is out of today's quota — the extension only says
# so after trying every image model on it — are re-run on the next account.
_ROTATING_TYPES = {"gen_image", "edit_image"}


async def _run_on_accounts(handler: Handler, req_type: str, params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services import account_projects
    from flowboard.services.account_pool import is_quota_error
    from flowboard.services.flow_client import account_pool

    client = account_pool.current()
    tried: list[str] = []
    switched: list[dict] = []
    while True:
        key = account_pool.key_of(client) if client.connected else None
        with account_pool.pin(client):
            result, err = await handler(dict(params))
        if (
            err
            and key
            and req_type in _ROTATING_TYPES
            and is_quota_error(err)
        ):
            account_pool.mark_exhausted(client, err)
            tried.append(key)
            nxt = account_pool.next_account(set(tried))
            if nxt is not None:
                nkey = account_pool.key_of(nxt)
                logger.info("account %s out of quota — retrying on %s", key, nkey)
                switched.append({"from": key, "to": nkey, "reason": str(err)[:160]})
                account_pool.record_switch(key, nkey, str(err))
                client = nxt
                continue
            if len(tried) > 1 or account_pool.connected_clients()[1:]:
                err = f"ALL_ACCOUNTS_QUOTA: tất cả tài khoản Flow đã hết lượt hôm nay ({', '.join(tried)}) — {err}"
        break
    if isinstance(result, dict):
        result = dict(result)
        if key:
            result["flow_account"] = key
        if switched:
            result["account_switches"] = switched
        if not err and key:
            ids = list(result.get("media_ids") or [])
            try:
                account_projects.record_media(ids, key)
            except Exception:  # noqa: BLE001
                logger.exception("record_media failed")
    return result, err


# ── Node finalize for headless dispatches (MCP / API) ─────────────────────
# The browser UI patches the node itself while it polls a request it
# dispatched. Requests created by the MCP server carry
# ``params._finalize_node = true`` so the worker writes the result onto
# the node instead (same fields the UI writes), then bumps live-sync so an
# open UI reloads and shows the new images.
_TERMINAL = {"done", "failed", "timeout", "canceled"}


def finalize_node_for_request(rid: int) -> bool:
    from flowboard.db.models import Node
    from flowboard.services import sync as sync_state

    with get_session() as s:
        req = s.get(Request, rid)
        if req is None or req.node_id is None:
            return False
        params = dict(req.params or {})
        if not params.get("_finalize_node") or req.status not in _TERMINAL:
            return False
        result = dict(req.result or {})
        if result.get("_node_finalized"):
            return False
        node = s.get(Node, req.node_id)
        if node is None:
            return False
        data = dict(node.data or {})
        now = datetime.now(timezone.utc).isoformat()
        if req.status == "done":
            media_ids = [m if isinstance(m, str) and m else None
                         for m in (result.get("media_ids") or [])]
            media_id = next((m for m in media_ids if m), None)
            if media_id is None:
                node.status = "error"
                data["error"] = "no_media_returned"
            else:
                node.status = "done"
                data.update({
                    "prompt": params.get("prompt") or data.get("prompt"),
                    "mediaId": media_id,
                    "mediaIds": media_ids,
                    "variantCount": len(media_ids) or 1,
                    "renderedAt": now,
                })
                aspect = params.get("aspect_ratio")
                if isinstance(aspect, str) and aspect:
                    data["aspectRatio"] = aspect
                slot_errors = result.get("slot_errors")
                if isinstance(slot_errors, list):
                    data["slotErrors"] = slot_errors
                else:
                    data.pop("slotErrors", None)
                partial = result.get("partial_error")
                if partial:
                    data["error"] = partial
                else:
                    data.pop("error", None)
                data.pop("aiBrief", None)
                if result.get("flow_account"):
                    data["flowAccount"] = result["flow_account"]
                if req.type in ("gen_image", "edit_image") and params.get("image_model"):
                    data["imageModel"] = params["image_model"]
                if req.type == "gen_video" and params.get("video_quality"):
                    data["videoQuality"] = params["video_quality"]
                if req.type == "gen_video_omni" and params.get("duration_s") in (4, 6, 8, 10):
                    data["videoQuality"] = f"abra_r2v_{params['duration_s']}s"
        elif req.status == "canceled":
            node.status = "idle"
        else:
            node.status = "error"
            data["error"] = (
                f"Timed out ({req.error or 'video_timeout'})"
                if req.status == "timeout" else (req.error or "failed")
            )
        node.data = data
        result["_node_finalized"] = True
        req.result = result
        s.add(node)
        s.add(req)
        s.commit()
        board_id = node.board_id
    sync_state.bump(board_id)
    return True


_worker: Optional[WorkerController] = None


def get_worker() -> WorkerController:
    global _worker
    if _worker is None:
        _worker = WorkerController()
    return _worker
