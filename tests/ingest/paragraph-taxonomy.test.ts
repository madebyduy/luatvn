import { checkExtraction, extractVbplDraft, sourceProvisionParagraphs } from "@luatvn/ingest";
import { describe, expect, it } from "vitest";

const draftOptions = {
  datasetReleaseId: "rel_drill_taxonomy",
  evidence: {
    officialSourceUrl: "https://vbpl.vn/van-ban/chi-tiet/drill--doc-uuid-1",
    retrievedAt: "2026-09-01T00:00:00.000Z",
    sourceSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
};

function flightWith(paragraphs: readonly string[]): string {
  const metadata = {
    docNum: "01/2020/TT-DRILL",
    effFrom: "2020-03-01T00:00:00",
    effTo: null,
    id: "doc-uuid-1",
    title: "Drill document for paragraph taxonomy",
  };
  const html = ["<html><body>", ...paragraphs, "</body></html>"].join("\n");
  const chunkLength = Buffer.byteLength(html, "utf8").toString(16);
  return `0:["x",null]\n1:${JSON.stringify(metadata)}\n2:T${chunkLength},${html}\n`;
}

const paragraph = (className: string, id: string, text: string) =>
  `<p class="${className}" id="${id}"><span>${text}</span></p>`;

// Reproduces the defect found on 2026-09-01: a real law puts most of its text in
// prov-clause and prov-item paragraphs, which the first extractor ignored.
const layeredBody = [
  paragraph("prov-chapter", "c1", "Chương I. QUY ĐỊNH CHUNG"),
  paragraph("prov-article", "a17", "Điều 17. Quyền thành lập doanh nghiệp"),
  paragraph("prov-clause", "a17k1", "1. Tổ chức, cá nhân có quyền thành lập doanh nghiệp."),
  paragraph("prov-item", "a17k2a", "a) Cơ quan nhà nước sử dụng tài sản công;"),
  paragraph("prov-item", "a17k2b", "b) Cán bộ, công chức theo quy định của pháp luật;"),
  paragraph("prov-content", "a17note", "Nội dung bổ trợ của điều 17."),
  paragraph("prov-section", "s1", "Mục 2. ĐĂNG KÝ DOANH NGHIỆP"),
  paragraph("prov-article", "a18", "Điều 18. Hồ sơ đăng ký"),
  paragraph("prov-clause", "a18k1", "1. Giấy đề nghị đăng ký doanh nghiệp."),
];

describe("provision paragraph taxonomy", () => {
  it("captures clause and item text, not only article and content paragraphs", () => {
    const { draft } = extractVbplDraft(flightWith(layeredBody), draftOptions);
    const article17 = draft.provisionVersions.find(
      (provision) => provision.provisionId === "prov_vbpl_a17",
    );
    expect(article17?.legalText).toContain("1. Tổ chức, cá nhân có quyền thành lập doanh nghiệp.");
    expect(article17?.legalText).toContain("a) Cơ quan nhà nước sử dụng tài sản công;");
    expect(article17?.legalText).toContain("b) Cán bộ, công chức theo quy định của pháp luật;");
    expect(article17?.legalText).toContain("Nội dung bổ trợ của điều 17.");
  });

  it("keeps chapter and section headings out of provision text", () => {
    const { draft } = extractVbplDraft(flightWith(layeredBody), draftOptions);
    for (const provision of draft.provisionVersions) {
      expect(provision.legalText).not.toContain("Chương I");
      expect(provision.legalText).not.toContain("Mục 2");
    }
  });

  it("does not leak the next article's clauses into the previous article", () => {
    const { draft } = extractVbplDraft(flightWith(layeredBody), draftOptions);
    const article17 = draft.provisionVersions.find(
      (provision) => provision.provisionId === "prov_vbpl_a17",
    );
    expect(article17?.legalText).not.toContain("Giấy đề nghị đăng ký doanh nghiệp.");
  });

  it("passes assurance on a layered document", () => {
    const flight = flightWith(layeredBody);
    const { draft } = extractVbplDraft(flight, draftOptions);
    expect(checkExtraction(flight, draft.provisionVersions)).toEqual([]);
  });

  it("covers a paragraph that the source split with a line break", () => {
    const body = [
      paragraph("prov-article", "a1", "Điều 1. Phạm vi"),
      `<p class="prov-clause" id="a1k1"><span>1. Dòng đầu.<br>Dòng sau.</span></p>`,
    ];
    const flight = flightWith(body);
    const { draft } = extractVbplDraft(flight, draftOptions);
    expect(checkExtraction(flight, draft.provisionVersions)).toEqual([]);
  });

  it("keeps text of an unclassified prov class and reports the class", () => {
    const body = [
      paragraph("prov-article", "a1", "Điều 1. Phạm vi"),
      paragraph("prov-appendix", "a1x", "Nội dung thuộc lớp chưa biết."),
    ];
    const flight = flightWith(body);
    const { draft } = extractVbplDraft(flight, draftOptions);
    expect(draft.provisionVersions[0]?.legalText).toContain("Nội dung thuộc lớp chưa biết.");

    const issues = checkExtraction(flight, draft.provisionVersions);
    expect(issues.map((issue) => issue.code)).toEqual(["UNKNOWN_PARAGRAPH_CLASS"]);
    expect(issues[0]?.message).toContain("prov-appendix");
  });

  it("exposes the source paragraphs with their class and role", () => {
    const paragraphs = sourceProvisionParagraphs(flightWith(layeredBody));
    expect(
      paragraphs.filter((entry) => entry.role === "structure").map((e) => e.className),
    ).toEqual(["prov-chapter", "prov-section"]);
    expect(paragraphs.filter((entry) => entry.role === "article")).toHaveLength(2);
    expect(paragraphs.filter((entry) => entry.role === "content")).toHaveLength(5);
  });
});
