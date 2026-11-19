# Flow Music UI — tiến độ

## Bước 1 · Design gate (19/11/2026) — Owner đã duyệt
- Prototype bấm thử: `docs/design/flow-music/prototype.html`; ảnh `shots/` (44 ảnh, lint 0 lỗi).
- Owner chốt: bám sát UI các tính năng Flowboard có sẵn, chỉ giao diện tối, custom phần tạo nhạc; link MCP giữ "chỉ hiện đủ 1 lần" (token lưu hash).

## Bước 2 · Code UI thật — XONG 19/11
- Tab **Flow Music** (sidebar, cạnh Image Gen): `frontend/src/components/music/FlowMusicPage.tsx` (+ `Waveform.tsx` vẽ từ audio thật, `music.css`).
  Soạn bài (lời + chèn [Verse]…, Không lời, Model, 1–4 bản, MP3/+WAV, tài khoản, Nâng cao: stems + seed, credit sẽ tốn/còn lại; nháp tự lưu) ·
  Hàng đợi cột cố định (trạng thái, tiến độ, tài khoản, credit, lúc), nghe thử, tải MP3/WAV/stems, Tách stems, Lên board (node song), Tạo lại, Dùng lại, Huỷ ·
  Thư viện lưới/bảng, lọc, tìm, chọn nhiều → actionbar · player ghim đáy.
- **Tài khoản** (đổi tên menu): dòng Flow Music mỗi thẻ (đăng nhập, credit, bận/rảnh, lần kiểm), nút Kiểm tra Flow Music, KPI credit, bước 4 đăng nhập flowmusic.app, khối **Link MCP của tôi** (`McpLinkCard.tsx`).
- Backend: `GET /api/music/requests` (mới nhất trước, `before`, `status`); `_view` thêm title/prompt/lyrics/created_at…; `music_snapshot.checked_at`; tuỳ chọn stems khi tạo bài giờ tự tách stems từng bản.
- Kiểm: `test_flow_music` 20/20; toàn bộ `agent/tests` 31 fail = baseline; `tsc` 27 lỗi = baseline (0 lỗi mới); `vite build` OK.
- Ảnh app thật (dev server + dữ liệu mẫu): `docs/design/flow-music/shots-app/` (768/1024/1366/1920), chụp lại bằng `shoot-app.cjs`.

## Bước 3 · Deploy
- Owner đồng ý 19/11: push main → server nail-sg `/opt/flowboard` `git pull --ff-only && docker compose up -d --build flowboard`.
