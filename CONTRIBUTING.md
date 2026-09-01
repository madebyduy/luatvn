# Đóng góp

Repo này ưu tiên **tính đúng đắn kiểm chứng được** hơn tốc độ thêm tính năng. Vài quy tắc giữ cho nó như vậy:

1. Mô tả yêu cầu theo `Known` / `Hypothesis` / `Unknown`. Con số chưa đo phải mang nhãn `Hypothesis` kèm cách kiểm chứng — đừng biến giả thuyết thành fact.
2. Không bịa nội dung pháp luật, số hiệu, ngày hiệu lực, quan hệ sửa đổi, URL nguồn hay checksum. Thiếu bằng chứng thì trả `unknown`.
3. Dữ liệu test phải mang chữ `synthetic` trong tên và không được xuất hiện trên đường chạy production.
4. Giữ ranh giới module: domain không import framework/database/crawler; adapter phụ thuộc vào port, không ngược lại.
5. Thay đổi nhỏ, có test cho invariant và boundary. Viết test trước khi tuyên bố hành vi đúng.
6. Chạy `pnpm check` trước khi gửi review. Không xoá test để làm gate xanh.

PR nên trả lời ngắn gọn:

- Invariant nào thay đổi?
- Bằng chứng nào chứng minh hành vi mới?
- Có claim nào chưa kiểm chứng không?
- Cách rollback là gì?

Với ingest: chỉ thêm nguồn chính thức, luôn tuân thủ `robots.txt` và rate limit, không bao giờ vượt CAPTCHA, và không để máy tự đặt `verified`.
