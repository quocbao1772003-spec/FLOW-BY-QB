"""Stale reference recovery for gen_image / edit_image.

Flow answers a generate whose reference image it can no longer see with boq
status 5 (NOT_FOUND). The worker must re-upload the refs from the local cache
and retry once, then reuse the new ids on later dispatches.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flowboard.worker import processor as proc

PROJECT = "3c22ead1-64ef-4ccc-9235-877373699ad2"
REF_A = "d40db8ec-fb39-4ab0-872f-2ec94b4b3991"
REF_B = "d6602a2d-a11b-4990-9553-b6199ad75eac"

# Verbatim from a real failure (older extension, raw head in the message).
RAW_NOT_FOUND = (
    "BOQ_NO_MEDIA_URL — )]}' 107 [[\"wrb.fr\",\"ogiZ0b\",null,null,null,[5],"
    "\"generic\"],[\"di\",361],[\"af.httprm\",360,\"-7059412366316328132\",40]] 25 "
    "[[\"e\",4,null,null,143]]"
)
OK = {"media_ids": ["new"], "media_entries": []}


def test_detects_both_error_shapes():
    assert proc._is_ref_not_found(RAW_NOT_FOUND)
    assert proc._is_ref_not_found("BOQ_RPC_5_NOT_FOUND — whatever")
    assert not proc._is_ref_not_found("BOQ_NO_MEDIA_URL — [[\"wrb.fr\",\"ogiZ0b\",null,null,null,[3],\"generic\"]]")
    assert not proc._is_ref_not_found("BOQ_CAPTCHA_FAILED")
    assert not proc._is_ref_not_found(None)


@pytest.mark.asyncio
async def test_gen_image_reuploads_refs_and_retries_on_not_found():
    with patch("flowboard.worker.processor.get_flow_sdk") as gen_sdk, \
         patch("flowboard.services.media_project_sync.get_flow_sdk") as up_sdk, \
         patch("flowboard.services.media_project_sync._load_bytes",
               AsyncMock(return_value=(b"img", "image/webp"))):
        gen_sdk.return_value.gen_image = AsyncMock(side_effect=[{"error": RAW_NOT_FOUND}, OK])
        up_sdk.return_value.upload_image = AsyncMock(side_effect=[
            {"media_id": "fresh-a"}, {"media_id": "fresh-b"},
        ])
        resp, err = await proc._handle_gen_image({
            "prompt": "x", "project_id": PROJECT, "ref_media_ids": [REF_A, REF_B],
        })
        assert err is None
        calls = gen_sdk.return_value.gen_image.call_args_list
        assert calls[0].kwargs["ref_media_ids"] == [REF_A, REF_B]
        assert calls[1].kwargs["ref_media_ids"] == ["fresh-a", "fresh-b"]

        # Next dispatch goes straight to the re-uploaded copies.
        gen_sdk.return_value.gen_image = AsyncMock(return_value=OK)
        await proc._handle_gen_image({
            "prompt": "x", "project_id": PROJECT, "ref_media_ids": [REF_A, REF_B],
        })
        assert gen_sdk.return_value.gen_image.call_args.kwargs["ref_media_ids"] == ["fresh-a", "fresh-b"]


@pytest.mark.asyncio
async def test_gen_image_reports_when_reupload_impossible():
    with patch("flowboard.worker.processor.get_flow_sdk") as gen_sdk, \
         patch("flowboard.services.media_project_sync._load_bytes",
               AsyncMock(return_value=(None, "image/png"))):
        gen_sdk.return_value.gen_image = AsyncMock(return_value={"error": RAW_NOT_FOUND})
        _, err = await proc._handle_gen_image({
            "prompt": "x", "project_id": PROJECT, "ref_media_ids": [REF_A],
        })
        assert err.startswith("REF_NOT_FOUND_REUPLOAD_FAILED")
        assert gen_sdk.return_value.gen_image.await_count == 1


@pytest.mark.asyncio
async def test_other_errors_do_not_trigger_reupload():
    with patch("flowboard.worker.processor.get_flow_sdk") as gen_sdk, \
         patch("flowboard.services.media_project_sync.get_flow_sdk") as up_sdk:
        gen_sdk.return_value.gen_image = AsyncMock(return_value={"error": "BOQ_CAPTCHA_FAILED"})
        up_sdk.return_value.upload_image = AsyncMock()
        _, err = await proc._handle_gen_image({
            "prompt": "x", "project_id": PROJECT, "ref_media_ids": [REF_A],
        })
        assert err == "BOQ_CAPTCHA_FAILED"
        up_sdk.return_value.upload_image.assert_not_awaited()


@pytest.mark.asyncio
async def test_edit_image_reuploads_source_and_refs():
    with patch("flowboard.worker.processor.get_flow_sdk") as gen_sdk, \
         patch("flowboard.services.media_project_sync.get_flow_sdk") as up_sdk, \
         patch("flowboard.services.media_project_sync._load_bytes",
               AsyncMock(return_value=(b"img", "image/png"))):
        gen_sdk.return_value.edit_image = AsyncMock(side_effect=[
            {"error": "BOQ_RPC_5_NOT_FOUND"}, OK,
        ])
        up_sdk.return_value.upload_image = AsyncMock(side_effect=[
            {"media_id": "src2"}, {"media_id": "ref2"},
        ])
        _, err = await proc._handle_edit_image({
            "prompt": "x", "project_id": PROJECT,
            "source_media_id": REF_A, "ref_media_ids": [REF_B],
        })
        assert err is None
        kw = gen_sdk.return_value.edit_image.call_args.kwargs
        assert kw["source_media_id"] == "src2"
        assert kw["ref_media_ids"] == ["ref2"]
