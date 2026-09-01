import type { AmendmentRelation, PublishedProvisionVersion } from "@luatvn/domain";
import { decodeManualDatasetFile, decodeReleaseManifest } from "@luatvn/manual-dataset";
import { describe, expect, it } from "vitest";

import {
  syntheticAmendment,
  syntheticReleaseId,
  syntheticVersionOne,
  syntheticVersionTwo,
} from "../fixtures/synthetic-legal-data.js";

interface EvidenceInput {
  evidenceId: string;
  locator: string | null;
  officialSourceUrl: string;
  retrievedAt: string;
  sourceSha256: string;
  [key: string]: unknown;
}

interface IntervalInput {
  from: string;
  to: string | null;
  [key: string]: unknown;
}

interface ProvisionVersionInput {
  datasetReleaseId: string;
  documentId: string;
  documentNumber: string;
  evidence: EvidenceInput[];
  heading: string | null;
  legalText: string;
  legalTextSha256: string;
  primaryEvidenceId: string;
  provisionId: string;
  provisionVersionId: string;
  reviewStatus: string;
  systemTime: IntervalInput;
  validTime: IntervalInput;
  [key: string]: unknown;
}

interface AmendmentInput {
  amendmentId: string;
  effectiveFrom: string;
  evidence: EvidenceInput[];
  relationType: string;
  reviewStatus: string;
  sourceProvisionId: string;
  targetProvisionId: string;
  [key: string]: unknown;
}

interface DatasetFileInput {
  schemaVersion: number;
  datasetReleaseId: string;
  provisionVersions: ProvisionVersionInput[];
  amendments: AmendmentInput[];
  [key: string]: unknown;
}

function provisionVersionInputFrom(version: PublishedProvisionVersion): ProvisionVersionInput {
  return {
    datasetReleaseId: version.datasetReleaseId,
    documentId: version.documentId,
    documentNumber: version.documentNumber,
    evidence: version.evidence.map((evidence) => ({ ...evidence })),
    heading: version.heading,
    legalText: version.legalText,
    legalTextSha256: version.legalTextSha256,
    primaryEvidenceId: version.primaryEvidenceId,
    provisionId: version.provisionId,
    provisionVersionId: version.provisionVersionId,
    reviewStatus: version.reviewStatus,
    systemTime: { ...version.systemTime },
    validTime: { ...version.validTime },
  };
}

function amendmentInputFrom(amendment: AmendmentRelation): AmendmentInput {
  return {
    amendmentId: amendment.amendmentId,
    effectiveFrom: amendment.effectiveFrom,
    evidence: amendment.evidence.map((evidence) => ({ ...evidence })),
    relationType: amendment.relationType,
    reviewStatus: amendment.reviewStatus,
    sourceProvisionId: amendment.sourceProvisionId,
    targetProvisionId: amendment.targetProvisionId,
  };
}

function syntheticDatasetFileInput(): DatasetFileInput {
  return {
    schemaVersion: 1,
    datasetReleaseId: syntheticReleaseId,
    provisionVersions: [
      provisionVersionInputFrom(syntheticVersionOne),
      provisionVersionInputFrom(syntheticVersionTwo),
    ],
    amendments: [amendmentInputFrom(syntheticAmendment)],
  };
}

function firstVersionOf(input: DatasetFileInput): ProvisionVersionInput {
  const version = input.provisionVersions[0];
  if (version === undefined) {
    throw new Error("Synthetic dataset input must contain a first version");
  }
  return version;
}

function expectRejectedAt(input: DatasetFileInput, pathPrefix: string): void {
  const result = decodeManualDatasetFile(input);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected the dataset file to be rejected");
  }
  expect(result.issues.some((issue) => issue.path.startsWith(pathPrefix))).toBe(true);
}

