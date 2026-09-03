import { extractCongBaoDraft, type CongBaoDocumentReference } from "@luatvn/ingest";
import type { PdfTextDocument, TextLine } from "@luatvn/pdf-text";
import { describe, expect, it } from "vitest";

// Placeholder wording throughout: these tests exercise segmentation, never
// real legal content.
const bodySize = 19.9;
const apparatusSize = 14.1;

function line(text: string, overrides: Partial<TextLine> = {}): TextLine {
  return { fontSize: bodySize, page: 1, text, x: 113, y: 700, ...overrides };
}

function documentOf(lines: readonly TextLine[], pageCount = 1): PdfTextDocument {
  const histogram = new Map<number, number>();
  for (const entry of lines) {
    histogram.set(entry.fontSize, (histogram.get(entry.fontSize) ?? 0) + 1);
  }
  return {
    fontSizeHistogram: [...histogram.entries()]
      .map(([fontSize, count]) => ({ fontSize, lines: count }))
      .toSorted((left, right) => right.lines - left.lines),
    lines,
    pageCount,
    pageWidth: 595,
  };
}

const reference: CongBaoDocumentReference = {
  documentNumber: "01/2026/NĐ-TEST",
  effectiveFrom: "2026-01-01",
  issuedOn: "2025-12-01",
  locator: "Công báo số 1 ngày 2026-01-02",
  pdfUrl: "https://congbaocdn.chinhphu.vn/2026/1/1/test-signed.pdf",
  title: "Nghị định thử nghiệm",
};

function draftOf(pdfText: PdfTextDocument) {
  return extractCongBaoDraft(pdfText, {
    datasetReleaseId: "rel_test",
    evidence: {
      locator: reference.locator,
      officialSourceUrl: reference.pdfUrl,
      retrievedAt: "2026-01-05T00:00:00.000Z",
      sourceSha256: "a".repeat(64),
    },
    reference,
  });
}

