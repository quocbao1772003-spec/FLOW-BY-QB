import { useEffect } from "react";
import { useBoardStore } from "../store/board";
import { useGenerationStore } from "../store/generation";
import { useViewStore } from "../store/view";

// Live sync with external controllers (Claude / ChatGPT through the
// Flowboard MCP server). The agent bumps `rev` after every change made via
// MCP; we reload the board when it moves. `focus_seq` changes when the AI
// asks the UI to open a specific board.

interface SyncSnapshot {
  rev: number;
  board_ids?: number[];
  focus_board_id: number | null;
  focus_seq: number;
}

// Fields a generation writes onto its node. The UI holds the fresh values in
// memory first and persists them with a PATCH a moment later; a reload that
// lands in between would read the OLD image from the server and show the
// previous result instead of the new one.
const MEDIA_FIELDS = [
  "mediaId", "mediaIds", "slotErrors", "variantCount", "aspectRatio",
  "renderedAt", "imageModel", "videoQuality", "flowAccount", "error", "prompt",
] as const;

function isNewer(local: unknown, server: unknown): boolean {
  if (typeof local !== "string" || !local) return false;
  if (typeof server !== "string" || !server) return true;
  return Date.parse(local) > Date.parse(server);
}

async function reloadKeepingLocalState() {
  const store = useBoardStore.getState();
  const prev = new Map(store.nodes.map((n) => [n.id, n]));
  await store.refreshBoardState();
  // Read `active` AFTER the fetch: a generation may have finished while the
  // request was in flight.
  const active = useGenerationStore.getState().active;
  useBoardStore.setState((s) => ({
    nodes: s.nodes.map((n) => {
      const old = prev.get(n.id);
      if (!old) return n;
      const next = { ...n, selected: old.selected };
      // Still generating in this tab, or finished here more recently than
      // what the server has: the local copy is the truth — keep it whole so
      // the node neither flips back to the previous image nor feeds a stale
      // image as reference into the next node.
      const keepLocal = !!active[n.id]
        || isNewer(old.data.renderedAt, n.data.renderedAt);
      if (keepLocal) {
        const data: Record<string, unknown> = { ...n.data };
        for (const k of MEDIA_FIELDS) data[k] = (old.data as Record<string, unknown>)[k];
        data.status = old.data.status;
        next.data = data as typeof n.data;
      }
      return next;
    }),
  }));
  void store.refreshBoardList();
}

export function useMcpSync() {
  useEffect(() => {
    let rev: number | null = null;
    let focusSeq: number | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const res = await fetch("/api/sync");
        if (res.ok) {
          const snap = (await res.json()) as SyncSnapshot;
          const store = useBoardStore.getState();
          if (focusSeq !== null && snap.focus_seq !== focusSeq && snap.focus_board_id) {
            await store.refreshBoardList();
            if (snap.focus_board_id !== store.boardId) {
              await store.switchBoard(snap.focus_board_id);
            } else {
              await reloadKeepingLocalState();
            }
            const view = useViewStore.getState();
            if (view.view !== "canvas") view.setView("canvas");
          } else if (
            rev !== null && snap.rev !== rev && store.boardId !== null
            // Only reload for a change on the board that is open here (an
            // empty list means "unknown", so reload to be safe).
            && (!snap.board_ids?.length || snap.board_ids.includes(store.boardId))
          ) {
            await reloadKeepingLocalState();
          }
          rev = snap.rev;
          focusSeq = snap.focus_seq;
        }
      } catch {
        // agent offline — keep polling quietly
      }
      if (!stopped) timer = setTimeout(tick, document.hidden ? 4000 : 1500);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
}
