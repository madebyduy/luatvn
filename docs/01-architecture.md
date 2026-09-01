# Kiến trúc

## Hình thái

LuatVN là **modular monolith**. Một repository và một release train có thể tạo nhiều process role (`api`, `mcp`, `worker`, `web`) nhưng business module gọi nhau qua interface/hàm nội bộ, không qua HTTP/gRPC.

```text
REST / MCP / Web
       |
application use cases + output contracts
       |
domain invariants (identity, time, diff, citation)
       |
ports
       |
manual dataset adapter (P) -> PostgreSQL adapter (sau BUILD)
```

## Luật phụ thuộc

| Tầng        | Được phụ thuộc vào       | Không được phụ thuộc vào                  |
| ----------- | ------------------------ | ----------------------------------------- |
| domain      | thư viện chuẩn           | framework, database, MCP, crawler, search |
| application | domain, port             | Fastify, PostgreSQL driver, UI            |
| contracts   | schema runtime thuần     | repository/hạ tầng                        |
| adapter     | application port, domain | transport                                 |
| transport   | application, contracts   | SQL trực tiếp, logic hiệu lực riêng       |

## Source-of-truth layers

1. Evidence store bất biến: file gốc + SHA-256 + URL + retrieved time.
2. Canonical store có phiên bản: metadata, provision version, effectivity, relation, release.
3. Projection có thể xóa/tái tạo: search/cache/read model.

Giai đoạn P dùng dataset nhập tay như một adapter tạm thời nhưng vẫn phải đáp ứng cùng domain contract. Dataset synthetic chỉ được tồn tại dưới `tests/`.

## Bitemporal resolution

Mọi truy vấn point-in-time phải có:

- `validAt`: thời điểm pháp lý cần hỏi;
- `knownAt`: thời điểm hệ thống biết;
- `releaseId`: snapshot dữ liệu cần tái hiện.

Không có đúng một version verified phù hợp thì kết quả là `unknown` hoặc `conflict`, không chọn gần nhất.

## Public boundary

- Schema từ chối unknown field.
- Legal content nằm trong field riêng, đánh dấu `untrustedContent: true`.
- Response pháp lý mang release/version/evidence.
- Không public staging, raw logs hoặc stack trace.
- Pagination, max depth/bytes và deadline là bắt buộc khi endpoint mở rộng.

## Hướng mở rộng

- Sau BUILD: PostgreSQL bitemporal + immutable evidence + published release + outbox.
- Search luôn là adapter/projection; không đưa ranking vào domain.
- Worker có thể tách process/host nhưng vẫn dùng cùng code và contract.
- Bất kỳ đề xuất microservices nào cần ADR mới và số liệu bottleneck.
