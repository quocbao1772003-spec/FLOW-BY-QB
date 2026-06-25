import { useCallback, useMemo, useRef, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useBoardStore, type FlowNode } from "../store/board";
import { patchNode, runAssistant } from "../api/client";
import {
  MentionAutocomplete,
  type MentionAutocompleteHandle,
  type MentionNode,
} from "../components/MentionAutocomplete";
import { IconPencil, IconPlay, IconSparkles, IconSpinner } from "./icons";

// Pretty-print the node type for the mention list. Mirrors the icons
// + labels Flowboard uses elsewhere.
function nodeTypeLabel(t: string): string {
  switch (t) {
    case "character":
      return "Character";
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "prompt":
      return "Prompt";
    case "note":
      return "Note";
    case "visual_asset":
      return "VisualAsset";
    case "Storyboard":
      return "Storyboard";
    case "assistant":
      return "Assistant";
    default:
      return t.charAt(0).toUpperCase() + t.slice(1);
  }
}

// Map a board node to the MentionAutocomplete shape. Strips down what
// the popover renders to: custom title (when renamed), type label,
// shortId, and a tiny label preview.
function toMentionNode(n: FlowNode): MentionNode {
  const data = n.data as Record<string, unknown>;
  const shortId = (data.shortId as string) ?? n.id;
  const type = nodeTypeLabel((data.type as string) ?? "node");
  // User-assigned name (set via inline rename). Takes priority in the
  // dropdown's primary text. Falls back to undefined if the node was
  // never renamed.
  const customTitle =
    typeof data.title === "string" && data.title.trim()
      ? data.title.trim()
      : undefined;
  // Prefer aiBrief / prompt / assistantResponse as the visible label,
  // truncated. Empty fallback so the row still renders.
  const labelRaw =
    (typeof data.aiBrief === "string" && data.aiBrief) ||
    (typeof data.prompt === "string" && data.prompt) ||
    (typeof data.assistantResponse === "string" && data.assistantResponse) ||
    "";
  const label = labelRaw.replace(/\s+/g, " ").slice(0, 60);
  return { id: n.id, type, shortId, label, customTitle };
}

// Models surfaced to the dropdown, grouped by provider. Keep in sync
// with AssistantModel in agent/flowboard/routes/assistant.py — backend
// validates against this list.
//
// • Gemini  → needs GEMINI_API_KEY env var on the agent (free tier OK)
// • Claude  → uses Claude CLI subprocess; covered by user's existing
//             Claude Pro/Max subscription, no extra API key needed
const MODELS: Array<{ id: string; label: string; group: "Gemini" | "Claude" }> = [
  // Gemini
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", group: "Gemini" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", group: "Gemini" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", group: "Gemini" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", group: "Gemini" },
  // Claude (no API key needed — uses CLI login)
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", group: "Claude" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 ★", group: "Claude" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", group: "Claude" },
];

const STATUS_COLOR: Record<string, string> = {
  idle: "transparent",
  queued: "rgba(245, 179, 1, 0.6)",
  running: "var(--accent)",
  done: "rgba(110, 231, 183, 0.8)",
  error: "#ef4444",
};

