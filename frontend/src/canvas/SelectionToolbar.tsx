import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useReactFlow, useStore } from "@xyflow/react";
import { useBoardStore, type FlowNode } from "../store/board";
import { useGenerationStore } from "../store/generation";
import { createNode, enhancePrompt, mediaUrl, patchNode, runAssistant, upscaleImageLocal } from "../api/client";
import { resolveImagePrompt } from "./NodeCard";
import {
  IconCaretDown,
  IconCopy,
  IconDownload,
  IconFrame,
  IconGridLayout,
  IconLock,
  IconPlay,
  IconRunAll,
  IconTrash,
  IconUngroup,
  IconUnlock,
  IconSpinner,
} from "./icons";

// Floating toolbars for canvas selections (Magnific-style).
//
// • 2+ ordinary nodes selected →  ▶ Run · ⬚ Group · ▦ Arrange · ⧉ Dup · 🗑
// • exactly one "group" frame selected →
//   ● Color · ⛶ Ungroup · ▦ Arrange · 🔒 Lock · ⧉ Dup · 🗑
//
// Rendered as a child of <ReactFlow> so the RF store hooks work; the
// pill itself portals to document.body and tracks the selection through
// pan/zoom via the transform subscription.

const FALLBACK_W = 280;
const FALLBACK_H = 200;
const GAP = 48;
const FRAME_PAD = 24;
const FRAME_LABEL_PAD = 48;

const GROUP_COLORS = [
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#22c55e", // green
  "#f59e0b", // amber
  "#ef4444", // red
  "#64748b", // slate
];

function nodeW(n: FlowNode): number {
  return n.measured?.width ?? FALLBACK_W;
}
function nodeH(n: FlowNode): number {
  return n.measured?.height ?? FALLBACK_H;
}

// Fields that must NOT be copied onto a duplicate: identity / transient
// UI state that the backend or the clone itself will regenerate.
const DUP_STRIP = new Set([
  "type",
  "shortId",
  "groupId",
  "aiBriefStatus",
  "autoPromptStatus",
]);

// ── Run helpers (shared with ImageNodeToolbar) ───────────────────────
// A node is "runnable" when it has a prompt and a one-shot dispatch
// path: image → Flow gen, assistant → LLM run. Video / Storyboard need
// the GenerationDialog's extra wiring, so they're skipped.

// Returns true when the node was actually dispatched (so callers know
// whether to wait for completion).
async function runSingleNode(n: FlowNode): Promise<boolean> {
  const t = n.data.type;
  if (t === "image") {
    const variantCount = Math.max(1, Math.min(n.data.variantCount ?? 1, 4));
    // Image node only runs with a real prompt (own box, or a connected
    // Assistant / Prompt / Note). No vision auto-synth.
    let prompt = resolveImagePrompt(n.id, n.data.prompt ?? "");
    if (!prompt) return false;
    // AI prompt toggle — optimise via LLM first.
    if (n.data.aiPrompt) {
      try {
        prompt = await enhancePrompt(prompt);
        useBoardStore.getState().updateNodeData(n.id, { prompt });
        const dbId = parseInt(n.id, 10);
        if (!isNaN(dbId)) patchNode(dbId, { data: { prompt } }).catch(() => {});
      } catch {
        // fall through with the original prompt
      }
    }
    await useGenerationStore.getState().dispatchGeneration(n.id, {
      prompt,
      kind: "image",
      aspectRatio: n.data.aspectRatio ?? "IMAGE_ASPECT_RATIO_SQUARE",
      variantCount,
    });
    return true;
  }
  const prompt = (n.data.prompt ?? "").trim();
  if (!prompt) return false;
  if (t === "video") {
    // Source = the upstream node's freshly generated variants (the
    // pipeline runner guarantees upstream finished before we get here).
    const { nodes, edges } = useBoardStore.getState();
    const up = edges.find((e) => e.target === n.id);
    const src = up ? nodes.find((x) => x.id === up.source) : undefined;
    const ids = (
      src?.data.mediaIds ?? (src?.data.mediaId ? [src.data.mediaId] : [])
    ).filter((m): m is string => typeof m === "string" && m.length > 0);
    if (ids.length === 0) return false;
    const ar =
      typeof n.data.aspectRatio === "string" &&
      n.data.aspectRatio.startsWith("VIDEO_")
        ? n.data.aspectRatio
        : undefined;
    await useGenerationStore.getState().dispatchGeneration(n.id, {
      prompt,
      kind: "video",
      aspectRatio: ar,
      sourceMediaIds: ids,
    });
    return true;
  }
  if (t === "assistant") {
    const dbId = parseInt(n.id, 10);
    if (isNaN(dbId)) return false;
    const model =
      (n.data.assistantModel as string | undefined) ?? "gemini-2.5-flash";
    useBoardStore.getState().updateNodeData(n.id, { status: "running" });
    try {
      const result = await runAssistant(dbId, prompt, model);
      useBoardStore.getState().updateNodeData(n.id, {
        assistantResponse: result.response,
        assistantModel: model,
        status: "done",
      });
    } catch {
      useBoardStore.getState().updateNodeData(n.id, { status: "error" });
    }
    return true;
  }
  return false;
}

