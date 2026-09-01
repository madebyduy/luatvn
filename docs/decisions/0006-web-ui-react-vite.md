# ADR-0006: React + Vite cho web transport, cam kết WCAG 2.1 AA và mobile

- Status: Accepted
- Date: 2026-09-01
- Source: Quyết định chủ dự án 2026-09-01; P-020 entry criteria

## Context

P-020 yêu cầu ghi lại lựa chọn nền tảng UI kèm hệ quả dependency và rollback trước khi code. Hai phương án được đặt lên bàn: HTML render từ server bằng Fastify sẵn có (0 dependency mới, không build step), hoặc SPA React + Vite.

## Decision

Chủ dự án chọn **React 19 + Vite** cho `apps/web`, và đặt mức cam kết giao diện là **WCAG 2.1 AA đầy đủ, có hỗ trợ mobile**.

Ràng buộc kèm theo:

- Web là một transport, không phải nơi chứa logic pháp lý. Nó chỉ tiêu thụ contract công khai của REST API; mọi quy tắc thời gian, citation và trạng thái hiệu lực nằm ở application/domain và không được sao chép sang UI.
- SPA gọi API qua HTTP. Đây là client gọi ranh giới công khai, không phải module gọi module, nên không vi phạm quy tắc modular monolith tại AGENTS §3.
- Nội dung pháp luật luôn được render như text thuần. Không `dangerouslySetInnerHTML`, không thực thi nội dung trả về, đúng nguyên tắc `untrustedContent`.
- UI không được biến `unknown` hay `conflict` thành một câu trả lời trông như đã xác định. Ba trạng thái phải phân biệt được bằng mắt và bằng screen reader.

## Consequences

- Thêm dependency runtime: `react`, `react-dom`. Thêm dev dependency: `vite`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `axe-core`. Toàn bộ pin phiên bản chính xác như các package hiện có.
- Có thêm một build step và một cây dependency lớn hơn đáng kể so với phương án server-render. Đây là chi phí được chấp nhận có ý thức để đổi lấy trải nghiệm tương tác và hệ sinh thái quen thuộc.
- Cam kết WCAG 2.1 AA làm tăng khối lượng: cần landmark ngữ nghĩa, nhãn cho mọi control, thông báo `aria-live` khi kết quả đổi, focus nhìn thấy rõ, tỉ lệ tương phản đạt chuẩn và bố cục dùng được trên màn hình hẹp.
- Kiểm chứng accessibility bằng `axe-core` chạy trong test. Cần nói rõ giới hạn: axe trong jsdom **không kiểm được tương phản màu** vì không có layout thật; tỉ lệ tương phản phải tính riêng và ghi lại trong hồ sơ phase.
- Rollback: `apps/web` là một thư mục tách rời và không có module nào phụ thuộc vào nó. Bỏ UI nghĩa là xóa thư mục cùng các dependency ở trên; API, domain và dataset không đổi một dòng.
