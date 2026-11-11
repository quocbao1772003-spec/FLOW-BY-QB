import { useEffect, useState } from "react";
import { createToken, listTokens, revokeToken, type PersonalToken } from "../api/team";
import { useSessionStore } from "../store/session";

// "Kết nối Chrome": pairing codes that tie a Chrome profile (with the
// Flowboard Bridge extension) to the signed-in Flowboard user, plus API
// tokens for MCP. Only shown when Flowboard user accounts are on.

export function ChromePairing() {
  const authRequired = useSessionStore((s) => s.authRequired);
  const [tokens, setTokens] = useState<PersonalToken[]>([]);
  const [fresh, setFresh] = useState<{ token: string; kind: string } | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const server = window.location.origin;

  async function load() {
    try {
      setTokens(await listTokens());
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (authRequired) void load();
  }, [authRequired]);

  if (!authRequired) return null;

  async function make(kind: "bridge" | "api") {
    if (busy) return;
    setBusy(true);
    try {
      const r = await createToken(kind, label || (kind === "bridge" ? "Chrome" : "MCP"));
      setFresh({ token: r.token, kind });
      setLabel("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string, key: string) {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  const bridges = tokens.filter((t) => t.kind === "bridge");
  const apis = tokens.filter((t) => t.kind === "api");

  return (
    <>
      <div className="accounts-section__head">
        <h2 className="accounts-section__title">Kết nối Chrome</h2>
      </div>
      <div className="pair-box">
        <p className="pair-box__text">
          Mỗi Chrome profile cần một mã ghép nối để biết nó thuộc về anh chị. Trong popup của extension Flowboard
          Bridge, điền <b>Server</b> và <b>Mã ghép nối</b> rồi bấm Lưu và kết nối.
        </p>
        <div className="pair-box__row">
          <span className="pair-box__label">Server</span>
          <button type="button" className="accounts-path" onClick={() => copy(server, "server")}>
            <span>{server}</span>
            <em>{copied === "server" ? "Đã copy" : "Copy"}</em>
          </button>
        </div>
        <div className="pair-box__row">
          <span className="pair-box__label">Mã mới</span>
          <input
            className="pair-box__input"
            placeholder="Ghi chú, ví dụ: Chrome máy văn phòng"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button type="button" className="page__cta" disabled={busy} onClick={() => void make("bridge")}>
            Tạo mã ghép nối
          </button>
          <button type="button" className="accounts-btn" disabled={busy} onClick={() => void make("api")}>
            Tạo link MCP
          </button>
        </div>
        {fresh && fresh.kind === "bridge" && (
          <div className="team-secret">
            <span>
              Mã ghép nối: <code>{fresh.token}</code>
            </span>
            <span className="team-secret__note">Chỉ hiện một lần.</span>
            <button type="button" className="accounts-btn" onClick={() => copy(fresh.token, "fresh")}>
              {copied === "fresh" ? "Đã copy" : "Copy"}
            </button>
            <button type="button" className="accounts-btn" onClick={() => setFresh(null)}>Đóng</button>
          </div>
        )}
        {fresh && fresh.kind === "api" && (
          <div className="team-secret mcp-link">
            <span className="mcp-link__row">
              Link MCP: <code>{`${server}/mcp/${fresh.token}`}</code>
            </span>
            <span className="team-secret__note">
              Chỉ hiện một lần. Giữ như mật khẩu: ai có link là điều khiển được Flowboard dưới tên anh chị.
            </span>
            <button type="button" className="page__cta" onClick={() => copy(`${server}/mcp/${fresh.token}`, "mcp")}>
              {copied === "mcp" ? "✓ Đã copy" : "Copy link MCP"}
            </button>
            <button
              type="button"
              className="accounts-btn"
              onClick={() => copy(`claude mcp add --transport http flowboard ${server}/mcp/${fresh.token}`, "cc")}
            >
              {copied === "cc" ? "✓ Đã copy" : "Copy lệnh Claude Code"}
            </button>
            <button type="button" className="accounts-btn" onClick={() => setFresh(null)}>Đóng</button>
            <ol className="mcp-link__how">
              <li>
                <b>claude.ai / Claude Desktop:</b> Settings → Connectors → Add custom connector, đặt tên{" "}
                <code>Flowboard</code>, dán link MCP, bấm Add.
              </li>
              <li>
                <b>Claude Code:</b> dán lệnh Claude Code vào terminal, chạy một lần.
              </li>
              <li>
                <b>ChatGPT:</b> Settings → Apps &amp; Connectors → Create, dán link MCP, chọn No authentication.
              </li>
              <li>Mất link hoặc lộ link: bấm Thu hồi ở dòng MCP bên dưới, rồi tạo token mới.</li>
            </ol>
          </div>
        )}
        {(bridges.length > 0 || apis.length > 0) && (
          <div className="pair-list">
            {[...bridges, ...apis].map((t) => (
              <div key={t.id} className="pair-list__row">
                <span className="account-tag">{t.kind === "bridge" ? "Chrome" : "MCP"}</span>
                <span className="pair-list__label">{t.label || "Không tên"}</span>
                <code className="pair-list__hint">{t.hint}…</code>
                <span className="pair-list__used">
                  {t.last_used_at
                    ? `Dùng lần cuối ${new Date(t.last_used_at).toLocaleString("vi-VN", { hour12: false })}`
                    : "Chưa dùng"}
                </span>
                <button
                  type="button"
                  className="accounts-btn accounts-btn--danger"
                  onClick={() => void revokeToken(t.id).then(load)}
                >
                  Thu hồi
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
