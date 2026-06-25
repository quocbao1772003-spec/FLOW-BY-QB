import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnConnectStartParams,
  type OnNodeDrag,
} from "@xyflow/react";

import { useBoardStore, type FlowNode, type NodeType } from "../store/board";
import { NodeCard } from "./NodeCard";
import { VariantEdge } from "./VariantEdge";
import { AssistantNodeCard } from "./AssistantNodeCard";
import { GroupNodeCard } from "./GroupNode";
import {
  SelectionToolbar,
  groupSelectedNodes,
  duplicateSelectedNodes,
} from "./SelectionToolbar";
import { LeftToolbar } from "./LeftToolbar";
import { FooterControls } from "./FooterControls";
import { NodeTypeIcon, IconSpinner } from "./icons";
import { useGenerationStore } from "../store/generation";
import {
  createEdge,
  createNode,
  ensureBoardProject,
  uploadImage,
} from "../api/client";

const nodeTypes = {
  character: NodeCard,
  image: NodeCard,
  video: NodeCard,
  prompt: NodeCard,
  note: NodeCard,
  visual_asset: NodeCard,
  Storyboard: NodeCard,
  assistant: AssistantNodeCard,
  group: GroupNodeCard,
};

const edgeTypes = {
  default: VariantEdge,
};

const defaultEdgeOptions = {
  // Spec: default bezier path #b1b1b7 (see ui/design_system.md §2.6),
  // dashed per user preference; selected/hover/running overrides live
  // in styles.css.
  style: {
    stroke: "var(--edge-path)",
    strokeWidth: 1.6,
    strokeDasharray: "7 5",
    cursor: "pointer",
  },
  interactionWidth: 24,
};

// Project-id cache (drag-drop upload optimisation from previous iteration)
const projectIdCache = new Map<number, string>();
const inflightProjectFetch = new Map<number, Promise<string>>();

async function getProjectIdFor(boardId: number): Promise<string> {
  const cached = projectIdCache.get(boardId);
  if (cached) return cached;
  const pending = inflightProjectFetch.get(boardId);
  if (pending) return pending;
  const p = ensureBoardProject(boardId)
    .then((proj) => {
      projectIdCache.set(boardId, proj.flow_project_id);
      inflightProjectFetch.delete(boardId);
      return proj.flow_project_id;
    })
    .catch((err) => {
      inflightProjectFetch.delete(boardId);
      throw err;
    });
  inflightProjectFetch.set(boardId, p);
  return p;
}

// ── Clipboard for copy/paste ─────────────────────────────────────────────
// Module-level so paste from a subsequent Board mount (e.g. after a
// project switch) still works. Lives in memory only — page reload clears it.
interface ClipboardPayload {
  nodes: Array<{
    oldId: string;
    type: string;
    x: number;
    y: number;
    data: Record<string, unknown>;
  }>;
  edges: Array<{
    oldSourceId: string;
    oldTargetId: string;
    // `kind` is OPTIONAL — the backend stamps a sensible default when
    // we omit it. We only forward it if the original edge carried a
    // non-default kind (we read it from a few possible spots since the
    // exact ReactFlow ↔ store mapping varies across edge variants).
    kind?: string;
    sourceVariantIdx: number | null;
  }>;
}
let internalClipboard: ClipboardPayload | null = null;

type InteractionMode = "hand" | "select";

function DropAddPopover({
  popover,
  onPick,
  onClose,
}: {
  popover: { clientX: number; clientY: number; sourceId: string } | null;
  onPick: (type: NodeType, flowPos: { x: number; y: number }) => void;
  onClose: () => void;
}) {
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    if (!popover) return;
    const t = window.setTimeout(onClose, 3000);
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onOutside = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && !t.closest(".drop-popover")) onClose();
    };
    document.addEventListener("keydown", onEsc);
    document.addEventListener("mousedown", onOutside);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onEsc);
      document.removeEventListener("mousedown", onOutside);
    };
  }, [popover, onClose]);

  if (!popover) return null;

  const handle = (type: NodeType) => {
    const flowPos = screenToFlowPosition({ x: popover.clientX, y: popover.clientY });
    onPick(type, flowPos);
  };

  return (
    <div
      className="drop-popover"
      style={{ left: popover.clientX + 8, top: popover.clientY + 8 }}
      role="menu"
      aria-label="Add connected node"
    >
      <button type="button" className="drop-popover__btn" onClick={() => handle("image")}>
        <span className="drop-popover__icon">▣</span> Image
      </button>
      <button type="button" className="drop-popover__btn" onClick={() => handle("video")}>
        <span className="drop-popover__icon">▶</span> Video
      </button>
    </div>
  );
}

