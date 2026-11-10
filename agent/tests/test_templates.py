"""Shared template library: publish, use (independent copies), permissions."""
import pytest

from flowboard.services import users as svc


@pytest.fixture(autouse=True)
def _reset_auth():
    svc._invalidate_cache()
    yield
    svc._invalidate_cache()


def _flow(client):
    b = client.post("/api/boards", json={"name": "Halloween"}).json()
    ref = client.post("/api/nodes", json={"board_id": b["id"], "type": "visual_asset",
                                         "data": {"title": "Ref", "mediaId": "m-ref"}, "status": "done"}).json()
    img = client.post("/api/nodes", json={"board_id": b["id"], "type": "image",
                                         "data": {"title": "Out", "prompt": "pumpkin nails on image 1",
                                                  "imageInputs": [str(ref["id"]), ""], "mediaId": "m-out",
                                                  "error": "old"}}).json()
    client.post("/api/edges", json={"board_id": b["id"], "source_id": ref["id"], "target_id": img["id"]})
    return b, ref, img


def test_publish_and_use_creates_independent_copy(client):
    b, ref, img = _flow(client)
    t = client.post("/api/templates", json={"board_id": b["id"], "description": "Mẫu Halloween"}).json()
    assert t["name"] == "Halloween" and t["node_count"] == 2 and t["cover_media_id"] == "m-ref"
    assert client.get(f"/api/templates/by-board/{b['id']}").json()["template"]["id"] == t["id"]

    # Author keeps editing their own flow: the template is frozen.
    client.patch(f"/api/nodes/{img['id']}", json={"data": {"prompt": "changed"}})
    snap = client.get(f"/api/templates/{t['id']}").json()["snapshot"]
    assert any(n["data"].get("prompt") == "pumpkin nails on image 1" for n in snap["nodes"])
    assert all("error" not in n["data"] for n in snap["nodes"])

    used = client.post(f"/api/templates/{t['id']}/use", json={}).json()
    nb = client.get(f"/api/boards/{used['board']['id']}").json()
    assert used["board"]["name"] == "Halloween" and len(nb["nodes"]) == 2 and len(nb["edges"]) == 1
    new_ref = next(n for n in nb["nodes"] if n["type"] == "visual_asset")
    new_img = next(n for n in nb["nodes"] if n["type"] == "image")
    assert new_img["data"]["imageInputs"] == [str(new_ref["id"]), ""]
    assert new_img["data"]["prompt"] == "pumpkin nails on image 1"
    assert nb["edges"][0]["source_id"] == new_ref["id"] and nb["edges"][0]["target_id"] == new_img["id"]
    # Editing the copy changes neither the template nor the author's flow.
    client.patch(f"/api/nodes/{new_img['id']}", json={"data": {"prompt": "mine"}})
    assert client.get(f"/api/nodes/{img['id']}").json()["data"]["prompt"] == "changed"
    snap2 = client.get(f"/api/templates/{t['id']}").json()["snapshot"]
    assert snap2 == snap
    assert client.get("/api/templates").json()[0]["use_count"] == 1

    # Refresh from the source flow.
    upd = client.patch(f"/api/templates/{t['id']}", json={"refresh_from_board": True, "name": "Halloween v2"}).json()
    assert upd["name"] == "Halloween v2"
    snap3 = client.get(f"/api/templates/{t['id']}").json()["snapshot"]
    assert any(n["data"].get("prompt") == "changed" for n in snap3["nodes"])


def test_template_permissions_and_private_flows(client):
    svc.create_user("boss", "secret123", role="admin")
    lan = svc.create_user("lan", "secret123")
    svc.create_user("minh", "secret123")
    svc._invalidate_cache()

    def login(u):
        client.post("/api/session/logout")
        assert client.post("/api/session/login", json={"username": u, "password": "secret123"}).status_code == 200

    login("lan")
    b, _, _ = _flow(client)
    t = client.post("/api/templates", json={"board_id": b["id"]}).json()
    assert t["can_edit"] is True

    login("minh")
    assert client.get(f"/api/boards/{b['id']}").status_code == 403
    assert [x["id"] for x in client.get("/api/boards").json()] == []
    lst = client.get("/api/templates").json()
    assert lst[0]["author"] == "lan" and lst[0]["can_edit"] is False
    assert client.patch(f"/api/templates/{t['id']}", json={"name": "x"}).status_code == 403
    assert client.delete(f"/api/templates/{t['id']}").status_code == 403
    used = client.post(f"/api/templates/{t['id']}/use", json={}).json()["board"]
    assert used["owner_user_id"] != lan.id
    assert [x["id"] for x in client.get("/api/boards").json()] == [used["id"]]

    login("boss")
    assert client.get(f"/api/boards/{b['id']}").status_code == 200
    assert len(client.get("/api/boards", params={"all": "true"}).json()) == 2
    assert client.delete(f"/api/templates/{t['id']}").json()["ok"]
