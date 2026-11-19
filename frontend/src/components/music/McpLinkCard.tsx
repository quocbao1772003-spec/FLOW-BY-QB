import { useEffect, useState } from "react";
import { createToken, listTokens, revokeToken, type PersonalToken } from "../../api/team";
import { useSessionStore } from "../../store/session";
import { IconKey, IconRefresh, IconTrash } from "../../canvas/icons";
import "./music.css";

// "Link MCP của tôi" — the personal MCP link (fbt_ token) shown up front on
// the Tài khoản page. Tokens are stored hashed server-side, so the full
// link can only be shown right after it is created; afterwards we show the
// masked hint + when it was last used, and offer "Tạo link mới".

const WHERE = [
  ["flowytb", "Cài đặt › Kết nối AI › dán link"],
  ["claude.ai", "Settings › Connectors › Add custom connector"],
  ["ChatGPT", "Settings › Apps & Connectors › Create"],
] as const;

export function McpLinkCard() {
  const authRequired = useSessionStore((s) => s.authRequired);
  const [tokens, setTokens] = useState<PersonalToken[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
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

  const apis = tokens.filter((t) => t.kind === "api");
  const latest = apis[0];
  const link = fresh ? `${server}/mcp/${fresh}` : null;

  async function make() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await createToken("api", "MCP");
      setFresh(r.token);
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

  const usedText = (t: PersonalToken) =>
    t.last_used_at
      ? `dùng lần cuối ${new Date(t.last_used_at).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", hour12: false })}`
      : "chưa dùng";

  return (
    <section className="mcp-card">
      <div className="mcp-card__main">
        <h2 className="mcp-card__title">
          <IconKey size={16} /> Link MCP của tôi
        </h2>
        <p className="mcp-card__text">
          Dán link này vào công cụ AI để ra lệnh tạo ảnh, video và nhạc bằng chính tài khoản của bạn. Ai có link là
          dùng được credit của bạn — không gửi cho người khác.
        </p>
        <div className="mcp-card__link">
          <code>
            {link ? (
              link
            ) : latest ? (
              <>
                {server}/mcp/<b>{latest.hint}••••••••</b>
              </>
            ) : (
              "Chưa có link — bấm Tạo link MCP"
            )}
          </code>
          {link ? (
            <button type="button" className="page__cta" onClick={() => copy(link, "link")}>
              {copied === "link" ? "Đã copy" : "Copy link"}
            </button>
          ) : (
            <button type="button" className="page__cta" disabled={busy} onClick={() => void make()}>
              {latest ? "Tạo link mới" : "Tạo link MCP"}
            </button>
          )}
        </div>
        {link ? (
          <div className="mcp-card__note mcp-card__note--warn">
            Copy ngay — vì bảo mật, link chỉ hiện đủ 1 lần.{" "}
            <button type="button" className="mcp-card__inline" onClick={() => copy(`claude mcp add --transport http flowboard ${link}`, "cc")}>
              {copied === "cc" ? "Đã copy lệnh" : "Copy lệnh Claude Code"}
            </button>
          </div>
        ) : latest ? (
          <div className="mcp-card__note">
            Đang có {apis.length} link · link mới nhất {usedText(latest)}. Mất link thì tạo link mới rồi thu hồi link cũ.
          </div>
        ) : null}
        {apis.length > 0 && (
          <div className="mcp-card__tokens">
            {apis.map((t) => (
              <div key={t.id} className="mcp-card__token">
                <code>{t.hint}…</code>
                <span>{t.label || "MCP"}</span>
                <span className="mcp-card__used">{usedText(t)}</span>
                <button
                  type="button"
                  className="footer-btn mcp-card__revoke"
                  title="Thu hồi link này"
                  aria-label="Thu hồi"
                  onClick={() => void revokeToken(t.id).then(load)}
                >
                  <IconTrash size={13} />
                </button>
              </div>
            ))}
            {link && (
              <button type="button" className="accounts-btn" disabled={busy} onClick={() => void make()}>
                <IconRefresh size={13} /> Tạo thêm link
              </button>
            )}
          </div>
        )}
      </div>
      <div className="mcp-card__where">
        {WHERE.map(([name, how]) => (
          <div key={name} className="mcp-card__where-i">
            <b>{name}</b>
            <span>{how}</span>
          </div>
        ))}
        <span className="mcp-card__tools">Công cụ: tạo ảnh, video, nhạc · tách stems · xem credit</span>
      </div>
    </section>
  );
}
