import { useState } from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import { useBoardStore } from "../store/board";
import { IconMap, IconPlus } from "./icons";

// Canvas footer (ui/design_system.md §2.8 + INTERACTION_SPEC.md §6):
// left — board ("page") tabs + add; right — minimap toggle + zoom
// indicator with a preset dropdown (5/10/25/50/100/200% + Fit).
// Rendered inside the canvas wrapper, overlaying the bottom edge.

const ZOOM_PRESETS = [0.05, 0.1, 0.25, 0.5, 1, 2];

export function FooterControls({
  showMiniMap,
  onToggleMiniMap,
}: {
  showMiniMap: boolean;
  onToggleMiniMap: () => void;
}) {
  const boards = useBoardStore((s) => s.boards);
  const boardId = useBoardStore((s) => s.boardId);
  const switchBoard = useBoardStore((s) => s.switchBoard);
  const createNewBoard = useBoardStore((s) => s.createNewBoard);

  const zoom = useStore((s) => s.transform[2]);
  const { zoomTo, fitView } = useReactFlow();
  const [zoomOpen, setZoomOpen] = useState(false);

  return (
    <>
      <div className="footer-controls footer-controls--left">
        {boards.map((b) => (
          <button
            key={b.id}
            type="button"
            className={`footer-tab${b.id === boardId ? " footer-tab--active" : ""}`}
            onClick={() => void switchBoard(b.id)}
            title={b.name}
          >
            {b.name || "Untitled"}
          </button>
        ))}
        <button
          type="button"
          className="footer-tab footer-tab--add"
          onClick={() => void createNewBoard("Untitled")}
          title="New board"
          aria-label="New board"
        >
          <IconPlus size={13} />
        </button>
      </div>

      <div className="footer-controls footer-controls--right">
        <button
          type="button"
          className={`footer-btn${showMiniMap ? " footer-btn--active" : ""}`}
          onClick={onToggleMiniMap}
          title={showMiniMap ? "Hide minimap" : "Show minimap"}
          aria-label="Toggle minimap"
        >
          <IconMap size={14} />
        </button>
        <span style={{ position: "relative", display: "inline-flex" }}>
          <button
            type="button"
            className="footer-btn footer-btn--zoom"
            onClick={() => setZoomOpen((o) => !o)}
            title="Zoom"
            aria-label="Zoom level"
          >
            {Math.round(zoom * 100)}%
          </button>
          {zoomOpen && (
            <div className="footer-zoom-menu" role="menu">
              {ZOOM_PRESETS.map((z) => (
                <button
                  key={z}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setZoomOpen(false);
                    void zoomTo(z, { duration: 200 });
                  }}
                >
                  {Math.round(z * 100)}%
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setZoomOpen(false);
                  void fitView({ duration: 200, padding: 0.15 });
                }}
              >
                Fit (F)
              </button>
            </div>
          )}
        </span>
      </div>
    </>
  );
}
