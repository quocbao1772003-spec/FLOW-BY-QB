import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { mediaUrl, patchNode, uploadImage } from "../api/client";
import { useBoardStore } from "../store/board";
import { useGenerationStore } from "../store/generation";
import {
  IconArrowUp,
  IconClose,
  IconCrop,
  IconSparkles,
  IconSpinner,
} from "../canvas/icons";

/**
 * Magnific-style Image Editor modal.
 *
 * Tools:
 *   1. PROMPT — text-driven edit via Flowboard's existing refineImage
 *      (the same backend the visual_asset "Refine" panel uses).
 *   2. CROP — interactive crop frame with 8 handles (4 corners + 4
 *      edges), aspect-ratio presets, and live pixel dimensions.
 *      Applied client-side via Canvas + re-upload.
 *   3. ROTATE — straighten slider + flip H/V, also Canvas + re-upload.
 *
 * Save flow for Crop / Rotate:
 *   transform image on canvas → toBlob → uploadImage → updateNodeData
 *   (local) + patchNode (server). Modal closes when save succeeds.
 */

interface Props {
  rfId: string;
  mediaId: string;
  onClose: () => void;
  /** Which tool tab to open with (defaults to the AI-prompt tool). */
  initialTool?: "prompt" | "crop";
}

type Tool = "prompt" | "crop";

// Aspect-ratio presets matching what Magnific surfaces. `null` = Free.
type AspectPreset = {
  key: string;
  label: string;
  ratio: number | null;
};
const ASPECT_PRESETS: AspectPreset[] = [
  { key: "free", label: "Custom", ratio: null },
  { key: "1:1", label: "1:1", ratio: 1 },
  { key: "21:9", label: "21:9", ratio: 21 / 9 },
  { key: "16:9", label: "16:9", ratio: 16 / 9 },
  { key: "9:16", label: "9:16", ratio: 9 / 16 },
  { key: "2:3", label: "2:3", ratio: 2 / 3 },
  { key: "3:4", label: "3:4", ratio: 3 / 4 },
  { key: "4:3", label: "4:3", ratio: 4 / 3 },
  { key: "3:2", label: "3:2", ratio: 3 / 2 },
  { key: "4:5", label: "4:5", ratio: 4 / 5 },
  { key: "5:4", label: "5:4", ratio: 5 / 4 },
];

