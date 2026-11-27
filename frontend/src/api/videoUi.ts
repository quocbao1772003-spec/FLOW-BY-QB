import { api } from "./client";

// Flow Video qua tab Flow (agent/flowboard/routes/video_ui.py).

export const VIDEO_STEPS = [
  "Mở tab",
  "Chế độ tay",
  "Tải ảnh",
  "Ảnh đầu",
  "Gửi",
  "Duyệt credit",
  "Đang tạo",
  "Tải về",
] as const;
export const STEP_TOTAL = VIDEO_STEPS.length;

export type VideoUiStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface VideoUiStep {
  key: string;
  label: string;
  at: string | null;
  ok: boolean | null;
}

export interface VideoUiRequest {
  id: number;
  status: VideoUiStatus;
  client_ref: string | null;
  prompt: string | null;
  model: string | null;
  account: string | null;
  source: "board" | "api";
  credits: number | null;
  created_at: string | null;
  finished_at: string | null;
  step: number;
  steps: VideoUiStep[];
  deprecated?: boolean;
  resolution?: string | null;
  duration_s?: number | null;
  error: { code: string; message: string; detail?: string } | null;
  result: { media_url: string; size: number | null; duration_s: number | null; node_id: number | null } | null;
}

export interface VideoUiAccount {
  email: string;
  tab_open: boolean | null;
  silent_on: boolean | null;
  always_approve: boolean | null;
  credits: number | null;
  busy: boolean;
  checked_at: number | null;
  models: Array<{ label: string; leaving: string | null }>;
}

export interface VideoUiBody {
  prompt: string;
  start_image: { media_id?: string; node_id?: number; url?: string; b64?: string; name?: string };
  model?: string;
  aspect?: "16:9" | "9:16";
  resolution?: string | null;
  duration_s?: number | null;
  max_credits?: number | null;
  download_quality?: "1080p" | "720p";
  account?: string | null;
  board_id?: number | null;
  node_id?: number | null;
  client_ref?: string | null;
  silent?: boolean;
}

export const VIDEO_MODELS = [
  { value: "veo_lite", label: "Veo 3.1 Lite", hint: "Mặc định · rẻ nhất có credit", deprecated: false },
  { value: "veo_lite_lowprio", label: "Veo 3.1 Lite · Lower Priority", hint: "Chậm hơn, không tốn credit", deprecated: false },
  { value: "omni_flash", label: "Omni 1.2 Flash", hint: "4–10 giây", deprecated: false },
  { value: "veo_fast", label: "Veo 3.1 Fast", hint: "Leaving Dec 5", deprecated: true },
  { value: "veo_quality", label: "Veo 3.1 Quality", hint: "Leaving Dec 5", deprecated: true },
];

export const VIDEO_CREDIT_FALLBACK: Record<string, number> = {
  veo_lite: 10, veo_lite_lowprio: 0, omni_flash: 20, veo_fast: 20, veo_quality: 100,
};

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const listVideoUi = (opts: { limit?: number; before?: number | null } = {}) => {
  const q = new URLSearchParams({ limit: String(opts.limit ?? 50) });
  if (opts.before) q.set("before", String(opts.before));
  return api<{ items: VideoUiRequest[]; next_before: number | null }>(`/api/video-ui/requests?${q}`);
};

export const generateVideoUi = (body: VideoUiBody) =>
  api<{ request_id: number; status: string; dedup: boolean }>("/api/video-ui/generate", json("POST", body));

export const cancelVideoUi = (id: number) => api<VideoUiRequest>(`/api/video-ui/requests/${id}/cancel`, json("POST"));

export const videoUiAccounts = () => api<VideoUiAccount[]>("/api/video-ui/accounts");

export const probeVideoUi = (account?: string | null) =>
  api<Record<string, unknown>>("/api/video-ui/probe", json("POST", { account: account ?? null }));

export const videoUiMediaUrl = (id: number) => `/api/video-ui/requests/${id}/media`;