function UploadProgressOverlay({
  uploads,
}: {
  uploads: Array<{ id: string; x: number; y: number; filename: string; done: boolean; error?: string }>;
}) {
  if (uploads.length === 0) return null;
  return (
    <>
      {uploads.map((u) => (
        <div
          key={u.id}
          style={{
            position: "absolute",
            left: u.x,
            top: u.y,
            transform: "translate(-50%, -50%)",
            zIndex: 1000,
            pointerEvents: "none",
            background: u.error ? "rgba(180, 50, 50, 0.92)" : "rgba(40, 44, 52, 0.92)",
            color: "#fff",
            padding: "8px 14px",
            borderRadius: 8,
            fontSize: 12,
            fontFamily: "system-ui, sans-serif",
            border: `1px solid ${u.error ? "#ff6b6b" : "#5db97a"}`,
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            whiteSpace: "nowrap",
            maxWidth: 240,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {u.error ? (
            `✗ ${u.error}`
          ) : u.done ? (
            `✓ ${u.filename}`
          ) : (
            <>
              <IconSpinner size={12} /> Uploading {u.filename}…
            </>
          )}
        </div>
      ))}
    </>
  );
}

// The interaction-mode toggle now lives in <LeftToolbar> (canvas/
// LeftToolbar.tsx) along with Add + Group — Magnific-style floating
// toolbar anchored to the canvas's left edge.

// ─────────────────────────────────────────────────────────────────────
// Right-click context menu (Magnific-style)
// ─────────────────────────────────────────────────────────────────────
// Right-clicking the empty canvas opens this menu instead of Chrome's
// default. Search box at top, sections of node types below, keyboard
// nav (↑↓ + Enter), and Esc / outside-click to dismiss.

interface CtxMenuItem {
  section: "BASICS" | "MEDIA";
  icon: string;
  label: string;
  type: NodeType;
  // Optional hint used for search matching (e.g. shortcut letter).
  hint?: string;
  // Per-module accent (ui/design_system.md §1.4) — colors the icon tile.
  accent: string;
}

const CTX_MENU_ITEMS: CtxMenuItem[] = [
  // BASICS — node types the user creates regularly.
  { section: "BASICS", icon: "✦", label: "Text", type: "prompt", hint: "T", accent: "#9c82e5" },
  { section: "BASICS", icon: "▣", label: "Image Generator", type: "image", hint: "I", accent: "#6f8bf7" },
  { section: "BASICS", icon: "▶", label: "Video Generator", type: "video", hint: "V", accent: "#3cd39f" },
  {
    section: "BASICS",
    icon: "✨",
    label: "Assistant",
    type: "assistant" as NodeType,
    hint: "A",
    accent: "#9c82e5",
  },
  // MEDIA — upload becomes a visual_asset which has the in-card
  // file picker / link-paste UI.
  { section: "MEDIA", icon: "◇", label: "Upload", type: "visual_asset", hint: "U", accent: "#fafafa" },
];

function CtxMenu({
  pos,
  onPick,
  onClose,
}: {
  pos: { clientX: number; clientY: number };
  onPick: (type: NodeType) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter against case-insensitive label substring.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return CTX_MENU_ITEMS;
    return CTX_MENU_ITEMS.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        i.type.toLowerCase().includes(q) ||
        i.hint?.toLowerCase() === q,
    );
  }, [search]);

  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, activeIdx]);

  // Auto-focus the search input when the menu mounts.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Position with clamp — keep the menu inside the viewport.
  const MENU_W = 270;
  const MENU_H = 420;
  const left = Math.min(pos.clientX, window.innerWidth - MENU_W - 8);
  const top = Math.min(pos.clientY, window.innerHeight - MENU_H - 8);

  // Dismiss on click outside (capture phase to beat ReactFlow's
  // stopPropagation pattern).
  useEffect(() => {
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest(".flowboard-ctx-menu")) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % Math.max(1, filtered.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx(
          (i) => (i - 1 + filtered.length) % Math.max(1, filtered.length),
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const pick = filtered[activeIdx];
        if (pick) onPick(pick.type);
      }
    },
    [filtered, activeIdx, onClose, onPick],
  );

  // Group filtered items by section for the rendered list.
  const basics = filtered.filter((i) => i.section === "BASICS");
  const media = filtered.filter((i) => i.section === "MEDIA");

  let runningIdx = 0;
  const renderRow = (item: CtxMenuItem) => {
    const myIdx = runningIdx++;
    const active = activeIdx === myIdx;
    return (
      <button
        key={`${item.section}-${item.label}`}
        type="button"
        onClick={() => onPick(item.type)}
        onMouseEnter={() => setActiveIdx(myIdx)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          padding: "8px 12px",
          borderRadius: 8,
          background: active ? "rgba(255, 255, 255, 0.06)" : "transparent",
          border: "none",
          color: "var(--fg-1, #e3e3e3)",
          fontSize: 13,
          cursor: "pointer",
          textAlign: "left",
          fontFamily: "inherit",
          transition: "background 0.08s",
        }}
      >
        {/* Icon tile — per-module accent on a 10% tint, Magnific-style */}
        <span
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            background: `${item.accent}1a`,
            color: item.accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          <NodeTypeIcon type={item.type} size={13} />
        </span>
        <span style={{ flex: 1, fontWeight: 500 }}>{item.label}</span>
      </button>
    );
  };

  return createPortal(
    <div
      className="flowboard-ctx-menu"
      role="menu"
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 2147483647,
        width: MENU_W,
        maxHeight: MENU_H,
        background: "var(--surface-1, #1a1a1a)",
        border: "1px solid rgba(255, 255, 255, 0.1)",
        borderRadius: 16,
        boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
        padding: "0 6px 6px",
        overflowY: "auto",
        fontFamily: "inherit",
        color: "var(--fg-1, #e3e3e3)",
        display: "flex",
        flexDirection: "column",
      }}
      onKeyDown={onKeyDown}
    >
      {/* Search — borderless row with a hairline divider, Magnific-style */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 12px",
          marginBottom: 4,
          borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
        }}
      >
        <span style={{ color: "var(--fg-4, #737373)", fontSize: 14 }}>⌕</span>
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search"
          className="nodrag"
          style={{
            flex: 1,
            minWidth: 0,
            background: "transparent",
            color: "var(--fg-0, #f5f5f5)",
            border: "none",
            outline: "none",
            fontSize: 13,
            fontFamily: "inherit",
          }}
        />
      </div>

      {basics.length > 0 && (
        <>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: 1.2,
              color: "var(--fg-4, #737373)",
              padding: "10px 12px 4px",
            }}
          >
            BASICS
          </div>
          {basics.map(renderRow)}
        </>
      )}
      {media.length > 0 && (
        <>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: 1.2,
              color: "var(--fg-4, #737373)",
              padding: "10px 12px 4px",
            }}
          >
            MEDIA
          </div>
          {media.map(renderRow)}
        </>
      )}
      {filtered.length === 0 && (
        <div
          style={{
            padding: "16px 12px",
            color: "#5a5f69",
            fontSize: 12,
            textAlign: "center",
          }}
        >
          No matches for "{search}"
        </div>
      )}

      {/* Footer hint row */}
      <div
        style={{
          marginTop: 6,
          padding: "8px 12px 6px",
          borderTop: "1px solid rgba(255, 255, 255, 0.08)",
          fontSize: 10,
          color: "var(--fg-4, #737373)",
          display: "flex",
          gap: 14,
        }}
      >
        <span>↑↓ Navigate</span>
        <span>↩ Insert</span>
        <span>Esc Close</span>
      </div>
    </div>,
    document.body,
  );
}

