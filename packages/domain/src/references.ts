// Cross-references inside legal text: "khoản 1 Điều 5 Luật An ninh mạng",
// "Điều 7 của Nghị định này", "Chương IV của Nghị định này", "Nghị định số
// 100/2019/NĐ-CP". Recognised by rule, on the forms measured in real gazette
// text. Anything the grammar does not cover is left as plain text - a
// reference that is not linked is a smaller failure than one linked to the
// wrong place, and the coverage gap is reportable.

export type LegalReferenceKind =
  /** "Điều 7 của Nghị định này", "Chương IV của Luật này" - the document being read. */
  | "same_document"
  /** "Điều 14 Luật An ninh mạng" - another document named by title. */
  | "named_document"
  /** "Nghị định số 100/2019/NĐ-CP" - another document named by number. */
  | "numbered_document";

export interface LegalReference {
  readonly kind: LegalReferenceKind;
  /** The exact span in the source text, so a renderer can wrap precisely that. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly article: number | null;
  readonly clause: number | null;
  readonly point: string | null;
  readonly chapter: string | null;
  /** Title after the document-type word, e.g. "An ninh mạng" for "Luật An ninh mạng". */
  readonly documentTitle: string | null;
  readonly documentType: string | null;
  readonly documentNumber: string | null;
}

const documentTypes = "Luật|Bộ luật|Nghị định|Nghị quyết|Thông tư|Quyết định|Pháp lệnh";

// A title runs until punctuation, a conjunction, or a lowercase continuation
// that clearly leaves the title ("Luật An ninh mạng và pháp luật có liên quan"
// stops at "và"). Titles are Title Case in Vietnamese drafting, so the first
// word after the type is capitalised.
// \b is ASCII-only under the u flag, so "và" (ending in à) needs an explicit
// boundary: whitespace, punctuation or end of text.
const titlePattern = `[A-ZĐ][^,.;:()\\n]*?(?=\\s+(?:và|hoặc|hay|theo|tại|trong|của|về|được|đã|có|cho|từ|với|nếu|khi|này|đó)(?=\\s|[,.;:()]|$)|[,.;:()]|\\n|$)`;

const patterns: readonly { readonly kind: LegalReferenceKind; readonly regex: RegExp }[] = [
  // điểm a khoản 1 Điều 5 [của] Luật An ninh mạng
  {
    kind: "named_document",
    regex: new RegExp(
      `(?:điểm\\s+(?<point>[a-zđ])\\s+)?(?:khoản\\s+(?<clause>\\d+)\\s+)?Điều\\s+(?<article>\\d+)\\s+(?:của\\s+)?(?<type>${documentTypes})\\s+(?<title>${titlePattern})`,
      "gu",
    ),
  },
  // Nghị định số 100/2019/NĐ-CP (optionally preceded by điểm/khoản/Điều)
  {
    kind: "numbered_document",
    regex: new RegExp(
      `(?:điểm\\s+(?<point>[a-zđ])\\s+)?(?:khoản\\s+(?<clause>\\d+)\\s+)?(?:Điều\\s+(?<article>\\d+)\\s+)?(?:của\\s+)?(?<type>${documentTypes})\\s+số\\s+(?<number>\\d+[/\\w.-]*[A-ZĐ][\\w-]*)`,
      "gu",
    ),
  },
  // điểm a khoản 1 Điều 7 của Nghị định này / Luật này
  {
    kind: "same_document",
    regex: new RegExp(
      `(?:điểm\\s+(?<point>[a-zđ])\\s+)?(?:khoản\\s+(?<clause>\\d+)\\s+)?Điều\\s+(?<article>\\d+)\\s+của\\s+(?<type>${documentTypes})\\s+này`,
      "gu",
    ),
  },
  // Chương IV của Nghị định này
  {
    kind: "same_document",
    regex: new RegExp(
      `Chương\\s+(?<chapter>[IVXLCDM]+)\\s+của\\s+(?<type>${documentTypes})\\s+này`,
      "gu",
    ),
  },
  // khoản 2 Điều này / điểm b khoản 1 Điều này
  {
    kind: "same_document",
    regex: /(?:điểm\s+(?<point>[a-zđ])\s+)?khoản\s+(?<clause>\d+)\s+Điều\s+này/gu,
  },
];

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Finds every recognised cross-reference in a piece of legal text. Longer,
 * more specific matches win over shorter ones covering the same span, so
 * "khoản 1 Điều 5 Luật An ninh mạng" is one reference, not three. Wrapped
 * references (a line break inside "Chương IV của\nNghị định này") are found
 * because whitespace in the patterns matches newlines.
 */
export function extractLegalReferences(text: string): readonly LegalReference[] {
  const found: LegalReference[] = [];
  for (const { kind, regex } of patterns) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const groups = match.groups ?? {};
      const start = match.index;
      const end = start + match[0].length;
      const candidate: LegalReference = {
        article: groups["article"] === undefined ? null : Number(groups["article"]),
        chapter: groups["chapter"] ?? null,
        clause: groups["clause"] === undefined ? null : Number(groups["clause"]),
        documentNumber: groups["number"] ?? null,
        documentTitle: groups["title"]?.replaceAll(/\s+/gu, " ").trim() ?? null,
        documentType: groups["type"] ?? null,
        end,
        kind,
        point: groups["point"] ?? null,
        start,
        text: match[0],
      };
      // Keep the longer of two overlapping candidates.
      const clash = found.findIndex((existing) => overlaps(existing, candidate));
      if (clash === -1) {
        found.push(candidate);
      } else {
        const existing = found[clash];
        if (
          existing !== undefined &&
          candidate.end - candidate.start > existing.end - existing.start
        ) {
          found[clash] = candidate;
        }
      }
    }
  }
  return found.toSorted((left, right) => left.start - right.start);
}
