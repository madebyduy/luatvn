# Manual verified dataset

Giai đoạn P sẽ đặt dataset đã human-review tại đây ở máy vận hành. File JSON bị `.gitignore` mặc định để tránh commit nhầm dữ liệu chưa duyệt.

Điều kiện nhận một record:

- URL nguồn chính thức;
- SHA-256 evidence;
- retrieved time;
- stable provision ID và version ID;
- valid/system interval;
- review status;
- dataset release ID;
- với amendment: source, target, effective date và evidence chỉ đúng điều/khoản.

Không copy fixture synthetic từ `tests/` vào đây. Không tạo dữ liệu “trông giống luật” để làm UI đẹp.