describe("manual dataset file schema", () => {
  it("decodes a fully provenanced synthetic dataset file", () => {
    const result = decodeManualDatasetFile(syntheticDatasetFileInput());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected the synthetic dataset file to decode");
    }
    expect(result.value.datasetReleaseId).toBe(syntheticReleaseId);
    expect(result.value.provisionVersions).toHaveLength(2);
    expect(result.value.amendments).toHaveLength(1);
    expect(result.value.provisionVersions[0]?.evidence).toHaveLength(1);
  });

  it("rejects a record without evidence", () => {
    const input = syntheticDatasetFileInput();
    firstVersionOf(input).evidence = [];
    expectRejectedAt(input, "provisionVersions.0.evidence");
  });

  it("rejects unknown public fields", () => {
    const input = syntheticDatasetFileInput();
    firstVersionOf(input)["draftNote"] = "must not pass";
    expectRejectedAt(input, "provisionVersions.0");
  });

  it("rejects a primary evidence pointer without a matching evidence entry", () => {
    const input = syntheticDatasetFileInput();
    firstVersionOf(input).primaryEvidenceId = "ev_synthetic_missing";
    expectRejectedAt(input, "provisionVersions.0.primaryEvidenceId");
  });

  it("rejects an impossible calendar date in the valid interval", () => {
    const input = syntheticDatasetFileInput();
    firstVersionOf(input).validTime.from = "2020-02-30";
    expectRejectedAt(input, "provisionVersions.0.validTime.from");
  });

  it("rejects an empty valid interval", () => {
    const input = syntheticDatasetFileInput();
    const version = firstVersionOf(input);
    version.validTime.from = "2024-01-01";
    version.validTime.to = "2024-01-01";
    expectRejectedAt(input, "provisionVersions.0.validTime");
  });

  it("rejects a malformed evidence SHA-256", () => {
    const input = syntheticDatasetFileInput();
    const evidence = firstVersionOf(input).evidence[0];
    if (evidence === undefined) {
      throw new Error("Synthetic version must contain evidence");
    }
    evidence.sourceSha256 = "NOT-A-HASH";
    expectRejectedAt(input, "provisionVersions.0.evidence.0.sourceSha256");
  });

  it("rejects a non-https evidence source URL", () => {
    const input = syntheticDatasetFileInput();
    const evidence = firstVersionOf(input).evidence[0];
    if (evidence === undefined) {
      throw new Error("Synthetic version must contain evidence");
    }
    evidence.officialSourceUrl = "http://example.invalid/synthetic-evidence";
    expectRejectedAt(input, "provisionVersions.0.evidence.0.officialSourceUrl");
  });

  it("rejects a record belonging to another dataset release", () => {
    const input = syntheticDatasetFileInput();
    firstVersionOf(input).datasetReleaseId = "rel_synthetic_other";
    expectRejectedAt(input, "provisionVersions.0.datasetReleaseId");
  });

  it("rejects duplicate provision version IDs", () => {
    const input = syntheticDatasetFileInput();
    input.provisionVersions = [
      provisionVersionInputFrom(syntheticVersionOne),
      provisionVersionInputFrom(syntheticVersionOne),
    ];
    expectRejectedAt(input, "provisionVersions.1.provisionVersionId");
  });
});

interface ManifestInput {
  schemaVersion: number;
  datasetReleaseId: string;
  releasedAt: string;
  reviewedBy: string;
  reviewState: string;
  files: { path: string; sha256: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

function syntheticManifestInput(): ManifestInput {
  return {
    schemaVersion: 1,
    datasetReleaseId: syntheticReleaseId,
    releasedAt: "2026-08-31T00:00:00.000Z",
    reviewedBy: "synthetic reviewer",
    reviewState: "verified",
    files: [
      {
        path: "data/manual/synthetic-dataset.json",
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ],
  };
}

describe("release manifest schema", () => {
  it("decodes a verified synthetic release manifest", () => {
    const result = decodeReleaseManifest(syntheticManifestInput());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected the synthetic manifest to decode");
    }
    expect(result.value.reviewState).toBe("verified");
    expect(result.value.files).toHaveLength(1);
  });

  it("rejects a manifest without files", () => {
    const input = syntheticManifestInput();
    input.files = [];
    const result = decodeReleaseManifest(input);
    expect(result.ok).toBe(false);
  });

  it("rejects a manifest path that escapes the release directory", () => {
    const input = syntheticManifestInput();
    const file = input.files[0];
    if (file === undefined) {
      throw new Error("Synthetic manifest must contain a file entry");
    }
    file.path = "../outside/synthetic-dataset.json";
    const result = decodeReleaseManifest(input);
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate manifest paths", () => {
    const input = syntheticManifestInput();
    const file = input.files[0];
    if (file === undefined) {
      throw new Error("Synthetic manifest must contain a file entry");
    }
    input.files = [{ ...file }, { ...file }];
    const result = decodeReleaseManifest(input);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected the manifest to be rejected");
    }
    expect(result.issues.some((issue) => issue.path.startsWith("files.1.path"))).toBe(true);
  });
});
