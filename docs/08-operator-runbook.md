# Operator runbook - manual dataset và solo runtime

Runbook cho một operator mới: nhập liệu, kiểm tra, publish, chạy, smoke và rollback mà không cần bước ngoài tài liệu. Nguồn văn bản, người review và nơi lưu trữ được quy định tại SR-003 trong [`docs/06-source-register.md`](./06-source-register.md).

## 0. Chuẩn bị (terminal mới)

```bash
pnpm install
pnpm check
```

Cả hai lệnh phải exit 0 trước khi thao tác dữ liệu.

## 1. Ingest - nhập dữ liệu đã kiểm chứng

1. Tải văn bản gốc (PDF/HTML) từ nguồn chính thức đã đăng ký (SR-003). Lưu vào `data/manual/sources/` trên máy vận hành rồi chạy `pnpm dataset sources` để cập nhật manifest (ADR-0005: file nguồn không vào git).
2. Soạn file staging JSON (đặt ngoài `data/manual/releases/`, ví dụ `data/manual/staging-rel-xxx.json` - file JSON ở cấp này được `.gitignore`). Cấu trúc bắt buộc (xem schema trong `packages/manual-dataset/src/dataset-schema.ts`):
   - `schemaVersion`: 1;
   - `datasetReleaseId`: ID mới dạng `rel_...`, không trùng release cũ;
   - `provisionVersions[]`: mỗi record có provision/version ID ổn định, `legalText` đúng nguyên văn, `legalTextSha256`, interval `validTime`/`systemTime` nửa mở, `reviewStatus: "verified"` chỉ sau khi người review đối chiếu lại nguồn, và `evidence[]` với URL nguồn chính thức + SHA-256 + `retrievedAt`;
   - `amendments[]`: quan hệ sửa đổi có evidence, target phải nằm trong release.
3. Người review (SR-003) đối chiếu từng record với văn bản gốc theo hai bước nhập - đối chiếu trước khi đặt `verified`.

## 2. Validate - kiểm tra trước publish

```bash
pnpm dataset validate data/manual/staging-rel-xxx.json
```

Lệnh in báo cáo lỗi theo từng record (locator + lý do). Chỉ tiếp tục khi in `validation passed`.

## 3. Publish - phát hành release bất biến

```bash
pnpm dataset publish data/manual/staging-rel-xxx.json --reviewed-by "Ho ten nguoi review"
```

- Ghi `data/manual/releases/<rel_id>/dataset.json` + `manifest.json` (SHA-256 từng file, review state, người review).
- Cập nhật con trỏ `data/manual/published.json` (atomic, giữ lịch sử để rollback).
- Release đã tồn tại thì bị từ chối (`RELEASE_ALREADY_EXISTS`) - sửa dữ liệu là phát hành release ID mới, không sửa release cũ.

Kiểm tra trạng thái bất kỳ lúc nào:

```bash
pnpm dataset status
```

## 4. Run - chạy API

```bash
pnpm dev
```

(`pnpm start` nếu đã build). Cấu hình qua biến môi trường, sai giá trị thì process từ chối khởi động:

| Biến                           | Mặc định      |
| ------------------------------ | ------------- |
| `LUATVN_DATA_DIR`              | `data/manual` |
| `LUATVN_HOST`                  | `127.0.0.1`   |
| `LUATVN_PORT` (0 = tự chọn)    | `3000`        |
| `LUATVN_OPERATION_TIMEOUT_MS`  | `10000`       |
| `LUATVN_SHUTDOWN_TIMEOUT_MS`   | `10000`       |
| `LUATVN_SOURCE_HOST_ALLOWLIST` | (không đặt)   |

`LUATVN_SOURCE_HOST_ALLOWLIST` chỉ dành cho drill/test: thay thế danh sách host nguồn đã đăng ký (SR-003) khi load release. Không đặt biến này khi chạy dữ liệu thật; khi đặt, server in event `source_host_allowlist_active` để việc override luôn quan sát được.

Khởi động thành công in dòng JSON `{"event":"listening",...}`. Readiness: `GET /ready` trả release ID đang phục vụ; `GET /health` trả `{"status":"ok"}`. Log không chứa nội dung pháp luật hay PII.

Dừng server: `Ctrl+C` (SIGINT) - server đóng listener rồi thoát mã 0; quá `LUATVN_SHUTDOWN_TIMEOUT_MS` thì thoát cưỡng bức mã 1.

## 1b. Ingest tự động (P-015, ADR-0004)

Máy làm phần cơ khí, người vẫn là người duyệt cuối. Luồng đầy đủ:

```bash
pnpm ingest draft "https://vbpl.vn/van-ban/chi-tiet/<slug--id>" --release rel_xxx --out data/manual/staging-rel-xxx.json
```

Tải payload nội dung của trang chi tiết (lưu kèm evidence vào `data/manual/sources/incoming/`), bóc từng Điều thành staging draft: mọi record `under_review`, ngày hiệu lực lấy từ metadata nguồn (thiếu thì máy từ chối tạo, không bịa).

