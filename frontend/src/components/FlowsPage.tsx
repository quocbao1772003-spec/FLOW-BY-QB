import { useEffect, useRef, useState } from "react";
import { useBoardStore } from "../store/board";
import { useViewStore } from "../store/view";
import { IconPlus, IconTrash, IconDownload, IconUpload } from "../canvas/icons";
import { downloadFlow, importFlow } from "../lib/flowIO";
import { listBoards, mediaUrl, type Board } from "../api/client";
import { usePublishDialog } from "./PublishTemplateDialog";
import { useSessionStore } from "../store/session";

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
  const openPublish = usePublishDialog((s) => s.open);
  const user = useSessionStore((s) => s.user);
  const isAdmin = user?.role === "admin";
  const [showAll, setShowAll] = useState(false);
  const [everyone, setEveryone] = useState<Board[] | null>(null);

  // Refresh list (covers) when the page opens; admins may view every flow.
  useEffect(() => {
    void refreshBoardList();
  }, [refreshBoardList]);
  useEffect(() => {
    if (!showAll) return;
    void listBoards(true).then(setEveryone).catch(() => setEveryone(null));
  }, [showAll, boards]);
  const shown: Board[] = showAll && everyone ? everyone : boards;

  async function openFlow(id: number) {
    if (id !== boardId) await switchBoard(id);
    setView("canvas");
  }

  async function handleImport(file: File) {
    if (busy) return;
    setBusy(true);
    try {
      if (/\.zip$/i.test(file.name)) {
        // Whole local Flowboard (XUAT-FLOW.bat): flows + images, owned by me.
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/flows/import-zip", { method: "POST", body: fd });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`);
        const got = (body.boards ?? []) as { id: number; name: string }[];
        await refreshBoardList();
        window.alert(`Đã nhập ${got.length} flow và ${body.media_added ?? 0} ảnh:\n` + got.map((b) => "• " + b.name).join("\n"));
        return;
      }
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
          {isAdmin && (
            <button
              type="button"
              className={`footer-tab${showAll ? " footer-tab--active" : ""}`}
              onClick={() => setShowAll((v) => !v)}
              title="Xem flow của mọi nhân viên"
              style={{ padding: "8px 14px" }}
            >
              {showAll ? "Tất cả nhân viên" : "Của tôi"}
            </button>
          )}
          <button
            type="button"
            className="footer-tab"
            onClick={() => importInputRef.current?.click()}
            disabled={busy}
            title="Nhập flow: file .flow.json, hoặc flowboard-export.zip (XUAT-FLOW.bat từ app trên máy)"
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
            accept="application/json,.json,application/zip,.zip"
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
        {shown.map((b) => (
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
              {b.cover_media_id ? (
                <img className="flow-card__cover" src={mediaUrl(b.cover_media_id)} alt="" loading="lazy" draggable={false} />
              ) : (
                <span className="flow-card__thumb-glyph">⌬</span>
              )}
            </div>
            <div className="flow-card__meta">
              <span className="flow-card__name">{b.name || "Untitled"}</span>
              <span className="flow-card__date">
                {showAll && b.owner_name ? `${b.owner_name} · ` : ""}
                {formatDate(b.created_at)}
              </span>
            </div>
            <div className="flow-card__actions">
              <button
                type="button"
                className="flow-card__action"
                onClick={(e) => {
                  e.stopPropagation();
                  openPublish({ id: b.id, name: b.name || "Untitled" });
                }}
                title="Đưa vào thư viện mẫu"
                aria-label={`Publish ${b.name}`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3l9 5-9 5-9-5 9-5z" />
                  <path d="M3 13l9 5 9-5" />
                </svg>
              </button>
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
