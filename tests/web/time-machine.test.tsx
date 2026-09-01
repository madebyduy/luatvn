// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../apps/web/src/App.js";

const releaseId = "rel_drill_ui";
const provisionId = "prov_drill_a17";
const versionOne = "pv_drill_a17_e20200101";
const versionTwo = "pv_drill_a17_e20240101";

const citation = (provisionVersionId: string, validAt: string) => ({
  checkedAt: "2026-09-01T00:00:00.000Z",
  datasetReleaseId: releaseId,
  documentNumber: "01/2020/TT-DRILL",
  locator: "prov-article drill",
  provisionId,
  provisionVersionId,
  retrievedAt: "2026-08-31T00:00:00.000Z",
  reviewStatus: "verified",
  sourceSha256: "a".repeat(64),
  sourceUrl: "https://drill.invalid/van-ban/drill",
  validAt,
  validityStatus: "effective",
});

const envelope = (data: unknown) => ({
  data,
  release: { id: releaseId },
  untrustedContent: true,
  warnings: ["LEGAL_DATA_NOT_ADVICE"],
});

const catalogBody = envelope({
  documents: [
    {
      documentId: "doc_drill_one",
      documentNumber: "01/2020/TT-DRILL",
      provisions: [
        {
          heading: "Điều 1. Nguyên tắc diễn tập",
          provisionId,
          versions: [
            {
              provisionVersionId: versionOne,
              reviewStatus: "verified",
              validFrom: "2020-01-01",
              validTo: "2024-01-01",
            },
            {
              provisionVersionId: versionTwo,
              reviewStatus: "verified",
              validFrom: "2024-01-01",
              validTo: null,
            },
          ],
        },
      ],
    },
  ],
  status: "resolved",
});

const resolvedBody = envelope({
  citation: citation(versionOne, "2021-06-01"),
  provision: {
    heading: "Điều 1. Nguyên tắc diễn tập",
    legalText: "1. Nội dung diễn tập phiên bản thứ nhất.",
    provisionId,
    provisionVersionId: versionOne,
  },
  status: "resolved",
});

const unknownBody = envelope({
  candidateVersionIds: [versionOne],
  reason: "MATCH_ONLY_UNVERIFIED",
  status: "unknown",
});

const compareBody = envelope({
  chunks: [
    { lines: ["1. Nội dung giữ nguyên."], operation: "unchanged" },
    { lines: ["2. Câu cũ bị bỏ đi."], operation: "removed" },
    { lines: ["2. Câu mới được thêm vào."], operation: "added" },
  ],
  fromCitation: citation(versionOne, "2020-01-01"),
  provisionId,
  status: "resolved",
  toCitation: citation(versionTwo, "2024-01-01"),
});

const amendmentsBody = envelope({
  provisionId,
  relations: [
    {
      amendmentId: "amd_drill_one",
      effectiveFrom: "2024-01-01",
      evidence: [
        {
          evidenceId: "ev_drill_rel",
          locator: null,
          officialSourceUrl: "https://drill.invalid/van-ban/drill-amending",
          retrievedAt: "2026-08-31T00:00:00.000Z",
          sourceSha256: "b".repeat(64),
        },
      ],
      relationType: "amends",
      reviewStatus: "verified",
      sourceProvisionId: "prov_drill_amending",
      targetProvisionId: provisionId,
    },
  ],
  status: "resolved",
});

const emptyAmendmentsBody = envelope({ provisionId, relations: [], status: "resolved" });

function stubApi(bodies: Readonly<Record<string, unknown>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : input.toString();
      if (path === "/ready") {
        return Promise.resolve({
          json: () => Promise.resolve({ datasetReleaseId: releaseId, status: "ready" }),
          ok: true,
          status: 200,
        } as Response);
      }
      const body = bodies[path];
      if (body === undefined) {
        return Promise.reject(new TypeError(`unexpected call to ${path}`));
      }
      return Promise.resolve({
        json: () => Promise.resolve(body),
        ok: true,
        status: 200,
      } as Response);
    }),
  );
}

async function waitForCatalog(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole("link", { name: /Điều 1. Nguyên tắc diễn tập/u })).toBeDefined();
  });
}

async function chooseProvision(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("link", { name: /Điều 1. Nguyên tắc diễn tập/u }));
}

async function expectNoAxeViolations(container: HTMLElement) {
  // color-contrast cannot run under jsdom because there is no layout engine;
  // the ratios are computed and recorded in apps/web/src/styles.css instead.
  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
}

