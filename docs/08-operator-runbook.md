# Operator runbook - manual dataset và solo runtime

Runbook cho một operator mới: nhập liệu, kiểm tra, publish, chạy, smoke và rollback mà không cần bước ngoài tài liệu. Nguồn văn bản, người review và nơi lưu trữ được quy định tại SR-003 trong sổ đăng ký nguồn của dự án.

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

`promote` là con đường duy nhất nâng record lên `verified` và ghi audit vào `<staging>.review-log.json`. Khi publish, file audit này **được đóng gói vào release**, còn bytes nguồn vào kho chung `data/manual/archive/` theo hash, để người ngoài kiểm chứng được (mục 4b). Khi mọi record đã `verified` thì validate + publish như mục 2-3. Draft chưa promote không thể publish.

Cào tăng dần theo sitemap (khám phá + phát hiện thay đổi qua `lastmod`, không tải lại văn bản chưa đổi):

```bash
pnpm ingest crawl --seeds "https://vbpl.vn/sitemap/1.xml" --pattern "/van-ban/chi-tiet/" --state data/manual/crawl-state.json --out data/manual/sources/incoming --max 20
```

- Fetcher luôn tuân thủ robots.txt, rate limit theo host (mặc định 2s/request) và chỉ chấp nhận host đã đăng ký SR-003; `--allow-hosts` chỉ dành cho drill/test.
- `pnpm ingest fetch <url>` vẫn dùng được để tải một file đơn lẻ (PDF/HTML) kèm evidence.
- Lưu ý: `Next-Action` id của vbpl.vn đổi khi site redeploy; nếu `draft` trả lỗi METADATA_NOT_FOUND, lấy id mới và truyền `--content-action` (và `--relations-action` cho tab Lược đồ).
- **File gốc (PDF) không được cào tự động**: tab "Văn bản gốc"/"Tải về" của vbpl.vn có reCAPTCHA. Người vận hành tự mở trình duyệt tải file gốc về `data/manual/sources/<release>/` rồi ghi SHA-256 vào evidence. Đây là ranh giới cứng ghi tại [ADR-0004](./decisions/0004-ingest-crawler-before-build.md), không được lách.

## 1c. Ingest từ Công báo qua PDF ký số (P-017)

Dùng khi nguồn là congbao.chinhphu.vn. Khác với vbpl.vn: trang chi tiết **không chứa nguyên văn**, nó chỉ trỏ tới file PDF ký số (SR-005). Máy tải PDF đó rồi bóc text từ lớp text của file.

```bash
pnpm ingest congbao "https://congbao.chinhphu.vn/van-ban/<slug>-<id>.htm" --release rel_xxx --out data/manual/staging-rel-xxx.json
```

Kết quả in ra: số Điều bóc được kèm dải số, tổng ký tự nguyên văn, ngày hiệu lực lấy từ Công báo, tên file PDF đã lưu kèm SHA-256, và **danh sách dòng không thuộc Điều nào**. Dòng cuối cùng đó phải đọc: thường là tiêu đề Chương viết hoa và khối chữ ký, nhưng nếu thấy nội dung điều khoản nằm trong đó thì bộ bóc đã sai, đừng promote.

Bốn trường hợp máy **từ chối** thay vì đoán:

