// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ProvisionResult } from "../../apps/web/src/components/ProvisionResult.js";
import type { ProvisionAtResponse } from "../../apps/web/src/api.js";

afterEach(() => {
  cleanup();
});

// Placeholder wording. One line of legal text carries two references: the
// first resolves to another article in the corpus, the second names a law the
// corpus does not hold.
const legalText = "Điều 1. Phạm vi\nÁp dụng theo Điều 2 của Nghị định này và Điều 9 Luật Không Có.";
const firstStart = legalText.indexOf("Điều 2 của Nghị định này");
const secondStart = legalText.indexOf("Điều 9 Luật Không Có");

const response: ProvisionAtResponse = {
  data: {
    citation: {
      checkedAt: "2026-09-01T00:00:00.000Z",
      datasetReleaseId: "rel_drill_ui",
      documentNumber: "01/2020/TT-DRILL",
      locator: null,
      provisionId: "prov_drill_a1",
      provisionVersionId: "pv_drill_a1_e20200101",
      retrievedAt: "2026-08-31T00:00:00.000Z",
      reviewStatus: "verified",
      sourceSha256: "a".repeat(64),
      sourceUrl: "https://drill.invalid/van-ban/drill",
      validAt: "2023-06-01",
      validityStatus: "effective",
    },
    provision: {
      heading: "Điều 1. Phạm vi",
      legalText,
      provisionId: "prov_drill_a1",
      provisionVersionId: "pv_drill_a1_e20200101",
    },
    references: [
      {
        article: 2,
        chapter: null,
        clause: null,
        documentNumber: null,
        documentTitle: null,
        documentType: "Nghị định",
        end: firstStart + "Điều 2 của Nghị định này".length,
        kind: "same_document",
        point: null,
        reason: null,
        start: firstStart,
        target: { provisionId: "prov_drill_a2", provisionVersionId: "pv_drill_a2_e20200101" },
        text: "Điều 2 của Nghị định này",
      },
      {
        article: 9,
        chapter: null,
        clause: null,
        documentNumber: null,
        documentTitle: "Không Có",
        documentType: "Luật",
        end: secondStart + "Điều 9 Luật Không Có".length,
        kind: "named_document",
        point: null,
        reason: "NOT_IN_CORPUS",
        start: secondStart,
        target: null,
        text: "Điều 9 Luật Không Có",
      },
    ],
    status: "resolved",
  },
  release: { id: "rel_drill_ui" },
  untrustedContent: true,
  warnings: ["LEGAL_DATA_NOT_ADVICE"],
};

describe("cross-references rendered inside the legal text", () => {
  it("turns a resolved reference into a link to that article at the same legal date", () => {
    render(<ProvisionResult response={response} />);
    const link = screen.getByRole("link", { name: "Điều 2 của Nghị định này" });
    const href = link.getAttribute("href") ?? "";
    expect(href).toContain("provision=prov_drill_a2");
    expect(href).toContain("validAt=2023-06-01");
    expect(href).toContain("release=rel_drill_ui");
  });

  it("leaves an unresolved reference as text and says why on hover, never a guessed link", () => {
    render(<ProvisionResult response={response} />);
    const unresolved = screen.getByText("Điều 9 Luật Không Có");
    expect(unresolved.tagName).toBe("SPAN");
    expect(unresolved.getAttribute("title")).toContain("chưa có trong kho");
    expect(screen.queryByRole("link", { name: "Điều 9 Luật Không Có" })).toBeNull();
  });

  it("keeps the surrounding text intact around the links", () => {
    render(<ProvisionResult response={response} />);
    const paragraph = screen.getByText("Điều 2 của Nghị định này").closest("p");
    expect(paragraph?.textContent).toBe(
      "Áp dụng theo Điều 2 của Nghị định này và Điều 9 Luật Không Có.",
    );
  });
});
