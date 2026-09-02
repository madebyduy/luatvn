# LuatVN

Bộ khung mã nguồn mở để làm việc với văn bản quy phạm pháp luật Việt Nam **theo thời điểm**: một Điều/Khoản có định danh ổn định, lịch sử phiên bản không ghi đè, quan hệ sửa đổi truy nguyên được, và bằng chứng nguồn kèm SHA-256.

> An open-source core for point-in-time Vietnamese legal texts: stable provision identity, bitemporal validity, evidence-backed citations, immutable dataset releases, and a polite ingest pipeline that never marks data verified on its own.

## Vấn đề

Tra cứu luật thường trả về "bản mới nhất". Nhưng câu hỏi thật của người hành nghề là _"điều này quy định thế nào **tại thời điểm** sự việc xảy ra?"_ — và _"ai đã sửa nó, bằng văn bản nào?"_. Trả lời được hai câu đó cần mô hình dữ liệu khác, không chỉ một ô tìm kiếm.

## Nguyên tắc thiết kế

- **Bitemporal**: mỗi truy vấn mang `validAt` (thời điểm pháp lý), `knownAt` (thời điểm hệ thống biết) và `releaseId` (ảnh chụp dữ liệu). Không đủ dữ kiện thì trả `unknown`, không đoán bản gần nhất.
- **Không bịa**: không có bằng chứng hiệu lực thì trạng thái là `unknown`, không mặc định `effective`. Không fallback từ dữ liệu đã publish sang staging hay internet.
- **Bằng chứng bắt buộc**: mọi kết quả đã resolve đều mang release ID, provision version ID, URL nguồn chính thức, SHA-256 và thời điểm thu thập — tách bạch với thời điểm kiểm tra.
- **Release bất biến**: dữ liệu công khai chỉ đọc từ release đã publish, có manifest hash; sửa dữ liệu nghĩa là phát hành release mới, có đường rollback.
- **Con người quyết định**: pipeline ingest tự động chỉ tạo bản nháp `under_review`. Chỉ người review mới nâng được lên `verified`, và thao tác đó có audit log.
- **Nội dung pháp luật là untrusted**: luôn nằm ở field riêng, luôn kèm cờ `untrustedContent` khi ra khỏi API.

## Có gì trong repo

| Package                   | Vai trò                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`         | Thuần TypeScript, không import framework: định danh có tag, ngày/instant hợp lệ, interval nửa mở, resolver bitemporal (`resolved`/`unknown`/`conflict`), diff giữ nguyên văn |
| `packages/application`    | Use case dùng chung, legal envelope, port repository có deadline/cancel                                                                                                      |
| `packages/contracts`      | Schema Zod nghiêm ngặt cho ranh giới công khai; từ chối field lạ và ngày không có thật                                                                                       |
| `packages/manual-dataset` | Schema dataset, kiểm tra provenance, kho release bất biến, publish/rollback, review gate                                                                                     |
| `packages/ingest`         | Fetcher lịch sự (robots.txt, rate limit, giới hạn kích thước), bóc tách văn bản, quan hệ sửa đổi, crawl tăng dần, kiểm chứng lại release                                     |
| `packages/pdf-text`       | Bytes PDF → dòng có toạ độ và cỡ chữ, chuẩn hoá NFC. Không biết gì về pháp luật; DOM lib của pdfjs dừng ở đây                                                                |
| `apps/api`                | Fastify factory, config fail-closed, composition root, graceful shutdown                                                                                                     |
| `apps/web`                | Ba màn hình đọc luật theo thời điểm: tra cứu, so sánh hai phiên bản, lược sử sửa đổi                                                                                         |
| `apps/mcp`                | Bốn công cụ MCP cho trợ lý AI, dùng chung use case và chính schema của REST                                                                                                  |

Kiến trúc là **modular monolith**: một codebase, một release train; domain không biết gì về Fastify, database hay crawler. Chi tiết trong [`docs/01-architecture.md`](docs/01-architecture.md) và các invariant trong [`docs/02-domain-invariants.md`](docs/02-domain-invariants.md).

## Bắt đầu

Yêu cầu Node.js 24 và pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` chạy guardrail, format, lint, build, typecheck test và toàn bộ test suite.

