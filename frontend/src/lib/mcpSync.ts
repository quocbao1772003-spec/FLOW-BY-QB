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
  focus_board_id: number | null;
  focus_seq: number;
}

async function reloadKeepingLocalState() {
  const store = useBoardStore.getState();
  const prev = new Map(store.nodes.map((n) => [n.id, n]));
  const active = useGenerationStore.getState().active;
  await store.refreshBoardState();
  // Keep selection and the in-memory status of generations the UI itself
  // is still polling (those aren't persisted until they finish).
  useBoardStore.setState((s) => ({
    nodes: s.nodes.map((n) => {
      const old = prev.get(n.id);
      if (!old) return n;
      const next = { ...n, selected: old.selected };
      if (active[n.id]) {
        next.data = {
          ...n.data,
          status: old.data.status,
          variantCount: old.data.variantCount,
          prompt: old.data.prompt ?? n.data.prompt,
        };
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
          } else if (rev !== null && snap.rev !== rev && store.boardId !== null) {
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
