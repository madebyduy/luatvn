import { LegalQueryService, foldForSearch, lexicalSearch, tokenize } from "@luatvn/application";
import {
  parseLegalDate,
  parseProvisionId,
  parseProvisionVersionId,
  type PublishedProvisionVersion,
} from "@luatvn/domain";
import { sha256HexOfText } from "@luatvn/manual-dataset";
import { describe, expect, it } from "vitest";

import { syntheticReleaseId, syntheticVersionOne } from "../fixtures/synthetic-legal-data.js";
import { SyntheticLegalReadRepository } from "../helpers/synthetic-repository.js";

// Placeholder wording shaped like labour provisions, so the test can ask the
// kind of question a person actually types. Never real legal content.
function version(overrides: {
  readonly heading: string;
  readonly legalText: string;
  readonly provisionId: string;
  readonly provisionVersionId: string;
  readonly reviewStatus?: PublishedProvisionVersion["reviewStatus"];
  readonly validFrom?: string;
  readonly validTo?: string | null;
}): PublishedProvisionVersion {
  return Object.assign({}, syntheticVersionOne, {
    heading: overrides.heading,
    legalText: overrides.legalText,
    legalTextSha256: sha256HexOfText(overrides.legalText),
    provisionId: parseProvisionId(overrides.provisionId),
    provisionVersionId: parseProvisionVersionId(overrides.provisionVersionId),
    reviewStatus: overrides.reviewStatus ?? "verified",
    validTime: {
      from: parseLegalDate(overrides.validFrom ?? "2020-01-01"),
      to:
        overrides.validTo === undefined || overrides.validTo === null
          ? null
          : parseLegalDate(overrides.validTo),
    },
  });
}

const salary = version({
  heading: "Điều 94. Nguyên tắc trả lương",
  legalText:
    "Điều 94. Nguyên tắc trả lương\nNgười sử dụng lao động phải trả lương trực tiếp, đầy đủ, đúng hạn cho người lao động.",
  provisionId: "prov_synthetic_s94",
  provisionVersionId: "pv_synthetic_s94_v1",
});
const deadline = version({
  heading: "Điều 97. Kỳ hạn trả lương",
  legalText:
    "Điều 97. Kỳ hạn trả lương\nTrường hợp chậm trả lương từ 15 ngày trở lên thì phải đền bù một khoản tiền.",
  provisionId: "prov_synthetic_s97",
  provisionVersionId: "pv_synthetic_s97_v1",
});
const leave = version({
  heading: "Điều 113. Nghỉ hằng năm",
  legalText:
    "Điều 113. Nghỉ hằng năm\nNgười lao động làm việc đủ 12 tháng được nghỉ hằng năm hưởng nguyên lương.",
  provisionId: "prov_synthetic_s113",
  provisionVersionId: "pv_synthetic_s113_v1",
});
const draft = version({
  heading: "Điều 200. Bản nháp về lương",
  legalText: "Điều 200. Bản nháp về lương\nTrả lương trả lương trả lương.",
  provisionId: "prov_synthetic_s200",
  provisionVersionId: "pv_synthetic_s200_v1",
  reviewStatus: "under_review",
});
const expired = version({
  heading: "Điều 300. Lương cũ",
  legalText: "Điều 300. Lương cũ\nQuy định cũ về trả lương đã hết hiệu lực.",
  provisionId: "prov_synthetic_s300",
  provisionVersionId: "pv_synthetic_s300_v1",
  validFrom: "2010-01-01",
  validTo: "2015-01-01",
});

describe("folding and tokenising Vietnamese for lexical search", () => {
  it("lets a query typed without diacritics hit text written with them", () => {
    expect(foldForSearch("Trả lương đúng hạn")).toBe("tra luong dung han");
    expect(foldForSearch("Điều")).toBe("dieu");
  });

  it("drops one-letter tokens and adds adjacent-word bigrams", () => {
    const tokens = tokenize("trả lương đúng hạn");
    expect(tokens).toContain("luong");
    expect(tokens).toContain("tra_luong");
  });
});

