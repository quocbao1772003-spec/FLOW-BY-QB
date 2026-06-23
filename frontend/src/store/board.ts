import { create } from "zustand";
import type { Edge, Node } from "@xyflow/react";
import {
  listBoards,
  createBoard,
  getBoard,
  patchBoard as apiPatchBoard,
  deleteBoard as apiDeleteBoard,
  createNode,
  patchNode,
  deleteNode,
  createEdge,
  deleteEdge,
  type Board,
  type NodeType,
} from "../api/client";

export type { NodeType };

export type NodeStatus = "idle" | "queued" | "running" | "done" | "error";

// Storyboard grid options.
//   2x2 → 4 panels (square)
//   2x3 → 6 panels (rectangular: 2×3 on landscape, 3×2 on portrait)
//   2x4 → 8 panels (rectangular: 2×4 on landscape, 4×2 on portrait)
// The rows/cols mapping happens at prompt-build time based on the
// node's aspectRatio — see resolveStoryboardLayout in
// frontend/src/lib/storyboardPrompt.ts.
export type StoryboardGrid = "2x2" | "2x3" | "2x4";

export interface FlowboardNodeData extends Record<string, unknown> {
  type: NodeType;
  shortId: string;
  title: string;
  status?: NodeStatus;
  prompt?: string;
  thumbnailUrl?: string;
  mediaId?: string;
  // Per-variant media ids in dispatch order. `null` entries are
  // positional placeholders for variants that failed (e.g. Veo content
  // filter blocked one of the 4 i2v clips while the other 3 succeeded);
  // keeping the slot preserves alignment with the upstream image's
  // variants for poster/edge-pin lookups.
  mediaIds?: (string | null)[];
  // Per-slot error code, aligned to `mediaIds` indexing. `null` for
  // succeeded slots, an error string (e.g. "PUBLIC_ERROR_UNSAFE_GENERATION")
  // for blocked ones. ResultViewer reads this to render the exact
  // filter reason on the blocked tile instead of falling through to
  // the previous variant.
  slotErrors?: (string | null)[];
  variantCount?: number;
  // The aspect-ratio enum the asset was generated / uploaded at — used to
  // default-match downstream gen dialogs (e.g. a 9:16 visual_asset feeds
  // into a downstream image / video that defaults to 9:16). Values are
  // Flow's IMAGE_ASPECT_RATIO_* enum strings since that's what the upload
  // route + gen worker produce. Video targets map them onto the matching
  // VIDEO_ASPECT_RATIO_* enum at dialog-open time.
  aspectRatio?: string;
  // AI-generated factual description of mediaId (set by /api/vision/describe).
  // Spliced into auto-prompts on downstream nodes for richer context.
  aiBrief?: string;
  aiBriefStatus?: "pending" | "done" | "failed";
  // Ordered image-input slots (Weavy-style). index = slot, value = the
  // source node rfId feeding that slot ("" = empty). Drives ref ordering
  // at dispatch and the labeled Image 1/2/3 handles on the card.
  imageInputs?: string[];
  // How many input slots to show (default 3). + Add input increments it.
  imageInputCount?: number;
  // "AI prompt" toggle — when on, the typed prompt is rewritten/optimised
  // by the LLM before generating.
  aiPrompt?: boolean;
  // Group membership — rfId of the "group" frame node this node belongs
  // to. Dragging the frame moves every member by the same delta.
  groupId?: string;
  // Frame dimensions for "group" nodes (the frame is sized to the
  // selection bounding box at creation time).
  frameW?: number;
  frameH?: number;
  // Transient status while the GenerationDialog runs `autoPrompt` /
  // `autoPromptBatch` against this node — set to "pending" while the
  // backend is composing the prompt, cleared on success/failure. Not
  // persisted to the DB; it's a few-second UX flag so the node can
  // render a visible "busy" treatment that blocks duplicate dispatches.
  autoPromptStatus?: "pending" | "done" | "failed";
  // ISO timestamp persisted when a generation completes successfully.
  // Powers the "5 phút trước" relative-time display in ResultViewer.
  // Uploads also stamp this so the timestamp reflects "when the asset
  // landed on the node" regardless of source.
  renderedAt?: string;
  // Model used to produce the rendered media. Populated on completion
  // of gen_image / edit_image (`imageModel`, e.g. "NANO_BANANA_PRO") or
  // gen_video (`videoQuality`, e.g. "fast" / "lite" / "quality"). Absent
  // on uploads (no model involved) and on nodes generated before this
  // feature shipped — ResultViewer falls back to current settings as
  // plain text in that case so the user knows it's an estimate.
  imageModel?: string;
  videoQuality?: string;
  // Character-builder selections — persisted on dispatch so the detail
  // panel can show "Country / Vibe / Gender" pills under METADATA. Keys
  // (`vn`, `clean`, `female`) match the constants in
  // `src/constants/character.ts`; viewer maps key → display label.
  charCountry?: string;
  charVibe?: string;
  charGender?: string;
  error?: string;
  // Storyboard layout. The Storyboard node is now a thin image-node
  // wrapper that generates a single composite using a locked prompt
  // template `Create visual storyboard for "<topic>" as SINGLE IMAGE
  // arranged in a NxN layout (N rows, N columns)`. Default `3x3` when
  // missing (true for fresh nodes + legacy pre-1.2.15 nodes whose
  // multi-shot data is now ignored).
  storyboardGrid?: StoryboardGrid;
}