describe("segmenting a gazette PDF into provisions", () => {
  it("keeps every line of an article with that article", () => {
    const { draft, report } = draftOf(
      documentOf([
        line("Căn cứ Luật Tổ chức Chính phủ;"),
        line("Điều 1. Phạm vi"),
        line("1. Đoạn thứ nhất của Điều 1."),
        line("2. Đoạn thứ hai của Điều 1."),
        line("Điều 2. Đối tượng"),
        line("Nội dung của Điều 2."),
      ]),
    );
    expect(report.provisionCount).toBe(2);
    expect(draft.provisionVersions[0]?.legalText).toBe(
      "Điều 1. Phạm vi\n1. Đoạn thứ nhất của Điều 1.\n2. Đoạn thứ hai của Điều 1.",
    );
    expect(report.preambleLines).toBe(1);
  });

  it("does not mistake a sentence mentioning a chapter for a chapter heading", () => {
    // "Chương IV của Nghị định này." is body text. Treating it as a heading
    // closes the article and drops the rest of its text without a word.
    const { draft } = draftOf(
      documentOf([
        line("Điều 1. Phạm vi"),
        line("Áp dụng theo Chương IV của Nghị định này."),
        line("Đoạn cuối vẫn thuộc Điều 1."),
      ]),
    );
    expect(draft.provisionVersions[0]?.legalText).toContain("Đoạn cuối vẫn thuộc Điều 1.");
  });

  it("treats a real chapter heading as structure, not as text of either article", () => {
    const { draft, report } = draftOf(
      documentOf([
        line("Điều 1. Phạm vi"),
        line("Nội dung Điều 1."),
        line("Chương II"),
        line("QUY ĐỊNH CHUNG"),
        line("Điều 2. Đối tượng"),
        line("Nội dung Điều 2."),
      ]),
    );
    expect(report.structureHeadings).toContain("Chương II");
    expect(draft.provisionVersions[0]?.legalText).not.toContain("Chương II");
    expect(draft.provisionVersions[1]?.legalText).not.toContain("QUY ĐỊNH CHUNG");
    // The chapter title is reported rather than silently discarded.
    expect(report.unassignedLines.map((entry) => entry.text)).toContain("QUY ĐỊNH CHUNG");
  });

  it("separates the editorial apparatus of a consolidated document by type size", () => {
    const { draft, report } = draftOf(
      documentOf([
        line("Điều 1. Phạm vi"),
        line("Nội dung Điều 1."),
        line("Điều 7. Điều khoản thi hành", { fontSize: apparatusSize, x: 85 }),
        line("Điều 2. Đối tượng"),
        line("Nội dung Điều 2."),
      ]),
    );
    expect(report.provisionCount).toBe(2);
    expect(report.apparatusLines.map((entry) => entry.text)).toContain(
      "Điều 7. Điều khoản thi hành",
    );
    expect(draft.provisionVersions.map((version) => version.legalText).join("")).not.toContain(
      "Điều khoản thi hành",
    );
  });

  it("drops a running header it detected from the document, not from a hardcoded phrase", () => {
    const lines: TextLine[] = [];
    for (let page = 1; page <= 4; page += 1) {
      lines.push(line(`CÔNG BÁO/Số 1/Ngày 02-01-2026 ${String(page)}`, { page, y: 800 }));
      lines.push(line(`Điều ${String(page)}. Tiêu đề`, { page, y: 700 }));
      lines.push(line(`Nội dung trang ${String(page)}.`, { page, y: 680 }));
    }
    const { report } = draftOf(documentOf(lines, 4));
    expect(report.provisionCount).toBe(4);
    expect(report.runningLines.length).toBeGreaterThan(0);
    expect(report.runningLines[0]).toContain("CÔNG BÁO");
  });

  it("refuses a draft whose article numbers skip, instead of publishing a gap", () => {
    expect(() =>
      draftOf(
        documentOf([line("Điều 1. Một"), line("Nội dung."), line("Điều 3. Ba"), line("Nội dung.")]),
      ),
    ).toThrowError(expect.objectContaining({ code: "ARTICLE_NUMBERS_BROKEN" }) as Error);
  });

  it("refuses a document that yields no article at all", () => {
    expect(() => draftOf(documentOf([line("Chỉ có lời nói đầu.")]))).toThrowError(
      expect.objectContaining({ code: "NO_PROVISIONS" }) as Error,
    );
  });

  it("caps every record at under_review and carries the gazette issue as the locator", () => {
    const { draft } = draftOf(documentOf([line("Điều 1. Phạm vi"), line("Nội dung Điều 1.")]));
    for (const version of draft.provisionVersions) {
      expect(version.reviewStatus).toBe("under_review");
      expect(version.evidence[0]?.locator).toBe("Công báo số 1 ngày 2026-01-02");
      expect(version.evidence[0]?.sourceSha256).toBe("a".repeat(64));
      expect(version.validTime.from).toBe("2026-01-01");
    }
  });

  it("keeps the signature block out of the last article, and says where it went", () => {
    // The block that closes a document sits right of centre: "TM. CHÍNH PHỦ /
    // KT. THỦ TƯỚNG / <name>". It follows the last article, so without this it
    // lands inside that article - putting the signer's name into the provision
    // and into its hash, and into every citation of it.
    const { draft, report } = draftOf(
      documentOf([
        line("Điều 1. Trách nhiệm thi hành"),
        line("Các Bộ trưởng chịu trách nhiệm thi hành Nghị định này."),
        line("TM. CHÍNH PHỦ", { x: 402 }),
        line("KT. THỦ TƯỚNG", { x: 401 }),
        line("Nguyễn Văn A", { x: 415 }),
      ]),
    );
    expect(draft.provisionVersions[0]?.legalText).toBe(
      "Điều 1. Trách nhiệm thi hành\nCác Bộ trưởng chịu trách nhiệm thi hành Nghị định này.",
    );
    expect(report.closingBlockLines).toEqual(["TM. CHÍNH PHỦ", "KT. THỦ TƯỚNG", "Nguyễn Văn A"]);
  });

  it("does not strip an indented line that merely sits to the right", () => {
    const { draft } = draftOf(
      documentOf([line("Điều 1. Phạm vi"), line("Đoạn thân bài thụt lề bình thường.", { x: 128 })]),
    );
    expect(draft.provisionVersions[0]?.legalText).toContain("thụt lề bình thường");
  });

  it("derives stable identifiers from the document number and article number", () => {
    const first = draftOf(documentOf([line("Điều 1. Phạm vi"), line("Nội dung.")]));
    const second = draftOf(documentOf([line("Điều 1. Phạm vi"), line("Nội dung.")]));
    expect(first.draft.provisionVersions[0]?.provisionId).toBe(
      second.draft.provisionVersions[0]?.provisionId,
    );
    expect(first.draft.provisionVersions[0]?.provisionVersionId).toContain("_e20260101");
  });
});

