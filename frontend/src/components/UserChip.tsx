import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { changePassword } from "../api/team";
import { useSessionStore } from "../store/session";

// Signed-in Flowboard user in the rail footer: name, role, change password,
// sign out. Hidden in the single-user local app (no accounts).

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const tooShort = next.length > 0 && next.length < 6;
  const mismatch = again.length > 0 && again !== next;
  const sameAsOld = next.length > 0 && next === cur;
  const canSave = !busy && !!cur && next.length >= 6 && next === again && !sameAsOld;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      await changePassword(cur, next);
      setDone(true);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Không đổi được mật khẩu");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="tpl-dialog__backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="tpl-dialog" role="dialog" aria-label="Đổi mật khẩu" onSubmit={submit}>
        <h2 className="tpl-dialog__title">Đổi mật khẩu</h2>
        {done ? (
          <>
            <p className="tpl-dialog__sub">Đã đổi mật khẩu. Lần đăng nhập sau dùng mật khẩu mới.</p>
            <div className="tpl-dialog__actions">
              <span className="tpl-dialog__spacer" />
              <button type="button" className="page__cta" onClick={onClose} autoFocus>Xong</button>
            </div>
          </>
        ) : (
          <>
            <label className="tpl-dialog__label" htmlFor="pw-cur">Mật khẩu hiện tại</label>
            <input id="pw-cur" className="tpl-dialog__input" type="password" autoFocus autoComplete="current-password"
              value={cur} onChange={(e) => setCur(e.target.value)} />
            <label className="tpl-dialog__label" htmlFor="pw-new">Mật khẩu mới</label>
            <input id="pw-new" className="tpl-dialog__input" type="password" autoComplete="new-password" placeholder="Từ 6 ký tự"
              value={next} onChange={(e) => setNext(e.target.value)} />
            <label className="tpl-dialog__label" htmlFor="pw-again">Nhập lại mật khẩu mới</label>
            <input id="pw-again" className="tpl-dialog__input" type="password" autoComplete="new-password"
              value={again} onChange={(e) => setAgain(e.target.value)} />
            {(err || tooShort || mismatch || sameAsOld) && (
              <p className="tpl-dialog__msg">
                {err ?? (tooShort ? "Mật khẩu mới cần ít nhất 6 ký tự" : sameAsOld ? "Mật khẩu mới phải khác mật khẩu cũ" : "Hai lần nhập mật khẩu mới không khớp")}
              </p>
            )}
            <div className="tpl-dialog__actions">
              <span className="tpl-dialog__spacer" />
              <button type="button" className="accounts-btn" onClick={onClose} disabled={busy}>Huỷ</button>
              <button type="submit" className="page__cta" disabled={!canSave}>{busy ? "Đang lưu…" : "Lưu mật khẩu"}</button>
            </div>
          </>
        )}
      </form>
    </div>,
    document.body,
  );
}

export function UserChip({ collapsed = false }: { collapsed?: boolean }) {
  const user = useSessionStore((s) => s.user);
  const logout = useSessionStore((s) => s.logout);
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!user) return null;
  const name = user.display_name || user.username;

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
          <button type="button" className="user-chip__item" onClick={() => { setOpen(false); setPwOpen(true); }}>
            Đổi mật khẩu
          </button>
          <button
            type="button"
            className="user-chip__item user-chip__item--danger"
            onClick={() => void logout().then(() => window.location.reload())}
          >
            Đăng xuất
          </button>
        </div>
      )}
      {pwOpen && <ChangePasswordDialog onClose={() => setPwOpen(false)} />}
    </div>
  );
}
