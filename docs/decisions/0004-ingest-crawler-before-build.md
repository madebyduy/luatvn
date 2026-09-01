# ADR-0004: Đưa ingest/crawler tự động vào trước BUILD

- Status: Accepted
- Date: 2026-09-01
- Source: Quyết định chủ dự án 2026-09-01 ("đưa luôn crawler vào"); SR-003; ADR-0002

## Decision

Xây pipeline ingest tự động (fetch → evidence → bóc nháp → hàng đợi review) ngay sau P-010, thay vì đợi quyết định BUILD ở P-050. Pipeline là adapter bao quanh validate/publish hiện có; con người vẫn là người duyệt cuối cùng.

Ràng buộc bắt buộc:

- Fetcher chỉ cào host đã đăng ký tại SR-003; tuân thủ robots.txt, rate limit theo host và User-Agent định danh dự án.
- Mọi file tải về ghi đủ evidence: URL chính thức, SHA-256, `retrievedAt`.
- Record do máy tạo vào staging với `reviewStatus` tối đa là `under_review`; chỉ người review mới được nâng lên `verified`. Máy không bao giờ tự đặt `verified`.
- Invariant sẵn có giữ nguyên: nội dung chưa `verified` không bao giờ được trả như luật có hiệu lực (resolver trả `unknown`).
- Cấm vượt CAPTCHA/chống bot. Quan sát 2026-09-01: tab "Văn bản gốc"/"Tải về" của vbpl.vn dùng reCAPTCHA, nên file gốc PDF nằm ngoài phạm vi crawler và chỉ được tải thủ công.
- Bài test 6 task (P-050) vẫn chấm trên corpus đã `verified`.

## Consequences

- Sửa một phần ADR-0002: bỏ ràng buộc "không xây crawler trên đường găng". Các phần khác của ADR-0002 giữ nguyên (chưa RAG, TTHC, production hosting; deadline giữ bằng cắt phạm vi).
- Thêm phase `P-015` vào registry; P-020/P-030 vẫn cần chuỗi sửa đổi đã `verified` làm đầu vào.
- Rủi ro mới phải quản lý trong P-015: chất lượng bóc tách, cấu trúc site thay đổi, chi phí review khi corpus lớn; đối phó bằng review bắt buộc + validation máy + sampling.
- Lưu trữ hàng chục nghìn file gốc vượt khả năng Git LFS thông thường; quyết định lưu trữ ở scale là entry criterion riêng (ING-006), không tự chọn.