describe("an instrument attached behind the last article", () => {
  it("holds the annex out of the last article instead of hashing it in", () => {
    const { draft, report } = draftOf(
      documentOf([
        line("Điều 1. Phạm vi"),
        line("Nội dung của Điều 1."),
        line("Điều 2. Điều khoản thi hành"),
        line("1. Thủ trưởng đơn vị chịu trách nhiệm thi hành./."),
        line("BỘ TRƯỞNG", { x: 400 }),
        line("Người ký thử nghiệm", { x: 400 }),
        line("CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM"),
        line("QCVN 99:2026/TEST"),
        line("1. QUY ĐỊNH CHUNG"),
        line("1.1. Phạm vi điều chỉnh"),
      ]),
    );

    const last = draft.provisionVersions.at(-1);
    expect(last?.legalText).toBe(
      "Điều 2. Điều khoản thi hành\n1. Thủ trưởng đơn vị chịu trách nhiệm thi hành./.",
    );
    expect(report.annexLines.map((entry) => entry.text)).toEqual([
      "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM",
      "QCVN 99:2026/TEST",
      "1. QUY ĐỊNH CHUNG",
      "1.1. Phạm vi điều chỉnh",
    ]);
    expect(report.annexCutRefused).toBeNull();
  });

  it("refuses to cut when articles continue past the marker, and says so", () => {
    // Cutting here would drop Điều 2 where no later check could notice: the
    // articles kept would still read 1..1 with no gap.
    const { draft, report } = draftOf(
      documentOf([
        line("Điều 1. Phạm vi"),
        line("Biểu mẫu kèm theo Điều này:"),
        line("PHỤ LỤC I"),
        line("Điều 2. Đối tượng"),
        line("Nội dung của Điều 2."),
      ]),
    );

    expect(draft.provisionVersions).toHaveLength(2);
    expect(report.annexLines).toEqual([]);
    expect(report.annexCutRefused).toContain("PHỤ LỤC I");
  });

  it("does not cut on the national heading that opens the document itself", () => {
    const { draft, report } = draftOf(
      documentOf([
        line("CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM"),
        line("Căn cứ Luật Tổ chức Chính phủ;"),
        line("Điều 1. Phạm vi"),
        line("Nội dung của Điều 1."),
      ]),
    );

    expect(draft.provisionVersions).toHaveLength(1);
    expect(report.annexLines).toEqual([]);
  });
});

describe("annex markers as they are actually printed", () => {
  it("cuts on a lower-case 'Phụ lục' heading standing alone", () => {
    const { report } = draftOf(
      documentOf([
        line("Điều 1. Điều khoản thi hành"),
        line("Có hiệu lực thi hành./."),
        line("Phụ lục"),
        line("DANH MỤC HÀNG HÓA"),
      ]),
    );
    expect(report.annexLines.map((entry) => entry.text)).toEqual(["Phụ lục", "DANH MỤC HÀNG HÓA"]);
  });

  it("cuts on a form schedule that names the document issuing it", () => {
    const { report } = draftOf(
      documentOf([
        line("Điều 1. Điều khoản thi hành"),
        line("Có hiệu lực thi hành./."),
        line("Mẫu CC01 ban hành kèm theo Thông tư số 01/2026/NĐ-TEST"),
        line("PHIẾU THU NHẬN"),
      ]),
    );
    expect(report.annexLines).toHaveLength(2);
  });

  it("keeps a reference to an annex inside the article that makes it", () => {
    const { draft, report } = draftOf(
      documentOf([
        line("Điều 1. Phạm vi"),
        line("Danh mục hàng hóa theo Phụ lục I ban hành kèm theo Thông tư này."),
      ]),
    );
    expect(report.annexLines).toEqual([]);
    expect(draft.provisionVersions[0]?.legalText).toContain("Phụ lục I");
  });
});

describe("annexes that carry their own Điều numbering", () => {
  // 128/2026/TT-BCA was refused outright: its annex, a set of facility rules,
  // restarts at Điều 1, so the article sequence read 1,2,3,4,1,2,3,4. The
  // marker was there but the PDF had flattened two columns into one line.
  it("cuts on a national heading that shares a line with the issuing body", () => {
    const { draft, report } = draftOf(
      documentOf([
        line("Điều 1. Phạm vi"),
        line("Nội dung của Điều 1."),
        line("Điều 2. Trách nhiệm thi hành"),
        line("Chịu trách nhiệm thi hành Thông tư này./."),
        line("BỘ TRƯỞNG", { x: 400 }),
        line("Người ký thử nghiệm", { x: 400 }),
        line("BỘ THỬ NGHIỆM CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM"),
        line("NỘI QUY THỬ NGHIỆM"),
        line("Điều 1. Quy định đối với người lưu trú"),
        line("Nội dung nội quy."),
      ]),
    );
    expect(draft.provisionVersions).toHaveLength(2);
    expect(report.annexLines.at(0)?.text).toContain("CỘNG HÒA");
    expect(report.annexLines).toHaveLength(4);
  });

  it("cuts on a bracketed line naming the document that issued the annex", () => {
    const { report } = draftOf(
      documentOf([
        line("Điều 1. Điều khoản thi hành"),
        line("Có hiệu lực thi hành./."),
        line("(Ban hành kèm theo Thông tư số 01/2026/NĐ-TEST)"),
        line("BẢNG GIÁ"),
      ]),
    );
    expect(report.annexLines).toHaveLength(2);
  });

  // The relaxed marker is only safe because of this: a marker that is followed
  // by the next article in sequence is not an annex, and no cut is made.
  it("still refuses the cut when the numbering continues past the marker", () => {
    const { draft, report } = draftOf(
      documentOf([
        line("Điều 1. Phạm vi"),
        line("Biểu mẫu in tiêu đề CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM ở đầu trang."),
        line("Điều 2. Đối tượng"),
        line("Nội dung của Điều 2."),
      ]),
    );
    expect(draft.provisionVersions).toHaveLength(2);
    expect(report.annexLines).toEqual([]);
    expect(report.annexCutRefused).toContain("CỘNG HÒA");
  });
});