describe("ranking provisions against a situation in plain words", () => {
  it("puts the articles about paying wages first when asked in the law's own words", () => {
    const hits = lexicalSearch([salary, deadline, leave], "trả lương đúng hạn", { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    const ids = hits.map((hit) => hit.version.provisionId);
    expect(ids[0] === "prov_synthetic_s94" || ids[0] === "prov_synthetic_s97").toBe(true);
    expect(ids).not.toContain("prov_synthetic_s113");
  });

  it("records the limit of a lexical baseline on an everyday question", () => {
    // Tier 0 is lexical, and this test pins down what that costs. On a corpus
    // where every article mentions "lương", BM25 treats the word as carrying
    // almost no information, while "tháng" - present only in the leave article
    // via "12 tháng" - carries a lot. So "công ty nợ lương tôi 2 tháng" returns
    // something, and what it returns is drawn from these articles, but the
    // wage articles are NOT guaranteed to be in it. Ranking by meaning is
    // exactly what AQ-001 (embeddings measured on real questions) exists for;
    // until then the UI says "tìm theo từ" and the runbook says why.
    const hits = lexicalSearch([salary, deadline, leave], "công ty nợ lương tôi 2 tháng", {
      limit: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(["prov_synthetic_s94", "prov_synthetic_s97", "prov_synthetic_s113"]).toContain(
        hit.version.provisionId,
      );
    }
  });

  it("returns nothing rather than the least-bad match when nothing is relevant", () => {
    expect(lexicalSearch([salary, deadline, leave], "thuế giá trị gia tăng", { limit: 5 })).toEqual(
      [],
    );
  });

  it("chooses a snippet from the line that matches most", () => {
    const [hit] = lexicalSearch([deadline], "chậm trả lương", { limit: 1 });
    expect(hit?.snippet).toContain("chậm trả lương");
  });
});

describe("the search use case", () => {
  const service = new LegalQueryService(
    new SyntheticLegalReadRepository([salary, deadline, leave, draft, expired], []),
  );
  const context = {
    datasetReleaseId: syntheticReleaseId,
    knownAt: "2026-09-01T00:00:00.000Z",
    requestId: "request-synthetic-search",
  };
  const execution = {
    deadlineAt: "2026-09-01T00:00:10.000Z",
    signal: new AbortController().signal,
  };

  it("only ever returns versions a reader may be shown and that were in force on the date", async () => {
    const result = await service.searchProvisions(
      { context, query: "trả lương", validAt: "2025-06-01" },
      execution,
    );
    const ids = result.data.results.map((hit) => hit.provisionId);
    expect(ids).not.toContain("prov_synthetic_s200"); // under_review
    expect(ids).not.toContain("prov_synthetic_s300"); // expired 2015
    expect(ids).toContain("prov_synthetic_s94");
    expect(result.data.retriever).toBe("lexical-bm25");
  });

  it("says the corpus is empty for a date before anything was in force", async () => {
    const result = await service.searchProvisions(
      { context, query: "trả lương", validAt: "2005-01-01" },
      execution,
    );
    expect(result.data.corpusEmpty).toBe(true);
    expect(result.data.results).toEqual([]);
  });

  it("says nothing is relevant, distinctly from the corpus being empty", async () => {
    const result = await service.searchProvisions(
      { context, query: "thuế giá trị gia tăng", validAt: "2025-06-01" },
      execution,
    );
    expect(result.data.corpusEmpty).toBe(false);
    expect(result.data.nothingRelevant).toBe(true);
  });

  it("rejects an empty or oversized question and an out-of-range limit", async () => {
    await expect(
      service.searchProvisions({ context, query: "   ", validAt: "2025-06-01" }, execution),
    ).rejects.toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }) as Error);
    await expect(
      service.searchProvisions(
        { context, limit: 50, query: "lương", validAt: "2025-06-01" },
        execution,
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }) as Error);
  });
});
