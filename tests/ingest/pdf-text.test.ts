import { createHash } from "node:crypto";

import {
  extractPdfLines,
  joinFragments,
  normaliseLineText,
  PdfTextError,
  type Fragment,
} from "@luatvn/pdf-text";
import { describe, expect, it } from "vitest";

function fragment(text: string, x: number, width: number): Fragment {
  return { fontSize: 20, text, width, x };
}

function digest(value: string): string {
  return createHash("sha256").update(normaliseLineText(value), "utf8").digest("hex");
}

describe("normalising text taken out of a PDF", () => {
  it("folds a partly decomposed Vietnamese word into the same string as the precomposed one", () => {
    // Measured on a real gazette PDF: "Điều" occurs both as U+1EC1 and as "ê"
    // followed by U+0300. A heading pattern written one way misses the other,
    // which cost 24 of 28 articles in one consolidated document before this.
    const precomposed = "Điều";
    const decomposed = "Diều".replace("D", "Đ");
    expect(precomposed).not.toBe(decomposed);
    expect(normaliseLineText(decomposed)).toBe(precomposed);
    expect(normaliseLineText(decomposed).startsWith("Điều")).toBe(true);
  });

  it("gives two visually identical texts the same hash, so re-derivation holds", () => {
    // The verification chain compares legalTextSha256 against text re-derived
    // from archived bytes. Without normalisation the same words in different
    // normal forms hash differently and every check would fail.
    expect(digest("Điều 1")).toBe(digest("Điều 1"));
  });

  it("collapses runs of spacing but keeps the words apart", () => {
    expect(normaliseLineText("  Điều   1.\tPhạm  vi  ")).toBe("Điều 1. Phạm vi");
  });

  it("joins fragments in reading order without inventing a space between them", () => {
    // A diacritic is often its own positioned fragment. Guessing a space from
    // the x-gap turns "thuật" into "thu ậ t".
    const joined = joinFragments([
      fragment("t", 130, 6),
      fragment("thu", 100, 20),
      fragment("ậ", 120, 8),
    ]);
    expect(joined).toBe("thuật");
  });

  it("keeps a space the document actually contains", () => {
    expect(
      joinFragments([fragment("Điều", 100, 30), fragment(" ", 130, 4), fragment("1", 134, 6)]),
    ).toBe("Điều 1");
  });
});

describe("refusing a PDF that carries no text", () => {
  it("reports a scanned or empty document instead of returning nothing", async () => {
    // A one-page PDF with no text operators at all: parses fine, yields
    // nothing. Silently returning zero provisions would look like a document
    // that simply has none.
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>",
      "<< /Length 0 >>\nstream\n\nendstream",
    ];
    let body = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (const [index, object] of objects.entries()) {
      offsets.push(body.length);
      body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
    }
    const startxref = body.length;
    body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      body += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(startxref)}\n%%EOF\n`;

    await expect(extractPdfLines(new TextEncoder().encode(body))).rejects.toThrowError(
      expect.objectContaining({ code: "PDF_HAS_NO_TEXT_LAYER" }) as Error,
    );
  });

  it("reports bytes that are not a PDF as unreadable, with a typed code", async () => {
    await expect(
      extractPdfLines(new TextEncoder().encode("đây không phải là PDF")),
    ).rejects.toBeInstanceOf(PdfTextError);
  });
});
