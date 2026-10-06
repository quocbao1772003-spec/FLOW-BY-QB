// Streaming client for the side-panel AI chat (POST /api/ai-chat/stream).

export type AiModel = "sonnet" | "opus" | "haiku";

export interface AiChatTurn {
  role: "user" | "assistant";
  content: string;
}

export type AiChatEvent =
  | { type: "delta"; text: string }
  | { type: "done"; model?: string }
  | { type: "error"; message: string };

export async function streamAiChat(
  body: { messages: AiChatTurn[]; model: AiModel; context?: string; attachments?: string[] },
  onEvent: (ev: AiChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/ai-chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `Máy chủ trả lỗi ${res.status}`;
    try {
      const j = await res.json();
      if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* not JSON */
    }
    onEvent({ type: "error", message: msg });
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          onEvent(JSON.parse(line.slice(6)) as AiChatEvent);
        } catch {
          /* partial / malformed line — skip */
        }
      }
    }
  }
}
