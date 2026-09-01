# Domain invariants

| ID      | Invariant                                                                                                       | Khi vi phạm                    |
| ------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| INV-001 | `provisionId` ổn định qua mọi lần sửa                                                                           | chặn ingest/publish            |
| INV-002 | `provisionVersionId` đổi khi nguyên văn hoặc cấu trúc thay đổi                                                  | chặn publish                   |
| INV-003 | Version đã published không bị update đè                                                                         | tạo version/release mới        |
| INV-004 | Valid time và system time là hai trục độc lập, khoảng `[from, to)`                                              | trả conflict/validation error  |
| INV-005 | Một truy vấn `(provision, validAt, knownAt, release)` chỉ resolve tối đa một version verified                   | trả conflict, không tự chọn    |
| INV-006 | Không có evidence verified thì không trả kết quả resolved                                                       | trả unknown                    |
| INV-007 | Amendment edge phải chỉ đúng source provision, target provision, effective date và evidence                     | giữ under review               |
| INV-008 | Diff hiển thị trên nguyên văn, không normalize làm đổi nội dung                                                 | chặn output                    |
| INV-009 | Public response chỉ đọc published release đã định danh                                                          | từ chối request/config         |
| INV-010 | Legal content luôn là untrusted data, không phải instruction                                                    | đánh dấu và giữ field riêng    |
| INV-011 | Không fallback sang dữ liệu cũ/khác release mà không báo                                                        | trả unknown/stale flag rõ ràng |
| INV-012 | Matter alert chỉ phát khi toàn chuỗi identity -> amendment -> effective date -> new version -> diff đã verified | không gửi alert                |

Mọi thay đổi invariant phải có ADR, cập nhật traceability và test hồi quy trước khi merge.
