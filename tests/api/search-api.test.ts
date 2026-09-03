import { buildApi } from "@luatvn/api";
import { LegalQueryService } from "@luatvn/application";
import {
  parseProvisionId,
  parseProvisionVersionId,
  type PublishedProvisionVersion,
} from "@luatvn/domain";
import { sha256HexOfText } from "@luatvn/manual-dataset";
import { afterAll, describe, expect, it } from "vitest";

import { syntheticReleaseId, syntheticVersionOne } from "../fixtures/synthetic-legal-data.js";
import { SyntheticLegalReadRepository } from "../helpers/synthetic-repository.js";

// Placeholder wording shaped like a labour article, so a plain question hits it.
const wages: PublishedProvisionVersion = Object.assign({}, syntheticVersionOne, {
  heading: "Điều 94. Nguyên tắc trả lương",
  legalText: "Điều 94. Nguyên tắc trả lương\nTrả lương đầy đủ, đúng hạn cho người lao động.",
  legalTextSha256: sha256HexOfText(
    "Điều 94. Nguyên tắc trả lương\nTrả lương đầy đủ, đúng hạn cho người lao động.",
  ),
  provisionId: parseProvisionId("prov_synthetic_search_94"),
  provisionVersionId: parseProvisionVersionId("pv_synthetic_search_94_v1"),
});

const app = buildApi({
  legalQueryService: new LegalQueryService(new SyntheticLegalReadRepository([wages])),
});

afterAll(async () => {
  await app.close();
});

const context = {
  datasetReleaseId: syntheticReleaseId,
  knownAt: "2026-08-31T01:00:00.000Z",
  requestId: "request-synthetic-search-api",
};

describe("search REST contract", () => {
  it("ranks provisions for a situation in plain words and names the retriever", async () => {
    const response = await app.inject({
      method: "POST",
      payload: { context, query: "công ty nợ lương", validAt: "2023-06-01" },
      url: "/v1/search",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.retriever).toBe("lexical-bm25");
    expect(body.data.results[0].provisionId).toBe("prov_synthetic_search_94");
    expect(body.data.results[0].reviewStatus).toBe("verified");
    expect(body.untrustedContent).toBe(true);
  });

  it("reports nothing relevant as an answer, with no least-bad match", async () => {
    const response = await app.inject({
      method: "POST",
      payload: { context, query: "thuế giá trị gia tăng", validAt: "2023-06-01" },
      url: "/v1/search",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ nothingRelevant: true, results: [] });
  });

  it("rejects an unknown field and an oversized limit at the boundary", async () => {
    const unknown = await app.inject({
      method: "POST",
      payload: { context, instruction: "no", query: "lương", validAt: "2023-06-01" },
      url: "/v1/search",
    });
    expect(unknown.statusCode).toBe(400);
    const oversized = await app.inject({
      method: "POST",
      payload: { context, limit: 99, query: "lương", validAt: "2023-06-01" },
      url: "/v1/search",
    });
    expect(oversized.statusCode).toBe(400);
  });
});
