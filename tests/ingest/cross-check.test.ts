import {
  crossCheckCongBao,
  extractCongBaoDraft,
  type CongBaoDocumentReference,
} from "@luatvn/ingest";
import type { PdfTextDocument, TextLine } from "@luatvn/pdf-text";
import { describe, expect, it } from "vitest";

// Placeholder wording; these exercise the cross-checks, never real legal content.
function line(text: string, overrides: Partial<TextLine> = {}): TextLine {
  return { fontSize: 19.9, page: 1, text, x: 113, y: 700, ...overrides };
}

function pdfOf(lines: readonly TextLine[]): PdfTextDocument {
  const histogram = new Map<number, number>();
  for (const entry of lines) {
    histogram.set(entry.fontSize, (histogram.get(entry.fontSize) ?? 0) + 1);
  }
  return {
    fontSizeHistogram: [...histogram.entries()]
      .map(([fontSize, count]) => ({ fontSize, lines: count }))
      .toSorted((left, right) => right.lines - left.lines),
    lines,
    pageCount: 1,
    pageWidth: 595,
  };
}

const reference: CongBaoDocumentReference = {
  documentNumber: "01/2026/NĐ-TEST",
  effectiveFrom: "2026-01-15",
  issuedOn: "2026-01-01",
  locator: "Công báo số 1 ngày 2026-01-02",
  pdfUrl: "https://congbaocdn.chinhphu.vn/2026/1/1/test-signed.pdf",
  title: "Nghị định thử nghiệm",
};

const consistentLines: TextLine[] = [
  line("CHÍNH PHỦ"),
  line("Số: 01/2026/NĐ-TEST Hà Nội, ngày 01 tháng 01 năm 2026"),
  line("Điều 1. Phạm vi"),
  line("1. Khoản thứ nhất."),
  line("a) Điểm a."),
  line("b) Điểm b."),
  line("2. Khoản thứ hai."),
  line("Điều 2. Hiệu lực thi hành"),
  line("Nghị định này có hiệu lực thi hành kể từ ngày 15 tháng 01 năm 2026."),
];

function run(
  lines: readonly TextLine[],
  ref: CongBaoDocumentReference = reference,
  secondExtraction?: string | null,
) {
  const pdfText = pdfOf(lines);
  const { draft, report } = extractCongBaoDraft(pdfText, {
    datasetReleaseId: "rel_test",
    evidence: {
      locator: ref.locator,
      officialSourceUrl: ref.pdfUrl,
      retrievedAt: "2026-01-05T00:00:00.000Z",
      sourceSha256: "a".repeat(64),
    },
    reference: ref,
  });
  return crossCheckCongBao({
    draft,
    pdfText,
    reference: ref,
    report,
    ...(secondExtraction === undefined ? {} : { secondExtraction }),
  });
}

function statusOf(report: ReturnType<typeof run>, check: string): string {
  return report.results.find((result) => result.check === check)?.status ?? "missing";
}

