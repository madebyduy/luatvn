# Quality gates

## Gate cục bộ bắt buộc

`pnpm check` phải pass và bao gồm:

1. Guardrails: cấm pattern làm suy yếu type safety, cấm legal fixture ngoài `tests/`, kiểm tra tài liệu bắt buộc.
2. Format check: output xác định.
3. Lint: correctness/suspicious là error, warning cũng làm gate fail.
4. Build: TypeScript strict/composite.
5. Test typecheck.
6. Unit/contract tests.

## Gate theo mức rủi ro

| Loại thay đổi      | Bằng chứng thêm                                                                 |
| ------------------ | ------------------------------------------------------------------------------- |
| domain invariant   | unit + property/boundary cases + ADR nếu đổi nghĩa                              |
| REST/MCP contract  | schema validation, unknown field rejection, response snapshot không chứa secret |
| database/migration | chạy trên PostgreSQL sạch, upgrade fixture, rollback/restore path               |
| legal dataset      | provenance, SHA-256, human review, temporal fixture                             |
| security control   | threat ID, test abuse/failure, cách tắt/rollback                                |
| performance claim  | benchmark reproducible, dataset và hardware                                     |

## Coverage policy

Không đặt phần trăm coverage giả tạo ở Foundation Slice 0. Trước BUILD phải đo baseline, sau đó đặt ngưỡng theo vùng rủi ro: resolver/diff/citation cao hơn code ghép transport. Mutation testing là ứng viên sau khi domain ổn định.

## Gate chưa thể tự động trong repository hiện tại

- branch protection trên remote;
- secret scanning/SBOM/CVE trên CI;
- PostgreSQL migration/restore drill;
- 5 chuỗi sửa đổi thật được human review;
- MCP conformance 2026-07-28.

Các gate này không được tuyên bố pass cho đến khi có artifact chứng minh.
