"""MCP integration: live-sync, worker node finalize, MCP helpers, HTTP gate."""
import asyncio

import pytest

from flowboard.db import get_session
from flowboard.db.models import Request
from flowboard.services import sync as sync_state
from flowboard.worker.processor import finalize_node_for_request

MCP = {"X-Flowboard-Source": "mcp"}


def _board_and_node(client, ntype="image"):
    b = client.post("/api/boards", json={"name": "b"}).json()
    n = client.post("/api/nodes", json={"board_id": b["id"], "type": ntype, "data": {"title": "T"}}).json()
    return b, n


def test_mcp_tagged_change_bumps_sync_rev(client):
    _, n = _board_and_node(client)
    rev0 = client.get("/api/sync").json()["rev"]
    client.patch(f"/api/nodes/{n['id']}", json={"data": {"prompt": "ui edit"}})
    assert client.get("/api/sync").json()["rev"] == rev0
    client.patch(f"/api/nodes/{n['id']}", json={"data": {"prompt": "mcp edit"}}, headers=MCP)
    assert client.get("/api/sync").json()["rev"] == rev0 + 1
    # failed calls don't bump
    client.patch("/api/nodes/99999", json={"data": {}}, headers=MCP)
    assert client.get("/api/sync").json()["rev"] == rev0 + 1


def test_focus_board(client):
    b, _ = _board_and_node(client)
    snap = client.post("/api/sync/focus", json={"board_id": b["id"]}).json()
    assert snap["focus_board_id"] == b["id"]
    assert client.post("/api/sync/focus", json={"board_id": 4242}).status_code == 404


def test_get_node_route(client):
    _, n = _board_and_node(client)
    got = client.get(f"/api/nodes/{n['id']}").json()
    assert got["id"] == n["id"] and got["data"]["title"] == "T"
    assert client.get("/api/nodes/4242").status_code == 404


def _req(node_id, status, result=None, params=None, rtype="gen_image", error=None):
    with get_session() as s:
        r = Request(node_id=node_id, type=rtype, status=status, result=result or {},
                    params={"_finalize_node": True, "prompt": "p", "aspect_ratio": "IMAGE_ASPECT_RATIO_SQUARE",
                            "image_model": "NANO_BANANA_PRO", **(params or {})}, error=error)
        s.add(r)
        s.commit()
        s.refresh(r)
        return r.id


def test_finalize_done_writes_media_onto_node(client):
    _, n = _board_and_node(client)
    rid = _req(n["id"], "done", {"media_ids": ["aaa-1", None, "ccc-3"], "slot_errors": [None, "BLOCKED", None]})
    rev0 = sync_state.snapshot()["rev"]
    assert finalize_node_for_request(rid) is True
    node = client.get(f"/api/nodes/{n['id']}").json()
    assert node["status"] == "done"
    d = node["data"]
    assert d["mediaId"] == "aaa-1" and d["mediaIds"] == ["aaa-1", None, "ccc-3"]
    assert d["prompt"] == "p" and d["imageModel"] == "NANO_BANANA_PRO"
    assert d["aspectRatio"] == "IMAGE_ASPECT_RATIO_SQUARE" and d["slotErrors"][1] == "BLOCKED"
    assert d["title"] == "T"
    assert sync_state.snapshot()["rev"] == rev0 + 1
    # idempotent
    assert finalize_node_for_request(rid) is False


def test_finalize_failed_and_unflagged(client):
    _, n = _board_and_node(client)
    rid = _req(n["id"], "failed", error="PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED")
    assert finalize_node_for_request(rid)
    node = client.get(f"/api/nodes/{n['id']}").json()
    assert node["status"] == "error" and "QUOTA" in node["data"]["error"]

    # UI-dispatched requests (no flag) are left to the browser.
    with get_session() as s:
        r = Request(node_id=n["id"], type="gen_image", status="done", params={}, result={"media_ids": ["x"]})
        s.add(r)
        s.commit()
        s.refresh(r)
        rid2 = r.id
    assert finalize_node_for_request(rid2) is False


# ── MCP-side helpers ─────────────────────────────────────────────────────

mcp_server = pytest.importorskip("flowboard_mcp.server")


def test_aspect_and_model_mapping():
    assert mcp_server._image_aspect("9:16") == "IMAGE_ASPECT_RATIO_PORTRAIT"
    assert mcp_server._image_aspect("4:3") == "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE"
    assert mcp_server._video_aspect("1:1") == "VIDEO_ASPECT_RATIO_PORTRAIT"
    assert mcp_server._image_model("pro") == "NANO_BANANA_PRO"
    assert mcp_server._image_model("Nano Banana 2.1") == "NANO_BANANA_2_1"
    with pytest.raises(Exception):
        mcp_server._image_aspect("2:1")


def test_upstream_refs_follow_slot_order_and_pins():
    board = {
        "nodes": [
            {"id": 1, "type": "visual_asset", "data": {"mediaId": "m1"}},
            {"id": 2, "type": "image", "data": {"mediaIds": ["v0", "v1"], "mediaId": "v0"}},
            {"id": 3, "type": "note", "data": {"prompt": "x"}},
            {"id": 4, "type": "image", "data": {"imageInputs": ["2", "", "1"]}},
        ],
        "edges": [
            {"source_id": 1, "target_id": 4, "source_variant_idx": None},
            {"source_id": 2, "target_id": 4, "source_variant_idx": 1},
            {"source_id": 3, "target_id": 4, "source_variant_idx": None},
        ],
    }
    target = board["nodes"][3]
    assert mcp_server._upstream_refs(board, target) == ["v1", "m1"]
    target["data"]["imageInputs"] = []
    assert mcp_server._upstream_refs(board, target) == ["m1", "v1"]


def test_free_spot_avoids_overlap():
    nodes = [{"id": 1, "type": "image", "x": 0, "y": 0, "w": 240, "h": 160},
             {"id": 2, "type": "note", "x": 360, "y": 0, "w": 240, "h": 160}]
    x, y = mcp_server._free_spot(nodes, near=nodes[0])
    assert x == 360 and y >= 340


def test_secret_gate():
    from flowboard_mcp.__main__ import SecretGate

    seen = {}

    async def app(scope, receive, send):
        seen["path"] = scope["path"]
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    gate = SecretGate(app, "s3cr3t-token-xyz")

    async def hit(path, headers=()):
        out = {}

        async def send(msg):
            if msg["type"] == "http.response.start":
                out["status"] = msg["status"]

        seen.clear()
        await gate({"type": "http", "path": path, "raw_path": path.encode(), "headers": list(headers)},
                   None, send)
        return out["status"], seen.get("path")

    assert asyncio.run(hit("/s3cr3t-token-xyz/mcp")) == (200, "/mcp")
    assert asyncio.run(hit("/mcp")) == (404, None)
    assert asyncio.run(hit("/wrong-token-xyz1/mcp")) == (404, None)
    assert asyncio.run(hit("/mcp", [(b"authorization", b"Bearer s3cr3t-token-xyz")])) == (200, "/mcp")
