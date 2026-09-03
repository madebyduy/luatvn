import { extractLegalReferences } from "@luatvn/domain";
import { describe, expect, it } from "vitest";

// The wording is placeholder or quoted from real drafting *patterns*; the
// tests exercise the grammar, not legal content.

describe("extracting cross-references from legal text", () => {
  it("reads an article of a named law, with clause and point", () => {
    const [reference] = extractLegalReferences(
      "Nghị định này quy định chi tiết khoản 1 Điều 5 Luật An ninh mạng, bao gồm:",
    );
    expect(reference).toMatchObject({
      article: 5,
      clause: 1,
      documentTitle: "An ninh mạng",
      documentType: "Luật",
      kind: "named_document",
      point: null,
      text: "khoản 1 Điều 5 Luật An ninh mạng",
    });
  });

  it("stops a law title before a conjunction or punctuation", () => {
    const [reference] = extractLegalReferences(
      "theo Điều 14 Luật An ninh mạng và pháp luật có liên quan.",
    );
    expect(reference?.documentTitle).toBe("An ninh mạng");
  });

  it("reads a reference to the document being read", () => {
    const references = extractLegalReferences(
      "Áp dụng biện pháp tại Điều 7 của Nghị định này và Chương IV của Nghị định này.",
    );
    expect(
      references.map((reference) => [reference.kind, reference.article, reference.chapter]),
    ).toEqual([
      ["same_document", 7, null],
      ["same_document", null, "IV"],
    ]);
  });

  it("reads a reference to a numbered document", () => {
    const [reference] = extractLegalReferences(
      "được sửa đổi bởi khoản 2 Điều 1 Nghị định số 100/2019/NĐ-CP ngày 30 tháng 12 năm 2019",
    );
    expect(reference).toMatchObject({
      article: 1,
      clause: 2,
      documentNumber: "100/2019/NĐ-CP",
      kind: "numbered_document",
    });
  });

  it("reads 'khoản 2 Điều này' as the same document without an article number", () => {
    const [reference] = extractLegalReferences("trừ trường hợp quy định tại khoản 2 Điều này.");
    expect(reference).toMatchObject({ article: null, clause: 2, kind: "same_document" });
  });

  it("survives a line break inside the reference", () => {
    const [reference] = extractLegalReferences("theo quy định tại Chương IV của\nNghị định này.");
    expect(reference?.chapter).toBe("IV");
  });

  it("keeps one reference per span, preferring the most specific", () => {
    const references = extractLegalReferences("theo khoản 1 Điều 5 Luật An ninh mạng.");
    expect(references).toHaveLength(1);
  });

  it("returns exact offsets so a renderer can wrap precisely the reference", () => {
    const text = "Xem Điều 7 của Nghị định này để biết thêm.";
    const [reference] = extractLegalReferences(text);
    expect(reference).toBeDefined();
    if (reference !== undefined) {
      expect(text.slice(reference.start, reference.end)).toBe(reference.text);
    }
  });

  it("leaves vague references alone rather than guessing", () => {
    expect(extractLegalReferences("theo quy định của pháp luật hiện hành.")).toEqual([]);
  });
});
