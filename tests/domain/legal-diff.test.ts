import { diffLegalText } from "@luatvn/domain";
import { describe, expect, it } from "vitest";

function reconstructBefore(chunks: ReturnType<typeof diffLegalText>): string {
  return chunks
    .filter((chunk) => chunk.operation !== "added")
    .flatMap((chunk) => chunk.lines)
    .join("\n");
}

function reconstructAfter(chunks: ReturnType<typeof diffLegalText>): string {
  return chunks
    .filter((chunk) => chunk.operation !== "removed")
    .flatMap((chunk) => chunk.lines)
    .join("\n");
}

describe("diffLegalText", () => {
  it("reconstructs both original texts without normalizing legal content", () => {
    const before = "Synthetic Điều 1\n  Khoản 1 giữ khoảng trắng\nDòng cũ";
    const after = "Synthetic Điều 1\n  Khoản 1 giữ khoảng trắng\nDòng mới";
    const chunks = diffLegalText(before, after);

    expect(reconstructBefore(chunks)).toBe(before);
    expect(reconstructAfter(chunks)).toBe(after);
    expect(chunks.some((chunk) => chunk.operation === "removed")).toBe(true);
    expect(chunks.some((chunk) => chunk.operation === "added")).toBe(true);
  });

  it("rejects unbounded line counts", () => {
    const oversized = Array.from({ length: 2_001 }, () => "Synthetic").join("\n");
    expect(() => diffLegalText(oversized, "Synthetic")).toThrow(RangeError);
  });
});
