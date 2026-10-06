import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { mediaUrl, patchNode } from "../../api/client";
import type { AiModel } from "../../api/aiChat";
import { useBoardStore } from "../../store/board";
import { refFromNode, useAiChatStore, type ChatMessage, type ChatRef } from "../../store/aiChat";
import { Markdown, type CodeBlockProps } from "./Markdown";
import { TEMPLATES, type ChatTemplate } from "./templates";
import "./AiChatPanel.css";

/**
 * Right-hand AI chat (Claude CLI on the agent). Built for two jobs: naming
 * products and writing image prompts — so it can take the selected canvas
 * nodes as context and push a finished prompt straight back into a node.
 */

const MODELS: Array<{ key: AiModel; label: string; hint: string }> = [
  { key: "sonnet", label: "Sonnet 5.5", hint: "Mặc định · nhanh, tiết kiệm" },
  { key: "opus", label: "Opus 5.5", hint: "Mạnh nhất, tốn lượt hơn" },
  { key: "haiku", label: "Haiku 4.5", hint: "Nhanh nhất, nhẹ nhất" },
];

const PROMPT_TYPES = new Set(["image", "video", "prompt", "Storyboard"]);

type NodeLike = { id: string; data: Record<string, unknown> };

function IconSpark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9L12 2.5z" fill="currentColor" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" fill="currentColor" opacity=".7" />
    </svg>
  );
}

function IconArrowUp() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconStop() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
    </svg>
  );
}

function IconNew() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconPaperclip() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function AiChatPanel() {
  const open = useAiChatStore((s) => s.open);
  if (!open) return null;
  return <PanelBody />;
}

