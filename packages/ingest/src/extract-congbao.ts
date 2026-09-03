import {
  parseDocumentId,
  parseEvidenceId,
  parseIsoInstant,
  parseLegalDate,
  parseProvisionId,
  parseProvisionVersionId,
  type EvidenceReference,
  type PublishedProvisionVersion,
} from "@luatvn/domain";
import {
  decodeManualDatasetFile,
  sha256HexOfText,
  type ManualDatasetFile,
} from "@luatvn/manual-dataset";
import type { PdfTextDocument, TextLine } from "@luatvn/pdf-text";

import type { CongBaoDocumentReference } from "./congbao-client.js";

export type CongBaoExtractErrorCode =
  "NO_PROVISIONS" | "ARTICLE_NUMBERS_BROKEN" | "TEXT_UNACCOUNTED" | "DRAFT_INVALID";

export class CongBaoExtractError extends Error {
  public readonly code: CongBaoExtractErrorCode;

  public constructor(code: CongBaoExtractErrorCode, message: string) {
    super(message);
    this.name = "CongBaoExtractError";
    this.code = code;
  }
}

const articlePattern = /^Điều\s+(\d+)\s*[.:]/u;

/**
 * A structural heading stands alone: "Chương IV", optionally followed by a
 * title set in capitals. Matching the prefix alone is not enough - body text
 * says things like "Chương IV của Nghị định này.", and treating that as a
 * heading closes the article it appears in and drops the rest of its text on
 * the floor. Requiring no lowercase letter after the numeral separates the two,
 * and errs towards keeping text inside its article rather than losing it.
 */
const chapterPattern = /^Chương\s+[IVXLCDM]+(?:\s+[^\p{Ll}]+)?$/u;
const sectionPattern = /^Mục\s+\d+(?:\s+[^\p{Ll}]+)?$/u;

/**
 * A circular often carries a second instrument behind it - a national technical
 * regulation, a schedule of forms, an annex - which is published in the same
 * PDF and begins the way every Vietnamese instrument begins: with the national
 * heading, or with the word "PHỤ LỤC" standing alone. That attached instrument
 * has its own numbering, so it lands inside the final article and takes the
 * article's text with it: Điều 4 of 127/2026/TT-BCA held 550 lines, of which
 * 8 were the article and 542 were QCVN 13:2026/BCA.
 *
 * Each marker must stand as the whole line. Body text refers to annexes all the
 * time - "theo Phụ lục I ban hành kèm theo Thông tư này" - and that reference is
 * legal text that must stay in its article; only a line that is nothing but the
 * heading opens an annex.
 */
const annexStartPatterns = [
  /^CỘNG\s+HÒA\s+XÃ\s+HỘI\s+CHỦ\s+NGHĨA\s+VIỆT\s+NAM$/u,
  /^PHỤ\s+LỤC(?:\s+[IVXLCDM\d]+[A-Za-zĐ]?)?\s*$/iu,
  // A form schedule opens by naming itself and the document that issued it:
  // "Mẫu CC01 ban hành kèm theo Thông tư số 118/2026/TT-BCA".
  /^Mẫu\s+\S+\s+(?:ban\s+hành\s+)?kèm\s+theo\s+/iu,
];

/**
 * A consolidated document ("văn bản hợp nhất") prints an editorial apparatus in
 * a smaller face: footnotes that quote other documents and read exactly like
 * headings - "Điều 7. Điều khoản thi hành" at 14.1pt against 19.9pt body text.
 * Treating them as body inserts articles that are not in this document, so they
 * are separated by size and reported rather than silently dropped.
 */
const apparatusSizeRatio = 0.8;

export interface CongBaoDraftEvidence {
  readonly officialSourceUrl: string;
  readonly retrievedAt: string;
  readonly sourceSha256: string;
  readonly locator: string;
}

export interface CongBaoDraftOptions {
  readonly datasetReleaseId: string;
  readonly reference: CongBaoDocumentReference;
  readonly evidence: CongBaoDraftEvidence;
}

