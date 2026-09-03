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

// Placeholder wording. Two articles of one synthetic document: Điều 1 cites
// Điều 2 of the same document, a law that is not in the corpus, and a numbered
// decree that is not in the corpus. Điều 2 has two versions so the link must
// pick the one in force at the date asked.
function version(overrides: {
  readonly legalText: string;
  readonly provisionId: string;
  readonly provisionVersionId: string;
  readonly heading: string;
  readonly validFrom: string;
  readonly validTo: string | null;
}): PublishedProvisionVersion {
  return Object.assign({}, syntheticVersionOne, {
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

const articleOne = version({
  heading: "Điều 1. Phạm vi",
  legalText:
    "Điều 1. Phạm vi\nÁp dụng theo Điều 2 của Nghị định này, Điều 9 Luật Không Có Trong Kho và khoản 1 Điều 3 Nghị định số 999/2020/NĐ-CP.",
  provisionId: "prov_synthetic_ref_1",
  provisionVersionId: "pv_synthetic_ref_1_v1",
  validFrom: "2020-01-01",
  validTo: null,
});

const articleTwoOld = version({
  heading: "Điều 2. Đối tượng",
  legalText: "Điều 2. Đối tượng\nBản cũ.",
  provisionId: "prov_synthetic_ref_2",
  provisionVersionId: "pv_synthetic_ref_2_v1",
  validFrom: "2020-01-01",
  validTo: "2024-01-01",
});

const articleTwoNew = version({
  heading: "Điều 2. Đối tượng",
  legalText: "Điều 2. Đối tượng\nBản mới.",
  provisionId: "prov_synthetic_ref_2",
  provisionVersionId: "pv_synthetic_ref_2_v2",
  validFrom: "2024-01-01",
  validTo: null,
});

function serviceWith(versions: readonly PublishedProvisionVersion[]): LegalQueryService {
  return new LegalQueryService(new SyntheticLegalReadRepository(versions, []));
}

async function referencesAt(validAt: string) {
  const service = serviceWith([articleOne, articleTwoOld, articleTwoNew]);
  const result = await service.getProvisionAt(
    {
      context: {
        datasetReleaseId: syntheticReleaseId,
        knownAt: "2026-09-01T00:00:00.000Z",
        requestId: "request-synthetic-references",
      },
      provisionId: "prov_synthetic_ref_1",
      validAt,
    },
    { deadlineAt: "2026-09-01T00:00:10.000Z", signal: new AbortController().signal },
  );
  if (result.data.status !== "resolved") {
    throw new Error(`expected resolved, got ${result.data.status}`);
  }
  return result.data.references;
}

describe("resolving cross-references at the date being read", () => {
  it("links a same-document article to the version in force at that date", async () => {
    const before = await referencesAt("2023-06-01");
    const after = await referencesAt("2025-06-01");
    const sameDocumentBefore = before.find((reference) => reference.kind === "same_document");
    const sameDocumentAfter = after.find((reference) => reference.kind === "same_document");
    expect(sameDocumentBefore?.target?.provisionVersionId).toBe("pv_synthetic_ref_2_v1");
    expect(sameDocumentAfter?.target?.provisionVersionId).toBe("pv_synthetic_ref_2_v2");
  });

  it("reports a titled law the corpus does not hold, instead of guessing", async () => {
    const references = await referencesAt("2025-06-01");
    const named = references.find((reference) => reference.kind === "named_document");
    expect(named?.target).toBeNull();
    expect(named?.reason).toBe("NOT_IN_CORPUS");
  });

  it("reports a numbered decree the corpus does not hold", async () => {
    const references = await referencesAt("2025-06-01");
    const numbered = references.find((reference) => reference.kind === "numbered_document");
    expect(numbered?.documentNumber).toBe("999/2020/NĐ-CP");
    expect(numbered?.target).toBeNull();
    expect(numbered?.reason).toBe("NOT_IN_CORPUS");
  });

  it("carries exact offsets so a renderer can wrap the reference in place", async () => {
    const references = await referencesAt("2025-06-01");
    for (const reference of references) {
      expect(articleOne.legalText.slice(reference.start, reference.end)).toBe(reference.text);
    }
  });
});
