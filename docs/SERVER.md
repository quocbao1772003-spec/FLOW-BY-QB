# Chạy Flowboard trên server cho cả team (Hetzner + Cloudflare)

Mô hình:

```
Nhân viên (Chrome + extension Flowboard Bridge, đăng nhập Google Flow Pro)
        │  wss://flow.congty.com/ws/bridge   (mã ghép nối của từng người)
        ▼
Cloudflare Tunnel  ──►  Hetzner: docker compose (flowboard + cloudflared)
                               web UI + API + media + SQLite trong ./storage
```

- Server chỉ giữ giao diện, API, ảnh/video và database.
- Lệnh tạo ảnh/video vẫn chạy trong Chrome của từng nhân viên, qua extension. Google Flow chỉ chạy ổn trong trình duyệt thật đã đăng nhập. Server không bao giờ giữ mật khẩu Google.
- Mỗi nhân viên có tài khoản Flowboard riêng (admin cấp). Họ chỉ thấy flow của mình và tài khoản Google Flow của mình.
- Lệnh của ai chạy trên Chrome của người đó.
- Admin thấy được tất cả.
- Chia sẻ flow giữa mọi người thì đưa vào **Thư viện mẫu**.

## Cách nhanh: một lệnh

SSH vào server rồi chạy:

```bash
curl -fsSL https://raw.githubusercontent.com/quocbao1772003-spec/FLOW-BY-QB/main/deploy/install.sh | sudo bash
```

Script hỏi tên miền, Cloudflare Tunnel token (bước 2 bên dưới), tài khoản admin, rồi tự cài Docker, build và chạy.

Nếu server đã có cloudflared đang chạy cho app khác, bỏ trống token. Script tự nối Flowboard vào tunnel đó và in ra dòng Service cần thêm vào Public Hostname của tunnel.

- Mọi thứ nằm riêng trong `/opt/flowboard` và các container `flowboard-*`, không đụng app khác trên cùng server.
- Chạy lại lệnh này bất cứ lúc nào để cập nhật bản mới.

Nếu repo để private, clone bằng tay vào `/opt/flowboard` trước (`git clone` với token GitHub), rồi chạy `sudo bash /opt/flowboard/deploy/install.sh`.

## 1. Chuẩn bị server (cách làm tay)

Hetzner Cloud là đủ: CX22 (2 vCPU, 4 GB RAM), Ubuntu 24.04. Không cần mở cổng nào ngoài SSH vì Cloudflare Tunnel tự đi ra ngoài.

```bash
ssh root@<ip-server>
curl -fsSL https://get.docker.com | sh
git clone https://github.com/quocbao1772003-spec/flow-by-qb.git /opt/flowboard
cd /opt/flowboard
cp deploy/env.example .env
nano .env
```

Các biến trong `.env`:

| Biến | Ý nghĩa |
|---|---|
| `FLOWBOARD_ADMIN_USER` / `FLOWBOARD_ADMIN_PASSWORD` | Tài khoản admin đầu tiên. Chỉ được tạo khi server chưa có user nào. Đăng nhập xong nên đổi mật khẩu trong app. |
| `FLOWBOARD_ALLOWED_ORIGINS` | Địa chỉ public, ví dụ `https://flow.congty.com` |
| `TUNNEL_TOKEN` | Token của Cloudflare Tunnel (bước 2) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Cho Auto-Prompt / Vision / Planner. Trên máy anh chạy `claude setup-token` rồi dán token vào đây. |

## 2. Cloudflare Tunnel

1. Mở Cloudflare Zero Trust, vào **Networks → Tunnels → Create a tunnel**, chọn loại **Cloudflared**.
2. Đặt tên (ví dụ `flowboard`), chọn **Docker**, copy token (chuỗi dài sau `--token`) vào `TUNNEL_TOKEN`.
3. Vào tab **Public Hostname → Add**:
   - Subdomain `flowboard`, domain `flowytb…` (ví dụ `flowboard.flowytb.com`).
   - Service: `HTTP` và `flowboard:8101`.
4. WebSocket được Cloudflare bật sẵn, không cần chỉnh gì thêm.

## 3. Chạy

```bash
cd /opt/flowboard
docker compose up -d --build
docker compose logs -f flowboard     # Ctrl+C để thoát xem log
```

Mở `https://flow.congty.com` rồi đăng nhập bằng tài khoản admin trong `.env`.

Cập nhật bản mới:

```bash
cd /opt/flowboard && git pull && docker compose up -d --build
```

Lệnh quản lý tài khoản nếu quên mật khẩu:

