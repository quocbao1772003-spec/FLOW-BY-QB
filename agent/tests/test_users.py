"""Server mode: Flowboard users, login gate, pairing, per-user Flow accounts."""
import asyncio
import json

import pytest

from flowboard.services import users as svc
from flowboard.services import ws_server
from flowboard.services.flow_client import account_pool


@pytest.fixture(autouse=True)
def _clean(tmp_path):
    account_pool._state_path = tmp_path / "accounts.json"
    account_pool._reset_for_tests()
    svc._invalidate_cache()
    yield
    account_pool._reset_for_tests()
    account_pool._state_path = None
    svc._invalidate_cache()


def _login(client, username, password):
    r = client.post("/api/session/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r


def test_open_until_first_user_then_login_required(client):
    assert client.get("/api/session").json() == {"auth_required": False, "user": None}
    assert client.get("/api/boards").status_code == 200
    svc.create_user("boss", "secret123", role="admin")
    svc._invalidate_cache()
    assert client.get("/api/boards").status_code == 401
    assert client.get("/api/health").status_code == 200
    assert client.post("/api/session/login", json={"username": "boss", "password": "nope"}).status_code == 401
    _login(client, "Boss", "secret123")
    me = client.get("/api/session").json()
    assert me["user"]["username"] == "boss" and me["user"]["role"] == "admin"
    assert client.get("/api/boards").status_code == 200
    client.post("/api/session/logout")
    assert client.get("/api/boards").status_code == 401


def test_admin_manages_staff_and_staff_cannot(client):
    svc.create_user("boss", "secret123", role="admin")
    svc._invalidate_cache()
    _login(client, "boss", "secret123")
    r = client.post("/api/users", json={"username": "lan", "display_name": "Lan"}).json()
    staff_pw = r["password"]
    assert len(staff_pw) >= 10
    uid = r["user"]["id"]
    users = client.get("/api/users").json()
    assert [u["username"] for u in users] == ["boss", "lan"]
    new_pw = client.patch(f"/api/users/{uid}", json={"reset_password": True}).json()["password"]
    assert new_pw and new_pw != staff_pw
    client.post("/api/session/logout")
    _login(client, "lan", new_pw)
    assert client.get("/api/users").status_code == 403
    assert client.post("/api/session/password",
                       json={"current_password": new_pw, "new_password": "lan-new-1"}).json()["ok"]
    client.post("/api/session/logout")
    _login(client, "boss", "secret123")
    client.patch(f"/api/users/{uid}", json={"disabled": True})
    client.post("/api/session/logout")
    assert client.post("/api/session/login", json={"username": "lan", "password": "lan-new-1"}).status_code == 401


def test_api_token_and_bridge_pairing(client):
    admin = svc.create_user("boss", "secret123", role="admin")
    svc._invalidate_cache()
    _login(client, "boss", "secret123")
    api = client.post("/api/session/tokens", json={"kind": "api", "label": "mcp"}).json()["token"]
    pair = client.post("/api/session/tokens", json={"kind": "bridge", "label": "Chrome 1"}).json()["token"]
    client.post("/api/session/logout")
    assert client.get("/api/boards", headers={"Authorization": f"Bearer {api}"}).status_code == 200
    assert client.get("/api/boards", headers={"Authorization": f"Bearer {pair}"}).status_code == 401
    assert svc.user_for_token(pair, "bridge").id == admin.id


class _Sock:
    def __init__(self, hello):
        self.hello, self.sent, self.closed = hello, [], None
        self.inbox: asyncio.Queue = asyncio.Queue()

    async def recv(self):
        return json.dumps(self.hello)

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    async def close(self, code, reason):
        self.closed = code

    def __aiter__(self):
        return self

    async def __anext__(self):
        v = await self.inbox.get()
        if v is None:
            raise StopAsyncIteration
        return json.dumps(v)


def test_each_user_only_uses_own_flow_accounts(client):
    a = svc.create_user("boss", "secret123", role="admin")
    b = svc.create_user("lan", "secret123")
    svc._invalidate_cache()
    pa, _ = svc.create_token(a.id, "bridge")
    pb, _ = svc.create_token(b.id, "bridge")

    async def scenario():
        socks = {
            "bad": _Sock({"type": "bridge_hello", "protocol": 2, "instanceId": "inst-XXXXXXXXXXXXXXXX", "version": "0.2.0"}),
            "a": _Sock({"type": "bridge_hello", "protocol": 2, "instanceId": "inst-AAAAAAAAAAAAAAAA", "version": "0.2.0", "pairToken": pa}),
            "b": _Sock({"type": "bridge_hello", "protocol": 2, "instanceId": "inst-BBBBBBBBBBBBBBBB", "version": "0.2.0", "pairToken": pb}),
        }
        tasks = [asyncio.create_task(ws_server._handler(s)) for s in socks.values()]
        await asyncio.sleep(0.05)
        await socks["a"].inbox.put({"type": "user_info", "userInfo": {"email": "boss.flow@x.test"}})
        await socks["b"].inbox.put({"type": "user_info", "userInfo": {"email": "lan.flow@x.test"}})
        await asyncio.sleep(0.05)
        assert socks["bad"].closed == 4004
        assert socks["bad"].sent[0]["error"] == "PAIRING_REQUIRED"
        for uid, email in ((a.id, "boss.flow@x.test"), (b.id, "lan.flow@x.test")):
            tok = svc.current_user_id.set(uid)
            try:
                assert account_pool.key_of(account_pool.current()) == email
                assert [r["key"] for r in account_pool.snapshot()["accounts"]] == [email]
                # Out of quota: never borrows another user's account.
                account_pool.mark_exhausted(account_pool.current(), "QUOTA")
                assert account_pool.next_account({email}) is None
            finally:
                svc.current_user_id.reset(tok)
        assert len(account_pool.snapshot(all_users=True)["accounts"]) == 2
        for s in socks.values():
            await s.inbox.put(None)
        await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(scenario())


def test_requests_are_stamped_with_user(client):
    svc.create_user("boss", "secret123", role="admin")
    svc._invalidate_cache()
    _login(client, "boss", "secret123")
    from unittest.mock import patch

    with patch("flowboard.routes.requests.get_worker") as w:
        w.return_value.enqueue = lambda rid: None
        r = client.post("/api/requests", json={"type": "gen_image", "params": {"prompt": "x", "_user_id": 999}})
    assert r.json()["params"]["_user_id"] != 999
    assert isinstance(r.json()["params"]["_user_id"], int)


def test_first_admin_from_this_computer_only(client):
    r = client.post("/api/users", json={"username": "boss", "password": "secret123"},
                    headers={"cf-connecting-ip": "1.2.3.4"})
    assert r.status_code == 403
    # TestClient's host is "testclient"; simulate a local call
    from flowboard.routes import users as users_route
    orig = users_route._local_request
    users_route._local_request = lambda req: True
    try:
        r = client.post("/api/users", json={"username": "boss", "password": "secret123", "role": "staff"})
    finally:
        users_route._local_request = orig
    assert r.status_code == 200 and r.json()["user"]["role"] == "admin"
    svc._invalidate_cache()
    assert client.get("/api/boards").status_code == 401
