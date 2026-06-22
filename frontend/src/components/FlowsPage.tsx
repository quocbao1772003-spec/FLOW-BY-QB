import { useRef, useState } from "react";
import { useBoardStore } from "../store/board";
import { useViewStore } from "../store/view";
import { IconPlus, IconTrash, IconDownload, IconUpload } from "../canvas/icons";
import { downloadFlow, importFlow } from "../lib/flowIO";

// "Flows" page — Magnific Spaces-style gallery of boards. Click a card
// to open that flow on the canvas; + New flow creates one.

function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

export function FlowsPage() {
  const boards = useBoardStore((s) => s.boards);
  const boardId = useBoardStore((s) => s.boardId);
  const switchBoard = useBoardStore((s) => s.switchBoard);
  const createNewBoard = useBoardStore((s) => s.createNewBoard);
  const deleteBoardById = useBoardStore((s) => s.deleteBoardById);
  const setView = useViewStore((s) => s.setView);
  const refreshBoardList = useBoardStore((s) => s.refreshBoardList);
  const [busy, setBusy] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  async function openFlow(id: number) {
    if (id !== boardId) await switchBoard(id);
    setView("canvas");
  }

  async function handleImport(file: File) {
    if (busy) return;
    setBusy(true);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const newId = await importFlow(json);
      await refreshBoardList();
      await switchBoard(newId);
      setView("canvas");
    } catch (err) {
      window.alert(
        err instanceof Error ? `Nhập flow thất bại: ${err.message}` : "Nhập flow thất bại",
      );
    } finally {
      setBusy(false);
    }
  }

  async function newFlow() {
    if (busy) return;
    setBusy(true);
    try {
      await createNewBoard("Untitled");
      setView("canvas");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Flows</h1>
          <p className="page__subtitle">
            Build node-based generative workflows and bring your ideas to life.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          <button
            type="button"
            className="footer-tab"
            onClick={() => importInputRef.current?.click()}
            disabled={busy}
            title="Nhập flow từ file .flow.json"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px" }}
          >
            <IconUpload size={13} /> Import
          </button>
          <button type="button" className="page__cta" onClick={() => void newFlow()} disabled={busy}>
            <IconPlus size={13} /> New flow
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImport(f);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      <div className="flows-grid">
        {boards.map((b) => (
          <div
            key={b.id}
            className={`flow-card${b.id === boardId ? " flow-card--active" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => void openFlow(b.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void openFlow(b.id);
            }}
          >
            <div className="flow-card__thumb" aria-hidden="true">
              <span className="flow-card__thumb-glyph">⌬</span>
            </div>
            <div className="flow-card__meta">
              <span className="flow-card__name">{b.name || "Untitled"}</span>
              <span className="flow-card__date">{formatDate(b.created_at)}</span>
            </div>
            <div className="flow-card__actions">
              <button
                type="button"
                className="flow-card__action"
                onClick={(e) => {
                  e.stopPropagation();
                  void downloadFlow(b.id).catch((err) =>
                    window.alert(
                      err instanceof Error ? `Xuất flow thất bại: ${err.message}` : "Xuất flow thất bại",
                    ),
                  );
                }}
                title="Xuất flow ra file JSON để chia sẻ"
                aria-label={`Export ${b.name}`}
              >
                <IconDownload size={12} />
              </button>
              <button
                type="button"
                className="flow-card__action flow-card__action--danger"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Delete flow "${b.name}"? This cannot be undone.`)) {
                    void deleteBoardById(b.id);
                  }
                }}
                title="Delete flow"
                aria-label={`Delete ${b.name}`}
              >
                <IconTrash size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
