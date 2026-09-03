import {
  parseDatasetReleaseId,
  parseIsoInstant,
  parseLegalDate,
  resolveProvisionAt,
  type PublishedProvisionVersion,
} from "@luatvn/domain";
import {
  markRecordMachineChecked,
  promoteRecordToVerified,
  ReviewError,
  sha256HexOfText,
  validateReleaseForPublish,
} from "@luatvn/manual-dataset";
import { describe, expect, it } from "vitest";

import {
  syntheticAmendment,
  syntheticProvisionId,
  syntheticReleaseId,
  syntheticVersionOne,
  syntheticVersionTwo,
} from "../fixtures/synthetic-legal-data.js";

const allPassed = { allPassed: true, flagged: [], notAvailable: [] } as const;

function stagingTextWith(status: PublishedProvisionVersion["reviewStatus"]): string {
  const versions = [syntheticVersionOne, syntheticVersionTwo].map((version) =>
    Object.assign({}, version, {
      legalTextSha256: sha256HexOfText(version.legalText),
      reviewStatus: status,
    }),
  );
  return JSON.stringify(
    {
      amendments: [syntheticAmendment],
      datasetReleaseId: syntheticReleaseId,
      provisionVersions: versions,
      schemaVersion: 1,
    },
    null,
    2,
  );
}

describe("the machine path to machine_checked", () => {
  it("raises a record to machine_checked only when every check passed, and signs as a machine", () => {
    const result = markRecordMachineChecked({
      checks: allPassed,
      datasetText: stagingTextWith("under_review"),
      provisionVersionId: syntheticVersionOne.provisionVersionId,
    });
    const updated = JSON.parse(result.updatedDatasetText) as {
      provisionVersions: { provisionVersionId: string; reviewStatus: string }[];
    };
    const marked = updated.provisionVersions.find(
      (version) => version.provisionVersionId === syntheticVersionOne.provisionVersionId,
    );
    expect(marked?.reviewStatus).toBe("machine_checked");
    expect(result.audit.method).toBe("machine");
    expect(result.audit.reviewedBy).toBe("machine:cross-check");
  });

  it("refuses when a check flagged, and says which", () => {
    expect(() =>
      markRecordMachineChecked({
        checks: { allPassed: false, flagged: ["EFFECTIVE_DATE"], notAvailable: [] },
        datasetText: stagingTextWith("under_review"),
        provisionVersionId: syntheticVersionOne.provisionVersionId,
      }),
    ).toThrowError(expect.objectContaining({ code: "CHECKS_NOT_PASSED" }) as Error);
  });

  it("refuses when a check could not run: not looking is not the same as passing", () => {
    try {
      markRecordMachineChecked({
        checks: { allPassed: false, flagged: [], notAvailable: ["SECOND_EXTRACTOR"] },
        datasetText: stagingTextWith("under_review"),
        provisionVersionId: syntheticVersionOne.provisionVersionId,
      });
      expect.unreachable("should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewError);
      expect((error as ReviewError).message).toContain("chưa chạy được");
    }
  });

  it("never lowers a human-verified record", () => {
    expect(() =>
      markRecordMachineChecked({
        checks: allPassed,
        datasetText: stagingTextWith("verified"),
        provisionVersionId: syntheticVersionOne.provisionVersionId,
      }),
    ).toThrowError(expect.objectContaining({ code: "ALREADY_VERIFIED" }) as Error);
  });

  it("a human can still promote a machine_checked record to verified", () => {
    const machine = markRecordMachineChecked({
      checks: allPassed,
      datasetText: stagingTextWith("under_review"),
      provisionVersionId: syntheticVersionOne.provisionVersionId,
    });
    const human = promoteRecordToVerified({
      datasetText: machine.updatedDatasetText,
      provisionVersionId: syntheticVersionOne.provisionVersionId,
      reviewedBy: "Người duyệt",
    });
    expect(human.audit.method).toBe("human");
    const updated = JSON.parse(human.updatedDatasetText) as {
      provisionVersions: { provisionVersionId: string; reviewStatus: string }[];
    };
    expect(
      updated.provisionVersions.find(
        (version) => version.provisionVersionId === syntheticVersionOne.provisionVersionId,
      )?.reviewStatus,
    ).toBe("verified");
  });
});

describe("machine_checked records are servable and labelled, never disguised", () => {
  it("publish validation accepts machine_checked provisions but still demands verified amendments", () => {
    const dataset = JSON.parse(stagingTextWith("machine_checked")) as Parameters<
      typeof validateReleaseForPublish
    >[0];
    const issues = validateReleaseForPublish(dataset, {
      allowedHosts: ["example.invalid"],
      now: parseIsoInstant("2026-09-01T00:00:00.000Z"),
    });
    expect(issues.filter((issue) => issue.locator.startsWith("provisionVersions"))).toEqual([]);
  });

  it("publish validation still refuses under_review", () => {
    const dataset = JSON.parse(stagingTextWith("under_review")) as Parameters<
      typeof validateReleaseForPublish
    >[0];
    const issues = validateReleaseForPublish(dataset, {
      allowedHosts: ["example.invalid"],
      now: parseIsoInstant("2026-09-01T00:00:00.000Z"),
    });
    expect(issues.some((issue) => issue.message.includes("verified or machine_checked"))).toBe(
      true,
    );
  });

  it("the resolver answers with a machine_checked version and carries its status in the answer", () => {
    const versions = [
      Object.assign({}, syntheticVersionOne, {
        datasetReleaseId: parseDatasetReleaseId(syntheticReleaseId),
        reviewStatus: "machine_checked" as const,
      }),
    ];
    const result = resolveProvisionAt({
      datasetReleaseId: parseDatasetReleaseId(syntheticReleaseId),
      knownAt: parseIsoInstant("2026-09-01T00:00:00.000Z"),
      provisionId: syntheticProvisionId,
      validAt: parseLegalDate("2021-06-01"),
      versions,
    });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.version.reviewStatus).toBe("machine_checked");
    }
  });

  it("the resolver still refuses under_review", () => {
    const versions = [
      Object.assign({}, syntheticVersionOne, {
        datasetReleaseId: parseDatasetReleaseId(syntheticReleaseId),
        reviewStatus: "under_review" as const,
      }),
    ];
    const result = resolveProvisionAt({
      datasetReleaseId: parseDatasetReleaseId(syntheticReleaseId),
      knownAt: parseIsoInstant("2026-09-01T00:00:00.000Z"),
      provisionId: syntheticProvisionId,
      validAt: parseLegalDate("2021-06-01"),
      versions,
    });
    expect(result.status).toBe("unknown");
  });
});
