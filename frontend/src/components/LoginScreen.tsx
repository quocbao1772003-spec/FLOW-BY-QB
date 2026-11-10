import { useState, type FormEvent } from "react";
import { login } from "../api/team";
import { useSessionStore } from "../store/session";

// Shown when the server has Flowboard user accounts and nobody is signed in.

export function LoginScreen() {
  const setUser = useSessionStore((s) => s.setUser);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const s = await login(username, password);
      setUser(s.user);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Đăng nhập thất bại");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <img className="login-card__logo" src="/favicon.svg" alt="" width={44} height={44} />
        <h1 className="login-card__title">Đăng nhập Flowboard</h1>
        <p className="login-card__sub">Dùng tài khoản admin cấp cho anh chị.</p>
        <label className="login-card__label" htmlFor="login-user">Tên đăng nhập</label>
        <input
          id="login-user"
          className="login-card__input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
        />
        <label className="login-card__label" htmlFor="login-pass">Mật khẩu</label>
        <input
          id="login-pass"
          className="login-card__input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        {error && <p className="login-card__error">{error}</p>}
        <button type="submit" className="page__cta login-card__submit" disabled={busy || !username || !password}>
          {busy ? "Đang đăng nhập…" : "Đăng nhập"}
        </button>
      </form>
    </div>
  );
}
