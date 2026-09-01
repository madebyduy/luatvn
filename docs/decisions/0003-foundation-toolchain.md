# ADR-0003: Foundation toolchain

- Status: Accepted
- Date: 2026-08-31

## Context

SR-001 đề xuất TypeScript + Node.js 24 LTS + Fastify + JSON Schema. Toolchain phải chạy được trong workspace hiện tại và hỗ trợ MCP SDK v2 sau này.

## Decision

- Node.js 24 LTS, pnpm 11 workspace.
- TypeScript 6.0.3 strict/composite để tương thích MCP SDK v2 và tránh nhận major compiler vừa phát hành mà chưa cần thiết.
- Fastify 5.12.1 cho REST transport.
- Zod 4.4.1 làm runtime contract; adapter Fastify chuyển schema, MCP sẽ dùng cùng schema.
- Vitest 4.1.11, Oxlint 1.80.0, Prettier 3.9.6.
- Pin exact version; lockfile là bằng chứng dependency graph.

## Consequences

- Upgrade dependency là thay đổi có review, không dùng `latest` hoặc range trôi.
- Domain không phụ thuộc bất kỳ package transport/schema nào.
- Nếu Zod-to-JSON-Schema không đáp ứng OpenAPI/MCP conformance, đổi adapter contract qua ADR, không đổi domain.
