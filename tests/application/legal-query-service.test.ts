import { LegalQueryService, maximumCatalogVersions } from "@luatvn/application";
import { parseEvidenceId, parseIsoInstant, type PublishedProvisionVersion } from "@luatvn/domain";
import { describe, expect, it } from "vitest";

import {
  syntheticAmendment,
  syntheticProvisionId,
  syntheticReleaseId,
  syntheticVersionOne,
  syntheticVersionTwo,
} from "../fixtures/synthetic-legal-data.js";
import { SyntheticLegalReadRepository } from "../helpers/synthetic-repository.js";

const context = {
  requestId: "request-synthetic-001",
  datasetReleaseId: syntheticReleaseId,
  knownAt: "2026-08-31T01:00:00.000Z",
} as const;

const execution = {
  deadlineAt: "2026-08-31T01:00:10.000Z",
  signal: new AbortController().signal,
};

describe("LegalQueryService", () => {
  const repository = new SyntheticLegalReadRepository(
    [syntheticVersionOne, syntheticVersionTwo],
    [syntheticAmendment],
  );
  const service = new LegalQueryService(repository);

  it("returns a citation and keeps legal content explicitly untrusted", async () => {
    const output = await service.getProvisionAt(
      {
        context,
        provisionId: syntheticProvisionId,
        validAt: "2024-01-01",
      },
      execution,
    );

    expect(output.untrustedContent).toBe(true);
    expect(output.warnings).toEqual(["LEGAL_DATA_NOT_ADVICE"]);
    expect(output.data.status).toBe("resolved");
    if (output.data.status === "resolved") {
      expect(output.data.citation.provisionVersionId).toBe(syntheticVersionTwo.provisionVersionId);
      expect(output.data.provision.legalText).toContain("Synthetic");
    }
  });

  it("traces only verified amendment relations", async () => {
    const output = await service.traceAmendments(
      {
        context,
        provisionId: syntheticProvisionId,
        maxDepth: 2,
      },
      execution,
    );

    expect(output.data.relations).toEqual([syntheticAmendment]);
  });

  it("maps an impossible legal date to a stable application input error", async () => {
    await expect(
      service.getProvisionAt(
        {
          context,
          provisionId: syntheticProvisionId,
          validAt: "2026-02-30",
        },
        execution,
      ),
    ).rejects.toMatchObject({
      name: "LegalQueryError",
      code: "INVALID_INPUT",
      message: "validAt is invalid",
    });
  });

  it("maps an impossible known-at instant to a stable application input error", async () => {
    await expect(
      service.getProvisionAt(
        {
          context: {
            ...context,
            knownAt: "2026-13-31T01:00:00.000Z",
          },
          provisionId: syntheticProvisionId,
          validAt: "2026-08-31",
        },
        execution,
      ),
    ).rejects.toMatchObject({
      name: "LegalQueryError",
      code: "INVALID_INPUT",
      message: "context.knownAt is invalid",
    });
  });

  it("rejects compare when a requested version is not verified", async () => {
    const underReviewVersion: PublishedProvisionVersion = {
      ...syntheticVersionTwo,
      reviewStatus: "under_review",
    };
    const guardedService = new LegalQueryService(
      new SyntheticLegalReadRepository([syntheticVersionOne, underReviewVersion]),
    );

    await expect(
      guardedService.compareProvisionVersions(
        {
          context,
          fromVersionId: syntheticVersionOne.provisionVersionId,
          toVersionId: underReviewVersion.provisionVersionId,
        },
        execution,
      ),
    ).rejects.toMatchObject({
      name: "LegalQueryError",
      code: "UNVERIFIED_VERSION",
    });
  });

  it("selects explicit primary evidence and separates retrieval from check time", async () => {
    const primaryEvidence = {
      ...syntheticVersionTwo.evidence[0],
      evidenceId: parseEvidenceId("ev_synthetic_explicit_primary"),
      officialSourceUrl: "https://example.invalid/synthetic-explicit-primary",
      sourceSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      retrievedAt: parseIsoInstant("2026-08-30T00:00:00.000Z"),
    };
    const versionWithExplicitPrimary: PublishedProvisionVersion = {
      ...syntheticVersionTwo,
      primaryEvidenceId: primaryEvidence.evidenceId,
      evidence: [syntheticVersionTwo.evidence[0], primaryEvidence],
    };
    const citationService = new LegalQueryService(
      new SyntheticLegalReadRepository([versionWithExplicitPrimary]),
    );

    const output = await citationService.getProvisionAt(
      {
        context,
        provisionId: syntheticProvisionId,
        validAt: "2026-08-31",
      },
      execution,
    );

    expect(output.data.status).toBe("resolved");
    if (output.data.status === "resolved") {
      expect(output.data.citation).toMatchObject({
        sourceUrl: primaryEvidence.officialSourceUrl,
        sourceSha256: primaryEvidence.sourceSha256,
        retrievedAt: primaryEvidence.retrievedAt,
        checkedAt: context.knownAt,
      });
    }
  });

  it("rejects repository collections above the public result limits", async () => {
    const excessiveVersions = Array.from({ length: 257 }, () => syntheticVersionTwo);
    const excessiveRelations = Array.from({ length: 257 }, () => syntheticAmendment);
    const versionLimitedService = new LegalQueryService(
      new SyntheticLegalReadRepository(excessiveVersions),
    );
    const relationLimitedService = new LegalQueryService(
      new SyntheticLegalReadRepository([syntheticVersionTwo], excessiveRelations),
    );

    await expect(
      versionLimitedService.getProvisionAt(
        {
          context,
          provisionId: syntheticProvisionId,
          validAt: "2026-08-31",
        },
        execution,
      ),
    ).rejects.toMatchObject({ code: "RESULT_LIMIT_EXCEEDED" });

    await expect(
      relationLimitedService.traceAmendments(
        {
          context,
          provisionId: syntheticProvisionId,
          maxDepth: 2,
        },
        execution,
      ),
    ).rejects.toMatchObject({ code: "RESULT_LIMIT_EXCEEDED" });
  });
  it("groups the catalog by document and orders versions by their start date", async () => {
    const catalogService = new LegalQueryService(
      new SyntheticLegalReadRepository([syntheticVersionTwo, syntheticVersionOne]),
    );
    const result = await catalogService.getCatalog({ context }, execution);
    if (result.data.status !== "resolved") {
      throw new Error("expected a resolved catalog");
    }
    expect(result.data.documents).toHaveLength(1);
    const [document] = result.data.documents;
    expect(document?.documentNumber).toBe(syntheticVersionOne.documentNumber);
    const [provision] = document?.provisions ?? [];
    expect(provision?.provisionId).toBe(syntheticProvisionId);
    expect(provision?.versions.map((version) => version.validFrom)).toEqual([
      syntheticVersionOne.validTime.from,
      syntheticVersionTwo.validTime.from,
    ]);
    expect(result.untrustedContent).toBe(true);
  });

  it("refuses a catalog larger than the public limit", async () => {
    const oversized = Array.from({ length: maximumCatalogVersions + 1 }, () => syntheticVersionOne);
    const oversizedService = new LegalQueryService(new SyntheticLegalReadRepository(oversized));
    await expect(oversizedService.getCatalog({ context }, execution)).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
    });
  });
});
