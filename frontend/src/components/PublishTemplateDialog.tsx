import { useEffect, useState } from "react";
import {
  deleteTemplate,
  publishTemplate,
  templateOfBoard,
  updateTemplate,
  type FlowTemplate,
} from "../api/team";
import { create } from "zustand";

// "Đưa vào thư viện" — publish a flow as a shared template, or update /
// remove the template this flow already published. Opened from the Flows
// gallery and from the canvas toolbar.

interface PublishState {
  board: { id: number; name: string } | null;
  open(board: { id: number; name: string }): void;
  close(): void;
}

export const usePublishDialog = create<PublishState>((set) => ({
  board: null,
  open: (board) => set({ board }),
  close: () => set({ board: null }),
}));

export function PublishTemplateDialog() {
  const board = usePublishDialog((s) => s.board);
  const close = usePublishDialog((s) => s.close);
  const [existing, setExisting] = useState<FlowTemplate | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!board) return;
    setExisting(undefined);
    setMsg(null);
    setName(board.name);
    setDesc("");
    templateOfBoard(board.id)
      .then((r) => {
        setExisting(r.template);
        if (r.template) {
          setName(r.template.name);
          setDesc(r.template.description);
        }
      })
      .catch(() => setExisting(null));
  }, [board]);

  if (!board) return null;

  async function run(fn: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(done);
      const r = await templateOfBoard(board!.id);
      setExisting(r.template);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const canEdit = !existing || existing.can_edit;

  return (
    <div className="tpl-dialog__backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="tpl-dialog" role="dialog" aria-label="Đưa vào thư viện mẫu">
        <h2 className="tpl-dialog__title">{existing ? "Mẫu trong thư viện" : "Đưa vào thư viện mẫu"}</h2>
        <p className="tpl-dialog__sub">
          {existing
            ? "Flow này đã có mẫu trong thư viện. Bản trong thư viện đứng yên, chỉ đổi khi bấm Cập nhật."
            : "Thư viện lưu một bản chụp của flow lúc này. Ai bấm Use sẽ có bản sao riêng, sửa thoải mái không ảnh hưởng mẫu hay người khác."}
        </p>
        <label className="tpl-dialog__label" htmlFor="tpl-name">Tên mẫu</label>
        <input id="tpl-name" className="tpl-dialog__input" value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
        <label className="tpl-dialog__label" htmlFor="tpl-desc">Mô tả ngắn</label>
        <textarea
          id="tpl-desc"
          className="tpl-dialog__input tpl-dialog__textarea"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Dùng để làm gì, cần ảnh tham chiếu gì…"
          disabled={!canEdit}
        />
        {existing && (
          <p className="tpl-dialog__meta">
            {existing.node_count} node · {existing.use_count} lượt dùng · cập nhật{" "}
            {new Date(existing.updated_at).toLocaleString("vi-VN", { hour12: false })}
          </p>
        )}
        {msg && <p className="tpl-dialog__msg">{msg}</p>}
        <div className="tpl-dialog__actions">
          {existing === undefined ? null : existing ? (
            <>
              {existing.can_edit && (
                <button
                  type="button"
                  className="accounts-btn accounts-btn--danger"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Gỡ mẫu "${existing.name}" khỏi thư viện? Các bản sao đã dùng vẫn giữ nguyên.`)) {
                      void run(() => deleteTemplate(existing.id), "Đã gỡ khỏi thư viện");
                    }
                  }}
                >
                  Gỡ khỏi thư viện
                </button>
              )}
              <span className="tpl-dialog__spacer" />
              <button type="button" className="accounts-btn" onClick={close}>Đóng</button>
              {existing.can_edit && (
                <button
                  type="button"
                  className="page__cta"
                  disabled={busy || !name.trim()}
                  onClick={() =>
                    void run(
                      () => updateTemplate(existing.id, { name, description: desc, refresh_from_board: true }),
                      "Đã cập nhật mẫu theo flow hiện tại",
                    )
                  }
                >
                  Cập nhật mẫu
                </button>
              )}
            </>
          ) : (
            <>
              <span className="tpl-dialog__spacer" />
              <button type="button" className="accounts-btn" onClick={close}>Huỷ</button>
              <button
                type="button"
                className="page__cta"
                disabled={busy || !name.trim()}
                onClick={() =>
                  void run(() => publishTemplate({ board_id: board.id, name, description: desc }), "Đã đưa vào thư viện")
                }
              >
                Đưa vào thư viện
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
