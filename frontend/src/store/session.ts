import { create } from "zustand";
import { getSession, logout as apiLogout, type TeamUser } from "../api/team";

// Who is signed in to Flowboard. While the server has no user accounts
// (single-user local app) `authRequired` is false and nobody signs in.

interface SessionState {
  loaded: boolean;
  authRequired: boolean;
  user: TeamUser | null;
  refresh(): Promise<void>;
  setUser(u: TeamUser | null): void;
  logout(): Promise<void>;
}

export const useSessionStore = create<SessionState>((set) => ({
  loaded: false,
  authRequired: false,
  user: null,
  async refresh() {
    try {
      const s = await getSession();
      set({ loaded: true, authRequired: s.auth_required, user: s.user });
    } catch {
      set({ loaded: true });
    }
  },
  setUser(u) {
    set({ user: u, authRequired: true });
  },
  async logout() {
    try {
      await apiLogout();
    } finally {
      set({ user: null });
    }
  },
}));

// Any API call answered 401 means the session expired: show the login.
let patched = false;
export function watchUnauthorized() {
  if (patched || typeof window === "undefined") return;
  patched = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await orig(...args);
    if (res.status === 401) {
      const url = typeof args[0] === "string" ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]);
      if (!url.includes("/api/session")) {
        const st = useSessionStore.getState();
        if (st.user) useSessionStore.setState({ user: null, authRequired: true });
      }
    }
    return res;
  };
}

export const isAdmin = (u: TeamUser | null) => !u || u.role === "admin";
