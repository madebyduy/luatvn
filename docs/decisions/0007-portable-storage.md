# ADR-0007: Nơi lưu trữ và định dạng bản phát hành để chạy được trên mọi máy

- Status: Proposed - chờ quyết định chủ dự án
- Date: 2026-09-01
- Source: Yêu cầu chủ dự án 2026-09-01 ("máy nào cũng chạy được, một nơi lưu trữ tốt nhất"); số đo tại mục Context; nối tiếp ADR-0005

## Context

ADR-0005 đã chốt: file nguồn nằm trên đĩa máy vận hành, chỉ commit manifest. Nó cũng ghi sẵn điều kiện mở ADR mới: "khi corpus vượt sức chứa đĩa cục bộ hoặc cần chia sẻ nhiều máy". Yêu cầu chạy được trên mọi máy chính là điều kiện đó.

Trước hết phải tách ba thứ đang bị gộp làm một khi nói "database":

| Lớp                         | Là gì                                                              | Bất biến? | Ai cần nó                            |
| --------------------------- | ------------------------------------------------------------------ | --------- | ------------------------------------ |
| **Bản phát hành** (release) | `dataset.json` + `manifest.json` + `review-log.json` + bytes nguồn | Có        | Mọi máy chạy API, Web, MCP           |
| **Kho nguồn thô** (archive) | Payload đã cào cho toàn corpus                                     | Có        | Chỉ máy làm ingest và kiểm chứng lại |
| **Chỗ làm việc** (staging)  | Draft chưa duyệt, `crawl-state.json`                               | Không     | Chỉ máy đang nhập liệu               |

Chỉ lớp thứ nhất bắt buộc phải đi theo người dùng. Gộp ba lớp là lý do người ta tưởng phải bê 10-30 GB đi khắp nơi.

### Số đo thật (2026-09-01, trên nguồn đã tải về từ vbpl.vn)

Một luật lớn, đo trên payload thật đã lưu:

| Đại lượng               | Giá trị    |
| ----------------------- | ---------- |
| bytes nguồn lưu trữ     | 694.870    |
| số Điều bóc được        | 218        |
| ký tự nguyên văn        | 318.183    |
| ký tự trên mỗi Điều     | 1.460      |
| một bản ghi JSON đầy đủ | 2.724 byte |

Suy ra kích thước `dataset.json`: 10.000 Điều là 27 MB, 100.000 Điều là 272 MB, 1.000.000 Điều là 2.724 MB.

Đo trực tiếp giới hạn của định dạng một-file-JSON hiện tại, và của SQLite ở cùng quy mô 50.000 Điều:

| Chỉ số                          | JSON một file | SQLite một file |
| ------------------------------- | ------------- | --------------- |
| kích thước trên đĩa             | 134,2 MB      | 207,8 MB        |
| thời gian mở để trả lời câu đầu | 1.414 ms      | 1,0 ms          |
| bộ nhớ heap phải giữ            | 435 MB        | 6 MB            |
| vẫn là một khối có SHA-256      | Có            | Có              |

SQLite tốn đĩa hơn 55% nhưng không nạp cả file vào RAM, nên bức tường thật không phải đĩa mà là bộ nhớ: JSON phải giữ toàn bộ corpus trong heap để trả lời một câu hỏi.

Corpus mục tiêu: **172.117** URL văn bản trên sitemap vbpl.vn (đo tại P-015). Bản phát hành hiện tại: 36 KB.

### Hai lỗi tính di động phát hiện khi đo, đã sửa

Kích thước chưa phải vấn đề hôm nay. Cái làm hỏng "clone là chạy" lại là công cụ:

1. `.gitignore` đang chặn `data/manual/published.json` và `data/manual/sources-manifest.json`. Máy khác clone về sẽ có release nhưng không biết phải phục vụ release nào, và không kiểm được kho nguồn theo manifest - trái đúng điều ADR-0005 quy định phải commit.
2. Git tự đổi LF sang CRLF khi checkout (`core.autocrlf`, mặc định trên Windows) làm **sai hash của mọi file trong release**. Bộ nạp fail-closed từ chối khởi động, đúng như thiết kế. Không có `.gitattributes` thì release không thể đi qua git giữa hai máy khác hệ điều hành.

Cả hai đã sửa và có bài diễn tập chạy được: `node tools/portability-drill.mjs` dựng release qua đường thật, commit dưới đúng `.gitignore`/`.gitattributes` của repo, clone như một máy thứ hai, rồi nạp và dựng lại nguyên văn từ chính bản sao chép.

## Decision (đề xuất, chờ chủ dự án duyệt)

**1. Bất biến nền tảng: sự thật không nằm ở nơi lưu, mà nằm ở hash.**

Một bản phát hành hợp lệ là "khối bytes có SHA-256 khớp manifest đã commit trong git". Mọi nơi lưu trữ - đĩa, git, object storage - chỉ là bản sao. Nhà cung cấp nào chết cũng không mất tính đúng đắn, chỉ mất tiện lợi. Đây là điều kiện để không bao giờ bị khoá vào một dịch vụ.

