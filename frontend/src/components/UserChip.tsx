import { useEffect, useRef, useState, type FormEvent } from "react";
import { changePassword } from "../api/team";
import { useSessionStore } from "../store/session";

// Signed-in Flowboard user in the rail footer: name, role, change password,
// sign out. Hidden in the single-user local app (no accounts).

export function UserChip({ collapsed = false }: { collapsed?: boolean }) {
  const user = useSessionStore((s) => s.user);
  const logout = useSessionStore((s) => s.logout);
  const [open, setOpen] = useState(false);
  const [pwMode, setPwMode] = useState(false);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setPwMode(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!user) return null;
  const name = user.display_name || user.username;

  async function submitPw(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await changePassword(cur, next);
      setMsg("Đã đổi mật khẩu");
      setCur("");
      setNext("");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Không đổi được");
    }
  }

  return (
    <div className={`user-chip${collapsed ? " user-chip--collapsed" : ""}`} ref={ref}>
      <button type="button" className="user-chip__btn" onClick={() => setOpen((v) => !v)} title={`${name} · ${user.role}`}>
        <span className="user-chip__avatar">{name.slice(0, 1).toUpperCase()}</span>
        {!collapsed && (
          <span className="user-chip__who">
            <span className="user-chip__name">{name}</span>
            <span className="user-chip__role">{user.role === "admin" ? "Admin" : "Nhân viên"}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="user-chip__menu" role="menu">
          {pwMode ? (
            <form className="user-chip__pw" onSubmit={submitPw}>
              <input type="password" placeholder="Mật khẩu hiện tại" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
              <input type="password" placeholder="Mật khẩu mới (từ 6 ký tự)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
              {msg && <span className="user-chip__msg">{msg}</span>}
              <button type="submit" className="accounts-btn" disabled={!cur || next.length < 6}>Lưu mật khẩu</button>
            </form>
          ) : (
            <>
              <button type="button" className="user-chip__item" onClick={() => setPwMode(true)}>Đổi mật khẩu</button>
              <button
                type="button"
                className="user-chip__item user-chip__item--danger"
                onClick={() => void logout().then(() => window.location.reload())}
              >
                Đăng xuất
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
