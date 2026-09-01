import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

// One job: turn PDF bytes into positioned, normalised lines of text. Nothing in
// here knows what a legal provision is. The DOM lib this package enables for
// pdfjs's typings stops at this boundary.

export interface TextLine {
  readonly page: number;
  /** Baseline position in PDF user space; larger y is higher on the page. */
  readonly y: number;
  /** Left edge of the first fragment on the line. */
  readonly x: number;
  /** Largest glyph height on the line, used to tell body text from apparatus. */
  readonly fontSize: number;
  readonly text: string;
}

export interface PdfTextDocument {
  readonly pageCount: number;
  readonly lines: readonly TextLine[];
  /** Distinct glyph heights and how many lines carry each, largest first. */
  readonly fontSizeHistogram: readonly { readonly fontSize: number; readonly lines: number }[];
}

export type PdfTextErrorCode = "PDF_UNREADABLE" | "PDF_HAS_NO_TEXT_LAYER";

export class PdfTextError extends Error {
  public readonly code: PdfTextErrorCode;

  public constructor(code: PdfTextErrorCode, message: string) {
    super(message);
    this.name = "PdfTextError";
    this.code = code;
  }
}

export interface ExtractLinesOptions {
  /**
   * Baselines this close together are one visual line. PDF baselines wobble by
   * a fraction of a point, so exact equality splits a line in two.
   */
  readonly baselineTolerance?: number;
  /** Below this many characters a document is treated as having no text layer. */
  readonly minimumCharacters?: number;
}

const defaultBaselineTolerance = 2;
const defaultMinimumCharacters = 40;

export interface Fragment {
  readonly x: number;
  readonly width: number;
  readonly fontSize: number;
  readonly text: string;
}

interface PdfTextItem {
  readonly str?: unknown;
  readonly width?: unknown;
  readonly transform?: unknown;
}

function fragmentOf(item: PdfTextItem): Fragment | null {
  const { str, transform, width } = item;
  if (typeof str !== "string" || str === "") {
    return null;
  }
  if (!Array.isArray(transform) || transform.length < 6) {
    return null;
  }
  const scaleX = transform[0];
  const scaleY = transform[3];
  const x = transform[4];
  const y = transform[5];
  if (
    typeof scaleX !== "number" ||
    typeof scaleY !== "number" ||
    typeof x !== "number" ||
    typeof y !== "number"
  ) {
    return null;
  }
  return {
    fontSize: Math.hypot(scaleX, scaleY),
    text: str,
    width: typeof width === "number" ? width : 0,
    x,
  };
}

// Fragments are joined in x order and never separated by a guessed space.
// pdfjs already emits an explicit space item wherever the document has one;
// inferring extra spaces from x-gaps splits words, because a Vietnamese
// diacritic is frequently its own positioned fragment ("thu" + "ậ" + "t").
export function joinFragments(fragments: readonly Fragment[]): string {
  return fragments
    .toSorted((left, right) => left.x - right.x)
    .map((fragment) => fragment.text)
    .join("");
}

/**
 * Normalising to NFC is not cosmetic. These documents mix precomposed
 * characters with partly decomposed ones - "Điều" occurs both as U+1EC1 and as
 * "ê" followed by U+0300 - so a pattern written one way silently misses
 * headings written the other way. It also decides the hash: two visually
 * identical texts in different normal forms produce different SHA-256 digests,
 * which would break re-derivation of a published release.
 */
export function normaliseLineText(text: string): string {
  return text
    .normalize("NFC")
    .replaceAll(/[\t  ]+/gu, " ")
    .trim();
}

export async function extractPdfLines(
  bytes: Uint8Array,
  options: ExtractLinesOptions = {},
): Promise<PdfTextDocument> {
  const tolerance = options.baselineTolerance ?? defaultBaselineTolerance;
  const minimumCharacters = options.minimumCharacters ?? defaultMinimumCharacters;

  let pdf;
  try {
    // A copy, because pdfjs transfers ownership of the buffer it is given.
    pdf = await pdfjs.getDocument({
      data: Uint8Array.from(bytes),
      useSystemFonts: false,
    }).promise;
  } catch (error) {
    throw new PdfTextError(
      "PDF_UNREADABLE",
      `không đọc được PDF: ${error instanceof Error ? error.message : "lỗi không rõ"}`,
    );
  }

  const lines: TextLine[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    // eslint-disable-next-line no-await-in-loop -- pages must be read in order and pdfjs keeps one document handle
    const page = await pdf.getPage(pageNumber);
    // eslint-disable-next-line no-await-in-loop -- same handle, sequential by design
    const content = await page.getTextContent();
    const rows = new Map<number, Fragment[]>();
    for (const item of content.items) {
      const fragment = fragmentOf(item as PdfTextItem);
      if (fragment === null) {
        continue;
      }
      const rawItem = item as { transform?: unknown };
      const transform = rawItem.transform as number[];
      const baseline = transform[5] ?? 0;
      const key = Math.round(baseline / tolerance) * tolerance;
      const row = rows.get(key);
      if (row === undefined) {
        rows.set(key, [fragment]);
      } else {
        row.push(fragment);
      }
    }
    for (const [y, fragments] of [...rows.entries()].toSorted(
      (left, right) => right[0] - left[0],
    )) {
      const text = normaliseLineText(joinFragments(fragments));
      if (text === "") {
        continue;
      }
      lines.push({
        fontSize: Math.round(Math.max(...fragments.map((f) => f.fontSize)) * 10) / 10,
        page: pageNumber,
        text,
        x: Math.round(Math.min(...fragments.map((f) => f.x))),
        y,
      });
    }
  }

  const characters = lines.reduce((total, line) => total + line.text.length, 0);
  if (characters < minimumCharacters) {
    // A scanned document parses fine and yields almost nothing. Returning an
    // empty result would look like a document with no provisions, so refuse.
    throw new PdfTextError(
      "PDF_HAS_NO_TEXT_LAYER",
      `PDF ${String(pdf.numPages)} trang chỉ cho ${String(characters)} ký tự; nhiều khả năng là bản scan, cần nhập tay`,
    );
  }

  const histogram = new Map<number, number>();
  for (const line of lines) {
    histogram.set(line.fontSize, (histogram.get(line.fontSize) ?? 0) + 1);
  }

  return {
    fontSizeHistogram: [...histogram.entries()]
      .map(([fontSize, count]) => ({ fontSize, lines: count }))
      .toSorted((left, right) => right.lines - left.lines),
    lines,
    pageCount: pdf.numPages,
  };
}
