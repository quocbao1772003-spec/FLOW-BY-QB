import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./MentionAutocomplete.css";

/**
 * Reusable textarea with @-mention autocomplete + inline tag highlighting.
 *
 * Behaviour
 * ---------
 * - Typing `@` opens a popover listing mentionable nodes (CONNECTED first,
 *   then NOT CONNECTED). Filter by typing more characters.
 * - ↑ / ↓ navigate, Enter / Tab insert, Esc closes.
 * - Inserted tokens (e.g. ``@Image#xqj1``) are rendered as colored pills
 *   inline via a mirror div behind the (transparent) textarea — same
 *   technique most chat apps use for mention highlighting.
 *
 * Critical implementation notes
 * -----------------------------
 * - The popover is rendered through ``createPortal(..., document.body)``
 *   because ReactFlow wraps the canvas in a CSS ``transform: scale``
 *   container — that turns ``position: fixed`` into "position relative
 *   to the transformed ancestor", clipping any popup that tries to
 *   escape via inset values. Portalling to body sidesteps the issue.
 * - The mirror overlay re-implements the textarea's wrap/padding/font
 *   1:1 so caret positions line up. If you tweak the visible textarea's
 *   font / padding, mirror those changes onto the overlay too.
 */

export interface MentionNode {
  id: string;
  type: string;
  shortId: string;
  label?: string;
  /** User-assigned display name (Magnific-style rename). When set this
   * takes priority over `Type #shortId` in the dropdown row. The inserted
   * mention token still uses the canonical `@Type#shortId` syntax — the
   * custom name is display-only so the backend parser stays simple. */
  customTitle?: string;
  /** Optional preview image shown in the picker row. */
  thumbUrl?: string;
}

export interface MentionAutocompleteHandle {
  focus: () => void;
  getTextarea: () => HTMLTextAreaElement | null;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  connectedNodes: MentionNode[];
  disconnectedNodes: MentionNode[];
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  className?: string;
  style?: CSSProperties;
  onMention?: (nodeId: string, isConnected: boolean) => void;
  onKeyDownPassthrough?: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  /** Plain mode: visible textarea text, no highlight mirror. (The mirror
   *  used to drift inside the scaled canvas — the cause was the textarea's
   *  scrollbar narrowing its text box; the mirror now compensates, so the
   *  canvas editor uses the highlighted mode too.) */
  plain?: boolean;
}

/** Token grammar — matches what's INSERTED into the textarea after a
 * popover pick.
 *
 * Token format: ``@<DisplayName> #<shortId>``
 *   - Magnific-style: visible name first, separator " #" before id.
 *   - DisplayName can contain spaces / unicode (e.g. "Cờ Argentina").
 *   - shortId is the canonical lookup handle the backend resolves
 *     against `node.short_id`.
 *
 * The mirror highlights the whole token in a single colored pill.
 * The in-progress regex catches `@<query>` before the user finishes
 * typing — `\w` is fine here because the user's query is short (no
 * spaces yet), and as soon as they pick from the dropdown the
 * insertion replaces it with the full name+id form. */
