# Điều tra UNUSUAL_ACTIVITY — 12/10/2026

## Kết luận đã có bằng chứng

- Hai request extension lúc 13:38:33 và 13:39:01 giờ Bangkok gửi tới project `8c7322f4-a2bc-4951-be2e-c529f88804bf`, model `GEM_PIX_2` (Nano Banana Pro). Payload dùng hai reference mới `071b2e67…` và `f1c1779b…`, không dùng ID project cũ trong INPUT của board.
- Phản hồi gRPC là 7/PERMISSION_DENIED và ErrorInfo là PUBLIC_ERROR_UNUSUAL_ACTIVITY. Đây là lý do được Google trả về, không phải phép suy đoán của app từ HTTP 403. Extension chuyển lý do này thành status 403 trong giao tiếp với agent.
- Người dùng xác nhận tạo trực tiếp thành công với hai ảnh tham chiếu. Log sau đó xác nhận cùng project/model/prompt, nhưng một reference có ID khác (bảng bên dưới). Không có căn cứ kết luận tài khoản hết lượt hoặc toàn bộ project bị khóa.
- Đổi project đã xử lý vấn đề project cũ nhưng không giải quyết được nguyên nhân từ chối này. Không tiếp tục tạo project liên tục như một biện pháp chữa lỗi.

## Cặp đối chiếu đã thu được

Nguồn đã lưu riêng trong `generation-pair-20261012.json`, không chứa cookie/token/WIZ secret hoặc URL ảnh có chữ ký.

| Trường | Flow trực tiếp | Extension |
| --- | --- | --- |
| Kết quả lúc (12/10, Bangkok) | 13:52:02 | 13:49:18 |
| Project | `8c7322f4-a2bc-4951-be2e-c529f88804bf` | giống |
| Model | `GEM_PIX_2` | giống |
| Prompt | Thay nails trong mockup bằng QB_HLW26_23 | giống chính xác |
| Reference đầu | `c965d893-6d36-4cca-8ce7-c23df3591322` | `071b2e67-57d5-4aa7-ac13-7a06fb364e9b` |
| Reference thứ hai | `f1c1779b-03df-4958-b49f-8d292d243bc9` | giống |
| Tab | visible | hidden |
| API toàn cục chứa marker | có | có |
| Kết quả | ảnh `3b3645e3-052a-4ed1-9a89-05b4fb361701` | RPC7 UNUSUAL_ACTIVITY |

Build và cấu trúc payload giống nhau sau khi chuẩn hóa UUID/seed/token/prompt. Prompt được so riêng, giống chính xác. Không xem đây là hai request giống hoàn toàn: khác ID reference đầu, visibility và token không lưu thô. Không thay mapping ảnh chỉ dựa trên việc một ID khác tạo thành công.

Native thành công dù API toàn cục có marker, nên marker không chứng minh cả trang bị lỗi. Giả thuyết mạnh là native và extension đi qua hai đường lấy token khác nhau; chưa ghi được source hàm thực tế hoặc action phía Google xác nhận. Lần native 13:49:11 chỉ tạo chó đen không có reference, không dùng làm bằng chứng cho trường hợp hai reference.

## Vì sao bộ log cũ chưa đủ

- File log ban đầu chỉ còn hai request extension thất bại. 0.1.13 đã thu được cặp đối chiếu bên trên.
- Agent giữ 60 dòng gần nhất cho mọi RPC. Request danh sách/thư viện liên tục đẩy mất bằng chứng tạo ảnh.
- Monitor chỉ đọc string body, bỏ qua fetch Request và URLSearchParams. Không thể xem việc không có log là bằng chứng người dùng chưa tạo ảnh.
- Chrome của người dùng không nằm trong trình duyệt kết nối với công cụ phiên này. Công cụ chỉ thấy trình duyệt trong Codex chưa có tab và bề mặt MCP Apps; không thể trực tiếp chạy kiểm chứng trên phiên Google đã đăng nhập.

## Đính chính nghiên cứu upstream

