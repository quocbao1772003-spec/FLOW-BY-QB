"""Several Google Flow accounts: selection, quota rotation, per-account projects."""
import asyncio
import time

import pytest

from flowboard.services import account_projects
from flowboard.services.account_pool import RECHECK_AFTER_S, is_quota_error
from flowboard.services.flow_client import account_pool, flow_client
from flowboard.worker import processor


class _WS:
    async def send(self, raw):
        pass


def _connect(email, inst):
    ws = _WS()
    client = account_pool.attach(ws, inst, "0.1.15")
    client._user_info = {"email": email}
    account_pool.note_identity(client)
    return client, ws


@pytest.fixture(autouse=True)
def _pool(tmp_path):
    account_pool._state_path = tmp_path / "accounts.json"
    account_pool._reset_for_tests()
    yield
    account_pool._reset_for_tests()
    account_pool._state_path = None


def test_quota_error_detection():
    assert is_quota_error("BOQ_QUOTA_DAILY — hết lượt")
    assert is_quota_error("PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED")
    assert not is_quota_error("BOQ_CAPTCHA_FAILED")


def test_selection_order_selected_and_exhausted():
    a, _ = _connect("a@x.test", "inst-AAAAAAAAAAAAAAAA")
    b, _ = _connect("B@x.test", "inst-BBBBBBBBBBBBBBBB")
    assert account_pool.primary == "a@x.test"
    assert account_pool.current() is a           # first in saved order
    account_pool.select("b@x.test")
    assert account_pool.current() is b
    assert flow_client.user_info["email"] == "B@x.test"   # proxy follows the pool
    account_pool.mark_exhausted(b, "QUOTA")
    assert account_pool.current() is a           # selected one is spent → next
    account_pool.set_auto_rotate(False)
    assert account_pool.current() is b           # manual mode sticks to the choice
    account_pool.set_auto_rotate(True)
    account_pool.clear_exhausted("b@x.test")
    assert account_pool.current() is b
    snap = account_pool.snapshot()
    assert [r["key"] for r in snap["accounts"]] == ["a@x.test", "b@x.test"]
    assert snap["active"] == "b@x.test"


def test_all_spent_rechecks_after_window():
    a, _ = _connect("a@x.test", "inst-AAAAAAAAAAAAAAAA")
    account_pool.mark_exhausted(a, "QUOTA")
    assert account_pool.next_account(set()) is None
    account_pool._state["exhausted"]["a@x.test"]["at"] = time.time() - RECHECK_AFTER_S - 1
    assert account_pool.next_account(set()) is a


def test_pin_overrides_selection():
    a, _ = _connect("a@x.test", "inst-AAAAAAAAAAAAAAAA")
    b, _ = _connect("b@x.test", "inst-BBBBBBBBBBBBBBBB")
    with account_pool.pin(b):
        assert flow_client.user_info["email"] == "b@x.test"
    assert account_pool.current() is a


def test_worker_rotates_image_job_to_next_account(client):
    a, _ = _connect("a@x.test", "inst-AAAAAAAAAAAAAAAA")
    b, _ = _connect("b@x.test", "inst-BBBBBBBBBBBBBBBB")
    seen = []

    async def handler(params):
        who = flow_client.user_info["email"]
        seen.append(who)
        if who == "a@x.test":
            return {"error": "BOQ_QUOTA_DAILY"}, "BOQ_QUOTA_DAILY — hết lượt"
        return {"media_ids": ["m-1", "m-2"]}, None

    result, err = asyncio.run(processor._run_on_accounts(handler, "gen_image", {"prompt": "p"}))
    assert err is None
    assert seen == ["a@x.test", "b@x.test"]
    assert result["flow_account"] == "b@x.test"
    assert result["account_switches"][0]["from"] == "a@x.test"
    assert account_pool.snapshot()["events"][0]["to"] == "b@x.test"
    assert account_projects.media_owner("m-1") == "b@x.test"
    assert account_pool.snapshot()["accounts"][0]["exhausted"] is True
    # The next job starts directly on b.
    seen.clear()
    asyncio.run(processor._run_on_accounts(handler, "gen_image", {"prompt": "p"}))
    assert seen == ["b@x.test"]


def test_worker_reports_when_every_account_is_spent(client):
    _connect("a@x.test", "inst-AAAAAAAAAAAAAAAA")
    _connect("b@x.test", "inst-BBBBBBBBBBBBBBBB")

    async def handler(params):
        return {}, "BOQ_QUOTA_DAILY"

    _, err = asyncio.run(processor._run_on_accounts(handler, "gen_image", {}))
    assert err.startswith("ALL_ACCOUNTS_QUOTA")


