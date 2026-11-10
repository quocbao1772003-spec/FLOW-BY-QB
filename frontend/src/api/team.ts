

// Flowboard user accounts, pairing codes and the shared template library.

export interface TeamUser {
  id: number;
  username: string;
  display_name: string;
  role: "admin" | "staff";
  disabled: boolean;
  created_at: string;
  last_login_at: string | null;
  flow_accounts?: { email: string; connected: boolean; exhausted: boolean }[];
  paired_profiles?: number;
}

export interface SessionInfo {
  auth_required: boolean;
  user: TeamUser | null;
}

export interface PersonalToken {
  id: number;
  kind: "bridge" | "api";
  label: string;
  hint: string;
  created_at: string;
  last_used_at: string | null;
}

export interface FlowTemplate {
  id: number;
  name: string;
  description: string;
  cover_media_id: string | null;
  node_count: number;
  source_board_id: number | null;
  created_by: number | null;
  author: string | null;
  created_at: string;
  updated_at: string;
  use_count: number;
  can_edit: boolean;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const d = await res.json();
      msg = typeof d.detail === "string" ? d.detail : JSON.stringify(d.detail ?? d);
    } catch {
      // keep status
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const getSession = () => call<SessionInfo>("/api/session");
export const login = (username: string, password: string) =>
  call<SessionInfo>("/api/session/login", json("POST", { username, password }));
export const logout = () => call<{ ok: boolean }>("/api/session/logout", json("POST"));
export const changePassword = (current_password: string, new_password: string) =>
  call<{ ok: boolean }>("/api/session/password", json("POST", { current_password, new_password }));

export const listTokens = () => call<PersonalToken[]>("/api/session/tokens");
export const createToken = (kind: "bridge" | "api", label: string) =>
  call<{ token: string; id: number; hint: string }>("/api/session/tokens", json("POST", { kind, label }));
export const revokeToken = (id: number) => call<{ ok: boolean }>(`/api/session/tokens/${id}`, json("DELETE"));

export const listUsers = () => call<TeamUser[]>("/api/users");
export const createUser = (body: { username: string; display_name?: string; password?: string; role?: string }) =>
  call<{ user: TeamUser; password: string }>("/api/users", json("POST", body));
export const updateUser = (
  id: number,
  body: { display_name?: string; role?: string; disabled?: boolean; reset_password?: boolean },
) => call<{ user: TeamUser; password: string | null }>(`/api/users/${id}`, json("PATCH", body));

export const listTemplates = (q?: string) =>
  call<FlowTemplate[]>(q ? `/api/templates?q=${encodeURIComponent(q)}` : "/api/templates");
export const templateOfBoard = (boardId: number) =>
  call<{ template: FlowTemplate | null }>(`/api/templates/by-board/${boardId}`);
export const publishTemplate = (body: { board_id: number; name: string; description: string }) =>
  call<FlowTemplate>("/api/templates", json("POST", body));
export const updateTemplate = (
  id: number,
  body: { name?: string; description?: string; refresh_from_board?: boolean },
) => call<FlowTemplate>(`/api/templates/${id}`, json("PATCH", body));
export const deleteTemplate = (id: number) => call<{ ok: boolean }>(`/api/templates/${id}`, json("DELETE"));
export const useTemplate = (id: number) =>
  call<{ board: { id: number; name: string }; node_count: number }>(`/api/templates/${id}/use`, json("POST", {}));