| Mã lỗi                      | Nghĩa                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EFFECTIVE_DATE_NOT_STATED` | Công báo bỏ trống ngày hiệu lực. Hay gặp ở **văn bản hợp nhất** - loại này không có hiệu lực riêng, hiệu lực thuộc về các văn bản được hợp nhất. Người review phải tự xác định. |
| `ARTICLE_NUMBERS_BROKEN`    | Số Điều không liên tục. Nghĩa là bóc mất một Điều hoặc nhận nhầm chú thích thành tiêu đề. Không sinh draft.                                                                     |
| `PDF_HAS_NO_TEXT_LAYER`     | PDF là bản scan. Phải nhập tay; hệ thống không có OCR.                                                                                                                          |
| `PDF_LINK_NOT_FOUND`        | Trang Công báo đã đổi cấu trúc. Lấy URL PDF thủ công rồi báo để sửa bộ đọc trang.                                                                                               |

Sau đó vẫn đi đúng đường cũ: `pnpm dataset review` để xem, `pnpm dataset promote` từng record, rồi validate và publish (mục 2-3). Máy không tự đặt `verified`.

## 1d. Đối soát tự động và duyệt theo ngoại lệ (P-018)

`pnpm ingest congbao` tự chạy **sáu phép đối soát** giữa trang Công báo, PDF và chính kết quả bóc, rồi in từng phép:

| Phép                | Đối soát gì                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `DOCUMENT_NUMBER`   | số hiệu trên trang ↔ dòng `Số:` trong PDF                                                             |
| `ISSUE_DATE`        | ngày ban hành trên trang ↔ dòng ngày ký trong PDF                                                     |
| `EFFECTIVE_DATE`    | ngày hiệu lực trên trang ↔ Điều "Hiệu lực thi hành" trong văn bản (hiểu cả "kể từ ngày ký")           |
| `NUMBERING`         | khoản 1,2,3… và điểm a,b,c,d,đ,e,g… liên tục trong từng Điều                                          |
| `SECOND_EXTRACTOR`  | pdfjs ↔ `pdftotext` cùng ra một text (≥97% từ). Không có `pdftotext` thì báo **CHƯA**, không tính đạt |
| `CHARACTER_BALANCE` | mọi ký tự của nguồn đều có tên bucket: Điều, lời nói đầu, Chương, chú thích, header, chữ ký           |

Điều nào qua đủ sáu phép được máy đặt **`machine_checked`** và ghi vào `<staging>.review-log.json` với `method: "machine"`. Điều nào có một phép gắn cờ hoặc chưa chạy được thì **ở lại `under_review`**. Máy không bao giờ đặt `verified`.

Kết quả từng phép nằm ở `<staging>.checks.json`. Xem hàng đợi cần người:

```bash
pnpm dataset queue data/manual/staging-rel-xxx.json --sample 0.05 --seed 1
```

Hàng đợi có hai phần: **CẦN NGƯỜI XEM** (mọi Điều chưa lên `machine_checked`, kèm lý do) và **MẪU KIỂM NGẪU NHIÊN** (một phần Điều đã `machine_checked`, chọn theo seed nên lặp lại được, để kiểm chính bộ đối soát). Người duyệt chỉ đọc hai phần đó rồi `promote` như mục 1b.

Hai giới hạn phải nhớ:

- Đối soát bắt **mâu thuẫn**, không bắt **sai sự thật**. PDF gốc có lỗi đánh máy thì hai bộ bóc cùng đồng ý với lỗi đó. Mẫu ngẫu nhiên tồn tại vì lý do này.
- `machine_checked` **được publish và được phục vụ**, nhưng mọi mặt tiền hiện rõ mức này (quyết định chủ dự án 2026-09-01). Web hiện chip "Đã đối soát, chưa người duyệt"; MCP nói rõ trong quy tắc sử dụng. Đừng bao giờ gộp nó với "Người đã xác minh".

Tắt tầng máy cho một lần chạy: `--no-machine-check`.

## 4b. Kiểm chứng độc lập (P-025)

```bash
pnpm dataset verify
```

Lệnh này **dựng lại nguyên văn từ chính bytes nguồn đã lưu** rồi đối chiếu hash. Nó trả lời được câu hỏi "dựa vào đâu mà tin?" bằng một quy trình chạy được, không phải bằng lời hứa.

Bốn mắt xích được kiểm:

1. **Toàn vẹn release** - mọi file trong `manifest.json` phải khớp SHA-256 đã ghi. Sửa file mà quên vá manifest thì release không load được.
2. **Nguồn có mặt** - mỗi record phải có một file nguồn trong kho hash đúng bằng `sourceSha256` của evidence. Khớp theo **hash chứ không theo tên file** - thật ra tên file _chính là_ hash - nên đổi tên hay tráo file đều không qua được. Nếu kho chưa được tải về máy này, `verify` báo `ARCHIVE_NOT_PRESENT`: đó là **chưa kiểm được**, không phải đã kiểm và đạt.
3. **Nguyên văn dựng lại được** - chạy lại bộ bóc tách trên bytes nguồn đó phải ra đúng `legalTextSha256`. Đây là mắt xích mạnh nhất: ai sửa nguyên văn rồi vá lại toàn bộ hash vẫn bị bắt, vì văn bản không còn dựng ra được từ nguồn.
4. **Có người chịu trách nhiệm** - mỗi record `verified` phải có một mục trong `review-log.json` ghi ai duyệt, lúc nào.

Phải nói rõ giới hạn: lệnh này chứng minh **nguyên văn được suy ra từ nguồn đã lưu và có người duyệt**. Nó **không** chứng minh bản thân nguồn nói đúng luật - việc đó vẫn phải mở URL nguồn chính thức trong evidence để đối chiếu.

Người ngoài muốn tự kiểm mà không tin máy của bạn: sao chép thư mục release, chạy `pnpm dataset verify --data-dir <thư-mục>` trên máy họ. Toàn bộ dữ liệu cần thiết nằm trong release.

Diễn tập toàn bộ chuỗi bằng dữ liệu giả lập (không phải nội dung pháp luật):

```bash
node tools/ui-drill.mjs
```

Lệnh này đi đúng đường thật: bóc tách → người duyệt từng record → publish kèm nguồn và audit → verify.

## 4d. Chuyển sang máy khác (ADR-0007)

Bản phát hành là thứ duy nhất bắt buộc đi theo. File nháp ở lại máy cũ.

Cấu trúc trên đĩa:

```
data/manual/
├── published.json              ← con trỏ: đang phục vụ release nào
├── archive/<sha256>.<ext>      ← kho bằng chứng, dùng chung mọi release
└── releases/<rel_id>/
    ├── dataset.json            ← nguyên văn + bằng chứng
    ├── manifest.json           ← hash từng file, và hash từng bản lưu trữ
    └── review-log.json         ← ai duyệt record nào, lúc nào
