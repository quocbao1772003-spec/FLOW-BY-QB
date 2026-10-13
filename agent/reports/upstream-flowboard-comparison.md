# Đối chiếu Flowboard ngày 2026-10-12

Nguồn: https://github.com/crisng95/flowboard tại commit `0aabdb349ba89aad62dccf59c3df78198a39ba3f`.

**Cập nhật 13/10, bản 0.1.14:** phần dưới là kết quả các lần sửa trước. Sau cặp log 0.1.13, khôi phục cơ chế giữ hàm reCAPTCHA của repo trong `extension/captcha-api.js`, thu hẹp hook theo đúng object, cho phép cập nhật thư viện hợp lệ và không mang hàm qua object mới. Generate/upload/upscale dùng chung hàng đợi mint. Xem `unusual-activity-investigation-20261012.md` cho bằng chứng, giới hạn và 15 bộ kiểm thử. Chưa xác nhận Google chấp nhận generation thật qua bản mới.

## Kết quả nghiên cứu

- Upstream chuyển SDK Python sang `flow_batch.py`, xây dựng payload BOQ rõ ràng; extension chỉ thực hiện request trong tab Flow. Bản hiện tại vẫn chuyển đổi request SDK cũ ở extension. Không thay toàn bộ SDK vì sẽ ảnh hưởng các luồng video và quản lý project ngoài phạm vi lỗi đang kiểm tra.
- Upstream dùng cookie của trang, WIZ metadata và token reCAPTCHA mới cho mỗi yêu cầu. **Đính chính ngày 12/10, 13:45:** `extension/injected.js` ở commit được đối chiếu còn ghi đè `Object.defineProperty` và các property reCAPTCHA để chặn hàm chứa `extension_hijack_detected`. Nhận định ban đầu rằng upstream không ghi đè là sai. Bản hiện tại không sao chép cơ chế can thiệp này. Comment upstream chỉ là giả thuyết về hoạt động của Flow, không phải bằng chứng đã quan sát trong Chrome của người dùng.
- Upstream phân biệt reference (1) và base image (2) trong mỗi image input. Bản hiện tại sao chép vai trò từ mẫu đã học, có thể gán base cho mọi ảnh. Đã sửa vai trò theo yêu cầu hiện tại, giữ nguyên cấu trúc mẫu.
- Upstream chưa port tạo/list project và thông tin credit. Họ sử dụng project cấu hình cố định. Vì vậy không sao chép cơ chế project này: người dùng yêu cầu một project cho mỗi phiên app; bản hiện tại đã có RPC tạo project được quan sát thực tế.
- Upstream đặt UUID ở cả slot 12 và 13 của image item. Bản built-in hiện tại đặt null ở slot 12, còn mẫu học theo traffic thực tế. Chưa có bằng chứng đủ để khẳng định khác biệt này gây NOT_FOUND; không đổi mù một trường chưa xác minh.

## Lỗi mới xác định được

Khi sync ảnh sang session project, ID `a` thành `session-a`, nhưng file gốc vẫn được lưu theo `a`. Worker truyền `session-a` vào hàm phục hồi nên tải lại thất bại dù ảnh gốc vẫn còn.

Đã tách danh sách ID nguồn dùng để phục hồi và danh sách ID đã sync dùng cho lần gửi đầu. Khi NOT_FOUND, upload lại bằng ID nguồn và cập nhật mapping nguồn → ID mới. Thử lại tối đa một lần như trước; không bỏ bớt reference nếu upload thiếu.

## Kiểm chứng

- Toàn bộ các file `extension/test/*.test.js`: đạt.
- Sáu kiểm thử Python cô lập bằng stdlib: đạt, bao gồm gen/edit lỗi NOT_FOUND sau sync, dùng ảnh gốc để upload lại, dùng ID mới để retry, chia sẻ project trong phiên, tạo lại sau reset, không generate khi tạo project/upload thất bại và tạo project đồng thời.
- Chưa chạy toàn bộ pytest của agent. Chưa xác nhận tạo ảnh thật thành công trên Google Flow.
- Phiên bản extension: 0.1.11. Cần khởi động lại agent để nạp sửa Python, reload extension và tải lại tab Flow để nạp sửa JavaScript.

NOT_FOUND không tự nó chứng minh ảnh tham chiếu bị mất; nó có thể liên quan thực thể khác trong request. UNUSUAL_ACTIVITY vẫn là lỗi từ Google và không được coi là đã giải quyết chỉ vì kiểm thử cục bộ đạt.