Đã đọc mã nguồn tại commit `0aabdb349ba89aad62dccf59c3df78198a39ba3f` của https://github.com/crisng95/flowboard. File injected.js có cơ chế ghi đè Object.defineProperty và property reCAPTCHA nhằm giữ hàm thư viện khi trang gán hàm chứa extension_hijack_detected. Nhận định trước rằng repo không còn cơ chế này là sai. Cơ chế này cũng có trong HEAD của repo local, nhưng đã bị bỏ trong các lần sửa trước; 0.1.13 tiếp tục gọi hàm thay thế. Quyết định lúc đó chỉ quan sát chưa giải quyết được sự khác biệt này. 0.1.14 khôi phục cơ chế tương thích với phạm vi hẹp hơn, như phần dưới.

Log người dùng xác nhận marker có trong hàm toàn cục; vẫn chưa tự chứng minh điều kiện Google từ chối. Comment upstream mô tả hàm thay action thành extension_hijack_detected. Kiểm thử mô phỏng tái hiện điều kiện này, nhưng không thay thế kiểm chứng trên dịch vụ thật.

## Thay đổi 0.1.13

- Chỉ chuyển trace của generate/upload/create/upscale, tránh log housekeeping đẩy mất cặp đối chiếu.
- Monitor xử lý string, URLSearchParams và Request clone, không tiêu thụ hoặc sửa request gốc.
- Chỉ học khuôn từ RPC ogiZ0b, không học nhầm response thư viện có URL ảnh.
- Ghi trace extension cả thành công và thất bại, trạng thái HTTP thực, đường dẫn trang, visibility và cờ quan sát API. Không ghi cookie, at hoặc token reCAPTCHA thô trong trace chuyển tới agent.
- Bỏ hướng dẫn reload như một cách chữa mặc định khi Google đã trả UNUSUAL_ACTIVITY.
- Thêm công cụ compare-generation-traces.js: ghép đúng project/model, chuẩn hóa UUID/seed/prompt/token trước khi so sánh; không coi khác biệt cấu trúc là nguyên nhân đã xác nhận.

## Tiêu chí hoàn tất

1. Có một trace manual thành công và một trace extension thất bại cùng project/model từ phiên hiện tại.
2. Chỉ sửa khác biệt có căn cứ hoặc chỉ rõ kiểm tra phía dịch vụ không thể giải quyết bằng sửa client.
3. Tạo ảnh thật thành công qua app với hai reference, kết quả gắn về đúng node. Kiểm thử giả lập không thay thế bước này.

## Bản sửa 0.1.14 — 13/10/2026

- `captcha-api.js` chạy trước `injected.js` tại document_start, giữ hàm thư viện reCAPTCHA khi được nạp. Hook Object.defineProperty chỉ xử lý đúng đối tượng grecaptcha.enterprise; không chặn execute trên các object khác như cách upstream hiện viết.
- Cho phép cập nhật thư viện hợp lệ; không giữ hàm cũ của một enterprise object để dùng cho enterprise object mới. Getter được gọi đúng receiver và không bị gọi sớm khi định nghĩa.
- Khi tab đã tải trước extension và không quan sát được hàm thư viện gốc, dừng với CAPTCHA_API_RELOAD_REQUIRED, không tự chế token hay gửi request giả định là hợp lệ.
- Generate/upload/upscale dùng chung hàm mint và hàng đợi với legacy bridge. Trước đây BOQ gọi trực tiếp global execute nên bỏ qua hàng đợi trong injected.js.
- Giữ nguyên project, mapping reference, payload và xử lý từ chối của server để kiểm tra riêng thay đổi đường token. Không retry UNUSUAL_ACTIVITY tự động.
- Kiểm thử tích hợp sử dụng code bridge và hàm generate thật với server giả kiểm tra action/token/project/hai reference. Nó xác nhận sửa trường hợp action bị thay trong mô hình kiểm thử; chưa xác nhận Google chấp nhận request thực.

Kiểm chứng 0.1.14: 15/15 file kiểm thử Node đạt; kiểm tra cú pháp các script thay đổi và git diff --check đạt. Kiểm kê trình duyệt ngày 13/10 vẫn chỉ có IAB/MCP Apps, không có Chrome chứa phiên Flow của người dùng để tự kiểm chứng end-to-end.

Trạng thái: đã có cặp log và bản sửa nguyên nhân nghi ngờ, chưa đạt tiêu chí tạo ảnh thực qua extension thành công. Cần nạp 0.1.14 bằng reload extension rồi tải lại tab Flow một lần vì mã phải chạy từ document_start. Không cần restart agent. Chỉ cần kiểm tra app một lần, không yêu cầu người dùng lặp lại việc tạo trực tiếp.
