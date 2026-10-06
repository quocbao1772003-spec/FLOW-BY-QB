"""Side-panel AI chat: streaming parse, CLI fallbacks, route shape.

A fake `claude` executable stands in for the real CLI so nothing leaves the
machine and the tests don't depend on a logged-in Claude Code.
"""
from __future__ import annotations

import json
import os
import stat
import sys
import textwrap

import pytest

from flowboard.services import ai_chat


def _fake_cli(tmp_path, body: str) -> str:
    path = tmp_path / "claude"
    path.write_text(f"#!{sys.executable}\n" + textwrap.dedent(body))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


STREAMING = """
import json, sys
args = sys.argv[1:]
prompt = sys.stdin.read()
open(sys.argv[0] + ".args", "w").write(json.dumps({"args": args, "stdin": prompt}))
def out(o): print(json.dumps(o), flush=True)
out({"type": "system", "subtype": "init"})
for t in ["Xin ", "chào ", "Richard"]:
    out({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": t}}})
out({"type": "assistant", "message": {"content": [{"type": "text", "text": "Xin chào Richard"}]}})
out({"type": "result", "is_error": False, "result": "Xin chào Richard"})
"""

OLD_CLI = """
import json, sys
args = sys.argv[1:]
if "--include-partial-messages" in args:
    sys.stderr.write("error: unknown option '--include-partial-messages'\\n"); sys.exit(1)
prompt = sys.stdin.read()
open(sys.argv[0] + ".args", "w").write(json.dumps({"args": args, "stdin": prompt}))
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "Midnight Mesh"}]}}), flush=True)
print(json.dumps({"type": "result", "is_error": False, "result": "Midnight Mesh"}), flush=True)
"""


async def _collect(**kw):
    return [ev async for ev in ai_chat.stream_reply(**kw)]


@pytest.mark.asyncio
async def test_streams_partial_text_and_uses_sonnet(tmp_path, monkeypatch):
    cli = _fake_cli(tmp_path, STREAMING)
    monkeypatch.setattr(ai_chat, "resolve_cli_binary", lambda *a, **k: cli)
    evs = await _collect(messages=[{"role": "user", "content": "chào"}])
    text = "".join(e["text"] for e in evs if e["type"] == "delta")
    assert text == "Xin chào Richard"  # deltas only — the full message isn't repeated
    assert evs[-1]["type"] == "done"
    rec = json.loads(open(cli + ".args").read())
    assert rec["args"][rec["args"].index("--model") + 1] == "claude-sonnet-5-5"
    assert "--system-prompt-file" in rec["args"]
    assert "Bash" in rec["args"][rec["args"].index("--disallowedTools") + 1]
    assert rec["stdin"].strip().endswith("chào")


@pytest.mark.asyncio
async def test_older_cli_falls_back_without_new_flags(tmp_path, monkeypatch):
    cli = _fake_cli(tmp_path, OLD_CLI)
    monkeypatch.setattr(ai_chat, "resolve_cli_binary", lambda *a, **k: cli)
    evs = await _collect(messages=[{"role": "user", "content": "đặt tên"}])
    assert "".join(e["text"] for e in evs if e["type"] == "delta") == "Midnight Mesh"
    rec = json.loads(open(cli + ".args").read())
    # Instructions travel on stdin when the system-prompt flag can't be used.
    assert "Handora" in rec["stdin"]
    assert "--include-partial-messages" not in rec["args"]


@pytest.mark.asyncio
async def test_missing_cli_reports_error(monkeypatch):
    monkeypatch.setattr(ai_chat, "resolve_cli_binary", lambda *a, **k: "/nonexistent/claude")
    evs = await _collect(messages=[{"role": "user", "content": "hi"}])
    assert evs[-1]["type"] == "error"
    assert "Claude CLI" in evs[-1]["message"]


def test_transcript_keeps_history_and_context():
    t = ai_chat.build_transcript(
        [
            {"role": "user", "content": "câu 1"},
            {"role": "assistant", "content": "trả lời 1"},
            {"role": "user", "content": "câu 2"},
        ],
        "Node đang chọn: #cgyl",
    )
    assert "câu 1" in t and "trả lời 1" in t and t.endswith("câu 2")
    assert "#cgyl" in t


def test_route_streams_sse(client, tmp_path, monkeypatch):
    cli = _fake_cli(tmp_path, STREAMING)
    monkeypatch.setattr(ai_chat, "resolve_cli_binary", lambda *a, **k: cli)
    r = client.post("/api/ai-chat/stream", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 200
    events = [json.loads(l[6:]) for l in r.text.splitlines() if l.startswith("data: ")]
    assert [e["type"] for e in events][-1] == "done"
    assert "".join(e.get("text", "") for e in events) == "Xin chào Richard"