const MENTION_IN_PROGRESS_RE = /(^|\s)@([\w-]*)$/;
// Captures: <name (anything except @ / newline / #, non-greedy)>, then
// optional space, then <#shortId>. The `\s?` makes the new format
// (with space) and the legacy format (no space) both highlight cleanly.
const MENTION_COMPLETED_RE = /@([^@\n#]+?)\s?#([A-Za-z0-9_-]+)/g;

export const MentionAutocomplete = forwardRef<MentionAutocompleteHandle, Props>(
  function MentionAutocomplete(
    {
      value,
      onChange,
      connectedNodes,
      disconnectedNodes,
      placeholder,
      disabled,
      rows = 5,
      className,
      style,
      onMention,
      onKeyDownPassthrough,
      plain = false,
    },
    ref,
  ) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const mirrorRef = useRef<HTMLDivElement>(null);

    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [tokenStart, setTokenStart] = useState<number | null>(null);
    const [activeIdx, setActiveIdx] = useState(0);
    const [popPos, setPopPos] = useState<{ left: number; top: number } | null>(null);
    // "Swap" mode: the user clicked an existing tag — the same popover lists
    // the nodes it can be switched to, and a pick replaces that tag in place.
    const [swap, setSwap] = useState<{ start: number; end: number; shortId: string } | null>(null);
    // Extra right padding for the mirror so it wraps exactly like the
    // textarea once the textarea grows a vertical scrollbar.
    const [scrollbarPad, setScrollbarPad] = useState(0);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => textareaRef.current?.focus(),
        getTextarea: () => textareaRef.current,
      }),
      [],
    );

    // Connected list first, then disconnected. Used by keyboard nav.
    const listQuery = swap ? "" : query;
    const filteredConnected = filterNodes(connectedNodes, listQuery);
    const filteredDisconnected = filterNodes(disconnectedNodes, listQuery);
    const flatList: Array<MentionNode & { connected: boolean }> = [
      ...filteredConnected.map((n) => ({ ...n, connected: true })),
      ...filteredDisconnected.map((n) => ({ ...n, connected: false })),
    ];
    const total = flatList.length;
    const popOpen = open || swap !== null;

    useEffect(() => {
      if (activeIdx >= total) setActiveIdx(Math.max(0, total - 1));
    }, [total, activeIdx]);

    // Popover placement. Anchors to the clicked tag in swap mode, otherwise
    // to the textarea: below when there is room, else above; shifted left
    // if it would leave the viewport.
    const POPUP_W = 360;
    const POPUP_H = 360;
    const GAP = 8;

    const updatePopPos = useCallback((anchor?: DOMRect | null) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const rect = anchor ?? ta.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const spaceBelow = vh - rect.bottom;
      const spaceAbove = rect.top;

      let top: number;
      if (spaceBelow >= POPUP_H + GAP) {
        top = rect.bottom + 4;
      } else if (spaceAbove >= POPUP_H + GAP) {
        top = rect.top - POPUP_H - 4;
      } else if (spaceBelow >= spaceAbove) {
        top = Math.min(rect.bottom + 4, vh - Math.min(POPUP_H, spaceBelow) - GAP);
      } else {
        top = Math.max(GAP, rect.top - Math.min(POPUP_H, spaceAbove) - 4);
      }
      top = Math.max(GAP, Math.min(top, vh - 80));

      let left = rect.left;
      if (left + POPUP_W > vw - GAP) {
        left = Math.max(GAP, vw - POPUP_W - GAP);
      }
      setPopPos({ left, top });
    }, []);

    const recomputeTokenState = useCallback(
      (text: string, cursor: number) => {
        const before = text.slice(0, cursor);
        const m = before.match(MENTION_IN_PROGRESS_RE);
        if (!m) {
          setOpen(false);
          setQuery("");
          setTokenStart(null);
          return;
        }
        const start = before.length - (m[2].length + 1);
        setSwap(null);
        setTokenStart(start);
        setQuery(m[2]);
        setActiveIdx(0);
        setOpen(true);
        updatePopPos();
      },
      [updatePopPos],
    );

    // Keep the popover anchored while the page moves.
    useLayoutEffect(() => {
      if (!open) return;
      updatePopPos();
      const onResize = () => updatePopPos();
      window.addEventListener("resize", onResize);
      window.addEventListener("scroll", onResize, true);
      return () => {
        window.removeEventListener("resize", onResize);
        window.removeEventListener("scroll", onResize, true);
      };
    }, [open, updatePopPos]);

    const syncMirrorScroll = useCallback(() => {
      const ta = textareaRef.current;
      const mirror = mirrorRef.current;
      if (!ta || !mirror) return;
      mirror.scrollTop = ta.scrollTop;
      mirror.scrollLeft = ta.scrollLeft;
    }, []);

    // The textarea's scrollbar (once the text overflows) narrows its text
    // box; the mirror has none, so without this it wraps later and every
    // highlight after the first wrapped line drifts. Layout sizes, so this
    // holds under the canvas' CSS scale too.
    useLayoutEffect(() => {
      if (plain) return;
      const ta = textareaRef.current;
      if (!ta) return;
      const measure = () => {
        const cs = window.getComputedStyle(ta);
        const borders = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
        const sb = Math.max(0, ta.offsetWidth - ta.clientWidth - borders);
        setScrollbarPad((p) => (Math.abs(p - sb) > 0.5 ? sb : p));
        syncMirrorScroll();
      };
      measure();
      const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
      ro?.observe(ta);
      return () => ro?.disconnect();
    }, [value, plain, syncMirrorScroll]);

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const next = e.target.value;
        setSwap(null);
        onChange(next);
        recomputeTokenState(next, e.target.selectionStart ?? next.length);
        requestAnimationFrame(syncMirrorScroll);
      },
      [onChange, recomputeTokenState, syncMirrorScroll],
    );

    const insertMention = useCallback(
      (pick: MentionNode & { connected: boolean }) => {
        const ta = textareaRef.current;
        if (ta === null || tokenStart === null) return;
        const cursor = ta.selectionStart ?? value.length;
        // Display name: the user's rename first, else the type. The " #id"
        // suffix is the handle the backend resolves.
        const tokenText = `${tokenFor(pick)} `;
        const next = value.slice(0, tokenStart) + tokenText + value.slice(cursor);
        onChange(next);
        setOpen(false);
        setTokenStart(null);
        const newCursor = tokenStart + tokenText.length;
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.focus();
            textareaRef.current.setSelectionRange(newCursor, newCursor);
          }
        });
        onMention?.(pick.id, pick.connected);
      },
      [tokenStart, value, onChange, onMention],
    );

    /** Replace the clicked tag with another node's tag. */
    const swapMention = useCallback(
      (pick: MentionNode & { connected: boolean }) => {
        if (!swap) return;
        const tokenText = tokenFor(pick);
        const next = value.slice(0, swap.start) + tokenText + value.slice(swap.end);
        onChange(next);
        setSwap(null);
        const newCursor = swap.start + tokenText.length;
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.focus();
            textareaRef.current.setSelectionRange(newCursor, newCursor);
          }
        });
        if (pick.shortId !== swap.shortId) onMention?.(pick.id, pick.connected);
      },
      [swap, value, onChange, onMention],
    );

    const choose = useCallback(
      (pick: MentionNode & { connected: boolean }) => {
        if (swap) swapMention(pick);
        else insertMention(pick);
      },
      [swap, swapMention, insertMention],
    );

    /** A click that lands inside a completed tag opens the swap list. */
    const handleClickInText = useCallback(() => {
      const ta = textareaRef.current;
      if (!ta || disabled) return;
      const a = ta.selectionStart ?? 0;
      const b = ta.selectionEnd ?? 0;
      if (a !== b) {
        setSwap(null);
        return;
      }
      MENTION_COMPLETED_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      let hit: { start: number; end: number; shortId: string } | null = null;
      while ((m = MENTION_COMPLETED_RE.exec(value)) !== null) {
        const start = m.index;
        const end = m.index + m[0].length;
        if (a >= start && a < end) {
          hit = { start, end, shortId: m[2] };
          break;
        }
      }
      if (!hit) {
        setSwap(null);
        return;
      }
      setOpen(false);
      setTokenStart(null);
      setSwap(hit);
      const all = [...connectedNodes, ...disconnectedNodes];
      const cur = all.findIndex((n) => n.shortId === hit!.shortId);
      setActiveIdx(cur >= 0 ? cur : 0);
      const span = mirrorRef.current?.querySelector<HTMLElement>(`[data-ms="${hit.start}"]`);
      updatePopPos(span ? span.getBoundingClientRect() : null);
    }, [value, disabled, connectedNodes, disconnectedNodes, updatePopPos]);

    const handleKeyDown = useCallback(
      (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (popOpen && total > 0) {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            setActiveIdx((i) => (i + 1) % total);
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            setActiveIdx((i) => (i - 1 + total) % total);
            return;
          }
          if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            e.stopPropagation();
            const pick = flatList[activeIdx];
            if (pick) choose(pick);
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            setSwap(null);
            return;
          }
        }
        onKeyDownPassthrough?.(e);
      },
      [popOpen, total, activeIdx, flatList, choose, onKeyDownPassthrough],
    );

    // Click outside closes the popover. Capture phase: ReactFlow stops
    // pointer events from bubbling.
    useEffect(() => {
      if (!popOpen) return;
      const onDown = (e: Event) => {
        const t = e.target as HTMLElement | null;
        if (!t) return;
        if (t.closest(".flowboard-at-mention-popover")) return;
        if (t === textareaRef.current) return;
        if (t.closest(".mention-wrap")) return;
        setOpen(false);
        setSwap(null);
      };
      document.addEventListener("pointerdown", onDown, true);
      document.addEventListener("mousedown", onDown, true);
      const ta = textareaRef.current;
      const onBlur = () => {
        window.setTimeout(() => {
          const active = document.activeElement as HTMLElement | null;
          if (active?.closest(".flowboard-at-mention-popover")) return;
          if (active === textareaRef.current) return;
          setOpen(false);
          setSwap(null);
        }, 150);
      };
      ta?.addEventListener("blur", onBlur);
      return () => {
        document.removeEventListener("pointerdown", onDown, true);
        document.removeEventListener("mousedown", onDown, true);
        ta?.removeEventListener("blur", onBlur);
      };
    }, [popOpen]);

    // Everything that affects text layout is pinned here and applied to
    // BOTH the textarea and the mirror; colours/borders live in CSS.
    const sharedFieldCss: CSSProperties = {
      fontFamily:
        'var(--font-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)',
      fontSize: 13,
      fontWeight: 400,
      lineHeight: 1.5,
      letterSpacing: 0,
      wordSpacing: 0,
      fontKerning: "none",
      fontVariantLigatures: "none",
      fontFeatureSettings: "normal",
      textRendering: "geometricPrecision",
      tabSize: 4,
      padding: 10,
      borderWidth: 1,
      borderStyle: "solid",
      borderRadius: 8,
      boxSizing: "border-box",
      whiteSpace: "pre-wrap",
      wordWrap: "break-word",
      overflowWrap: "break-word",
      wordBreak: "break-word",
    };

    const wrapperLayoutStyle: CSSProperties = {
      flex: (style as Record<string, unknown> | undefined)?.flex as CSSProperties["flex"],
      minHeight: (style as Record<string, unknown> | undefined)?.minHeight as CSSProperties["minHeight"],
      minWidth: (style as Record<string, unknown> | undefined)?.minWidth as CSSProperties["minWidth"],
      maxHeight: (style as Record<string, unknown> | undefined)?.maxHeight as CSSProperties["maxHeight"],
      width: ((style as Record<string, unknown> | undefined)?.width as CSSProperties["width"]) ?? "100%",
      height: (style as Record<string, unknown> | undefined)?.height as CSSProperties["height"],
    };
    Object.keys(wrapperLayoutStyle).forEach((k) => {
      const v = (wrapperLayoutStyle as Record<string, unknown>)[k];
      if (v === undefined) delete (wrapperLayoutStyle as Record<string, unknown>)[k];
    });

    const currentShortId = swap?.shortId ?? null;

    return (
      <div
        ref={wrapperRef}
        className={`mention-wrap${plain ? " mention-wrap--plain" : ""}${className ? ` ${className}` : ""}`}
        style={{
          position: "relative",
          boxSizing: "border-box",
          overflow: "visible",
          ...wrapperLayoutStyle,
        }}
      >
        {!plain && (
          <div
            ref={mirrorRef}
            aria-hidden="true"
            className="mention-mirror"
            style={{
              ...sharedFieldCss,
              paddingRight: 10 + scrollbarPad,
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              overflow: "hidden",
            }}
          >
            {renderHighlightedContent(value, swap?.start ?? null)}
          </div>
        )}

        <textarea
          ref={textareaRef}
          className="mention-field"
          value={value}
          onChange={handleChange}
          onScroll={plain ? undefined : syncMirrorScroll}
          onKeyDown={handleKeyDown}
          onClick={handleClickInText}
          onFocus={() => updatePopPos()}
          placeholder={placeholder}
          disabled={disabled}
          rows={rows}
          wrap="soft"
          spellCheck={false}
          style={{
            ...sharedFieldCss,
            position: "relative",
            zIndex: 1,
            display: "block",
            width: "100%",
            height: "100%",
            resize: "none",
            outline: "none",
          }}
        />

        {popOpen &&
          popPos &&
          total > 0 &&
          createPortal(
            <div
              className="flowboard-at-mention-popover mention-pop"
              role="listbox"
              style={{ left: popPos.left, top: popPos.top }}
            >
              {swap && <div className="mention-pop__title">Đổi tag thành…</div>}
              {filteredConnected.length > 0 && (
                <>
                  <div className="mention-pop__section">
                    <span className="mention-pop__dot mention-pop__dot--on" />
                    {swap ? "Đang nối vào node" : "Connected"}
                  </div>
                  {filteredConnected.map((n, i) => (
                    <MentionRow
                      key={`c-${n.id}`}
                      node={n}
                      connected
                      current={n.shortId === currentShortId}
                      active={activeIdx === i}
                      onClick={() => choose({ ...n, connected: true })}
                      onHover={() => setActiveIdx(i)}
                    />
                  ))}
                </>
              )}
              {filteredDisconnected.length > 0 && (
                <>
                  <div className="mention-pop__section">
                    <span className="mention-pop__dot" />
                    {swap ? "Chưa nối (sẽ tự nối)" : "Not connected"}
                  </div>
                  {filteredDisconnected.map((n, i) => {
                    const idx = filteredConnected.length + i;
                    return (
                      <MentionRow
                        key={`d-${n.id}`}
                        node={n}
                        connected={false}
                        current={n.shortId === currentShortId}
                        active={activeIdx === idx}
                        onClick={() => choose({ ...n, connected: false })}
                        onHover={() => setActiveIdx(idx)}
                      />
                    );
                  })}
                </>
              )}
            </div>,
            document.body,
          )}
      </div>
    );
  },
);

