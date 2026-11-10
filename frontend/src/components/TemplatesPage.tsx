import { useEffect, useState } from "react";
import { mediaUrl } from "../api/client";
import { deleteTemplate, listTemplates, useTemplate, type FlowTemplate } from "../api/team";
import { IconRefresh } from "../canvas/icons";
import { useBoardStore } from "../store/board";
import { useViewStore } from "../store/view";

// Shared template library. "Use" makes the clicker their own copy of the
// flow — later edits never touch the template or anyone else's copy.

export function TemplatesPage() {
  const [items, setItems] = useState<FlowTemplate[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshBoardList = useBoardStore((s) => s.refreshBoardList);
  const switchBoard = useBoardStore((s) => s.switchBoard);
  const setView = useViewStore((s) => s.setView);

  async function load() {
    try {
      setItems(await listTemplates(q.trim() || undefined));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function use(t: FlowTemplate) {
    if (busy) return;
    setBusy(t.id);
    try {
      const r = await useTemplate(t.id);
      await refreshBoardList();
      await switchBoard(r.board.id);
      setView("canvas");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(t: FlowTemplate) {
    if (!window.confirm(`Gỡ mẫu "${t.name}" khỏi thư viện? Các bản sao đã dùng vẫn giữ nguyên.`)) return;
    try {
      await deleteTemplate(t.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Thư viện mẫu</h1>
          <p className="page__subtitle">
            Flow mẫu dùng chung cả team. Bấm Use để có bản riêng của mình. Đưa flow vào đây bằng nút Đưa vào thư
            viện ở trang Flows hoặc trên thanh công cụ.
          </p>
        </div>
        <div className="templates-tools">
          <input className="templates-search" placeholder="Tìm mẫu…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="button" className="footer-btn" onClick={() => void load()} title="Làm mới" aria-label="Làm mới">
            <IconRefresh size={13} />
          </button>
        </div>
      </div>

      {error && <p className="page__empty">✗ {error}</p>}
      {items !== null && items.length === 0 && !error && (
        <p className="page__empty">
          {q ? "Không có mẫu nào khớp." : "Thư viện chưa có mẫu. Mở một flow và bấm Đưa vào thư viện."}
        </p>
      )}

      <div className="flows-grid">
        {(items ?? []).map((t) => (
          <div key={t.id} className="tpl-card">
            <div className="tpl-card__thumb">
              {t.cover_media_id ? (
                <img src={mediaUrl(t.cover_media_id)} alt="" loading="lazy" draggable={false} />
              ) : (
                <span className="flow-card__thumb-glyph">⌬</span>
              )}
              <span className="tpl-card__count">{t.node_count} node</span>
            </div>
            <div className="tpl-card__body">
              <span className="tpl-card__name" title={t.name}>{t.name}</span>
              <span className="tpl-card__desc" title={t.description}>{t.description || "Không có mô tả"}</span>
              <span className="tpl-card__meta">
                {t.author ? `${t.author} · ` : ""}
                {t.use_count} lượt dùng
              </span>
            </div>
            <div className="tpl-card__actions">
              <button type="button" className="page__cta tpl-card__use" disabled={busy !== null} onClick={() => void use(t)}>
                {busy === t.id ? "Đang tạo…" : "Use"}
              </button>
              {t.can_edit && (
                <button type="button" className="accounts-btn" onClick={() => void remove(t)} title="Gỡ khỏi thư viện">
                  Gỡ
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