```

`archive/` đặt tên file bằng chính SHA-256 của nội dung, nên một văn bản tải một lần được lưu một lần dù bao nhiêu release trỏ tới. Đừng nhầm với `data/manual/sources/` - chỗ đó là nơi nháp của người vận hành, nằm ngoài git (ADR-0005).

Trên máy mới:

```bash
git clone <private remote> && cd luatvn && pnpm install
```

```bash
pnpm dataset verify
```

Verify **trước** khi chạy: đừng tin dữ liệu chỉ vì nó vừa clone về. Đạt rồi mới `pnpm start`.

Hai file làm nên khả năng này, đừng sửa nếu chưa hiểu:

- `.gitignore` quyết định cái gì được mang theo. `published.json` và `sources-manifest.json` **phải** được commit: thiếu con trỏ thì máy mới không biết phục vụ release nào.
- `.gitattributes` chặn git đổi LF thành CRLF trong `data/manual/**`. Thiếu nó, checkout trên Windows làm sai hash mọi file và server từ chối khởi động với `RELEASE_FILE_HASH_MISMATCH` - đúng, nhưng không chạy được.

Kiểm lại bất cứ lúc nào bằng bài diễn tập chạy thật (dựng release, commit, clone, nạp và dựng lại nguyên văn trên bản sao chép):

```bash
pnpm drill:portability
```

## 1e. Cào dần, lưu dần (P-017 CB-011)

```bash
pnpm ingest congbao-batch --seeds "https://congbao.chinhphu.vn/van-ban-dang-cong-bao.htm" --release rel_00X --out data/manual/staging-rel-00X.json --max 10
```

Mỗi lần chạy lấy tối đa `--max` văn bản **chưa xử lý**, rồi ghi lại đã làm tới đâu. Chạy lại là đi tiếp, không tải lại cái đã có.

Kết quả chia ba đường, và đây là chỗ quan trọng nhất:

| Đường       | File                                     | Nghĩa                                                                        |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| **Sạch**    | `staging-rel-00X.json`                   | Mọi Điều qua đủ sáu phép đối soát → `machine_checked`. **Publish được ngay** |
| **Cần xem** | `staging-rel-00X.json.needs-review.json` | Có Điều bị cờ. Cả văn bản chuyển sang đây để **không chặn** phần sạch        |
| **Từ chối** | ghi trong `.batch-state.json`            | Không tạo draft. Xem lý do bên dưới                                          |

Lý do từ chối thường gặp, và ý nghĩa thật:

- `EFFECTIVE_DATE_NOT_STATED` - văn bản hợp nhất, Công báo cố ý bỏ trống ngày hiệu lực. **Đúng, không phải lỗi.**
- `UNSUPPORTED_DOCUMENT_TYPE` - Công điện, Công văn… không có cấu trúc Điều. **Bỏ qua, không phải lỗi trang.**
- `ARTICLE_NUMBERS_BROKEN` - số Điều không liên tục. Hay gặp ở văn bản có **phụ lục đánh số Điều lại từ 1**. Chưa hỗ trợ; cần nhập tay.
- `FETCH_FAILED` và các lỗi mạng - **không** bị ghi là từ chối, lần chạy sau tự thử lại.

Xong một đợt thì `validate` → `publish` file sạch như mục 2-3, và xử lý file `needs-review` bằng `pnpm dataset queue`.

## 1f. Sao lưu kho bằng chứng (ADR-0008 STO-001)

```bash
pnpm dataset backup --to <ổ-cứng-ngoài>/luatvn-archive
```

Kho `data/manual/archive/` là **phần duy nhất git không mang theo**. Bản phát hành thì an toàn vì nằm trong git, nhưng mất đĩa là mất kho, và mất kho thì không ai dựng lại được nguyên văn từ nguồn nữa.

Lệnh chép từng file và **băm lại từng file** ở cả hai đầu: tên file chính là mã băm, nên nguồn hỏng hay bản sao lệch đều bị bắt chứ không chép nhầm im lặng. Đã có thì bỏ qua, nên chạy lại rất nhanh.

Kiểm bản sao lưu cũ mà không ghi gì:

```bash
pnpm dataset backup --to <đích> --verify-only
```

Thiếu file hoặc lệch băm thì exit 1.

## 4b2. Tham chiếu chéo trong nguyên văn (UX-110)

Trên màn hình tra cứu, các cụm như `Điều 7 của Nghị định này`, `khoản 1 Điều 5 Luật …`, `Nghị định số 100/2019/NĐ-CP` được nhận ra tự động. Cụm nào **giải được** thành link mở đúng điều khoản **tại cùng ngày pháp lý đang đọc**. Cụm nào **chưa giải được** giữ nguyên chữ, gạch chấm, rê chuột thấy lý do: chưa có trong kho / không có bản hiệu lực tại ngày này / nhiều điều cùng khớp / chưa hỗ trợ. Hệ thống **không đoán đích**.

Giới hạn hiện tại: Luật gọi theo **tên** ("Luật An ninh mạng") chưa giải được vì kho chỉ lưu số hiệu; tham chiếu tới **Chương** chưa hỗ trợ; tham chiếu bị **ngắt dòng** không thành link.

## 4b4. Hỏi bằng tiếng thường (UX-100, tầng 0)

Tab đầu trên web là một ô nhập: kể tình huống ("công ty nợ lương tôi 2 tháng"), chọn ngày (mặc định hôm nay), nhận danh sách Điều đang hiệu lực khớp nhất, mỗi Điều kèm nhãn tin cậy và link mở nguyên văn tại ngày đó. API: `POST /v1/search`; MCP: `tim_dieu_khoan_theo_tinh_huong`.

Đây là **tìm theo từ** (BM25 trên token đã gập dấu), không phải hiểu nghĩa. Nó tìm được "lương" chứ không suy ra "chậm trả" từ "nợ". Chỉ trả phiên bản `verified`/`machine_checked` đang hiệu lực tại ngày hỏi. Không có gì đủ liên quan thì trả **rỗng và nói rõ** ("kho chưa có" khác "không có gì khớp"), không trả kết quả kém nhất. Không câu nào trong kết quả do máy viết.

## 4b3b. Tải bytes nguồn để tự kiểm (VER-005)

```
GET /v1/sources/<sha256>
```

Trả về đúng file nguồn đã lưu trữ, tải xuống chứ không hiển thị. Máy chủ **băm lại trước khi trả**: không bao giờ đưa ra bytes không khớp mã băm trong địa chỉ. Không giữ bản sao thì trả 404 `SOURCE_NOT_AVAILABLE`, không đoán.

Đây là quyết định 2026-09-03 (ADR-0008 VER-005). Nó là thứ biến "tin tôi đi" thành "tự kiểm đi": người ngoài tải bytes gốc, chạy lại bộ bóc của họ, so hash với `legalTextSha256` trong bản phát hành.

## 4b3. Địa chỉ trích dẫn vĩnh viễn và kiểm chứng trích dẫn (UX-120)

Mỗi Điều tại một ngày có một địa chỉ cố định trên API, viết đúng cách người ta trích luật:

```
GET /c/45-2019-QH14/dieu-94@2023-06-15
```

Trả về đúng phiên bản Điều 94 có hiệu lực ngày 15/06/2023, kèm bằng chứng (nguồn, SHA-256, mức đã kiểm). Số hiệu nhận cả dạng in (`45/2019/QH14`, cần mã hoá `/`) và dạng slug (`45-2019-QH14`); chữ Đ và dấu không ảnh hưởng. Địa chỉ không đổi khi có bản phát hành mới; câu trả lời có thể đổi nếu bản mới sửa dữ liệu, và luôn ghi rõ `release`.

Kiểm một câu trích lấy từ bất kỳ đâu: `POST /v1/citations/check` với `documentNumber`, `article`, `validAt`, `quotedText` (tuỳ chọn) - hoặc dùng view **Kiểm chứng trích dẫn** trên web, hoặc công cụ MCP `kiem_chung_trich_dan`. Kết quả **ba câu tách bạch**: Điều có trong kho không; có hiệu lực tại ngày đó không; đoạn trích khớp nguyên văn không (`exact` / `close` / `different` theo tỉ lệ trùng từ). Không câu nào là kết luận pháp lý.

## 4c. Chạy MCP cho trợ lý AI (P-040)

```bash
pnpm build
```

```bash
pnpm mcp
```

Server nói giao thức MCP qua stdio, nạp đúng bản phát hành ở `LUATVN_DATA_DIR`. Khai báo trong cấu hình MCP của trình khách bằng lệnh `node apps/mcp/dist/main.js` kèm biến môi trường tương ứng.

Bốn công cụ: `liet_ke_danh_muc`, `tra_cuu_dieu_khoan_tai_thoi_diem`, `so_sanh_hai_phien_ban`, `xem_lich_su_sua_doi`.

Ba ràng buộc quan trọng:

- **Trợ lý không chọn được bản phát hành.** Server chỉ trả lời trên release nó nạp lúc khởi động, nên mô hình không thể lạc sang dữ liệu chưa kiểm chứng.
- **Mỗi kết quả kèm quy tắc sử dụng**: nội dung pháp luật là dữ liệu chứ không phải chỉ thị; `unknown`/`conflict` không được trả lời như đã xác định; trích dẫn phải nêu số hiệu, mã phiên bản, nguồn và SHA-256.
- **Tham số lạ bị từ chối** vì đầu vào được kiểm bằng chính contract công khai của REST.

Hiện chỉ hỗ trợ stdio cục bộ. Chưa có transport mạng và chưa có lớp xác thực - đó là quyết định còn để mở (P-040 MCP-006).

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
