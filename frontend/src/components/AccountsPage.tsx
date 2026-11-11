import { useEffect, useState } from "react";
import { api } from "../api/client";
import { IconRefresh } from "../canvas/icons";
import { ChromePairing } from "./ChromePairing";
import { ConnectGuide } from "./ConnectGuide";
import { useSessionStore } from "../store/session";
import { extensionZipUrl, useExtensionVersion } from "../lib/extensionVersion";

// "Tài khoản Flow" tab — every Google Flow account connected through a
// Chrome profile (agent: services/account_pool.py, routes/accounts.py).
// Image jobs that hit the daily quota move to the next account by
// themselves; this page shows that, and lets the user pick a preferred
// account, change the order, reopen a spent account or turn switching off.

interface Usage {
  jobs: number;
  done: number;
  failed: number;
  media: number;
  switched_away: number;
}

export interface FlowAccountRow {
  key: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  connected: boolean;
  identified?: boolean;
  active: boolean;
  selected: boolean;
  primary: boolean;
  exhausted: boolean;
  exhausted_reason: string | null;
  exhausted_until: number | null;
  requests: number;
  failed: number;
  last_error: string | null;
  extension_version: string | null;
  today?: Usage;
}

interface SwitchEvent {
  at: number;
  from: string;
  to: string;
  reason: string;
}

export interface AccountsData {
  auto_rotate: boolean;
  selected: string | null;
  active: string | null;
  primary: string | null;
  accounts: FlowAccountRow[];
  events?: SwitchEvent[];
  extension_dir?: string;
}

const post = (path: string, body: unknown) =>
  api<AccountsData>(path, { method: "POST", body: JSON.stringify(body) });

const time = (ts: number | null | undefined) =>
  ts
    ? new Date(ts * 1000).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false })
    : "";

const dateTime = (ts: number) =>
  new Date(ts * 1000).toLocaleString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    hour12: false,
  });

function statusOf(a: FlowAccountRow): { label: string; tone: "on" | "ready" | "spent" | "off" } {
  if (!a.connected) return { label: "Mất kết nối", tone: "off" };
  if (a.identified === false) return { label: "Chưa nhận diện tài khoản · không được giao lệnh", tone: "spent" };
  if (a.exhausted) return { label: `Hết lượt · mở lại ${time(a.exhausted_until)}`, tone: "spent" };
  if (a.active) return { label: "Đang dùng", tone: "on" };
  return { label: "Sẵn sàng", tone: "ready" };
}