```bash
docker compose exec flowboard python -m flowboard.manage list-users
docker compose exec flowboard python -m flowboard.manage reset-password admin
docker compose exec flowboard python -m flowboard.manage create-admin ten_moi
```

## 4. Chuyển dữ liệu từ máy anh lên server (tuỳ chọn)

Mang theo toàn bộ flow, ảnh và video hiện có:

1. Tắt Flowboard trên máy (đóng cửa sổ Agent).
2. Nén thư mục `E:\FLOW-BY-QB-main\storage` thành `storage.zip`.
3. Đẩy lên server rồi giải nén vào `/opt/flowboard/storage`:

```bash
scp storage.zip root@<ip-server>:/opt/flowboard/
ssh root@<ip-server>
cd /opt/flowboard && docker compose down
apt-get install -y unzip && unzip -o storage.zip -d storage/
docker compose up -d
```

Các flow cũ (tạo trước khi có tài khoản) thuộc về admin. Admin có thể mở và đưa chúng vào Thư viện mẫu cho cả team dùng.

## 5. Cấp tài khoản cho nhân viên

Admin vào trang **Nhân viên**, bấm **Thêm nhân viên**, rồi gửi tên đăng nhập và mật khẩu vừa hiện cho người đó.

Mỗi nhân viên làm như sau:

1. Đăng nhập `https://flow.congty.com`.
2. Mở **Tài khoản Flow** và bấm **Tạo mã ghép nối** ở mục Kết nối Chrome.
3. Trong Chrome, tạo một profile riêng cho mỗi tài khoản Google Flow Pro.
4. Ở mỗi profile:
   1. Tải **flowboard-bridge.zip** ở bước 2 của trang Tài khoản Flow rồi giải nén.
   2. Mở `chrome://extensions`, bật **Developer mode**, bấm **Load unpacked** và chọn thư mục vừa giải nén.
   3. Bấm icon extension rồi điền:
      - **Server**: `https://flow.congty.com`
      - **Mã ghép nối**: mã vừa tạo.
   4. Bấm **Lưu và kết nối**.
   5. Đăng nhập Google Flow, mở một project bất kỳ (`flow.google.com/project/…`) và để tab đó mở.
5. Email tài khoản sẽ hiện trong danh sách. Nhiều profile thì tự đổi khi hết lượt trong ngày.

Một mã ghép nối dùng được cho mọi profile của cùng một người. Muốn chặn một máy thì bấm **Thu hồi**.

## 6. Thư viện mẫu

- Ở trang Flows (hoặc nút **Thư viện** trên thanh công cụ của canvas), bấm **Đưa vào thư viện**.
- Thư viện lưu một bản chụp của flow lúc đó.
- Người khác bấm **Use** sẽ có bản sao riêng trong tài khoản của mình. Họ sửa thoải mái, không ảnh hưởng mẫu gốc hay bản của người khác.
- Tác giả hoặc admin bấm **Cập nhật mẫu** để chụp lại flow mới nhất, hoặc **Gỡ** để bỏ khỏi thư viện. Các bản đã Use vẫn giữ nguyên.

## 7. Điều khiển bằng Claude / ChatGPT (MCP) với server

1. Mỗi người tạo **Token MCP** ở mục Kết nối Chrome.
2. Trên máy có Claude Desktop / Claude Code / Codex, chạy:

```bash
python -m flowboard_mcp install --server https://flow.congty.com --token fbt_xxxxxxxx
```

Lệnh này cần chạy từ thư mục `agent` của repo.

MCP thao tác bằng chính tài khoản của người tạo token, nên chỉ thấy flow của người đó (admin thấy tất cả). Lệnh `save_media` lưu file trên máy đang chạy MCP.

## Ghi chú

- **AI provider**: chỉ admin chọn được. Nhân viên không bị chặn bởi hộp thoại cài đặt.
- **Upscale**: trên server không có Real-ESRGAN (bản Windows), nên tự dùng Lanczos + làm nét.
- **Sao lưu**: chỉ cần sao lưu thư mục `/opt/flowboard/storage` (database + ảnh/video).
- **Bảo mật**:
  - Cổng 8101 chỉ mở cho chính server (`127.0.0.1`). Mọi truy cập từ ngoài đi qua Cloudflare.
  - Đăng nhập sai quá 8 lần trong 10 phút sẽ bị khoá tạm.
  - Muốn chặn thêm một lớp, có thể bật Cloudflare Access cho hostname này.
- **Chạy trên máy cá nhân như cũ**: nếu chưa tạo tài khoản nào thì Flowboard vẫn mở tự do như trước. Khi đã tạo admin thì mọi Chrome profile, kể cả trên máy anh, đều cần mã ghép nối.