// Block until a node leaves the queued/running states. Generation
// dispatches resolve as soon as the request is accepted — the worker
// finishes later and flips node status via the polling loop — so the
// pipeline runner watches the store instead of trusting the promise.
const PIPELINE_NODE_TIMEOUT_MS = 10 * 60_000;

function waitForNodeCompletion(rfId: string): Promise<"done" | "error" | "timeout"> {
  return new Promise((resolve) => {
    const statusOf = () =>
      useBoardStore.getState().nodes.find((n) => n.id === rfId)?.data.status;
    const settled = (s: string | undefined) => s === "done" || s === "error";
    const first = statusOf();
    if (settled(first)) {
      resolve(first as "done" | "error");
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const unsub = useBoardStore.subscribe((state) => {
      const s = state.nodes.find((n) => n.id === rfId)?.data.status;
      if (settled(s)) {
        unsub();
        clearTimeout(timer);
        resolve(s as "done" | "error");
      }
    });
    timer = setTimeout(() => {
      unsub();
      resolve("timeout");
    }, PIPELINE_NODE_TIMEOUT_MS);
  });
}

export async function runNodeOnly(rfId: string): Promise<void> {
  const n = useBoardStore.getState().nodes.find((x) => x.id === rfId);
  if (!n) return;
  const dispatched = await runSingleNode(n);
  if (dispatched) await waitForNodeCompletion(rfId);
}

// True pipeline run: BFS downstream from the start node, but each node
// WAITS for the previous one to fully finish (status done) before it
// fires — so downstream prompts/refs consume the freshly generated
// upstream media/text, not stale data. A failed or timed-out node
// aborts the rest of the chain (its dependents would be missing their
// input anyway).
export async function runFromHere(rfId: string): Promise<void> {
  const { edges } = useBoardStore.getState();
  const order: string[] = [];
  const seen = new Set<string>([rfId]);
  const queue = [rfId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const e of edges) {
      if (e.source === cur && !seen.has(e.target)) {
        seen.add(e.target);
        queue.push(e.target);
      }
    }
  }
  for (const id of order) {
    // Re-read the node fresh each step — upstream runs have updated
    // mediaIds / assistantResponse since the chain started.
    const n = useBoardStore.getState().nodes.find((x) => x.id === id);
    if (!n) continue;
    const dispatched = await runSingleNode(n);
    if (!dispatched) continue; // not runnable (no prompt / no source) — skip
    const result = await waitForNodeCompletion(id);
    if (result !== "done") {
      useGenerationStore.setState({
        error: `Pipeline stopped at #${n.data.shortId}: node ${
          result === "timeout" ? "timed out" : "failed"
        }. Fix it and Run from here again.`,
      });
      return;
    }
  }
}

function patchNodeData(rfId: string, partial: Record<string, unknown>) {
  useBoardStore.getState().updateNodeData(rfId, partial);
  const dbId = parseInt(rfId, 10);
  if (!isNaN(dbId)) {
    patchNode(dbId, { data: partial }).catch(() => {});
  }
}

