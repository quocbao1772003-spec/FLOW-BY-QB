import "../connect-guide.css";
import { useState, type ReactNode } from "react";

// Step-by-step guide for staff: connect a Chrome profile (Google Flow) to the
// team server. Illustrations are drawn in HTML/CSS (not screenshots) so they
// stay sharp, follow the light/dark theme and show this server's address.

function Mark({ children }: { children: ReactNode }) {
  return <span className="cg-mark">{children}</span>;
}

function Browser({ url, children }: { url: string; children: ReactNode }) {
  return (
    <div className="cg-browser" aria-hidden="true">
      <div className="cg-browser__bar">
        <span className="cg-dot" /><span className="cg-dot" /><span className="cg-dot" />
        <span className="cg-browser__url">{url}</span>
      </div>
      <div className="cg-browser__body">{children}</div>
    </div>
  );
}

function Step({ n, title, children, art }: { n: number; title: string; children: ReactNode; art?: ReactNode }) {
  return (
    <li className="cg-step">
      <div className="cg-step__text">
        <span className="cg-step__num">{n}</span>
        <div>
          <h3 className="cg-step__title">{title}</h3>
          <div className="cg-step__body">{children}</div>
        </div>
      </div>
      {art && <div className="cg-step__art">{art}</div>}
    </li>
  );
}

