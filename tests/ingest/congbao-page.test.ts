import { CongBaoPageError, readCongBaoDetailPage } from "@luatvn/ingest";
import { describe, expect, it } from "vitest";

// Shaped like the real congbao.chinhphu.vn detail page: metadata plus an
// attachment list, and no legal text - the page renders the signed PDF with
// PDF.js at view time, so the text never appears in the HTML (SR-005).
function detailPage(options: {
  readonly issued?: string;
  readonly effective?: string;
  readonly attachment?: string;
}): string {
  const attachment =
    options.attachment ??
    '<a href="/van-ban/nghi-dinh-so-1-2026-nd-cp-1/1.htm" data-tepid="1" data-href="https://congbaocdn.chinhphu.vn/2026/8/28/1-signed.pdf" title="Công báo số 496 ngày 2026-08-29" class="itemtep active">tải</a>';
  return [
    "<html><head><title>Nghị định số 327/2026/NĐ-CP quy định về phòng ngừa - Công báo</title></head>",
    "<body>",
    `<div class="ngayban">Ban hành: ${options.issued ?? "19/08/2026"} - Hiệu lực: ${options.effective ?? "19/08/2026"}</div>`,
    '<div class="kyhieu" data-contentvanban="loadtep">',
    attachment,
    "</div>",
    '<div id="pdf-container"></div>',
    "</body></html>",
  ].join("\n");
}

describe("reading a Công báo detail page", () => {
  it("takes the signed PDF and the gazette issue that cites it", () => {
    const reference = readCongBaoDetailPage(detailPage({}));
    expect(reference.pdfUrl).toBe("https://congbaocdn.chinhphu.vn/2026/8/28/1-signed.pdf");
    expect(reference.locator).toBe("Công báo số 496 ngày 2026-08-29");
    expect(reference.documentNumber).toBe("327/2026/NĐ-CP");
    expect(reference.issuedOn).toBe("2026-08-19");
    expect(reference.effectiveFrom).toBe("2026-08-19");
  });

  it("refuses a consolidated document, whose effective date the gazette leaves blank", () => {
    // A văn bản hợp nhất restates other documents and has no effective date of
    // its own. Refusing is right; inventing one would be a legal claim the
    // source never made.
    expect(() => readCongBaoDetailPage(detailPage({ effective: "" }))).toThrowError(
      expect.objectContaining({ code: "EFFECTIVE_DATE_NOT_STATED" }) as Error,
    );
  });

  it("refuses when the page states no issue date", () => {
    expect(() => readCongBaoDetailPage(detailPage({ issued: "" }))).toThrowError(
      expect.objectContaining({ code: "ISSUE_DATE_NOT_FOUND" }) as Error,
    );
  });

  it("refuses when the attachment list carries no active PDF", () => {
    const page = detailPage({ attachment: '<a href="#" class="itemtep">không có file</a>' });
    expect(() => readCongBaoDetailPage(page)).toThrowError(
      expect.objectContaining({ code: "PDF_LINK_NOT_FOUND" }) as Error,
    );
  });

  it("reports a refusal as a typed error, not a generic failure", () => {
    try {
      readCongBaoDetailPage(detailPage({ effective: "" }));
      expect.unreachable("the page should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(CongBaoPageError);
      expect((error as CongBaoPageError).message).toContain("hợp nhất");
    }
  });
});

describe("document types whose name contains another type's name", () => {
  // "Thông tư liên tịch" is a normative document with a full Điều structure.
  // A pattern that tried "Thông tư" first matched that prefix, found no "số"
  // after it, and reported the whole document as an unsupported type; six were
  // turned away in a single crawl of twenty-five.
  it("reads a joint circular rather than calling it an unsupported type", () => {
    const page = detailPage({}).replace(
      "Nghị định số 327/2026/NĐ-CP quy định về phòng ngừa",
      "Thông tư liên tịch số 12/2026/TTLT-BCA-BQP quy định về phối hợp",
    );
    const reference = readCongBaoDetailPage(page);
    expect(reference.documentNumber).toBe("12/2026/TTLT-BCA-BQP");
  });

  it("still reads a plain circular", () => {
    const page = detailPage({}).replace(
      "Nghị định số 327/2026/NĐ-CP quy định về phòng ngừa",
      "Thông tư số 41/2026/TT-BCT quy định về tạm ngừng",
    );
    expect(readCongBaoDetailPage(page).documentNumber).toBe("41/2026/TT-BCT");
  });

  it("names the type it found when the type has no Điều structure", () => {
    const page = detailPage({}).replace(
      "Nghị định số 327/2026/NĐ-CP quy định về phòng ngừa",
      "Công điện số 15/CĐ-TTg về ứng phó",
    );
    const error = (() => {
      try {
        readCongBaoDetailPage(page);
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(CongBaoPageError);
    expect((error as CongBaoPageError).code).toBe("UNSUPPORTED_DOCUMENT_TYPE");
  });
});
