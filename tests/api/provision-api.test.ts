import { buildApi } from "@luatvn/api";
import { LegalQueryService } from "@luatvn/application";
import type { PublishedProvisionVersion } from "@luatvn/domain";
import { afterAll, describe, expect, it } from "vitest";

import {
  syntheticReleaseId,
  syntheticVersionOne,
  syntheticVersionTwo,
} from "../fixtures/synthetic-legal-data.js";
import {
  AbortAwareSyntheticLegalReadRepository,
  SyntheticLegalReadRepository,
} from "../helpers/synthetic-repository.js";

const repository = new SyntheticLegalReadRepository([syntheticVersionOne, syntheticVersionTwo]);
const app = buildApi({ legalQueryService: new LegalQueryService(repository) });

afterAll(async () => {
  await app.close();
});

describe("provision REST contract", () => {
  it("returns the version at a requested legal date with provenance", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/provisions/at",
      payload: {
        context: {
          requestId: "request-synthetic-api-001",
          datasetReleaseId: syntheticReleaseId,
          knownAt: "2026-08-31T01:00:00.000Z",
        },
        provisionId: syntheticVersionOne.provisionId,
        validAt: "2024-01-01",
      },
    });

    expect(response.statusCode).toBe(200);
    // Cross-references travel with every resolved answer, possibly empty.
    expect(
      Array.isArray((response.json() as { data: { references: unknown } }).data.references),
    ).toBe(true);
    expect(response.json()).toMatchObject({
      data: {
        status: "resolved",
        citation: {
          provisionVersionId: syntheticVersionTwo.provisionVersionId,
          datasetReleaseId: syntheticReleaseId,
          retrievedAt: "2026-08-31T00:00:00.000Z",
          checkedAt: "2026-08-31T01:00:00.000Z",
        },
      },
      untrustedContent: true,
    });
  });

  it("rejects unknown public fields", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/provisions/at",
      payload: {
        context: {
          requestId: "request-synthetic-api-002",
          datasetReleaseId: syntheticReleaseId,
          knownAt: "2026-08-31T01:00:00.000Z",
        },
        provisionId: syntheticVersionOne.provisionId,
        validAt: "2024-01-01",
        instruction: "This synthetic field must never pass validation",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("rejects an impossible calendar date as a public input error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/provisions/at",
      payload: {
        context: {
          requestId: "request-synthetic-api-003",
          datasetReleaseId: syntheticReleaseId,
          knownAt: "2026-08-31T01:00:00.000Z",
        },
        provisionId: syntheticVersionOne.provisionId,
        validAt: "2026-02-30",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("rejects an impossible canonical instant as a public input error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/provisions/at",
      payload: {
        context: {
          requestId: "request-synthetic-api-004",
          datasetReleaseId: syntheticReleaseId,
          knownAt: "2026-13-31T01:00:00.000Z",
        },
        provisionId: syntheticVersionOne.provisionId,
        validAt: "2026-08-31",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("rejects compare when a version has not been verified", async () => {
    const underReviewVersion: PublishedProvisionVersion = {
      ...syntheticVersionTwo,
      reviewStatus: "under_review",
    };
    const guardedRepository = new SyntheticLegalReadRepository([
      syntheticVersionOne,
      underReviewVersion,
    ]);
    const guardedApp = buildApi({
      legalQueryService: new LegalQueryService(guardedRepository),
    });

    try {
      const response = await guardedApp.inject({
        method: "POST",
        url: "/v1/provisions/compare",
        payload: {
          context: {
            requestId: "request-synthetic-api-005",
            datasetReleaseId: syntheticReleaseId,
            knownAt: "2026-08-31T01:00:00.000Z",
          },
          fromVersionId: syntheticVersionOne.provisionVersionId,
          toVersionId: underReviewVersion.provisionVersionId,
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "UNVERIFIED_VERSION" },
      });
    } finally {
      await guardedApp.close();
    }
  });

  it("aborts a repository operation at the configured handler deadline", async () => {
    const timedApp = buildApi({
      legalQueryService: new LegalQueryService(new AbortAwareSyntheticLegalReadRepository()),
      operationTimeoutMs: 10,
    });

    try {
      const response = await timedApp.inject({
        method: "POST",
        url: "/v1/provisions/at",
        payload: {
          context: {
            requestId: "request-synthetic-api-006",
            datasetReleaseId: syntheticReleaseId,
            knownAt: "2026-08-31T01:00:00.000Z",
          },
          provisionId: syntheticVersionOne.provisionId,
          validAt: "2026-08-31",
        },
      });

      expect(response.statusCode).toBe(408);
      expect(response.json()).toMatchObject({
        error: { code: "REQUEST_ABORTED" },
      });
    } finally {
      await timedApp.close();
    }
  });
  it("serves a catalog a client can build a chooser from", async () => {
    const response = await app.inject({
      method: "POST",
      payload: {
        context: {
          datasetReleaseId: syntheticReleaseId,
          knownAt: "2026-08-31T01:00:00.000Z",
          requestId: "request-synthetic-catalog",
        },
      },
      url: "/v1/catalog",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.status).toBe("resolved");
    expect(body.data.documents).toHaveLength(1);
    expect(body.data.documents[0].provisions[0].versions).toHaveLength(2);
    expect(body.untrustedContent).toBe(true);
  });

  it("rejects an unknown field on the catalog request", async () => {
    const response = await app.inject({
      method: "POST",
      payload: {
        context: {
          datasetReleaseId: syntheticReleaseId,
          knownAt: "2026-08-31T01:00:00.000Z",
          requestId: "request-synthetic-catalog",
        },
        unexpected: true,
      },
      url: "/v1/catalog",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });
});