export interface CongBaoDraftReport {
  readonly documentNumber: string;
  readonly title: string;
  readonly effectiveFrom: string;
  readonly bodyFontSize: number;
  readonly provisionCount: number;
  readonly articleNumbers: readonly number[];
  /** Lines held back as running headers or footers, with what they said. */
  readonly runningLines: readonly string[];
  /** Lines held back as editorial apparatus, by page. */
  readonly apparatusLines: readonly { readonly page: number; readonly text: string }[];
  /** Body lines before the first article: preamble and enacting citations. */
  readonly preambleLines: number;
  /** The same lines verbatim; the cross-check reads the document number and dates from here. */
  readonly preambleText: readonly string[];
  /**
   * Body lines after the first article that landed in no article - chapter
   * titles and the signature block, legitimately, but also anything the
   * segmentation failed to place. Reported verbatim rather than counted, so a
   * reviewer can see exactly what was not captured instead of trusting that
   * nothing was.
   */
  readonly unassignedLines: readonly { readonly page: number; readonly text: string }[];
  readonly structureHeadings: readonly string[];
  /**
   * The signature block that closes the document: who signed, on whose
   * behalf. Held out of the last article's text, and listed so a reviewer can
   * see it was recognised rather than lost.
   */
  readonly closingBlockLines: readonly string[];
  /**
   * The attached instrument that followed the last article, held out of it.
   * Listed verbatim rather than counted, because cutting text is the one
   * operation that can lose law silently: a reviewer must be able to read what
   * was removed and say whether it was really an annex.
   */
  readonly annexLines: readonly { readonly page: number; readonly text: string }[];
  /**
   * Set when an annex marker was found but the cut was refused because articles
   * continued past it. Names what was seen, so the refusal is not invisible.
   */
  readonly annexCutRefused: string | null;
}

export interface CongBaoDraftResult {
  readonly draft: ManualDatasetFile;
  readonly report: CongBaoDraftReport;
}

function normaliseKey(text: string): string {
  return text.replaceAll(/\d+/gu, "#");
}

/**
 * A running header repeats near-identically at the same edge of most pages.
 * Detected from the document rather than matched against "CÔNG BÁO", so the
 * rule keeps working if the gazette changes its wording or another source is
 * added later.
 */
function findRunningLines(lines: readonly TextLine[], pageCount: number): ReadonlySet<string> {
  const byPage = new Map<number, TextLine[]>();
  for (const line of lines) {
    const page = byPage.get(line.page);
    if (page === undefined) {
      byPage.set(line.page, [line]);
    } else {
      page.push(line);
    }
  }
  const counts = new Map<string, number>();
  for (const page of byPage.values()) {
    const edges = [page.at(0), page.at(-1)];
    for (const line of edges) {
      if (line === undefined) {
        continue;
      }
      const key = normaliseKey(line.text);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.floor(pageCount * 0.6));
  return new Set(
    [...counts.entries()].filter(([, count]) => count >= threshold).map(([key]) => key),
  );
}

function slugOfDocumentNumber(documentNumber: string): string {
  const slug = documentNumber
    .normalize("NFC")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "")
    .slice(0, 40);
  return slug === "" ? "vanban" : slug;
}