export function AssistantNodeCard({ id, data, selected }: NodeProps<FlowNode>) {
  const updateNodeData = useBoardStore((s) => s.updateNodeData);
  // Pull nodes + edges + the connection helper for the @-mention popover.
  // Subscribing to the whole list is fine — the component already
  // re-renders on selection / drag, this just piggy-backs.
  const allNodes = useBoardStore((s) => s.nodes);
  const allEdges = useBoardStore((s) => s.edges);
  const addEdgeFromConnection = useBoardStore((s) => s.addEdgeFromConnection);

  const [prompt, setPrompt] = useState<string>((data.prompt as string) ?? "");
  const [model, setModel] = useState<string>(
    (data.assistantModel as string) ?? "gemini-2.5-flash",
  );
  const [tab, setTab] = useState<"prompt" | "result">(
    data.assistantResponse ? "result" : "prompt",
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mentionRef = useRef<MentionAutocompleteHandle>(null);

  // Rename state — Magnific-style inline title editing. Double-click
  // the header text to enter edit mode, Enter saves, Esc cancels.
  // Persisted via patchNode so the rename survives reload + propagates
  // to other tabs via the next board fetch.
  const currentTitle =
    typeof data.title === "string" && data.title.trim() ? data.title.trim() : "";
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState(currentTitle);
  const [copied, setCopied] = useState(false);

  const startRename = useCallback(() => {
    setTitleInput(currentTitle);
    setEditingTitle(true);
  }, [currentTitle]);

  const commitRename = useCallback(async () => {
    const next = titleInput.trim();
    setEditingTitle(false);
    if (next === currentTitle) return;
    // Optimistic local update so the canvas reflects the change
    // immediately. Use `null` to clear the field (backend's merge
    // patch treats null as "delete this key").
    updateNodeData(id, { title: next || null });
    const dbId = parseInt(id, 10);
    if (isNaN(dbId)) return;
    try {
      await patchNode(dbId, { data: { title: next || null } });
    } catch (err) {
      console.error("Failed to save title rename", err);
    }
  }, [id, titleInput, currentTitle, updateNodeData]);

  const cancelRename = useCallback(() => {
    setTitleInput(currentTitle);
    setEditingTitle(false);
  }, [currentTitle]);

  // Partition the rest of the board's nodes into "already connected to
  // me" vs "not yet connected". The popover shows both, with connected
  // first. Note: we exclude the Assistant node itself (no self-mention).
  const { connectedMentions, disconnectedMentions } = useMemo(() => {
    const connectedSourceIds = new Set(
      allEdges.filter((e) => e.target === id).map((e) => e.source),
    );
    const connected: MentionNode[] = [];
    const disconnected: MentionNode[] = [];
    for (const n of allNodes) {
      if (n.id === id) continue;
      const mn = toMentionNode(n);
      if (connectedSourceIds.has(n.id)) connected.push(mn);
      else disconnected.push(mn);
    }
    return { connectedMentions: connected, disconnectedMentions: disconnected };
  }, [id, allNodes, allEdges]);

  // When the user @-mentions a node that isn't connected yet, we
  // auto-wire an edge so the backend's upstream walker sees it as a
  // first-class source. This mirrors the explicit drag-edge gesture
  // but driven by typing instead of pointer drag.
  const handleMention = useCallback(
    (sourceNodeId: string, isConnected: boolean) => {
      if (isConnected) return;
      void addEdgeFromConnection(sourceNodeId, id);
    },
    [addEdgeFromConnection, id],
  );

  const response = data.assistantResponse as string | undefined;
  const statusColor = STATUS_COLOR[(data.status as string) ?? "idle"] ?? "transparent";

  const handleRun = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setRunning(true);
    setError(null);
    updateNodeData(id, { status: "running" });
    try {
      const dbId = parseInt(id, 10);
      const result = await runAssistant(dbId, trimmed, model);
      updateNodeData(id, {
        prompt: trimmed,
        assistantResponse: result.response,
        assistantModel: model,
        status: "done",
      });
      setTab("result");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      updateNodeData(id, { status: "error" });
    } finally {
      setRunning(false);
    }
  }, [id, prompt, model, updateNodeData]);

  const handleExport = useCallback(() => {
    if (!response) return;
    const blob = new Blob([response], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `assistant-${data.shortId ?? id}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [response, data.shortId, id]);

  // Copy the whole result to the clipboard. If the user has highlighted just
  // part of the text, copy that selection instead.
  const handleCopy = useCallback(async () => {
    const selected = window.getSelection()?.toString();
    const text = selected && selected.trim() ? selected : response;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API can fail in non-secure contexts — ignore quietly.
    }
  }, [response]);

  // Don't propagate keyboard input on textarea/select to ReactFlow —
  // otherwise Backspace deletes the node while the user is editing.
  const stopRf = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
  }, []);

  return (
    // Magnific-style: type label ("eyebrow") floats ABOVE the card,
    // the card itself is a clean rounded surface with a blue selection
    // ring. Rename still works — double-click the eyebrow title.
    <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 7 }}>
      {/* Eyebrow — outside the card, like Magnific's "✦ Assistant #42" */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 4px",
          fontSize: 11,
          color: "#8a8f99",
          userSelect: "none",
        }}
      >
        <span style={{ fontSize: 12, flexShrink: 0, display: "inline-flex" }}>
          <IconSparkles size={12} />
        </span>
        {editingTitle ? (
          <input
            type="text"
            value={titleInput}
            onChange={(e) => setTitleInput(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              // Stop ReactFlow from intercepting Backspace etc.
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelRename();
              }
            }}
            autoFocus
            placeholder={`Assistant #${data.shortId ?? id}`}
            className="nodrag"
            style={{
              flex: 1,
              minWidth: 0,
              background: "#0f1115",
              color: "#e4e7ec",
              border: "1px solid #3b82f6",
              borderRadius: 5,
              padding: "2px 6px",
              fontSize: 11,
              fontWeight: 600,
              fontFamily: "inherit",
              outline: "none",
            }}
          />
        ) : (
          <span
            onDoubleClick={startRename}
            title="Double-click to rename"
            style={{
              fontWeight: 600,
              fontSize: 11,
              color: "#d6d9de",
              cursor: "text",
              minWidth: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              userSelect: "none",
            }}
          >
            {currentTitle || "Assistant"}
          </span>
        )}
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 10, flexShrink: 0 }}>
          #{data.shortId ?? id}
        </span>
        {!editingTitle && (
          <button
            type="button"
            onClick={startRename}
            title="Rename"
            className="nodrag"
            style={{
              background: "transparent",
              color: "#6a6f79",
              border: "none",
              cursor: "pointer",
              padding: 0,
              fontSize: 11,
              flexShrink: 0,
              display: "inline-flex",
            }}
          >
            <IconPencil size={11} />
          </button>
        )}
      </div>

      <div
        style={{
          // FIXED dimensions — node never grows to fit content. Long
          // Gemini responses scroll INSIDE the Result tab instead of
          // stretching the node vertically across the canvas.
          width: 360,
          height: 480,
          background: "var(--surface-1, #1a1a1a)",
          border: `1px solid ${selected ? "#3b82f6" : "rgba(255, 255, 255, 0.08)"}`,
          borderRadius: 16,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: selected
            ? "0 0 0 1px #3b82f6, 0 0 18px rgba(59, 130, 246, 0.25)"
            : "0 1px 2px rgba(0, 0, 0, 0.3)",
          transition: "border-color 120ms ease, box-shadow 120ms ease",
          fontFamily: "system-ui, -apple-system, sans-serif",
          color: "#e4e7ec",
        }}
      >
      <Handle
        type="target"
        position={Position.Left}
        style={{
          // Magnific-style square side button instead of a dot
          background: "#232327",
          border: "1px solid rgba(255, 255, 255, 0.14)",
          borderRadius: 5,
          width: 16,
          height: 16,
          boxShadow: "0 2px 6px rgba(0, 0, 0, 0.4)",
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{
          background: "#232327",
          border: "1px solid rgba(255, 255, 255, 0.14)",
          borderRadius: 5,
          width: 16,
          height: 16,
          boxShadow: "0 2px 6px rgba(0, 0, 0, 0.4)",
        }}
      />

      {/* Status strip — matches the convention used by NodeCard.tsx */}
      <div
        style={{
          height: 3,
          background: statusColor,
          transition: "background 0.2s",
        }}
      />

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: "8px 12px 0",
        }}
      >
        <button
          type="button"
          onClick={() => setTab("prompt")}
          title="Prompt"
          style={{
            background: tab === "prompt" ? "#2a2e38" : "transparent",
            border: "1px solid #2a2e38",
            color: tab === "prompt" ? "#fff" : "#8a8f99",
            padding: "5px 12px",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <IconPencil size={11} /> Prompt
          </span>
        </button>
        <button
          type="button"
          onClick={() => setTab("result")}
          title="Result"
          style={{
            background: tab === "result" ? "#2a2e38" : "transparent",
            border: "1px solid #2a2e38",
            color: tab === "result" ? "#fff" : "#8a8f99",
            padding: "5px 12px",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <IconSparkles size={11} /> Result
          </span>
          {response && (
            <span
              style={{
                marginLeft: 4,
                fontSize: 10,
                color: "#5db97a",
              }}
            >
              ●
            </span>
          )}
        </button>
      </div>

      {/* Body — flex: 1 + minHeight: 0 + overflow: hidden is the magic
          flexbox combo that lets the inner Result div scroll INSIDE
          this container instead of forcing the outer node to grow. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          padding: 12,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {tab === "prompt" ? (
          <MentionAutocomplete
            ref={mentionRef}
            value={prompt}
            onChange={setPrompt}
            onKeyDownPassthrough={stopRf}
            onMention={handleMention}
            connectedNodes={connectedMentions}
            disconnectedNodes={disconnectedMentions}
            placeholder="nhập prompt ở đây — gõ @ để tag node"
            disabled={running}
            rows={12}
            className="nodrag"
            style={{
              flex: 1,
              minHeight: 0,
              background: "#0f1115",
              color: "#e4e7ec",
              border: "1px solid #2a2e38",
              borderRadius: 8,
              padding: 10,
              resize: "none",
              fontFamily: "inherit",
              fontSize: 13,
              outline: "none",
              lineHeight: 1.5,
              width: "100%",
              boxSizing: "border-box",
            }}
          />
        ) : (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              background: "#0f1115",
              border: "1px solid #2a2e38",
              borderRadius: 8,
              padding: 10,
              overflow: "auto",
              fontSize: 13,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              // Allow click-drag to highlight the text and copy it. ReactFlow
              // disables selection on nodes and starts a drag on mousedown, so
              // we need both `nodrag` (no node drag) and an explicit
              // userSelect/cursor override here.
              userSelect: "text",
              WebkitUserSelect: "text",
              cursor: "text",
            }}
            className="nowheel nodrag"
            // Keep mousedown from bubbling to ReactFlow (which would start a
            // pan / node drag and clear the selection).
            onMouseDown={(e) => e.stopPropagation()}
          >
            {error ? (
              <span style={{ color: "#ef4444" }}>✗ {error}</span>
            ) : running ? (
              <span style={{ color: "#8a8f99" }}>
                <IconSpinner size={12} /> Đang chạy {model}...
              </span>
            ) : response ? (
              response
            ) : (
              <span style={{ color: "#5a5f69" }}>
                Chưa có kết quả. Bấm ▶ ở tab Prompt để chạy.
              </span>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "10px 12px",
          borderTop: "1px solid rgba(255, 255, 255, 0.07)",
          background: "#141417",
        }}
      >
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onKeyDown={stopRf}
          disabled={running}
          className="nodrag"
          style={{
            background: "#2a2e38",
            color: "#fff",
            border: "1px solid #3a3f4a",
            padding: "5px 8px",
            borderRadius: 6,
            fontSize: 12,
            cursor: "pointer",
            outline: "none",
            maxWidth: 180,
          }}
        >
          {/* Grouped by provider — Gemini needs API key, Claude uses
              the user's CLI login. Optgroup labels are visible in the
              dropdown but not in the closed select element. */}
          <optgroup label="Gemini (needs API key)">
            {MODELS.filter((m) => m.group === "Gemini").map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Claude (via CLI login)">
            {MODELS.filter((m) => m.group === "Claude").map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </optgroup>
        </select>

        <button
          type="button"
          onClick={handleCopy}
          disabled={!response}
          className="nodrag"
          title="Copy kết quả (hoặc phần đang bôi đen)"
          style={{
            marginLeft: "auto",
            background: response ? "#2a2e38" : "transparent",
            color: response ? (copied ? "#22c55e" : "#e4e7ec") : "#5a5f69",
            border: "1px solid #3a3f4a",
            padding: "5px 12px",
            borderRadius: 6,
            cursor: response ? "pointer" : "not-allowed",
            fontSize: 12,
          }}
        >
          {copied ? "✓ Đã copy" : "Copy"}
        </button>

        <button
          type="button"
          onClick={handleExport}
          disabled={!response}
          className="nodrag"
          style={{
            background: response ? "#2a2e38" : "transparent",
            color: response ? "#e4e7ec" : "#5a5f69",
            border: "1px solid #3a3f4a",
            padding: "5px 12px",
            borderRadius: 6,
            cursor: response ? "pointer" : "not-allowed",
            fontSize: 12,
          }}
        >
          Export as text ⌄
        </button>

        <button
          type="button"
          onClick={handleRun}
          disabled={running || !prompt.trim()}
          className="nodrag"
          title="Run"
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            // Magnific-style: neutral dark circle; disabled fades out
            background: "#2f3137",
            color: "#fff",
            opacity: running || !prompt.trim() ? 0.45 : 1,
            border: "1px solid rgba(255, 255, 255, 0.1)",
            cursor: running || !prompt.trim() ? "not-allowed" : "pointer",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            paddingLeft: 2, // optically centre the ▶ glyph
            flexShrink: 0,
          }}
        >
          {running ? <IconSpinner size={13} /> : <IconPlay size={13} />}
        </button>
      </div>
      </div>
    </div>
  );
}
