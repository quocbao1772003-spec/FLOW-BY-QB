import {
  createBoard,
  createEdge,
  createNode,
  getBoard,
  type NodeType,
} from "../api/client";
import { useBoardStore } from "../store/board";

// Export / import a whole flow (board) as JSON so workflows can be shared.
//
// What travels: node types, positions, all node `data` (prompts, model,
// aspect, variant count, image-input order, etc.) and edges (with variant
// pins). What does NOT travel reliably: generated media — `mediaId`s are
// scoped to the original user's Flow project, so on another machine the
// images won't resolve. The shared value is the WORKFLOW (prompts +
// structure); recipients re-generate the images.

const FORMAT = "flowboard.flow";
const FORMAT_VERSION = 1;

interface ExportedNode {
  ref: string; // original node id (used to rewire edges on import)
  type: NodeType;
  x: number;
  y: number;
  data: Record<string, unknown>;
}
interface ExportedEdge {
  source: string;
  target: string;
  kind?: string;
  sourceVariantIdx?: number | null;
}
export interface ExportedFlow {
  format: typeof FORMAT;
  version: number;
  name: string;
  exportedAt: string;
  nodes: ExportedNode[];
  edges: ExportedEdge[];
}

// Data keys that shouldn't be carried into another environment.
const STRIP_KEYS = new Set([
  "status",
  "renderedAt",
  "autoPromptStatus",
  "aiBriefStatus",
]);

function cleanData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (STRIP_KEYS.has(k) || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** Build the export JSON for a given board (defaults to the active one). */
export async function exportFlow(boardId?: number): Promise<ExportedFlow> {
  const id = boardId ?? useBoardStore.getState().boardId;
  if (id == null) throw new Error("No board to export");
  const detail = await getBoard(id);
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    name: detail.board.name || "Untitled",
    exportedAt: new Date().toISOString(),
    nodes: detail.nodes.map((n) => ({
      ref: String(n.id),
      type: n.type,
      x: n.x,
      y: n.y,
      data: cleanData(n.data),
    })),
    edges: detail.edges.map((e) => ({
      source: String(e.source_id),
      target: String(e.target_id),
      kind: e.kind,
      sourceVariantIdx: e.source_variant_idx,
    })),
  };
}

/** Trigger a browser download of a board's flow JSON. */
export async function downloadFlow(boardId?: number): Promise<void> {
  const flow = await exportFlow(boardId);
  const safe = flow.name.replace(/[^A-Za-z0-9_-]+/g, "_") || "flow";
  const blob = new Blob([JSON.stringify(flow, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safe}.flow.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Create a brand-new board from an exported flow JSON. Returns its id. */
export async function importFlow(raw: unknown): Promise<number> {
  const flow = raw as ExportedFlow;
  if (!flow || flow.format !== FORMAT || !Array.isArray(flow.nodes)) {
    throw new Error("File không hợp lệ — không phải flow JSON của Flowboard.");
  }
  const board = await createBoard(`${flow.name} (imported)`);

  // 1. Create nodes; map old ref → new node id.
  const idMap = new Map<string, string>();
  for (const n of flow.nodes) {
    // imageInputs holds old refs — remapped in a second pass once all
    // ids are known (set empty for now).
    const data = { ...n.data };
    const dto = await createNode({
      board_id: board.id,
      type: n.type,
      x: n.x,
      y: n.y,
      data,
    });
    idMap.set(n.ref, String(dto.id));
  }

  // 2. Remap imageInputs (slot → source ref) to new ids + persist.
  const { patchNode } = await import("../api/client");
  for (const n of flow.nodes) {
    const slots = n.data.imageInputs;
    if (Array.isArray(slots)) {
      const remapped = (slots as string[]).map((s) => (s ? idMap.get(s) ?? "" : ""));
      const newId = idMap.get(n.ref);
      if (newId) {
        const dbId = parseInt(newId, 10);
        if (!isNaN(dbId)) {
          await patchNode(dbId, { data: { imageInputs: remapped } }).catch(() => {});
        }
      }
    }
  }

  // 3. Recreate edges with remapped source/target.
  for (const e of flow.edges) {
    const src = idMap.get(e.source);
    const tgt = idMap.get(e.target);
    if (!src || !tgt) continue;
    const sId = parseInt(src, 10);
    const tId = parseInt(tgt, 10);
    if (isNaN(sId) || isNaN(tId)) continue;
    await createEdge({
      board_id: board.id,
      source_id: sId,
      target_id: tId,
      kind: e.kind,
      source_variant_idx: e.sourceVariantIdx ?? null,
    }).catch(() => {});
  }

  return board.id;
}
