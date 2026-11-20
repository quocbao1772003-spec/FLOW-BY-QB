"""Flow Music: fake bridge only, no network."""
import asyncio
import base64
import json
import uuid

import pytest

from flowboard.services import flow_music as fm
from flowboard.services.flow_music import FlowMusic, MusicError

OP = "11111111-1111-4111-8111-111111111111"
CLIP = "22222222-2222-4222-8222-222222222222"


async def _nosleep(_s):
    return None


class FakeBridge:
    """Records calls; behaviour is switched per test."""

    def __init__(self, *, credits=50, sse_error=False, blocked=False):
        self.calls = []
        self.credits = credits
        self.sse_error = sse_error
        self.blocked = blocked
        self.created = 0

    async def __call__(self, path, method="GET", body=None, mode="json", timeout_ms=0):
        self.calls.append((method, path, body))
        ok = lambda data: {"ok": True, "status": 200, "data": data}  # noqa: E731
        if path == "/billing/credits":
            return ok({"data": {"credits_remaining": self.credits}})
        if path == "/conversation/create":
            return ok({"conversation_id": "conv-1"})
        if path == "/producer/tool-call":
            self.created += 1
            self.credits -= 5
            return ok({"job_id": "job-1"})
        if path.startswith("/messages/"):
            if self.blocked:
                return ok("event: error\ndata: blocked by safety policy\n\n")
            if self.sse_error:
                return ok('event: error\ndata: "Error while streaming parts"\n\n')
            return ok(f'data: {{"operation_id": "{OP}"}}\n\n')
        if path.startswith("/conversations/"):
            return ok({"messages": [{"operation_id": OP}]})
        if path.startswith("/audio-create-song-status/"):
            return ok({"status": "complete", "clip_id": CLIP})
        if path == "/clips":
            return ok({"clips": {CLIP: {"title": "My Song", "duration": {"value": 12.5},
                                        "lyrics": {"value": {"text": "la la"}},
                                        "audio_url": "u", "wav_url": "w", "image_url": "i"}}})
        if path.startswith("/download/audio/"):
            return {"ok": True, "status": 200, "data": base64.b64encode(b"ID3fake").decode()}
        return {"ok": False, "status": 404, "error": "http_404"}


def run(coro):
    return asyncio.run(coro)


def test_lyrics_id_is_uuid5_and_empty_for_instrumental():
    ns = uuid.UUID("b8f9e3a1-7c2d-4f5e-9a8b-1c3d5e7f9a2b")
    assert fm.lyrics_id("hello\nworld") == str(uuid.uuid5(ns, "hello\nworld"))
    assert fm.lyrics_id("") == ""
    assert fm.lyrics_id("   ") == ""
    assert fm.lyrics_id("[Instrumental]") == ""


def test_start_song_instrumental_sends_empty_lyrics_id():
    b = FakeBridge()
    fmc = FlowMusic(b, _nosleep)
    run(fmc.start_song(sound_prompt="lofi", lyrics="ignored", instrumental=True, title="t",
                       model="Lyria 3.5", seed=None))
    body = next(x[2] for x in b.calls if x[1] == "/producer/tool-call")
    assert body["part"]["args"]["lyrics_id"] == ""
    assert body["client_context"]["lyrics_id_map"] == {}
    assert body["part"]["tool_name"] == "audio__create_song"


def test_start_song_with_lyrics_maps_id():
    b = FakeBridge()
    run(FlowMusic(b, _nosleep).start_song(sound_prompt="p", lyrics="verse", instrumental=False,
                                          title="t", model="Lyria 3.5", seed=7))
    body = next(x[2] for x in b.calls if x[1] == "/producer/tool-call")
    lid = fm.lyrics_id("verse")
    assert body["part"]["args"]["lyrics_id"] == lid
    assert body["client_context"]["lyrics_id_map"] == {lid: "verse"}
    assert body["part"]["args"]["seed"] == 7


def test_sse_error_falls_back_to_conversation(tmp_path):
    b = FakeBridge(sse_error=True)
    res = run(fm.generate_songs(FlowMusic(b, _nosleep), {"sound_prompt": "p", "formats": ["mp3"]},
                                tmp_path, poll_s=0))
    assert len(res["takes"]) == 1
    assert any(c[1].startswith("/conversations/") for c in b.calls)
    assert (tmp_path / res["takes"][0]["files"]["mp3"]).read_bytes() == b"ID3fake"
    assert res["takes"][0]["lyrics"] == "la la"
    assert res["credits_used"] == 5