export function ConnectGuide({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const server = window.location.origin;
  const host = window.location.host;

  function copyServer() {
    void navigator.clipboard?.writeText(server).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <section className="cg">
      <button type="button" className="cg__toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="cg__toggle-icon">{open ? "▾" : "▸"}</span>
        <span>
          <b>Hướng dẫn kết nối Chrome với Flowboard</b>
          <em>6 bước, khoảng 5 phút. Làm một lần cho mỗi Chrome profile.</em>
        </span>
      </button>

      {open && (
        <div className="cg__content">
          <div className="cg-need">
            <b>Cần chuẩn bị:</b> máy tính có Google Chrome, một tài khoản Google đã có <b>Google Flow Pro/Ultra</b>,
            và tài khoản Flowboard admin đã cấp (đang đăng nhập trang này).
          </div>

          <ol className="cg-steps">
            <Step
              n={1}
              title="Tạo mã ghép nối"
              art={
                <Browser url={`${host}  ›  Tài khoản Flow`}>
                  <div className="cg-mini-title">Kết nối Chrome</div>
                  <div className="cg-row">
                    <span className="cg-chip">Server</span>
                    <span className="cg-field">{server}</span>
                  </div>
                  <div className="cg-row">
                    <span className="cg-chip">Mã mới</span>
                    <span className="cg-field cg-field--muted">Chrome máy văn phòng</span>
                    <Mark><span className="cg-btn cg-btn--accent">Tạo mã ghép nối</span></Mark>
                  </div>
                  <div className="cg-secret">
                    Mã ghép nối: <code>fbp_7Kq2…</code> <Mark><span className="cg-btn">Copy</span></Mark>
                  </div>
                </Browser>
              }
            >
              <p>
                Ngay trên trang này, mục <b>Kết nối Chrome</b>: gõ ghi chú (ví dụ “Chrome máy văn phòng”) rồi bấm{" "}
                <b>Tạo mã ghép nối</b>.
              </p>
              <p>
                Bấm <b>Copy</b> và dán tạm ra Notepad. <b>Mã chỉ hiện một lần</b>, lỡ đóng thì tạo mã mới.
              </p>
            </Step>

            <Step
              n={2}
              title="Tải extension và giải nén"
              art={
                <div className="cg-explorer" aria-hidden="true">
                  <div className="cg-explorer__file">
                    <span className="cg-zip">ZIP</span> flowboard-bridge.zip
                  </div>
                  <div className="cg-menu">
                    <div className="cg-menu__item">Open</div>
                    <Mark><div className="cg-menu__item cg-menu__item--on">Extract All…</div></Mark>
                    <div className="cg-menu__item">Copy</div>
                  </div>
                  <div className="cg-arrow">↓</div>
                  <div className="cg-explorer__file">
                    <span className="cg-folder">▰</span> flowboard-bridge
                    <span className="cg-note">thư mục để Chrome đọc</span>
                  </div>
                </div>
              }
            >
              <p>
                Bấm{" "}
                <a className="cg-link" href="/api/accounts/extension.zip" download>
                  Tải flowboard-bridge.zip
                </a>
                .
              </p>
              <p>
                Mở thư mục Downloads, <b>chuột phải</b> vào file zip, chọn <b>Extract All…</b> (Giải nén tất cả), rồi bấm{" "}
                <b>Extract</b>.
              </p>
              <p className="cg-warn">
                Để thư mục giải nén ở chỗ cố định, ví dụ <code>Documents\flowboard-bridge</code>. Xoá thư mục này thì
                extension ngừng chạy.
              </p>
            </Step>

            <Step
              n={3}
              title="Cài extension vào Chrome"
              art={
                <Browser url="chrome://extensions">
                  <div className="cg-ext-head">
                    <span className="cg-mini-title">Extensions</span>
                    <Mark>
                      <span className="cg-toggle-row">
                        Developer mode <span className="cg-switch" />
                      </span>
                    </Mark>
                  </div>
                  <div className="cg-row">
                    <Mark><span className="cg-btn">Load unpacked</span></Mark>
                    <span className="cg-btn cg-btn--ghost">Pack extension</span>
                  </div>
                  <div className="cg-card">
                    <span className="cg-logo">F</span>
                    <span>
                      <b>Flowboard Bridge</b> <small>0.2.0</small>
                      <br />
                      <small>Đã bật</small>
                    </span>
                    <span className="cg-switch cg-switch--sm" />
                  </div>
                </Browser>
              }
            >
              <p>
                Mở tab mới, gõ <code>chrome://extensions</code> rồi Enter.
              </p>
              <p>
                Bật <b>Developer mode</b> (công tắc góc trên bên phải), bấm <b>Load unpacked</b>, chọn thư mục{" "}
                <b>flowboard-bridge</b> vừa giải nén. Thấy thẻ <b>Flowboard Bridge 0.2.0</b> là cài xong.
              </p>
              <p>
                Cuối cùng bấm biểu tượng <b>mảnh ghép 🧩</b> trên thanh Chrome, bấm <b>ghim 📌</b> cạnh Flowboard Bridge để
                icon luôn hiện.
              </p>
              <p className="cg-warn">
                Đã có bản cũ thì bấm <b>Remove</b> bản cũ trước, rồi mới Load unpacked bản mới.
              </p>
            </Step>

            <Step
              n={4}
              title="Điền Server và Mã ghép nối"
              art={
                <div className="cg-popup" aria-hidden="true">
                  <div className="cg-popup__head">
                    <span className="cg-logo">F</span> Flowboard Bridge <small>v0.2.0</small>
                  </div>
                  <div className="cg-popup__kv"><span>Status</span><span>○ offline</span></div>
                  <div className="cg-popup__label">Server Flowboard</div>
                  <Mark><div className="cg-popup__input">{server}</div></Mark>
                  <div className="cg-popup__label">Mã ghép nối</div>
                  <Mark><div className="cg-popup__input">fbp_7Kq2…</div></Mark>
                  <Mark><div className="cg-popup__btn">Lưu và kết nối</div></Mark>
                  <div className="cg-allow">
                    <div>
                      Flowboard Bridge muốn truy cập <b>{host}</b>
                    </div>
                    <div className="cg-row cg-row--end">
                      <span className="cg-btn cg-btn--ghost">Deny</span>
                      <Mark><span className="cg-btn cg-btn--accent">Allow</span></Mark>
                    </div>
                  </div>
                </div>
              }
            >
              <p>Bấm icon Flowboard Bridge trên thanh Chrome để mở popup, rồi điền:</p>
              <ul>
                <li>
                  <b>Server Flowboard:</b>{" "}
                  <button type="button" className="cg-copy" onClick={copyServer}>
                    {server} <em>{copied ? "Đã copy" : "Copy"}</em>
                  </button>
                </li>
                <li>
                  <b>Mã ghép nối:</b> mã <code>fbp_…</code> vừa copy ở bước 1.
                </li>
              </ul>
              <p>
                Bấm <b>Lưu và kết nối</b>. Chrome hỏi quyền truy cập thì bấm <b>Allow</b>. Bấm Deny thì cài đặt không được lưu.
              </p>
              <p className="cg-warn">
                <b>Không được để trống ô Server.</b> Để trống thì extension đi tìm app trên máy và báo lỗi “App đang dùng
                profile Chrome khác”.
              </p>
            </Step>

            <Step
              n={5}
              title="Mở Google Flow và vào một project"
              art={
                <Browser url="labs.google/fx/tools/flow/project/…">
                  <div className="cg-flow">
                    <div className="cg-flow__side" />
                    <div className="cg-flow__main">
                      <div className="cg-flow__grid">
                        <span /><span /><span /><span />
                      </div>
                      <div className="cg-flow__prompt">Nhập prompt…</div>
                    </div>
                  </div>
                  <div className="cg-tabnote">Để tab này luôn mở khi dùng Flowboard</div>
                </Browser>
              }
            >
              <p>
                Trong popup bấm <b>Open Flow tab</b>, hoặc tự mở <code>labs.google/fx/tools/flow</code>. Đăng nhập đúng
                tài khoản Google có gói Flow.
              </p>
              <p>
                Bấm vào <b>một project bất kỳ</b> (hoặc tạo project mới). Địa chỉ phải có <code>/project/…</code>.
              </p>
              <p>
                <b>Để tab này mở</b> trong lúc làm việc. Flowboard tạo ảnh qua chính tab đó, đóng tab là không tạo được.
              </p>
            </Step>

            <Step
              n={6}
              title="Kiểm tra đã kết nối"
              art={
                <div className="cg-popup" aria-hidden="true">
                  <div className="cg-popup__head">
                    <span className="cg-logo">F</span> Flowboard Bridge <small>v0.2.0</small>
                  </div>
                  <Mark>
                    <div className="cg-popup__kv"><span>Status</span><span className="cg-ok">● connected</span></div>
                  </Mark>
                  <div className="cg-popup__kv"><span>Token</span><span>có</span></div>
                  <div className="cg-popup__kv"><span>Error</span><span>—</span></div>
                  <div className="cg-acct">
                    <span className="cg-dot cg-dot--ok" /> ten.ban@gmail.com <small>online</small>
                  </div>
                </div>
              }
            >
              <p>
                Mở lại popup: <b>Status</b> là <b className="cg-ok">● connected</b>, dòng <b>Error</b> trống.
              </p>
              <p>
                Tải lại trang này (F5): email Google của bạn hiện trong danh sách tài khoản ở trên, trạng thái{" "}
                <b>online</b>. Xong, bạn tạo ảnh được rồi.
              </p>
              <p>
                Có nhiều tài khoản Google Flow? Tạo thêm Chrome profile (ảnh đại diện góc trên phải Chrome, chọn{" "}
                <b>Thêm</b>) và làm lại từ bước 1 cho từng profile. Tài khoản đầu hết lượt thì Flowboard tự chuyển sang
                tài khoản sau.
              </p>
            </Step>
          </ol>

          <h3 className="cg-sub">Gặp lỗi?</h3>
          <div className="cg-faq">
            <div className="cg-faq__row">
              <span className="cg-faq__err">App đang dùng profile Chrome khác</span>
              <span>Ô <b>Server</b> đang trống. Điền {server} rồi bấm Lưu và kết nối.</span>
            </div>
            <div className="cg-faq__row">
              <span className="cg-faq__err">Server cần mã ghép nối</span>
              <span>Mã sai hoặc đã thu hồi. Tạo mã mới ở bước 1, dán vào popup rồi Lưu lại.</span>
            </div>
            <div className="cg-faq__row">
              <span className="cg-faq__err">Status ○ offline, không có lỗi</span>
              <span>Bấm <b>Reconnect</b> trong popup và đợi 10 giây. Vẫn vậy thì kiểm tra mạng.</span>
            </div>
            <div className="cg-faq__row">
              <span className="cg-faq__err">Cần cập nhật Flowboard Bridge</span>
              <span>Tải lại zip ở bước 2, Remove bản cũ, rồi Load unpacked bản mới.</span>
            </div>
            <div className="cg-faq__row">
              <span className="cg-faq__err">Token: none</span>
              <span>Chưa mở project Flow. Làm bước 5, rồi bấm <b>Refresh token</b> trong popup.</span>
            </div>
            <div className="cg-faq__row">
              <span className="cg-faq__err">Tạo ảnh báo BOQ_RPC_5_NOT_FOUND</span>
              <span>
                Google vừa đổi giao diện. Trong tab Flow, tự tạo <b>1 ảnh có ảnh tham chiếu</b> để extension học lại, rồi
                chạy lại trên Flowboard.
              </span>
            </div>
            <div className="cg-faq__row">
              <span className="cg-faq__err">Hết lượt trong ngày</span>
              <span>Thêm Chrome profile với tài khoản Google khác (bước 6), Flowboard tự đổi sang.</span>
            </div>
          </div>
          <p className="cg-foot">Vẫn không được? Chụp màn hình popup extension gửi admin.</p>
        </div>
      )}
    </section>
  );
}
