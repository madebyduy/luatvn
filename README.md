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
| `packages/ingest`         | Fetcher lịch sự (robots.txt, rate limit, giới hạn kích thước), bóc tách văn bản, quan hệ sửa đổi, crawl tăng dần                                                             |
| `apps/api`                | Fastify factory, config fail-closed, composition root, graceful shutdown                                                                                                     |

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

## Trạng thái trung thực

- **Đã có và có test**: mô hình domain, contract công khai, dataset/release store, review workflow, pipeline ingest, REST API chạy được. `pnpm check` xanh.
- **Chưa có**: UI Time Machine, MCP transport, PostgreSQL adapter, RAG, hosting production.
- **Không kèm dữ liệu pháp luật**: repo này không chứa corpus. Mọi fixture test đều `synthetic` và bị guardrail chặn khỏi đường chạy production.
- Đây là mã nguồn tham chiếu, **không phải tư vấn pháp lý**, và không cam kết độ chính xác của bất kỳ dữ liệu nào bạn nạp vào.

## Không có trong repo này

Một số tài liệu nội bộ được giữ riêng: charter sản phẩm, roadmap có điều kiện, hồ sơ phase/nghiệm thu, ma trận truy vết, quy tắc vận hành AI, và tài liệu kiến trúc gốc. Vì vậy vài tham chiếu trong `docs/` (ví dụ tới `AGENTS.md`, `SR-001`, `SR-003`, `ADR-0002` hay `docs/phases/`) sẽ không mở được ở đây — nội dung kỹ thuật cần thiết đã nằm trong các file `docs/` kèm theo.

## Giấy phép

[MIT](LICENSE).
