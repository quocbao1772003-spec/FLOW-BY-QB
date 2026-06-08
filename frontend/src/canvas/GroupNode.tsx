import { type NodeProps } from "@xyflow/react";
import { type FlowNode } from "../store/board";

// Convert "#rrggbb" → "rgba(r,g,b,a)" for the frame's translucent fill.
function tint(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(59, 130, 246, ${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Visual frame node ("group") — sized to the selection bounding box when
// created from the SelectionToolbar. Renders behind its members (Board
// assigns zIndex -1), so clicks inside still hit the member nodes; the
// frame itself is grabbed via its border / label / empty areas. Dragging
// the frame moves every member node (see Board's onNodeDrag* handlers).
export function GroupNodeCard({ data, selected }: NodeProps<FlowNode>) {
  const w = typeof data.frameW === "number" ? data.frameW : 400;
  const h = typeof data.frameH === "number" ? data.frameH : 300;
  const color = (data.color as string | undefined) ?? "#3b82f6";
  const locked = data.locked === true;
  return (
    <div
      className={`group-frame${selected ? " group-frame--selected" : ""}`}
      style={{
        width: w,
        height: h,
        borderColor: selected ? color : tint(color, 0.55),
        background: tint(color, 0.05),
        boxShadow: selected
          ? `0 0 0 1px ${color}, 0 0 18px ${tint(color, 0.2)}`
          : undefined,
      }}
    >
      <div className="group-frame__label">
        {locked && <span aria-hidden="true">🔒 </span>}
        {data.title || "New group"}
      </div>
    </div>
  );
}
