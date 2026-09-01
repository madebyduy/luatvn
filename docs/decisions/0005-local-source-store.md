# ADR-0005: Lưu trữ file nguồn cục bộ, chỉ commit manifest

- Status: Accepted
- Date: 2026-09-01
- Source: Quyết định chủ dự án 2026-09-01; số liệu đo tại P-015 ING-006

## Context

Khảo sát 2026-09-01 trên sitemap index của vbpl.vn: **172.117** URL văn bản. Payload text đo trên 8 mẫu: trung bình **58 KB**, tối đa 66 KB. Suy ra bản sao text toàn corpus khoảng **10 GB** (`Hypothesis`, cần đo lại với mẫu lớn hơn). File PDF gốc nằm sau reCAPTCHA nên không thuộc phạm vi crawler (ADR-0004).

Git LFS không phù hợp ở quy mô này: 172k object nhỏ làm chậm mọi thao tác git và tốn băng thông mỗi lần clone.

## Decision

File nguồn (payload đã tải và PDF tải tay) nằm trên đĩa máy vận hành dưới `data/manual/sources/`, **không commit vào git**. Chỉ commit `data/manual/sources-manifest.json` gồm đường dẫn tương đối, SHA-256 và kích thước từng file.

Hệ quả bắt buộc:

- Manifest là hợp đồng kiểm tra toàn vẹn: `pnpm dataset sources --verify` phải báo file thiếu, file lệch hash và file chưa đăng ký.
- Người vận hành tự sao lưu `data/manual/sources/` theo lịch của mình; manifest cho phép kiểm chứng bản sao lưu.
- Evidence trong dataset vẫn trỏ URL chính thức + SHA-256, nên release đã publish không phụ thuộc vào việc file nguồn còn nằm trên máy nào.
- Bỏ Git LFS cho `data/manual/sources/**`: file ở đó không còn được commit.

## Consequences

- Chi phí lưu trữ bằng 0, không thêm credential hay dependency; đổi lại kỷ luật sao lưu là thủ công và thuộc trách nhiệm người vận hành.
- Khi corpus vượt sức chứa đĩa cục bộ hoặc cần chia sẻ nhiều máy, phải có ADR mới chọn object storage; quyết định này không khoá đường đó.
- Phạm vi cào trước mắt (quyết định cùng ngày): **5-10 chuỗi sửa đổi**, không mirror toàn corpus.
