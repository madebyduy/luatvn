import {
  parseAmendmentId,
  parseDatasetReleaseId,
  parseDocumentId,
  parseEvidenceId,
  parseIsoInstant,
  parseLegalDate,
  parseProvisionId,
  parseProvisionVersionId,
  type AmendmentRelation,
  type PublishedProvisionVersion,
} from "@luatvn/domain";

export const syntheticReleaseId = parseDatasetReleaseId("rel_synthetic_001");
export const syntheticProvisionId = parseProvisionId("prov_synthetic_alpha");

const evidence = {
  evidenceId: parseEvidenceId("ev_synthetic_alpha"),
  officialSourceUrl: "https://example.invalid/synthetic-evidence",
  sourceSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  retrievedAt: parseIsoInstant("2026-08-31T00:00:00.000Z"),
  locator: "synthetic-page-1",
} as const;

export const syntheticVersionOne: PublishedProvisionVersion = {
  documentId: parseDocumentId("doc_synthetic_law"),
  provisionId: syntheticProvisionId,
  provisionVersionId: parseProvisionVersionId("pv_synthetic_alpha_v1"),
  datasetReleaseId: syntheticReleaseId,
  documentNumber: "SYNTHETIC-ONLY",
  heading: "Synthetic provision",
  legalText: "Synthetic line one\nSynthetic old line",
  legalTextSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  validTime: {
    from: parseLegalDate("2020-01-01"),
    to: parseLegalDate("2024-01-01"),
  },
  systemTime: {
    from: parseIsoInstant("2026-08-31T00:00:00.000Z"),
    to: null,
  },
  reviewStatus: "verified",
  primaryEvidenceId: evidence.evidenceId,
  evidence: [evidence],
};

export const syntheticVersionTwo: PublishedProvisionVersion = {
  ...syntheticVersionOne,
  provisionVersionId: parseProvisionVersionId("pv_synthetic_alpha_v2"),
  legalText: "Synthetic line one\nSynthetic new line",
  legalTextSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  validTime: {
    from: parseLegalDate("2024-01-01"),
    to: null,
  },
};

export const syntheticAmendment: AmendmentRelation = {
  amendmentId: parseAmendmentId("amd_synthetic_alpha"),
  sourceProvisionId: parseProvisionId("prov_synthetic_amending"),
  targetProvisionId: syntheticProvisionId,
  effectiveFrom: parseLegalDate("2024-01-01"),
  relationType: "amends",
  reviewStatus: "verified",
  evidence: [evidence],
};
