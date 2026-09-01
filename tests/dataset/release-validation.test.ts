import {
  parseLegalDate,
  parseProvisionId,
  type AmendmentRelation,
  type EvidenceReference,
  type PublishedProvisionVersion,
} from "@luatvn/domain";
import {
  sha256HexOfText,
  validateReleaseForPublish,
  type ManualDatasetFile,
} from "@luatvn/manual-dataset";
import { describe, expect, it } from "vitest";

import {
  syntheticAmendment,
  syntheticReleaseId,
  syntheticVersionOne,
  syntheticVersionTwo,
} from "../fixtures/synthetic-legal-data.js";

const validationNow = "2026-08-31T12:00:00.000Z";

function withRegisteredEvidence(
  evidence: readonly [EvidenceReference, ...EvidenceReference[]],
  url: string,
): readonly [EvidenceReference, ...EvidenceReference[]] {
  const [first, ...rest] = evidence;
  return [{ ...first, officialSourceUrl: url }, ...rest];
}

function verifiedVersion(
  base: PublishedProvisionVersion,
  overrides: Partial<PublishedProvisionVersion> = {},
): PublishedProvisionVersion {
  const merged = {
    ...base,
    evidence: withRegisteredEvidence(base.evidence, "https://vbpl.vn/#synthetic-fixture"),
    ...overrides,
  };
  return { ...merged, legalTextSha256: sha256HexOfText(merged.legalText) };
}

function verifiedAmendment(overrides: Partial<AmendmentRelation> = {}): AmendmentRelation {
  return {
    ...syntheticAmendment,
    evidence: withRegisteredEvidence(
      syntheticAmendment.evidence,
      "https://congbao.chinhphu.vn/#synthetic-fixture",
    ),
    ...overrides,
  };
}

function datasetWith(
  versions: readonly PublishedProvisionVersion[],
  amendments: readonly AmendmentRelation[] = [],
): ManualDatasetFile {
  return {
    schemaVersion: 1,
    datasetReleaseId: syntheticReleaseId,
    provisionVersions: [...versions],
    amendments: [...amendments],
  };
}

describe("validateReleaseForPublish", () => {
  it("passes a fully verified dataset that uses registered hosts", () => {
    const issues = validateReleaseForPublish(
      datasetWith(
        [verifiedVersion(syntheticVersionOne), verifiedVersion(syntheticVersionTwo)],
        [verifiedAmendment()],
      ),
      { now: validationNow },
    );
    expect(issues).toEqual([]);
  });

  it("accepts ministry portals through the gov.vn suffix", () => {
    const issues = validateReleaseForPublish(
      datasetWith([
        verifiedVersion(syntheticVersionOne, {
          evidence: withRegisteredEvidence(
            syntheticVersionOne.evidence,
            "https://mof.gov.vn/#synthetic-fixture",
          ),
        }),
      ]),
      { now: validationNow },
    );
    expect(issues).toEqual([]);
  });

  it("flags a legal text that does not match its recorded SHA-256", () => {
    const version = verifiedVersion(syntheticVersionOne);
    const tampered = { ...version, legalText: `${version.legalText} tampered` };
    const issues = validateReleaseForPublish(datasetWith([tampered]), { now: validationNow });
    expect(
      issues.some(
        (issue) =>
          issue.locator.includes(String(version.provisionVersionId)) &&
          issue.message.includes("legalTextSha256"),
      ),
    ).toBe(true);
  });

  it("flags a record that has not been human-verified", () => {
    const issues = validateReleaseForPublish(
      datasetWith([verifiedVersion(syntheticVersionOne, { reviewStatus: "under_review" })]),
      { now: validationNow },
    );
    expect(issues.some((issue) => issue.message.includes("reviewStatus"))).toBe(true);
  });

  it("flags evidence retrieved in the future", () => {
    const [firstEvidence] = syntheticVersionOne.evidence;
    const issues = validateReleaseForPublish(
      datasetWith([
        verifiedVersion(syntheticVersionOne, {
          evidence: [
            {
              ...firstEvidence,
              officialSourceUrl: "https://vbpl.vn/#synthetic-fixture",
              retrievedAt: syntheticVersionTwo.systemTime.from,
            },
          ],
        }),
      ]),
      { now: "2020-01-01T00:00:00.000Z" },
    );
    expect(issues.some((issue) => issue.message.includes("retrievedAt"))).toBe(true);
  });

  it("flags evidence hosted outside the registered sources", () => {
    const issues = validateReleaseForPublish(
      datasetWith([
        verifiedVersion(syntheticVersionOne, {
          evidence: withRegisteredEvidence(
            syntheticVersionOne.evidence,
            "https://vbpl.vn.evil.invalid/#synthetic-fixture",
          ),
        }),
      ]),
      { now: validationNow },
    );
    expect(issues.some((issue) => issue.message.includes("registered source"))).toBe(true);
  });

  it("flags an amendment whose target provision is not in the release", () => {
    const issues = validateReleaseForPublish(
      datasetWith(
        [verifiedVersion(syntheticVersionOne)],
        [verifiedAmendment({ targetProvisionId: parseProvisionId("prov_synthetic_absent") })],
      ),
      { now: validationNow },
    );
    expect(issues.some((issue) => issue.message.includes("targetProvisionId"))).toBe(true);
  });

  it("flags overlapping verified versions that would resolve to a conflict", () => {
    const overlapping = verifiedVersion(syntheticVersionTwo, {
      validTime: { from: parseLegalDate("2023-01-01"), to: null },
    });
    const issues = validateReleaseForPublish(
      datasetWith([verifiedVersion(syntheticVersionOne), overlapping]),
      { now: validationNow },
    );
    expect(issues.some((issue) => issue.message.includes("overlap"))).toBe(true);
  });
});
