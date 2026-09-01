import { detectProvisionDrift, extractVbplDraft } from "@luatvn/ingest";
import { describe, expect, it } from "vitest";

const draftOptions = {
  datasetReleaseId: "rel_drill_drift1",
  evidence: {
    officialSourceUrl: "https://vbpl.vn/van-ban/chi-tiet/drill--doc-uuid-1",
    retrievedAt: "2026-09-01T00:00:00.000Z",
    sourceSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
};

function draftOf(paragraphs: readonly string[]) {
  const metadata = {
    docNum: "01/2020/TT-DRILL",
    effFrom: "2020-03-01T00:00:00",
    effTo: null,
    id: "doc-uuid-1",
    title: "Drill circular for drift tests",
  };
  const html = ["<html><body>", ...paragraphs, "</body></html>"].join("\n");
  const chunkLength = Buffer.byteLength(html, "utf8").toString(16);
  const flight = `0:["x",null]\n1:${JSON.stringify(metadata)}\n2:T${chunkLength},${html}\n`;
  return extractVbplDraft(flight, draftOptions).draft.provisionVersions;
}

const article = (id: string, text: string) =>
  `<p class="prov-article" id="${id}"><span><strong>${text}</strong></span></p>`;
const content = (id: string, text: string) =>
  `<p class="prov-content" id="${id}"><span>${text}</span></p>`;

const publishedBody = [
  article("p1", "Điều 1. Phạm vi"),
  content("p1", "Nội dung gốc."),
  article("p2", "Điều 2. Đối tượng"),
  content("p2", "Nội dung điều hai."),
];

describe("detectProvisionDrift", () => {
  it("reports nothing when the source still matches the release", () => {
    const published = draftOf(publishedBody);
    expect(detectProvisionDrift(published, draftOf(publishedBody))).toEqual([]);
  });

  it("names the provision whose text changed at the source", () => {
    const published = draftOf(publishedBody);
    const current = draftOf([
      article("p1", "Điều 1. Phạm vi"),
      content("p1", "Nội dung đã bị sửa."),
      article("p2", "Điều 2. Đối tượng"),
      content("p2", "Nội dung điều hai."),
    ]);
    const issues = detectProvisionDrift(published, current);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("PROVISION_CHANGED");
    expect(issues[0]?.message).toContain("Điều 1");
  });

  it("reports a provision that disappeared from the source", () => {
    const published = draftOf(publishedBody);
    const current = draftOf([article("p1", "Điều 1. Phạm vi"), content("p1", "Nội dung gốc.")]);
    const issues = detectProvisionDrift(published, current);
    expect(issues.map((issue) => issue.code)).toEqual(["PROVISION_MISSING_AT_SOURCE"]);
  });

  it("reports a provision the source added after publication", () => {
    const published = draftOf([article("p1", "Điều 1. Phạm vi"), content("p1", "Nội dung gốc.")]);
    const issues = detectProvisionDrift(published, draftOf(publishedBody));
    expect(issues.map((issue) => issue.code)).toEqual(["PROVISION_ADDED_AT_SOURCE"]);
  });
});