Chạy API trên một dataset đã publish, kèm smoke drill đầu-cuối:

```bash
pnpm smoke
```

Quy trình vận hành đầy đủ (ingest → review → publish → chạy → rollback) nằm trong [`docs/08-operator-runbook.md`](docs/08-operator-runbook.md).

## Ingest có trách nhiệm

Pipeline chỉ lấy dữ liệu từ nguồn chính thức đã đăng ký, tuân thủ `robots.txt`, giới hạn nhịp theo host, và ghi đủ URL + SHA-256 + thời điểm thu thập cho mọi thứ tải về. Nội dung sau CAPTCHA hoặc cơ chế chống bot **không bao giờ** được lấy tự động — xem [`docs/decisions/0004-ingest-crawler-before-build.md`](docs/decisions/0004-ingest-crawler-before-build.md).

Với nguồn công báo, nguyên văn nằm trong file PDF ký số chứ không nằm trong HTML (trang web vẽ chữ từ PDF lúc xem). Bộ bóc đọc thẳng lớp text của PDF, và **từ chối thay vì đoán** trong bốn trường hợp: công báo bỏ trống ngày hiệu lực (thường gặp ở văn bản hợp nhất, vốn không có hiệu lực riêng), số Điều không liên tục (nghĩa là mất Điều hoặc nhận nhầm chú thích), PDF không có lớp text, và trang nguồn đổi cấu trúc.

## Kiểm chứng được, không phải tin lời hứa

```bash
pnpm dataset verify
```

Lệnh này **dựng lại nguyên văn từ chính bytes nguồn đã lưu** rồi so hash. Hash không thôi thì giả được — sửa nguyên văn rồi vá lại mọi digest. Suy dẫn thì không: văn bản đã sửa sẽ không còn dựng ra được từ nguồn của nó. Nó cũng đòi mỗi bản ghi `verified` phải có tên người duyệt và thời điểm duyệt.

Ba trạng thái được phân biệt rõ, không gộp: *chưa có bản sao cục bộ* (chưa kiểm được) / *có và khớp* / *có nhưng sai hash* (đã bị sửa).

Giới hạn phải nói rõ: nó chứng minh **nguyên văn suy ra được từ nguồn đã lưu và có người chịu trách nhiệm**. Nó *không* chứng minh bản thân nguồn nói đúng luật — việc đó vẫn phải mở URL nguồn chính thức trong evidence để đối chiếu.

Bytes nguồn nằm trong kho dùng chung, đặt tên bằng chính SHA-256 của nội dung, nên một văn bản tải một lần được lưu một lần dù bao nhiêu release trỏ tới.

## Trạng thái trung thực

- **Đã có và có test**: mô hình domain, contract công khai, dataset/release store, review workflow, pipeline ingest (HTML và PDF ký số), lớp kiểm chứng, REST API, giao diện web, transport MCP. `pnpm check` xanh.
- **Chưa có**: PostgreSQL adapter, RAG, hosting production, OCR cho PDF scan.
- **Chưa nghiệm thu**: chưa có corpus đã `verified` nào, nên phần diff/lược sử/MCP mới chỉ chạy trên dữ liệu diễn tập. Bộ bóc PDF mới đo trên 5 văn bản thật — chưa đủ để tuyên bố khái quát.
- **Không kèm dữ liệu pháp luật**: repo này không chứa corpus. Mọi fixture test đều `synthetic` và bị guardrail chặn khỏi đường chạy production.
- Đây là mã nguồn tham chiếu, **không phải tư vấn pháp lý**, và không cam kết độ chính xác của bất kỳ dữ liệu nào bạn nạp vào.

## Không có trong repo này

Một số tài liệu nội bộ được giữ riêng: charter sản phẩm, roadmap có điều kiện, hồ sơ phase/nghiệm thu, ma trận truy vết, quy tắc vận hành AI, và tài liệu kiến trúc gốc. Vì vậy vài tham chiếu trong `docs/` (ví dụ tới `AGENTS.md`, `SR-001`, `SR-003`, `ADR-0002` hay `docs/phases/`) sẽ không mở được ở đây — nội dung kỹ thuật cần thiết đã nằm trong các file `docs/` kèm theo.

## Giấy phép

[MIT](LICENSE).
