# Brief — Thiết kế tab "Flow Music" + Kết nối tài khoản (Flowboard)

Owner yêu cầu 19/11/2026: "mở một phiên bên Flowboard, design giao diện đàng hoàng cho tính năng mới với tab mới là Flow Music, và làm cả phần kết nối tài khoản".

## Bối cảnh
- Repo: worktree `E:\fb-music` (nhánh `feat/flow-music`, Flowboard). Đừng đụng `E:\FLOW-BY-QB-main` (phiên khác). Không pull/rebase/stash; KHÔNG deploy khi Owner chưa duyệt.
- Backend đã có (commit 66b0fb1 + 651fef8, prod đang chạy 66b0fb1): `/api/music/generate|requests/{id}|cancel|accounts|accounts/refresh|media/{path}|stems|whoami`, worker `gen_music`, account pool khoá `music:<email>`, scoping theo user (token `fbt_`), MCP tools `generate_music/get_music/music_credits/split_stems`, extension 0.2.3 lệnh `music_call` (`extension/music-api.js`), node `song` (`frontend/src/canvas/SongNodeCard.tsx`, chỉ hiển thị kết quả).
- Tài liệu API Flow Music: `C:\Users\ADMIN\orca\workspaces\Youtube\Kênh\flow-music\README.md`; thiết kế tích hợp: `C:\Users\ADMIN\ytops-music\docs\research\music-pipeline\06-flowboard-music-integration.md`; contract REST: `C:\Users\ADMIN\ytops-music\specs\001-music-playlist-pipeline\contracts\flowboard-music-api.md`.
- Frontend: React 18 + Vite + zustand + @xyflow; trang có sẵn: `ImageGenPage.tsx`, `AccountsPage.tsx`, `AccountPanel.tsx`, `ChromePairing.tsx`, `ConnectGuide.tsx`, `AppSidebar.tsx`, `LibraryPage.tsx`, `TemplatesPage.tsx`, `settings/AiProvidersSection.tsx`. Học style + component của chính Flowboard trước khi thiết kế (đồng bộ, không tự chế style mới).

## Việc cần làm
1. **Thiết kế trước, duyệt trước khi code (Design gate)** — dùng skill `ui-ux-pro-max` (`C:\Users\ADMIN\.claude\skills\ui-ux-pro-max`, KHÔNG để generator đổi màu brand Flowboard) + quy chuẩn Handora Ops (`C:\Users\ADMIN\orca\workspaces\handora-final\ux-ui\specs\006-ux-ui-van-hanh\design\CONTENT-RULES.md`, `ds\kit.css`, `ref\mobile-research.md`): lưới 4/8, 1 cỡ control, vai chữ H/N/B/C có giới hạn ký tự + số dòng, chiều cao khối cố định, danh sách dùng grid cột cố định (cột trạng thái/tiến độ/thời gian thẳng hàng), actionbar ghim đáy khi chọn nhiều, icon Lucide (không emoji), sáng/tối, 390/768/1024/1366/1920. Mockup HTML bấm thử được trong `docs/design/flow-music/` + ảnh chụp Playwright; gửi Owner duyệt.
2. **Tab "Flow Music"** (mục mới trên sidebar, cạnh tạo ảnh):
   - Ô soạn bài: Lời (có nhãn [Verse]/[Chorus], đếm dòng), công tắc Không lời, Mô tả phong cách (sound prompt), Tiêu đề, Model (Lyria 3.5 / Lyria 3 Pro), Seed (nâng cao), Số bản 1–4, Định dạng (mp3/wav), Tách stems; hiển thị credit sẽ tốn (~5/bản) + credit còn lại; chọn tài khoản (Tự động / tài khoản cụ thể).
   - Hàng đợi + lịch sử: thẻ mỗi yêu cầu (trạng thái, tiến độ, tài khoản, credit dùng, thời gian), kết quả gồm player waveform, ảnh bìa, lời, tải mp3/wav/stems, "Đưa lên board" (tạo node song), "Tạo lại", "Huỷ".
   - Thư viện bài của tôi: lưới/bảng, lọc, tìm, nghe thử.
   - Trạng thái trống/đang tải/lỗi rõ ràng (vd "Chưa có tài khoản Flow Music — Kết nối ngay").
3. **Kết nối tài khoản** (trang/tab Tài khoản):
   - Mỗi tài khoản Google: Flow (ảnh) + Flow Music trên cùng một thẻ: email, trạng thái phiên Flow / Flow Music (đăng nhập hay chưa), credit Flow Music còn lại, bận/rảnh, lần kiểm cuối, nút "Kiểm tra lại" (`/api/music/accounts/refresh`), "Mở flowmusic.app để đăng nhập".
   - Hướng dẫn kết nối từng bước (Chrome extension 0.2.3 → pair → đăng nhập labs.google/flow + flowmusic.app) có ảnh minh hoạ.
   - **Link MCP cá nhân** (`https://flowboard.flowytb.app/mcp/fbt_…`) hiển thị nổi bật + nút Copy + giải thích: dán vào flowytb (Cài đặt › Kết nối AI) / claude.ai / ChatGPT để dùng Flow ảnh + Flow Music bằng tài khoản của chính mình. Tạo mới / thu hồi token.
4. Backend nhỏ nếu cần cho UI (chỉ thêm, có test): vd endpoint lịch sử `GET /api/music/requests?limit&cursor`, waveform peaks.
5. Test: `agent/tests` không lỗi mới (baseline 31 fail có sẵn), `npm run build` (tsc) sạch cho file mới, extension tests `extension/test/*.js` nếu đụng extension (nâng version manifest +1).
6. Commit trong `E:\fb-music`. Báo Owner: link mockup, ảnh, những gì cần duyệt. Deploy chỉ khi Owner đồng ý (quy trình: push main → server nail-sg `/opt/flowboard` `git pull --ff-only && docker compose up -d --build flowboard`, rồi tải thử extension.zip qua domain kiểm cf-cache-status).

Ghi tiến độ vào `E:\fb-music\docs\design\flow-music\PROGRESS.md` sau mỗi bước.