describe("cross-checking a gazette document against its own page and body", () => {
  it("passes every check when page, PDF and extraction agree", () => {
    const secondReading = consistentLines.map((entry) => entry.text).join("\n");
    const report = run(consistentLines, reference, secondReading);
    expect(report.results.map((result) => [result.check, result.status])).toEqual([
      ["DOCUMENT_NUMBER", "pass"],
      ["ISSUE_DATE", "pass"],
      ["EFFECTIVE_DATE", "pass"],
      ["NUMBERING", "pass"],
      ["SECOND_EXTRACTOR", "pass"],
      ["CHARACTER_BALANCE", "pass"],
    ]);
    expect(report.allPassed).toBe(true);
  });

  it("flags a page whose effective date disagrees with the document's own words", () => {
    // The page operator typed one date; the signed document says another.
    // Two independent sources disagreeing is exactly what a person must see.
    const report = run(consistentLines, { ...reference, effectiveFrom: "2026-02-01" });
    expect(statusOf(report, "EFFECTIVE_DATE")).toBe("flag");
    expect(report.allPassed).toBe(false);
    expect(report.flagged).toContain("EFFECTIVE_DATE");
  });

  it("flags a document number that appears on the page but not in the PDF", () => {
    const report = run(consistentLines, { ...reference, documentNumber: "99/2026/NĐ-KHAC" });
    expect(statusOf(report, "DOCUMENT_NUMBER")).toBe("flag");
  });

  it("flags an issue date the PDF signing line contradicts", () => {
    const report = run(consistentLines, { ...reference, issuedOn: "2025-12-31" });
    expect(statusOf(report, "ISSUE_DATE")).toBe("flag");
  });

  it("reads 'kể từ ngày ký' as effective-equals-issued, and flags when the page says otherwise", () => {
    const lines = [
      ...consistentLines.slice(0, 7),
      line("Điều 2. Hiệu lực thi hành"),
      line("Quyết định này có hiệu lực thi hành kể từ ngày ký ban hành."),
    ];
    expect(
      statusOf(run(lines, { ...reference, effectiveFrom: "2026-01-01" }), "EFFECTIVE_DATE"),
    ).toBe("pass");
    expect(
      statusOf(run(lines, { ...reference, effectiveFrom: "2026-01-15" }), "EFFECTIVE_DATE"),
    ).toBe("flag");
  });

  it("flags a skipped clause and names the article, leaving the others clean", () => {
    const lines = [
      ...consistentLines.slice(0, 2),
      line("Điều 1. Phạm vi"),
      line("1. Khoản thứ nhất."),
      line("3. Khoản thứ ba - khoản 2 đã rơi."),
      line("Điều 2. Hiệu lực thi hành"),
      line("Nghị định này có hiệu lực thi hành kể từ ngày 15 tháng 01 năm 2026."),
    ];
    const report = run(lines);
    expect(statusOf(report, "NUMBERING")).toBe("flag");
    expect(report.flaggedProvisionVersionIds).toHaveLength(1);
    expect(report.flaggedProvisionVersionIds[0]).toContain("_d1_");
  });

  it("follows the Vietnamese point order a, b, c, d, đ, e, g - not ASCII", () => {
    const lines = [
      ...consistentLines.slice(0, 2),
      line("Điều 1. Phạm vi"),
      line("1. Khoản."),
      line("a) một"),
      line("b) hai"),
      line("c) ba"),
      line("d) bốn"),
      line("đ) năm"),
      line("e) sáu"),
      line("g) bảy"),
      line("Điều 2. Hiệu lực thi hành"),
      line("Nghị định này có hiệu lực thi hành kể từ ngày 15 tháng 01 năm 2026."),
    ];
    expect(statusOf(run(lines), "NUMBERING")).toBe("pass");
  });

  it("reports the second-extractor check as not available rather than passed when there is none", () => {
    const report = run(consistentLines);
    expect(statusOf(report, "SECOND_EXTRACTOR")).toBe("not_available");
    // Not available is not a pass: the document does not reach machine_checked.
    expect(report.allPassed).toBe(false);
    expect(report.notAvailable).toEqual(["SECOND_EXTRACTOR"]);
  });

  it("flags a second reading that dropped text", () => {
    const partial = consistentLines
      .slice(0, 5)
      .map((entry) => entry.text)
      .join("\n");
    expect(statusOf(run(consistentLines, reference, partial), "SECOND_EXTRACTOR")).toBe("flag");
  });

  it("accounts for every character of the source in some named bucket", () => {
    const report = run(consistentLines);
    expect(statusOf(report, "CHARACTER_BALANCE")).toBe("pass");
  });
});

describe("the two ways a Vietnamese date is written", () => {
  const slashForm: TextLine[] = [
    line("CHÍNH PHỦ"),
    line("Số: 01/2026/NĐ-TEST Hà Nội, ngày 01 tháng 01 năm 2026"),
    line("Điều 1. Phạm vi"),
    line("Nội dung của Điều 1."),
    line("Điều 2. Hiệu lực thi hành"),
    line("Nghị định này có hiệu lực thi hành kể từ ngày 15/01/2026."),
  ];

  // The date is written plainly on the page; reporting "no readable date" sent
  // the document to a human reviewer over a formatting difference.
  it("reads an effective date written as ngày dd/mm/yyyy", () => {
    expect(statusOf(run(slashForm), "EFFECTIVE_DATE")).toBe("pass");
  });

  it("still disagrees with the gazette when the slash date differs", () => {
    expect(
      statusOf(run(slashForm, { ...reference, effectiveFrom: "2026-02-01" }), "EFFECTIVE_DATE"),
    ).toBe("flag");
  });

  it("does not read a bare pair of numbers as a date", () => {
    const noDate = slashForm.with(
      5,
      line("Nghị định này có hiệu lực thi hành theo Điều 15/2026 của Luật A."),
    );
    expect(statusOf(run(noDate), "EFFECTIVE_DATE")).toBe("not_available");
  });
});

