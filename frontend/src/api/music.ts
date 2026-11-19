import { api } from "./client";

// Flow Music REST (agent/flowboard/routes/music.py). Every call is scoped
// to the signed-in user server-side.

export interface MusicTake {
  clip_id?: string;
  title?: string;
  duration_s?: number | null;
  lyrics?: string | null;
  image_url?: string | null;
  files?: Record<string, string>;
  stems?: Record<string, string>;
  stems_error?: string;
}

export type MusicStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface MusicRequest {
  request_id: string;
  type: "gen_music" | "stems_music";
  status: MusicStatus;
  account: string | null;
  credits_used: number | null;
  error: string | null;
  error_detail?: string;
  takes: MusicTake[];
  stems?: Record<string, string>;
  title: string;
  sound_prompt: string | null;
  lyrics: string | null;
  instrumental: boolean;
  model: string | null;
  takes_wanted: number;
  formats: string[];
  stems_wanted: boolean;
  seed: number | null;
  account_wanted: string | null;
  clip_id: string | null;
  node_id: number | null;
  created_at: string | null;
  finished_at: string | null;
}

export interface MusicAccount {
  email: string;
  credits_remaining: number | null;
  session_ok: boolean | null;
  busy: boolean;
  exhausted_until: number | null;
  checked_at: number | null;
}

export interface MusicGenerateBody {
  sound_prompt: string;
  lyrics?: string | null;
  instrumental?: boolean;
  title?: string;
  model?: string;
  seed?: number | null;
  takes?: number;
  formats?: string[];
  stems?: boolean;
  account?: string | null;
  board_id?: number | null;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const listMusic = (opts: { limit?: number; before?: number | null; type?: string } = {}) => {
  const q = new URLSearchParams();
  q.set("limit", String(opts.limit ?? 50));
  if (opts.before) q.set("before", String(opts.before));
  if (opts.type) q.set("type", opts.type);
  return api<{ items: MusicRequest[]; next_before: number | null }>(`/api/music/requests?${q}`);
};

export const generateMusic = (body: MusicGenerateBody) =>
  api<{ request_id: string; status: string }>("/api/music/generate", json("POST", body));

export const cancelMusic = (id: string) => api<MusicRequest>(`/api/music/requests/${id}/cancel`, json("POST"));

export const splitStems = (clip_id: string, account?: string | null) =>
  api<{ request_id: string }>("/api/music/stems", json("POST", { clip_id, account: account ?? null }));

export const musicAccounts = () => api<MusicAccount[]>("/api/music/accounts");

export const refreshMusicAccounts = () => api<MusicAccount[]>("/api/music/accounts/refresh", json("POST"));

/** ~5 credits per song (Flow Music pricing, services/flow_music.CREDITS_PER_SONG). */
export const CREDITS_PER_SONG = 5;

export const MUSIC_MODELS = [
  { value: "Lyria 3.5", label: "Lyria 3.5", hint: "Mặc định · nhanh" },
  { value: "Lyria 3 Pro", label: "Lyria 3 Pro", hint: "Chất lượng cao hơn" },
];

/** Human Vietnamese message for backend error codes. */
export function musicErrorText(r: Pick<MusicRequest, "error" | "error_detail">): string {
  const code = (r.error || "").toLowerCase();
  if (code.includes("no_session")) return "Phiên flowmusic.app hết hạn — mở flowmusic.app trong Chrome để đăng nhập lại";
  if (code.includes("credits_exhausted")) return "Hết credit Flow Music ở mọi tài khoản";
  if (code.includes("extension_offline")) return "Chưa có tài khoản Flow Music nào kết nối (Chrome + extension)";
  if (code.includes("flowmusic_api_changed")) return "Flow Music đổi API — báo admin cập nhật Flowboard";
  if (code.includes("blocked")) return "Flow Music từ chối nội dung — sửa lời hoặc phong cách";
  if (code.includes("timeout")) return "Quá thời gian chờ Flow Music";
  return r.error_detail || r.error || "Lỗi không rõ";
}