// Extracts a machine draft from the signed PDF a gazette published. Every
// record is capped at reviewStatus "under_review"; dates come from the gazette
// page, never from guesswork over the body text.
export function extractCongBaoDraft(
  pdfText: PdfTextDocument,
  options: CongBaoDraftOptions,
): CongBaoDraftResult {
  const bodyFontSize = pdfText.fontSizeHistogram[0]?.fontSize ?? 0;
  const apparatusFloor = bodyFontSize * apparatusSizeRatio;
  const running = findRunningLines(pdfText.lines, pdfText.pageCount);

  const runningLines: string[] = [];
  const apparatusLines: { page: number; text: string }[] = [];
  const body: TextLine[] = [];
  for (const line of pdfText.lines) {
    if (running.has(normaliseKey(line.text))) {
      runningLines.push(line.text);
      continue;
    }
    if (line.fontSize < apparatusFloor) {
      apparatusLines.push({ page: line.page, text: line.text });
      continue;
    }
    body.push(line);
  }

  // Cut the attached instrument off the body before segmentation, so it never
  // reaches an article's text or its hash. The cut is refused when the removed
  // tail still contains the article that should follow the last one kept: that
  // means the marker was something else - a form quoted inside a provision, a
  // page header the running-line pass did not catch - and cutting there would
  // drop real articles where the numbering check could not see it happen.
  let annexLines: { page: number; text: string }[] = [];
  let annexCutRefused: string | null = null;
  let lastArticleBeforeMarker: number | null = null;
  let markerIndex = -1;
  for (const [index, line] of body.entries()) {
    const article = articlePattern.exec(line.text);
    if (article !== null) {
      lastArticleBeforeMarker = Number(article[1]);
      continue;
    }
    if (lastArticleBeforeMarker !== null && annexStartPatterns.some((p) => p.test(line.text))) {
      markerIndex = index;
      break;
    }
  }
  if (markerIndex >= 0 && lastArticleBeforeMarker !== null) {
    const tail = body.slice(markerIndex);
    const expected = lastArticleBeforeMarker + 1;
    const continuation = tail.find(
      (line) => Number(articlePattern.exec(line.text)?.[1]) === expected,
    );
    if (continuation === undefined) {
      annexLines = tail.map((line) => ({ page: line.page, text: line.text }));
      body.length = markerIndex;
    } else {
      annexCutRefused = `thấy mốc phụ lục "${body[markerIndex]?.text ?? ""}" nhưng sau đó vẫn còn "${continuation.text}", nên không cắt`;
    }
  }

  const { evidence, reference } = options;
  const retrievedAt = parseIsoInstant(evidence.retrievedAt);
  const validFrom = parseLegalDate(reference.effectiveFrom);
  const evidenceId = parseEvidenceId(`ev_cb_${evidence.sourceSha256.slice(0, 32)}`);
  const evidenceReference: EvidenceReference = {
    evidenceId,
    locator: evidence.locator,
    officialSourceUrl: evidence.officialSourceUrl,
    retrievedAt,
    sourceSha256: evidence.sourceSha256,
  };
  const slug = slugOfDocumentNumber(reference.documentNumber);
  const documentId = parseDocumentId(`doc_cb_${slug}`);

  interface Collected {
    readonly number: number;
    readonly lines: TextLine[];
  }
  const collected: Collected[] = [];
  const structureHeadings: string[] = [];
  const unassignedLines: { page: number; text: string }[] = [];
  const preambleText: string[] = [];
  let preambleLines = 0;
  let current: Collected | null = null;
  for (const line of body) {
    const article = articlePattern.exec(line.text);
    if (article !== null) {
      const number = Number(article[1]);
      current = { lines: [line], number };
      collected.push(current);
      continue;
    }
    if (chapterPattern.test(line.text) || sectionPattern.test(line.text)) {
      // Structural headings belong to neither the article before nor the one
      // after, so they close the current article instead of joining its text.
      structureHeadings.push(line.text);
      current = null;
      continue;
    }
    if (current === null) {
      if (collected.length === 0) {
        preambleLines += 1;
        preambleText.push(line.text);
      } else {
        unassignedLines.push({ page: line.page, text: line.text });
      }
      continue;
    }
    current.lines.push(line);
  }

  if (collected.length === 0) {
    throw new CongBaoExtractError(
      "NO_PROVISIONS",
      `văn bản ${reference.documentNumber} không cho ra Điều nào (${String(body.length)} dòng thân bài, cỡ chữ ${String(bodyFontSize)})`,
    );
  }

  // Article numbers in a Vietnamese legal document run 1, 2, 3 with no gaps.
  // A gap means the extractor lost an article or invented one; either way the
  // draft must not be produced, because nobody would notice the missing text.
  const numbers = collected.map((entry) => entry.number);
  const breaks: string[] = [];
  if (numbers[0] !== 1) {
    breaks.push(`bắt đầu từ Điều ${String(numbers[0])} thay vì Điều 1`);
  }
  for (let index = 1; index < numbers.length; index += 1) {
    const previous = numbers[index - 1] ?? 0;
    const value = numbers[index] ?? 0;
    if (value !== previous + 1) {
      breaks.push(`Điều ${String(previous)} -> Điều ${String(value)}`);
    }
  }
  if (breaks.length > 0) {
    throw new CongBaoExtractError(
      "ARTICLE_NUMBERS_BROKEN",
      `số Điều không liên tục (${breaks.join("; ")}); bộ bóc tách có thể đã mất chữ hoặc nhận nhầm chú thích thành tiêu đề`,
    );
  }

  // A Vietnamese legal document closes with a signature block set to the right
  // of centre: "TM. CHÍNH PHỦ / KT. THỦ TƯỚNG / <name>". It follows the last
  // article, so it lands inside that article's text unless it is recognised.
  // That would put the signer's name inside the provision and inside its hash,
  // and a citation of the last article would quote it. Position decides this,
  // not wording: body text is flush or indented on the left, this block is not.
  const closingBlockLines: string[] = [];
  const lastArticle = collected.at(-1);
  if (lastArticle !== undefined) {
    const centre = pdfText.pageWidth / 2;
    while (lastArticle.lines.length > 1) {
      const tail = lastArticle.lines.at(-1);
      if (tail === undefined || tail.x <= centre) {
        break;
      }
      closingBlockLines.unshift(tail.text);
      lastArticle.lines.pop();
    }
  }

  const provisionVersions: Omit<PublishedProvisionVersion, "datasetReleaseId">[] = [];
  for (const entry of collected) {
    const legalText = entry.lines.map((entryLine) => entryLine.text).join("\n");
    const headingLine = entry.lines[0]?.text ?? "";
    if (legalText.trim() === "") {
      throw new CongBaoExtractError(
        "TEXT_UNACCOUNTED",
        `Điều ${String(entry.number)} của ${reference.documentNumber} không có nội dung`,
      );
    }
    provisionVersions.push({
      documentId,
      documentNumber: reference.documentNumber,
      evidence: [evidenceReference],
      heading: headingLine,
      legalText,
      legalTextSha256: sha256HexOfText(legalText),
      primaryEvidenceId: evidenceId,
      provisionId: parseProvisionId(`prov_cb_${slug}_d${String(entry.number)}`),
      provisionVersionId: parseProvisionVersionId(
        `pv_cb_${slug}_d${String(entry.number)}_e${reference.effectiveFrom.replaceAll("-", "")}`,
      ),
      reviewStatus: "under_review",
      systemTime: { from: retrievedAt, to: null },
      validTime: { from: validFrom, to: null },
    });
  }

  const decoded = decodeManualDatasetFile({
    amendments: [],
    datasetReleaseId: options.datasetReleaseId,
    provisionVersions: provisionVersions.map((version) =>
      Object.assign({}, version, { datasetReleaseId: options.datasetReleaseId }),
    ),
    schemaVersion: 1,
  });
  if (!decoded.ok) {
    const [first] = decoded.issues;
    throw new CongBaoExtractError(
      "DRAFT_INVALID",
      `draft không khớp schema dataset (${first?.path ?? "?"}: ${first?.message ?? "?"})`,
    );
  }

  return {
    draft: decoded.value,
    report: {
      annexCutRefused,
      annexLines,
      apparatusLines,
      articleNumbers: numbers,
      closingBlockLines,
      bodyFontSize,
      documentNumber: reference.documentNumber,
      effectiveFrom: reference.effectiveFrom,
      preambleLines,
      preambleText,
      provisionCount: provisionVersions.length,
      runningLines: [...new Set(runningLines)],
      structureHeadings,
      title: reference.title,
      unassignedLines,
    },
  };
}