def test_blocked_content(tmp_path):
    b = FakeBridge(blocked=True)
    with pytest.raises(MusicError) as e:
        run(fm.generate_songs(FlowMusic(b, _nosleep), {"sound_prompt": "p"}, tmp_path, poll_s=0))
    assert e.value.code == "blocked_content"


def test_credits_exhausted_precheck(tmp_path):
    b = FakeBridge(credits=2)
    with pytest.raises(MusicError) as e:
        run(fm.generate_songs(FlowMusic(b, _nosleep), {"sound_prompt": "p"}, tmp_path))
    assert e.value.code == "credits_exhausted"
    assert b.created == 0


def test_classify_errors():
    assert fm.classify({"ok": False, "error": "not_logged_in"}, "x").code == "no_session"
    assert fm.classify({"ok": False, "error": "extension_disconnected"}, "x").code == "extension_offline"
    assert fm.classify({"ok": False, "status": 402, "error": "http_402"}, "x").code == "credits_exhausted"
    assert fm.classify({"ok": False, "status": 429, "error": "http_429"}, "x").code == "busy"
    assert fm.classify({"ok": False, "error": "timeout"}, "x").code == "timeout"
    assert fm.classify({"ok": False, "status": 500, "error": "http_500"}, "x").code == "flowmusic_api_changed"


# ── pool / worker level ────────────────────────────────────────────────────
class FakeClient:
    def __init__(self, email):
        self.email = email
        self.connected = True


class FakePool:
    def __init__(self, emails):
        self.clients = [FakeClient(e) for e in emails]
        self.exhausted = {}

    def connected_clients(self):
        return self.clients

    def key_of(self, c):
        return c.email

    def identified(self, c):
        return True

    def _exhausted(self, key, now=None):
        return self.exhausted.get(key)

    def mark_exhausted_key(self, key, reason="", hold_s=0):
        self.exhausted[key] = {"reason": reason}

    def pin(self, c):
        import contextlib
        return contextlib.nullcontext(c)


def test_exhausted_account_rotates_to_next(tmp_path):
    pool = FakePool(["a@x.com", "b@x.com"])
    made = {}

    def factory(c):
        made[c.email] = FakeBridge(credits=1 if c.email == "a@x.com" else 50)
        return FlowMusic(made[c.email], _nosleep)

    res, err = run(fm.run_job({"sound_prompt": "p"}, pool, tmp_path, fm_factory=factory, poll_s=0))
    assert err is None
    assert res["account"] == "b@x.com"
    assert "music:a@x.com" in pool.exhausted
    # image-side keys untouched
    assert "a@x.com" not in pool.exhausted


def test_all_exhausted_error(tmp_path):
    pool = FakePool(["a@x.com"])
    res, err = run(fm.run_job({"sound_prompt": "p"}, pool, tmp_path,
                              fm_factory=lambda c: FlowMusic(FakeBridge(credits=0), _nosleep), poll_s=0))
    assert err == "credits_exhausted"


def test_no_extension_connected(tmp_path):
    res, err = run(fm.run_job({"sound_prompt": "p"}, FakePool([]), tmp_path))
    assert err == "extension_offline"


def test_busy_account_queues_second_job(tmp_path):
    """One running job per account: the second waits for the first."""
    pool = FakePool(["a@x.com"])
    order = []

    class Slow(FakeBridge):
        async def __call__(self, path, *a, **kw):
            if path == "/producer/tool-call":
                order.append("start")
                await asyncio.sleep(0.05)
                order.append("started")
            return await super().__call__(path, *a, **kw)

    async def both():
        mk = lambda c: FlowMusic(Slow(), _nosleep)  # noqa: E731
        j1 = fm.run_job({"sound_prompt": "1"}, pool, tmp_path / "1", fm_factory=mk, poll_s=0)
        j2 = fm.run_job({"sound_prompt": "2"}, pool, tmp_path / "2", fm_factory=mk, poll_s=0)
        return await asyncio.gather(j1, j2)

    (r1, e1), (r2, e2) = run(both())
    assert e1 is None and e2 is None
    assert order == ["start", "started", "start", "started"]  # never interleaved