export type FlowNode = Node<FlowboardNodeData>;

// Per-edge data we attach to ReactFlow's `Edge.data` so dispatch and
// edge-rendering paths can read it without a round-trip through the
// backend. `sourceVariantIdx` mirrors `EdgeDTO.source_variant_idx`.
export interface FlowboardEdgeData extends Record<string, unknown> {
  sourceVariantIdx?: number | null;
}

/** Map an EdgeDTO from the backend into ReactFlow's Edge shape, carrying
 * the variant pin through `data` so dispatch + edge UI can read it. */
function edgeFromDto(dto: {
  id: number;
  source_id: number;
  target_id: number;
  source_variant_idx?: number | null;
}): Edge<FlowboardEdgeData> {
  return {
    id: String(dto.id),
    source: String(dto.source_id),
    target: String(dto.target_id),
    data: { sourceVariantIdx: dto.source_variant_idx ?? null },
  };
}

// Reconstruct each edge's targetHandle from the target image node's
// `imageInputs` array so the edge visually attaches to the right
// "Image N" slot after a reload (handles aren't persisted on the edge).
function assignImageInputHandles(
  nodes: FlowNode[],
  edges: Edge<FlowboardEdgeData>[],
): Edge<FlowboardEdgeData>[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Legacy image nodes have no `imageInputs` yet — derive a stable slot
  // order from their incoming edges so old boards still attach edges to
  // sequential handles.
  const derived = new Map<string, string[]>(); // targetId → [sourceId per slot]
  for (const e of edges) {
    const t = byId.get(e.target);
    if (t?.data.type === "image" && !Array.isArray(t.data.imageInputs)) {
      const arr = derived.get(e.target) ?? [];
      arr.push(e.source);
      derived.set(e.target, arr);
    }
  }
  return edges.map((e) => {
    const t = byId.get(e.target);
    if (t?.data.type !== "image") return e;
    const slots = Array.isArray(t.data.imageInputs)
      ? (t.data.imageInputs as string[])
      : derived.get(e.target);
    if (slots) {
      const idx = slots.indexOf(e.source);
      if (idx >= 0) return { ...e, targetHandle: `in-${idx}` };
    }
    return e;
  });
}

// ── Tiny per-node debounce (no external deps) ─────────────────────────────
const positionTimers = new Map<string, ReturnType<typeof setTimeout>>();

function debouncePosition(rfId: string, fn: () => void, delay = 150) {
  const existing = positionTimers.get(rfId);
  if (existing !== undefined) clearTimeout(existing);
  positionTimers.set(rfId, setTimeout(() => {
    positionTimers.delete(rfId);
    fn();
  }, delay));
}