export function Board() {
  const nodes = useBoardStore((s) => s.nodes);
  const edges = useBoardStore((s) => s.edges);
  const setNodes = useBoardStore((s) => s.setNodes);
  const setEdges = useBoardStore((s) => s.setEdges);
  const persistNodePosition = useBoardStore((s) => s.persistNodePosition);
  const addEdgeFromConnection = useBoardStore((s) => s.addEdgeFromConnection);
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);
  const deleteNodeByRfId = useBoardStore((s) => s.deleteNodeByRfId);
  const deleteEdgeByRfId = useBoardStore((s) => s.deleteEdgeByRfId);
  const { screenToFlowPosition, fitView, zoomTo } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Footer minimap toggle (FooterControls).
  const [showMiniMap, setShowMiniMap] = useState(true);
  // Space-held temporary pan: remembers the mode to restore on keyup.
  const spaceModeRef = useRef<InteractionMode | null>(null);

  const [dropPopover, setDropPopover] = useState<
    { clientX: number; clientY: number; sourceId: string } | null
  >(null);
  const connectStateRef = useRef<{ sourceId: string | null; didConnect: boolean }>({
    sourceId: null,
    didConnect: false,
  });
  const [activeUploads, setActiveUploads] = useState<
    Array<{ id: string; x: number; y: number; filename: string; done: boolean; error?: string }>
  >([]);
  // Floating toast for paste / copy feedback — disappears after ~1.5s.
  const [paneToast, setPaneToast] = useState<{ text: string; tone: "info" | "success" | "error" } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const showToast = useCallback(
    (text: string, tone: "info" | "success" | "error" = "info", ttl = 1500) => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      setPaneToast({ text, tone });
      toastTimerRef.current = window.setTimeout(() => setPaneToast(null), ttl);
    },
    [],
  );
  // IDs of nodes that were just pasted — used to fire a brief "flash"
  // animation on them so the user can spot the duplicates without
  // hunting the canvas. Cleared 1.2s after the paste.
  const [pastedFlashIds, setPastedFlashIds] = useState<Set<string>>(new Set());
  // Last known mouse position (screen coords). Tracked globally so
  // Ctrl+V can drop the clones AT the cursor instead of at original+48.
  // Stays in a ref so updates don't trigger re-renders.
  const lastMousePosRef = useRef<{ clientX: number; clientY: number } | null>(null);

  // Right-click context menu state. Stores the screen coords of the
  // right-click event so the menu can render at the cursor; null means
  // closed.
  const [ctxMenu, setCtxMenu] = useState<
    { clientX: number; clientY: number } | null
  >(null);

  const handleCtxPick = useCallback(
    async (type: NodeType) => {
      if (!ctxMenu) return;
      const flowPos = screenToFlowPosition({
        x: ctxMenu.clientX,
        y: ctxMenu.clientY,
      });
      setCtxMenu(null);
      await addNodeOfType(type, flowPos);
    },
    [ctxMenu, screenToFlowPosition, addNodeOfType],
  );
  // Interaction mode — controls whether canvas drag pans the view or
  // draws a selection box. Persisted to localStorage so the user's
  // preference survives reloads.
  const [interactionMode, setInteractionModeState] = useState<InteractionMode>(() => {
    try {
      const saved = localStorage.getItem("flowboard:interactionMode");
      return saved === "select" ? "select" : "hand";
    } catch {
      return "hand";
    }
  });
  const setInteractionMode = useCallback((m: InteractionMode) => {
    setInteractionModeState(m);
    try {
      localStorage.setItem("flowboard:interactionMode", m);
    } catch {
      /* ignore */
    }
  }, []);

  // ── Drag-and-drop image upload (from earlier feature) ────────────────
  const onCanvasDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-flowboard-reference")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      return;
    }
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  // Shared upload pipeline: upload image File[]s and drop a visual_asset
  // node per file at the given screen point. Used by drag-drop AND
  // clipboard paste (Ctrl+V).
  const uploadImagesAt = useCallback(
    async (imageFiles: File[], clientX: number, clientY: number) => {
      const boardId = useBoardStore.getState().boardId;
      if (boardId === null) return;
      const baseFlowPos = screenToFlowPosition({ x: clientX, y: clientY });
      const uploadIds = imageFiles.map(
        (_, i) => `paste-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
      );
      setActiveUploads((prev) => [
        ...prev,
        ...imageFiles.map((f, i) => ({
          id: uploadIds[i],
          x: clientX,
          y: clientY + i * 28,
          filename: f.name || "Pasted image",
          done: false,
        })),
      ]);
      const flowProjectId = await getProjectIdFor(boardId).catch(() => null);
      if (!flowProjectId) {
        setActiveUploads((prev) =>
          prev.map((u) =>
            uploadIds.includes(u.id) ? { ...u, done: true, error: "No Flow project" } : u,
          ),
        );
        window.setTimeout(() => {
          setActiveUploads((prev) => prev.filter((u) => !uploadIds.includes(u.id)));
        }, 2000);
        return;
      }
      await Promise.all(
        imageFiles.map(async (file, i) => {
          const uploadId = uploadIds[i];
          const pos = { x: baseFlowPos.x + i * 40, y: baseFlowPos.y + i * 40 };
          try {
            const uploaded = await uploadImage(file, flowProjectId);
            await useBoardStore.getState().addReferenceNode(
              {
                mediaId: uploaded.media_id,
                aiBrief: null,
                aspectRatio: uploaded.aspect_ratio ?? null,
                kind: "visual_asset",
                label: (file.name || "Pasted image").replace(/\.[^/.]+$/, ""),
              },
              pos,
            );
            setActiveUploads((prev) =>
              prev.map((u) => (u.id === uploadId ? { ...u, done: true } : u)),
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setActiveUploads((prev) =>
              prev.map((u) =>
                u.id === uploadId ? { ...u, done: true, error: msg.slice(0, 60) } : u,
              ),
            );
          } finally {
            window.setTimeout(() => {
              setActiveUploads((prev) => prev.filter((u) => u.id !== uploadId));
            }, 1200);
          }
        }),
      );
    },
    [screenToFlowPosition],
  );

  // Paste the in-app node clipboard at the cursor. Extracted from the
  // old keydown handler so it can be called from the `paste` event AFTER
  // checking the OS clipboard for an image (image takes priority — a node
  // copied earlier no longer hijacks Ctrl+V of an external image).
  const pasteInternalNodes = useCallback(async () => {
    if (!internalClipboard || internalClipboard.nodes.length === 0) return;
    const boardId = useBoardStore.getState().boardId;
    if (boardId === null) return;
    const clipSnap = internalClipboard;

    let targetFlow: { x: number; y: number };
    if (lastMousePosRef.current) {
      targetFlow = screenToFlowPosition({
        x: lastMousePosRef.current.clientX,
        y: lastMousePosRef.current.clientY,
      });
    } else {
      targetFlow = { x: clipSnap.nodes[0].x + 48, y: clipSnap.nodes[0].y + 48 };
    }
    const avgX = clipSnap.nodes.reduce((s, n) => s + n.x, 0) / clipSnap.nodes.length;
    const avgY = clipSnap.nodes.reduce((s, n) => s + n.y, 0) / clipSnap.nodes.length;

    showToast(`Pasting ${clipSnap.nodes.length} node(s)...`, "info", 8000);

    const nodeResults = await Promise.allSettled(
      clipSnap.nodes.map((n) => {
        const dataCopy: Record<string, unknown> = { ...n.data };
        delete dataCopy.shortId;
        return createNode({
          board_id: boardId,
          type: n.type as NodeType,
          x: targetFlow.x + (n.x - avgX),
          y: targetFlow.y + (n.y - avgY),
          data: dataCopy,
        }).then((created) => ({ oldId: n.oldId, created }));
      }),
    );

    const idMap = new Map<string, number>();
    const newFlowNodes: FlowNode[] = [];
    const failedNodes: string[] = [];
    for (const r of nodeResults) {
      if (r.status === "fulfilled") {
        const { oldId, created } = r.value;
        idMap.set(oldId, created.id);
        newFlowNodes.push({
          id: String(created.id),
          type: created.type as unknown as string,
          position: { x: created.x, y: created.y },
          data: {
            ...(created.data as Record<string, unknown>),
            type: created.type,
            shortId: created.short_id,
            status: created.status,
          },
          selected: false,
        } as unknown as FlowNode);
      } else {
        failedNodes.push(String(r.reason));
        console.error("[paste] createNode failed:", r.reason);
      }
    }

    const edgePayloads = clipSnap.edges
      .map((edge) => {
        const newSrc = idMap.get(edge.oldSourceId);
        const newDst = idMap.get(edge.oldTargetId);
        if (newSrc === undefined || newDst === undefined) return null;
        return { newSrc, newDst, kind: edge.kind, vIdx: edge.sourceVariantIdx };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const edgeResults = await Promise.allSettled(
      edgePayloads.map((p) => {
        const payload: Parameters<typeof createEdge>[0] = {
          board_id: boardId,
          source_id: p.newSrc,
          target_id: p.newDst,
          source_variant_idx: p.vIdx,
        };
        if (p.kind && p.kind !== "default") payload.kind = p.kind;
        return createEdge(payload);
      }),
    );
    const newFlowEdges: Array<{
      id: string;
      source: string;
      target: string;
      type: string;
      data: { sourceVariantIdx: number | null };
    }> = [];
    let failedEdges = 0;
    for (const r of edgeResults) {
      if (r.status === "fulfilled") {
        const ed = r.value;
        newFlowEdges.push({
          id: String(ed.id),
          source: String(ed.source_id),
          target: String(ed.target_id),
          type: "default",
          data: { sourceVariantIdx: ed.source_variant_idx },
        });
      } else {
        failedEdges += 1;
        console.error("[paste] createEdge failed:", r.reason);
      }
    }

    const currentNodes = useBoardStore.getState().nodes;
    const currentEdges = useBoardStore.getState().edges;
    setNodes([...currentNodes, ...newFlowNodes]);
    setEdges([...currentEdges, ...(newFlowEdges as unknown as typeof currentEdges)]);

    const flashIds = new Set(newFlowNodes.map((n) => n.id));
    setPastedFlashIds(flashIds);
    window.setTimeout(() => setPastedFlashIds(new Set()), 1200);

    const okN = newFlowNodes.length;
    const okE = newFlowEdges.length;
    if (failedNodes.length === 0 && failedEdges === 0) {
      showToast(`✓ Pasted ${okN} node${okN !== 1 ? "s" : ""}` + (okE ? ` + ${okE} edge${okE !== 1 ? "s" : ""}` : ""), "success");
    } else {
      showToast(
        `Pasted ${okN} of ${clipSnap.nodes.length} (${failedNodes.length} node + ${failedEdges} edge errors — see console)`,
        "error",
        3000,
      );
    }
  }, [screenToFlowPosition, setNodes, setEdges]);

  const onCanvasDrop = useCallback(
    async (e: React.DragEvent) => {
      const raw = e.dataTransfer.getData("application/x-flowboard-reference");
      if (raw) {
        e.preventDefault();
        e.stopPropagation();
        try {
          const ref = JSON.parse(raw) as {
            mediaId: string;
            aiBrief?: string | null;
            aspectRatio?: string | null;
            kind: string;
            label: string;
          };
          const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
          void useBoardStore.getState().addReferenceNode(ref, flowPos);
        } catch (err) {
          console.warn("Failed to parse reference drop payload", err);
        }
        return;
      }

      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length === 0) return;
      const imageFiles = files.filter((f) => f.type.startsWith("image/"));
      if (imageFiles.length === 0) {
        console.warn("Drop ignored — no image files in payload");
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const boardId = useBoardStore.getState().boardId;
      if (boardId === null) {
        console.warn("Drop ignored — no active board");
        return;
      }

      const dropClientX = e.clientX;
      const dropClientY = e.clientY;
      const baseFlowPos = screenToFlowPosition({ x: dropClientX, y: dropClientY });
      const projectPromise = getProjectIdFor(boardId);

      const uploadIds = imageFiles.map(
        (_, i) => `upload-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
      );
      const overlayEntries = imageFiles.map((f, i) => ({
        id: uploadIds[i],
        x: dropClientX,
        y: dropClientY + i * 28,
        filename: f.name,
        done: false,
      }));
      setActiveUploads((prev) => [...prev, ...overlayEntries]);

      const flowProjectId = await projectPromise.catch((err) => {
        console.error("Could not ensure Flow project for upload", err);
        setActiveUploads((prev) =>
          prev.map((u) =>
            uploadIds.includes(u.id) ? { ...u, done: true, error: "No Flow project" } : u,
          ),
        );
        window.setTimeout(() => {
          setActiveUploads((prev) => prev.filter((u) => !uploadIds.includes(u.id)));
        }, 2000);
        return null;
      });
      if (!flowProjectId) return;

      await Promise.all(
        imageFiles.map(async (file, i) => {
          const uploadId = uploadIds[i];
          const pos = { x: baseFlowPos.x + i * 40, y: baseFlowPos.y + i * 40 };
          try {
            const uploaded = await uploadImage(file, flowProjectId);
            await useBoardStore.getState().addReferenceNode(
              {
                mediaId: uploaded.media_id,
                aiBrief: null,
                aspectRatio: uploaded.aspect_ratio ?? null,
                kind: "visual_asset",
                label: file.name.replace(/\.[^/.]+$/, "") || "Uploaded image",
              },
              pos,
            );
            setActiveUploads((prev) =>
              prev.map((u) => (u.id === uploadId ? { ...u, done: true } : u)),
            );
          } catch (err) {
            console.error(`Upload failed for ${file.name}`, err);
            const msg = err instanceof Error ? err.message : String(err);
            setActiveUploads((prev) =>
              prev.map((u) =>
                u.id === uploadId ? { ...u, done: true, error: msg.slice(0, 60) } : u,
              ),
            );
          } finally {
            window.setTimeout(() => {
              setActiveUploads((prev) => prev.filter((u) => u.id !== uploadId));
            }, 1200);
          }
        }),
      );
    },
    [screenToFlowPosition],
  );

  // ── Core ReactFlow handlers ─────────────────────────────────────────
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const c of changes) {
        if (c.type === "remove") {
          void deleteNodeByRfId(c.id);
        }
      }
      setNodes(applyNodeChanges(changes, useBoardStore.getState().nodes) as FlowNode[]);
    },
    [setNodes, deleteNodeByRfId],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const c of changes) {
        if (c.type === "remove") {
          void deleteEdgeByRfId(c.id);
        }
      }
      setEdges(applyEdgeChanges(changes, useBoardStore.getState().edges));
    },
    [setEdges, deleteEdgeByRfId],
  );

  // ── Group-frame drag: moving a "group" node carries its members ──────
  // On drag start we snapshot every member's position + the frame's own
  // start; during drag we apply the frame's delta to all members; on stop
  // we persist everything in one pass.
  const groupDragRef = useRef<{
    frameStart: { x: number; y: number };
    members: Map<string, { x: number; y: number }>;
  } | null>(null);

  // Pre-drag position snapshot of every node, so Ctrl+Z can restore where
  // things were before a drag (covers single, multi-select and group drags).
  const moveStartRef = useRef<Map<string, { x: number; y: number }> | null>(
    null,
  );

  const onNodeDragStart: OnNodeDrag<FlowNode> = useCallback((_event, node) => {
    const snap = new Map<string, { x: number; y: number }>();
    for (const n of useBoardStore.getState().nodes) {
      snap.set(n.id, { x: n.position.x, y: n.position.y });
    }
    moveStartRef.current = snap;
    if (node.data.type !== "group") return;
    const members = new Map<string, { x: number; y: number }>();
    for (const n of useBoardStore.getState().nodes) {
      if (n.data.groupId === node.id) {
        members.set(n.id, { x: n.position.x, y: n.position.y });
      }
    }
    groupDragRef.current = {
      frameStart: { x: node.position.x, y: node.position.y },
      members,
    };
  }, []);

  const onNodeDrag: OnNodeDrag<FlowNode> = useCallback((_event, node) => {
    const st = groupDragRef.current;
    if (!st || node.data.type !== "group") return;
    const dx = node.position.x - st.frameStart.x;
    const dy = node.position.y - st.frameStart.y;
    useBoardStore.setState((s) => ({
      nodes: s.nodes.map((n) => {
        const start = st.members.get(n.id);
        return start
          ? { ...n, position: { x: start.x + dx, y: start.y + dy } }
          : n;
      }),
    }));
  }, []);

  const onNodeDragStop: OnNodeDrag<FlowNode> = useCallback(
    (_event, node) => {
      persistNodePosition(node.id, node.position);
      const st = groupDragRef.current;
      if (st && node.data.type === "group") {
        for (const n of useBoardStore.getState().nodes) {
          if (st.members.has(n.id)) {
            persistNodePosition(n.id, n.position);
          }
        }
      }
      groupDragRef.current = null;

      // Record the move for Ctrl+Z: any node that actually shifted from its
      // pre-drag position, stored with its *start* coords so undo restores it.
      const start = moveStartRef.current;
      moveStartRef.current = null;
      if (start) {
        const moves: { rfId: string; x: number; y: number }[] = [];
        for (const n of useBoardStore.getState().nodes) {
          const s = start.get(n.id);
          if (s && (s.x !== n.position.x || s.y !== n.position.y)) {
            moves.push({ rfId: n.id, x: s.x, y: s.y });
          }
        }
        if (moves.length > 0) useBoardStore.getState().recordNodeMoves(moves);
      }
    },
    [persistNodePosition],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        addEdgeFromConnection(
          connection.source,
          connection.target,
          connection.targetHandle,
        );
        connectStateRef.current.didConnect = true;
      }
    },
    [addEdgeFromConnection],
  );

  const onConnectStart = useCallback(
    (_event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      if (params.handleType !== "source" || !params.nodeId) {
        connectStateRef.current = { sourceId: null, didConnect: false };
        return;
      }
      connectStateRef.current = { sourceId: params.nodeId, didConnect: false };
    },
    [],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const { sourceId, didConnect } = connectStateRef.current;
      connectStateRef.current = { sourceId: null, didConnect: false };
      if (!sourceId || didConnect) return;
      const e = event as MouseEvent;
      const cx = typeof e.clientX === "number" ? e.clientX : 0;
      const cy = typeof e.clientY === "number" ? e.clientY : 0;
      setDropPopover({ clientX: cx, clientY: cy, sourceId });
    },
    [],
  );

  const handlePickAdd = useCallback(
    async (type: NodeType, flowPos: { x: number; y: number }) => {
      const sourceId = dropPopover?.sourceId;
      setDropPopover(null);
      if (!sourceId) return;
      const newId = await addNodeOfType(type, flowPos);
      if (newId) {
        await addEdgeFromConnection(sourceId, newId);
      }
    },
    [dropPopover, addNodeOfType, addEdgeFromConnection],
  );

  const onNodesDelete = useCallback(
    (deletedNodes: FlowNode[]) => {
      if (deletedNodes.length === 0) return;
      // Group into one undo step so a single Ctrl+Z restores them all.
      void useBoardStore.getState().runUndoBatch("delete nodes", async () => {
        for (const n of deletedNodes) await deleteNodeByRfId(n.id);
      });
    },
    [deleteNodeByRfId],
  );

  const onEdgesDelete = useCallback(
    (deletedEdges: { id: string }[]) => {
      deletedEdges.forEach((e) => deleteEdgeByRfId(e.id));
    },
    [deleteEdgeByRfId],
  );

  const onNodeDoubleClick = useCallback(
    (event: React.MouseEvent, node: FlowNode) => {
      const target = event.target as HTMLElement | null;
      // Double-click on the inline prompt (display or editor) only edits
      // text — native word-select, no popup.
      if (
        target?.closest(".node-genprompt") ||
        target?.closest(".node-genprompt-editor") ||
        target?.closest(".node-genfooter")
      ) {
        return;
      }
      // Only the MEDIA area opens the viewer — double-clicking empty
      // card chrome does nothing.
      const onMedia =
        target?.closest(".thumbnail-grid") ||
        target?.closest(".video-grid") ||
        target?.closest(".visual-asset__media") ||
        target?.closest(".character-avatar");
      const isGenerable = [
        "image",
        "prompt",
        "video",
        "visual_asset",
        "character",
        "Storyboard",
      ].includes(node.data.type);
      if (!isGenerable) return;
      const s = useGenerationStore.getState();
      if (node.data.mediaId) {
        if (!onMedia) return;
        s.openResultViewer(node.id);
      } else {
        // No media yet — keep the old behavior (open the gen dialog)
        // unless the user was interacting with the prompt/footer.
        s.openGenerationDialog(node.id, node.data.prompt ?? "");
      }
    },
    [],
  );

  // Track mouse position globally so paste can drop at the cursor.
  // We attach to the wrapper specifically — anywhere outside the canvas
  // (sidebars, toolbar) shouldn't be a paste target anyway.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      lastMousePosRef.current = { clientX: e.clientX, clientY: e.clientY };
    };
    el.addEventListener("mousemove", onMove);
    return () => el.removeEventListener("mousemove", onMove);
  }, []);

  // ── Clipboard paste (Ctrl+V) — single source of truth ───────────────
  // Priority: an IMAGE in the OS clipboard (from a website / screenshot /
  // file) → uploaded as a node. Otherwise → paste the in-app node
  // clipboard. This ordering means a node copied earlier no longer
  // hijacks Ctrl+V when the user just copied an external image.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const active = document.activeElement;
      const tag = (active?.tagName ?? "").toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return; // let the field handle paste (text)
      }
      const items = e.clipboardData?.items;
      const files: File[] = [];
      if (items) {
        for (const it of items) {
          if (it.kind === "file" && it.type.startsWith("image/")) {
            const f = it.getAsFile();
            if (f) files.push(f);
          }
        }
      }
      if (files.length > 0) {
        // External image wins.
        e.preventDefault();
        const pos = lastMousePosRef.current ?? {
          clientX: window.innerWidth / 2,
          clientY: window.innerHeight / 2,
        };
        void uploadImagesAt(files, pos.clientX, pos.clientY);
        return;
      }
      // No image → paste the in-app node clipboard (if any).
      if (internalClipboard && internalClipboard.nodes.length > 0) {
        e.preventDefault();
        void pasteInternalNodes();
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [uploadImagesAt, pasteInternalNodes]);

  // ── Keyboard: g (open generation dialog) + V/H (mode toggle) +
  //              Ctrl+C / Ctrl+V (copy / paste selection) ──────────────
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const isEditableTarget = () => {
      const active = document.activeElement;
      const tag = (active?.tagName ?? "").toLowerCase();
      return (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (active instanceof HTMLElement && active.isContentEditable)
      );
    };

    const onKeyDown = async (e: KeyboardEvent) => {
      if (isEditableTarget()) return;
      const key = e.key.toLowerCase();
      const isMod = e.ctrlKey || e.metaKey;

      // ── Mode toggles — V = select, H = hand. Single-key, no modifier.
      if (!isMod && !e.altKey && !e.shiftKey) {
        if (key === "v") {
          // Note: V is the standard hotkey for Select tool in Figma/Canva.
          // Don't intercept Ctrl+V here — that's paste, handled below.
          e.preventDefault();
          setInteractionMode("select");
          return;
        }
        if (key === "h") {
          e.preventDefault();
          setInteractionMode("hand");
          return;
        }
      }

      // ── G — Group selection (spec §8) when 2+ nodes are selected;
      // falls back to the legacy behavior (open gen dialog / viewer)
      // for a single selected node.
      if (!isMod && !e.altKey && !e.shiftKey && key === "g") {
        const groupable = useBoardStore
          .getState()
          .nodes.filter((n) => n.selected && n.data.type !== "group");
        if (groupable.length >= 2) {
          e.preventDefault();
          void groupSelectedNodes();
          return;
        }
        const selectedNodes = useBoardStore
          .getState()
          .nodes.filter(
            (n) =>
              n.selected &&
              ["image", "prompt", "video", "character", "Storyboard"].includes(n.data.type),
          );
        if (selectedNodes.length === 0) return;
        e.preventDefault();
        const target = selectedNodes[0];
        const s = useGenerationStore.getState();
        if (target.data.mediaId) {
          s.openResultViewer(target.id);
        } else {
          s.openGenerationDialog(target.id, target.data.prompt ?? "");
        }
        return;
      }

      // ── F — zoom to fit · 0 — reset zoom to 100% (spec §8)
      if (!isMod && !e.altKey && !e.shiftKey && key === "f") {
        e.preventDefault();
        void fitView({ duration: 200, padding: 0.15 });
        return;
      }
      if (!isMod && !e.altKey && !e.shiftKey && key === "0") {
        e.preventDefault();
        void zoomTo(1, { duration: 200 });
        return;
      }

      // ── Ctrl/Cmd+D — duplicate selection (spec §8)
      if (isMod && key === "d") {
        e.preventDefault();
        void duplicateSelectedNodes();
        return;
      }

      // ── Space (hold) — temporary hand/pan mode (spec §8). Restored
      // on keyup below.
      if (!isMod && key === " " && !e.repeat) {
        e.preventDefault();
        if (spaceModeRef.current === null) {
          spaceModeRef.current = interactionMode;
          setInteractionMode("hand");
        }
        return;
      }

      // ── Ctrl/Cmd+Z — undo the last structural edit (move, add, delete,
      // connect/disconnect). Typing inside a node's prompt is left to the
      // browser's native textarea undo (isEditableTarget bails out above).
      if (isMod && key === "z" && !e.shiftKey) {
        e.preventDefault();
        void useBoardStore.getState().undo();
        return;
      }

      // ── Ctrl+C — copy selected nodes + edges to internal clipboard
      if (isMod && key === "c") {
        // If the user has highlighted text (e.g. in an Assistant's Result
        // panel), let the browser copy that text instead of the node.
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) return;
        const state = useBoardStore.getState();
        const selectedNodes = state.nodes.filter((n) => n.selected);
        if (selectedNodes.length === 0) return; // let browser handle (text copy)

        e.preventDefault();
        const selectedIds = new Set(selectedNodes.map((n) => n.id));
        const internalEdges = state.edges.filter(
          (edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target),
        );

        internalClipboard = {
          nodes: selectedNodes.map((n) => ({
            oldId: n.id,
            type: (n.data.type as string) ?? n.type ?? "image",
            x: n.position.x,
            y: n.position.y,
            data: { ...(n.data as Record<string, unknown>) },
          })),
          edges: internalEdges.map((edge) => {
            // Pull kind from anywhere it might live — different parts of
            // the Flowboard store hydrate this differently. If we can't
            // find one, leave `kind` UNDEFINED so the backend stamps its
            // own default (the previous version hard-coded "default"
            // which the agent rejected → that was the source of the
            // "3 edge errors" toast.)
            const ed = edge as unknown as {
              source: string;
              target: string;
              type?: string;
              kind?: string;
              data?: { sourceVariantIdx?: number | null; kind?: string };
            };
            const resolvedKind =
              ed.data?.kind || ed.kind || (ed.type && ed.type !== "default" ? ed.type : undefined);
            return {
              oldSourceId: ed.source,
              oldTargetId: ed.target,
              kind: resolvedKind,
              sourceVariantIdx: ed.data?.sourceVariantIdx ?? null,
            };
          }),
        };
        showToast(
          `Copied ${internalClipboard.nodes.length} node${internalClipboard.nodes.length !== 1 ? "s" : ""}` +
            (internalClipboard.edges.length > 0
              ? ` + ${internalClipboard.edges.length} edge${internalClipboard.edges.length !== 1 ? "s" : ""}`
              : ""),
          "info",
        );
        return;
      }

      // ── Ctrl+V — handled by the `paste` event listener instead (so the
      // OS clipboard image takes priority over a previously-copied node).
      // Intentionally NOT handled here: we must NOT preventDefault on
      // keydown, or the browser cancels the paste event and external
      // image paste stops working.
      if (false && isMod && key === "v") {
        if (!internalClipboard || internalClipboard.nodes.length === 0) return;

        e.preventDefault();
        const boardId = useBoardStore.getState().boardId;
        if (boardId === null) {
          console.warn("[paste] no active board");
          return;
        }

        const clipSnap = internalClipboard;

        // ── Compute target paste position ─────────────────────────────
        // We want the centroid of the pasted group to land AT the
        // cursor (or near the canvas center if we never tracked a
        // mouse move). Each node then gets offset from that centroid
        // by the same relative vector it had from the original group's
        // centroid → relative positions preserved.
        let targetFlow: { x: number; y: number };
        if (lastMousePosRef.current) {
          targetFlow = screenToFlowPosition({
            x: lastMousePosRef.current.clientX,
            y: lastMousePosRef.current.clientY,
          });
        } else {
          // Fallback: original position + small offset (old behaviour).
          targetFlow = {
            x: clipSnap.nodes[0].x + 48,
            y: clipSnap.nodes[0].y + 48,
          };
        }
        const avgX =
          clipSnap.nodes.reduce((s, n) => s + n.x, 0) / clipSnap.nodes.length;
        const avgY =
          clipSnap.nodes.reduce((s, n) => s + n.y, 0) / clipSnap.nodes.length;

        showToast(`Pasting ${clipSnap.nodes.length} node(s)...`, "info", 8000);

        // 1) Create cloned nodes in PARALLEL — each node lands at
        // (cursor + its offset from the source centroid).
        const nodeResults = await Promise.allSettled(
          clipSnap.nodes.map((n) => {
            const dataCopy: Record<string, unknown> = { ...n.data };
            delete dataCopy.shortId;
            return createNode({
              board_id: boardId,
              type: n.type as NodeType,
              x: targetFlow.x + (n.x - avgX),
              y: targetFlow.y + (n.y - avgY),
              data: dataCopy,
            }).then((created) => ({ oldId: n.oldId, created }));
          }),
        );

        const idMap = new Map<string, number>();
        // Built incrementally so we can also assemble the FlowNode array
        // for the local store push, no second mapping pass.
        const newFlowNodes: FlowNode[] = [];
        const failedNodes: string[] = [];
        for (const r of nodeResults) {
          if (r.status === "fulfilled") {
            const { oldId, created } = r.value;
            idMap.set(oldId, created.id);
            // Construct the FlowNode shape matching what ReactFlow +
            // Flowboard's store expects. Mirrors the structure produced
            // by addReferenceNode on the store side: id is the string of
            // the DB id, data carries type / shortId / status alongside
            // whatever the backend persisted.
            const fn = {
              id: String(created.id),
              type: created.type as unknown as string,
              position: { x: created.x, y: created.y },
              data: {
                ...(created.data as Record<string, unknown>),
                type: created.type,
                shortId: created.short_id,
                status: created.status,
              },
              // Don't auto-select the new clones — leaves the original
              // selection intact so the user can immediately Ctrl+V
              // again if they want a third copy.
              selected: false,
            } as unknown as FlowNode;
            newFlowNodes.push(fn);
          } else {
            failedNodes.push(String(r.reason));
            console.error("[paste] createNode failed:", r.reason);
          }
        }

        // 2) Edges in PARALLEL — depend on idMap from step 1.
        // Only forward `kind` when we actually captured one in the
        // copy step; passing through "default" was what made the
        // backend reject every edge in the previous version.
        const edgePayloads = clipSnap.edges
          .map((edge) => {
            const newSrc = idMap.get(edge.oldSourceId);
            const newDst = idMap.get(edge.oldTargetId);
            if (newSrc === undefined || newDst === undefined) {
              console.warn(
                "[paste] skipping edge — endpoint missing in idMap:",
                edge,
              );
              return null;
            }
            return {
              newSrc,
              newDst,
              kind: edge.kind, // may be undefined → omitted below
              vIdx: edge.sourceVariantIdx,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);

        const edgeResults = await Promise.allSettled(
          edgePayloads.map((p) => {
            const payload: Parameters<typeof createEdge>[0] = {
              board_id: boardId,
              source_id: p.newSrc,
              target_id: p.newDst,
              source_variant_idx: p.vIdx,
            };
            // Only attach `kind` when we have a real, non-default
            // value. Empty string / "default" / undefined → omit so
            // the backend uses its own default.
            if (p.kind && p.kind !== "default") {
              payload.kind = p.kind;
            }
            return createEdge(payload);
          }),
        );
        const newFlowEdges: Array<{
          id: string;
          source: string;
          target: string;
          type: string;
          data: { sourceVariantIdx: number | null };
        }> = [];
        let failedEdges = 0;
        for (const r of edgeResults) {
          if (r.status === "fulfilled") {
            const ed = r.value;
            newFlowEdges.push({
              id: String(ed.id),
              source: String(ed.source_id),
              target: String(ed.target_id),
              type: "default",
              data: { sourceVariantIdx: ed.source_variant_idx },
            });
          } else {
            failedEdges += 1;
            console.error("[paste] createEdge failed:", r.reason);
          }
        }

        // 3) Append directly to the store — no reload. Uses the same
        // setNodes / setEdges actions ReactFlow's change events go
        // through, so the canvas updates in the same render cycle.
        const currentNodes = useBoardStore.getState().nodes;
        const currentEdges = useBoardStore.getState().edges;
        setNodes([...currentNodes, ...newFlowNodes]);
        // The store's edge array typing is whatever ReactFlow's Edge
        // looks like; cast through unknown to satisfy the call site.
        setEdges([
          ...currentEdges,
          ...(newFlowEdges as unknown as typeof currentEdges),
        ]);

        // 4) Flash the new nodes briefly so the user spots them. We
        // surface this via a className on the wrapper; CSS handles the
        // animation. (See the JSX below for the .pasted-flash style
        // injected inline.)
        const flashIds = new Set(newFlowNodes.map((n) => n.id));
        setPastedFlashIds(flashIds);
        window.setTimeout(() => setPastedFlashIds(new Set()), 1200);

        // 5) Final status toast.
        const okN = newFlowNodes.length;
        const okE = newFlowEdges.length;
        if (failedNodes.length === 0 && failedEdges === 0) {
          showToast(`✓ Pasted ${okN} node${okN !== 1 ? "s" : ""}` + (okE ? ` + ${okE} edge${okE !== 1 ? "s" : ""}` : ""), "success");
        } else {
          showToast(
            `Pasted ${okN} of ${clipSnap.nodes.length} (${failedNodes.length} node + ${failedEdges} edge errors — see console)`,
            "error",
            3000,
          );
        }
        return;
      }
    };

    // Space keyup — restore the mode that was active before the hold.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " " && spaceModeRef.current !== null) {
        setInteractionMode(spaceModeRef.current);
        spaceModeRef.current = null;
      }
    };

    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("keyup", onKeyUp);
    return () => {
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("keyup", onKeyUp);
    };
  }, [setInteractionMode, interactionMode, fitView, zoomTo]);

  // Memoize nodes-with-flash-class so the flashing decoration applies
  // without reshaping the underlying store data. The .react-flow__node
  // CSS class is what ReactFlow wraps around our node card; tagging
  // the parent with .pasted-flash lets the global CSS (injected below)
  // pulse the border briefly.
  // Frames whose lock toggle is on — both the frame and its members
  // become non-draggable.
  const lockedFrameIds = new Set(
    nodes
      .filter((n) => n.data.type === "group" && n.data.locked === true)
      .map((n) => n.id),
  );

  const decoratedNodes = nodes.map((n) => {
    let out = n;
    if (pastedFlashIds.has(n.id)) {
      out = { ...out, className: `${out.className ?? ""} pasted-flash`.trim() };
    }
    // Group frames render BEHIND their members so clicks inside the
    // frame still hit member nodes.
    if (n.data.type === "group") {
      out = { ...out, zIndex: -1, draggable: n.data.locked !== true };
    } else if (
      typeof n.data.groupId === "string" &&
      lockedFrameIds.has(n.data.groupId)
    ) {
      out = { ...out, draggable: false };
    }
    return out;
  });

  // Edges feeding a node that's currently generating get the animated
  // "flow running" treatment (blue marching dashes) so the active path
  // lights up while a pipeline runs.
  const busyNodeIds = new Set(
    nodes
      .filter((n) => n.data.status === "queued" || n.data.status === "running")
      .map((n) => n.id),
  );
  const decoratedEdges = edges.map((e) =>
    busyNodeIds.has(e.target)
      ? { ...e, className: `${e.className ?? ""} edge-running`.trim() }
      : e,
  );

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div
      ref={wrapperRef}
      style={{
        flex: 1,
        minHeight: 0,
        width: "100%",
        height: "100%",
        position: "relative",
      }}
      onDragOver={onCanvasDragOver}
      onDrop={onCanvasDrop}
      tabIndex={0}
    >
      {/* Inline CSS for the paste-flash animation. Scoped via the
          .pasted-flash class so nothing else on the canvas is affected. */}
      <style>{`
        @keyframes flowboardPastedFlash {
          0%   { box-shadow: 0 0 0 0 rgba(93, 185, 122, 0.0); transform: scale(1); }
          15%  { box-shadow: 0 0 0 6px rgba(93, 185, 122, 0.55); transform: scale(1.03); }
          60%  { box-shadow: 0 0 0 12px rgba(93, 185, 122, 0.15); transform: scale(1); }
          100% { box-shadow: 0 0 0 0 rgba(93, 185, 122, 0.0); transform: scale(1); }
        }
        .react-flow__node.pasted-flash > * {
          animation: flowboardPastedFlash 1.1s ease-out;
          border-radius: 12px;
        }
      `}</style>

      <ReactFlow
        // Zoom range: out to 5% (whole-board overview) and in to 400%.
        // React Flow's defaults (50%–200%) were too tight for big boards.
        minZoom={0.05}
        maxZoom={4}
        nodes={decoratedNodes}
        edges={decoratedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onNodeDoubleClick={onNodeDoubleClick}
        // Right-click on empty canvas opens our custom node-add menu.
        // We swallow Chrome's default menu via preventDefault. Right-
        // clicking a node still bubbles to onNodeContextMenu (not
        // wired up here — feature for later).
        onPaneContextMenu={(e) => {
          // Some browsers fire this for both mouse and touch events;
          // the shape differs (MouseEvent has clientX/Y, TouchEvent
          // doesn't). Guard the cast.
          if ("preventDefault" in e) e.preventDefault();
          const ev = e as unknown as { clientX: number; clientY: number };
          setCtxMenu({ clientX: ev.clientX, clientY: ev.clientY });
        }}
        deleteKeyCode={["Backspace", "Delete"]}
        defaultEdgeOptions={defaultEdgeOptions}
        connectionRadius={32}
        // Mode-dependent props: in "hand" mode the user drags the
        // background to pan; in "select" mode the same drag draws a
        // box selection. Shift+drag also selects regardless of mode.
        panOnDrag={interactionMode === "hand"}
        selectionOnDrag={interactionMode === "select"}
        selectionMode={"partial" as never}
        multiSelectionKeyCode="Shift"
        selectionKeyCode={interactionMode === "select" ? null : "Shift"}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#2b2b2b" />
        {showMiniMap && <MiniMap pannable zoomable />}
        <SelectionToolbar />
        <DropAddPopover
          popover={dropPopover}
          onPick={handlePickAdd}
          onClose={() => setDropPopover(null)}
        />
      </ReactFlow>
      {/* Magnific-style chrome: floating left toolbar + footer controls
          (board tabs · minimap toggle · zoom dropdown). */}
      <LeftToolbar mode={interactionMode} onModeChange={setInteractionMode} />
      <FooterControls
        showMiniMap={showMiniMap}
        onToggleMiniMap={() => setShowMiniMap((v) => !v)}
      />
      <UploadProgressOverlay uploads={activeUploads} />
      {ctxMenu && (
        <CtxMenu
          pos={ctxMenu}
          onPick={handleCtxPick}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {/* Center-bottom toast for copy / paste feedback. Positioned in
          screen space (not flow space) so it stays put while the user
          pans / zooms. Fades in/out via CSS opacity transition. */}
      {paneToast && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: 32,
            transform: "translateX(-50%)",
            zIndex: 1100,
            pointerEvents: "none",
            background:
              paneToast.tone === "success"
                ? "rgba(40, 120, 70, 0.95)"
                : paneToast.tone === "error"
                  ? "rgba(180, 50, 50, 0.95)"
                  : "rgba(30, 33, 40, 0.95)",
            color: "#fff",
            padding: "10px 18px",
            borderRadius: 10,
            fontSize: 13,
            fontFamily: "system-ui, sans-serif",
            border: `1px solid ${
              paneToast.tone === "success"
                ? "#5db97a"
                : paneToast.tone === "error"
                  ? "#ff6b6b"
                  : "#3a3f4a"
            }`,
            boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
            animation: "flowboardToastIn 0.18s ease-out",
          }}
        >
          {paneToast.text}
        </div>
      )}
      <style>{`
        @keyframes flowboardToastIn {
          from { opacity: 0; transform: translateX(-50%) translateY(10px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `}</style>
    </div>
  );
}