function arrangeNodes(
  targets: FlowNode[],
  mode: "vertical" | "horizontal" | "grid",
): Map<string, { x: number; y: number }> {
  const moves = new Map<string, { x: number; y: number }>();
  if (targets.length === 0) return moves;
  const minX = Math.min(...targets.map((n) => n.position.x));
  const minY = Math.min(...targets.map((n) => n.position.y));
  if (mode === "vertical") {
    const sorted = [...targets].sort((a, b) => a.position.y - b.position.y);
    let y = minY;
    for (const n of sorted) {
      moves.set(n.id, { x: minX, y });
      y += nodeH(n) + GAP;
    }
  } else if (mode === "horizontal") {
    const sorted = [...targets].sort((a, b) => a.position.x - b.position.x);
    let x = minX;
    for (const n of sorted) {
      moves.set(n.id, { x, y: minY });
      x += nodeW(n) + GAP;
    }
  } else {
    const sorted = [...targets].sort(
      (a, b) => a.position.y - b.position.y || a.position.x - b.position.x,
    );
    const cols = Math.ceil(Math.sqrt(sorted.length));
    const cellW = Math.max(...sorted.map(nodeW)) + GAP;
    const cellH = Math.max(...sorted.map(nodeH)) + GAP;
    sorted.forEach((n, i) => {
      moves.set(n.id, {
        x: minX + (i % cols) * cellW,
        y: minY + Math.floor(i / cols) * cellH,
      });
    });
  }
  return moves;
}

function applyMoves(moves: Map<string, { x: number; y: number }>) {
  useBoardStore.setState((s) => ({
    nodes: s.nodes.map((n) =>
      moves.has(n.id) ? { ...n, position: moves.get(n.id)! } : n,
    ),
  }));
  const persist = useBoardStore.getState().persistNodePosition;
  for (const [rfId, pos] of moves) void persist(rfId, pos);
}

async function duplicateNodes(
  targets: FlowNode[],
  offset: number,
  groupIdForClones?: string,
): Promise<FlowNode[]> {
  const boardId = useBoardStore.getState().boardId;
  if (boardId === null) return [];
  const created: FlowNode[] = [];
  for (const n of targets) {
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n.data)) {
      if (!DUP_STRIP.has(k) && v !== undefined) data[k] = v;
    }
    if (groupIdForClones) data.groupId = groupIdForClones;
    try {
      const dto = await createNode({
        board_id: boardId,
        type: n.data.type,
        x: Math.round(n.position.x + offset),
        y: Math.round(n.position.y + offset),
        data,
      });
      created.push({
        id: String(dto.id),
        type: dto.type,
        position: { x: dto.x, y: dto.y },
        selected: false,
        data: {
          ...(data as FlowNode["data"]),
          type: dto.type,
          shortId: dto.short_id,
          title: (data.title as string) ?? dto.type,
        },
      });
    } catch (err) {
      console.error("duplicate failed for node", n.id, err);
    }
  }
  if (created.length > 0) {
    useBoardStore.setState((s) => ({ nodes: [...s.nodes, ...created] }));
  }
  return created;
}

// Group the current selection (≥2 non-group nodes) into a new frame.
// Exposed for the LeftToolbar button and the `G` keyboard shortcut.
export async function groupSelectedNodes(): Promise<void> {
  const selected = useBoardStore
    .getState()
    .nodes.filter((n) => n.selected && n.data.type !== "group");
  if (selected.length < 2) return;
  const boardId = useBoardStore.getState().boardId;
  if (boardId === null) return;
  const minX = Math.min(...selected.map((n) => n.position.x));
  const minY = Math.min(...selected.map((n) => n.position.y));
  const maxX = Math.max(...selected.map((n) => n.position.x + nodeW(n)));
  const maxY = Math.max(...selected.map((n) => n.position.y + nodeH(n)));
  const gMinX = minX - FRAME_PAD;
  const gMinY = minY - FRAME_LABEL_PAD;
  const w = Math.round(maxX + FRAME_PAD - gMinX);
  const h = Math.round(maxY + FRAME_PAD - gMinY);
  const dto = await createNode({
    board_id: boardId,
    type: "group",
    x: Math.round(gMinX),
    y: Math.round(gMinY),
    w,
    h,
    data: { title: "New group", frameW: w, frameH: h },
  });
  const frame: FlowNode = {
    id: String(dto.id),
    type: "group",
    position: { x: dto.x, y: dto.y },
    data: {
      type: "group",
      shortId: dto.short_id,
      title: "New group",
      frameW: w,
      frameH: h,
      status: "idle",
    },
  };
  useBoardStore.setState((s) => ({ nodes: [frame, ...s.nodes] }));
  for (const n of selected) {
    patchNodeData(n.id, { groupId: frame.id });
  }
}

