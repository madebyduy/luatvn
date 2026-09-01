import { checkArticleNumbering, checkExtraction, extractVbplDraft } from "@luatvn/ingest";
import { describe, expect, it } from "vitest";

const drillEvidence = {
  officialSourceUrl: "https://vbpl.vn/van-ban/chi-tiet/drill--doc-uuid-1",
  retrievedAt: "2026-09-01T00:00:00.000Z",
  sourceSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const draftOptions = { datasetReleaseId: "rel_drill_assure1", evidence: drillEvidence };

function flightWith(bodyParagraphs: readonly string[]): string {
  const metadata = {
    docNum: "01/2020/TT-DRILL",
    effFrom: "2020-03-01T00:00:00",
    effTo: null,
    id: "doc-uuid-1",
    title: "Drill circular for assurance tests",
  };
  const html = ["<html><body><div>", ...bodyParagraphs, "</div></body></html>"].join("\n");
  const chunkLength = Buffer.byteLength(html, "utf8").toString(16);
  return `0:["$@1",["drill",null]]\n1:${JSON.stringify(metadata)}\n2:T${chunkLength},${html}\n`;
}

const article = (id: string, text: string) =>
  `<p class="prov-article" id="${id}"><span><strong>${text}</strong></span></p>`;
const content = (id: string, text: string) =>
  `<p class="prov-content" id="${id}"><span>${text}</span></p>`;

const fullBody = [
  article("p1", "Điều 1. Phạm vi"),
  content("p1", "Nội dung điều một."),
  content("p1", "Đoạn thứ hai của điều một."),
  article("p2", "Điều 2. Đối tượng"),
  content("p2", "Nội dung điều hai."),
];

describe("checkExtraction", () => {
  it("passes when every source paragraph is present in the extraction", () => {
    const flight = flightWith(fullBody);
    const { draft } = extractVbplDraft(flight, draftOptions);
    expect(checkExtraction(flight, draft.provisionVersions)).toEqual([]);
  });

  it("reports source text that no extracted provision covers", () => {
    const flight = flightWith(fullBody);
    const { draft } = extractVbplDraft(flight, draftOptions);
    const withoutSecondArticle = draft.provisionVersions.filter(
      (provision) => provision.provisionId !== "prov_vbpl_p2",
    );
    const issues = checkExtraction(flight, withoutSecondArticle);
    expect(issues.some((issue) => issue.code === "UNCOVERED_SOURCE_PARAGRAPH")).toBe(true);
    expect(issues.some((issue) => issue.message.includes("Điều 2"))).toBe(true);
  });

  it("reports a truncated provision because its tail is no longer covered", () => {
    const flight = flightWith(fullBody);
    const { draft } = extractVbplDraft(flight, draftOptions);
    const truncated = draft.provisionVersions.map((provision) =>
      provision.provisionId === "prov_vbpl_p1"
        ? Object.assign({}, provision, { legalText: "Nội dung điều một." })
        : provision,
    );
    const issues = checkExtraction(flight, truncated);
    expect(issues.map((issue) => issue.code)).toContain("UNCOVERED_SOURCE_PARAGRAPH");
    expect(issues.some((issue) => issue.message.includes("Đoạn thứ hai"))).toBe(true);
  });
});

describe("checkArticleNumbering", () => {
  it("accepts contiguous article numbers", () => {
    const { draft } = extractVbplDraft(flightWith(fullBody), draftOptions);
    expect(checkArticleNumbering(draft.provisionVersions)).toEqual([]);
  });

  it("reports a gap that suggests a dropped article", () => {
    const { draft } = extractVbplDraft(
      flightWith([
        article("p1", "Điều 1. Phạm vi"),
        content("p1", "Nội dung điều một."),
        article("p5", "Điều 5. Hiệu lực"),
        content("p5", "Nội dung điều năm."),
      ]),
      draftOptions,
    );
    const issues = checkArticleNumbering(draft.provisionVersions);
    expect(issues.map((issue) => issue.code)).toEqual(["ARTICLE_NUMBER_GAP"]);
    expect(issues[0]?.message).toContain("1 to 5");
  });

  it("reports a heading that carries no article number", () => {
    const { draft } = extractVbplDraft(
      flightWith([article("p1", "Chương I. Quy định chung"), content("p1", "Nội dung.")]),
      draftOptions,
    );
    const issues = checkArticleNumbering(draft.provisionVersions);
    expect(issues.map((issue) => issue.code)).toEqual(["UNNUMBERED_ARTICLE"]);
  });

  it("flags a repeated number so a reviewer can judge an inserted article", () => {
    const { draft } = extractVbplDraft(
      flightWith([
        article("p3", "Điều 3. Nguyên tắc"),
        content("p3", "Nội dung điều ba."),
        article("p3a", "Điều 3a. Bổ sung"),
        content("p3a", "Nội dung điều ba a."),
      ]),
      draftOptions,
    );
    const issues = checkArticleNumbering(draft.provisionVersions);
    expect(issues.map((issue) => issue.code)).toEqual(["DUPLICATE_ARTICLE_NUMBER"]);
  });
});
