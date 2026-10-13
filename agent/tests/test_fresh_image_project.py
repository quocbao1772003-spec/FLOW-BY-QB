from unittest.mock import AsyncMock, Mock, patch
import asyncio

import pytest

from flowboard.worker import processor as proc

P1 = "11111111-1111-4111-8111-111111111111"
P2 = "22222222-2222-4222-8222-222222222222"


@pytest.mark.asyncio
async def test_recovery_keeps_original_bytes_after_session_upload():
    for edit in (False, True):
        proc.reset_image_project_session()
        generate = AsyncMock(side_effect=[{"error": "BOQ_RPC_5_NOT_FOUND"}, {"media_entries": []}])
        sdk = Mock(create_project=AsyncMock(return_value={"project_id": P1}),
                   gen_image=generate, edit_image=generate)
        upload = AsyncMock(return_value=(["fresh-a", "fresh-b"], []))
        with patch.object(proc, "get_flow_sdk", return_value=sdk), patch(
            "flowboard.services.media_project_sync.ensure_media_ids_in_project",
            AsyncMock(return_value=(["session-a", "session-b"], []))
        ), patch("flowboard.services.media_project_sync.force_reupload", upload):
            params = {"prompt": "x", "ref_media_ids": ["a", "b"]}
            if edit:
                params.update(source_media_id="a", ref_media_ids=["b"])
            handler = proc._handle_edit_image if edit else proc._handle_gen_image
            _, err = await handler(params)
        assert err is None
        upload.assert_awaited_once_with(["a", "b"], P1)
        calls = generate.call_args_list
        if edit:
            assert calls[0].kwargs["source_media_id"] == "session-a"
            assert calls[1].kwargs["source_media_id"] == "fresh-a"
            assert calls[1].kwargs["ref_media_ids"] == ["fresh-b"]
        else:
            assert calls[0].kwargs["ref_media_ids"] == ["session-a", "session-b"]
            assert calls[1].kwargs["ref_media_ids"] == ["fresh-a", "fresh-b"]


@pytest.fixture(autouse=True)
def reset_session():
    proc.reset_image_project_session()
    yield
    proc.reset_image_project_session()


@pytest.mark.asyncio
async def test_generations_share_project_until_new_session():
    sdk = Mock()
    sdk.create_project = AsyncMock(side_effect=[{"project_id": P1}, {"project_id": P2}])
    sdk.gen_image = AsyncMock(side_effect=[{"media_entries": []}, {"media_entries": []}])
    sync = AsyncMock(side_effect=[(["a1", "b1"], []), (["a2", "b2"], [])])
    params = {"prompt": "nails", "project_id": "obsolete", "ref_media_ids": ["a", "b"], "variant_count": 4}
    with patch.object(proc, "get_flow_sdk", return_value=sdk), patch(
        "flowboard.services.media_project_sync.ensure_media_ids_in_project", sync
    ):
        first, err = await proc._handle_gen_image(params)
        assert err is None
        second, err = await proc._handle_gen_image(params)
        assert err is None
        assert sdk.create_project.await_count == 1
        proc.reset_image_project_session()
        sdk.gen_image.return_value = {"media_entries": []}
        sdk.gen_image.side_effect = None
        sync.return_value = (["a3", "b3"], [])
        sync.side_effect = None
        third, err = await proc._handle_gen_image(params)
        assert err is None
    assert first["project_id"] == P1
    assert second["project_id"] == P1
    assert third["project_id"] == P2
    assert sdk.create_project.await_count == 2
    assert sync.call_args_list[0].args == (["a", "b"], P1)
    assert sdk.gen_image.call_args_list[0].kwargs["ref_media_ids"] == ["a1", "b1"]
    assert sdk.gen_image.call_args_list[1].kwargs["project_id"] == P1
    assert sdk.gen_image.call_args.kwargs["variant_count"] == 4


@pytest.mark.asyncio
async def test_creation_failure_never_generates():
    sdk = Mock(create_project=AsyncMock(return_value={"error": "offline"}), gen_image=AsyncMock())
    with patch.object(proc, "get_flow_sdk", return_value=sdk):
        _, err = await proc._handle_gen_image({"prompt": "x"})
    assert "NEW_IMAGE_PROJECT_FAILED" in err
    sdk.gen_image.assert_not_called()


@pytest.mark.asyncio
async def test_partial_reference_upload_never_generates():
    sdk = Mock(create_project=AsyncMock(return_value={"project_id": P1}), gen_image=AsyncMock())
    with patch.object(proc, "get_flow_sdk", return_value=sdk), patch(
        "flowboard.services.media_project_sync.ensure_media_ids_in_project",
        AsyncMock(return_value=(["a1"], [("b", "missing bytes")]))
    ):
        _, err = await proc._handle_gen_image({"prompt": "x", "ref_media_ids": ["a", "b"]})
    assert "REF_SYNC_FAILED" in err
    sdk.gen_image.assert_not_called()


@pytest.mark.asyncio
async def test_edit_copies_source_and_references_in_order():
    sdk = Mock(create_project=AsyncMock(return_value={"project_id": P1}),
               edit_image=AsyncMock(return_value={"media_entries": []}))
    sync = AsyncMock(return_value=(["source-new", "ref-new"], []))
    with patch.object(proc, "get_flow_sdk", return_value=sdk), patch(
        "flowboard.services.media_project_sync.ensure_media_ids_in_project", sync
    ):
        result, err = await proc._handle_edit_image({"prompt": "x", "source_media_id": "source", "ref_media_ids": ["ref"]})
    assert err is None
    assert result["project_id"] == P1
    assert sync.call_args.args == (["source", "ref"], P1)
    assert sdk.edit_image.call_args.kwargs["source_media_id"] == "source-new"
    assert sdk.edit_image.call_args.kwargs["ref_media_ids"] == ["ref-new"]


@pytest.mark.asyncio
async def test_parallel_requests_only_create_one_project():
    sdk = Mock(create_project=AsyncMock(return_value={"project_id": P1}))
    with patch.object(proc, "get_flow_sdk", return_value=sdk), patch(
        "flowboard.services.media_project_sync.ensure_media_ids_in_project",
        AsyncMock(return_value=([], []))
    ):
        results = await asyncio.gather(proc._new_image_project([]), proc._new_image_project([]))
    assert all(result["project_id"] == P1 for result in results)
    sdk.create_project.assert_awaited_once()
