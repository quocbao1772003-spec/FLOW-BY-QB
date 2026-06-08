import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { mediaUrl } from "../api/client";

/**
 * Fullscreen image preview with zoom + pan.
 *
 * Controls:
 *   - Mouse wheel: zoom in/out (anchored at cursor)
 *   - +/- buttons: stepped zoom
 *   - Drag: pan
 *   - Double-click: reset to fit
 *   - Esc: close
 *   - 0: reset
 */

interface Props {
  mediaId: string;
  title?: string;
  onClose: () => void;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.2;

export function FullscreenImageViewer({ mediaId, title, onClose }: Props) {
  // `zoom` is a multiplier on the natural "fit" size. 1.0 = fit-to-screen.
  const [zoom, setZoom] = useState(1);
  // `pan` is the offset in pixels from centered.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback((delta: number, cursor?: { x: number; y: number }) => {
    setZoom((prev) => {
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev + delta));
      // Anchor zoom at the cursor — adjust pan so the point under
      // the cursor stays under the cursor after the zoom.
      if (cursor && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const cx = cursor.x - rect.left - rect.width / 2;
        const cy = cursor.y - rect.top - rect.height / 2;
        const factor = next / prev;
        setPan((p) => ({
          x: cx - (cx - p.x) * factor,
          y: cy - (cy - p.y) * factor,
        }));
      }
      return next;
    });
  }, []);

  // Keyboard + scroll lock
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "0") {
        e.preventDefault();
        reset();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomBy(ZOOM_STEP);
      } else if (e.key === "-") {
        e.preventDefault();
        zoomBy(-ZOOM_STEP);
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, reset, zoomBy]);

  // Wheel zoom
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
      zoomBy(delta, { x: e.clientX, y: e.clientY });
    },
    [zoomBy],
  );

  // Drag-to-pan
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return; // left click only
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  }, [pan]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPan({ x: d.panX + (e.clientX - d.startX), y: d.panY + (e.clientY - d.startY) });
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.96)",
        zIndex: 2147483646,
        display: "flex",
        flexDirection: "column",
        color: "#e4e7ec",
        fontFamily: "system-ui, sans-serif",
      }}
      onClick={(e) => {
        // Only the dark backdrop closes (clicks on toolbars / image
        // don't bubble here because they call stopPropagation).
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "14px 18px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={iconBtnStyle()}
        >
          ✕
        </button>
        {title && (
          <span style={{ fontSize: 13, color: "#c9cdd6" }}>{title}</span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button
            type="button"
            onClick={() => zoomBy(-ZOOM_STEP)}
            title="Zoom out (-)"
            style={iconBtnStyle()}
          >
            −
          </button>
          <button
            type="button"
            onClick={reset}
            title="Reset (0)"
            style={{
              ...iconBtnStyle(),
              minWidth: 64,
              fontSize: 12,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => zoomBy(ZOOM_STEP)}
            title="Zoom in (+)"
            style={iconBtnStyle()}
          >
            +
          </button>
        </div>
      </div>

      {/* Image area */}
      <div
        ref={containerRef}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onDoubleClick={reset}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          cursor: dragRef.current ? "grabbing" : "grab",
          userSelect: "none",
        }}
      >
        <img
          src={mediaUrl(mediaId)}
          alt="Preview"
          draggable={false}
          style={{
            maxWidth: "92vw",
            maxHeight: "82vh",
            objectFit: "contain",
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "center center",
            transition: dragRef.current ? "none" : "transform 0.08s ease-out",
            pointerEvents: "none",
            willChange: "transform",
          }}
        />
      </div>

      {/* Footer hint */}
      <div
        style={{
          padding: "10px 18px",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          fontSize: 11,
          color: "#5a5f69",
          display: "flex",
          gap: 16,
          fontFamily: "ui-monospace, monospace",
          justifyContent: "center",
        }}
      >
        <span>Scroll: Zoom</span>
        <span>Drag: Pan</span>
        <span>Double-click: Reset</span>
        <span>+/−: Zoom</span>
        <span>0: Reset</span>
        <span>Esc: Close</span>
      </div>
    </div>,
    document.body,
  );
}

function iconBtnStyle(): React.CSSProperties {
  return {
    width: 32,
    height: 32,
    minWidth: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(255,255,255,0.06)",
    color: "#e4e7ec",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 16,
    fontFamily: "inherit",
  };
}
