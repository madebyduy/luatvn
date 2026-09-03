import { LegalQueryService } from "@luatvn/application";
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

// Placeholder wording. One synthetic decree "12/2020/NĐ-TEST" with Điều 3 in
// two versions (old until 2024, new from 2024) and Điều 4 once.
function version(overrides: {
  readonly documentNumber: string;
  readonly heading: string;
  readonly legalText: string;
  readonly provisionId: string;
  readonly provisionVersionId: string;
  readonly validFrom: string;
  readonly validTo: string | null;
}): PublishedProvisionVersion {
  return Object.assign({}, syntheticVersionOne, {
    documentNumber: overrides.documentNumber,
    heading: overrides.heading,
    legalText: overrides.legalText,
    legalTextSha256: sha256HexOfText(overrides.legalText),
    provisionId: parseProvisionId(overrides.provisionId),
    provisionVersionId: parseProvisionVersionId(overrides.provisionVersionId),
    validTime: {
      from: parseLegalDate(overrides.validFrom),
      to: overrides.validTo === null ? null : parseLegalDate(overrides.validTo),
    },
  });
}

const oldText = "Điều 3. Nguyên tắc\nTổ chức phải nộp báo cáo trong ba mươi ngày.";
const newText = "Điều 3. Nguyên tắc\nTổ chức phải nộp báo cáo trong mười lăm ngày.";

const versions = [
  version({
    documentNumber: "12/2020/NĐ-TEST",
    heading: "Điều 3. Nguyên tắc",
    legalText: oldText,
    provisionId: "prov_synthetic_cit_3",
    provisionVersionId: "pv_synthetic_cit_3_v1",
    validFrom: "2020-01-01",
    validTo: "2024-01-01",
  }),
  version({
    documentNumber: "12/2020/NĐ-TEST",
    heading: "Điều 3. Nguyên tắc",
    legalText: newText,
    provisionId: "prov_synthetic_cit_3",
    provisionVersionId: "pv_synthetic_cit_3_v2",
    validFrom: "2024-01-01",
    validTo: null,
  }),
  version({
    documentNumber: "12/2020/NĐ-TEST",
    heading: "Điều 4. Trách nhiệm",
    legalText: "Điều 4. Trách nhiệm\nNội dung Điều 4.",
    provisionId: "prov_synthetic_cit_4",
    provisionVersionId: "pv_synthetic_cit_4_v1",
    validFrom: "2020-01-01",
    validTo: null,
  }),
];

const service = new LegalQueryService(new SyntheticLegalReadRepository(versions, []));
const context = {
  datasetReleaseId: syntheticReleaseId,
  knownAt: "2026-09-01T00:00:00.000Z",
  requestId: "request-synthetic-citation",
};
const execution = {
  deadlineAt: "2026-09-01T00:00:10.000Z",
  signal: new AbortController().signal,
};

describe("looking a provision up by the citation people actually write", () => {
  it("finds the version in force on the date, from document number and article", async () => {
    const before = await service.lookupByCitation(
      { article: 3, context, documentNumber: "12/2020/NĐ-TEST", validAt: "2023-06-01" },
      execution,
    );
    const after = await service.lookupByCitation(
      { article: 3, context, documentNumber: "12/2020/NĐ-TEST", validAt: "2025-06-01" },
      execution,
    );
    expect(before.data.status).toBe("resolved");
    expect(after.data.status).toBe("resolved");
    if (before.data.status === "resolved" && after.data.status === "resolved") {
      expect(before.data.provision.provisionVersionId).toBe("pv_synthetic_cit_3_v1");
      expect(after.data.provision.provisionVersionId).toBe("pv_synthetic_cit_3_v2");
    }
  });

  it("accepts a URL-safe slug, lowercase and a folded Đ as the same document number", async () => {
    const results = await Promise.all(
      ["12-2020-ND-TEST", "12/2020/nđ-test", "12 / 2020 / NĐ - TEST"].map(async (spelling) =>
        service.lookupByCitation(
          { article: 4, context, documentNumber: spelling, validAt: "2025-06-01" },
          execution,
        ),
      ),
    );
    for (const result of results) {
      expect(result.data.status).toBe("resolved");
    }
  });

  it("says the document is not in the corpus rather than guessing a neighbour", async () => {
    const result = await service.lookupByCitation(
      { article: 3, context, documentNumber: "99/2020/NĐ-TEST", validAt: "2025-06-01" },
      execution,
    );
    expect(result.data).toMatchObject({ reason: "DOCUMENT_NOT_IN_CORPUS", status: "unknown" });
  });

  it("says the article is not in the document", async () => {
    const result = await service.lookupByCitation(
      { article: 77, context, documentNumber: "12/2020/NĐ-TEST", validAt: "2025-06-01" },
      execution,
    );
    expect(result.data).toMatchObject({ reason: "ARTICLE_NOT_IN_DOCUMENT", status: "unknown" });
  });

  it("refuses an impossible article number as invalid input", async () => {
    await expect(
      service.lookupByCitation(
        { article: 0, context, documentNumber: "12/2020/NĐ-TEST", validAt: "2025-06-01" },
        execution,
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }) as Error);
  });
});

describe("checking whether a quotation says what the law said that day", () => {
  it("marks a faithful quotation exact and a lightly altered one close", async () => {
    const exact = await service.checkCitation(
      {
        article: 3,
        context,
        documentNumber: "12/2020/NĐ-TEST",
        quotedText: newText,
        validAt: "2025-06-01",
      },
      execution,
    );
    expect(exact.data).toMatchObject({ exists: true, inForceAtDate: true });
    expect(exact.data.textMatch.status).toBe("exact");

    const close = await service.checkCitation(
      {
        article: 3,
        context,
        documentNumber: "12/2020/NĐ-TEST",
        quotedText: "Điều 3. Nguyên tắc\nTổ chức phải nộp báo cáo trong mười lăm ngày làm việc.",
        validAt: "2025-06-01",
      },
      execution,
    );
    expect(close.data.textMatch.status).toBe("close");
  });

  it("catches a quotation of the old wording presented as the current one", async () => {
    // The quotation is real law - but the 2020 wording, cited against 2025.
    // That is exactly the mistake this exists to catch.
    const result = await service.checkCitation(
      {
        article: 3,
        context,
        documentNumber: "12/2020/NĐ-TEST",
        quotedText: oldText,
        validAt: "2025-06-01",
      },
      execution,
    );
    expect(result.data.exists).toBe(true);
    expect(result.data.inForceAtDate).toBe(true);
    expect(result.data.textMatch.status).not.toBe("exact");
    expect(result.data.target?.provisionVersionId).toBe("pv_synthetic_cit_3_v2");
  });

  it("reports a missing article without pretending to compare text", async () => {
    const result = await service.checkCitation(
      {
        article: 77,
        context,
        documentNumber: "12/2020/NĐ-TEST",
        quotedText: "bất kỳ",
        validAt: "2025-06-01",
      },
      execution,
    );
    expect(result.data).toMatchObject({
      exists: false,
      inForceAtDate: false,
      target: null,
      textMatch: { similarity: null, status: "not_checked" },
    });
  });

  it("checks existence and force alone when no text is supplied", async () => {
    const result = await service.checkCitation(
      {
        article: 4,
        context,
        documentNumber: "12/2020/NĐ-TEST",
        quotedText: null,
        validAt: "2025-06-01",
      },
      execution,
    );
    expect(result.data).toMatchObject({ exists: true, inForceAtDate: true });
    expect(result.data.textMatch.status).toBe("not_checked");
  });
});
