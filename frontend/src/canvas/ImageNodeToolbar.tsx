import { useCallback, useState } from "react";
import { useBoardStore } from "../store/board";
import { mediaUrl, upscaleImage, upscaleImageLocal } from "../api/client";
import { useGenerationStore } from "../store/generation";
import { FullscreenImageViewer } from "../components/FullscreenImageViewer";
import { RunSplitButton } from "./SelectionToolbar";
import { IconSpinner } from "./icons";

/**
 * Magnific-style floating toolbar for Image / Image-Generator nodes.
 *
 * Rendered ABOVE the node when the node is selected. Contains 5
 * actions: Quick connections, Open preview, Edit image, Delete,
 * Download. Hover tooltips expose the keyboard shortcut where one
 * exists.
 *
 * Positioning: the toolbar sits in its own absolutely-positioned div
 * inside the node card so it scales / pans with the canvas
 * naturally. ReactFlow's transform on the wrapper carries it along
 * — no portal needed.
 */

interface Props {
  rfId: string;
  /** Has any media been generated / uploaded yet? Disables actions
   * that don't make sense on an empty node (download, preview). */
  hasMedia: boolean;
  /** Open the Image Editor modal. Wired by the parent NodeCard so the
   * modal state lives one level up (alongside other UI overlays). */
  onOpenEditor: () => void;
}