beforeEach(() => {
  globalThis.history.pushState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("provision picker", () => {
  it("offers the provisions of the published release instead of asking for an identifier", async () => {
    stubApi({ "/v1/catalog": catalogBody });
    render(<App />);
    await waitForCatalog();

    expect(screen.getByRole("heading", { name: "01/2020/TT-DRILL" })).toBeDefined();
    const entry = screen.getByRole("link", { name: /Điều 1. Nguyên tắc diễn tập/u });
    expect(entry.textContent).toContain("2 phiên bản");
  });

  it("falls back to a text field and explains why when the catalog cannot load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/ready") {
          return Promise.resolve({
            json: () => Promise.resolve({ datasetReleaseId: releaseId, status: "ready" }),
            ok: true,
            status: 200,
          } as Response);
        }
        return Promise.reject(new TypeError("network down"));
      }),
    );
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Không tải được danh mục/u)).toBeDefined();
    });
    expect(screen.getByLabelText<HTMLInputElement>("Mã điều khoản").tagName).toBe("INPUT");
  });
});

describe("Tra cứu theo thời điểm", () => {
  it("shows a resolved provision together with its evidence", async () => {
    stubApi({ "/v1/catalog": catalogBody, "/v1/provisions/at": resolvedBody });
    render(<App />);
    await waitForCatalog();

    await chooseProvision();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Ngày pháp lý cần hỏi"), "2021-06-01");
    await user.click(screen.getByRole("button", { name: "Tra cứu" }));

    expect(
      await screen.findByRole("heading", { name: "Điều 1. Nguyên tắc diễn tập" }),
    ).toBeDefined();
    expect(screen.getByText("1. Nội dung diễn tập phiên bản thứ nhất.")).toBeDefined();
    expect(screen.getByRole("link", { name: /drill\.invalid/u })).toBeDefined();
    expect(screen.getByText("a".repeat(64))).toBeDefined();
  });

  it("puts the whole question in the address bar so a reload repeats it", async () => {
    stubApi({ "/v1/catalog": catalogBody, "/v1/provisions/at": resolvedBody });
    render(<App />);
    await waitForCatalog();

    await chooseProvision();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Ngày pháp lý cần hỏi"), "2021-06-01");
    await user.click(screen.getByRole("button", { name: "Tra cứu" }));

    await waitFor(() => {
      expect(globalThis.location.search).toContain(`provision=${provisionId}`);
    });
    expect(globalThis.location.search).toContain("view=tra-cuu");
    expect(globalThis.location.search).toContain("validAt=2021-06-01");
    expect(globalThis.location.search).toContain(`release=${releaseId}`);
  });

  it("presents unknown as its own answer without offering a nearest match", async () => {
    stubApi({ "/v1/catalog": catalogBody, "/v1/provisions/at": unknownBody });
    render(<App />);
    await waitForCatalog();

    await chooseProvision();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Ngày pháp lý cần hỏi"), "2015-06-01");
    await user.click(screen.getByRole("button", { name: "Tra cứu" }));

    expect(await screen.findByText("Không có câu trả lời chắc chắn")).toBeDefined();
    expect(screen.queryByText("Đã xác định")).toBeNull();
    expect(screen.queryByText("Nguyên văn")).toBeNull();
  });
});

describe("So sánh hai phiên bản", () => {
  it("shows added, removed and unchanged text as the source wrote it", async () => {
    stubApi({ "/v1/catalog": catalogBody, "/v1/provisions/compare": compareBody });
    globalThis.history.pushState(null, "", `?view=so-sanh&release=${releaseId}`);
    render(<App />);
    await waitForCatalog();

    await chooseProvision();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Phiên bản trước"), versionOne);
    await user.selectOptions(screen.getByLabelText("Phiên bản sau"), versionTwo);
    await user.click(screen.getByRole("button", { name: "So sánh" }));

    expect(await screen.findByText("Thay đổi giữa hai phiên bản")).toBeDefined();
    expect(screen.getByText("2. Câu cũ bị bỏ đi.")).toBeDefined();
    expect(screen.getByText("2. Câu mới được thêm vào.")).toBeDefined();
    expect(screen.getByText("1. Nội dung giữ nguyên.")).toBeDefined();
    expect(screen.getByText(/Có 2 đoạn khác nhau/u)).toBeDefined();
  });

  it("offers the versions of the chosen provision with their date ranges", async () => {
    stubApi({ "/v1/catalog": catalogBody });
    globalThis.history.pushState(null, "", `?view=so-sanh&release=${releaseId}`);
    render(<App />);
    await waitForCatalog();

    await chooseProvision();
    expect(
      screen.getAllByRole("option", { name: "Từ 2020-01-01 đến trước 2024-01-01" }),
    ).toHaveLength(2);
    expect(screen.getAllByRole("option", { name: "Từ 2024-01-01 trở đi" })).toHaveLength(2);
  });
});