def test_busy_response_retries_then_succeeds(tmp_path):
    class Busy(FakeBridge):
        n = 0

        async def __call__(self, path, *a, **kw):
            if path == "/producer/tool-call":
                Busy.n += 1
                if Busy.n == 1:
                    return {"ok": False, "status": 429, "error": "http_429"}
            return await super().__call__(path, *a, **kw)

    res = run(fm.generate_songs(FlowMusic(Busy(), _nosleep), {"sound_prompt": "p"}, tmp_path, poll_s=0))
    assert len(res["takes"]) == 1


# ── REST: idempotent client_ref + cancel ───────────────────────────────────
def test_generate_client_ref_is_idempotent(client, monkeypatch):
    from flowboard.worker import processor

    monkeypatch.setattr(processor.get_worker(), "enqueue", lambda rid: None)
    body = {"sound_prompt": "p", "client_ref": "ytops-1"}
    r1 = client.post("/api/music/generate", json=body)
    r2 = client.post("/api/music/generate", json=body)
    assert r1.status_code == 202 and r2.status_code == 202
    assert r1.json()["request_id"] == r2.json()["request_id"]
    r3 = client.post("/api/music/generate", json={**body, "client_ref": "ytops-2"})
    assert r3.json()["request_id"] != r1.json()["request_id"]

    got = client.get(f"/api/music/requests/{r1.json()['request_id']}").json()
    assert got["status"] == "queued" and got["takes"] == []
    c = client.post(f"/api/music/requests/{r1.json()['request_id']}/cancel")
    assert c.status_code == 200 and c.json()["status"] == "cancelled"


def test_music_media_serves_file_and_blocks_traversal(client):
    from flowboard.config import STORAGE_DIR

    d = STORAGE_DIR / "music" / "99"
    d.mkdir(parents=True, exist_ok=True)
    (d / "a.mp3").write_bytes(b"0123456789")
    r = client.get("/api/music/media/99/a.mp3", headers={"Range": "bytes=0-3"})
    assert r.status_code in (200, 206)
    assert r.headers["cache-control"] == "no-store"
    assert client.get("/api/music/media/99/..%2f..%2fx").status_code in (400, 404)


def test_accounts_endpoint(client):
    r = client.get("/api/music/accounts")
    assert r.status_code == 200 and isinstance(r.json(), list)

# ── per-user scoping (FR-075) ──────────────────────────────────────────────
def test_music_is_scoped_per_user(client, monkeypatch, tmp_path):
    from flowboard.services import users as svc
    from flowboard.services.flow_client import account_pool
    from flowboard.worker import processor

    account_pool._state_path = tmp_path / "accounts.json"
    account_pool._reset_for_tests()
    svc._invalidate_cache()
    a = svc.create_user("boss", "secret123", role="admin")
    b = svc.create_user("lan", "secret123")
    svc._invalidate_cache()
    ta, _ = svc.create_token(a.id, "api")
    tb, _ = svc.create_token(b.id, "api")
    pa, _ = svc.create_token(a.id, "bridge")
    pb, _ = svc.create_token(b.id, "bridge")
    monkeypatch.setattr(processor.get_worker(), "enqueue", lambda rid: None)

    from flowboard.services import ws_server
    import sys
    sys.path.insert(0, __file__.rsplit("test_flow_music.py", 1)[0])
    from test_users import _Sock

    async def scenario():
        socks = [
            _Sock({"type": "bridge_hello", "protocol": 2, "instanceId": "inst-AAAAAAAAAAAAAAAA", "version": "0.2.0", "pairToken": pa}),
            _Sock({"type": "bridge_hello", "protocol": 2, "instanceId": "inst-BBBBBBBBBBBBBBBB", "version": "0.2.0", "pairToken": pb}),
        ]
        tasks = [asyncio.create_task(ws_server._handler(s)) for s in socks]
        await asyncio.sleep(0.05)
        await socks[0].inbox.put({"type": "user_info", "userInfo": {"email": "boss.flow@x.test"}})
        await socks[1].inbox.put({"type": "user_info", "userInfo": {"email": "lan.flow@x.test"}})
        await asyncio.sleep(0.05)
        # candidates() only sees the acting user's accounts
        for uid, email in ((a.id, "boss.flow@x.test"), (b.id, "lan.flow@x.test")):
            tok = svc.current_user_id.set(uid)
            try:
                assert [account_pool.key_of(c) for c in fm.candidates(account_pool)] == [email]
                assert fm.candidates(account_pool, "boss.flow@x.test" if email.startswith("lan") else "lan.flow@x.test") == []
            finally:
                svc.current_user_id.reset(tok)
        for s in socks:
            await s.inbox.put(None)
        await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(scenario())

    ha, hb = {"Authorization": f"Bearer {ta}"}, {"Authorization": f"Bearer {tb}"}
    ra = client.post("/api/music/generate", json={"sound_prompt": "p"}, headers=ha)
    assert ra.status_code == 202
    rid = ra.json()["request_id"]
    assert client.get(f"/api/music/requests/{rid}", headers=ha).status_code == 200
    assert client.get(f"/api/music/requests/{rid}", headers=hb).status_code == 404
    assert client.post(f"/api/music/requests/{rid}/cancel", headers=hb).status_code == 404
    # same client_ref from another user is a different request
    r1 = client.post("/api/music/generate", json={"sound_prompt": "p", "client_ref": "x"}, headers=ha).json()
    r2 = client.post("/api/music/generate", json={"sound_prompt": "p", "client_ref": "x"}, headers=hb).json()
    assert r1["request_id"] != r2["request_id"]

    wa = client.get("/api/music/whoami", headers=ha).json()
    wb = client.get("/api/music/whoami", headers=hb).json()
    assert wa["user"]["username"] == "boss" and wb["user"]["username"] == "lan"
    # accounts listing: connection closed above, so each sees only own (none now), never the other's
    assert all(x["email"].startswith("boss") for x in wa["music_accounts"])
    assert all(x["email"].startswith("lan") for x in wb["music_accounts"])
    assert client.get("/api/music/whoami", headers={"Authorization": "Bearer fbt_bogus0000000000000"}).status_code == 401
    account_pool._reset_for_tests()
    account_pool._state_path = None
    svc._invalidate_cache()