export function ImageEditModal({ rfId, mediaId, onClose, initialTool }: Props) {
  const [tool, setTool] = useState<Tool>(initialTool ?? "prompt");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ensureProjectId = useGenerationStore((s) => s.ensureProjectId);
  const refineImage = useGenerationStore((s) => s.refineImage);
  const updateNodeData = useBoardStore((s) => s.updateNodeData);

  // ── Natural dimensions of the source image (for px display) ────────
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = mediaUrl(mediaId);
  }, [mediaId]);

  // ── Esc + scroll lock ────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // ── Common save path: canvas transform → blob → upload → replace ──
  const replaceWithCanvas = useCallback(
    async (transform: (img: HTMLImageElement) => HTMLCanvasElement): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const projectId = await ensureProjectId();
        if (!projectId) throw new Error("Flow project not ready — open labs.google/fx/tools/flow tab");
        const img = await loadImage(mediaUrl(mediaId));
        const canvas = transform(img);
        const blob: Blob = await new Promise((resolve, reject) => {
          canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
            "image/png",
            0.95,
          );
        });
        const file = new File([blob], `edit-${Date.now()}.png`, { type: "image/png" });
        const dbId = parseInt(rfId, 10);
        const uploaded = await uploadImage(
          file,
          projectId,
          isNaN(dbId) ? undefined : dbId,
        );
        // Local-state update FIRST so the canvas re-renders before
        // the network round-trip to patchNode completes.
        updateNodeData(rfId, {
          mediaId: uploaded.media_id,
          mediaIds: [uploaded.media_id],
          variantCount: 1,
          aiBrief: null,
          aspectRatio: uploaded.aspect_ratio,
          status: "done",
        });
        if (!isNaN(dbId)) {
          await patchNode(dbId, {
            status: "done",
            data: {
              mediaId: uploaded.media_id,
              mediaIds: [uploaded.media_id],
              variantCount: 1,
              aiBrief: null,
              aspectRatio: uploaded.aspect_ratio,
              renderedAt: new Date().toISOString(),
            },
          }).catch((err) => {
            console.warn("patchNode failed (local state already updated):", err);
          });
        }
        onClose();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Image edit save failed:", err);
        setError(msg);
      } finally {
        setBusy(false);
      }
    },
    [rfId, mediaId, ensureProjectId, updateNodeData, onClose],
  );

  // ── PROMPT tool ───────────────────────────────────────────────────
  const [prompt, setPrompt] = useState("");
  const handlePromptRun = useCallback(async () => {
    const t = prompt.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      await refineImage(rfId, { prompt: t, refMediaIds: [] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [prompt, rfId, refineImage, onClose]);

  // ── FLIP (merged into the crop page) ──────────────────────────────
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);

  // ── CROP tool ─────────────────────────────────────────────────────
  // Stored as fractions of the natural image so resize-invariant.
  // Start with the crop box filling the whole image — no crop until the
  // user drags a handle. (Was 80% centered, which looked like a crop was
  // already applied on open.)
  const [cropFrac, setCropFrac] = useState({ x: 0, y: 0, w: 1, h: 1 });
  const [aspectKey, setAspectKey] = useState<string>("free");
  const aspectRatio = useMemo(
    () => ASPECT_PRESETS.find((p) => p.key === aspectKey)?.ratio ?? null,
    [aspectKey],
  );

  // When the user picks an aspect preset, snap the current crop to it
  // (centred). Free preset just leaves the box alone.
  useEffect(() => {
    if (!aspectRatio || !naturalSize) return;
    // Use image-aspect-corrected ratio so 1:1 visually is 1:1 in
    // natural pixels too.
    const imgAspect = naturalSize.w / naturalSize.h;
    const cropAspectInImageSpace = aspectRatio / imgAspect; // because we work in fractional space
    let newW = cropFrac.w;
    let newH = newW / cropAspectInImageSpace;
    if (newH > 0.98) {
      newH = 0.98;
      newW = newH * cropAspectInImageSpace;
    }
    if (newW > 0.98) {
      newW = 0.98;
      newH = newW / cropAspectInImageSpace;
    }
    setCropFrac({
      x: Math.max(0, 0.5 - newW / 2),
      y: Math.max(0, 0.5 - newH / 2),
      w: newW,
      h: newH,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspectKey, naturalSize?.w, naturalSize?.h]);

  const handleCropApply = useCallback(() => {
    void replaceWithCanvas((img) => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const sx = clamp(cropFrac.x * w, 0, w - 1);
      const sy = clamp(cropFrac.y * h, 0, h - 1);
      const sw = clamp(cropFrac.w * w, 1, w - sx);
      const sh = clamp(cropFrac.h * h, 1, h - sy);
      // Flip the full image first (matches the flipped preview the crop
      // box was drawn over), then cut the selected region from it.
      const full = document.createElement("canvas");
      full.width = w;
      full.height = h;
      const fctx = full.getContext("2d")!;
      fctx.translate(flipH ? w : 0, flipV ? h : 0);
      fctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
      fctx.drawImage(img, 0, 0);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(sw);
      canvas.height = Math.round(sh);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
      return canvas;
    });
  }, [cropFrac, flipH, flipV, replaceWithCanvas]);

  // Pixel dimensions of the current crop (for the toolbar display).
  const cropPx = naturalSize
    ? {
        w: Math.round(cropFrac.w * naturalSize.w),
        h: Math.round(cropFrac.h * naturalSize.h),
      }
    : null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(16, 16, 16, 0.97)",
        zIndex: 2147483646,
        display: "flex",
        flexDirection: "column",
        fontFamily: "inherit",
        color: "var(--fg-1, #e3e3e3)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Header — Magnific-style slim strip: ✕ + title */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "10px 16px",
          background: "#1f1f22",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{ ...iconBtnStyle(), display: "inline-flex" }}
        >
          <IconClose size={15} />
        </button>
        <span style={{ fontWeight: 600, fontSize: 13, color: "var(--fg-0, #f5f5f5)" }}>
          Image Editor
        </span>
        {naturalSize && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--fg-4, #737373)", fontFamily: "ui-monospace, monospace" }}>
            {naturalSize.w} × {naturalSize.h} px
          </span>
        )}
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        {tool === "crop" ? (
          <CropCanvas
            mediaId={mediaId}
            naturalSize={naturalSize}
            crop={cropFrac}
            aspectRatio={aspectRatio}
            flipH={flipH}
            flipV={flipV}
            onChange={setCropFrac}
          />
        ) : (
          <img
            src={mediaUrl(mediaId)}
            alt="Edit preview"
            style={{
              maxWidth: "min(900px, 80vw)",
              maxHeight: "70vh",
              objectFit: "contain",
              borderRadius: 6,
            }}
          />
        )}
      </div>

      {/* Footer — Magnific-style floating control bar + tool switcher */}
      <div
        style={{
          background: "transparent",
          padding: "0 14px 16px",
        }}
      >
        {tool === "prompt" && (
          <div style={floatingBarStyle(720)}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                // Keep all typing (incl. Space / arrows) inside the field —
                // stop it reaching document-level handlers like the
                // ResultViewer's variant navigation that ate the spaces.
                e.stopPropagation();
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void handlePromptRun();
                }
              }}
              placeholder="What do you want to change?"
              rows={1}
              disabled={busy}
              style={{
                flex: 1,
                background: "transparent",
                color: "var(--fg-0, #f5f5f5)",
                border: "none",
                padding: "10px 6px",
                fontFamily: "inherit",
                fontSize: 13,
                resize: "none",
                outline: "none",
                lineHeight: 1.5,
              }}
            />
            <button
              type="button"
              onClick={handlePromptRun}
              disabled={busy || !prompt.trim()}
              style={circleSubmitStyle(busy || !prompt.trim())}
              aria-label="Apply edit"
              title="Apply edit (Ctrl+Enter)"
            >
              {busy ? <IconSpinner size={13} /> : <IconArrowUp size={14} />}
            </button>
          </div>
        )}

        {tool === "crop" && (
          <div style={floatingBarStyle(760)}>
            {/* Aspect preset — Magnific's "Custom ⌄" dropdown */}
            <select
              value={aspectKey}
              onChange={(e) => setAspectKey(e.target.value)}
              disabled={busy}
              aria-label="Aspect preset"
              style={{
                background: "rgba(255,255,255,0.06)",
                color: "var(--fg-1, #e3e3e3)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 999,
                padding: "6px 12px",
                fontSize: 12,
                fontFamily: "inherit",
                outline: "none",
                cursor: "pointer",
              }}
            >
              {ASPECT_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
            {/* Pixel dimensions — readout chips like Magnific's ↔/↕ fields */}
            {cropPx && (
              <span style={pxChipStyle()}>↔ {cropPx.w} px</span>
            )}
            {cropPx && (
              <span style={pxChipStyle()}>↕ {cropPx.h} px</span>
            )}
            <span style={{ flex: 1 }} />
            {/* Flip — merged into the crop page (no separate tool) */}
            <button type="button" onClick={() => setFlipH((v) => !v)} style={chipButtonStyle(flipH)} disabled={busy}>
              ↔ Flip H
            </button>
            <button type="button" onClick={() => setFlipV((v) => !v)} style={chipButtonStyle(flipV)} disabled={busy}>
              ↕ Flip V
            </button>
            <button
              type="button"
              onClick={() => {
                setCropFrac({ x: 0, y: 0, w: 1, h: 1 });
                setFlipH(false);
                setFlipV(false);
              }}
              style={ghostButtonStyle()}
              disabled={busy}
            >
              Reset
            </button>
            <button
              type="button"
              onClick={handleCropApply}
              disabled={busy}
              style={circleSubmitStyle(busy)}
              aria-label="Apply crop"
              title="Apply crop"
            >
              {busy ? <IconSpinner size={13} /> : <IconArrowUp size={14} />}
            </button>
          </div>
        )}

        {error && (
          <p style={{ marginTop: 10, color: "var(--error, #f66950)", fontSize: 12, textAlign: "center" }}>✗ {error}</p>
        )}

        {/* Tool switcher — icon-only pill, Magnific-style */}
        <div style={{ marginTop: 12, display: "flex", justifyContent: "center" }}>
          <div
            style={{
              display: "flex",
              gap: 2,
              padding: 5,
              background: "var(--surface-1, #1a1a1a)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 12,
              boxShadow: "0 10px 28px rgba(0,0,0,0.5)",
            }}
          >
            <ToolSwitcher active={tool === "prompt"} label="AI edit" onClick={() => setTool("prompt")}>
              <IconSparkles size={14} />
            </ToolSwitcher>
            <ToolSwitcher active={tool === "crop"} label="Crop & Flip" onClick={() => setTool("crop")}>
              <IconCrop size={14} />
            </ToolSwitcher>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── CropCanvas — interactive selection with 8 handles + aspect lock ─

type DragMode = null | "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

function CropCanvas({
  mediaId,
  naturalSize,
  crop,
  aspectRatio,
  flipH,
  flipV,
  onChange,
}: {
  mediaId: string;
  naturalSize: { w: number; h: number } | null;
  crop: { x: number; y: number; w: number; h: number };
  /** Constraint in IMAGE-SPACE (i.e. natural-pixel ratio). null = free. */
  aspectRatio: number | null;
  flipH: boolean;
  flipV: boolean;
  onChange: (c: { x: number; y: number; w: number; h: number }) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [drag, setDrag] = useState<DragMode>(null);
  const startRef = useRef<{
    mouseX: number;
    mouseY: number;
    crop: { x: number; y: number; w: number; h: number };
    rectW: number;
    rectH: number;
  } | null>(null);

  // Translate aspect-ratio (image-space) → fractional-space ratio
  // since our crop coordinates are fractions of the natural image.
  const fracRatio = useMemo(() => {
    if (!aspectRatio || !naturalSize) return null;
    return aspectRatio / (naturalSize.w / naturalSize.h);
  }, [aspectRatio, naturalSize]);

  const onMouseDown = (mode: Exclude<DragMode, null>) => (e: React.MouseEvent) => {
    if (!imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    startRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      crop: { ...crop },
      rectW: rect.width,
      rectH: rect.height,
    };
    setDrag(mode);
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const s = startRef.current;
      if (!s) return;
      const dx = (e.clientX - s.mouseX) / s.rectW;
      const dy = (e.clientY - s.mouseY) / s.rectH;
      let next = { ...s.crop };
      const MIN = 0.05;
      if (drag === "move") {
        next.x = clamp(s.crop.x + dx, 0, 1 - s.crop.w);
        next.y = clamp(s.crop.y + dy, 0, 1 - s.crop.h);
      } else {
        const hasN = drag === "n" || drag === "nw" || drag === "ne";
        const hasS = drag === "s" || drag === "sw" || drag === "se";
        const hasW = drag === "w" || drag === "nw" || drag === "sw";
        const hasE = drag === "e" || drag === "ne" || drag === "se";

        if (hasN) {
          const newY = clamp(s.crop.y + dy, 0, s.crop.y + s.crop.h - MIN);
          next.h = s.crop.h - (newY - s.crop.y);
          next.y = newY;
        }
        if (hasS) {
          next.h = clamp(s.crop.h + dy, MIN, 1 - s.crop.y);
        }
        if (hasW) {
          const newX = clamp(s.crop.x + dx, 0, s.crop.x + s.crop.w - MIN);
          next.w = s.crop.w - (newX - s.crop.x);
          next.x = newX;
        }
        if (hasE) {
          next.w = clamp(s.crop.w + dx, MIN, 1 - s.crop.x);
        }

        // Aspect-ratio constraint: after resize, adjust the opposite
        // dimension to keep the ratio. Uses fractional-space ratio so
        // 1:1 image-space → ~1.78:1 fractional on a landscape image.
        if (fracRatio !== null) {
          // Anchor side: which corner stays fixed during the resize.
          // We re-derive width from height (or vice versa) keeping
          // the dragged side stable.
          if (drag === "n" || drag === "s") {
            // Vertical drag → width follows height.
            const newW = next.h * fracRatio;
            const centerX = s.crop.x + s.crop.w / 2;
            next.x = clamp(centerX - newW / 2, 0, 1 - newW);
            next.w = clamp(newW, MIN, 1 - next.x);
          } else if (drag === "e" || drag === "w") {
            // Horizontal drag → height follows width.
            const newH = next.w / fracRatio;
            const centerY = s.crop.y + s.crop.h / 2;
            next.y = clamp(centerY - newH / 2, 0, 1 - newH);
            next.h = clamp(newH, MIN, 1 - next.y);
          } else {
            // Corner drag — derive height from width (or vice versa)
            // anchored at the OPPOSITE corner.
            const newH = next.w / fracRatio;
            if (hasN) {
              next.y = next.y + (next.h - newH);
            }
            next.h = clamp(newH, MIN, 1 - next.y);
            if (next.h !== newH) {
              // Hit a clamp — back-compute width from clamped height.
              next.w = clamp(next.h * fracRatio, MIN, 1 - next.x);
              if (hasW) {
                next.x = next.x + ((s.crop.w - next.w));
              }
            }
          }
        }
      }
      onChange(next);
    };
    const onUp = () => setDrag(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, fracRatio, onChange]);

  return (
    <div style={{ position: "relative", display: "inline-block", userSelect: "none" }}>
      <img
        ref={imgRef}
        src={mediaUrl(mediaId)}
        alt="Crop preview"
        draggable={false}
        style={{
          maxWidth: "min(900px, 80vw)",
          maxHeight: "62vh",
          objectFit: "contain",
          display: "block",
          pointerEvents: "none",
          // Live flip preview — the crop box is drawn over the flipped
          // image, and apply flips before cropping to match.
          transform: `scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1})`,
        }}
      />
      {/* Dimmed overlay outside the crop box */}
      <div
        onMouseDown={onMouseDown("move")}
        style={{
          position: "absolute",
          left: `${crop.x * 100}%`,
          top: `${crop.y * 100}%`,
          width: `${crop.w * 100}%`,
          height: `${crop.h * 100}%`,
          // No dimming outside the crop box (user preference) — a thin
          // outline marks the selection instead.
          outline: "1px solid rgba(255,255,255,0.7)",
          cursor: drag === "move" ? "grabbing" : "move",
        }}
      >
        {/* Rule-of-thirds grid */}
        <div style={gridLineH("33.33%")} />
        <div style={gridLineH("66.66%")} />
        <div style={gridLineV("33.33%")} />
        <div style={gridLineV("66.66%")} />

        {/* Frame corner brackets — visual mimic of camera focus marks */}
        <CornerBracket pos="tl" />
        <CornerBracket pos="tr" />
        <CornerBracket pos="bl" />
        <CornerBracket pos="br" />

        {/* 8 drag handles */}
        <Handle pos="nw" onDown={onMouseDown("nw")} />
        <Handle pos="n" onDown={onMouseDown("n")} />
        <Handle pos="ne" onDown={onMouseDown("ne")} />
        <Handle pos="e" onDown={onMouseDown("e")} />
        <Handle pos="se" onDown={onMouseDown("se")} />
        <Handle pos="s" onDown={onMouseDown("s")} />
        <Handle pos="sw" onDown={onMouseDown("sw")} />
        <Handle pos="w" onDown={onMouseDown("w")} />
      </div>
    </div>
  );
}

// ─── Crop UI primitives ─────────────────────────────────────────────

function CornerBracket({ pos }: { pos: "tl" | "tr" | "bl" | "br" }) {
  const size = 22;
  const stroke = 3;
  const color = "#ffffff";
  const style: React.CSSProperties = {
    position: "absolute",
    width: size,
    height: size,
    pointerEvents: "none",
  };
  let border: React.CSSProperties = {};
  if (pos === "tl") {
    style.top = -stroke;
    style.left = -stroke;
    border = { borderTop: `${stroke}px solid ${color}`, borderLeft: `${stroke}px solid ${color}` };
  } else if (pos === "tr") {
    style.top = -stroke;
    style.right = -stroke;
    border = { borderTop: `${stroke}px solid ${color}`, borderRight: `${stroke}px solid ${color}` };
  } else if (pos === "bl") {
    style.bottom = -stroke;
    style.left = -stroke;
    border = { borderBottom: `${stroke}px solid ${color}`, borderLeft: `${stroke}px solid ${color}` };
  } else {
    style.bottom = -stroke;
    style.right = -stroke;
    border = { borderBottom: `${stroke}px solid ${color}`, borderRight: `${stroke}px solid ${color}` };
  }
  return <div style={{ ...style, ...border }} />;
}

function Handle({
  pos,
  onDown,
}: {
  pos: "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
  onDown: (e: React.MouseEvent) => void;
}) {
  // Edge handles are thin rectangles; corner handles are larger squares.
  const isCorner = pos.length === 2;
  const w = isCorner ? 14 : pos === "n" || pos === "s" ? 28 : 8;
  const h = isCorner ? 14 : pos === "n" || pos === "s" ? 8 : 28;

  const style: React.CSSProperties = {
    position: "absolute",
    width: w,
    height: h,
    background: "#ffffff",
    border: "1px solid rgba(0,0,0,0.4)",
    borderRadius: isCorner ? 3 : 4,
    transform: "translate(-50%, -50%)",
    boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
  };

  // Position by % so the handle stays at the right spot when crop resizes.
  const setSide = (
    s: { top?: string; left?: string; right?: string; bottom?: string },
    cursor: string,
  ) => Object.assign(style, s, { cursor });

  switch (pos) {
    case "nw":
      setSide({ top: "0", left: "0" }, "nwse-resize");
      break;
    case "n":
      setSide({ top: "0", left: "50%" }, "ns-resize");
      break;
    case "ne":
      setSide({ top: "0", left: "100%" }, "nesw-resize");
      break;
    case "e":
      setSide({ top: "50%", left: "100%" }, "ew-resize");
      break;
    case "se":
      setSide({ top: "100%", left: "100%" }, "nwse-resize");
      break;
    case "s":
      setSide({ top: "100%", left: "50%" }, "ns-resize");
      break;
    case "sw":
      setSide({ top: "100%", left: "0" }, "nesw-resize");
      break;
    case "w":
      setSide({ top: "50%", left: "0" }, "ew-resize");
      break;
  }
  return <div style={style} onMouseDown={onDown} />;
}

function gridLineH(top: string): React.CSSProperties {
  return {
    position: "absolute",
    left: 0,
    right: 0,
    top,
    height: 1,
    background: "rgba(255,255,255,0.25)",
    pointerEvents: "none",
  };
}
function gridLineV(left: string): React.CSSProperties {
  return {
    position: "absolute",
    top: 0,
    bottom: 0,
    left,
    width: 1,
    background: "rgba(255,255,255,0.25)",
    pointerEvents: "none",
  };
}

// ─── Misc helpers ───────────────────────────────────────────────────

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load image: ${src}`));
    img.src = src;
  });
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// Floating control bar — Magnific's rounded pill anchored near the
// bottom of the editor.
function floatingBarStyle(maxWidth: number): React.CSSProperties {
  return {
    maxWidth,
    margin: "0 auto",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    background: "var(--surface-1, #1a1a1a)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 16,
    boxShadow: "0 10px 28px rgba(0,0,0,0.5)",
    flexWrap: "wrap",
  };
}

// Circular ↑ submit — Magnific's send button.
function circleSubmitStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 34,
    height: 34,
    borderRadius: "50%",
    background: disabled ? "#2b2b2b" : "var(--accent-0, #3b82f6)",
    color: "#fff",
    border: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    opacity: disabled ? 0.6 : 1,
  };
}

function pxChipStyle(): React.CSSProperties {
  return {
    padding: "6px 10px",
    borderRadius: 999,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.08)",
    fontSize: 11,
    color: "var(--fg-2, #c5c5c5)",
    fontFamily: "ui-monospace, monospace",
    whiteSpace: "nowrap",
  };
}

function ghostButtonStyle(): React.CSSProperties {
  return {
    background: "transparent",
    color: "var(--fg-2, #c5c5c5)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 999,
    padding: "6px 14px",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}
function chipButtonStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? "var(--accent-0, #3b82f6)" : "rgba(255,255,255,0.06)",
    color: active ? "#fff" : "var(--fg-2, #c5c5c5)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 999,
    padding: "6px 12px",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}
function iconBtnStyle(): React.CSSProperties {
  return {
    background: "transparent",
    color: "var(--fg-2, #c5c5c5)",
    border: "none",
    cursor: "pointer",
    fontSize: 18,
    padding: 4,
    fontFamily: "inherit",
    alignItems: "center",
  };
}

function ToolSwitcher({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 34,
        height: 30,
        background: active ? "var(--accent-0, #3b82f6)" : "transparent",
        color: active ? "#fff" : "var(--fg-3, #aaaaaa)",
        border: "none",
        borderRadius: 8,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}