describe("finding the effective-date clause among sentences that merely mention it", () => {
  // "có hiệu lực" is ordinary Vietnamese. Taking the first line that contains it
  // read a sentence about the legal force of someone else's decision, found no
  // date, and reported a document whose date was stated plainly as unreadable.
  const buried: TextLine[] = [
    line("CHÍNH PHỦ"),
    line("Số: 01/2026/NĐ-TEST Hà Nội, ngày 01 tháng 01 năm 2026"),
    line("Điều 1. Phạm vi"),
    line("Áp dụng với kết luận, quyết định giải quyết đã có hiệu lực pháp luật."),
    line("Điều 2. Hiệu lực thi hành"),
    line("Nghị định này có hiệu lực thi hành kể từ ngày 15 tháng 01 năm 2026."),
  ];

  it("reads the clause that carries a date, not the first mention", () => {
    expect(statusOf(run(buried), "EFFECTIVE_DATE")).toBe("pass");
  });

  it("flags when no candidate line agrees with the gazette", () => {
    const report = run(buried, { ...reference, effectiveFrom: "2026-03-01" });
    expect(statusOf(report, "EFFECTIVE_DATE")).toBe("flag");
    expect(report.results.find((r) => r.check === "EFFECTIVE_DATE")?.detail).toContain(
      "2026-01-15",
    );
  });

  it("says how many candidates it read when none carries a date", () => {
    const noDate: TextLine[] = [
      line("CHÍNH PHỦ"),
      line("Số: 01/2026/NĐ-TEST Hà Nội, ngày 01 tháng 01 năm 2026"),
      line("Điều 1. Phạm vi"),
      line("Áp dụng với quyết định đã có hiệu lực pháp luật."),
      line("Điều 2. Thi hành"),
      line("Bản án đã có hiệu lực được thi hành theo quy định."),
    ];
    const report = run(noDate);
    expect(statusOf(report, "EFFECTIVE_DATE")).toBe("not_available");
    expect(report.results.find((r) => r.check === "EFFECTIVE_DATE")?.detail).toContain("2 câu");
  });
});

describe("clause numbering as the PDF prints it", () => {
  // A missing space after the number is typography, not a defect in the law.
  // Requiring one made the check skip the clause and report the article as
  // jumping from 1 to 3, which sent twenty-three good articles to a reviewer.
  it("counts a clause written without a space after its number", () => {
    const tight: TextLine[] = [
      line("CHÍNH PHỦ"),
      line("Số: 01/2026/NĐ-TEST Hà Nội, ngày 01 tháng 01 năm 2026"),
      line("Điều 1. Xử lý sự cố"),
      line("1. Khoản thứ nhất."),
      line("2.Khoản thứ hai viết sát số."),
      line("3. Khoản thứ ba."),
      line("Điều 2. Hiệu lực thi hành"),
      line("Nghị định này có hiệu lực thi hành kể từ ngày 15 tháng 01 năm 2026."),
    ];
    expect(statusOf(run(tight), "NUMBERING")).toBe("pass");
  });

  it("still reports a clause that is actually missing", () => {
    const gap: TextLine[] = [
      line("CHÍNH PHỦ"),
      line("Số: 01/2026/NĐ-TEST Hà Nội, ngày 01 tháng 01 năm 2026"),
      line("Điều 1. Xử lý sự cố"),
      line("1. Khoản thứ nhất."),
      line("3. Khoản thứ ba, khoản 2 biến mất."),
      line("Điều 2. Hiệu lực thi hành"),
      line("Nghị định này có hiệu lực thi hành kể từ ngày 15 tháng 01 năm 2026."),
    ];
    expect(statusOf(run(gap), "NUMBERING")).toBe("flag");
  });

  it("does not read a sub-heading like 2.1 as a clause", () => {
    const nested: TextLine[] = [
      line("CHÍNH PHỦ"),
      line("Số: 01/2026/NĐ-TEST Hà Nội, ngày 01 tháng 01 năm 2026"),
      line("Điều 1. Xử lý sự cố"),
      line("1. Khoản thứ nhất."),
      line("1.1. Mục con của khoản thứ nhất."),
      line("2. Khoản thứ hai."),
      line("Điều 2. Hiệu lực thi hành"),
      line("Nghị định này có hiệu lực thi hành kể từ ngày 15 tháng 01 năm 2026."),
    ];
    expect(statusOf(run(nested), "NUMBERING")).toBe("pass");
  });
});
