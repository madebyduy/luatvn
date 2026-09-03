# ADR-0008: Chín quyết định của chủ dự án, 2026-09-03

- Status: Accepted
- Date: 2026-09-03
- Source: Quyết định chủ dự án 2026-09-03, trả lời trực tiếp các mục còn treo tại ADR-0007, P-025, P-040, UX-100, UX-130, UX-140

## Context

Chín quyết định đã treo qua nhiều phase, mỗi cái chặn một phần việc. Chủ dự án chốt tất cả trong một lượt. Ghi lại nguyên văn lựa chọn, kèm hệ quả kỹ thuật bắt buộc đi theo, để sau này không phải đoán lại ý.

## Decision

| Mã                    | Quyết định                                     | Hệ quả bắt buộc                                                                                 |
| --------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **VER-005**           | **Cho** người ngoài tải bytes nguồn đã lưu trữ | Mở đường đọc kho theo hash trên API công khai. Đây là thứ biến "tin lời tôi" thành "tự kiểm đi" |
| **VER-006**           | **Chưa cần** ký số bản phát hành               | Giữ nguyên hash + manifest. Mở lại khi có bên thứ hai phát hành release                         |
| **STO-001**           | **Cần** sao lưu kho nguồn                      | Phải có lệnh sao lưu kiểm chứng được; kho không nằm trong git nên mất là mất hẳn                |
| **STO-002**           | **Không** mở remote git thứ hai                | Rủi ro chấp nhận: `luatvn-private` là bản duy nhất ngoài máy                                    |
| **STO-003**           | **Không** dùng object storage                  | Kho ở lại đĩa. Ngưỡng 1 GB (~1.200 văn bản) vẫn phải theo dõi; tới đó mở lại quyết định này     |
| **MCP-006**           | **Không** mở MCP ra mạng                       | Chỉ stdio cục bộ. Không có listener, không có lớp xác thực, không có bề mặt tấn công            |
| **UX-130 AM-003/004** | Hồ sơ người dùng **lưu trên máy họ**           | Không có tài khoản, không có server giữ dữ liệu nhạy cảm. Đổi máy là mất hồ sơ - chấp nhận      |
| **UX-100 tầng 1**     | **Chưa rõ**                                    | Tầng 1 (LLM soạn tóm tắt) **không làm**. Tầng 0 không cần LLM và đã chạy                        |
| **UX-140 CD-002**     | **Chưa làm** bản án                            | Nguồn bản án vẫn không đăng ký (SR-008). Fetcher tiếp tục từ chối                               |

Và một chỉ đạo về nhịp làm việc: **cào dần, lưu dần**, không chờ đủ mới bắt đầu.

## Consequences

- VER-005 là quyết định mạnh nhất trong nhóm: nó biến bản phát hành thành thứ người ngoài kiểm chứng độc lập được, không cần tin máy chủ. Đổi lại, kho nguồn trở thành dữ liệu công khai, nên dung lượng phục vụ và băng thông là chi phí thật khi corpus lớn.
- STO-002 + STO-003 cùng "không" nghĩa là **toàn bộ trứng nằm hai giỏ**: đĩa máy này và `luatvn-private`. Bản phát hành thì an toàn (nằm trong git, đi theo mọi bản clone), nhưng **kho nguồn thô chỉ có trên đĩa** - đó chính là lý do STO-001 được chọn "cần" và phải làm ngay.
- MCP-006 "không" giữ bề mặt tấn công bằng không, đổi lấy việc trợ lý AI của người khác chưa dùng được kho này từ xa.
- UX-100 tầng 1 "chưa rõ" được diễn giải là **chưa làm**, không phải "làm tạm rồi tính". Không viết code cho nó.