# ── list endpoint (UI queue + library) ─────────────────────────────────────
def test_list_music_requests_newest_first_paginated_and_filtered(client, monkeypatch):
    from flowboard.worker import processor

    monkeypatch.setattr(processor.get_worker(), "enqueue", lambda rid: None)
    ids = [client.post("/api/music/generate", json={"sound_prompt": f"p{i}", "title": f"T{i}",
                                                    "lyrics": "[Verse]\nla"}).json()["request_id"]
           for i in range(3)]
    client.post(f"/api/music/requests/{ids[0]}/cancel")
    r = client.get("/api/music/requests?limit=2").json()
    got = [x["request_id"] for x in r["items"]]
    assert got == [ids[2], ids[1]] and r["next_before"] == int(ids[1])
    first = r["items"][0]
    assert first["title"] == "T2" and first["sound_prompt"] == "p2" and first["lyrics"] == "[Verse]\nla"
    assert first["created_at"] and first["status"] == "queued" and first["takes_wanted"] == 1
    r2 = client.get(f"/api/music/requests?limit=2&before={r['next_before']}").json()
    assert ids[0] in [x["request_id"] for x in r2["items"]]
    c = client.get("/api/music/requests?status=cancelled").json()["items"]
    assert ids[0] in [x["request_id"] for x in c] and all(x["status"] == "cancelled" for x in c)


def test_gen_music_with_stems_option_splits_each_take(tmp_path, monkeypatch):
    from flowboard.worker import processor

    async def fake_job(params, pool, out_dir, **kw):
        return {"takes": [{"clip_id": "c1", "files": {"mp3": "a-1.mp3"}},
                          {"clip_id": "c2", "files": {"mp3": "a-2.mp3"}}],
                "account": "x@y.test", "credits_used": 10}, None

    calls = []

    async def fake_stems(params, pool, out_dir, **kw):
        calls.append((params["clip_id"], params["account"], out_dir.name))
        if params["clip_id"] == "c2":
            return {"error_detail": "nope"}, "stems_failed"
        return {"stems": {"vocals": "vocals.mp3"}}, None

    monkeypatch.setattr(fm, "run_job", fake_job)
    monkeypatch.setattr(fm, "run_stems", fake_stems)
    res, err = run(processor._handle_gen_music({"sound_prompt": "p", "stems": True, "__request_id": 7}))
    assert err is None
    assert calls == [("c1", "x@y.test", "1"), ("c2", "x@y.test", "2")]
    assert res["takes"][0]["stems"] == {"vocals": "/api/music/media/7/stems/1/vocals.mp3"}
    assert res["takes"][1]["stems_error"] == "nope" and "stems" not in res["takes"][1]