function PanelBody() {
  const {
    model, messages, draft, draftRefs, streaming,
    setOpen, setModel, setDraft, addRefs, removeRef, newChat, send, stop,
  } = useAiChatStore();
  const nodes = useBoardStore((s) => s.nodes);
  const selected = useMemo(() => nodes.filter((n) => n.selected), [nodes]);
  const target = selected.length === 1 && PROMPT_TYPES.has(String(selected[0].data.type)) ? selected[0] : null;

  const [modelMenu, setModelMenu] = useState(false);
  const [tplMenu, setTplMenu] = useState(false);
  const { runTemplate, fillTemplate } = useAiChatStore.getState();
  const selectedRefs = () => selected.map((n) => refFromNode(n as unknown as NodeLike));
  const hasImage = selected.some((n) => !!refFromNode(n as unknown as NodeLike).mediaId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);

  // Follow the stream unless the user scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Focus the composer when an image is attached from the canvas ("Use").
  const focusTick = useAiChatStore((s) => s.focusTick);
  useEffect(() => {
    if (focusTick) requestAnimationFrame(() => taRef.current?.focus());
  }, [focusTick]);

  // Autosize the composer.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [draft]);

  function attachSelected() {
    if (selected.length) addRefs(selectedRefs());
  }

  /** Card body: put the template in the composer, cursor on the first blank. */
  function fill(t: ChatTemplate) {
    const text = fillTemplate(t.id, t.needsNode ? selectedRefs() : []);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      const at = t.cursorAfter ? text.indexOf(t.cursorAfter) : -1;
      const pos = at >= 0 ? at + (t.cursorAfter?.length ?? 0) : text.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  /** "Use": attach the selected node(s) and send straight away. */
  function use(t: ChatTemplate) {
    void runTemplate(t.id, selectedRefs());
  }

  const useBlocked = (t: ChatTemplate) => streaming || (t.needsNode && selected.length === 0);
  const useHint = (t: ChatTemplate) =>
    t.needsNode && selected.length === 0
      ? "Chọn node ảnh trên canvas trước"
      : hasImage
        ? `Gửi ngay kèm ${selected.length} node đang chọn`
        : "Gửi ngay (node đang chọn không có ảnh)";

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Vietnamese IMEs compose with Enter — never send mid-composition.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  function retry(msgIdx: number) {
    const prevUser = [...messages.slice(0, msgIdx)].reverse().find((m) => m.role === "user");
    if (!prevUser || streaming) return;
    useAiChatStore.setState((s) => ({
      messages: s.messages.slice(0, s.messages.indexOf(prevUser)),
      draft: prevUser.content,
      draftRefs: prevUser.refs ?? [],
    }));
    void send();
  }

  const modelInfo = MODELS.find((m) => m.key === model) ?? MODELS[0];

  return (
    <aside className="aic" aria-label="Trợ lý AI">
      <header className="aic-head">
        <div className="aic-title">
          <span className="aic-mark" aria-hidden="true"><IconSpark /></span>
          <span>Trợ lý AI</span>
        </div>
        <div className="aic-head__actions">
          <button className="aic-icon" onClick={newChat} title="Cuộc trò chuyện mới" aria-label="Cuộc trò chuyện mới">
            <IconNew />
          </button>
          <button className="aic-icon" onClick={() => setOpen(false)} title="Đóng" aria-label="Đóng trợ lý">
            <IconClose />
          </button>
        </div>
      </header>

      <div
        className="aic-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {messages.length === 0 ? (
          <div className="aic-empty">
            <div className="aic-empty__mark" aria-hidden="true"><IconSpark /></div>
            <h2>Cần đặt tên hay viết prompt?</h2>
            <p>Chọn node trên canvas rồi hỏi — trợ lý xem được ảnh và prompt của node đó.</p>
            <div className="aic-starters">
              {TEMPLATES.map((t) => (
                <div key={t.id} className="aic-starter">
                  <button className="aic-starter__main" onClick={() => fill(t)} title="Điền vào ô chat để sửa trước khi gửi">
                    <strong>{t.title}</strong>
                    <span>{t.hint}</span>
                  </button>
                  <button className="aic-use" onClick={() => use(t)} disabled={useBlocked(t)} title={useHint(t)}>
                    Gửi ngay
                  </button>
                </div>
              ))}
            </div>
            <p className="aic-empty__tip">
              <strong>Gửi ngay</strong> = gửi mẫu kèm ảnh node đang chọn · bấm vào thẻ để sửa trước khi gửi
            </p>
          </div>
        ) : (
          <div className="aic-thread">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <UserBubble key={m.id} msg={m} />
              ) : (
                <AssistantMessage key={m.id} msg={m} target={target ? refFromNode(target as unknown as NodeLike) : null} onRetry={() => retry(i)} />
              ),
            )}
          </div>
        )}
      </div>

      <div className="aic-composer-wrap">
        <div className={`aic-composer${streaming ? " aic-composer--busy" : ""}`}>
          {draftRefs.length > 0 && (
            <div className="aic-refs">
              {draftRefs.map((r) => (
                <span key={r.rfId} className="aic-ref">
                  {r.mediaId ? <img src={mediaUrl(r.mediaId)} alt="" /> : <span className="aic-ref__dot" />}
                  <span className="aic-ref__label">#{r.shortId}</span>
                  <button onClick={() => removeRef(r.rfId)} aria-label={`Bỏ #${r.shortId}`}>×</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            value={draft}
            rows={1}
            placeholder="Hỏi trợ lý… (Enter để gửi, Shift+Enter xuống dòng)"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
          />
          <div className="aic-composer__bar">
            <button
              className="aic-chip"
              onClick={attachSelected}
              disabled={selected.length === 0}
              title={selected.length ? "Đính kèm node đang chọn (ảnh + prompt)" : "Chọn node trên canvas để đính kèm"}
            >
              <IconPaperclip />
              {selected.length ? `Node đang chọn (${selected.length})` : "Chưa chọn node"}
            </button>
            <div className="aic-tpl">
              <button
                className="aic-chip aic-chip--ghost"
                onClick={() => setTplMenu((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={tplMenu}
                title="Prompt mẫu"
              >
                Mẫu
                <span className="aic-caret" aria-hidden="true">⌄</span>
              </button>
              {tplMenu && (
                <div className="aic-menu aic-menu--left" role="menu" onMouseLeave={() => setTplMenu(false)}>
                  {TEMPLATES.map((t) => (
                    <div key={t.id} className="aic-tplrow">
                      <button
                        className="aic-menu__item"
                        onClick={() => {
                          fill(t);
                          setTplMenu(false);
                        }}
                        title="Điền vào ô chat để sửa"
                      >
                        <strong>{t.title}</strong>
                        <span>{t.hint}</span>
                      </button>
                      <button
                        className="aic-use"
                        disabled={useBlocked(t)}
                        title={useHint(t)}
                        onClick={() => {
                          use(t);
                          setTplMenu(false);
                        }}
                      >
                        Gửi ngay
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="aic-model">
              <button className="aic-chip aic-chip--ghost" onClick={() => setModelMenu((v) => !v)} aria-haspopup="menu" aria-expanded={modelMenu}>
                {modelInfo.label}
                <span className="aic-caret" aria-hidden="true">⌄</span>
              </button>
              {modelMenu && (
                <div className="aic-menu" role="menu" onMouseLeave={() => setModelMenu(false)}>
                  {MODELS.map((m) => (
                    <button
                      key={m.key}
                      role="menuitemradio"
                      aria-checked={m.key === model}
                      className={`aic-menu__item${m.key === model ? " aic-menu__item--on" : ""}`}
                      onClick={() => {
                        setModel(m.key);
                        setModelMenu(false);
                      }}
                    >
                      <strong>{m.label}</strong>
                      <span>{m.hint}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {streaming ? (
              <button className="aic-send aic-send--stop" onClick={stop} aria-label="Dừng">
                <IconStop />
              </button>
            ) : (
              <button className="aic-send" onClick={() => void send()} disabled={!draft.trim()} aria-label="Gửi">
                <IconArrowUp />
              </button>
            )}
          </div>
        </div>
        <p className="aic-foot">Chạy qua Claude CLI trên máy bạn · AI có thể sai, hãy kiểm tra trước khi dùng.</p>
      </div>
    </aside>
  );
}

function UserBubble({ msg }: { msg: ChatMessage }) {
  const long = msg.content.length > 320 || msg.content.split("\n").length > 7;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="aic-user">
      {msg.refs && msg.refs.length > 0 && (
        <div className="aic-user__refs">
          {msg.refs.map((r) =>
            r.mediaId ? (
              <img key={r.rfId} src={mediaUrl(r.mediaId)} alt={`#${r.shortId}`} title={`#${r.shortId} · ${r.title}`} />
            ) : (
              <span key={r.rfId} className="aic-user__reftag">#{r.shortId}</span>
            ),
          )}
        </div>
      )}
      <div className={`aic-user__bubble${long && !expanded ? " aic-user__bubble--clamped" : ""}`}>{msg.content}</div>
      {long && (
        <button className="aic-user__more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Thu gọn" : "Xem đầy đủ"}
        </button>
      )}
    </div>
  );
}

function AssistantMessage({ msg, target, onRetry }: { msg: ChatMessage; target: ChatRef | null; onRetry: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="aic-bot">
      <div className="aic-bot__mark" aria-hidden="true"><IconSpark /></div>
      <div className="aic-bot__body">
        {msg.content ? (
          <div className="aic-md">
            <Markdown text={msg.content} renderCode={(p) => <CodeBlock {...p} target={target} />} />
            {msg.streaming && <span className="aic-caret-blink" aria-hidden="true" />}
          </div>
        ) : msg.streaming ? (
          <div className="aic-thinking" aria-label="Đang trả lời">
            <span /><span /><span />
          </div>
        ) : null}
        {msg.error && (
          <div className="aic-error">
            <strong>Không nhận được trả lời.</strong> {msg.error}
            <button onClick={onRetry}>Thử lại</button>
          </div>
        )}
        {!msg.streaming && msg.content && (
          <div className="aic-bot__actions">
            <button
              onClick={async () => {
                if (await copyText(msg.content)) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }
              }}
            >
              {copied ? "Đã copy" : "Copy"}
            </button>
            <button onClick={onRetry}>Trả lời lại</button>
          </div>
        )}
      </div>
    </div>
  );
}

function CodeBlock({ code, lang, target }: CodeBlockProps & { target: ChatRef | null }) {
  const [state, setState] = useState<"" | "copied" | "applied">("");
  const flash = (s: "copied" | "applied") => {
    setState(s);
    setTimeout(() => setState(""), 1600);
  };

  function applyToNode() {
    if (!target) return;
    const next = code.trim();
    useBoardStore.getState().updateNodeData(target.rfId, { prompt: next });
    const dbId = parseInt(target.rfId, 10);
    if (!isNaN(dbId)) patchNode(dbId, { data: { prompt: next } }).catch(() => {});
    flash("applied");
  }

  return (
    <div className="aic-code">
      <div className="aic-code__head">
        <span>{lang || "prompt"}</span>
        <div>
          <button onClick={async () => (await copyText(code)) && flash("copied")}>
            {state === "copied" ? "Đã copy" : "Copy"}
          </button>
          <button
            className="aic-code__apply"
            onClick={applyToNode}
            disabled={!target}
            title={target ? `Thay prompt của #${target.shortId} bằng nội dung này` : "Chọn đúng 1 node ảnh/video/prompt trên canvas"}
          >
            {state === "applied" ? "Đã đưa vào node" : target ? `Đưa vào #${target.shortId}` : "Đưa vào node"}
          </button>
        </div>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
