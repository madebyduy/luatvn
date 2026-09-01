# ADR-0001: Modular monolith

- Status: Accepted
- Date: 2026-08-31
- Source: SR-001 v2.1 §03A

## Decision

Một monorepo, một release train, module gọi qua application/domain interface. API, MCP, web và worker có thể là process/container riêng nhưng không trở thành business microservice.

## Consequences

- Không database-per-service, service discovery hoặc distributed transaction.
- Scale worker/API theo process role trước khi cân nhắc đổi hình thái.
- Mọi đề xuất microservices cần ADR mới và số liệu bottleneck/SLO.