**2. Ba lớp, ba nơi lưu khác nhau.**

- **Bản phát hành** đi theo git, trong private remote. Kèm bytes nguồn của đúng những văn bản trong release. Máy mới: `git clone` → `pnpm install` → `pnpm dataset verify` → `pnpm start`. Không cần credential, không cần mạng ngoài git.
- **Kho nguồn thô** ở lại đĩa máy ingest theo ADR-0005, cộng thêm một bản sao lưu do chủ dự án chọn. Không đi vào git.
- **Chỗ làm việc** không rời máy, đã được `.gitignore` chặn.

**3. Ngưỡng chuyển định dạng, theo số đo chứ không theo cảm tính.**

- Dưới **10.000 Điều** một release (27 MB): giữ nguyên `dataset.json`. Đơn giản, đọc được bằng mắt, diff được.
- Từ 10.000 Điều trở lên: chuyển định dạng release sang **SQLite một file**. Vẫn là một khối bất biến có SHA-256, nên toàn bộ chuỗi kiểm chứng P-025 giữ nguyên không phải viết lại. Node 24 có `node:sqlite` sẵn nên không thêm dependency biên dịch.

**3b. PostgreSQL: có dùng, nhưng ở đúng lớp.**

Phải tách hai vai mà từ "database" hay gộp lại:

| Vai                    | Là gì                                                        | Nên là gì                           |
| ---------------------- | ------------------------------------------------------------ | ----------------------------------- |
| **Nơi làm việc**       | Chỗ nhập, sửa, duyệt, tìm kiếm, phục vụ nhiều người cùng lúc | PostgreSQL, khi tới ngưỡng (B-100)  |
| **Vật phẩm phát hành** | Thứ được đóng băng, hash, phân phát và kiểm chứng lại được   | File bất biến (JSON, sau là SQLite) |

B-100 gọi PostgreSQL là canonical store, và điều đó đúng cho vai thứ nhất: fact sheet của chính B-100 đã ghi "immutable published release and evidence chain remain mandatory" và "search/cache are rebuildable projections". Hai tài liệu không mâu thuẫn khi nói rõ vai.

Ràng buộc cứng, và chỉ một ràng buộc: **`publish` phải đóng băng ra một file có SHA-256; không bao giờ trỏ người dùng vào một database đang chạy để đọc luật.** Lý do: không hash được một instance đang chạy. Một câu `UPDATE` gõ nhầm hoặc một tài khoản bị chiếm sẽ sửa nguyên văn mà không ai chứng minh được là đã bị sửa - đúng thứ mà cả P-025 sinh ra để chống. Khi bản phát hành vẫn là file, Postgres trở thành thứ **dựng lại được**: nghi ngờ thì rebuild từ release rồi diff.

Ngưỡng nên đưa Postgres vào (bất kỳ điều nào tới trước): cần tìm kiếm toàn văn tiếng Việt thật sự (`tsvector` + `unaccent`), có từ hai người biên tập trở lên cùng lúc, hoặc corpus vượt bức tường bộ nhớ ở mục Context. Trước những mốc đó, Postgres chỉ thêm một tiến trình phải cài trên mọi máy - đi ngược đúng yêu cầu "máy nào cũng chạy được".

**3c. Chi phí sao chép: nặng nằm ở kho nguồn, không nằm ở dữ liệu.**

Đo trên Nghị định 327/2026/NĐ-CP, văn bản thật, 16 Điều (2026-09-01):

|                                        | Kích thước |
| -------------------------------------- | ---------- |
| PDF nguồn                              | 797 KB     |
| PDF nén gzip                           | 486 KB     |
| dataset JSON (nguyên văn + bằng chứng) | 71 KB      |
| dataset JSON nén gzip                  | **12 KB**  |

Tức là 4,5 KB JSON mỗi Điều, còn 0,8 KB sau khi nén. Suy ra toàn corpus 172.117 văn bản (`Hypothesis`: giả định 20 Điều/văn bản, chưa đo phân bố thật):

| Lớp              | Dung lượng |
| ---------------- | ---------- |
| dataset JSON thô | 15,7 GB    |
| dataset JSON nén | **2,7 GB** |
| kho PDF nguồn    | 140,6 GB   |
| kho PDF nén      | 85,7 GB    |

**Kho PDF nặng gấp 52 lần phần dữ liệu cần để chạy.** Đây là con số quyết định: thứ bắt buộc đi theo người dùng là 2,7 GB, còn 140 GB kia chỉ cần khi có người muốn _kiểm chứng lại_.

Quy đổi sang ngưỡng thực dụng, nếu release vẫn đóng gói kèm PDF và commit vào git: vượt mốc 1 GB ở khoảng **1.200 văn bản**. Git giữ mọi phiên bản mãi mãi nên con số đó chỉ đi lên, không đi xuống.

**Điểm yếu này ĐÃ SỬA 2026-09-01.** Mô tả dưới đây giữ lại để hiểu vì sao phải đổi.