// ── Undo history (Ctrl+Z) ──────────────────────────────────────────────────
// We record an *inverse* operation for each structural edit the user makes:
// adding / deleting a node, adding / deleting an edge, and moving nodes. A
// single Ctrl+Z pops the latest inverse and replays it (locally + persisted).
// Text edits inside a node's prompt are deliberately NOT tracked here — the
// browser's native textarea undo already handles typing, and Board.tsx only
// routes Ctrl+Z to us when focus isn't in an input/textarea.
type UndoOp = { label: string; run: () => Promise<void> };
const undoStack: UndoOp[] = [];
const UNDO_LIMIT = 100;
// Set while replaying an undo so the inverse ops we issue (delete a node we
// just re-added, etc.) don't get pushed back onto the stack themselves.
let undoSuppressed = false;
// When > 0 we're inside an explicit batch (e.g. deleting a multi-selection):
// every pushUndo is collected so one Ctrl+Z reverses the whole group.
let batchDepth = 0;
let batchBuffer: UndoOp[] = [];
function pushUndo(op: UndoOp) {
  if (undoSuppressed) return;
  if (batchDepth > 0) {
    batchBuffer.push(op);
    return;
  }
  undoStack.push(op);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

// ── Type-to-title lookup ───────────────────────────────────────────────────
const TYPE_TITLE: Record<NodeType, string> = {
  character: "Character",
  image: "Image",
  video: "Video",
  prompt: "Prompt",
  note: "Note",
  visual_asset: "Visual asset",
  Storyboard: "Storyboard",
  assistant: "Assistant",
  group: "New group",
};

// ── Persisted active-board id ─────────────────────────────────────────────
// Survives page reloads so refreshing on project #4 doesn't kick the user
// back to project #1. localStorage is fine here — single-user, single-host.
const ACTIVE_BOARD_KEY = "flowboard.activeBoardId";

function loadPersistedBoardId(): number | null {
  try {
    const raw = localStorage.getItem(ACTIVE_BOARD_KEY);
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function persistBoardId(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_BOARD_KEY);
    else localStorage.setItem(ACTIVE_BOARD_KEY, String(id));
  } catch {
    // Storage disabled / quota exceeded — non-fatal, just lose persistence.
  }
}

// ── Store ──────────────────────────────────────────────────────────────────
interface BoardState {
  boardId: number | null;
  boardName: string;
  // Lightweight summary list rendered by the ProjectSidebar — full node /
  // edge content lives only on the active board to keep memory bounded.
  boards: Board[];
  nodes: FlowNode[];
  edges: Edge[];
  loading: boolean;
  error: string | null;

  loadInitialBoard(): Promise<void>;
  refreshBoardState(): Promise<void>;
  refreshBoardList(): Promise<void>;
  renameBoard(name: string): Promise<void>;
  // Switch the active board: load detail, replace nodes/edges, reset
  // poll-state on the generation store.
  switchBoard(id: number): Promise<void>;
  // Create a new board, switch to it, return id.
  createNewBoard(name: string): Promise<number | null>;
  // Delete a board. If it's the active one, switch to first remaining
  // board (or create a fresh "Untitled" if list ends up empty).
  deleteBoardById(id: number): Promise<void>;

  // Returns the new node's rfId on success, or null if creation failed.
  // Callers that need to wire up an edge immediately (e.g. drop-popover
  // shortcut) need the id back synchronously.
  addNodeOfType(type: NodeType, position: { x: number; y: number }): Promise<string | null>;
  // Spawn a brand-new visual_asset node from a saved Reference. Used by
  // both the panel click-to-spawn path and the canvas drop-to-spawn path.
  // The new node lands with status="done" + mediaId + aiBrief already
  // populated so its thumbnail loads immediately and it can be used as a
  // downstream ref without any extra round-trip.
  addReferenceNode(
    ref: {
      mediaId: string;
      aiBrief?: string | null;
      aspectRatio?: string | null;
      kind: string;
      label: string;
    },
    position: { x: number; y: number },
  ): Promise<string | null>;
  persistNodePosition(rfId: string, position: { x: number; y: number }): Promise<void>;
  deleteNodeByRfId(rfId: string): Promise<void>;
  addEdgeFromConnection(source: string, target: string, targetHandle?: string | null): Promise<void>;
  deleteEdgeByRfId(rfId: string): Promise<void>;
  // Spawn an empty sibling node next to `rfId` with the same type and the
  // same upstream edges. Returns the new node's rfId so callers can focus
  // / open the generation dialog on it. Used by ResultViewer's
  // "New variant +" — gives the user a fresh canvas to gen another shot
  // sharing the original's source refs.
  cloneNodeWithUpstream(rfId: string): Promise<string | null>;

  updateNodeData(rfId: string, partial: Partial<FlowboardNodeData>): void;
  /** Merge `partial` into edge.data — used to refresh the local cache
   * after a PATCH /api/edges/{id} so the badge updates without waiting
   * for a full board refresh. */
  updateEdgeData(edgeId: string, partial: Partial<FlowboardEdgeData>): void;
  setNodes(nodes: FlowNode[]): void;
  setEdges(edges: Edge[]): void;
  clearError(): void;

  // ── Undo (Ctrl+Z) ──
  /** Pop and replay the most recent inverse op. No-op if history is empty. */
  undo(): Promise<void>;
  /** True when there's at least one undoable structural edit. */
  canUndo(): boolean;
  /** Record a node-move so it can be reversed. `moves` holds each node's
   *  position *before* the drag. Called by the canvas on drag-stop. */
  recordNodeMoves(moves: { rfId: string; x: number; y: number }[]): void;
  /** Group several structural edits into one undo step (e.g. deleting a
   *  multi-selection). Run the edits inside `fn`; one Ctrl+Z reverses all. */
  runUndoBatch(label: string, fn: () => Promise<void>): Promise<void>;
  /** Manually register an inverse op — for edits that bypass the wrapped
   *  store methods (e.g. bulk duplication that calls createNode directly). */
  recordUndo(label: string, run: () => Promise<void>): void;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  boardId: null,
  boardName: "",
  boards: [],
  nodes: [],
  edges: [],
  loading: false,
  error: null,

  async loadInitialBoard() {
    set({ loading: true, error: null });
    try {
      let boards = await listBoards();
      // Prefer the user's last-active board if it still exists; fall back
      // to the first board in the list. Without this, refresh always
      // snapped back to boards[0] regardless of what was selected before.
      const persistedId = loadPersistedBoardId();
      let board =
        (persistedId !== null && boards.find((b) => b.id === persistedId)) ||
        boards[0];
      if (!board) {
        board = await createBoard("Untitled");
        boards = [board];
      }
      const detail = await getBoard(board.id);

      const nodes: FlowNode[] = detail.nodes.map((n) => ({
        id: String(n.id),
        type: n.type,
        position: { x: n.x, y: n.y },
        data: {
          // Spread the raw payload first so fields without explicit
          // mappings (groupId, frameW/frameH, assistant*, …) survive a
          // board reload; the typed casts below then take precedence.
          ...(n.data as Record<string, unknown>),
          type: n.type,
          shortId: n.short_id,
          title: (n.data["title"] as string | undefined) ?? TYPE_TITLE[n.type],
          status: n.status,
          prompt: n.data["prompt"] as string | undefined,
          thumbnailUrl: n.data["thumbnailUrl"] as string | undefined,
          mediaId: n.data["mediaId"] as string | undefined,
          mediaIds: n.data["mediaIds"] as (string | null)[] | undefined,
          slotErrors: n.data["slotErrors"] as (string | null)[] | undefined,
          variantCount: n.data["variantCount"] as number | undefined,
          aspectRatio: n.data["aspectRatio"] as string | undefined,
          aiBrief: n.data["aiBrief"] as string | undefined,
          imageModel: n.data["imageModel"] as string | undefined,
          videoQuality: n.data["videoQuality"] as string | undefined,
          charCountry: n.data["charCountry"] as string | undefined,
          charVibe: n.data["charVibe"] as string | undefined,
          charGender: n.data["charGender"] as string | undefined,
          storyboardGrid: n.data["storyboardGrid"] as StoryboardGrid | undefined,
        },
      }));

      const edges: Edge[] = assignImageInputHandles(nodes, detail.edges.map(edgeFromDto));

      set({
        boardId: detail.board.id,
        boardName: detail.board.name,
        boards,
        nodes,
        edges,
        loading: false,
      });
      persistBoardId(detail.board.id);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async refreshBoardList() {
    try {
      const boards = await listBoards();
      set({ boards });
    } catch {
      // non-fatal
    }
  },

  async switchBoard(id) {
    if (id === get().boardId) return;
    set({ loading: true, error: null });
    try {
      const detail = await getBoard(id);
      const nodes: FlowNode[] = detail.nodes.map((n) => ({
        id: String(n.id),
        type: n.type,
        position: { x: n.x, y: n.y },
        data: {
          // Spread the raw payload first so fields without explicit
          // mappings (groupId, frameW/frameH, assistant*, …) survive a
          // board reload; the typed casts below then take precedence.
          ...(n.data as Record<string, unknown>),
          type: n.type,
          shortId: n.short_id,
          title: (n.data["title"] as string | undefined) ?? TYPE_TITLE[n.type],
          status: n.status,
          prompt: n.data["prompt"] as string | undefined,
          thumbnailUrl: n.data["thumbnailUrl"] as string | undefined,
          mediaId: n.data["mediaId"] as string | undefined,
          mediaIds: n.data["mediaIds"] as (string | null)[] | undefined,
          slotErrors: n.data["slotErrors"] as (string | null)[] | undefined,
          variantCount: n.data["variantCount"] as number | undefined,
          aspectRatio: n.data["aspectRatio"] as string | undefined,
          aiBrief: n.data["aiBrief"] as string | undefined,
          imageModel: n.data["imageModel"] as string | undefined,
          videoQuality: n.data["videoQuality"] as string | undefined,
          charCountry: n.data["charCountry"] as string | undefined,
          charVibe: n.data["charVibe"] as string | undefined,
          charGender: n.data["charGender"] as string | undefined,
          storyboardGrid: n.data["storyboardGrid"] as StoryboardGrid | undefined,
        },
      }));
      const edges: Edge[] = assignImageInputHandles(nodes, detail.edges.map(edgeFromDto));
      set({
        boardId: detail.board.id,
        boardName: detail.board.name,
        nodes,
        edges,
        loading: false,
      });
      persistBoardId(detail.board.id);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async createNewBoard(name) {
    try {
      const board = await createBoard(name || "Untitled");
      // Add to list (front of list so the newly-created project shows up
      // at the top of the sidebar) and switch to it.
      set((s) => ({ boards: [board, ...s.boards] }));
      await get().switchBoard(board.id);
      return board.id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  async deleteBoardById(id) {
    try {
      await apiDeleteBoard(id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const remaining = get().boards.filter((b) => b.id !== id);
    set({ boards: remaining });
    // If we just deleted the active board, switch to the first remaining
    // board — or create a fresh "Untitled" if none left.
    if (get().boardId === id) {
      if (remaining.length > 0) {
        await get().switchBoard(remaining[0].id);
      } else {
        try {
          const board = await createBoard("Untitled");
          set({ boards: [board] });
          await get().switchBoard(board.id);
        } catch (err) {
          set({ error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  },

  async refreshBoardState() {
    const { boardId } = get();
    if (boardId === null) return;
    try {
      const detail = await getBoard(boardId);
      const nodes: FlowNode[] = detail.nodes.map((n) => ({
        id: String(n.id),
        type: n.type,
        position: { x: n.x, y: n.y },
        data: {
          // Spread the raw payload first so fields without explicit
          // mappings (groupId, frameW/frameH, assistant*, …) survive a
          // board reload; the typed casts below then take precedence.
          ...(n.data as Record<string, unknown>),
          type: n.type,
          shortId: n.short_id,
          title: (n.data["title"] as string | undefined) ?? TYPE_TITLE[n.type],
          status: n.status,
          prompt: n.data["prompt"] as string | undefined,
          thumbnailUrl: n.data["thumbnailUrl"] as string | undefined,
          mediaId: n.data["mediaId"] as string | undefined,
          mediaIds: n.data["mediaIds"] as (string | null)[] | undefined,
          slotErrors: n.data["slotErrors"] as (string | null)[] | undefined,
          variantCount: n.data["variantCount"] as number | undefined,
          aiBrief: n.data["aiBrief"] as string | undefined,
          imageModel: n.data["imageModel"] as string | undefined,
          videoQuality: n.data["videoQuality"] as string | undefined,
          charCountry: n.data["charCountry"] as string | undefined,
          charVibe: n.data["charVibe"] as string | undefined,
          charGender: n.data["charGender"] as string | undefined,
          storyboardGrid: n.data["storyboardGrid"] as StoryboardGrid | undefined,
          error: n.data["error"] as string | undefined,
        },
      }));
      const edges: Edge[] = assignImageInputHandles(nodes, detail.edges.map(edgeFromDto));
      set({ nodes, edges });
    } catch {
      // ignore — leave state alone, next poll will retry
    }
  },

  async renameBoard(name: string) {
    const { boardId } = get();
    if (boardId === null) return;
    try {
      const updated = await apiPatchBoard(boardId, name);
      set((s) => ({
        boardName: updated.name,
        boards: s.boards.map((b) =>
          b.id === boardId ? { ...b, name: updated.name } : b,
        ),
      }));
    } catch {
      // non-fatal; keep local name
    }
  },

  async addNodeOfType(type, position) {
    const { boardId } = get();
    if (boardId === null) return null;
    const title = TYPE_TITLE[type];
    try {
      const dto = await createNode({
        board_id: boardId,
        type,
        x: Math.round(position.x),
        y: Math.round(position.y),
        data: { title },
      });
      const node: FlowNode = {
        id: String(dto.id),
        type: dto.type,
        position: { x: dto.x, y: dto.y },
        data: {
          type: dto.type,
          shortId: dto.short_id,
          title: (dto.data["title"] as string | undefined) ?? title,
          status: dto.status,
        },
      };
      set((s) => ({ nodes: [...s.nodes, node] }));
      pushUndo({
        label: "add node",
        run: async () => {
          await get().deleteNodeByRfId(node.id);
        },
      });
      return node.id;
    } catch (err) {
      // Surface to console so the next "I clicked Add but nothing
      // appeared" report has a breadcrumb in DevTools instead of an
      // empty canvas — a 422 here usually means the backend's NodeType
      // literal is out of sync with the frontend's NodeType union.
      console.error("addNodeOfType failed", { type, err });
    }
    return null;
  },

  async addReferenceNode(ref, position) {
    const { boardId } = get();
    if (boardId === null) return null;
    const title = ref.label || "Reference";
    try {
      const dto = await createNode({
        board_id: boardId,
        type: "visual_asset",
        x: Math.round(position.x),
        y: Math.round(position.y),
        data: {
          title,
          mediaId: ref.mediaId,
          aiBrief: ref.aiBrief ?? undefined,
          aspectRatio: ref.aspectRatio ?? undefined,
          status: "done",
          renderedAt: new Date().toISOString(),
        },
      });
      // Mirror addNodeOfType's local-state insertion, but propagate the
      // rich data fields so the visual_asset body renders the thumbnail
      // straight away (instead of falling into the empty-state CTA).
      const node: FlowNode = {
        id: String(dto.id),
        type: dto.type,
        position: { x: dto.x, y: dto.y },
        data: {
          type: dto.type,
          shortId: dto.short_id,
          title: (dto.data["title"] as string | undefined) ?? title,
          status: "done",
          mediaId: ref.mediaId,
          aiBrief: ref.aiBrief ?? undefined,
          aspectRatio: ref.aspectRatio ?? undefined,
          renderedAt: new Date().toISOString(),
        },
      };
      set((s) => ({ nodes: [...s.nodes, node] }));
      pushUndo({
        label: "add reference",
        run: async () => {
          await get().deleteNodeByRfId(node.id);
        },
      });
      return node.id;
    } catch {
      // surface silently for now
    }
    return null;
  },

  async persistNodePosition(rfId, position) {
    debouncePosition(rfId, async () => {
      const dbId = parseInt(rfId, 10);
      if (isNaN(dbId)) return;
      try {
        await patchNode(dbId, { x: Math.round(position.x), y: Math.round(position.y) });
      } catch {
        // ignore persist failures
      }
    });
  },

  async deleteNodeByRfId(rfId) {
    const dbId = parseInt(rfId, 10);
    if (isNaN(dbId)) return;
    // Cancel any pending debounced patch for this node (it would 404 after delete).
    const pending = positionTimers.get(rfId);
    if (pending !== undefined) {
      clearTimeout(pending);
      positionTimers.delete(rfId);
    }
    // Also cancel any in-flight generation poll — otherwise the poll loop
    // keeps pinging the server about a node that no longer exists.
    // Dynamic import to avoid a circular store dependency at module init.
    try {
      const { useGenerationStore } = await import("./generation");
      useGenerationStore.getState().cancelGeneration(rfId);
    } catch {
      // If the module isn't loaded yet (tree-shaken test path), ignore.
    }
    // Snapshot the node + its connected edges *before* deletion so Ctrl+Z
    // can recreate it (note: the recreated node gets a fresh DB id — see the
    // reference remap in the undo closure below).
    const snapNode = get().nodes.find((n) => n.id === rfId);
    const snapEdges = get().edges.filter(
      (e) => e.source === rfId || e.target === rfId,
    );
    try {
      await deleteNode(dbId);
      set((s) => ({
        nodes: s.nodes.filter((n) => n.id !== rfId),
        edges: s.edges.filter((e) => e.source !== rfId && e.target !== rfId),
      }));
      if (snapNode) {
        const oldId = rfId;
        pushUndo({
          label: "delete node",
          run: async () => {
            const { boardId } = get();
            if (boardId === null) return;
            // Recreate the node — backend hands back a NEW id.
            const dto = await createNode({
              board_id: boardId,
              type: snapNode.data.type,
              x: Math.round(snapNode.position.x),
              y: Math.round(snapNode.position.y),
              data: { ...(snapNode.data as Record<string, unknown>) },
            });
            const newId = String(dto.id);
            const newNode: FlowNode = {
              ...snapNode,
              id: newId,
              position: { x: dto.x, y: dto.y },
              data: { ...snapNode.data, shortId: dto.short_id },
            };
            set((s) => ({ nodes: [...s.nodes, newNode] }));
            // Repoint any image-input slots that referenced the old id.
            for (const n of get().nodes) {
              if (
                Array.isArray(n.data.imageInputs) &&
                (n.data.imageInputs as string[]).includes(oldId)
              ) {
                const slots = (n.data.imageInputs as string[]).map((s) =>
                  s === oldId ? newId : s,
                );
                get().updateNodeData(n.id, { imageInputs: slots });
                const nDb = parseInt(n.id, 10);
                if (!isNaN(nDb))
                  patchNode(nDb, { data: { imageInputs: slots } }).catch(
                    () => {},
                  );
              }
            }
            // Recreate the edges that were attached to the deleted node,
            // mapping the old endpoint to the new id; skip any whose other
            // end no longer exists.
            for (const e of snapEdges) {
              const src = e.source === oldId ? newId : e.source;
              const tgt = e.target === oldId ? newId : e.target;
              const have = (id: string) =>
                get().nodes.some((n) => n.id === id);
              if (have(src) && have(tgt)) {
                await get().addEdgeFromConnection(
                  src,
                  tgt,
                  e.targetHandle ?? null,
                );
              }
            }
          },
        });
      }
    } catch {
      // ignore
    }
  },

  async addEdgeFromConnection(source, target, targetHandle) {
    const { boardId } = get();
    if (boardId === null) return;
    const sourceId = parseInt(source, 10);
    const targetId = parseInt(target, 10);
    if (isNaN(sourceId) || isNaN(targetId)) return;
    try {
      const dto = await createEdge({ board_id: boardId, source_id: sourceId, target_id: targetId });
      const edge = edgeFromDto(dto);

      // Image-input slots (Weavy-style ordered handles): the target image
      // node tracks which source feeds which slot in `data.imageInputs`.
      // Persisted as JSON (no DB schema change); the edge's targetHandle
      // is reconstructed from this array on load.
      const targetNode = get().nodes.find((n) => n.id === target);
      const sourceNode = get().nodes.find((n) => n.id === source);
      // Prompt feeders (Assistant / Prompt / Note) supply text, not an image
      // reference — they must NOT occupy a numbered Image slot, or they'd
      // shift the real refs (Image 1/2/3). resolveImagePrompt picks them up
      // from the upstream edge regardless of handle.
      const sourceIsPromptFeeder =
        sourceNode != null &&
        (sourceNode.data.type === "assistant" ||
          sourceNode.data.type === "prompt" ||
          sourceNode.data.type === "note");
      if (targetNode && targetNode.data.type === "image" && !sourceIsPromptFeeder) {
        const slots: string[] = Array.isArray(targetNode.data.imageInputs)
          ? [...(targetNode.data.imageInputs as string[])]
          : [];
        let slotIdx = -1;
        const m = /^in-(\d+)$/.exec(targetHandle ?? "");
        if (m) slotIdx = parseInt(m[1], 10);
        if (slotIdx < 0) {
          // No explicit slot — drop into the first empty slot, else append.
          slotIdx = slots.findIndex((s) => !s);
          if (slotIdx < 0) slotIdx = slots.length;
        }
        // Grow the array if needed; one source per slot.
        while (slots.length <= slotIdx) slots.push("");
        slots[slotIdx] = source;
        edge.targetHandle = `in-${slotIdx}`;
        get().updateNodeData(target, { imageInputs: slots });
        const dbId = parseInt(target, 10);
        if (!isNaN(dbId)) {
          patchNode(dbId, { data: { imageInputs: slots } }).catch(() => {});
        }
      }

      set((s) => ({ edges: [...s.edges, edge] }));
      pushUndo({
        label: "add edge",
        run: async () => {
          await get().deleteEdgeByRfId(edge.id);
        },
      });
    } catch {
      // ignore
    }
  },

  async cloneNodeWithUpstream(rfId) {
    const { boardId, nodes, edges } = get();
    if (boardId === null) return null;
    const src = nodes.find((n) => n.id === rfId);
    if (!src) return null;

    // Position the clone to the lower-right of the source so it doesn't
    // overlap. Title gets a " (variant)" suffix if not already present so
    // it's easy to tell apart at a glance.
    const offset = { x: 60, y: 60 };
    const newPos = {
      x: Math.round(src.position.x + offset.x),
      y: Math.round(src.position.y + offset.y),
    };
    const baseTitle = src.data.title ?? TYPE_TITLE[src.data.type];
    const newTitle = baseTitle.endsWith("(variant)")
      ? baseTitle
      : `${baseTitle} (variant)`;

    let nodeDto;
    try {
      nodeDto = await createNode({
        board_id: boardId,
        type: src.data.type,
        x: newPos.x,
        y: newPos.y,
        data: { title: newTitle },
      });
    } catch {
      return null;
    }

    const newNode: FlowNode = {
      id: String(nodeDto.id),
      type: nodeDto.type,
      position: { x: nodeDto.x, y: nodeDto.y },
      data: {
        type: nodeDto.type,
        shortId: nodeDto.short_id,
        title: (nodeDto.data["title"] as string | undefined) ?? newTitle,
        status: nodeDto.status,
      },
    };
    set((s) => ({ nodes: [...s.nodes, newNode] }));

    // Replicate upstream edges: every (upstream → src) becomes (upstream → clone).
    const upstreamSourceRfIds = edges
      .filter((e) => e.target === rfId)
      .map((e) => e.source);
    for (const usrc of upstreamSourceRfIds) {
      const sourceId = parseInt(usrc, 10);
      if (isNaN(sourceId)) continue;
      try {
        const eDto = await createEdge({
          board_id: boardId,
          source_id: sourceId,
          target_id: nodeDto.id,
        });
        const newEdge: Edge = {
          id: String(eDto.id),
          source: String(eDto.source_id),
          target: String(eDto.target_id),
        };
        set((s) => ({ edges: [...s.edges, newEdge] }));
      } catch {
        // best-effort — partial edge replication still useful
      }
    }
    return newNode.id;
  },

  async deleteEdgeByRfId(rfId) {
    const dbId = parseInt(rfId, 10);
    if (isNaN(dbId)) return;
    // Clear the freed image-input slot on the target image node.
    const edge = get().edges.find((e) => e.id === rfId);
    if (edge) {
      const t = get().nodes.find((n) => n.id === edge.target);
      if (t && t.data.type === "image" && Array.isArray(t.data.imageInputs)) {
        const slots = (t.data.imageInputs as string[]).map((s) =>
          s === edge.source ? "" : s,
        );
        get().updateNodeData(edge.target, { imageInputs: slots });
        const tDbId = parseInt(edge.target, 10);
        if (!isNaN(tDbId)) patchNode(tDbId, { data: { imageInputs: slots } }).catch(() => {});
      }
    }
    try {
      await deleteEdge(dbId);
      set((s) => ({ edges: s.edges.filter((e) => e.id !== rfId) }));
      if (edge) {
        const snapSource = edge.source;
        const snapTarget = edge.target;
        const snapHandle = edge.targetHandle ?? null;
        pushUndo({
          label: "delete edge",
          run: async () => {
            const have = (id: string) => get().nodes.some((n) => n.id === id);
            if (have(snapSource) && have(snapTarget)) {
              await get().addEdgeFromConnection(
                snapSource,
                snapTarget,
                snapHandle,
              );
            }
          },
        });
      }
    } catch {
      // ignore
    }
  },

  updateNodeData: (rfId, partial) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === rfId ? { ...n, data: { ...n.data, ...partial } } : n,
      ),
    })),
  updateEdgeData: (edgeId, partial) =>
    set((s) => ({
      edges: s.edges.map((e) =>
        e.id === edgeId
          ? { ...e, data: { ...(e.data ?? {}), ...partial } }
          : e,
      ),
    })),
  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  clearError: () => set({ error: null }),

  canUndo: () => undoStack.length > 0,

  recordUndo: (label, run) => pushUndo({ label, run }),

  async undo() {
    const op = undoStack.pop();
    if (!op) return;
    undoSuppressed = true;
    try {
      await op.run();
    } catch (err) {
      console.error("undo failed", { label: op.label, err });
    } finally {
      undoSuppressed = false;
    }
  },

  recordNodeMoves(moves) {
    if (moves.length === 0) return;
    pushUndo({
      label: "move",
      run: async () => {
        set((s) => ({
          nodes: s.nodes.map((n) => {
            const mv = moves.find((m) => m.rfId === n.id);
            return mv ? { ...n, position: { x: mv.x, y: mv.y } } : n;
          }),
        }));
        for (const m of moves) {
          const dbId = parseInt(m.rfId, 10);
          if (!isNaN(dbId)) {
            patchNode(dbId, { x: Math.round(m.x), y: Math.round(m.y) }).catch(
              () => {},
            );
          }
        }
      },
    });
  },

  async runUndoBatch(label, fn) {
    // Re-entrant guard: nested batches just flow into the outer one.
    if (batchDepth > 0) {
      await fn();
      return;
    }
    batchDepth++;
    batchBuffer = [];
    try {
      await fn();
    } finally {
      const ops = batchBuffer;
      batchBuffer = [];
      batchDepth--;
      if (ops.length === 1) {
        pushUndo(ops[0]);
      } else if (ops.length > 1) {
        // Replay the collected inverses in reverse order so the canvas
        // unwinds in the same way it was built up.
        pushUndo({
          label,
          run: async () => {
            for (let i = ops.length - 1; i >= 0; i--) await ops[i].run();
          },
        });
      }
    }
  },
}));
