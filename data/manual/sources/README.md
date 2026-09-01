# Nguồn gốc văn bản (evidence store)

Đặt file gốc tải từ nguồn chính thức (SR-003) tại đây: PDF/HTML từ vbpl.vn, congbao.chinhphu.vn, chinhphu.vn hoặc cổng bộ/ngành.

- Thư mục này được Git LFS track (`data/manual/sources/**` trong `.gitattributes`).
- Đặt tên file theo release và số hiệu văn bản, ví dụ `rel_2026_001/91-2015-QH13.pdf`.
- SHA-256 của từng file phải khớp `sourceSha256` trong evidence của dataset.
- File gốc là bất biến: không sửa, không ghi đè; sai thì thêm file mới và release mới.
