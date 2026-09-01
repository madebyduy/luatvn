import { extractVbplRelations } from "@luatvn/ingest";
import { describe, expect, it } from "vitest";

function relationFlight(byType: Record<string, { id: string; name: string }[]>): string {
  return [
    '0:["$@1",["drill-build",null]]',
    `1:${JSON.stringify({ documentNamesByType: byType, documentNamesBySource: {} })}`,
    "",
  ].join("\n");
}

describe("extractVbplRelations", () => {
  it("maps the verified amendment codes", () => {
    const { relations, unmapped } = extractVbplRelations(
      relationFlight({
        "10": [{ id: "166338", name: "Thông tư số 01/2024/TT-NHNN" }],
        "12": [{ id: "13936", name: "Quyết định số 28/2007/QĐ-NHNN" }],
      }),
    );
    expect(relations).toEqual([
      {
        relationType: "amends",
        targetName: "Thông tư số 01/2024/TT-NHNN",
        targetSourceId: "166338",
      },
      {
        relationType: "replaces",
        targetName: "Quyết định số 28/2007/QĐ-NHNN",
        targetSourceId: "13936",
      },
    ]);
    expect(unmapped).toEqual([]);
  });

  it("excludes legal-basis citations from amendment relations", () => {
    const { relations, unmapped } = extractVbplRelations(
      relationFlight({ "3": [{ id: "25692", name: "Luật Ngân hàng Nhà nước Việt Nam" }] }),
    );
    expect(relations).toEqual([]);
    expect(unmapped).toEqual([]);
  });

  it("reports unknown relation codes instead of guessing them", () => {
    const { relations, unmapped } = extractVbplRelations(
      relationFlight({ "99": [{ id: "1", name: "Văn bản lạ" }] }),
    );
    expect(relations).toEqual([]);
    expect(unmapped).toEqual([{ code: "99", documentCount: 1 }]);
  });

  it("returns nothing when the payload carries no relation graph", () => {
    expect(extractVbplRelations("0:[]\n1:null\n")).toEqual({ relations: [], unmapped: [] });
  });
});
