import { useEffect, useState, type FormEvent } from "react";
import { createUser, listUsers, updateUser, type TeamUser } from "../api/team";
import { IconRefresh } from "../canvas/icons";
import { useSessionStore } from "../store/session";

// Admin: Flowboard accounts for the team. Passwords are generated here and
// shown once, for the admin to hand over. Google Flow passwords never pass
// through Flowboard: staff sign in to Google inside their own Chrome profile.

function ago(iso: string | null): string {
  if (!iso) return "Chưa đăng nhập";
  const d = new Date(iso);
  return d.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", hour12: false });
}

export function TeamPage() {
  const me = useSessionStore((s) => s.user);
  const authRequired = useSessionStore((s) => s.authRequired);
  const [users, setUsers] = useState<TeamUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ username: "", display_name: "", password: "", role: "staff" });
  const [secret, setSecret] = useState<{ who: string; password: string } | null>(null);

  async function load() {
    if (!authRequired) return;
    try {
      setUsers(await listUsers());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authRequired]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await createUser({
        username: form.username,
        display_name: form.display_name,
        password: form.password || undefined,
        role: authRequired ? form.role : "admin",
      });
      if (!authRequired) {
        // First admin: login is now on.
        window.location.reload();
        return;
      }
      setSecret({ who: r.user.username, password: r.password });
      setForm({ username: "", display_name: "", password: "", role: "staff" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function act(u: TeamUser, body: Parameters<typeof updateUser>[1]) {
    setBusy(true);
    try {
      const r = await updateUser(u.id, body);
      if (r.password) setSecret({ who: u.username, password: r.password });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!authRequired) {
    return (
      <div className="page accounts-page">
        <div className="page__header">
          <div>
            <h1 className="page__title">Nhân viên</h1>
            <p className="page__subtitle">
              Flowboard đang chạy chế độ một người dùng, chưa cần đăng nhập. Tạo tài khoản admin đầu tiên để bật
              đăng nhập, sau đó cấp tài khoản cho từng nhân viên.
            </p>
          </div>
        </div>
        <form className="team-form" onSubmit={submit}>
          <input placeholder="Tên đăng nhập admin" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <input placeholder="Tên hiển thị" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
          <input type="password" placeholder="Mật khẩu (từ 6 ký tự)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <button type="submit" className="page__cta" disabled={busy || !form.username || form.password.length < 6}>
            Tạo admin và bật đăng nhập
          </button>
        </form>
        {error && <p className="page__empty">✗ {error}</p>}
        <p className="accounts-hint">
          Sau khi bật, mọi Chrome profile cần dán mã ghép nối (trang Tài khoản Flow → Kết nối Chrome) để tiếp tục chạy.
        </p>
      </div>
    );
  }

  return (
    <div className="page accounts-page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Nhân viên</h1>
          <p className="page__subtitle">
            Cấp tài khoản Flowboard cho từng người. Mỗi người tự đăng nhập Google Flow trên Chrome của mình và chỉ
            dùng tài khoản Flow của chính họ.
          </p>
        </div>
        <button type="button" className="footer-btn" onClick={() => void load()} title="Làm mới" aria-label="Làm mới">
          <IconRefresh size={13} />
        </button>
      </div>

      <div className="accounts-section__head">
        <h2 className="accounts-section__title">Thêm nhân viên</h2>
      </div>
      <form className="team-form" onSubmit={submit}>
        <input placeholder="Tên đăng nhập" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        <input placeholder="Tên hiển thị" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
        <input placeholder="Mật khẩu (trống = tự tạo)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="staff">Nhân viên</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit" className="page__cta" disabled={busy || !form.username}>Tạo tài khoản</button>
      </form>

      {secret && (
        <div className="team-secret">
          <span>
            Mật khẩu của <b>{secret.who}</b>: <code>{secret.password}</code>
          </span>
          <span className="team-secret__note">Chỉ hiện một lần. Copy gửi cho nhân viên.</span>
          <button type="button" className="accounts-btn" onClick={() => void navigator.clipboard?.writeText(secret.password)}>Copy</button>
          <button type="button" className="accounts-btn" onClick={() => setSecret(null)}>Đóng</button>
        </div>
      )}
      {error && <p className="page__empty">✗ {error}</p>}

      <div className="accounts-section__head">
        <h2 className="accounts-section__title">Danh sách ({users?.length ?? 0})</h2>
      </div>
      <div className="accounts-list">
        {(users ?? []).map((u) => {
          const accts = u.flow_accounts ?? [];
          const online = accts.filter((a) => a.connected).length;
          return (
            <div key={u.id} className={`team-row${u.disabled ? " team-row--off" : ""}`}>
              <span className="account-card__avatar">{(u.display_name || u.username).slice(0, 1).toUpperCase()}</span>
              <div className="account-card__who">
                <div className="account-card__line">
                  <span className="account-card__email">{u.display_name || u.username}</span>
                  <span className={`account-tag${u.role === "admin" ? " account-tag--accent" : ""}`}>
                    {u.role === "admin" ? "Admin" : "Nhân viên"}
                  </span>
                  {u.disabled && <span className="account-tag">Đã khoá</span>}
                  {u.id === me?.id && <span className="account-tag">Bạn</span>}
                </div>
                <div className="account-card__line account-card__line--muted">
                  <span>@{u.username}</span>
                  <span>· Lần cuối: {ago(u.last_login_at)}</span>
                </div>
              </div>
              <div className="team-row__flow" title={accts.map((a) => a.email).join("\n")}>
                <b>{online}/{accts.length}</b>
                <span>Tài khoản Flow online</span>
              </div>
              <div className="team-row__flow">
                <b>{u.paired_profiles ?? 0}</b>
                <span>Mã Chrome</span>
              </div>
              <div className="team-row__actions">
                {u.id !== me?.id && (
                  <button
                    type="button"
                    className="accounts-btn"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Đặt lại mật khẩu cho ${u.display_name || u.username}? Mật khẩu cũ sẽ không dùng được nữa, mật khẩu mới hiện ra một lần để anh/chị gửi cho họ.`)) {
                        void act(u, { reset_password: true });
                      }
                    }}
                  >
                    Đặt lại mật khẩu
                  </button>
                )}
                <button
                  type="button"
                  className="accounts-btn"
                  disabled={busy || u.id === me?.id}
                  onClick={() => void act(u, { role: u.role === "admin" ? "staff" : "admin" })}
                >
                  {u.role === "admin" ? "Bỏ quyền admin" : "Cho làm admin"}
                </button>
                <button
                  type="button"
                  className={`accounts-btn${u.disabled ? "" : " accounts-btn--danger"}`}
                  disabled={busy || u.id === me?.id}
                  onClick={() => void act(u, { disabled: !u.disabled })}
                >
                  {u.disabled ? "Mở khoá" : "Khoá"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
