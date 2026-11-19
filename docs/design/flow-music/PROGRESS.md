# Flow Music UI — tiến độ

## Bước 1 · Design gate (19/11/2026) — CHỜ OWNER DUYỆT
- Prototype bấm thử: `docs/design/flow-music/prototype.html` (mở thẳng bằng Chrome; thanh "Mockup" góc phải dưới để đổi trạng thái: có dữ liệu / trống / đang tải / lỗi / chưa có tài khoản; nút Giao diện sáng/tối ở sidebar).
- Ảnh chụp: `docs/design/flow-music/shots/` — 44 ảnh, 390/768/1024/1366/1920 × sáng/tối; `lint.json` = 0 lỗi (cuộn ngang, nút xuống dòng/bị cắt, chữ vượt dòng, thẻ cùng nhóm lệch cao).
- Chụp lại: `node docs/design/flow-music/shoot.cjs` (chạy từ PowerShell; Playwright mượn `E:/handora-final/node_modules`).
- Token màu, font, bo góc lấy nguyên từ `frontend/src/theme-studio.css` (Lacquer Studio, hồng #f2558f); bản sáng là token mới (Flowboard hiện chỉ có tối).

### Màn đã dựng
1. **Flow Music** (mục mới trên sidebar, sau Image Gen): khung Soạn bài trái (tiêu đề, phong cách, lời + nút chèn nhãn [Verse]…, công tắc Không lời, Model, Số bản 1–4, MP3/WAV, chọn tài khoản, Nâng cao: stems + seed; chân: credit sẽ tốn / còn lại + nút Tạo) · phải: tab Hàng đợi (lưới cột cố định: bài · trạng thái · tiến độ · tài khoản · credit · lúc · thao tác; bài xong mở các bản với waveform, tải MP3/WAV, stems, lên board; lỗi hiện dòng đỏ + nút Kiểm tra) và tab Thư viện (lưới/bảng, tìm, lọc chip, chọn nhiều → actionbar ghim đáy) · player ghim đáy.
   - Mobile: 3 tab Soạn bài / Hàng đợi / Thư viện, nav đáy.
2. **Tài khoản** (đổi tên từ "Tài khoản Flow"): 4 KPI · khối **Link MCP của tôi** nổi bật (copy, nơi dán: flowytb / claude.ai / ChatGPT, tạo link mới, thu hồi) · mỗi tài khoản Google 1 thẻ có 2 ô dịch vụ Flow ảnh + Flow Music (trạng thái, credit, bận/rảnh, lần kiểm, nút Kiểm tra lại / Mở flowmusic.app) · hướng dẫn 4 bước có hình · danh sách mã ghép nối + link đang hoạt động.

### Cần Owner quyết
1. **Link MCP chỉ hiện đủ 1 lần lúc tạo** (backend chỉ lưu hash token `fbt_`, như hiện tại). Muốn lúc nào cũng copy được thì phải lưu token dạng mã hoá — kém an toàn hơn. Đề xuất: giữ 1 lần + nút "Tạo link mới".
2. Thêm **giao diện sáng** cho cả Flowboard (hiện chỉ tối) hay chỉ giữ tối?
3. Đổi menu "Tài khoản Flow" → "Tài khoản" (gộp Flow ảnh + Flow Music).
4. Backend cần thêm khi code: `GET /api/music/requests?limit&cursor` (lịch sử/thư viện), waveform peaks, tiêu đề + phong cách lưu trong kết quả.

## Bước 2 · Code UI thật — chưa bắt đầu (chờ duyệt)
## Bước 3 · Deploy — chỉ khi Owner đồng ý