**Trạng thái cũ.** `loadReleaseById` đọc và băm **mọi** file có tên trong manifest, gồm cả PDF nguồn. Tuỳ chọn `includeAttachments` chỉ quyết định có _giữ lại bytes trong bộ nhớ_ hay không, không quyết định có _đọc_ hay không. Hệ quả: hôm nay không thể chạy hệ thống nếu thiếu kho nguồn, dù để trả lời truy vấn thì không cần đến nó.

Cách đã làm: chia manifest thành hai loại file.

- **Bắt buộc để phục vụ** (`dataset.json`, `review-log.json`): luôn đọc và băm khi load. Thiếu hoặc lệch hash thì từ chối khởi động như hiện nay.
- **Kho lưu trữ** (`sources/**`): manifest vẫn ghi hash, nhưng bytes được phép vắng mặt. Load vẫn chạy; `verify` phải phân biệt rõ **"chưa có bản sao cục bộ"** với **"có nhưng sai hash"** - hai chuyện khác hẳn nhau, và không được gộp thành một chữ "pass".

Đánh đổi phải nói thẳng: hôm nay "release load được" đồng nghĩa "toàn bộ bằng chứng còn nguyên vẹn". Sau khi tách, load được không còn chứng minh điều đó nữa - chỉ `verify` mới chứng minh. Vì thế bộ nạp bắt buộc phải **báo ra** những file kho đang vắng mặt, chứ không được im lặng.

**Làm ngay chứ không hoãn, vì bản phát hành là bất biến.** Release đã publish thì không migrate được: nếu phát hành 50 release theo bố cục cũ rồi mới đổi, 50 release đó giữ bố cục cũ vĩnh viễn và bộ nạp phải hiểu cả hai kiểu mãi mãi. Thời điểm đổi rẻ nhất là khi có **0 release** - đúng lúc này.

Và hoá ra không phải đánh đổi gì: **nghiêm ngặt vẫn là mặc định**, chỉ nới khi người vận hành chủ động yêu cầu.

| Tình huống                | `archivePolicy: "required"` (mặc định) | `archivePolicy: "optional"`                       |
| ------------------------- | -------------------------------------- | ------------------------------------------------- |
| kho đủ và khớp hash       | nạp được                               | nạp được                                          |
| kho **vắng mặt**          | **từ chối nạp**                        | nạp được, liệt kê file vắng tại `missingArchives` |
| kho có nhưng **sai hash** | **từ chối nạp**                        | **từ chối nạp**                                   |

Dòng cuối là điều kiện không thương lượng: vắng mặt nghĩa là _chưa lấy về_, sai hash nghĩa là _đã bị sửa_. `verify` cũng tách hai chuyện đó ra: mã `ARCHIVE_NOT_PRESENT` kèm `uncheckedProvisions` cho biết bao nhiêu bản ghi **chưa kiểm được** - khác hẳn với đã kiểm và đạt.

Kho nằm tại `data/manual/archive/<sha256>.<ext>`, dùng chung cho mọi release. Publish lại cùng một văn bản không ghi thêm bản sao nào. Thư mục này khác `data/manual/sources/` - chỗ đó vẫn là nơi nháp của người vận hành và vẫn nằm ngoài git theo ADR-0005.

**4. Khi nào cần object storage.**

Khi tổng bản phát hành vượt khoảng **1 GB**, hoặc khi cần phát cho người ngoài tải: chuyển bundle sang object storage, giữ lại trong git đúng con trỏ và hash. Ưu tiên nhà cung cấp có S3 API và không tính phí egress. Lúc đó máy mới chạy một lệnh tải bundle theo hash rồi verify - vẫn không phải tin nhà cung cấp.

## Consequences

- Hôm nay đã chạy được trên mọi máy mà không tốn đồng nào và không thêm credential nào, vì release còn nhỏ. Chi phí chỉ phát sinh khi corpus lớn thật.
- Đổi lại, phải kỷ luật: bytes nguồn đi kèm release làm git phình theo từng lần publish, và git không bao giờ xoá lịch sử. Đây là lý do có ngưỡng 1 GB ở trên chứ không để trôi.
- SQLite tốn đĩa hơn JSON 55% ở cùng dữ liệu. Chấp nhận, vì đổi lại truy vấn 1 ms thay vì nạp 435 MB vào RAM.
- `.gitattributes` là một phần của hợp đồng tính di động chứ không phải tiểu tiết định dạng: thiếu nó thì release không đi qua git được giữa Windows và Linux.

## Chờ chủ dự án quyết

- **STO-001**: nơi sao lưu kho nguồn thô (ADR-0005 để trống). Cần một địa điểm cụ thể và một lịch cụ thể.
- **STO-002**: có mở private remote thứ hai làm bản sao lưu cho repo hay không. Hiện repo riêng chỉ tồn tại trên một máy.
- **STO-003**: khi vượt ngưỡng 1 GB thì dùng nhà cung cấp object storage nào, và có chấp nhận chi phí hàng tháng không.
- ~~**STO-004**~~: đã giải quyết 2026-09-01 mà không phải đánh đổi - nghiêm ngặt là mặc định, nới lỏng phải yêu cầu tường minh (mục 3c).
