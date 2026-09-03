// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AskView } from "../../apps/web/src/components/AskView.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const context = { datasetReleaseId: "rel_drill_ui", knownAt: "2026-09-01T00:00:00.000Z" };

function stubSearch(data: unknown) {
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

describe("asking in plain language on the web", () => {
  it("lists matching provisions with their trust tier and a link to the text on that date", async () => {
    stubSearch({
      corpusEmpty: false,
      nothingRelevant: false,
      query: "công ty nợ lương",
      results: [
        {
          documentNumber: "45/2019/QH14",
          heading: "Điều 94. Nguyên tắc trả lương",
          provisionId: "prov_drill_94",
          provisionVersionId: "pv_drill_94_v1",
          reviewStatus: "machine_checked",
          score: 0.83,
          snippet: "Trả lương đầy đủ, đúng hạn cho người lao động.",
          validFrom: "2021-01-01",
          validTo: null,
        },
      ],
      retriever: "lexical-bm25",
      status: "resolved",
      validAt: "2026-09-01",
    });
    const asked = vi.fn();
    const user = userEvent.setup();
    render(<AskView context={context} initialQuery="" onAsked={asked} />);
    await user.type(
      screen.getByLabelText("Kể tình huống của bạn bằng tiếng thường"),
      "công ty nợ lương",
    );
    await user.click(screen.getByRole("button", { name: "Tìm điều luật" }));

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Điều 94. Nguyên tắc trả lương" })).toBeTruthy();
    });
    const href =
      screen.getByRole("link", { name: "Điều 94. Nguyên tắc trả lương" }).getAttribute("href") ??
      "";
    expect(href).toContain("provision=prov_drill_94");
    expect(href).toContain("validAt=2026-09-01");
    expect(screen.getByText("Đã đối soát, chưa người duyệt")).toBeTruthy();
    expect(asked).toHaveBeenCalledWith("công ty nợ lương");
  });

  it("says the corpus has nothing, instead of inventing an answer", async () => {
    stubSearch({
      corpusEmpty: false,
      nothingRelevant: true,
      query: "thuế",
      results: [],
      retriever: "lexical-bm25",
      status: "resolved",
      validAt: "2026-09-01",
    });
    const user = userEvent.setup();
    render(<AskView context={context} initialQuery="" onAsked={vi.fn()} />);
    await user.type(screen.getByLabelText("Kể tình huống của bạn bằng tiếng thường"), "thuế");
    await user.click(screen.getByRole("button", { name: "Tìm điều luật" }));

    await waitFor(() => {
      expect(screen.getByText("Kho chưa có điều luật nào khớp với mô tả này")).toBeTruthy();
    });
    expect(screen.queryByRole("list")).toBeNull();
  });
});
