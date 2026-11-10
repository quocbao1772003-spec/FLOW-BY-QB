import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useGenerationStore } from "../store/generation";
import { useViewStore } from "../store/view";
import type { AccountsData } from "./AccountsPage";

// Small summary of the connected Google Flow accounts in the rail footer.
// Clicking it opens the "Tài khoản Flow" tab. It also watches which account
// is in use: a board's Flow project is per account, so the cached project
// id is dropped whenever the account changes (e.g. automatic switch).

export function AccountSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const [snap, setSnap] = useState<AccountsData | null>(null);
  const lastActive = useRef<string | null | undefined>(undefined);
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const s = await api<AccountsData>("/api/accounts");
        if (!alive) return;
        setSnap(s);
        if (lastActive.current !== undefined && s.active !== lastActive.current) {
          useGenerationStore.setState({ projectId: null });
        }
        lastActive.current = s.active;
      } catch {
        // agent offline
      }
      if (alive) timer = setTimeout(tick, 5000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!snap) return null;
  const live = snap.accounts.filter((a) => a.connected);
  const ready = live.filter((a) => !a.exhausted && a.identified !== false).length;
  const title = live.length === 0 ? "Chưa có tài khoản" : `${live.length} tài khoản`;
  const sub = live.length <= 1 ? "Thêm tài khoản" : `${ready} còn lượt`;

  return (
    <div className={`acct-switch${collapsed ? " acct-switch--collapsed" : ""}`}>
      <button
        type="button"
        className={`acct-switch__toggle${view === "accounts" ? " is-current" : ""}`}
        onClick={() => setView("accounts")}
        title={`${title} · ${ready} còn lượt · bấm để mở trang Tài khoản Flow`}
      >
        <span className="acct-switch__stack" aria-hidden="true">
          {(live.length ? live : snap.accounts).slice(0, 3).map((a) => (
            <span
              key={a.key}
              className={`acct-switch__dot${a.exhausted ? " is-spent" : ""}${a.active ? " is-active" : ""}`}
            >
              {(a.email || a.key).slice(0, 1).toUpperCase()}
            </span>
          ))}
          {snap.accounts.length === 0 && <span className="acct-switch__dot">+</span>}
        </span>
        {!collapsed && (
          <>
            <span className="acct-switch__label">
              <span className="acct-switch__title">{title}</span>
              <span className="acct-switch__sub">{sub}</span>
            </span>
            <span className="acct-switch__chev" aria-hidden="true">›</span>
          </>
        )}
      </button>
    </div>
  );
}
