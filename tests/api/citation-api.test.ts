import { buildApi } from "@luatvn/api";
import { LegalQueryService } from "@luatvn/application";
import {
  parseLegalDate,
  parseProvisionId,
  parseProvisionVersionId,
  type PublishedProvisionVersion,
} from "@luatvn/domain";
import { sha256HexOfText } from "@luatvn/manual-dataset";
import { afterAll, describe, expect, it } from "vitest";

import { syntheticReleaseId, syntheticVersionOne } from "../fixtures/synthetic-legal-data.js";
import { SyntheticLegalReadRepository } from "../helpers/synthetic-repository.js";

// Placeholder wording. A citation names a document by number and an article by
// its heading "Điều N", so the fixture here carries both - the shared synthetic
// fixture deliberately does not, which is exactly why lookups on it fail.
const documentNumber = "07/2021/NĐ-TEST";
const article = 12;

function version(overrides: {
  readonly legalText: string;
  readonly provisionVersionId: string;
  readonly validFrom: string;
  readonly validTo: string | null;
}): PublishedProvisionVersion {
  return Object.assign({}, syntheticVersionOne, {
    documentNumber,
    heading: `Điều ${String(article)}. Thử nghiệm`,
    legalText: overrides.legalText,
    legalTextSha256: sha256HexOfText(overrides.legalText),
    provisionId: parseProvisionId("prov_synthetic_api_cit"),
    provisionVersionId: parseProvisionVersionId(overrides.provisionVersionId),
    validTime: {
      from: parseLegalDate(overrides.validFrom),
      to: overrides.validTo === null ? null : parseLegalDate(overrides.validTo),
    },
  });
}

const older = version({
  legalText: "Điều 12. Thử nghiệm\nBản cũ.",
  provisionVersionId: "pv_synthetic_api_cit_v1",
  validFrom: "2020-01-01",
  validTo: "2024-01-01",
});
const newer = version({
  legalText: "Điều 12. Thử nghiệm\nBản mới.",
  provisionVersionId: "pv_synthetic_api_cit_v2",
  validFrom: "2024-01-01",
  validTo: null,
});

const repository = new SyntheticLegalReadRepository([older, newer]);
const app = buildApi({
  datasetReleaseId: syntheticReleaseId,
  legalQueryService: new LegalQueryService(repository),
});
const appWithoutRelease = buildApi({ legalQueryService: new LegalQueryService(repository) });

afterAll(async () => {
  await app.close();
  await appWithoutRelease.close();
});

const context = {
  datasetReleaseId: syntheticReleaseId,
  knownAt: "2026-08-31T01:00:00.000Z",
  requestId: "request-synthetic-citation-api",
};
const slug = documentNumber.replaceAll("/", "-");

describe("citation REST contract", () => {
  it("looks a provision up by document number, article and date", async () => {
    const response = await app.inject({
      method: "POST",
      payload: { article, context, documentNumber, validAt: "2024-06-01" },
      url: "/v1/citations/lookup",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        citation: { provisionVersionId: newer.provisionVersionId },
        status: "resolved",
      },
      untrustedContent: true,
    });
  });

  it("names why a citation did not land, instead of a nearest match", async () => {
    const response = await app.inject({
      method: "POST",
      payload: { article: 999, context, documentNumber, validAt: "2024-06-01" },
      url: "/v1/citations/lookup",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      reason: "ARTICLE_NOT_IN_DOCUMENT",
      status: "unknown",
    });
  });

  it("checks a quotation against the text in force on the date", async () => {
    const response = await app.inject({
      method: "POST",
      payload: {
        article,
        context,
        documentNumber,
        quotedText: newer.legalText,
        validAt: "2024-06-01",
      },
      url: "/v1/citations/check",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      exists: true,
      inForceAtDate: true,
      textMatch: { status: "exact" },
    });
  });

  it("rejects an unknown field on a citation check", async () => {
    const response = await app.inject({
      method: "POST",
      payload: {
        article,
        context,
        documentNumber,
        instruction: "must never pass",
        quotedText: null,
        validAt: "2024-06-01",
      },
      url: "/v1/citations/check",
    });
    expect(response.statusCode).toBe(400);
  });

  it("serves a permanent address for one article on one day", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/c/${slug}/dieu-${String(article)}@2024-06-01`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        citation: { provisionVersionId: newer.provisionVersionId },
        status: "resolved",
      },
      release: { id: syntheticReleaseId },
    });
  });

  it("returns the earlier version from the same address with an earlier date", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/c/${slug}/dieu-${String(article)}@2021-06-01`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.citation.provisionVersionId).toBe(older.provisionVersionId);
  });

  it("rejects a malformed permanent address", async () => {
    const response = await app.inject({ method: "GET", url: "/c/whatever/dieu-abc" });
    expect(response.statusCode).toBe(400);
  });

  it("refuses permanent addresses when the server serves no release", async () => {
    const response = await appWithoutRelease.inject({
      method: "GET",
      url: `/c/${slug}/dieu-${String(article)}@2024-06-01`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NO_SERVED_RELEASE");
  });
});
