"""Flow Video via tab: fake bridge only, no network, no extension."""
import asyncio
import base64
from contextlib import contextmanager

import pytest

from flowboard.config import STORAGE_DIR
from flowboard.db import get_session
from flowboard.db.models import Request
from flowboard.services import flow_video_ui as fv

def run(coro):
    return asyncio.run(coro)

class FakeClient:
    connected = True

    def __init__(self, key="a@x.com"):
        self.key = key

class FakePool:
    def __init__(self, keys=("a@x.com",)):
        self.clients = [FakeClient(k) for k in keys]

    def connected_clients(self):
        return self.clients

    def identified(self, c):
        return True

    def key_of(self, c):
        return c.key

    @contextmanager
    def pin(self, c):
        yield c

def _fake_factory(mp4: bytes, steps=fv.STEP_KEYS, fail=None, split=3, cost=None):
    """call_factory whose call() emulates the extension: progress + chunks + reply."""
    seen = {}

    def factory(_client):
        async def call(params, timeout_s=0):
            seen["params"] = params
            cid = params.get("call")
            if params.get("probe"):
                return {"ok": True, "tab_open": True, "silent_on": True, "always_approve": False, "credits": 980,
                        "models": [{"label": "Veo 3.1 - Fast", "leaving": "Leaving Dec 5"}, {"label": "Veo 3.1 - Lite", "leaving": None}]}
            if cid is None:
                return {"ok": True}
            for k in steps:
                fv.on_progress({"call": cid, "step": k, "ok": True})
                if fail and k == fail[0]:
                    return {"ok": False, "code": fail[1], "detail": "boom"}
            n = max(1, -(-len(mp4) // split))
            parts = [mp4[i:i + n] for i in range(0, len(mp4), n)] or [b""]
            for i, part in enumerate(parts):
                fv.on_chunk({"call": cid, "seq": i, "last": i == len(parts) - 1,
                             "b64": base64.b64encode(part).decode()})
            out = {"ok": True, "size": len(mp4), "duration_s": 8.0, "silent_on": True, "credits_after": 960}
            if cost is not None:
                out["cost"] = cost
            return out
        return call
    return factory, seen

MP4 = b"\x00\x00\x00\x18ftypmp42" + bytes(range(256)) * 20

def test_run_job_assembles_chunks_and_reports_steps(tmp_path):
    factory, seen = _fake_factory(MP4)
    steps = []
    out = tmp_path / "1.mp4"
    res, err = run(fv.run_job({"prompt": "p", "image": {"b64": "x", "name": "a.png"}, "model": "veo_quality"},
                              FakePool(), out, on_step=lambda k, ok: steps.append(k),
                              call_factory=factory, poll_s=0.01))
    assert err is None
    assert out.read_bytes() == MP4
    assert steps == fv.STEP_KEYS
    assert res["credits"] == 100 and res["credits_real"] is False and res["size"] == len(MP4) and res["duration_s"] == 8.0
    assert seen["params"]["selectors"]["prompt_box"].startswith("div.ProseMirror")

def test_real_cost_overrides_fallback_and_steps_are_eight(tmp_path):
    assert len(fv.STEP_KEYS) == 8 and fv.STEP_KEYS[1] == "manual_mode" and fv.DEFAULT_MODEL == "veo_lite"
    factory, seen = _fake_factory(MP4, cost=7)
    res, err = run(fv.run_job({"prompt": "p", "image": {}, "max_credits": 10, "resolution": "1080p",
                               "ref_images": [{"b64": "x"}]}, FakePool(), tmp_path / "7.mp4",
                              call_factory=factory, poll_s=0.01))
    assert err is None and res["credits"] == 7 and res["credits_real"] is True
    p = seen["params"]
    assert p["model"] == "veo_lite" and p["max_credits"] == 10 and p["resolution"] == "1080p"
    assert p["download_quality"] == "1080p" and p["ref_images"] == [{"b64": "x"}]

@pytest.mark.parametrize("code,expect", [
    ("NO_CREDITS", "NO_CREDITS"), ("FLOW_REJECTED", "FLOW_REJECTED"), ("UI_NOT_FOUND", "UI_NOT_FOUND"),
    ("TIMEOUT", "TIMEOUT"), ("OVER_BUDGET", "OVER_BUDGET"), ("DEBUGGER_BUSY", "DEBUGGER_BUSY"),
    ("CDP attach: Another debugger is already attached", "DEBUGGER_BUSY"),
    ("weird", "UI_NOT_FOUND"), ("extension_disconnected", "EXTENSION_OFFLINE"),
])
def test_error_mapping(tmp_path, code, expect):
    factory, _ = _fake_factory(MP4, steps=["open_tab", "upload"], fail=("upload", code))
    res, err = run(fv.run_job({"prompt": "p", "image": {}}, FakePool(), tmp_path / "2.mp4",
                              call_factory=factory, poll_s=0.01))
    assert err == expect
    obj = fv.error_obj(err, res.get("error_detail"))
    assert obj["code"] == expect and obj["message"]

def test_no_account_is_extension_offline(tmp_path):
    res, err = run(fv.run_job({"prompt": "p", "image": {}}, FakePool(()), tmp_path / "3.mp4"))
    assert err == "EXTENSION_OFFLINE"

def test_bad_chunk_order_is_download_failed(tmp_path):
    def factory(_c):
        async def call(params, timeout_s=0):
            cid = params["call"]
            fv.on_chunk({"call": cid, "seq": 1, "last": True, "b64": ""})
            return {"ok": True, "size": 0}
        return call
    res, err = run(fv.run_job({"prompt": "p", "image": {}}, FakePool(), tmp_path / "4.mp4",
                              call_factory=factory, poll_s=0.01))
    assert err == "DOWNLOAD_FAILED"

def test_size_mismatch_is_download_failed(tmp_path):
    def factory(_c):
        async def call(params, timeout_s=0):
            cid = params["call"]
            fv.on_chunk({"call": cid, "seq": 0, "last": True, "b64": base64.b64encode(b"abc").decode()})
            return {"ok": True, "size": 99}
        return call
    _, err = run(fv.run_job({"prompt": "p", "image": {}}, FakePool(), tmp_path / "5.mp4",
                            call_factory=factory, poll_s=0.01))
    assert err == "DOWNLOAD_FAILED"

def test_cancel_stops_job(tmp_path):
    sent = []

    def factory(_c):
        async def call(params, timeout_s=0):
            sent.append(params)
            if "cancel" in params:
                return {"ok": True}
            await asyncio.sleep(30)
            return {"ok": True}
        return call
    res, err = run(fv.run_job({"prompt": "p", "image": {}}, FakePool(), tmp_path / "6.mp4",
                              is_canceled=lambda: True, call_factory=factory, poll_s=0.01))
    assert err == "canceled"
    assert any("cancel" in p for p in sent)
    assert fv.error_obj("canceled") is None

def test_probe_updates_accounts(tmp_path):
    factory, _ = _fake_factory(MP4)
    pool = FakePool()
    d = run(fv.probe(pool, None, call_factory=factory))
    assert d["tab_open"] and d["credits"] == 980
    snap = fv.accounts_snapshot(pool)
    assert snap[0]["email"] == "a@x.com" and snap[0]["silent_on"] is True and snap[0]["credits"] == 980
    assert snap[0]["models"][0]["leaving"] == "Leaving Dec 5"

# ── REST ──────────────────────────────────────────────────────────────────
@pytest.fixture
def online(monkeypatch):
    monkeypatch.setattr(fv, "candidates", lambda pool, only=None: [FakeClient()])
    from flowboard.worker import processor

    class W:
        queued = []
        def enqueue(self, rid):
            self.queued.append(rid)
    w = W()
    monkeypatch.setattr("flowboard.routes.video_ui.get_worker", lambda: w)
    return w

BODY = {"prompt": "move", "start_image": {"url": "https://x/y.png"}, "client_ref": "P:s4:1"}

def test_generate_dedup_and_validation(client, online):
    r = client.post("/api/video-ui/generate", json=BODY)
    assert r.status_code == 201
    j = r.json()
    assert j["status"] == "queued" and j["dedup"] is False
    r2 = client.post("/api/video-ui/generate", json=BODY)
    assert r2.json()["request_id"] == j["request_id"] and r2.json()["dedup"] is True
    assert len(online.queued) == 1
    bad = client.post("/api/video-ui/generate", json={"prompt": "", "start_image": {"url": "https://x"}})
    assert bad.status_code == 422
    two = client.post("/api/video-ui/generate", json={"prompt": "p", "start_image": {"url": "https://x", "media_id": "ab"}})
    assert two.status_code == 422
    none = client.post("/api/video-ui/generate", json={"prompt": "p", "start_image": {}})
    assert none.status_code == 422

def test_generate_offline_503(client, monkeypatch):
    monkeypatch.setattr(fv, "candidates", lambda pool, only=None: [])
    r = client.post("/api/video-ui/generate", json=BODY)
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "EXTENSION_OFFLINE"

def test_view_steps_error_and_media(client, online):
    rid = client.post("/api/video-ui/generate", json=BODY).json()["request_id"]
    v = client.get(f"/api/video-ui/requests/{rid}").json()
    assert [s["key"] for s in v["steps"]] == fv.STEP_KEYS and v["step"] == 0
    # worker writes steps + failure
    from flowboard.worker.processor import _video_ui_step_writer
    _video_ui_step_writer(rid)("approve", True)
    v = client.get(f"/api/video-ui/requests/{rid}").json()
    assert v["step"] == 6 and all(s["ok"] for s in v["steps"][:6])
    with get_session() as s:
        req = s.get(Request, rid)
        req.status, req.error = "failed", "NO_CREDITS"
        s.add(req)
        s.commit()
    v = client.get(f"/api/video-ui/requests/{rid}").json()
    assert v["status"] == "failed" and v["error"]["code"] == "NO_CREDITS" and "credit" in v["error"]["message"]
    # done + media with Range and no-store
    with get_session() as s:
        req = s.get(Request, rid)
        req.status, req.error, req.result = "done", None, {"size": len(MP4), "duration_s": 8.0, "account": "a@x.com"}
        s.add(req)
        s.commit()
    d = STORAGE_DIR / "video_ui"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{rid}.mp4").write_bytes(MP4)
    v = client.get(f"/api/video-ui/requests/{rid}").json()
    assert v["result"]["media_url"].endswith(f"/{rid}/media") and v["result"]["size"] == len(MP4)
    m = client.get(f"/api/video-ui/requests/{rid}/media", headers={"Range": "bytes=0-9"})
    assert m.status_code == 206 and m.content == MP4[:10]
    assert m.headers["cache-control"] == "no-store"
    lst = client.get("/api/video-ui/requests?status=done").json()
    assert [i["id"] for i in lst["items"]] == [rid]

def test_new_params_validation(client, online):
    ok = client.post("/api/video-ui/generate", json={**BODY, "client_ref": "n1", "model": "omni_flash",
                                                      "resolution": "360p", "duration_s": 6, "max_credits": 30})
    assert ok.status_code == 201
    for bad in ({"model": "nope"}, {"resolution": "1080p", "model": "omni_flash"}, {"duration_s": 6},
                {"download_quality": "4k"}, {"duration_s": 99, "model": "omni_flash"}):
        r = client.post("/api/video-ui/generate", json={**BODY, "client_ref": "bad", **bad})
        assert r.status_code == 422, bad
    v = client.get(f"/api/video-ui/requests/{ok.json()['request_id']}").json()
    assert v["model"] == "omni_flash" and v["deprecated"] is False and len(v["steps"]) == 8
    old = client.post("/api/video-ui/generate", json={**BODY, "client_ref": "n2", "model": "veo_fast"}).json()
    assert client.get(f"/api/video-ui/requests/{old['request_id']}").json()["deprecated"] is True

def test_cancel_endpoint(client, online):
    rid = client.post("/api/video-ui/generate", json=BODY).json()["request_id"]
    c = client.post(f"/api/video-ui/requests/{rid}/cancel").json()
    assert c["status"] == "cancelled"
    assert client.post(f"/api/video-ui/requests/{rid}/cancel").status_code == 409
    # a cancelled ref can be re-submitted (new request)
    again = client.post("/api/video-ui/generate", json=BODY).json()
    assert again["dedup"] is False and again["request_id"] != rid

def test_selectors_get_put(client):
    g = client.get("/api/video-ui/selectors").json()
    assert g["start_button"].startswith("button")
    p = client.put("/api/video-ui/selectors", json={"start_button": "button.x"}).json()
    assert p["start_button"] == "button.x" and p["prompt_box"] == g["prompt_box"]
    assert client.get("/api/video-ui/selectors").json()["start_button"] == "button.x"
    fv.selectors_path().unlink()

def test_health_exposes_flag(client):
    assert "video_via_tab" in client.get("/api/health").json()
