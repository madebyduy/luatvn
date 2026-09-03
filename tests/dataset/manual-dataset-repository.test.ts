import type { LegalReadOperation } from "@luatvn/application";
import {
  parseAmendmentId,
  parseDatasetReleaseId,
  parseIsoInstant,
  parseProvisionId,
  type AmendmentRelation,
} from "@luatvn/domain";
import { ManualDatasetRepository, type ManualDatasetFile } from "@luatvn/manual-dataset";
import { describe, expect, it } from "vitest";

import {
  syntheticAmendment,
  syntheticProvisionId,
  syntheticReleaseId,
  syntheticVersionOne,
  syntheticVersionTwo,
} from "../fixtures/synthetic-legal-data.js";

const otherReleaseId = parseDatasetReleaseId("rel_synthetic_other");

const chainedAmendment: AmendmentRelation = {
  ...syntheticAmendment,
  amendmentId: parseAmendmentId("amd_synthetic_beta"),
  sourceProvisionId: parseProvisionId("prov_synthetic_root"),
  targetProvisionId: parseProvisionId("prov_synthetic_amending"),
};

const unverifiedAmendment: AmendmentRelation = {
  ...syntheticAmendment,
  amendmentId: parseAmendmentId("amd_synthetic_unverified"),
  reviewStatus: "under_review",
};

function repositoryUnderTest(): ManualDatasetRepository {
  const dataset: ManualDatasetFile = {
    schemaVersion: 1,
    datasetReleaseId: syntheticReleaseId,
    provisionVersions: [syntheticVersionOne, syntheticVersionTwo],
    amendments: [syntheticAmendment, chainedAmendment, unverifiedAmendment],
    applicability: [],
  };
  return new ManualDatasetRepository({ datasetReleaseId: syntheticReleaseId, dataset });
}

function activeOperation(signal?: AbortSignal): LegalReadOperation {
  return {
    deadlineAt: parseIsoInstant(new Date(Date.now() + 60_000).toISOString()),
    requestId: "synthetic-request-1",
    signal: signal ?? new AbortController().signal,
  };
}

describe("ManualDatasetRepository", () => {
  it("lists the published versions of the requested provision and release", async () => {
    const versions = await repositoryUnderTest().listPublishedProvisionVersions(
      syntheticProvisionId,
      syntheticReleaseId,
      activeOperation(),
    );
    expect(versions.map((version) => version.provisionVersionId)).toEqual([
      syntheticVersionOne.provisionVersionId,
      syntheticVersionTwo.provisionVersionId,
    ]);
  });

  it("returns nothing for another release instead of falling back", async () => {
    const repository = repositoryUnderTest();
    const versions = await repository.listPublishedProvisionVersions(
      syntheticProvisionId,
      otherReleaseId,
      activeOperation(),
    );
    expect(versions).toEqual([]);
    const version = await repository.getPublishedProvisionVersion(
      syntheticVersionOne.provisionVersionId,
      otherReleaseId,
      activeOperation(),
    );
    expect(version).toBeNull();
    const amendments = await repository.listVerifiedAmendments(
      syntheticProvisionId,
      otherReleaseId,
      2,
      activeOperation(),
    );
    expect(amendments).toEqual([]);
  });

  it("returns a version by its ID within the loaded release", async () => {
    const version = await repositoryUnderTest().getPublishedProvisionVersion(
      syntheticVersionTwo.provisionVersionId,
      syntheticReleaseId,
      activeOperation(),
    );
    expect(version?.provisionVersionId).toBe(syntheticVersionTwo.provisionVersionId);
  });

  it("rejects reads once the operation signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      repositoryUnderTest().listPublishedProvisionVersions(
        syntheticProvisionId,
        syntheticReleaseId,
        activeOperation(controller.signal),
      ),
    ).rejects.toThrowError("aborted");
  });

  it("lists only verified amendments touching the provision at depth 1", async () => {
    const amendments = await repositoryUnderTest().listVerifiedAmendments(
      syntheticProvisionId,
      syntheticReleaseId,
      1,
      activeOperation(),
    );
    expect(amendments.map((relation) => relation.amendmentId)).toEqual([
      syntheticAmendment.amendmentId,
    ]);
  });

  it("follows the amending provision one step further at depth 2", async () => {
    const amendments = await repositoryUnderTest().listVerifiedAmendments(
      syntheticProvisionId,
      syntheticReleaseId,
      2,
      activeOperation(),
    );
    expect(amendments.map((relation) => relation.amendmentId).toSorted()).toEqual(
      [syntheticAmendment.amendmentId, chainedAmendment.amendmentId].toSorted(),
    );
  });
});