export function ImageNodeToolbar({
  rfId,
  hasMedia,
  onOpenEditor,
}: Props) {
  const deleteNodeByRfId = useBoardStore((s) => s.deleteNodeByRfId);
  const nodes = useBoardStore((s) => s.nodes);
  const node = nodes.find((n) => n.id === rfId);

  // Local state for our own fullscreen preview (zoom + pan). We use
  // this instead of Flowboard's built-in ResultViewer so we can control
  // zoom behaviour directly.
  const [previewOpen, setPreviewOpen] = useState(false);
  const activeMediaId =
    (node?.data && typeof (node.data as Record<string, unknown>).mediaId === "string"
      ? ((node.data as Record<string, unknown>).mediaId as string)
      : null) ||
    (Array.isArray((node?.data as Record<string, unknown> | undefined)?.mediaIds)
      ? (((node?.data as Record<string, unknown>).mediaIds as unknown[]).find(
          (m): m is string => typeof m === "string" && m.length > 0,
        ) ?? null)
      : null);

  // ── Action handlers ───────────────────────────────────────────────
  const handlePreview = useCallback(() => {
    if (!hasMedia || !activeMediaId) return;
    setPreviewOpen(true);
  }, [hasMedia, activeMediaId]);

  const handleDelete = useCallback(() => {
    void deleteNodeByRfId(rfId);
  }, [rfId, deleteNodeByRfId]);

  const [dlOpen, setDlOpen] = useState(false);
  const [upscaling, setUpscaling] = useState(false);

  function nameParts() {
    const data = (node?.data ?? {}) as Record<string, unknown>;
    const title =
      (typeof data.title === "string" && data.title) || (data.type as string);
    return {
      safe: title.replace(/[^A-Za-z0-9_-]+/g, "_"),
      shortId: (data.shortId as string) || rfId,
    };
  }

  // 1K = download every rendered variant as-is.
  const handleDownload1K = useCallback(() => {
    setDlOpen(false);
    if (!node?.data) return;
    const data = node.data as Record<string, unknown>;
    const ids = (
      (data.mediaIds as string[] | undefined) ||
      (typeof data.mediaId === "string" ? [data.mediaId] : [])
    ).filter((m): m is string => typeof m === "string" && m.length > 0);
    if (ids.length === 0) return;
    const { safe, shortId } = nameParts();
    const ext = data.type === "video" ? "mp4" : "png";
    ids.forEach((mid, i) => {
      const a = document.createElement("a");
      a.href = mediaUrl(mid);
      const suffix = ids.length > 1 ? `-${i + 1}` : "";
      a.download = `${safe}-${shortId}${suffix}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }, [rfId, node]);

  // 2K = upscale the active variant via Flow, then download the bytes.
  const handleDownload2K = useCallback(async () => {
    setDlOpen(false);
    if (!activeMediaId || upscaling) return;
    const projectId = await useGenerationStore.getState().ensureProjectId();
    if (!projectId) {
      useGenerationStore.setState({ error: "Flow project chưa sẵn sàng." });
      return;
    }
    setUpscaling(true);
    try {
      const blob = await upscaleImage(activeMediaId, projectId, "2K");
      const { safe, shortId } = nameParts();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safe}-${shortId}-2K.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      useGenerationStore.setState({
        error:
          err instanceof Error ? `Upscale 2K thất bại: ${err.message}` : "Upscale 2K thất bại",
      });
    } finally {
      setUpscaling(false);
    }
  }, [activeMediaId, upscaling, rfId, node]);

  // 2K (local AI) = Real-ESRGAN on the machine (Lanczos fallback). Faithful,
  // no Flow / no quota. See routes/upscale.py.
  const handleDownload2KLocal = useCallback(async () => {
    setDlOpen(false);
    if (!activeMediaId || upscaling) return;
    setUpscaling(true);
    try {
      const blob = await upscaleImageLocal(activeMediaId, "2K");
      const { safe, shortId } = nameParts();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safe}-${shortId}-2K-ai.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      useGenerationStore.setState({
        error:
          err instanceof Error ? `Làm nét 2K thất bại: ${err.message}` : "Làm nét 2K thất bại",
      });
    } finally {
      setUpscaling(false);
    }
  }, [activeMediaId, upscaling, rfId, node]);

  return (
    <>
    {previewOpen && activeMediaId && (
      <FullscreenImageViewer
        mediaId={activeMediaId}
        title={(node?.data as Record<string, unknown> | undefined)?.title as string | undefined}
        onClose={() => setPreviewOpen(false)}
      />
    )}
    <div
      className="image-node-toolbar nodrag nowheel"
      style={{
        position: "absolute",
        top: -50,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 5,
        display: "flex",
        gap: 2,
        padding: 4,
        background: "rgba(21, 23, 28, 0.96)",
        border: "1px solid #2a2e38",
        borderRadius: 10,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        backdropFilter: "blur(8px)",
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <RunSplitButton rfId={rfId} />
      <ToolbarButton
        title="Open preview (A)"
        disabled={!hasMedia}
        onClick={handlePreview}
      >
        <SvgExpand />
      </ToolbarButton>
      <ToolbarButton
        title="Edit image"
        disabled={!hasMedia}
        onClick={onOpenEditor}
      >
        <SvgEdit />
      </ToolbarButton>
      <ToolbarButton
        title="Delete (Backspace)"
        onClick={handleDelete}
        danger
      >
        <SvgTrash />
      </ToolbarButton>
      <span style={{ position: "relative", display: "inline-flex" }}>
        <ToolbarButton
          title="Download (1K / 2K)"
          disabled={!hasMedia || upscaling}
          onClick={() => setDlOpen((o) => !o)}
        >
          {upscaling ? <IconSpinner size={13} /> : <SvgDownload />}
        </ToolbarButton>
        {dlOpen && !upscaling && (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              right: 0,
              background: "var(--surface-1, #1a1a1a)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 10,
              padding: 5,
              boxShadow: "0 10px 28px rgba(0,0,0,0.5)",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              whiteSpace: "nowrap",
              zIndex: 6,
            }}
          >
            <button
              type="button"
              className="image-node-toolbar__menu-item"
              onClick={handleDownload1K}
            >
              Tải 1K (gốc)
            </button>
            <button
              type="button"
              className="image-node-toolbar__menu-item"
              onClick={() => void handleDownload2KLocal()}
            >
              Tải 2K (làm nét AI · local)
            </button>
            <button
              type="button"
              className="image-node-toolbar__menu-item"
              onClick={() => void handleDownload2K()}
            >
              Tải 2K (Flow · nâng cấp)
            </button>
          </div>
        )}
      </span>
    </div>
    </>
  );
}

// ── Button + Icon primitives ────────────────────────────────────────

function ToolbarButton({
  title,
  onClick,
  children,
  disabled,
  danger,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 30,
        height: 30,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        color: disabled ? "#3a3f4a" : danger ? "#e4e7ec" : "#c9cdd6",
        border: "none",
        borderRadius: 6,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.1s, color 0.1s",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = danger
          ? "rgba(239, 68, 68, 0.15)"
          : "#2a2e38";
        if (danger) e.currentTarget.style.color = "#ef4444";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = disabled
          ? "#3a3f4a"
          : danger
            ? "#e4e7ec"
            : "#c9cdd6";
      }}
    >
      {children}
    </button>
  );
}

// Inline SVGs — sharper than unicode glyphs at this size and they
// inherit currentColor so the hover styling above just works.

function SvgExpand() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 3h-6" />
      <path d="M21 3v6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21h6" />
      <path d="M3 21v-6" />
      <path d="M3 21l7-7" />
    </svg>
  );
}

function SvgEdit() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21l3.6-1 11-11a2.5 2.5 0 0 0-3.5-3.5l-11 11L2 21" />
      <path d="M14 5l4 4" />
      <circle cx="18" cy="6" r="2.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SvgTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6v-2a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function SvgDownload() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}