Thêm `--with-amendments` để dựng cả chuỗi sửa đổi: máy đọc tab Lược đồ, tải luôn văn bản bị sửa/bị thay thế vào cùng release, rồi nối quan hệ tới đúng Điều được nêu trong tiêu đề (`Điều 1. Sửa đổi, bổ sung khoản 1 Điều 2` → Điều 2 của văn bản đích). Điều nào không nêu Điều đích, hoặc Điều đích không tồn tại, sẽ được báo `not linked` để người review xử lý — máy không đoán.

```bash
pnpm ingest draft "https://vbpl.vn/van-ban/chi-tiet/<slug--id>" --release rel_xxx --out data/manual/staging-rel-xxx.json --with-amendments
```

```bash
pnpm dataset review data/manual/staging-rel-xxx.json
```

Liệt kê record và trạng thái review. Người review đối chiếu từng Điều với nguồn rồi duyệt từng record:

```bash
pnpm dataset promote data/manual/staging-rel-xxx.json --version pv_vbpl_xxx --reviewed-by "Ho ten"
```

`promote` là con đường duy nhất nâng record lên `verified` và ghi audit vào `<staging>.review-log.json`. Khi mọi record đã `verified` thì validate + publish như mục 2-3. Draft chưa promote không thể publish.

Cào tăng dần theo sitemap (khám phá + phát hiện thay đổi qua `lastmod`, không tải lại văn bản chưa đổi):

```bash
pnpm ingest crawl --seeds "https://vbpl.vn/sitemap/1.xml" --pattern "/van-ban/chi-tiet/" --state data/manual/crawl-state.json --out data/manual/sources/incoming --max 20
```

- Fetcher luôn tuân thủ robots.txt, rate limit theo host (mặc định 2s/request) và chỉ chấp nhận host đã đăng ký SR-003; `--allow-hosts` chỉ dành cho drill/test.
- `pnpm ingest fetch <url>` vẫn dùng được để tải một file đơn lẻ (PDF/HTML) kèm evidence.
- Lưu ý: `Next-Action` id của vbpl.vn đổi khi site redeploy; nếu `draft` trả lỗi METADATA_NOT_FOUND, lấy id mới và truyền `--content-action` (và `--relations-action` cho tab Lược đồ).
- **File gốc (PDF) không được cào tự động**: tab "Văn bản gốc"/"Tải về" của vbpl.vn có reCAPTCHA. Người vận hành tự mở trình duyệt tải file gốc về `data/manual/sources/<release>/` rồi ghi SHA-256 vào evidence. Đây là ranh giới cứng trong AGENTS.md và ADR-0004, không được lách.

## 5. Smoke - kiểm tra đầu-cuối tự động

```bash
pnpm smoke
```

Drill tự động: publish một release placeholder (không phải nội dung pháp luật) vào thư mục tạm dưới `tmp/`, chạy server thật, kiểm tra health/ready/truy vấn/không-fallback/lỗi ngày sai, tắt graceful và xác nhận release không bị ghi đè. Kết thúc phải in `SMOKE PASSED`.

## 6. Rollback - khôi phục release trước

```bash
pnpm dataset rollback
```

- Kiểm tra toàn vẹn release trước (hash + schema + provenance) rồi mới trỏ lại; release hỏng thì rollback bị từ chối và con trỏ giữ nguyên.
- Sau rollback, khởi động lại server để phục vụ release cũ. Release lỗi vẫn nằm nguyên trên đĩa để điều tra - không xóa, không sửa.

## Sự cố thường gặp

| Triệu chứng khi start        | Nguyên nhân / xử lý                                                               |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `POINTER_MISSING`            | Chưa publish release nào - làm bước 2-3.                                          |
| `RELEASE_FILE_HASH_MISMATCH` | File release bị sửa tay - release là bất biến; rollback hoặc publish release mới. |
| `RELEASE_NOT_REVIEWED`       | Manifest không ở trạng thái `verified` - dữ liệu chưa được người review xác nhận. |
| `RELEASE_VALIDATION_FAILED`  | Record thiếu provenance/sai hash/host lạ - xem locator trong log, sửa ở staging.  |
| `INVALID_RUNTIME_CONFIG`     | Biến môi trường sai - xem danh sách issues trong log.                             |

## Sao lưu (ADR-0005)

File nguồn nằm trên đĩa máy vận hành tại `data/manual/sources/` và **không vào git**; chỉ manifest toàn vẹn được commit:

```bash
pnpm dataset sources
```

Ghi `data/manual/sources-manifest.json` (đường dẫn + SHA-256 + kích thước từng file). Chạy lại mỗi khi thêm file nguồn và commit manifest.

```bash
pnpm dataset sources --verify
```

Đối chiếu thư mục nguồn với manifest đã commit: báo file thiếu, file lệch hash, file chưa đăng ký, và thoát mã 1 nếu có sai lệch. Dùng lệnh này để kiểm chứng bản sao lưu sau khi khôi phục.

- Người vận hành tự sao lưu `data/manual/sources/` (ổ ngoài/cloud drive) theo lịch của mình; manifest là cách kiểm chứng bản sao đó.
- `data/manual/releases/` là dữ liệu phát hành bất biến - đưa vào backup định kỳ cùng `published.json`.
