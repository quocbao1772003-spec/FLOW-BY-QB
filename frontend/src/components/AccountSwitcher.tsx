import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useGenerationStore } from "../store/generation";

// Google Flow accounts connected through Chrome profiles (agent:
// services/account_pool.py). One row per profile; the agent switches to the
// next account on its own when an image job hits the daily quota.

export interface FlowAccount {
  key: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  connected: boolean;
  active: boolean;
  selected: boolean;
  primary: boolean;
  exhausted: boolean;
  exhausted_reason: string | null;
  exhausted_until: number | null;
  requests: number;
  failed: number;
  last_error: string | null;
}

interface AccountsSnapshot {
  auto_rotate: boolean;
  selected: string | null;
  active: string | null;
  primary: string | null;
  accounts: FlowAccount[];
}

const post = (path: string, body: unknown) =>
  api<AccountsSnapshot>(path, { method: "POST", body: JSON.stringify(body) });

function untilLabel(ts: number | null): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function AccountSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const [snap, setSnap] = useState<AccountsSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const lastActive = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const s = await api<AccountsSnapshot>("/api/accounts");
        if (!alive) return;
        setSnap(s);
        // The board's Flow project is per account — drop the cached id
        // when the account in use changes so the next dispatch asks again.
        if (lastActive.current !== null && s.active !== lastActive.current) {
          useGenerationStore.setState({ projectId: null });
        }
        lastActive.current = s.active;
      } catch {
        // agent offline
      }
      if (alive) timer = setTimeout(tick, open ? 2500 : 5000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const run = async (fn: () => Promise<AccountsSnapshot>) => {
    if (busy) return;
    setBusy(true);
    try {
      setSnap(await fn());
    } catch {
      // keep current view; next poll refreshes
    } finally {
      setBusy(false);
    }
  };

  const accounts = snap?.accounts ?? [];
  const live = accounts.filter((a) => a.connected);
  const ready = live.filter((a) => !a.exhausted).length;
  // One account and nothing special going on: the regular account chip
  // below already says everything.
  if (!snap || (accounts.length <= 1 && !open)) return null;

  const summary = `${ready} sẵn sàng`;

  return (
    <div className={`acct-switch${collapsed ? " acct-switch--collapsed" : ""}`} ref={ref}>
      <button
        type="button"
        className="acct-switch__toggle"
        onClick={() => setOpen((v) => !v)}
        title={`Tài khoản Google Flow: ${ready}/${live.length} sẵn sàng · ${snap.auto_rotate ? "tự đổi khi hết lượt" : "không tự đổi"}`}
        aria-expanded={open}
      >
        <span className="acct-switch__stack" aria-hidden="true">
          {live.slice(0, 3).map((a) => (
            <span
              key={a.key}
              className={`acct-switch__dot${a.exhausted ? " is-spent" : ""}${a.active ? " is-active" : ""}`}
            >
              {(a.email || a.key).slice(0, 1).toUpperCase()}
            </span>
          ))}
        </span>
        {!collapsed && (
          <>
            <span className="acct-switch__label">
              <span className="acct-switch__title">{live.length} tài khoản</span>
              <span className="acct-switch__sub">{summary}</span>
            </span>
            <span className="acct-switch__chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
          </>
        )}
      </button>

      {open && (
        <div className="acct-switch__pop" role="dialog" aria-label="Tài khoản Google Flow">
          <div className="acct-switch__head">
            <span>Tài khoản Google Flow</span>
            <label className="acct-switch__auto" title="Hết lượt tạo ảnh trong ngày thì tự chạy lại lệnh bằng tài khoản kế tiếp">
              <input
                type="checkbox"
                checked={snap.auto_rotate}
                disabled={busy}
                onChange={(e) => run(() => post("/api/accounts/settings", { auto_rotate: e.target.checked }))}
              />
              <span>Tự đổi khi hết lượt</span>
            </label>
          </div>

          <ul className="acct-switch__list">
            {accounts.map((a) => (
              <li
                key={a.key}
                className={`acct-switch__row${a.active ? " is-active" : ""}${!a.connected ? " is-off" : ""}`}
              >
                <button
                  type="button"
                  className="acct-switch__pick"
                  disabled={busy || !a.connected}
                  onClick={() => run(() => post("/api/accounts/select", { key: a.selected ? null : a.key }))}
                  title={
                    a.selected
                      ? "Đang ưu tiên tài khoản này. Bấm để bỏ ưu tiên"
                      : "Ưu tiên dùng tài khoản này"
                  }
                >
                  <span className="acct-switch__avatar">
                    {a.picture ? (
                      <img src={a.picture} alt="" referrerPolicy="no-referrer" />
                    ) : (
                      (a.email || a.key).slice(0, 1).toUpperCase()
                    )}
                  </span>
                  <span className="acct-switch__who">
                    <span className="acct-switch__email">{a.email || "Chưa rõ tài khoản"}</span>
                    <span className="acct-switch__state">
                      {!a.connected
                        ? "Mất kết nối"
                        : a.exhausted
                          ? `Hết lượt · mở lại lúc ${untilLabel(a.exhausted_until)}`
                          : a.active
                            ? "Đang dùng"
                            : "Sẵn sàng"}
                      {a.selected ? " · ưu tiên" : ""}
                      {a.requests ? ` · ${a.requests} lệnh` : ""}
                    </span>
                  </span>
                </button>
                {a.exhausted && a.connected && (
                  <button
                    type="button"
                    className="acct-switch__reset"
                    disabled={busy}
                    onClick={() => run(() => post("/api/accounts/reset", { key: a.key }))}
                    title="Bỏ dấu hết lượt (ví dụ sau khi mua thêm credit)"
                  >
                    Mở lại
                  </button>
                )}
              </li>
            ))}
          </ul>

          <p className="acct-switch__hint">
            Thêm tài khoản: mở Chrome bằng profile khác, cài extension Flowboard Bridge,
            đăng nhập Google Flow và để một tab Flow mở.
          </p>
        </div>
      )}
    </div>
  );
}
