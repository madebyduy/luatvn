import {
  parseProvisionId,
  parseProvisionVersionId,
  type PublishedProvisionVersion,
} from "@luatvn/domain";
import { proposeApplicability } from "@luatvn/ingest";
import {
  decodeManualDatasetFile,
  sha256HexOfText,
  validateReleaseForPublish,
} from "@luatvn/manual-dataset";
import { describe, expect, it } from "vitest";

import { syntheticReleaseId, syntheticVersionOne } from "../fixtures/synthetic-legal-data.js";

// Placeholder wording shaped like a scope article. Never real legal content.
function version(overrides: {
  readonly heading: string;
  readonly legalText: string;
  readonly provisionId: string;
  readonly provisionVersionId: string;
}): PublishedProvisionVersion {
  return Object.assign({}, syntheticVersionOne, {
    heading: overrides.heading,
    legalText: overrides.legalText,
    legalTextSha256: sha256HexOfText(overrides.legalText),
    provisionId: parseProvisionId(overrides.provisionId),
    provisionVersionId: parseProvisionVersionId(overrides.provisionVersionId),
  });
}

const scope = version({
  heading: "Điều 2. Đối tượng áp dụng",
  legalText:
    "Điều 2. Đối tượng áp dụng\n1. Doanh nghiệp cung cấp dịch vụ viễn thông trong nước.\n2. Hộ kinh doanh có doanh thu trên 100 triệu đồng một năm.\nCác trường hợp khác theo quy định.",
  provisionId: "prov_synthetic_scope",
  provisionVersionId: "pv_synthetic_scope_v1",
});
const other = version({
  heading: "Điều 3. Giải thích từ ngữ",
  legalText: "Điều 3. Giải thích từ ngữ\n1. Thuật ngữ một.",
  provisionId: "prov_synthetic_terms",
  provisionVersionId: "pv_synthetic_terms_v1",
});

function draftOf(versions: readonly PublishedProvisionVersion[]) {
  const decoded = decodeManualDatasetFile({
    amendments: [],
    datasetReleaseId: syntheticReleaseId,
    provisionVersions: versions,
    schemaVersion: 1,
  });
  if (!decoded.ok) throw new Error("fixture draft invalid");
  return decoded.value;
}

describe("proposing applicability conditions from the scope article", () => {
  it("quotes each numbered clause of 'Đối tượng áp dụng' as one under_review condition", () => {
    const { conditions, report } = proposeApplicability(draftOf([scope, other]));
    expect(report.proposed).toBe(2);
    expect(conditions.map((condition) => condition.condition)).toEqual([
      "Doanh nghiệp cung cấp dịch vụ viễn thông trong nước.",
      "Hộ kinh doanh có doanh thu trên 100 triệu đồng một năm.",
    ]);
    for (const condition of conditions) {
      expect(condition.reviewStatus).toBe("under_review");
      expect(condition.provisionId).toBe("prov_synthetic_scope");
      expect(condition.evidence).toHaveLength(1);
      expect(condition.subject.length).toBeGreaterThan(0);
    }
  });

  it("proposes nothing from articles that are not the scope article", () => {
    const { conditions } = proposeApplicability(draftOf([other]));
    expect(conditions).toEqual([]);
  });

  it("reports a scope article it could not split rather than inventing a condition", () => {
    const prose = version({
      heading: "Điều 2. Đối tượng áp dụng",
      legalText: "Điều 2. Đối tượng áp dụng\nNghị định này áp dụng cho mọi tổ chức, cá nhân.",
      provisionId: "prov_synthetic_scope",
      provisionVersionId: "pv_synthetic_scope_v2",
    });
    const { conditions, report } = proposeApplicability(draftOf([prose]));
    expect(conditions).toEqual([]);
    expect(report.scopeArticlesWithoutClauses).toEqual(["pv_synthetic_scope_v2"]);
  });
});

describe("applicability conditions in the dataset file", () => {
  it("decodes conditions and defaults to none when absent", () => {
    const draft = draftOf([scope]);
    expect(draft.applicability).toEqual([]);
  });

  it("refuses a condition that points at a provision not in the file", () => {
    const { conditions } = proposeApplicability(draftOf([scope]));
    const decoded = decodeManualDatasetFile({
      amendments: [],
      applicability: conditions.map((condition) =>
        Object.assign({}, condition, { provisionId: "prov_synthetic_missing" }),
      ),
      datasetReleaseId: syntheticReleaseId,
      provisionVersions: [scope],
      schemaVersion: 1,
    });
    expect(decoded.ok).toBe(false);
  });

  it("does not publish an under_review condition, and has no machine tier for it", () => {
    const { conditions } = proposeApplicability(draftOf([scope]));
    const verifiedScope = Object.assign({}, scope, { reviewStatus: "verified" as const });
    const decoded = decodeManualDatasetFile({
      amendments: [],
      applicability: conditions,
      datasetReleaseId: syntheticReleaseId,
      provisionVersions: [verifiedScope],
      schemaVersion: 1,
    });
    if (!decoded.ok) throw new Error("fixture invalid");
    const issues = validateReleaseForPublish(decoded.value, {
      allowedHosts: ["example.invalid"],
      now: syntheticVersionOne.systemTime.from,
    });
    expect(issues.some((issue) => issue.locator.startsWith("applicability["))).toBe(true);
    expect(issues.some((issue) => issue.message.includes("verified by a person"))).toBe(true);
  });
});
