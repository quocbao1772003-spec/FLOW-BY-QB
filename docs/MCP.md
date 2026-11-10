# Flowboard MCP: điều khiển Flowboard bằng Claude hoặc ChatGPT

MCP server `flowboard` cho AI toàn quyền với app: tạo/sửa/xoá board và node, nối ảnh tham chiếu, tạo ảnh (Nano Banana), sửa ảnh, tạo video (Veo, Omni Flash), upload ảnh, xem ảnh, lưu file, upscale, mô tả ảnh, viết prompt, thư viện reference, và gọi thẳng mọi API của agent.

Mọi thay đổi AI làm sẽ hiện ngay trên cửa sổ Flowboard đang mở (tự tải lại board, không cần F5).

```
Claude Desktop / Claude Code / Codex ──stdio──┐
                                              ├──> flowboard_mcp ──HTTP──> Flowboard agent :8101 ──> Chrome extension ──> Google Flow
ChatGPT / claude.ai (web, điện thoại) ─HTTPS──┘   (cloudflared tunnel, link bí mật)
```

## 1. Cài một lần

1. Mở Flowboard như thường lệ: `MO-APP.bat` (Chrome có extension, đã đăng nhập Flow).
2. Chạy `MCP-CAI-DAT.bat`. Script cài thư viện `mcp` vào agent rồi tự đăng ký `flowboard` vào:
   - Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`, có bản sao lưu `.bak`)
   - Claude Code (`~/.claude.json`, dùng được ở mọi thư mục)
   - Codex CLI (`~/.codex/config.toml`) nếu máy có Codex
3. Thoát hẳn Claude Desktop (cả icon dưới khay) rồi mở lại. Trong khung chat sẽ thấy công cụ `flowboard`.

## 2. ChatGPT hoặc claude.ai trên web / điện thoại

ChatGPT và claude.ai chạy trên cloud nên cần một link HTTPS trỏ về máy anh.

1. Cài cloudflared một lần (PowerShell): `winget install --id Cloudflare.cloudflared`
2. Chạy `MCP-CHATGPT.bat`. Cửa sổ in ra link dạng
   `https://xxxx.trycloudflare.com/<mã-bí-mật>/mcp` và tự copy vào clipboard.
3. ChatGPT: bật Developer mode trong Settings, thêm app/connector mới, dán link, chọn không xác thực (No authentication). Khi chat, chọn Developer mode và bật app Flowboard. Tên menu của ChatGPT hay đổi, cần thì tìm "Developer mode" trong Settings.
4. claude.ai: Settings → Connectors → Add custom connector, dán link.

Lưu ý:
- Link quick tunnel đổi mỗi lần chạy lại bat, phải dán link mới vào connector.
- Ai có link là điều khiển được Flowboard và tiêu credit Flow. Đổi mã bí mật: `agent\.venv\Scripts\python.exe -m flowboard_mcp secret --rotate`.
- Đóng cửa sổ `MCP-CHATGPT.bat` là ngắt kết nối.

## 3. Công cụ có sẵn (41)

| Nhóm | Công cụ |
|---|---|
| Trạng thái | `flowboard_status` |
| Tài khoản Flow | `list_flow_accounts`, `use_flow_account`, `set_account_auto_switch`, `reset_account_quota` (xem [NHIEU-TAI-KHOAN.md](NHIEU-TAI-KHOAN.md)) |
| Board | `list_boards`, `get_board`, `create_board`, `rename_board`, `delete_board` (phải `confirm=true`), `open_board_in_ui` |
| Node, nối dây | `get_node`, `create_node`, `update_node`, `delete_node`, `connect_nodes`, `set_edge_variant`, `delete_edge` |
| Tạo ảnh/video | `generate_image`, `edit_image`, `generate_video`, `wait_for_request`, `get_request`, `cancel_request`, `list_activity` |
| Media | `view_image`, `upload_image`, `save_media`, `upscale_image`, `describe_image`, `list_assets` |
| Prompt | `enhance_prompt`, `auto_prompt` |
| Thư viện reference | `list_references`, `save_reference`, `update_reference`, `delete_reference`, `place_reference` |
| Toàn quyền | `flowboard_api` (gọi bất kỳ endpoint `/api/...` nào) |
| Tương thích ChatGPT | `search`, `fetch` |

Chi tiết quan trọng:
- `generate_image`: `ref_node_ids` nối vào đúng thứ tự Image 1, 2, 3 nên prompt có thể ghi "image 1", "image 2". `aspect_ratio` 1:1, 16:9, 9:16, 4:3, 3:4. `variants` 1 đến 4. `model` NANO_BANANA_PRO, NANO_BANANA_2_1, NANO_BANANA_2 (mặc định, giống app), NANO_BANANA_2_LITE. Đổi mặc định bằng biến môi trường `FLOWBOARD_MCP_IMAGE_MODEL`.
- Việc chạy lâu (nhất là video) trả về `request_id`; AI gọi `wait_for_request` để chờ tiếp. Agent tự ghi kết quả vào node khi xong, kể cả khi AI đã ngắt.
- `save_media` lưu vào `Pictures\Flowboard` (đổi bằng `folder` hoặc biến `FLOWBOARD_EXPORT_DIR`), đổi định dạng png/jpg/webp, giới hạn cạnh dài.
- Xoá dấu góc ảnh và hộp thoại tải ZIP theo SKU vẫn nằm trong giao diện app, MCP chưa làm thay.

## 4. Ví dụ câu lệnh

- "Mở Flowboard, tạo board 'Halloween 2026', upload ảnh C:\Users\ADMIN\Desktop\mau\tay.jpg làm ảnh tham chiếu, rồi tạo 4 ảnh 9:16 bộ nail bí ngô cam đen đeo trên tay, dựa theo image 1."
- "Xem 4 ảnh vừa tạo, chọn ảnh đẹp nhất, sửa cho móng bóng hơn, rồi lưu thành webp tên HD_HLW_001."
- "Lấy ảnh variant 2 của node 42 làm video Veo 9:16 tay xoay nhẹ khoe móng."
- "Liệt kê các board và cho biết node nào đang lỗi, lỗi gì."

## 5. Chạy tay / gỡ lỗi

```
cd agent
.venv\Scripts\python.exe -m flowboard_mcp            # stdio (cho Claude/Codex tự gọi)
.venv\Scripts\python.exe -m flowboard_mcp http       # HTTP local http://127.0.0.1:8765/<mã>/mcp
.venv\Scripts\python.exe -m flowboard_mcp public     # HTTP + tunnel, in link
.venv\Scripts\python.exe -m flowboard_mcp install    # đăng ký lại Claude Desktop/Code/Codex
```

| Lỗi | Cách xử lý |
|---|---|
| "Không kết nối được Flowboard agent" | Chưa mở app. Chạy `MO-APP.bat`. |
| `paygate_tier_unknown` | Mở labs.google/flow một lần trong Chrome có extension. |
| `...QUOTA_REACHED` | Hết lượt model đó trong ngày, đổi `model`. |
| Claude Desktop không thấy tool | Thoát hẳn app rồi mở lại; chạy lại `MCP-CAI-DAT.bat`. |
| Biến môi trường | `FLOWBOARD_URL` (mặc định http://127.0.0.1:8101), `FLOWBOARD_MCP_PORT` (8765), `FLOWBOARD_MCP_SECRET`. |
