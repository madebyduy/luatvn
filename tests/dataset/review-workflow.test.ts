import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDatasetReleaseId, type PublishedProvisionVersion } from "@luatvn/domain";
import {
  loadPublishedRelease,
  promoteRecordToVerified,
  publishRelease,
  ReleaseStoreError,
  ReviewError,
  sha256HexOfText,
} from "@luatvn/manual-dataset";
import { describe, expect, it } from "vitest";

import {
  syntheticAmendment,
  syntheticVersionOne,
  syntheticVersionTwo,
} from "../fixtures/synthetic-legal-data.js";

const storeOptions = { allowedHosts: ["example.invalid"] } as const;

function draftVersion(
  base: PublishedProvisionVersion,
  releaseId: string,
): PublishedProvisionVersion {
  return {
    ...base,
    datasetReleaseId: parseDatasetReleaseId(releaseId),
    legalTextSha256: sha256HexOfText(base.legalText),
    reviewStatus: "under_review",
  };
}

function draftTextFor(releaseId: string): string {
  return JSON.stringify(
    {
      amendments: [{ ...syntheticAmendment, reviewStatus: "under_review" }],
      datasetReleaseId: releaseId,
      provisionVersions: [
        draftVersion(syntheticVersionOne, releaseId),
        draftVersion(syntheticVersionTwo, releaseId),
      ],
      schemaVersion: 1,
    },
    null,
    2,
  );
}

function expectReviewError(work: () => unknown, code: ReviewError["code"]): void {
  try {
    work();
    throw new Error("Expected promotion to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewError);
    if (error instanceof ReviewError) {
      expect(error.code).toBe(code);
    }
  }
}

describe("review promotion", () => {
  it("promotes a machine draft to verified with an audit entry", () => {
    const result = promoteRecordToVerified({
      datasetText: draftTextFor("rel_synthetic_review1"),
      provisionVersionId: String(syntheticVersionOne.provisionVersionId),
      reviewedBy: "synthetic reviewer",
    });
    expect(result.audit.target).toBe(String(syntheticVersionOne.provisionVersionId));
    expect(result.audit.reviewedBy).toBe("synthetic reviewer");
    const updated = JSON.parse(result.updatedDatasetText) as {
      provisionVersions: { provisionVersionId: string; reviewStatus: string }[];
    };
    const statuses = new Map(
      updated.provisionVersions.map((version) => [
        version.provisionVersionId,
        version.reviewStatus,
      ]),
    );
    expect(statuses.get(String(syntheticVersionOne.provisionVersionId))).toBe("verified");
    expect(statuses.get(String(syntheticVersionTwo.provisionVersionId))).toBe("under_review");
  });

  it("requires exactly one target and a named reviewer", () => {
    expectReviewError(
      () =>
        promoteRecordToVerified({
          datasetText: draftTextFor("rel_synthetic_review1"),
          provisionVersionId: String(syntheticVersionOne.provisionVersionId),
          reviewedBy: "   ",
        }),
      "REVIEWER_REQUIRED",
    );
    expectReviewError(
      () =>
        promoteRecordToVerified({
          datasetText: draftTextFor("rel_synthetic_review1"),
          reviewedBy: "synthetic reviewer",
        }),
      "TARGET_REQUIRED",
    );
    expectReviewError(
      () =>
        promoteRecordToVerified({
          datasetText: draftTextFor("rel_synthetic_review1"),
          provisionVersionId: "pv_synthetic_missing",
          reviewedBy: "synthetic reviewer",
        }),
      "RECORD_NOT_FOUND",
    );
  });

  it("refuses to promote a record twice", () => {
    const first = promoteRecordToVerified({
      datasetText: draftTextFor("rel_synthetic_review1"),
      provisionVersionId: String(syntheticVersionOne.provisionVersionId),
      reviewedBy: "synthetic reviewer",
    });
    expectReviewError(
      () =>
        promoteRecordToVerified({
          datasetText: first.updatedDatasetText,
          provisionVersionId: String(syntheticVersionOne.provisionVersionId),
          reviewedBy: "synthetic reviewer",
        }),
      "ALREADY_VERIFIED",
    );
  });

  it("keeps machine drafts unpublishable until every record is promoted", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "luatvn-review-"));
    try {
      const releaseId = "rel_synthetic_review2";
      let stagingText = draftTextFor(releaseId);

      const rejected = await publishRelease(dataDirectory, stagingText, {
        reviewedBy: "synthetic reviewer",
        ...storeOptions,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(rejected).toBeInstanceOf(ReleaseStoreError);
      if (rejected instanceof ReleaseStoreError) {
        expect(rejected.code).toBe("RELEASE_VALIDATION_FAILED");
      }

      for (const target of [
        { provisionVersionId: String(syntheticVersionOne.provisionVersionId) },
        { provisionVersionId: String(syntheticVersionTwo.provisionVersionId) },
        { amendmentId: String(syntheticAmendment.amendmentId) },
      ]) {
        stagingText = promoteRecordToVerified({
          datasetText: stagingText,
          reviewedBy: "synthetic reviewer",
          ...target,
        }).updatedDatasetText;
      }

      await publishRelease(dataDirectory, stagingText, {
        reviewedBy: "synthetic reviewer",
        ...storeOptions,
      });
      const release = await loadPublishedRelease(dataDirectory, storeOptions);
      expect(release.datasetReleaseId).toBe(releaseId);
      expect(
        release.dataset.provisionVersions.every((version) => version.reviewStatus === "verified"),
      ).toBe(true);
    } finally {
      await rm(dataDirectory, { force: true, recursive: true });
    }
  });
});
