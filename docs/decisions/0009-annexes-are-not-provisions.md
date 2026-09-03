# ADR-0009: Phụ lục bị tách khỏi nguyên văn Điều, và chưa được phục vụ

- Status: Accepted
- Date: 2026-09-03
- Supersedes nothing. Bổ sung cho ADR-0004 (bóc tách) và P-018 (đối soát).

## Context

Một Thông tư thường mang theo văn bản khác trong cùng file PDF: quy chuẩn kỹ
thuật, biểu mẫu, danh mục. Trong file đó, phần này nằm **sau Điều cuối cùng**,
nên bộ bóc dán trọn nó vào Điều cuối.

Đo trên văn bản thật, Thông tư 127/2026/TT-BCA:

|                                           | ký tự  |
| ----------------------------------------- | ------ |
| Điều 4 "Điều khoản thi hành" như đang lưu | 33.335 |
| Điều 4 thật sự                            | 1.247  |
| QCVN 13:2026/BCA bị dán vào               | 32.088 |

Nghĩa là 96% "nguyên văn Điều 4" không phải Điều 4. Con số này đi thẳng vào
`legalTextSha256`, nên ai trích dẫn Điều 4 là trích dẫn cả một quy chuẩn kỹ
thuật. Phép kiểm NUMBERING bắt được vì phụ lục đánh số lại từ 1, và đó là lý do
tỉ lệ máy tự duyệt chỉ đạt 3/25 ở lượt cào đầu tiên.

## Decision

**1. Cắt phụ lục ra khỏi thân bài trước khi chia Điều.** Bốn mốc, mỗi mốc phải
chiếm trọn một dòng: quốc hiệu `CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM` xuất hiện
lại sau khi đã có Điều; `PHỤ LỤC` / `Phụ lục` đứng một mình; đầu biểu mẫu dạng
`Mẫu <mã> kèm theo`. Câu dẫn chiếu trong thân bài ("theo Phụ lục I ban hành kèm
theo Thông tư này") nằm giữa câu nên không khớp và ở lại trong Điều của nó.

**2. Từ chối cắt nếu phần cắt đi vẫn còn Điều tiếp theo.** Cắt nhầm là mất Điều
mà **không phép kiểm nào thấy được**: số Điều còn lại vẫn liên tục 1..N. Khi
gặp trường hợp đó, báo `annexCutRefused` và để người xem quyết định.

**3. Phần cắt ra được ghi nguyên văn vào `annexLines`, không vứt đi.** Nó cũng
được tính vào phép kiểm CHARACTER_BALANCE, nên không có ký tự nào biến mất mà
không ai đếm.

**4. Nội dung phụ lục hiện KHÔNG được phục vụ.** Kho chỉ trả lời ở mức Điều.

## Consequences

- Nguyên văn Điều trở nên đúng. Tỉ lệ máy tự duyệt trên cùng 25 văn bản: 3 lên 7.
- **Kho thiếu một phần luật có hiệu lực.** Quy chuẩn kỹ thuật và biểu mẫu là quy
  phạm bắt buộc, không phải phụ chú. Người hỏi "hồ sơ gồm mẫu nào" sẽ không được
  trả lời. Bytes vẫn còn trong PDF đã lưu trữ và tải được qua `/v1/sources/`,
  nhưng máy không tra cứu được.
- Việc mở phục vụ phụ lục cần một mô hình địa chỉ khác Điều/Khoản/Điểm, và cần
  chủ dự án quyết định trước - **đây là quyết định về dữ liệu pháp lý, không
  phải quyết định kỹ thuật.**
- Bốn mốc trên là quan sát từ Công báo tháng 8-9/2026. Cách trình bày khác sẽ
  lọt lưới; khi đó triệu chứng là Điều cuối phình to và NUMBERING gắn cờ, chứ
  không phải mất chữ im lặng.
