"""Entry point.

    python -m flowboard_mcp                 stdio (Claude Desktop, Claude Code, Codex)
    python -m flowboard_mcp http            streamable HTTP on 127.0.0.1:8765, secret URL
                                            (ChatGPT / claude.ai through a tunnel)
    python -m flowboard_mcp public          HTTP + Cloudflare quick tunnel, prints the
                                            public connector URL (ChatGPT / claude.ai)
    python -m flowboard_mcp install         register in Claude Desktop, Claude Code, Codex
    python -m flowboard_mcp secret          print / rotate the HTTP secret
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent
ROOT = AGENT_DIR.parent
STORAGE = Path(os.getenv("FLOWBOARD_STORAGE", ROOT / "storage"))
SECRET_FILE = STORAGE / "mcp_secret.txt"


def load_secret(rotate: bool = False) -> str:
    env = os.getenv("FLOWBOARD_MCP_SECRET")
    if env and not rotate:
        return env.strip()
    if SECRET_FILE.is_file() and not rotate:
        val = SECRET_FILE.read_text(encoding="utf-8").strip()
        if len(val) >= 16:
            return val
    STORAGE.mkdir(parents=True, exist_ok=True)
    val = secrets.token_urlsafe(24)
    SECRET_FILE.write_text(val, encoding="utf-8")
    return val


class SecretGate:
    """Only lets through requests to /<secret>/mcp (or Authorization: Bearer
    <secret>). Everything else gets a plain 404 so a scanner learns nothing
    and MCP clients probing /.well-known/* fall back to "no OAuth"."""

    def __init__(self, app, secret: str) -> None:
        self.app = app
        self.secret = secret
        self.prefix = f"/{secret}"

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        if path == "/health":
            await self._send(send, 200, b'{"ok":true}')
            return
        if path.startswith(self.prefix + "/") and hmac.compare_digest(path[: len(self.prefix)], self.prefix):
            scope = dict(scope)
            scope["path"] = path[len(self.prefix):]
            raw = scope.get("raw_path")
            if isinstance(raw, (bytes, bytearray)) and raw.startswith(self.prefix.encode()):
                scope["raw_path"] = bytes(raw[len(self.prefix):])
            await self.app(scope, receive, send)
            return
        headers = {k.lower(): v for k, v in scope.get("headers", [])}
        auth = headers.get(b"authorization", b"").decode("latin-1")
        if auth.lower().startswith("bearer ") and hmac.compare_digest(auth[7:].strip(), self.secret):
            await self.app(scope, receive, send)
            return
        await self._send(send, 404, b'{"error":"not found"}')

    @staticmethod
    async def _send(send, status: int, body: bytes) -> None:
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": body})


def _build_app(host: str):
    from mcp.server.transport_security import TransportSecuritySettings

    from flowboard_mcp.server import mcp

    app = mcp.streamable_http_app(
        streamable_http_path="/mcp",
        host=host,
        # Requests arrive through a tunnel with a public Host header; the
        # secret path is the guard instead of DNS-rebinding host checks.
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    return SecretGate(app, load_secret())


def run_http(host: str, port: int) -> None:
    import uvicorn

    secret = load_secret()
    app = _build_app(host)
    print("=" * 66)
    print(" Flowboard MCP (HTTP) dang chay")
    print(f"   Local : http://{host}:{port}/{secret}/mcp")
    print("   Qua tunnel: https://<ten-tunnel>/" + secret + "/mcp")
    print("   Giu bi mat duong link nay: ai co link la dieu khien duoc Flowboard.")
    print("=" * 66, flush=True)
    uvicorn.run(app, host=host, port=port, log_level="warning")


def _find_cloudflared() -> str | None:
    found = shutil.which("cloudflared")
    if found:
        return found
    cands = [
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "cloudflared" / "cloudflared.exe",
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "cloudflared" / "cloudflared.exe",
        Path.home() / ".cloudflared" / "cloudflared.exe",
        Path.home() / "cloudflared.exe",
        ROOT / "tools" / "cloudflared.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Links" / "cloudflared.exe",
    ]
    return next((str(p) for p in cands if p.is_file()), None)


def _copy_to_clipboard(text: str) -> bool:
    try:
        if os.name == "nt":
            subprocess.run(["clip"], input=text.encode("utf-16le"), check=True)
            return True
    except Exception:  # noqa: BLE001
        pass
    return False


def run_public(port: int) -> None:
    import uvicorn

    secret = load_secret()
    cf = _find_cloudflared()
    if not cf:
        print("[LOI] Chua co cloudflared. Cai bang lenh (PowerShell):")
        print("      winget install --id Cloudflare.cloudflared")
        print("      roi dong cua so nay va chay lai.")
        sys.exit(1)

    server = uvicorn.Server(uvicorn.Config(_build_app("127.0.0.1"), host="127.0.0.1", port=port,
                                           log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.1)

    print("Dang mo tunnel Cloudflare (10-20 giay)...", flush=True)
    proc = subprocess.Popen([cf, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace")
    url_re = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
    shown = False
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            m = url_re.search(line)
            if m and not shown:
                shown = True
                full = f"{m.group(0)}/{secret}/mcp"
                copied = _copy_to_clipboard(full)
                try:
                    (STORAGE / "mcp_public_url.txt").write_text(full, encoding="utf-8")
                except OSError:
                    pass
                print()
                print("=" * 72)
                print(" LINK MCP CUA FLOWBOARD (dan vao ChatGPT / claude.ai -> Connector):")
                print()
                print("   " + full)
                print()
                if copied:
                    print(" (Da copy san vao clipboard.)")
                print(" Authentication: chon 'No authentication' / khong OAuth.")
                print(" Link doi moi lan chay lai. Giu bi mat: ai co link la dieu khien duoc app.")
                print(" Dong cua so nay = tat ket noi.")
                print("=" * 72, flush=True)
            elif "ERR" in line or "error" in line.lower():
                print("[cloudflared] " + line.rstrip(), flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        proc.terminate()
        server.should_exit = True


# ── installers ───────────────────────────────────────────────────────────


def _python_exe() -> str:
    exe = Path(sys.executable)
    if os.name == "nt" and exe.name.lower() == "pythonw.exe":
        exe = exe.with_name("python.exe")
    return str(exe)


def _server_entry() -> dict:
    return {
        "command": _python_exe(),
        "args": ["-m", "flowboard_mcp"],
        "env": {"PYTHONPATH": str(AGENT_DIR), "PYTHONIOENCODING": "utf-8"},
    }


def _claude_desktop_dirs() -> list[Path]:
    if sys.platform == "darwin":
        return [Path.home() / "Library" / "Application Support" / "Claude"]
    if os.name != "nt":
        return [Path.home() / ".config" / "Claude"]
    roaming = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "Claude"
    dirs = [roaming] if roaming.is_dir() else []
    # Microsoft Store / MSIX installs keep their AppData in a package sandbox.
    pkgs = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "Packages"
    if pkgs.is_dir():
        for p in pkgs.glob("*Claude*"):
            d = p / "LocalCache" / "Roaming" / "Claude"
            if d.is_dir():
                dirs.append(d)
    return dirs or [roaming]


def install_claude_desktop() -> str:
    msgs = []
    for base in _claude_desktop_dirs():
        cfg = base / "claude_desktop_config.json"
        data: dict = {}
        if cfg.is_file():
            text = cfg.read_text(encoding="utf-8").strip()
            if text:
                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    msgs.append(f"BO QUA Claude Desktop: {cfg} khong phai JSON hop le, sua tay roi chay lai.")
                    continue
            shutil.copy2(cfg, cfg.with_suffix(".json.bak"))
        base.mkdir(parents=True, exist_ok=True)
        data.setdefault("mcpServers", {})["flowboard"] = _server_entry()
        cfg.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        msgs.append(f"OK Claude Desktop: da ghi {cfg}")
    msgs.append("   -> Thoat han Claude Desktop (ca icon o khay he thong) roi mo lai.")
    return "\n".join(msgs)


def install_claude_code() -> str:
    """User-scope MCP servers live under "mcpServers" in ~/.claude.json."""
    cfg = Path.home() / ".claude.json"
    if not cfg.is_file() and not shutil.which("claude"):
        return "BO QUA Claude Code: chua cai Claude Code."
    data: dict = {}
    if cfg.is_file():
        try:
            data = json.loads(cfg.read_text(encoding="utf-8") or "{}")
        except json.JSONDecodeError:
            return f"BO QUA Claude Code: {cfg} khong phai JSON hop le."
        shutil.copy2(cfg, cfg.with_name(".claude.json.bak"))
    data.setdefault("mcpServers", {})["flowboard"] = {"type": "stdio", **_server_entry()}
    cfg.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return "OK Claude Code: da them MCP 'flowboard' (moi project)."


def install_codex() -> str:
    home = Path.home() / ".codex"
    if not home.is_dir():
        return "BO QUA Codex: khong thay thu muc ~/.codex."
    cfg = home / "config.toml"
    text = cfg.read_text(encoding="utf-8") if cfg.is_file() else ""
    if "[mcp_servers.flowboard]" in text:
        return "OK Codex: da co san [mcp_servers.flowboard]."
    entry = _server_entry()
    esc = lambda s: s.replace("\\", "\\\\").replace('"', '\\"')  # noqa: E731
    block = (
        "\n[mcp_servers.flowboard]\n"
        f'command = "{esc(entry["command"])}"\n'
        'args = ["-m", "flowboard_mcp"]\n'
        "tool_timeout_sec = 300\n"
        "[mcp_servers.flowboard.env]\n"
        f'PYTHONPATH = "{esc(entry["env"]["PYTHONPATH"])}"\n'
        'PYTHONIOENCODING = "utf-8"\n'
    )
    if cfg.is_file():
        shutil.copy2(cfg, cfg.with_suffix(".toml.bak"))
    cfg.write_text(text.rstrip() + "\n" + block, encoding="utf-8")
    return f"OK Codex: da them vao {cfg}."


def main() -> None:
    ap = argparse.ArgumentParser(prog="flowboard_mcp")
    sub = ap.add_subparsers(dest="cmd")
    p_http = sub.add_parser("http")
    p_http.add_argument("--host", default=os.getenv("FLOWBOARD_MCP_HOST", "127.0.0.1"))
    p_http.add_argument("--port", type=int, default=int(os.getenv("FLOWBOARD_MCP_PORT", "8765")))
    p_sec = sub.add_parser("secret")
    p_sec.add_argument("--rotate", action="store_true")
    p_pub = sub.add_parser("public")
    p_pub.add_argument("--port", type=int, default=int(os.getenv("FLOWBOARD_MCP_PORT", "8765")))
    sub.add_parser("install")
    sub.add_parser("stdio")
    args = ap.parse_args()

    if args.cmd == "http":
        run_http(args.host, args.port)
    elif args.cmd == "public":
        run_public(args.port)
    elif args.cmd == "secret":
        print(load_secret(rotate=args.rotate))
    elif args.cmd == "install":
        for fn in (install_claude_desktop, install_claude_code, install_codex):
            try:
                print(fn())
            except Exception as exc:  # noqa: BLE001
                print(f"LOI {fn.__name__}: {exc}")
    else:
        from flowboard_mcp.server import mcp

        mcp.run("stdio")


if __name__ == "__main__":
    main()
