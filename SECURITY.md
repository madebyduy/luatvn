# Security policy

Không gửi lỗ hổng kèm secret, dữ liệu truy vấn thật hoặc tài liệu cá nhân vào issue công khai.

Repository chưa có kênh báo lỗi bảo mật chính thức. Đây là trạng thái `Unknown` cần chủ dự án quyết định trước public pilot. Khi có kênh, phải cập nhật file này và `security.txt` cùng lúc.

Nguyên tắc hiện tại:

- deny by default;
- không public database/search/cache;
- không lưu raw query mặc định;
- không ghi token/secret vào log;
- không parse file internet trong process API;
- mỗi control mới phải trỏ tới một threat đã ghi nhận.
