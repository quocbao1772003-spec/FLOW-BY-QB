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
  /** Plain mode: render the textarea text directly (visible), skip the
   *  transparent-text + highlight-mirror overlay. The overlay drifts when
   *  the field lives inside a CSS-scaled container (ReactFlow canvas),
   *  causing cursor jumps + selection misalignment — plain mode avoids
   *  that. The @-mention dropdown still works. */
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

    useImperativeHandle(
      ref,
      () => ({
        focus: () => textareaRef.current?.focus(),
        getTextarea: () => textareaRef.current,
      }),
      [],
    );

    // Connected list first, then disconnected. Used by keyboard nav.
    const filteredConnected = filterNodes(connectedNodes, query);
    const filteredDisconnected = filterNodes(disconnectedNodes, query);
    const flatList: Array<MentionNode & { connected: boolean }> = [
      ...filteredConnected.map((n) => ({ ...n, connected: true })),
      ...filteredDisconnected.map((n) => ({ ...n, connected: false })),
    ];
    const total = flatList.length;

    useEffect(() => {
      if (activeIdx >= total) setActiveIdx(Math.max(0, total - 1));
    }, [total, activeIdx]);

    // Smart popover positioning — picks a corner of the textarea that
    // gives the popup room without falling off the viewport. Strategy:
    //   1. Default to anchor BELOW the textarea, left-aligned.
    //   2. If not enough room below, flip ABOVE the textarea.
    //   3. If the popup would overflow right, shift it left.
    //   4. If neither above nor below fits, pick the side with more
    //      room and let the popup's internal scroll handle the rest.
    const POPUP_W = 360; // matches maxWidth in styles below
    const POPUP_H = 360; // matches maxHeight
    const GAP = 8;

    const updatePopPos = useCallback(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      const rect = ta.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const spaceBelow = vh - rect.bottom;
      const spaceAbove = rect.top;

      // Vertical: prefer below, flip above when needed.
      let top: number;
      if (spaceBelow >= POPUP_H + GAP) {
        top = rect.bottom + 4;
      } else if (spaceAbove >= POPUP_H + GAP) {
        top = rect.top - POPUP_H - 4;
      } else {
        // Neither has full room — pick the bigger side; cap to viewport.
        if (spaceBelow >= spaceAbove) {
          top = Math.min(rect.bottom + 4, vh - Math.min(POPUP_H, spaceBelow) - GAP);
        } else {
          top = Math.max(GAP, rect.top - Math.min(POPUP_H, spaceAbove) - 4);
        }
      }
      // Final clamp to viewport.
      top = Math.max(GAP, Math.min(top, vh - 80));

      // Horizontal: prefer left-aligned to textarea, shift left when
      // popup would overflow the right edge.
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
        setTokenStart(start);
        setQuery(m[2]);
        setActiveIdx(0);
        setOpen(true);
        updatePopPos();
      },
      [updatePopPos],
    );

    // Keep popover anchored if the textarea moves (window resize,
    // scrolling, parent layout shift). Cheap to recompute.
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

    // Sync mirror scroll with textarea scroll so highlights stay
    // aligned when the user scrolls within a long prompt.
    const syncMirrorScroll = useCallback(() => {
      const ta = textareaRef.current;
      const mirror = mirrorRef.current;
      if (!ta || !mirror) return;
      mirror.scrollTop = ta.scrollTop;
      mirror.scrollLeft = ta.scrollLeft;
    }, []);

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const next = e.target.value;
        onChange(next);
        recomputeTokenState(next, e.target.selectionStart ?? next.length);
        // Allow React to commit the new value before re-syncing.
        requestAnimationFrame(syncMirrorScroll);
      },
      [onChange, recomputeTokenState, syncMirrorScroll],
    );

    const handleKeyDown = useCallback(
      (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        onKeyDownPassthrough?.(e);
        if (e.defaultPrevented) return;
        if (!open || total === 0) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIdx((i) => (i + 1) % total);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIdx((i) => (i - 1 + total) % total);
        } else if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const pick = flatList[activeIdx];
          if (pick) insertMention(pick);
        } else if (e.key === "Escape") {
          e.preventDefault();
          setOpen(false);
        }
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [open, total, activeIdx, flatList, onKeyDownPassthrough],
    );

    const insertMention = useCallback(
      (pick: MentionNode & { connected: boolean }) => {
        const ta = textareaRef.current;
        if (ta === null || tokenStart === null) return;
        const cursor = ta.selectionStart ?? value.length;
        // Pick the DISPLAY name in priority order:
        //   1. user-assigned customTitle (the rename)
        //   2. type label (e.g. "Image", "Assistant")
        // Then append " #<shortId>" — the canonical handle the backend
        // uses for lookup. This matches Magnific's mention grammar and
        // means what the user sees IS what's in the textarea (perfect
        // caret alignment, no overlay substitution required).
        const displayName = pick.customTitle?.trim() || pick.type;
        const tokenText = `@${displayName} #${pick.shortId} `;
        const next =
          value.slice(0, tokenStart) + tokenText + value.slice(cursor);
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

    // Click outside closes the popover.
    //
    // CRITICAL: ReactFlow's node event handlers call `stopPropagation`
    // on pointer events, so document-level listeners in the BUBBLE phase
    // never fire. We attach in the CAPTURE phase (third arg `true`)
    // which sees the event before any descendant can stop it.
    //
    // Also listen for both pointerdown AND mousedown — pointerdown is
    // the modern path, mousedown is the fallback when an ancestor
    // converts pointer events. Either is enough to dismiss the popup.
    useEffect(() => {
      if (!open) return;
      const onDown = (e: Event) => {
        const t = e.target as HTMLElement | null;
        if (!t) return;
        if (t.closest(".flowboard-at-mention-popover")) return;
        if (t === textareaRef.current) return;
        if (t.closest(".mention-wrap")) return;
        setOpen(false);
      };
      // Capture phase = sees the event before ReactFlow swallows it.
      document.addEventListener("pointerdown", onDown, true);
      document.addEventListener("mousedown", onDown, true);
      // Also dismiss on textarea blur — when focus moves away to any
      // other UI control the popup should go with it.
      const ta = textareaRef.current;
      const onBlur = () => {
        // 150ms delay so clicking a popup row (which briefly steals
        // focus) doesn't close before the click handler runs.
        window.setTimeout(() => {
          const active = document.activeElement as HTMLElement | null;
          if (active?.closest(".flowboard-at-mention-popover")) return;
          if (active === textareaRef.current) return;
          setOpen(false);
        }, 150);
      };
      ta?.addEventListener("blur", onBlur);
      return () => {
        document.removeEventListener("pointerdown", onDown, true);
        document.removeEventListener("mousedown", onDown, true);
        ta?.removeEventListener("blur", onBlur);
      };
    }, [open]);

    // Mirror styling lives next to the visible textarea's styling so
    // we can guarantee the overlay's text-metrics match. Anything
    // affecting layout MUST be present on BOTH — and locked to
    // explicit values (not "inherit") so wrapper CSS classes injected
    // by the host (e.g. .gen-dialog__textarea) can't override one side
    // without the other.
    //
    // The combo below mirrors what professional rich-text editors do
    // for "overlay" mode (Slate, Lexical, etc.): fully lock down the
    // font cascade.
    const sharedFieldCss: CSSProperties = {
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif',
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
      border: "1px solid transparent",
      borderRadius: 8,
      boxSizing: "border-box",
      whiteSpace: "pre-wrap",
      wordWrap: "break-word",
      overflowWrap: "break-word",
    };

    // Pull out the bits of user's style that affect layout (size) so the
    // wrapper can position correctly. Everything VISUAL (color, bg, border,
    // border-radius, padding) we ignore — we set those on the mirror/
    // textarea pair directly so the mirror's metrics always line up.
    const wrapperLayoutStyle: CSSProperties = {
      flex: (style as Record<string, unknown> | undefined)?.flex as CSSProperties["flex"],
      minHeight: (style as Record<string, unknown> | undefined)?.minHeight as CSSProperties["minHeight"],
      minWidth: (style as Record<string, unknown> | undefined)?.minWidth as CSSProperties["minWidth"],
      maxHeight: (style as Record<string, unknown> | undefined)?.maxHeight as CSSProperties["maxHeight"],
      width: ((style as Record<string, unknown> | undefined)?.width as CSSProperties["width"]) ?? "100%",
      height: (style as Record<string, unknown> | undefined)?.height as CSSProperties["height"],
    };
    // ZERO out any "undefined" props so they don't override inherits.
    Object.keys(wrapperLayoutStyle).forEach((k) => {
      const v = (wrapperLayoutStyle as Record<string, unknown>)[k];
      if (v === undefined) delete (wrapperLayoutStyle as Record<string, unknown>)[k];
    });

    return (
      <div
        ref={wrapperRef}
        // `mention-wrap` is our own marker class — used by the
        // click-outside handler to ignore clicks that land on the
        // textarea OR its mirror overlay (both children of this wrap).
        // The user's `className` is appended so layout/positioning
        // styles still apply.
        className={`mention-wrap${className ? ` ${className}` : ""}`}
        style={{
          position: "relative",
          boxSizing: "border-box",
          // CRITICAL: do NOT clip overflow — popup is portal'd anyway,
          // but the wrapper must let the textarea's native scrollbar
          // appear when needed.
          overflow: "visible",
          ...wrapperLayoutStyle,
        }}
      >
        {/* Background mirror — renders the same text as the textarea
            but with @-mention tokens highlighted as colored pills. Sits
            behind the (transparent) textarea so the user sees the
            highlights through it.

            CRITICAL: this div MUST inherit textarea's exact font-metrics
            (line-height, font-size, padding, wrap mode) for caret
            position alignment. */}
        {/* Highlight mirror — skipped in plain mode (the overlay drifts
            under CSS scale, e.g. inside the ReactFlow canvas). */}
        {!plain && (
          <div
            ref={mirrorRef}
            aria-hidden="true"
            style={{
              ...sharedFieldCss,
              position: "absolute",
              inset: 0,
              color: "#e4e7ec",
              background: "#0f1115",
              border: "1px solid #2a2e38",
              pointerEvents: "none",
              overflow: "hidden",
              wordBreak: "break-word",
            }}
          >
            {renderHighlightedContent(value)}
          </div>
        )}

        {/* Real textarea. Default: transparent text over the mirror.
            Plain mode: visible text, no mirror — robust under scale. */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onScroll={plain ? undefined : syncMirrorScroll}
          onKeyDown={handleKeyDown}
          onFocus={updatePopPos}
          placeholder={placeholder}
          disabled={disabled}
          rows={rows}
          wrap="soft"
          style={{
            ...sharedFieldCss,
            position: "relative",
            zIndex: 1,
            display: "block",
            width: "100%",
            height: "100%",
            color: plain ? "#e4e7ec" : "transparent",
            background: plain ? "#0f1115" : "transparent",
            caretColor: "#e4e7ec",
            border: plain ? "1px solid #2a2e38" : "1px solid transparent",
            resize: "none",
            outline: "none",
            // Match the mirror wrap.
            wordBreak: "break-word",
          }}
        />

        {/* Popover — portal'd to body. Two CRITICAL hacks for visibility:
            1. Z-index near max int — beats any modal backdrop / overlay
               on the page.
            2. ``isolation: isolate`` on the inner card forces a fresh
               stacking context so backdrop-filter etc don't bleed. */}
        {open
          && popPos
          && total > 0
          && createPortal(
            <div
              className="flowboard-at-mention-popover"
              role="listbox"
              style={{
                position: "fixed",
                left: popPos.left,
                top: popPos.top,
                zIndex: 2147483647,
                isolation: "isolate",
                background: "#15171c",
                border: "1px solid #3a3f4a",
                borderRadius: 12,
                boxShadow: "0 12px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.4)",
                padding: 8,
                minWidth: 320,
                maxWidth: 420,
                maxHeight: 360,
                overflowY: "auto",
                fontFamily: "system-ui, -apple-system, sans-serif",
                fontSize: 13,
                color: "#e4e7ec",
              }}
            >
              {filteredConnected.length > 0 && (
                <>
                  <div style={sectionLabelStyle}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "#5db97a",
                        display: "inline-block",
                        marginRight: 6,
                      }}
                    />
                    CONNECTED
                  </div>
                  {filteredConnected.map((n, i) => (
                    <MentionRow
                      key={`c-${n.id}`}
                      node={n}
                      connected
                      active={activeIdx === i}
                      onClick={() => insertMention({ ...n, connected: true })}
                      onHover={() => setActiveIdx(i)}
                    />
                  ))}
                </>
              )}
              {filteredDisconnected.length > 0 && (
                <>
                  <div style={{ ...sectionLabelStyle, marginTop: 8 }}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "#5a5f69",
                        display: "inline-block",
                        marginRight: 6,
                      }}
                    />
                    NOT CONNECTED
                  </div>
                  {filteredDisconnected.map((n, i) => {
                    const idx = filteredConnected.length + i;
                    return (
                      <MentionRow
                        key={`d-${n.id}`}
                        node={n}
                        connected={false}
                        active={activeIdx === idx}
                        onClick={() => insertMention({ ...n, connected: false })}
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

// ─────────────────────────────────────────────────────────────────────
// Mirror highlighting — turn raw text into ReactNodes where every
// `@Type#shortId` token gets wrapped in a colored pill <span>.
// ─────────────────────────────────────────────────────────────────────
function renderHighlightedContent(text: string): ReactNode[] {
  // Trailing newline trick — textareas render an extra empty line at
  // the bottom of a string ending with \n that <div> doesn't, throwing
  // the alignment off by one row. Append a zero-width space so the
  // div mirrors the same height.
  const display = text.endsWith("\n") ? text + "​" : text;

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  MENTION_COMPLETED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_COMPLETED_RE.exec(display)) !== null) {
    if (m.index > lastIndex) {
      parts.push(display.slice(lastIndex, m.index));
    }
    // CRITICAL: this span MUST NOT change text metrics. The textarea
    // behind us renders the SAME characters with no styling — if we
    // add padding/border/font-weight here, every character after the
    // tag drifts further from its actual caret position.
    //
    // Trade-off: we get a less "pill-like" highlight (no padding,
    // no border, normal font-weight), but the caret stays glued to
    // the right letter as the user types past the mention.
    parts.push(
      <span
        key={`mention-${m.index}`}
        style={{
          color: "#c4b5fd",
          background: "rgba(139, 92, 246, 0.22)",
          borderRadius: 3,
          // padding / border / font-weight would shift metrics; do NOT add them.
          // Box-shadow draws a faux "border" that doesn't take up width.
          boxShadow: "inset 0 0 0 1px rgba(139, 92, 246, 0.45)",
        }}
      >
        {m[0]}
      </span>,
    );
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < display.length) {
    parts.push(display.slice(lastIndex));
  }
  return parts;
}

const sectionLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 1.2,
  color: "#8a8f99",
  padding: "6px 10px 6px",
  textTransform: "uppercase",
  display: "flex",
  alignItems: "center",
};

function MentionRow({
  node,
  connected,
  active,
  onClick,
  onHover,
}: {
  node: MentionNode;
  connected: boolean;
  active: boolean;
  onClick: () => void;
  onHover: () => void;
}) {
  return (
    <div
      // Keep the textarea focused — mousedown default would blur it,
      // which (in the inline node editor) closes the editor before the
      // tag is inserted. preventDefault keeps focus so the click inserts.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      onMouseEnter={onHover}
      role="option"
      aria-selected={active}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 12px",
        borderRadius: 8,
        cursor: "pointer",
        background: active ? "#2a2e38" : "transparent",
        userSelect: "none",
        transition: "background 0.08s",
      }}
    >
      <span
        style={{
          width: 24,
          height: 24,
          borderRadius: 6,
          background: connected ? "rgba(139, 92, 246, 0.18)" : "#22262e",
          color: connected ? "#c4b5fd" : "#8a8f99",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          flexShrink: 0,
        }}
      >
        {iconForType(node.type)}
      </span>
      <div style={{ flex: 1, minWidth: 0, lineHeight: 1.3 }}>
        {/* When the node has a user-assigned title, surface that as the
            primary text (mirroring Magnific's "rename then @-search"
            workflow). Type + shortId become the secondary line so the
            user still knows which canonical node they're picking. */}
        {node.customTitle ? (
          <>
            <div style={{ fontWeight: 600 }}>{node.customTitle}</div>
            <div
              style={{
                fontSize: 11,
                color: "#8a8f99",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                marginTop: 1,
              }}
            >
              {node.type} #{node.shortId}
            </div>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 600 }}>
              {node.type} #{node.shortId}
            </div>
            {node.label && (
              <div
                style={{
                  fontSize: 11,
                  color: "#8a8f99",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  marginTop: 1,
                }}
              >
                {node.label}
              </div>
            )}
          </>
        )}
      </div>
      {!connected && (
        <span
          title="Picking this will auto-create an edge"
          style={{
            fontSize: 10,
            color: "#5db97a",
            background: "rgba(93, 185, 122, 0.12)",
            border: "1px solid rgba(93, 185, 122, 0.4)",
            padding: "2px 7px",
            borderRadius: 4,
            fontWeight: 600,
            letterSpacing: 0.3,
            flexShrink: 0,
          }}
        >
          + link
        </span>
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
    // Custom title gets first chance — that's the name the user
    // explicitly chose to look the node up by.
    if (n.customTitle?.toLowerCase().includes(q)) return true;
    if (n.type.toLowerCase().includes(q)) return true;
    if (n.shortId.toLowerCase().includes(q)) return true;
    if (n.label?.toLowerCase().includes(q)) return true;
    return false;
  });
}
