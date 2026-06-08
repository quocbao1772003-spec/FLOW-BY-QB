import { useEffect, useRef, useState } from "react";
import { useBoardStore } from "../store/board";
import { useGenerationStore } from "../store/generation";
import { mediaUrl, uploadImage } from "../api/client";
import { IconArrowUp, IconImage, IconPlus, IconSpinner } from "../canvas/icons";
import {
  MentionAutocomplete,
  type MentionNode,
} from "./MentionAutocomplete";

// Standalone single-image generator — Magnific "Image Generator"-style
// page. Generations are dispatched onto a dedicated hidden board
// ("Quick Gen") through the exact same node + request pipeline the
// canvas uses, so nothing new is needed on the backend. The right side
// shows every creation from that board, newest first.

const QUICK_GEN_BOARD = "Quick Gen";

const ASPECTS = [
  { v: "IMAGE_ASPECT_RATIO_SQUARE", label: "1:1" },
  { v: "IMAGE_ASPECT_RATIO_PORTRAIT", label: "9:16" },
  { v: "IMAGE_ASPECT_RATIO_LANDSCAPE", label: "16:9" },
];

export function ImageGenPage() {
  const boards = useBoardStore((s) => s.boards);
  const boardId = useBoardStore((s) => s.boardId);
  const nodes = useBoardStore((s) => s.nodes);
  const switchBoard = useBoardStore((s) => s.switchBoard);
  const createNewBoard = useBoardStore((s) => s.createNewBoard);
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);
  const dispatchGeneration = useGenerationStore((s) => s.dispatchGeneration);
  const openResultViewer = useGenerationStore((s) => s.openResultViewer);

  const addReferenceNode = useBoardStore((s) => s.addReferenceNode);
  const addEdgeFromConnection = useBoardStore((s) => s.addEdgeFromConnection);
  const deleteNodeByRfId = useBoardStore((s) => s.deleteNodeByRfId);
  const ensureProjectId = useGenerationStore((s) => s.ensureProjectId);

  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState(ASPECTS[0].v);
  const [variants, setVariants] = useState(1);
  const [busy, setBusy] = useState(false);
  // Uploaded reference images (max 4) — each becomes a visual_asset node
  // on the Quick Gen board; at generate time they're wired into the
  // image node so the dispatcher feeds them to Flow as refs (same
  // mechanics as the canvas).
  const [refs, setRefs] = useState<
    Array<{ rfId: string; mediaId: string; name: string }>
  >([]);
  const [uploadingRef, setUploadingRef] = useState(false);
  const refInputRef = useRef<HTMLInputElement>(null);
  const ensuring = useRef(false);

  // Make sure the hidden Quick Gen board exists and is active so its
  // nodes hydrate into the store (the gallery reads from there).
  useEffect(() => {
    if (ensuring.current) return;
    const existing = boards.find((b) => b.name === QUICK_GEN_BOARD);
    if (existing && existing.id === boardId) return;
    ensuring.current = true;
    void (async () => {
      try {
        if (existing) {
          await switchBoard(existing.id);
        } else {
          await createNewBoard(QUICK_GEN_BOARD);
        }
      } finally {
        ensuring.current = false;
      }
    })();
  }, [boards, boardId, switchBoard, createNewBoard]);

  const onQuickGenBoard =
    boards.find((b) => b.id === boardId)?.name === QUICK_GEN_BOARD;

  // Gallery — image nodes of the Quick Gen board, newest (highest id) first.
  const creations = onQuickGenBoard
    ? nodes
        .filter(
          (n) =>
            n.data.type === "image" &&
            (n.data.mediaId ||
              (n.data.mediaIds ?? []).some(
                (m) => typeof m === "string" && m,
              ) ||
              n.data.status === "queued" ||
              n.data.status === "running"),
        )
        .sort((a, b) => parseInt(b.id, 10) - parseInt(a.id, 10))
    : [];

  // ── Reference upload (max 4) ──────────────────────────────────────
  async function handleRefUpload(file: File) {
    if (refs.length >= 4 || !onQuickGenBoard) return;
    setUploadingRef(true);
    try {
      const projectId = await ensureProjectId();
      if (!projectId) return;
      const resp = await uploadImage(file, projectId);
      const name = file.name.replace(/\.[^.]+$/, "").slice(0, 40) || "ref";
      const rfId = await addReferenceNode(
        {
          mediaId: resp.media_id,
          label: name,
          kind: "visual_asset",
          aiBrief: null,
          aspectRatio: resp.aspect_ratio ?? null,
        },
        { x: -600, y: refs.length * 320 },
      );
      if (rfId) {
        setRefs((r) => [...r, { rfId, mediaId: resp.media_id, name }]);
      }
    } finally {
      setUploadingRef(false);
    }
  }

  function removeRef(rfId: string) {
    setRefs((r) => r.filter((x) => x.rfId !== rfId));
    void deleteNodeByRfId(rfId);
  }

  // @-mention list for the prompt box — the uploaded refs, so typing @
  // tags a specific reference image (same UX as the canvas Assistant).
  const mentionRefs: MentionNode[] = refs.map((r) => {
    const n = nodes.find((x) => x.id === r.rfId);
    return {
      id: r.rfId,
      type: "VisualAsset",
      shortId: (n?.data.shortId as string) ?? r.rfId,
      label: r.name,
      customTitle: r.name,
    };
  });

  async function handleGenerate() {
    const p = prompt.trim();
    if (!p || busy || !onQuickGenBoard) return;
    setBusy(true);
    try {
      // Scatter nodes on the hidden board so they don't pile up.
      const idx = nodes.length;
      const rfId = await addNodeOfType("image", {
        x: (idx % 6) * 360,
        y: Math.floor(idx / 6) * 420,
      });
      if (!rfId) return;
      // Wire every uploaded reference into the new image node so the
      // dispatcher sends them to Flow as IMAGE_INPUT_TYPE_REFERENCE.
      for (const r of refs) {
        await addEdgeFromConnection(r.rfId, rfId);
      }
      await dispatchGeneration(rfId, {
        prompt: p,
        kind: "image",
        aspectRatio: aspect,
        variantCount: variants,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page page--imagegen">
      {/* Left — generator form */}
      <div className="imagegen-form">
        <h2 className="imagegen-form__title">
          <IconImage size={15} /> Image Generator
        </h2>

        <span className="imagegen-form__label">MODEL</span>
        <div className="imagegen-form__model">GemPix 2</div>

        <span className="imagegen-form__label">
          REFERENCES <span style={{ marginLeft: "auto" }}>{refs.length}/4</span>
        </span>
        <div className="imagegen-refs">
          {refs.map((r) => (
            <div key={r.rfId} className="imagegen-ref" title={r.name}>
              <img src={mediaUrl(r.mediaId)} alt={r.name} />
              <button
                type="button"
                className="imagegen-ref__remove"
                onClick={() => removeRef(r.rfId)}
                aria-label={`Remove ${r.name}`}
              >
                ×
              </button>
              <span className="imagegen-ref__name">{r.name}</span>
            </div>
          ))}
          {refs.length < 4 && (
            <button
              type="button"
              className="imagegen-ref imagegen-ref--add"
              onClick={() => refInputRef.current?.click()}
              disabled={uploadingRef}
              title="Upload reference image"
            >
              <span className="imagegen-ref__tile">
                {uploadingRef ? <IconSpinner size={14} /> : <IconPlus size={14} />}
              </span>
              <span className="imagegen-ref__name">Add</span>
            </button>
          )}
          <input
            ref={refInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleRefUpload(f);
              e.target.value = "";
            }}
          />
        </div>

        <span className="imagegen-form__label">PROMPT</span>
        <MentionAutocomplete
          value={prompt}
          onChange={setPrompt}
          onKeyDownPassthrough={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void handleGenerate();
            }
          }}
          onMention={() => {
            // Edges are wired at generate time — mention is just text.
          }}
          connectedNodes={mentionRefs}
          disconnectedNodes={[]}
          placeholder="Describe your image — gõ @ để tag ảnh tham chiếu"
          disabled={busy}
          rows={6}
          className="imagegen-form__prompt nowheel"
        />

        <div className="imagegen-form__row">
          {/* Variants stepper */}
          <span className="node-chip node-chip--stepper" title="Variants">
            <button
              type="button"
              className="node-chip__step"
              onClick={() => setVariants((v) => Math.max(1, v - 1))}
              disabled={variants <= 1}
            >
              –
            </button>
            <span className="node-chip__step-value">x{variants}</span>
            <button
              type="button"
              className="node-chip__step"
              onClick={() => setVariants((v) => Math.min(4, v + 1))}
              disabled={variants >= 4}
            >
              +
            </button>
          </span>
          {/* Aspect */}
          <select
            className="node-chip node-chip--select"
            value={aspect}
            onChange={(e) => setAspect(e.target.value)}
            aria-label="Aspect ratio"
          >
            {ASPECTS.map((a) => (
              <option key={a.v} value={a.v}>
                ▭ {a.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          className="imagegen-form__generate"
          onClick={() => void handleGenerate()}
          disabled={busy || !prompt.trim() || !onQuickGenBoard}
          title="Generate (Ctrl+Enter)"
        >
          {busy ? "Generating…" : (
            <>
              Generate <IconArrowUp size={13} />
            </>
          )}
        </button>
      </div>

      {/* Right — creations gallery */}
      <div className="imagegen-gallery">
        {creations.length === 0 && (
          <p className="page__empty">
            Chưa có ảnh nào — nhập prompt bên trái và bấm Generate.
          </p>
        )}
        {creations.map((n) => {
          const ids = (
            n.data.mediaIds ?? (n.data.mediaId ? [n.data.mediaId] : [])
          ).filter((m): m is string => typeof m === "string" && m.length > 0);
          const pending =
            n.data.status === "queued" || n.data.status === "running";
          if (ids.length === 0 && pending) {
            return (
              <div key={n.id} className="library-tile library-tile--pending">
                <IconSpinner size={18} />
              </div>
            );
          }
          return ids.map((mid, i) => (
            <button
              key={`${n.id}-${i}`}
              type="button"
              className="library-tile"
              onClick={() => openResultViewer(n.id, i)}
              title={n.data.prompt ?? ""}
            >
              <img src={mediaUrl(mid)} alt={n.data.prompt ?? "creation"} loading="lazy" />
            </button>
          ));
        })}
      </div>
    </div>
  );
}