// Duplicate the current selection — exposed for Ctrl/Cmd+D.
export async function duplicateSelectedNodes(): Promise<void> {
  const selected = useBoardStore
    .getState()
    .nodes.filter((n) => n.selected && n.data.type !== "group");
  if (selected.length === 0) return;
  const created = await duplicateNodes(selected, 40);
  if (created.length > 0) {
    const ids = new Set(created.map((c) => c.id));
    useBoardStore.setState((s) => ({
      nodes: s.nodes.map((n) => ({ ...n, selected: ids.has(n.id) })),
    }));
    // One Ctrl+Z removes all the clones.
    const clonedIds = created.map((c) => c.id);
    useBoardStore.getState().recordUndo("duplicate", async () => {
      const del = useBoardStore.getState().deleteNodeByRfId;
      for (const id of clonedIds) await del(id);
    });
  }
}

// Recompute a frame's geometry to wrap its members (after arrange).
function refitFrame(frame: FlowNode) {
  const members = useBoardStore
    .getState()
    .nodes.filter((n) => n.data.groupId === frame.id);
  if (members.length === 0) return;
  const minX = Math.min(...members.map((n) => n.position.x)) - FRAME_PAD;
  const minY = Math.min(...members.map((n) => n.position.y)) - FRAME_LABEL_PAD;
  const maxX = Math.max(...members.map((n) => n.position.x + nodeW(n))) + FRAME_PAD;
  const maxY = Math.max(...members.map((n) => n.position.y + nodeH(n))) + FRAME_PAD;
  const w = Math.round(maxX - minX);
  const h = Math.round(maxY - minY);
  useBoardStore.setState((s) => ({
    nodes: s.nodes.map((n) =>
      n.id === frame.id
        ? {
            ...n,
            position: { x: minX, y: minY },
            data: { ...n.data, frameW: w, frameH: h },
          }
        : n,
    ),
  }));
  void useBoardStore.getState().persistNodePosition(frame.id, { x: minX, y: minY });
  patchNodeData(frame.id, { frameW: w, frameH: h });
}

// ── Shared pill button ───────────────────────────────────────────────