/** Text inserted for a node: `@<rename or Type> #<shortId>`. */
function tokenFor(n: MentionNode): string {
  const displayName = n.customTitle?.trim() || n.type;
  return `@${displayName} #${n.shortId}`;
}

// ─────────────────────────────────────────────────────────────────────
// Mirror highlighting — every `@Name #shortId` token becomes a pill <span>.
// ─────────────────────────────────────────────────────────────────────
function renderHighlightedContent(text: string, swapStart: number | null): ReactNode[] {
  // A trailing newline renders an extra empty row in a textarea but not in
  // a div — pad it so heights match.
  const display = text.endsWith("\n") ? text + "​" : text;

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  MENTION_COMPLETED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_COMPLETED_RE.exec(display)) !== null) {
    if (m.index > lastIndex) parts.push(display.slice(lastIndex, m.index));
    // The pill must not change text metrics (no padding / border / weight)
    // or the caret drifts from the letters; the outline is a box-shadow.
    parts.push(
      <span
        key={`mention-${m.index}`}
        data-ms={m.index}
        className={`mention-tag${swapStart === m.index ? " mention-tag--swapping" : ""}`}
      >
        {m[0]}
      </span>,
    );
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < display.length) parts.push(display.slice(lastIndex));
  return parts;
}

function MentionRow({
  node,
  connected,
  current,
  active,
  onClick,
  onHover,
}: {
  node: MentionNode;
  connected: boolean;
  current?: boolean;
  active: boolean;
  onClick: () => void;
  onHover: () => void;
}) {
  return (
    <div
      // Keep the textarea focused — a blur would close the inline editor
      // before the pick lands.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      onMouseEnter={onHover}
      role="option"
      aria-selected={active}
      className={`mention-row${active ? " mention-row--active" : ""}${current ? " mention-row--current" : ""}`}
    >
      {node.thumbUrl ? (
        <img className="mention-row__thumb" src={node.thumbUrl} alt="" draggable={false} />
      ) : (
        <span className={`mention-row__icon${connected ? " mention-row__icon--on" : ""}`}>
          {iconForType(node.type)}
        </span>
      )}
      <div className="mention-row__text">
        {node.customTitle ? (
          <>
            <div className="mention-row__name">{node.customTitle}</div>
            <div className="mention-row__sub">
              {node.type} #{node.shortId}
            </div>
          </>
        ) : (
          <>
            <div className="mention-row__name">
              {node.type} #{node.shortId}
            </div>
            {node.label && <div className="mention-row__sub">{node.label}</div>}
          </>
        )}
      </div>
      {current ? (
        <span className="mention-row__badge mention-row__badge--current">Đang dùng</span>
      ) : (
        !connected && (
          <span className="mention-row__badge" title="Chọn sẽ tự nối dây vào node">
            + nối
          </span>
        )
      )}
    </div>
  );
}

function iconForType(type: string): string {
  switch (type.toLowerCase()) {
    case "character":
      return "◎";
    case "image":
      return "▣";
    case "video":
      return "▶";
    case "prompt":
      return "✦";
    case "note":
      return "✎";
    case "visual_asset":
    case "visualasset":
      return "◇";
    case "storyboard":
      return "▦";
    case "assistant":
      return "✨";
    default:
      return "○";
  }
}

function filterNodes(nodes: MentionNode[], query: string): MentionNode[] {
  if (!query) return nodes;
  const q = query.toLowerCase();
  return nodes.filter((n) => {
    if (n.customTitle?.toLowerCase().includes(q)) return true;
    if (n.type.toLowerCase().includes(q)) return true;
    if (n.shortId.toLowerCase().includes(q)) return true;
    if (n.label?.toLowerCase().includes(q)) return true;
    return false;
  });
}