describe("Lược sử sửa đổi", () => {
  it("lists verified amendment relations with their source", async () => {
    stubApi({ "/v1/catalog": catalogBody, "/v1/provisions/amendments": amendmentsBody });
    globalThis.history.pushState(
      null,
      "",
      `?view=luoc-su&provision=${provisionId}&release=${releaseId}`,
    );
    render(<App />);

    expect(await screen.findByText("1 quan hệ sửa đổi đã kiểm chứng")).toBeDefined();
    expect(screen.getByText(/sửa đổi, bổ sung/u)).toBeDefined();
    expect(screen.getByText("prov_drill_amending")).toBeDefined();
    expect(screen.getByText("b".repeat(64))).toBeDefined();
  });

  it("says plainly that no verified relation exists rather than implying none happened", async () => {
    stubApi({ "/v1/catalog": catalogBody, "/v1/provisions/amendments": emptyAmendmentsBody });
    globalThis.history.pushState(
      null,
      "",
      `?view=luoc-su&provision=${provisionId}&release=${releaseId}`,
    );
    render(<App />);

    expect(await screen.findByText("Không có quan hệ sửa đổi đã kiểm chứng")).toBeDefined();
    expect(screen.getByText(/không có nghĩa là điều khoản chưa từng bị sửa/u)).toBeDefined();
  });
});

describe("navigation and failure states", () => {
  it("switches view from the tabs and keeps it in the URL", async () => {
    stubApi({ "/v1/catalog": catalogBody });
    render(<App />);
    await waitForCatalog();

    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Lược sử sửa đổi" }));
    await waitFor(() => {
      expect(globalThis.location.search).toContain("view=luoc-su");
    });
    expect(screen.getByRole("link", { name: "Lược sử sửa đổi" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("keeps the question when the API is unreachable", async () => {
    stubApi({ "/v1/catalog": catalogBody });
    globalThis.history.pushState(
      null,
      "",
      `?view=tra-cuu&provision=${provisionId}&validAt=2021-06-01&release=${releaseId}`,
    );
    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Không kết nối được tới máy chủ dữ liệu.");
    expect(globalThis.location.search).toContain(`provision=${provisionId}`);
  });

  it("rejects a response that does not match the published contract", async () => {
    stubApi({ "/v1/catalog": catalogBody, "/v1/provisions/at": envelope({ status: "resolved" }) });
    globalThis.history.pushState(
      null,
      "",
      `?view=tra-cuu&provision=${provisionId}&validAt=2021-06-01&release=${releaseId}`,
    );
    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("không khớp hợp đồng công khai");
  });
});

describe("accessibility", () => {
  it("has no automated violations on the lookup screen", async () => {
    stubApi({ "/v1/catalog": catalogBody, "/v1/provisions/at": resolvedBody });
    globalThis.history.pushState(
      null,
      "",
      `?view=tra-cuu&provision=${provisionId}&validAt=2021-06-01&release=${releaseId}`,
    );
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Điều 1. Nguyên tắc diễn tập" });
    await expectNoAxeViolations(container);
  });

  it("has no automated violations on the comparison screen", async () => {
    stubApi({ "/v1/catalog": catalogBody, "/v1/provisions/compare": compareBody });
    globalThis.history.pushState(
      null,
      "",
      `?view=so-sanh&provision=${provisionId}&from=${versionOne}&to=${versionTwo}&release=${releaseId}`,
    );
    const { container } = render(<App />);
    await screen.findByText("Thay đổi giữa hai phiên bản");
    await expectNoAxeViolations(container);
  });

  it("has no automated violations on the amendment history screen", async () => {
    stubApi({ "/v1/catalog": catalogBody, "/v1/provisions/amendments": amendmentsBody });
    globalThis.history.pushState(
      null,
      "",
      `?view=luoc-su&provision=${provisionId}&release=${releaseId}`,
    );
    const { container } = render(<App />);
    await screen.findByText("1 quan hệ sửa đổi đã kiểm chứng");
    await expectNoAxeViolations(container);
  });

  it("can be driven from the keyboard alone", async () => {
    stubApi({ "/v1/catalog": catalogBody });
    render(<App />);
    await waitForCatalog();

    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement?.textContent).toContain("Bỏ qua, tới nội dung chính");
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Tra cứu theo thời điểm");
  });
});