function PillButton({
  label,
  title,
  danger,
  disabled,
  onClick,
}: {
  label: ReactNode;
  title: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`selection-toolbar__btn${danger ? " selection-toolbar__btn--danger" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {label}
    </button>
  );
}

// ── Multi-select toolbar ─────────────────────────────────────────────

function MultiToolbar({ selected }: { selected: FlowNode[] }) {
  const { flowToScreenPosition } = useReactFlow();
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const minX = Math.min(...selected.map((n) => n.position.x));
  const minY = Math.min(...selected.map((n) => n.position.y));
  const maxX = Math.max(...selected.map((n) => n.position.x + nodeW(n)));
  const screen = flowToScreenPosition({ x: (minX + maxX) / 2, y: minY });

  async function runAll() {
    if (busy) return;
    setBusy(true);
    const gen = useGenerationStore.getState();
    const jobs: Promise<unknown>[] = [];
    for (const n of selected) {
      const t = n.data.type;
      const prompt = (n.data.prompt ?? "").trim();
      if (!prompt) continue;
      if (t === "image") {
        jobs.push(
          gen.dispatchGeneration(n.id, {
            prompt,
            kind: "image",
            aspectRatio: n.data.aspectRatio ?? "IMAGE_ASPECT_RATIO_SQUARE",
            variantCount: n.data.variantCount,
          }),
        );
      } else if (t === "assistant") {
        const dbId = parseInt(n.id, 10);
        if (isNaN(dbId)) continue;
        const model =
          (n.data.assistantModel as string | undefined) ?? "gemini-2.5-flash";
        useBoardStore.getState().updateNodeData(n.id, { status: "running" });
        jobs.push(
          runAssistant(dbId, prompt, model)
            .then((result) => {
              useBoardStore.getState().updateNodeData(n.id, {
                assistantResponse: result.response,
                assistantModel: model,
                status: "done",
              });
            })
            .catch(() => {
              useBoardStore.getState().updateNodeData(n.id, { status: "error" });
            }),
        );
      }
      // video / Storyboard need the dialog's extra wiring — skipped.
    }
    await Promise.allSettled(jobs);
    setBusy(false);
  }

  async function groupSelection() {
    if (busy) return;
    setBusy(true);
    try {
      await groupSelectedNodes();
    } finally {
      setBusy(false);
    }
  }

  async function duplicateAll() {
    if (busy) return;
    setBusy(true);
    try {
      await duplicateSelectedNodes();
    } finally {
      setBusy(false);
    }
  }

  async function deleteAll() {
    if (busy) return;
    setBusy(true);
    try {
      // One undo step for the whole multi-delete.
      await useBoardStore.getState().runUndoBatch("delete nodes", async () => {
        const del = useBoardStore.getState().deleteNodeByRfId;
        for (const n of selected) await del(n.id);
      });
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="selection-toolbar"
      style={{ left: screen.x, top: screen.y - 56 }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      role="toolbar"
      aria-label="Selection actions"
    >
      <PillButton label={<IconPlay size={12} />} title={`Run ${selected.length} nodes`} disabled={busy} onClick={() => void runAll()} />
      <PillButton label={<IconFrame size={14} />} title="Group" disabled={busy} onClick={() => void groupSelection()} />
      <span style={{ position: "relative", display: "inline-flex" }}>
        <PillButton label={<IconGridLayout size={14} />} title="Arrange" disabled={busy} onClick={() => setLayoutOpen((o) => !o)} />
        {layoutOpen && (
          <div className="selection-toolbar__menu">
            {(["vertical", "horizontal", "grid"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setLayoutOpen(false);
                  applyMoves(arrangeNodes(selected, m));
                }}
              >
                {m === "vertical" ? "▯ Vertical" : m === "horizontal" ? "▭ Horizontal" : "▦ Grid"}
              </button>
            ))}
          </div>
        )}
      </span>
      <PillButton label={<IconCopy size={13} />} title="Duplicate" disabled={busy} onClick={() => void duplicateAll()} />
      <span className="selection-toolbar__sep" />
      <PillButton label={<IconTrash size={13} />} title="Delete" danger disabled={busy} onClick={() => void deleteAll()} />
    </div>,
    document.body,
  );
}

// ── Group-frame toolbar ──────────────────────────────────────────────

function GroupToolbar({ frame }: { frame: FlowNode }) {
  const { flowToScreenPosition } = useReactFlow();
  const [colorOpen, setColorOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const w = typeof frame.data.frameW === "number" ? frame.data.frameW : 400;
  const screen = flowToScreenPosition({
    x: frame.position.x + w / 2,
    y: frame.position.y,
  });

  const members = () =>
    useBoardStore.getState().nodes.filter((n) => n.data.groupId === frame.id);
  const locked = frame.data.locked === true;
  const color = (frame.data.color as string | undefined) ?? "#3b82f6";

  function setColor(c: string) {
    setColorOpen(false);
    patchNodeData(frame.id, { color: c });
  }

  function ungroup() {
    for (const m of members()) {
      patchNodeData(m.id, { groupId: null });
    }
    void useBoardStore.getState().deleteNodeByRfId(frame.id);
  }

  function arrange(mode: "vertical" | "horizontal" | "grid") {
    setLayoutOpen(false);
    applyMoves(arrangeNodes(members(), mode));
    // Resize the frame to hug the new layout.
    const fresh = useBoardStore.getState().nodes.find((n) => n.id === frame.id);
    if (fresh) refitFrame(fresh);
  }

  function toggleLock() {
    patchNodeData(frame.id, { locked: !locked });
  }

  async function duplicateGroup() {
    if (busy) return;
    setBusy(true);
    try {
      const boardId = useBoardStore.getState().boardId;
      if (boardId === null) return;
      const offset = 60;
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(frame.data)) {
        if (!DUP_STRIP.has(k) && v !== undefined) data[k] = v;
      }
      data.locked = false;
      const dto = await createNode({
        board_id: boardId,
        type: "group",
        x: Math.round(frame.position.x + offset),
        y: Math.round(frame.position.y + offset),
        data,
      });
      const clone: FlowNode = {
        id: String(dto.id),
        type: "group",
        position: { x: dto.x, y: dto.y },
        data: {
          ...(data as FlowNode["data"]),
          type: "group",
          shortId: dto.short_id,
          title: (data.title as string) ?? "New group",
        },
      };
      useBoardStore.setState((s) => ({ nodes: [clone, ...s.nodes] }));
      await duplicateNodes(members(), offset, clone.id);
    } finally {
      setBusy(false);
    }
  }

  // Download every rendered image/video inside the group — one file per
  // media (no zip). Same-origin /media/<id> URLs honour the `download`
  // filename. Small stagger so Chrome doesn't drop downloads.
  function downloadGroupMedia() {
    const items: Array<{ url: string; name: string }> = [];
    for (const m of members()) {
      const t = m.data.type;
      if (t === "prompt" || t === "note" || t === "assistant") continue;
      const rawIds =
        m.data.mediaIds && m.data.mediaIds.length > 0
          ? m.data.mediaIds
          : m.data.mediaId
            ? [m.data.mediaId]
            : [];
      const ids = rawIds.filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      );
      const safeTitle = (m.data.title || t).replace(/[^A-Za-z0-9_-]+/g, "_");
      const ext = t === "video" ? "mp4" : "png";
      ids.forEach((mid, i) => {
        const suffix = ids.length > 1 ? `-${i + 1}` : "";
        items.push({
          url: mediaUrl(mid),
          name: `${safeTitle}-${m.data.shortId}${suffix}.${ext}`,
        });
      });
    }
    items.forEach((item, i) => {
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = item.url;
        a.download = item.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 300);
    });
  }

  // Download every IMAGE in the group upscaled to 2K — locally (Pillow
  // Lanczos + light sharpen). Faithful (no invented detail), instant, no Flow
  // and no quota. Videos are skipped. Done one at a time with a clean busy
  // state; reports how many failed.
  async function downloadGroupMedia2K() {
    if (busy) return;
    setBusy(true);
    try {
      const items: Array<{ mediaId: string; name: string }> = [];
      for (const m of members()) {
        const t = m.data.type;
        if (t === "video" || t === "prompt" || t === "note" || t === "assistant") continue;
        const rawIds =
          m.data.mediaIds && m.data.mediaIds.length > 0
            ? m.data.mediaIds
            : m.data.mediaId
              ? [m.data.mediaId]
              : [];
        const ids = rawIds.filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        );
        const safeTitle = (m.data.title || t).replace(/[^A-Za-z0-9_-]+/g, "_");
        ids.forEach((mid, i) => {
          const suffix = ids.length > 1 ? `-${i + 1}` : "";
          items.push({
            mediaId: mid,
            name: `${safeTitle}-${m.data.shortId}${suffix}-2K.png`,
          });
        });
      }
      if (items.length === 0) {
        useGenerationStore.setState({ error: "Group không có ảnh để tải 2K." });
        return;
      }
      let failed = 0;
      for (const item of items) {
        try {
          const blob = await upscaleImageLocal(item.mediaId, "2K");
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = item.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        } catch {
          failed++;
        }
        // Small gap so Chrome doesn't drop back-to-back downloads.
        await new Promise((r) => setTimeout(r, 250));
      }
      if (failed > 0) {
        useGenerationStore.setState({
          error: `Tải 2K: ${failed}/${items.length} ảnh thất bại.`,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  async function deleteGroup() {
    if (busy) return;
    setBusy(true);
    try {
      // One undo step for the whole group + its members.
      await useBoardStore.getState().runUndoBatch("delete group", async () => {
        const del = useBoardStore.getState().deleteNodeByRfId;
        for (const m of members()) await del(m.id);
        await del(frame.id);
      });
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="selection-toolbar"
      style={{ left: screen.x, top: screen.y - 56 }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      role="toolbar"
      aria-label="Group actions"
    >
      <span style={{ position: "relative", display: "inline-flex" }}>
        <button
          type="button"
          className="selection-toolbar__btn"
          onClick={() => setColorOpen((o) => !o)}
          title="Color"
          disabled={busy}
        >
          <span className="group-color-dot" style={{ background: color }} />
        </button>
        {colorOpen && (
          <div className="selection-toolbar__menu selection-toolbar__menu--colors">
            {GROUP_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="group-color-swatch"
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={`Set color ${c}`}
              />
            ))}
          </div>
        )}
      </span>
      <PillButton label={<IconUngroup size={14} />} title="Ungroup" disabled={busy} onClick={ungroup} />
      <span style={{ position: "relative", display: "inline-flex" }}>
        <PillButton label={<IconGridLayout size={14} />} title="Arrange members" disabled={busy} onClick={() => setLayoutOpen((o) => !o)} />
        {layoutOpen && (
          <div className="selection-toolbar__menu">
            {(["vertical", "horizontal", "grid"] as const).map((m) => (
              <button key={m} type="button" onClick={() => arrange(m)}>
                {m === "vertical" ? "▯ Vertical" : m === "horizontal" ? "▭ Horizontal" : "▦ Grid"}
              </button>
            ))}
          </div>
        )}
      </span>
      <PillButton label={locked ? <IconLock size={13} /> : <IconUnlock size={13} />} title={locked ? "Unlock" : "Lock"} disabled={busy} onClick={toggleLock} />
      <PillButton label={<IconDownload size={13} />} title="Tải toàn bộ ảnh/video trong group (1K gốc, mỗi file một ảnh)" disabled={busy} onClick={downloadGroupMedia} />
      <PillButton
        label={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
            {busy ? <IconSpinner size={13} /> : <IconDownload size={13} />}
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.2 }}>2K</span>
          </span>
        }
        title="Tải toàn bộ ảnh trong group ở 2K — làm nét AI trên máy (Real-ESRGAN nếu đã cài, tự nhiên · không dính quota Flow)"
        disabled={busy}
        onClick={() => void downloadGroupMedia2K()}
      />
      <PillButton label={<IconCopy size={13} />} title="Duplicate group" disabled={busy} onClick={() => void duplicateGroup()} />
      <span className="selection-toolbar__sep" />
      <PillButton label={<IconTrash size={13} />} title="Delete group + contents" danger disabled={busy} onClick={() => void deleteGroup()} />
    </div>,
    document.body,
  );
}

// ── Run split-button (▶▶ + dropdown) ─────────────────────────────────
// Shared by the single-node pill below and the ImageNodeToolbar.

export function RunSplitButton({ rfId }: { rfId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function exec(fn: (id: string) => Promise<void>) {
    if (busy) return;
    setOpen(false);
    setBusy(true);
    try {
      await fn(rfId);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className="selection-toolbar__btn"
        disabled={busy}
        title="Run from here (this node + everything downstream)"
        onClick={() => void exec(runFromHere)}
      >
        {busy ? <IconSpinner size={13} /> : <IconRunAll size={14} />}
      </button>
      <button
        type="button"
        className="selection-toolbar__btn selection-toolbar__btn--caret"
        disabled={busy}
        title="Run options"
        onClick={() => setOpen((o) => !o)}
        aria-label="Run options"
      >
        <IconCaretDown size={10} />
      </button>
      {open && (
        <div className="selection-toolbar__menu">
          <button type="button" onClick={() => void exec(runNodeOnly)}>
            <IconPlay size={11} /> This node only
          </button>
          <button type="button" onClick={() => void exec(runFromHere)}>
            <IconRunAll size={12} /> Run from here
          </button>
        </div>
      )}
    </span>
  );
}

// Floating run pill for a single selected node (any type except group;
// image/visual_asset nodes with media already get the run button inside
// their ImageNodeToolbar).
function SingleRunToolbar({ node }: { node: FlowNode }) {
  const { flowToScreenPosition } = useReactFlow();
  const screen = flowToScreenPosition({
    x: node.position.x + nodeW(node) / 2,
    y: node.position.y,
  });
  return createPortal(
    <div
      className="selection-toolbar"
      style={{ left: screen.x, top: screen.y - 56 }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      role="toolbar"
      aria-label="Run actions"
    >
      <RunSplitButton rfId={node.id} />
    </div>,
    document.body,
  );
}

// ── Entry point ──────────────────────────────────────────────────────

export function SelectionToolbar() {
  const nodes = useBoardStore((s) => s.nodes);
  // Re-render on pan/zoom so the pill stays glued to the selection.
  useStore((s) => s.transform);

  const selectedAll = nodes.filter((n) => n.selected);
  const selectedPlain = selectedAll.filter((n) => n.data.type !== "group");

  if (selectedAll.length === 1 && selectedAll[0].data.type === "group") {
    return <GroupToolbar frame={selectedAll[0]} />;
  }
  if (selectedPlain.length >= 2) {
    return <MultiToolbar selected={selectedPlain} />;
  }
  if (selectedAll.length === 1) {
    const n = selectedAll[0];
    const t = n.data.type;
    const hasMedia = Boolean(
      n.data.mediaId ||
        (n.data.mediaIds ?? []).some((m) => typeof m === "string" && m),
    );
    // Image/visual_asset nodes with media show ImageNodeToolbar (which
    // now embeds the run split-button) — don't double up.
    if ((t === "image" || t === "visual_asset") && hasMedia) return null;
    return <SingleRunToolbar node={n} />;
  }
  return null;
}
