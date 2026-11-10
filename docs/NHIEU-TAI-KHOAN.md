# Nhiều tài khoản Google Flow, tự đổi khi hết lượt

Flowboard dùng được nhiều tài khoản Google Flow Pro cùng lúc. Mỗi tài khoản là một Chrome profile riêng. Khi một tài khoản hết lượt tạo ảnh trong ngày, lệnh đó tự chạy lại bằng tài khoản kế tiếp. Anh không phải làm gì thêm.

```
Chrome profile A (shop.a@...)  ─┐
Chrome profile B (shop.b@...)  ─┼─ extension ─> Flowboard agent ─> chọn tài khoản cho từng lệnh
Chrome profile C (staff.c@...) ─┘
```

## Thêm một tài khoản

1. Trong Chrome, bấm vào ảnh đại diện góc trên bên phải, chọn **Thêm** để tạo profile mới (hoặc mở profile có sẵn).
2. Trong profile đó, cài extension **Flowboard Bridge**: vào `chrome://extensions`, bật Developer mode, chọn Load unpacked, rồi chọn thư mục `extension` trong `E:\FLOW-BY-QB-main`.
3. Đăng nhập tài khoản Google Flow Pro, mở `labs.google/fx/tools/flow` và để tab đó mở. Extension cần tab Flow để giải captcha.
4. Tài khoản tự hiện trong trang **Tài khoản Flow** trên menu bên trái. Ô nhỏ ở góc dưới bên trái cũng mở trang này.

Không lưu mật khẩu ở đâu cả. Mỗi tài khoản vẫn đăng nhập trong Chrome profile của nó.

## Cách tự đổi hoạt động

- Mỗi lệnh chạy trọn trên một tài khoản, từ project, upload đến tạo ảnh và chờ kết quả.
- Khi tạo ảnh hoặc sửa ảnh bị báo hết lượt, extension đã thử hết các model (Pro, 2.1, 2, Lite) trên tài khoản đó. Agent đánh dấu tài khoản **Hết lượt**, rồi chạy lại lệnh bằng tài khoản kế tiếp. Node vẫn ra ảnh như bình thường.
- Tài khoản hết lượt được mở lại khoảng 0:05 giờ Mỹ (tức khoảng 15:05 giờ Việt Nam) khi Google reset lượt. Sau 30 phút, nếu mọi tài khoản đều hết thì agent thử lại tài khoản hết sớm nhất, vì bị từ chối không tốn credit. Nút **Mở lại** bỏ dấu ngay, ví dụ khi anh vừa mua thêm credit.
- Video (Veo, Omni) chạy trên tài khoản đang dùng và không tự đổi khi lỗi.
- Ảnh tham chiếu và ảnh gốc làm video thuộc tài khoản khác sẽ được tự upload lại sang tài khoản đang chạy, từ bản lưu trên máy.
- Mỗi board có một Flow project riêng cho từng tài khoản. Project cũ trước khi có tính năng này được tính là của tài khoản đầu tiên kết nối.

## Trang Tài khoản Flow

| Mục | Ý nghĩa |
|---|---|
| Đang dùng | Lệnh mới sẽ chạy trên tài khoản này |
| Sẵn sàng | Còn lượt, sẽ được dùng khi tài khoản trên hết |
| Hết lượt · mở lại lúc 15:05 | Đã hết lượt hôm nay |
| Ưu tiên dùng / Bỏ ưu tiên | Chọn tài khoản dùng trước |
| Mũi tên ▲▼ | Đổi thứ tự dùng: tài khoản 1 hết lượt thì sang 2, rồi 3 |
| Số liệu | Lệnh xong, ảnh/video, lỗi, số lần bị đổi đi, tính từ 0 giờ hôm nay |
| Lần tự đổi gần đây | Nhật ký các lần tự chuyển tài khoản và lý do |
| Tự đổi khi hết lượt | Tắt đi thì luôn dùng tài khoản đang chọn, không tự chuyển |

Node nào tạo xong sẽ ghi lại tài khoản đã tạo (`flowAccount`).

## Điều khiển bằng Claude / ChatGPT (MCP)

Có thêm 4 tool: `list_flow_accounts`, `use_flow_account`, `set_account_auto_switch`, `reset_account_quota`. Kết quả `generate_image` cho biết tài khoản đã dùng (`flow_account`) và những lần đổi (`account_switches`).

## API

`GET /api/accounts`, `POST /api/accounts/select {key}`, `POST /api/accounts/settings {auto_rotate}`, `POST /api/accounts/reset {key}`, `POST /api/accounts/order {keys}`. Trạng thái lưu trong `storage/accounts.json`.
