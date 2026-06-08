<p align="center">
  <b>FLOWBOARD</b><br/>
  <i>Infinite-canvas workspace cho AI media workflow — node graph, multi-page, image editor.</i>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT"/>
  <img src="https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white" alt="Python"/>
  <img src="https://img.shields.io/badge/Node-20+-339933?logo=node.js&logoColor=white" alt="Node"/>
  <img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white" alt="React"/>
  <img src="https://img.shields.io/badge/React%20Flow-12-8A2BE2" alt="React Flow"/>
  <img src="https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white" alt="MV3"/>
  <img src="https://img.shields.io/badge/Flow-Pro%20%2F%20Ultra-EA4335?logo=google&logoColor=white" alt="Flow"/>
</p>

---

## Flowboard là gì

Flowboard là workspace **canvas vô hạn** chạy **local trên máy bạn**, dùng để dựng các workflow tạo ảnh/video bằng AI dưới dạng đồ thị các node nối với nhau bằng đường bezier. Mỗi lệnh generate được proxy qua một **Chrome extension** tới **Google Flow** (Veo 3.1 i2v + GemPix 2), dùng chính phiên đăng nhập Flow của bạn.

> ⚠️ **Yêu cầu bắt buộc:** tài khoản Google Flow gói **Pro hoặc Ultra** ([labs.google/fx/tools/flow](https://labs.google/fx/tools/flow)) — gói free không chạy được. Phải load Chrome extension trong `extension/`. Cần một LLM CLI trên PATH (Claude Code mặc định, hoặc Gemini CLI / Codex) cho auto-prompt / vision / assistant.

---

## Tính năng

### Canvas (giao diện kiểu Magnific Spaces)
- **Infinite canvas** với pan/zoom (5%–400%), nét đứt cho đường nối, hiệu ứng **chạy sáng màu xanh** trên đường nối khi pipeline đang generate.
- **Left toolbar nổi**: Add node (+), Select (V), Hand (H), Group (G) — thu gọn được.
- **Footer**: chuyển nhanh giữa các flow, bật/tắt minimap, dropdown zoom (5/10/25/50/100/200% / Fit).
- **Sidebar thu gọn được** với 3 trang chính: Flows · Image Gen · Library.
- **Cắt kết nối**: chọn 1 đường nối → bấm nút ✂ ở giữa để ngắt liên kết 2 node.

### Node types
- **Image** — gen ảnh nhiều ref (kéo node khác vào làm reference). Card có **prompt nhập trực tiếp + @-tag** node khác, stepper số variant (x1–x4), chọn model, chọn tỷ lệ; khung node **tự khớp tỷ lệ ảnh** (1:1 → vuông, 9:16 → dọc). Nút ▶ gen ngay, không cần popup. Nút **Replace** đổi ảnh tại chỗ.
- **Video** — image-to-video qua Veo, multi-source i2v.
- **Storyboard** — nhiều shot trong một node.
- **Character / Visual asset** — node tham chiếu (upload hoặc generate).
- **Assistant** — chạy LLM (Claude / Gemini) tự do, hỗ trợ @-tag node.
- **Prompt / Note** — text node.

### Run pipeline
- **Run from here** — chạy node đó rồi lan theo edge xuống toàn bộ node phía sau, **tuần tự**: node sau **đợi node trước generate xong** rồi mới lấy ảnh/text vừa tạo làm đầu vào. Lỗi/timeout thì dừng cả chuỗi.
- **This node only** — chỉ chạy đúng 1 node.

### Group
- Quét chọn nhiều node → **Group** thành một khung. Toolbar riêng cho group: **đổi màu nền, Ungroup, Arrange (Vertical/Horizontal/Grid), Lock, Duplicate, Download toàn bộ ảnh trong group** (tải từng file riêng), Delete.
- Kéo khung = di chuyển mọi node bên trong.

### Image Editor
- **AI edit** — sửa ảnh bằng prompt.
- **Crop & Flip** — cắt theo preset tỷ lệ + lật ngang/dọc, lưới 1/3, kéo 8 điểm.
- Trong viewer kết quả: **zoom/pan ảnh bằng lăn chuột**, các nút AI edit · Crop & Flip · Download · Re-generate.

### Trang độc lập (không cần canvas)
- **Flows** — gallery tất cả flow, tạo flow mới, mở/xóa.
- **Image Gen** — gen lẻ từng ảnh: form prompt + @-tag, **upload ảnh tham chiếu (tối đa 4)**, chọn model/variant/tỷ lệ; gallery kết quả realtime.
- **Library** — toàn bộ ảnh/video đã tạo từ mọi flow + Image Gen, filter, tải về.

---

## Kiến trúc

```
┌──────────────────────┐   WS    ┌────────────────────┐        ┌──────────────────────┐
│  Chrome MV3 ext      │◄───────►│  FastAPI agent     ├───────►│  SQLite (storage/)   │
│  (proxy Google Flow) │ :9223   │  127.0.0.1:8101    │        │  Board/Node/Edge/... │
└──────────┬───────────┘         │  + worker queue    │        └──────────────────────┘
           │                     │  + LLM CLI bridge  │
           ▼                     └─────────┬──────────┘
   labs.google (Flow)                      ▼
                              ┌────────────────────┐
                              │  React + Vite      │
                              │  ReactFlow canvas  │
                              │  127.0.0.1:5173    │
                              └────────────────────┘
```

- **frontend/** — React 18 + Vite + ReactFlow 12 + Zustand, TypeScript strict.
- **agent/** — FastAPI + SQLModel + SQLite, worker queue, cầu nối LLM CLI.
- **extension/** — Chrome MV3, proxy mọi lệnh Flow qua WebSocket localhost.

---

## Cài đặt

**Yêu cầu:** WSL2 (Ubuntu) hoặc Linux/macOS · Python 3.11 · Node 20+ · Chrome · tài khoản Flow Pro/Ultra · 1 LLM CLI (`claude` / `gemini` / `codex`).

```bash
git clone https://github.com/quocbao1772003-spec/FLOW-BY-QB.git
cd FLOW-BY-QB
make install
```

1. `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục `extension/`.
2. Mở tab `labs.google/fx/tools/flow`, đăng nhập tài khoản Flow **của riêng bạn**.
3. Chạy app (2 terminal):

```bash
make agent      # FastAPI :8101
make frontend   # Vite :5173
```

4. Mở `http://localhost:5173`.

---

## Cập nhật

Khi có bản mới trên GitHub, chỉ cần một lệnh:

```bash
make upgrade
```

Script `update.sh` sẽ: `git pull` → tự cài lại deps nếu requirements/package.json đổi → nhắc reload extension nếu `extension/` đổi → nhắc restart agent + frontend. **Dữ liệu local (board, ảnh) không bị động tới** (`storage/` được git-ignore).

Sau đó restart `make agent` + `make frontend` và hard-refresh trình duyệt (Ctrl+Shift+R).

---

## Lưu ý

- App là **local-only, single-user**: mỗi người chạy bản riêng trên máy mình, đăng nhập tài khoản Flow riêng. Board/ảnh nằm trên máy người đó.
- Không gọi API LLM cloud trực tiếp — auto-prompt/vision/assistant shell ra CLI dùng subscription của bạn.

## License

MIT. Dự án phát triển từ một bản gốc và được mở rộng đáng kể (canvas UI, multi-page, image editor, group, run-from-here pipeline, v.v.).