def test_video_jobs_do_not_rotate(client):
    _connect("a@x.test", "inst-AAAAAAAAAAAAAAAA")
    _connect("b@x.test", "inst-BBBBBBBBBBBBBBBB")
    calls = []

    async def handler(params):
        calls.append(1)
        return {}, "QUOTA"

    asyncio.run(processor._run_on_accounts(handler, "gen_video", {}))
    assert calls == [1]


def test_board_project_is_per_account(client, monkeypatch):
    from unittest.mock import AsyncMock, patch

    a, _ = _connect("a@x.test", "inst-AAAAAAAAAAAAAAAA")
    b, _ = _connect("b@x.test", "inst-BBBBBBBBBBBBBBBB")
    board = client.post("/api/boards", json={"name": "B"}).json()
    n = {"v": 0}

    async def fake_create(title="x", tool=None):
        n["v"] += 1
        return {"project_id": f"proj-{n['v']}"}

    with patch("flowboard.routes.projects.get_flow_sdk") as m:
        m.return_value.create_project = AsyncMock(side_effect=fake_create)
        r1 = client.post(f"/api/boards/{board['id']}/project").json()
        assert r1 == {"flow_project_id": "proj-1", "created": True}
        assert client.post(f"/api/boards/{board['id']}/project").json()["flow_project_id"] == "proj-1"
        account_pool.select("b@x.test")
        r2 = client.post(f"/api/boards/{board['id']}/project").json()
        assert r2 == {"flow_project_id": "proj-2", "created": True}
        account_pool.select("a@x.test")
        assert client.get(f"/api/boards/{board['id']}/project").json()["flow_project_id"] == "proj-1"
    assert account_projects.project_owner("proj-2") == "b@x.test"
    # Legacy projects with no recorded owner belong to the primary account.
    assert account_projects.project_usable("legacy-proj", "a@x.test")
    assert not account_projects.project_usable("proj-2", "a@x.test")
    assert client.delete(f"/api/boards/{board['id']}").status_code == 200


def test_accounts_api(client):
    _connect("a@x.test", "inst-AAAAAAAAAAAAAAAA")
    b, _ = _connect("b@x.test", "inst-BBBBBBBBBBBBBBBB")
    account_pool.mark_exhausted(b, "QUOTA")
    data = client.get("/api/accounts").json()
    assert data["auto_rotate"] is True and len(data["accounts"]) == 2
    assert client.post("/api/accounts/select", json={"key": "b@x.test"}).json()["selected"] == "b@x.test"
    assert client.post("/api/accounts/select", json={"key": "nobody@x.test"}).status_code == 404
    client.post("/api/accounts/reset", json={"key": "b@x.test"})
    assert client.get("/api/accounts").json()["active"] == "b@x.test"
    assert client.post("/api/accounts/settings", json={"auto_rotate": False}).json()["auto_rotate"] is False
    order = client.post("/api/accounts/order", json={"keys": ["b@x.test"]}).json()
    assert [r["key"] for r in order["accounts"]][0] == "b@x.test"


def test_existing_media_runs_on_its_owner_account(client):
    a, _ = _connect("a@x.test", "inst-AAAAAAAAAAAAAAAA")
    b, _ = _connect("b@x.test", "inst-BBBBBBBBBBBBBBBB")
    account_projects.record_project("proj-a", "a@x.test")
    account_projects.record_media(["img-a"], "a@x.test")
    account_pool.select("b@x.test")
    owner, pid = account_projects.owner_route("img-a", "proj-b")
    assert owner is a and pid == "proj-a"
    assert account_projects.owner_route("img-unknown", "proj-b") == (None, "proj-b")
    assert not account_projects.media_usable("img-a")


def test_accounts_api_reports_today_usage(client):
    from flowboard.db import get_session
    from flowboard.db.models import Request

    _connect("a@x.test", "inst-AAAAAAAAAAAAAAAA")
    _connect("b@x.test", "inst-BBBBBBBBBBBBBBBB")
    with get_session() as s:
        s.add(Request(type="gen_image", status="done", params={},
                      result={"flow_account": "b@x.test", "media_ids": ["x", "y"],
                              "account_switches": [{"from": "a@x.test", "to": "b@x.test"}]}))
        s.add(Request(type="proxy", status="done", params={}, result={"flow_account": "b@x.test"}))
        s.commit()
    rows = {a["key"]: a["today"] for a in client.get("/api/accounts").json()["accounts"]}
    assert rows["b@x.test"] == {"jobs": 1, "done": 1, "failed": 0, "media": 2, "switched_away": 0}
    assert rows["a@x.test"]["switched_away"] == 1
