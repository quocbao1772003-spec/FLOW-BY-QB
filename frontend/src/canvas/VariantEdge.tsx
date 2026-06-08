import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import { useBoardStore } from "../store/board";
import { IconScissors } from "./icons";

/**
 * Edge variant: draws the standard bezier line plus a small chip at the
 * midpoint when the edge has a variant pin.
 *
 * The pin (`data.sourceVariantIdx`) records which variant of the
 * upstream multi-variant node this edge consumes — set when the user
 * clicks a specific variant tile to bind it to a downstream. The label
 * surfaces that binding so it stays visible on the graph instead of
 * being hidden in node data.
 *
 * Edges without a pin (single-variant sources, or unconfigured
 * multi-variant edges still defaulting to mediaId) render exactly the
 * way the previous default edge did — only the chip is additive.
 */
export function VariantEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
  selected,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const pin = (data?.sourceVariantIdx ?? null) as number | null;

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      {/* Cut button — Magnific-style scissors at the midpoint when the
          edge is selected. Click = disconnect the two nodes. */}
      {selected && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="edge-cut-btn nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            onClick={(e) => {
              e.stopPropagation();
              void useBoardStore.getState().deleteEdgeByRfId(id);
            }}
            title="Cut connection"
            aria-label="Cut connection"
          >
            <IconScissors size={12} />
          </button>
        </EdgeLabelRenderer>
      )}
      {pin !== null && pin >= 0 && (
        <EdgeLabelRenderer>
          <div
            // The chip sits centered on the bezier midpoint and ignores
            // pointer events so it doesn't shadow the edge's invisible
            // hit area (selection / delete still work as before).
            className="variant-edge-pin"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            v{pin + 1}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
