import {
  parseIsoInstant,
  parseLegalDate,
  parseProvisionId,
  resolveProvisionAt,
  type PublishedProvisionVersion,
} from "@luatvn/domain";
import { describe, expect, it } from "vitest";

import {
  syntheticProvisionId,
  syntheticReleaseId,
  syntheticVersionOne,
  syntheticVersionTwo,
} from "../fixtures/synthetic-legal-data.js";

describe("resolveProvisionAt", () => {
  it("resolves exactly one verified version for valid/system/release time", () => {
    const result = resolveProvisionAt({
      versions: [syntheticVersionOne, syntheticVersionTwo],
      provisionId: syntheticProvisionId,
      validAt: parseLegalDate("2023-12-31"),
      knownAt: parseIsoInstant("2026-08-31T01:00:00.000Z"),
      datasetReleaseId: syntheticReleaseId,
    });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.version.provisionId).toBe(syntheticProvisionId);
      expect(result.version.provisionVersionId).toBe(syntheticVersionOne.provisionVersionId);
    }
  });

  it("uses half-open valid intervals at a version boundary", () => {
    const result = resolveProvisionAt({
      versions: [syntheticVersionOne, syntheticVersionTwo],
      provisionId: syntheticProvisionId,
      validAt: parseLegalDate("2024-01-01"),
      knownAt: parseIsoInstant("2026-08-31T01:00:00.000Z"),
      datasetReleaseId: syntheticReleaseId,
    });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.version.provisionVersionId).toBe(syntheticVersionTwo.provisionVersionId);
    }
  });

  it("returns unknown instead of guessing when only unverified data matches", () => {
    const unverified: PublishedProvisionVersion = {
      ...syntheticVersionTwo,
      reviewStatus: "under_review",
    };
    const result = resolveProvisionAt({
      versions: [unverified],
      provisionId: syntheticProvisionId,
      validAt: parseLegalDate("2026-08-31"),
      knownAt: parseIsoInstant("2026-08-31T01:00:00.000Z"),
      datasetReleaseId: syntheticReleaseId,
    });

    expect(result).toEqual({
      status: "unknown",
      reason: "MATCH_ONLY_UNVERIFIED",
      candidateVersionIds: [unverified.provisionVersionId],
    });
  });

  it("returns conflict instead of choosing among overlapping verified versions", () => {
    const overlapping: PublishedProvisionVersion = {
      ...syntheticVersionTwo,
      provisionVersionId: syntheticVersionOne.provisionVersionId,
    };
    const result = resolveProvisionAt({
      versions: [syntheticVersionTwo, overlapping],
      provisionId: syntheticProvisionId,
      validAt: parseLegalDate("2026-08-31"),
      knownAt: parseIsoInstant("2026-08-31T01:00:00.000Z"),
      datasetReleaseId: syntheticReleaseId,
    });

    expect(result.status).toBe("conflict");
  });

  it("rejects impossible calendar dates", () => {
    expect(() => parseLegalDate("2026-02-30")).toThrow(TypeError);
  });

  it("does not resolve a candidate belonging to another stable provision", () => {
    const mismatchedProvision: PublishedProvisionVersion = {
      ...syntheticVersionTwo,
      provisionId: parseProvisionId("prov_synthetic_other"),
    };
    const result = resolveProvisionAt({
      versions: [mismatchedProvision],
      provisionId: syntheticProvisionId,
      validAt: parseLegalDate("2026-08-31"),
      knownAt: parseIsoInstant("2026-08-31T01:00:00.000Z"),
      datasetReleaseId: syntheticReleaseId,
    });

    expect(result).toEqual({
      status: "unknown",
      reason: "NO_MATCHING_VERSION",
      candidateVersionIds: [],
    });
  });
});
