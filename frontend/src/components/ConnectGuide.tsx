import "../connect-guide.css";
import { useState, type ReactNode } from "react";

// Step-by-step guide for staff: connect a Chrome profile (Google Flow) to the
// team server. Illustrations are real screenshots (frontend/public/guide), with the
// thing to click outlined in pink.

function Shot({ src, alt }: { src: string; alt: string }) {
  return (
    <figure className="cg-shot">
      <a href={src} target="_blank" rel="noreferrer" title="Bấm để xem ảnh lớn">
        <img src={src} alt={alt} loading="lazy" />
      </a>
      <figcaption>{alt}</figcaption>
    </figure>
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
              art={<Shot src="/guide/1-tao-ma.webp" alt="Trang Tài khoản Flow, mục Kết nối Chrome: bấm Tạo mã ghép nối" />}
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
              art={<Shot src="/guide/3-extensions.webp" alt="Trang chrome://extensions: (1) bật Developer mode, (2) bấm Load unpacked" />}
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
              art={<Shot src="/guide/4-popup-dien.webp" alt="Popup Flowboard Bridge: (1) Server, (2) Mã ghép nối, (3) Lưu và kết nối" />}
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
              art={<Shot src="/guide/5-google-flow.webp" alt="labs.google/fx/tools/flow: bấm Create with Google Flow rồi mở một project" />}
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
              art={<Shot src="/guide/6-connected.webp" alt="Popup sau khi kết nối thành công: Status ● connected" />}
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
