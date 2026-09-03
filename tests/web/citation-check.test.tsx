// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CitationCheckView } from "../../apps/web/src/components/CitationCheckView.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const context = { datasetReleaseId: "rel_drill_ui", knownAt: "2026-09-01T00:00:00.000Z" };

function stubCheck(data: unknown) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        data,
        release: { id: "rel_drill_ui" },
        untrustedContent: true,
        warnings: ["LEGAL_DATA_NOT_ADVICE"],
      }),
      { headers: { "content-type": "application/json" }, status: 200 },
    ),
  );
}

async function submit(user: ReturnType<typeof userEvent.setup>, quoted: string) {
  await user.type(screen.getByLabelText("Số hiệu văn bản"), "01/2020/TT-DRILL");
  await user.type(screen.getByLabelText("Số Điều"), "1");
  await user.type(screen.getByLabelText("Ngày pháp lý"), "2023-06-01");
  if (quoted !== "") {
    await user.type(screen.getByLabelText("Đoạn được trích (tuỳ chọn)"), quoted);
  }
  await user.click(screen.getByRole("button", { name: "Kiểm chứng" }));
}

describe("checking a pasted citation on the web", () => {
  it("shows the three answers separately for a faithful quotation", async () => {
    stubCheck({
      article: 1,
      citation: {
        checkedAt: "2026-09-01T00:00:00.000Z",
        datasetReleaseId: "rel_drill_ui",
        documentNumber: "01/2020/TT-DRILL",
        locator: null,
        provisionId: "prov_drill_a1",
        provisionVersionId: "pv_drill_a1_e20200101",
        retrievedAt: "2026-08-31T00:00:00.000Z",
        reviewStatus: "machine_checked",
        sourceSha256: "a".repeat(64),
        sourceUrl: "https://drill.invalid/van-ban/drill",
        validAt: "2023-06-01",
        validityStatus: "effective",
      },
      documentNumber: "01/2020/TT-DRILL",
      exists: true,
      inForceAtDate: true,
      status: "resolved",
      target: { provisionId: "prov_drill_a1", provisionVersionId: "pv_drill_a1_e20200101" },
      textMatch: { similarity: 1, status: "exact" },
      validAt: "2023-06-01",
    });
    const user = userEvent.setup();
    render(<CitationCheckView context={context} />);
    await submit(user, "Điều 1. Nội dung diễn tập.");

    await waitFor(() => {
      expect(screen.getByText("Khớp nguyên văn")).toBeTruthy();
    });
    expect(screen.getAllByText("Có")).toHaveLength(2);
    // The trust tier is shown, not hidden, next to the verdict.
    expect(screen.getByText("machine_checked")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Mở nguyên văn tại ngày 2023-06-01/u })).toBeTruthy();
  });

  it("says the article is not in the corpus without pretending to compare", async () => {
    stubCheck({
      article: 1,
      citation: null,
      documentNumber: "01/2020/TT-DRILL",
      exists: false,
      inForceAtDate: false,
      status: "resolved",
      target: null,
      textMatch: { similarity: null, status: "not_checked" },
      validAt: "2023-06-01",
    });
    const user = userEvent.setup();
    render(<CitationCheckView context={context} />);
    await submit(user, "");

    await waitFor(() => {
      expect(screen.getByText(/kho chưa có văn bản hoặc Điều này/u)).toBeTruthy();
    });
    expect(screen.getByText("Không có đoạn trích để so")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Mở nguyên văn/u })).toBeNull();
  });
});
