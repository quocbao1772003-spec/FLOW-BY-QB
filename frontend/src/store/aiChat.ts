import { create } from "zustand";
import { streamAiChat, type AiModel } from "../api/aiChat";
import { TEMPLATES, type ChatTemplate } from "../components/ai-chat/templates";

/** A canvas node handed to the assistant as context (and its image, if any). */
export interface ChatRef {
  rfId: string;
  shortId: string;
  title: string;
  type: string;
  prompt?: string;
  mediaId?: string;
}

/** Turn a canvas node into a chat reference (its active image + prompt). */
export function refFromNode(n: { id: string; data: Record<string, unknown> }): ChatRef {
  const d = n.data;
  const mediaId =
    (typeof d.mediaId === "string" && d.mediaId) ||
    (Array.isArray(d.mediaIds) ? (d.mediaIds.find((m) => typeof m === "string" && m) as string | undefined) : undefined);
  return {
    rfId: n.id,
    shortId: String(d.shortId ?? n.id),
    title: String(d.title || d.type || "Node"),
    type: String(d.type ?? "node"),
    prompt: typeof d.prompt === "string" ? d.prompt : undefined,
    mediaId: mediaId || undefined,
  };
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  refs?: ChatRef[];
  error?: string;
  streaming?: boolean;
}

interface AiChatState {
  open: boolean;
  model: AiModel;
  messages: ChatMessage[];
  draft: string;
  draftRefs: ChatRef[];
  streaming: boolean;
  /** Bumped when something outside the panel wants the composer focused. */
  focusTick: number;
  toggle(): void;
  setOpen(v: boolean): void;
  setModel(m: AiModel): void;
  setDraft(t: string): void;
  addRefs(refs: ChatRef[]): void;
  removeRef(rfId: string): void;
  newChat(): void;
  send(): Promise<void>;
  stop(): void;
  /** "Use": open the panel, attach these nodes, send the template right away. */
  runTemplate(id: ChatTemplate["id"], refs: ChatRef[]): Promise<void>;
  /** Node toolbar "Use": open the panel and attach the image — nothing is sent. */
  attachToChat(refs: ChatRef[]): void;
  /** Put a template in the composer for editing (cursor on the first blank). */
  fillTemplate(id: ChatTemplate["id"], refs: ChatRef[]): string;
}

const KEY = "flowboard.aichat.v1";
const MAX_SAVED = 60;

interface Persisted {
  open: boolean;
  model: AiModel;
  messages: ChatMessage[];
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>;
      return {
        open: !!p.open,
        model: p.model === "opus" || p.model === "haiku" ? p.model : "sonnet",
        messages: Array.isArray(p.messages)
          ? p.messages.filter((m) => m && (m.role === "user" || m.role === "assistant")).map((m) => ({ ...m, streaming: false }))
          : [],
      };
    }
  } catch {
    /* storage blocked */
  }
  return { open: false, model: "sonnet", messages: [] };
}

function save(s: Persisted): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ open: s.open, model: s.model, messages: s.messages.slice(-MAX_SAVED) }),
    );
  } catch {
    /* quota / private mode */
  }
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

let controller: AbortController | null = null;

function contextFor(refs: ChatRef[]): string | undefined {
  if (refs.length === 0) return undefined;
  return refs
    .map((r) => {
      const lines = [`Node #${r.shortId} — ${r.title} (${r.type})`];
      if (r.prompt?.trim()) lines.push(`Prompt hiện tại: ${r.prompt.trim()}`);
      if (r.mediaId) lines.push("Có ảnh đính kèm.");
      return lines.join("\n");
    })
    .join("\n\n");
}

const initial = load();

export const useAiChatStore = create<AiChatState>((set, get) => {
  const persist = () => {
    const s = get();
    save({ open: s.open, model: s.model, messages: s.messages });
  };

  return {
    open: initial.open,
    model: initial.model,
    messages: initial.messages,
    draft: "",
    draftRefs: [],
    streaming: false,
    focusTick: 0,

    toggle() {
      set((s) => ({ open: !s.open }));
      persist();
    },
    setOpen(v) {
      set({ open: v });
      persist();
    },
    setModel(m) {
      set({ model: m });
      persist();
    },
    setDraft(t) {
      set({ draft: t });
    },
    addRefs(refs) {
      set((s) => {
        const seen = new Set(s.draftRefs.map((r) => r.rfId));
        return { draftRefs: [...s.draftRefs, ...refs.filter((r) => !seen.has(r.rfId))].slice(0, 6) };
      });
    },
    removeRef(rfId) {
      set((s) => ({ draftRefs: s.draftRefs.filter((r) => r.rfId !== rfId) }));
    },
    newChat() {
      get().stop();
      set({ messages: [], draft: "", draftRefs: [] });
      persist();
    },
    stop() {
      controller?.abort();
      controller = null;
    },

    async runTemplate(id, refs) {
      const t = TEMPLATES.find((x) => x.id === id);
      if (!t || get().streaming) return;
      set({ open: true, draft: t.text(false), draftRefs: refs.slice(0, 6) });
      persist();
      await get().send();
    },

    attachToChat(refs) {
      set((s) => {
        const seen = new Set(s.draftRefs.map((r) => r.rfId));
        return {
          open: true,
          draftRefs: [...s.draftRefs, ...refs.filter((r) => !seen.has(r.rfId))].slice(0, 6),
          focusTick: s.focusTick + 1,
        };
      });
      persist();
    },

    fillTemplate(id, refs) {
      const t = TEMPLATES.find((x) => x.id === id);
      if (!t) return "";
      const text = t.text(true);
      set((s) => {
        const seen = new Set(s.draftRefs.map((r) => r.rfId));
        return {
          open: true,
          draft: text,
          draftRefs: [...s.draftRefs, ...refs.filter((r) => !seen.has(r.rfId))].slice(0, 6),
        };
      });
      persist();
      return text;
    },

    async send() {
      const { draft, draftRefs, streaming, model } = get();
      const text = draft.trim();
      if (!text || streaming) return;

      const userMsg: ChatMessage = { id: uid(), role: "user", content: text, refs: draftRefs.length ? draftRefs : undefined };
      const reply: ChatMessage = { id: uid(), role: "assistant", content: "", streaming: true };
      const history = [...get().messages, userMsg];
      set({ messages: [...history, reply], draft: "", draftRefs: [], streaming: true });

      const patchReply = (fn: (m: ChatMessage) => ChatMessage) =>
        set((s) => ({ messages: s.messages.map((m) => (m.id === reply.id ? fn(m) : m)) }));

      controller = new AbortController();
      try {
        await streamAiChat(
          {
            messages: history
              .filter((m) => !m.error && m.content.trim())
              .map((m) => ({ role: m.role, content: m.content })),
            model,
            context: contextFor(draftRefs),
            attachments: draftRefs.map((r) => r.mediaId).filter((x): x is string => !!x),
          },
          (ev) => {
            if (ev.type === "delta") patchReply((m) => ({ ...m, content: m.content + ev.text }));
            else if (ev.type === "error")
              patchReply((m) => ({
                ...m,
                // The CLI often prints its error (e.g. usage limit) as the reply
                // text too — show it once, in the error box.
                content: m.content.trim() === ev.message.trim() ? "" : m.content,
                error: ev.message,
              }));
          },
          controller.signal,
        );
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          patchReply((m) => ({ ...m, error: e instanceof Error ? e.message : String(e) }));
        }
      } finally {
        controller = null;
        patchReply((m) => ({ ...m, streaming: false }));
        set({ streaming: false });
        persist();
      }
    },
  };
});
