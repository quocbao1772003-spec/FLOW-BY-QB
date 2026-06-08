import { useEffect, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { useBoardStore, type NodeType } from "../store/board";
import { groupSelectedNodes } from "./SelectionToolbar";
import { IconFrame, IconPlus, NodeTypeIcon } from "./icons";

// Floating left toolbar (ui/INTERACTION_SPEC.md §4) — only tools that
// have real behavior today: Add(+), Select (V), Hand (H), Group (G).
// Active tool: surface-2 bg + white icon; inactive: transparent + fg-3.

export type InteractionMode = "select" | "hand";

const ADD_CHIPS: Array<{ type: NodeType; icon: string; label: string }> = [
  { type: "character", icon: "◎", label: "Character" },
  { type: "image", icon: "▣", label: "Image" },
  { type: "Storyboard", icon: "▦", label: "Storyboard" },
  { type: "video", icon: "▶", label: "Video" },
  { type: "visual_asset", icon: "◇", label: "Visual asset" },
  { type: "prompt", icon: "✦", label: "Prompt" },
  { type: "note", icon: "✎", label: "Note" },
  { type: "assistant", icon: "✨", label: "Assistant" },
];

function SelectIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M5.5 3.21v17.58c0 .45.54.67.85.35l4.86-4.86 2.16 5.25c.2.48.76.71 1.24.51l1.84-.76c.48-.2.71-.76.51-1.24l-2.18-5.27h6.91c.45 0 .67-.54.35-.85L6.35 2.85a.5.5 0 00-.85.36z" />
    </svg>
  );
}

function HandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12.5 2a1.5 1.5 0 011.5 1.5V10h1V4.5a1.5 1.5 0 013 0V12h1V7.5a1.5 1.5 0 013 0v7.6c0 3.8-2.9 6.9-6.7 6.9h-1.6c-2 0-3.9-.9-5.1-2.5l-4-5.2a1.6 1.6 0 012.4-2.1l1.9 1.9V5a1.5 1.5 0 013 0v5h1V3.5A1.5 1.5 0 0112.5 2z" />
    </svg>
  );
}

export function LeftToolbar({
  mode,
  onModeChange,
}: {
  mode: InteractionMode;
  onModeChange: (m: InteractionMode) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);
  const hasGroupableSelection = useBoardStore(
    (s) => s.nodes.filter((n) => n.selected && n.data.type !== "group").length >= 2,
  );

  // Close the add menu on outside click.
  useEffect(() => {
    if (!addOpen) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setAddOpen(false);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [addOpen]);

  function handleAdd(type: NodeType) {
    setAddOpen(false);
    const position = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    void addNodeOfType(type, position);
  }

  return (
    <div className="left-toolbar" ref={rootRef} role="toolbar" aria-label="Canvas tools">
      <button
        type="button"
        className={`left-toolbar__btn${addOpen ? " left-toolbar__btn--active" : ""}`}
        title="Add node"
        aria-label="Add node"
        onClick={() => setAddOpen((o) => !o)}
      >
        <IconPlus size={15} />
      </button>
      {addOpen && (
        <div className="left-toolbar__menu" role="menu">
          {ADD_CHIPS.map((chip) => (
            <button
              key={chip.type}
              type="button"
              role="menuitem"
              onClick={() => handleAdd(chip.type)}
            >
              <span aria-hidden="true"><NodeTypeIcon type={chip.type} size={13} /></span>
              {chip.label}
            </button>
          ))}
        </div>
      )}
      <span className="left-toolbar__sep" aria-hidden="true" />
      <button
        type="button"
        className={`left-toolbar__btn${mode === "select" ? " left-toolbar__btn--active" : ""}`}
        title="Select (V) — drag to box-select; Shift+click to multi-select"
        aria-label="Select tool"
        onClick={() => onModeChange("select")}
      >
        <SelectIcon />
      </button>
      <button
        type="button"
        className={`left-toolbar__btn${mode === "hand" ? " left-toolbar__btn--active" : ""}`}
        title="Hand (H) — drag to pan; hold Space for temporary pan"
        aria-label="Hand tool"
        onClick={() => onModeChange("hand")}
      >
        <HandIcon />
      </button>
      <span className="left-toolbar__sep" aria-hidden="true" />
      <button
        type="button"
        className="left-toolbar__btn"
        title="Group selection (G)"
        aria-label="Group selection"
        disabled={!hasGroupableSelection}
        onClick={() => void groupSelectedNodes()}
      >
        <IconFrame size={14} />
      </button>
    </div>
  );
}
