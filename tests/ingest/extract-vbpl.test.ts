import { extractVbplDraft, VbplExtractError, vbplDocumentIdFromUrl } from "@luatvn/ingest";
import { sha256HexOfText } from "@luatvn/manual-dataset";
import { describe, expect, it } from "vitest";

const drillEvidence = {
  officialSourceUrl: "https://vbpl.vn/van-ban/chi-tiet/drill--doc-uuid-1",
  retrievedAt: "2026-09-01T00:00:00.000Z",
  sourceSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

interface FlightOverrides {
  readonly effFrom?: string | null;
  readonly docNum?: string | null;
}

function drillFlight(overrides: FlightOverrides = {}): string {
  const metadata: Record<string, unknown> = {
    docType: { code: "TT", name: "Thông tư" },
    effFrom: overrides.effFrom === undefined ? "2020-03-01T00:00:00" : overrides.effFrom,
    effStatus: { code: "CHL", name: "Còn hiệu lực" },
    effTo: null,
    id: "doc-uuid-1",
    issueDate: "2020-01-15T00:00:00",
    key: "doc-uuid-1",
    status: "Publish",
    title: "Drill circular for extraction tests",
  };
  if (overrides.docNum !== null) {
    metadata["docNum"] = overrides.docNum ?? "01/2020/TT-DRILL";
  }
  const html = [
    "<html><body><div>",
    '<p class="prov-article" id="prov-uuid-1" style="margin:0"><span><strong>Điều 1. Phạm vi drill</strong></span></p>',
    '<p class="prov-content" style="margin:0" id="prov-uuid-1"><span>Đoạn một drill &amp; thử nghiệm.</span></p>',
    '<p class="prov-content" id="prov-uuid-1"><span>Đoạn hai có&nbsp;khoảng trắng.</span></p>',
    '<p class="prov-article" id="prov-uuid-2"><span><strong>Điều 2. Hiệu lực drill</strong></span></p>',
    '<p class="prov-content" id="prov-uuid-2"><span>Nội dung điều hai.</span></p>',
    "</div></body></html>",
  ].join("\n");
  const chunkLength = Buffer.byteLength(html, "utf8").toString(16);
  return `0:["$@1",["drill-build",null]]\n1:${JSON.stringify(metadata)}\n2:T${chunkLength},${html}\n`;
}

describe("extractVbplDraft", () => {
  it("extracts under_review provisions with metadata-sourced validity", () => {
    const { draft, report } = extractVbplDraft(drillFlight(), {
      datasetReleaseId: "rel_drill_extract1",
      evidence: drillEvidence,
    });

    expect(report.documentNumber).toBe("01/2020/TT-DRILL");
    expect(report.effectiveFrom).toBe("2020-03-01");
    expect(report.provisionCount).toBe(2);
    expect(draft.datasetReleaseId).toBe("rel_drill_extract1");

    const [first, second] = draft.provisionVersions;
    expect(first?.provisionId).toBe("prov_vbpl_prov-uuid-1");
    expect(first?.provisionVersionId).toBe("pv_vbpl_prov-uuid-1_e20200301");
    expect(first?.reviewStatus).toBe("under_review");
    expect(first?.heading).toBe("Điều 1. Phạm vi drill");
    expect(first?.legalText).toBe("Đoạn một drill & thử nghiệm.\nĐoạn hai có khoảng trắng.");
    expect(first?.legalTextSha256).toBe(sha256HexOfText(first?.legalText ?? ""));
    expect(first?.validTime).toEqual({ from: "2020-03-01", to: null });
    expect(first?.systemTime).toEqual({ from: drillEvidence.retrievedAt, to: null });
    expect(first?.evidence[0]?.locator).toBe("prov-article prov-uuid-1");
    expect(second?.provisionId).toBe("prov_vbpl_prov-uuid-2");
  });

  it("handles multibyte text in the length-prefixed body chunk", () => {
    const { draft } = extractVbplDraft(drillFlight(), {
      datasetReleaseId: "rel_drill_extract1",
      evidence: drillEvidence,
    });
    expect(draft.provisionVersions[1]?.legalText).toBe("Nội dung điều hai.");
  });

  it("refuses to invent an effective date", () => {
    expect(() =>
      extractVbplDraft(drillFlight({ effFrom: null }), {
        datasetReleaseId: "rel_drill_extract1",
        evidence: drillEvidence,
      }),
    ).toThrowError(VbplExtractError);
    try {
      extractVbplDraft(drillFlight({ effFrom: null }), {
        datasetReleaseId: "rel_drill_extract1",
        evidence: drillEvidence,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(VbplExtractError);
      if (error instanceof VbplExtractError) {
        expect(error.code).toBe("EFFECTIVE_DATE_MISSING");
      }
    }
  });

  it("fails when the payload has no document metadata", () => {
    try {
      extractVbplDraft(drillFlight({ docNum: null }), {
        datasetReleaseId: "rel_drill_extract1",
        evidence: drillEvidence,
      });
      throw new Error("Expected extraction to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(VbplExtractError);
      if (error instanceof VbplExtractError) {
        expect(error.code).toBe("METADATA_NOT_FOUND");
      }
    }
  });
});

describe("vbplDocumentIdFromUrl", () => {
  it("takes the id after the final double dash", () => {
    expect(vbplDocumentIdFromUrl("https://vbpl.vn/van-ban/chi-tiet/slug-a--uuid-1")).toBe("uuid-1");
  });

  it("takes the whole last segment for plain ids", () => {
    expect(vbplDocumentIdFromUrl("https://vbpl.vn/van-ban/chi-tiet/166338")).toBe("166338");
  });
});
