import {
  parseDatasetReleaseId,
  parseDocumentId,
  parseEvidenceId,
  parseIsoInstant,
  parseLegalDate,
  parseProvisionId,
  parseProvisionVersionId,
  type EvidenceReference,
  type PublishedProvisionVersion,
} from "@luatvn/domain";
import {
  articleNumberOf,
  linkAmendments,
  referencedArticleNumber,
  relationEvidenceFrom,
} from "@luatvn/ingest";
import { sha256HexOfText } from "@luatvn/manual-dataset";
import { describe, expect, it } from "vitest";

const evidence: readonly [EvidenceReference, ...EvidenceReference[]] = [
  {
    evidenceId: parseEvidenceId("ev_vbplrel_drill"),
    locator: "luoc-do relations payload",
    officialSourceUrl: "https://vbpl.vn/van-ban/chi-tiet/drill",
    retrievedAt: parseIsoInstant("2026-09-01T00:00:00.000Z"),
    sourceSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
];

function provision(uuid: string, heading: string): PublishedProvisionVersion {
  const legalText = `Nội dung ${uuid}`;
  return {
    datasetReleaseId: parseDatasetReleaseId("rel_drill_link1"),
    documentId: parseDocumentId("doc_vbpl_drill"),
    documentNumber: "01/2020/TT-DRILL",
    evidence,
    heading,
    legalText,
    legalTextSha256: sha256HexOfText(legalText),
    primaryEvidenceId: evidence[0].evidenceId,
    provisionId: parseProvisionId(`prov_vbpl_${uuid}`),
    provisionVersionId: parseProvisionVersionId(`pv_vbpl_${uuid}_e20200301`),
    reviewStatus: "under_review",
    systemTime: { from: parseIsoInstant("2026-09-01T00:00:00.000Z"), to: null },
    validTime: { from: parseLegalDate("2020-03-01"), to: null },
  };
}

const linkInput = {
  amendingProvisions: [
    provision("src1", "Điều 1. Sửa đổi, bổ sung khoản 1 Điều 2"),
    provision("src2", "Điều 2. Bổ sung điểm b1 vào sau điểm b khoản 1 Điều 5"),
    provision("src3", "Điều 3. Trách nhiệm tổ chức thực hiện"),
    provision("src4", "Điều 4. Điều khoản thi hành"),
    provision("src5", "Điều 5. Sửa đổi Điều 99"),
  ],
  effectiveFrom: parseLegalDate("2026-10-13"),
  evidence,
  relationType: "amends" as const,
  targetProvisions: [
    provision("tgt2", "Điều 2. Đối tượng áp dụng"),
    provision("tgt5", "Điều 5. Nguyên tắc xác lập seri"),
  ],
};

describe("referencedArticleNumber", () => {
  it("finds the amended article after stripping the provision's own number", () => {
    expect(referencedArticleNumber("Điều 1. Sửa đổi, bổ sung khoản 1 Điều 2")).toBe(2);
    expect(referencedArticleNumber("Điều 2. Bổ sung điểm b1 vào sau điểm b khoản 1 Điều 5")).toBe(
      5,
    );
  });

  it("returns nothing for wording that names no numbered article", () => {
    expect(referencedArticleNumber("Điều 5. Điều khoản thi hành")).toBeNull();
    expect(referencedArticleNumber("Điều 4. Trách nhiệm tổ chức thực hiện")).toBeNull();
  });
});

describe("articleNumberOf", () => {
  it("reads a provision's own article number", () => {
    expect(articleNumberOf("Điều 12. Hiệu lực")).toBe(12);
    expect(articleNumberOf("Chương I")).toBeNull();
    expect(articleNumberOf(null)).toBeNull();
  });
});

describe("linkAmendments", () => {
  it("links only provisions whose referenced article exists in the target", () => {
    const { amendments } = linkAmendments(linkInput);
    expect(amendments).toHaveLength(2);
    expect(amendments[0]?.sourceProvisionId).toBe("prov_vbpl_src1");
    expect(amendments[0]?.targetProvisionId).toBe("prov_vbpl_tgt2");
    expect(amendments[0]?.relationType).toBe("amends");
    expect(amendments[0]?.effectiveFrom).toBe("2026-10-13");
    expect(amendments[1]?.targetProvisionId).toBe("prov_vbpl_tgt5");
    expect(amendments.every((amendment) => amendment.reviewStatus === "under_review")).toBe(true);
  });

  it("reports every provision it refused to link", () => {
    const { unlinked } = linkAmendments(linkInput);
    expect(unlinked).toHaveLength(3);
    expect(unlinked.filter((entry) => entry.reason.includes("no target article"))).toHaveLength(2);
    expect(unlinked.some((entry) => entry.reason.includes("Điều 99"))).toBe(true);
  });

  it("keeps amendment ids unique per source/target pair", () => {
    const repeated = provision("src1", "Điều 1. Sửa đổi, bổ sung khoản 1 Điều 2");
    const duplicated = { ...linkInput, amendingProvisions: [repeated, repeated] };
    const { amendments, unlinked } = linkAmendments(duplicated);
    expect(amendments).toHaveLength(1);
    expect(unlinked.some((entry) => entry.reason.includes("duplicate"))).toBe(true);
  });
});

describe("relationEvidenceFrom", () => {
  it("carries the relation payload url, hash and retrieval time", () => {
    const built = relationEvidenceFrom({
      officialSourceUrl: "https://vbpl.vn/van-ban/chi-tiet/abc",
      retrievedAt: "2026-09-01T10:00:00.000Z",
      sourceDocumentId: "abc",
      sourceSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    expect(built[0].evidenceId).toBe("ev_vbplrel_abc");
    expect(built[0].locator).toBe("luoc-do relations payload");
    expect(built[0].retrievedAt).toBe("2026-09-01T10:00:00.000Z");
  });
});
