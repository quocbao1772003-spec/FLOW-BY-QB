import { useState, useRef, type KeyboardEvent } from "react";
import { useBoardStore } from "../store/board";
import { ActivityBell } from "./activity/ActivityBell";
import { AiProviderBadge } from "./AiProviderBadge";
import { useAiChatStore } from "../store/aiChat";

export function Toolbar() {
  const boardName = useBoardStore((s) => s.boardName);
  const renameBoard = useBoardStore((s) => s.renameBoard);
  const chatOpen = useAiChatStore((s) => s.open);
  const toggleChat = useAiChatStore((s) => s.toggle);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(boardName);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }

  function commitEdit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== boardName) {
      renameBoard(trimmed);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") inputRef.current?.blur();
    if (e.key === "Escape") {
      setEditing(false);
    }
  }

  return (
    <div className="toolbar">
      <span className="toolbar-wordmark">Flowboard</span>
      <span className="toolbar-sep" aria-hidden="true">›</span>
      <span className="toolbar-crumb">Personal</span>
      <span className="toolbar-sep" aria-hidden="true">›</span>
      {editing ? (
        <input
          ref={inputRef}
          className="toolbar-name-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={onKeyDown}
          aria-label="Board name"
        />
      ) : (
        <button
          className="toolbar-name-btn"
          onClick={startEdit}
          aria-label="Rename board"
          title="Click to rename"
        >
          {boardName || "Untitled"}
        </button>
      )}

      <div className="toolbar-actions">
        <ActivityBell />
        <AiProviderBadge />
        <button
          className={`toolbar-ai-btn${chatOpen ? " toolbar-ai-btn--on" : ""}`}
          onClick={toggleChat}
          aria-pressed={chatOpen}
          title="Trợ lý AI — đặt tên sản phẩm, viết prompt"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9L12 2.5z" fill="currentColor" />
          </svg>
          Trợ lý AI
        </button>
      </div>
    </div>
  );
}