class DownloadFailsBridge(FakeBridge):
    """The tab makes the song, then drops while the WAV comes down (seen 20/11)."""

    async def __call__(self, path, method="GET", body=None, mode="json", timeout_ms=0):
        if path.startswith("/download/audio/"):
            self.calls.append((method, path, body))
            return {"ok": False, "status": 0, "error": "extension_disconnected"}
        return await super().__call__(path, method, body, mode, timeout_ms)

def test_download_falls_back_to_public_clip_file(tmp_path):
    fetched = []

    async def fetch(url):
        fetched.append(url)
        return b"RIFFwav"

    b = DownloadFailsBridge()
    res = run(fm.generate_songs(FlowMusic(b, _nosleep, fetch), {"sound_prompt": "p", "formats": ["wav"]},
                                tmp_path, poll_s=0))
    assert fetched == ["https://storage.googleapis.com/producer-app-public/clips/" + CLIP + ".wav"]
    assert (tmp_path / res["takes"][0]["files"]["wav"]).read_bytes() == b"RIFFwav"

def test_download_failure_reported_when_public_file_also_fails(tmp_path):
    async def fetch(url):
        raise RuntimeError("404")

    with pytest.raises(MusicError) as e:
        run(fm.generate_songs(FlowMusic(DownloadFailsBridge(), _nosleep, fetch),
                              {"sound_prompt": "p", "formats": ["wav"]}, tmp_path, poll_s=0))
    assert e.value.code == "extension_offline"

def test_streaming_error_waits_longer_for_the_operation(tmp_path):
    class Late(FakeBridge):
        def __init__(self):
            super().__init__(sse_error=True)
            self.reads = 0

        async def __call__(self, path, method="GET", body=None, mode="json", timeout_ms=0):
            if path.startswith("/conversations/"):
                self.reads += 1
                if self.reads < 10:  # beyond the old 6 tries
                    self.calls.append((method, path, body))
                    return {"ok": True, "status": 200, "data": {"messages": []}}
            return await super().__call__(path, method, body, mode, timeout_ms)

    b = Late()
    res = run(fm.generate_songs(FlowMusic(b, _nosleep), {"sound_prompt": "p", "formats": ["mp3"]},
                                tmp_path, poll_s=0))
    assert len(res["takes"]) == 1 and b.reads == 10


class SlowTabBridge(FakeBridge):
    """Tab downloads are slow (base64 through the extension); public GCS is fast."""

    async def __call__(self, path, method="GET", body=None, mode="json", timeout_ms=0):
        if path.startswith("/download/audio/"):
            self.calls.append((method, path, body))
            await asyncio.sleep(0.6)
        return await super().__call__(path, method, body, mode, timeout_ms)


def test_formats_download_in_parallel_and_public_file_wins_when_faster(tmp_path):
    import time

    async def fetch(url):
        await asyncio.sleep(0.05)
        return b"RIFFwav" if url.endswith(".wav") else b"\x00\x00\x00\x18ftypm4a"

    t0 = time.monotonic()
    res = run(fm.generate_songs(FlowMusic(SlowTabBridge(), _nosleep, fetch),
                                {"sound_prompt": "p", "formats": ["mp3", "wav"]}, tmp_path, poll_s=0))
    dt = time.monotonic() - t0
    files = res["takes"][0]["files"]
    assert set(files) == {"mp3", "wav"}
    assert (tmp_path / files["wav"]).read_bytes() == b"RIFFwav"
    assert dt < 0.5  # serial tab downloads would take >= 1.2s


def test_one_format_failing_everywhere_still_raises(tmp_path):
    async def fetch(url):
        raise RuntimeError("404")

    with pytest.raises(MusicError):
        run(fm.generate_songs(FlowMusic(DownloadFailsBridge(), _nosleep, fetch),
                              {"sound_prompt": "p", "formats": ["mp3", "wav"]}, tmp_path, poll_s=0))


def test_poll_interval_is_dense_after_20s():
    assert FlowMusic._next_poll(30, 5) == 2.0
    assert FlowMusic._next_poll(5, 5) == 4.0
    assert FlowMusic._next_poll(5, 0) == 0