export function AccountsPage() {
  const authRequired = useSessionStore((s) => s.authRequired);
  const extVersion = useExtensionVersion();
  const [data, setData] = useState<AccountsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      setData(await api<AccountsData>("/api/accounts"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await load();
      if (alive) t = setTimeout(tick, 3000);
    };
    void tick();
    return () => {
      alive = false;
      if (t) clearTimeout(t);
    };
  }, []);

  async function act(fn: () => Promise<AccountsData>) {
    if (busy) return;
    setBusy(true);
    try {
      const next = await fn();
      setData((d) => ({ ...next, extension_dir: next.extension_dir ?? d?.extension_dir }));
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const accounts = data?.accounts ?? [];
  const live = accounts.filter((a) => a.connected);
  const ready = live.filter((a) => !a.exhausted && a.identified !== false);
  const spent = live.filter((a) => a.exhausted);
  const active = accounts.find((a) => a.active);
  const events = data?.events ?? [];

  function move(key: string, dir: -1 | 1) {
    const keys = accounts.map((a) => a.key);
    const i = keys.indexOf(key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    void act(() => post("/api/accounts/order", { keys }));
  }

  return (
    <div className="page accounts-page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Tài khoản Flow</h1>
          <p className="page__subtitle">
            Mỗi Chrome profile có extension là một tài khoản Google Flow. Hết lượt tạo ảnh trong ngày
            thì lệnh tự chạy lại bằng tài khoản kế tiếp.
          </p>
        </div>
        <div className="accounts-page__head-actions">
          <label className="accounts-switch" title="Hết lượt tạo ảnh thì tự chạy lại lệnh bằng tài khoản kế tiếp">
            <input
              type="checkbox"
              checked={!!data?.auto_rotate}
              disabled={!data || busy}
              onChange={(e) => act(() => post("/api/accounts/settings", { auto_rotate: e.target.checked }))}
            />
            <span className="accounts-switch__track" aria-hidden="true">
              <span className="accounts-switch__knob" />
            </span>
            <span>Tự đổi khi hết lượt</span>
          </label>
          <button type="button" className="footer-btn" onClick={() => void load()} title="Làm mới" aria-label="Làm mới">
            <IconRefresh size={13} />
          </button>
        </div>
      </div>

      {error && <p className="page__empty">✗ {error}</p>}

      <div className="accounts-stats">
        <div className="accounts-stat">
          <span className="accounts-stat__value">{live.length}</span>
          <span className="accounts-stat__label">Đang kết nối</span>
        </div>
        <div className="accounts-stat">
          <span className="accounts-stat__value accounts-stat__value--ok">{ready.length}</span>
          <span className="accounts-stat__label">Còn lượt</span>
        </div>
        <div className="accounts-stat">
          <span className="accounts-stat__value accounts-stat__value--warn">{spent.length}</span>
          <span className="accounts-stat__label">Hết lượt hôm nay</span>
        </div>
        <div className="accounts-stat">
          <span className="accounts-stat__value accounts-stat__value--text" title={active?.key ?? ""}>
            {active?.email ?? "—"}
          </span>
          <span className="accounts-stat__label">Đang dùng</span>
        </div>
      </div>

      <div className="accounts-section__head">
        <h2 className="accounts-section__title">Danh sách tài khoản</h2>
        {spent.length > 0 && (
          <button
            type="button"
            className="accounts-btn"
            disabled={busy}
            onClick={() => act(() => post("/api/accounts/reset", { key: null }))}
          >
            Mở lại tất cả
          </button>
        )}
      </div>

      {data && accounts.length === 0 && (
        <p className="page__empty">Chưa có tài khoản nào. Làm theo 3 bước bên dưới để thêm.</p>
      )}

      <div className="accounts-list">
        {accounts.map((a, idx) => {
          const st = statusOf(a);
          const t = a.today ?? { jobs: 0, done: 0, failed: 0, media: 0, switched_away: 0 };
          return (
            <div key={a.key} className={`account-card account-card--${st.tone}`}>
              <div className="account-card__order">
                <button
                  type="button"
                  disabled={busy || idx === 0}
                  onClick={() => move(a.key, -1)}
                  title="Đưa lên trước"
                  aria-label="Đưa lên trước"
                >
                  ▲
                </button>
                <span>{idx + 1}</span>
                <button
                  type="button"
                  disabled={busy || idx === accounts.length - 1}
                  onClick={() => move(a.key, 1)}
                  title="Đưa xuống sau"
                  aria-label="Đưa xuống sau"
                >
                  ▼
                </button>
              </div>

              <div className="account-card__avatar">
                {a.picture ? (
                  <img src={a.picture} alt="" referrerPolicy="no-referrer" />
                ) : (
                  (a.email || a.key).slice(0, 1).toUpperCase()
                )}
              </div>

              <div className="account-card__who">
                <div className="account-card__line">
                  <span className="account-card__email">{a.email || "Profile chưa nhận diện"}</span>
                  {a.selected && <span className="account-tag account-tag--accent">Ưu tiên</span>}
                  {a.primary && <span className="account-tag">Tài khoản chính</span>}
                </div>
                <div className="account-card__line account-card__line--muted">
                  <span className={`account-dot account-dot--${st.tone}`} aria-hidden="true" />
                  <span>{st.label}</span>
                  {a.name && <span>· {a.name}</span>}
                  {a.extension_version && <span>· extension {a.extension_version}</span>}
                </div>
                {a.connected && a.identified === false && (
                  <div className="account-card__note account-card__note--warn">
                    Trong profile Chrome này mở Google Flow và vào một project bất kỳ (trang flow.google.com/project/…).
                  </div>
                )}
                {a.exhausted && a.exhausted_reason && (
                  <div className="account-card__note" title={a.exhausted_reason}>{a.exhausted_reason}</div>
                )}
                {!a.exhausted && a.last_error && (
                  <div className="account-card__note" title={a.last_error}>Lỗi gần nhất: {a.last_error}</div>
                )}
              </div>

              <div className="account-card__nums">
                <div>
                  <b>{t.done}</b>
                  <span>Lệnh xong</span>
                </div>
                <div>
                  <b>{t.media}</b>
                  <span>Ảnh, video</span>
                </div>
                <div>
                  <b>{t.failed}</b>
                  <span>Lỗi</span>
                </div>
                <div>
                  <b>{t.switched_away}</b>
                  <span>Lần đổi đi</span>
                </div>
              </div>

              <div className="account-card__actions">
                <button
                  type="button"
                  className={`accounts-btn${a.selected ? " accounts-btn--on" : ""}`}
                  disabled={busy || ((!a.connected || a.identified === false) && !a.selected)}
                  onClick={() => act(() => post("/api/accounts/select", { key: a.selected ? null : a.key }))}
                >
                  {a.selected ? "Bỏ ưu tiên" : "Ưu tiên dùng"}
                </button>
                {a.connected && a.identified === false ? (
                  <button
                    type="button"
                    className="accounts-btn"
                    disabled={busy}
                    onClick={() => act(() => post("/api/accounts/scan", {}))}
                    title="Đọc lại tài khoản từ tab Flow của profile này"
                  >
                    Quét lại
                  </button>
                ) : (
                  <button
                    type="button"
                    className="accounts-btn"
                    disabled={busy || !a.exhausted}
                    onClick={() => act(() => post("/api/accounts/reset", { key: a.key }))}
                    title="Bỏ dấu hết lượt, ví dụ sau khi mua thêm credit"
                  >
                    Mở lại lượt
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {accounts.length > 1 && (
        <p className="accounts-hint">
          Số thứ tự là thứ tự dùng: tài khoản 1 hết lượt thì chuyển sang 2, rồi 3. Số liệu tính từ 0 giờ hôm nay.
        </p>
      )}

      {authRequired && <ConnectGuide defaultOpen={accounts.length === 0} />}
      <ChromePairing />

      <div className="accounts-section__head">
        <h2 className="accounts-section__title">Thêm tài khoản</h2>
      </div>
      <div className="accounts-steps">
        <div className="accounts-step">
          <span className="accounts-step__num">1</span>
          <span className="accounts-step__title">Tạo Chrome profile</span>
          <span className="accounts-step__text">
            Trong Chrome bấm ảnh đại diện góc trên bên phải, chọn <b>Thêm</b> để tạo profile mới cho tài
            khoản đó.
          </span>
        </div>
        <div className="accounts-step">
          <span className="accounts-step__num">2</span>
          <span className="accounts-step__title">Cài extension</span>
          <span className="accounts-step__text">
            {authRequired ? (
              <>
                Tải extension về, giải nén. Mở <code>chrome://extensions</code>, bật Developer mode, bấm Load
                unpacked và chọn thư mục vừa giải nén. Sau đó mở popup extension, điền Server và Mã ghép nối ở
                mục Kết nối Chrome phía trên.
              </>
            ) : (
              <>
                Mở <code>chrome://extensions</code>, bật Developer mode, bấm Load unpacked và chọn thư mục:
              </>
            )}
          </span>
          {authRequired && (
            <a className="accounts-path" href={extensionZipUrl(extVersion)} download>
              <span>flowboard-bridge{extVersion ? `-${extVersion}` : ""}.zip</span>
              <em>Tải</em>
            </a>
          )}
          {!authRequired && data?.extension_dir && (
            <button
              type="button"
              className="accounts-path"
              onClick={() => {
                void navigator.clipboard?.writeText(data.extension_dir ?? "").then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
              title="Bấm để copy đường dẫn"
            >
              <span>{data.extension_dir}</span>
              <em>{copied ? "Đã copy" : "Copy"}</em>
            </button>
          )}
        </div>
        <div className="accounts-step">
          <span className="accounts-step__num">3</span>
          <span className="accounts-step__title">Đăng nhập Flow</span>
          <span className="accounts-step__text">
            Đăng nhập Google Flow Pro, mở Flow rồi <b>vào một project bất kỳ</b> (trang{" "}
            <code>flow.google.com/project/…</code>) và để tab đó mở. Email sẽ tự hiện trong danh sách trên.
          </span>
        </div>
      </div>

      <div className="accounts-section__head">
        <h2 className="accounts-section__title">Lần tự đổi gần đây</h2>
      </div>
      {events.length === 0 ? (
        <p className="page__empty">Chưa có lần đổi nào.</p>
      ) : (
        <div className="accounts-log">
          {events.map((e, i) => (
            <div key={`${e.at}-${i}`} className="accounts-log__row">
              <span className="accounts-log__time">{dateTime(e.at)}</span>
              <span className="accounts-log__move">
                {e.from} <em>→</em> {e.to}
              </span>
              <span className="accounts-log__reason" title={e.reason}>{e.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
