import type { ManualDatasetFile } from "@luatvn/manual-dataset";
import type { PdfTextDocument } from "@luatvn/pdf-text";

import type { CongBaoDocumentReference } from "./congbao-client.js";
import type { CongBaoDraftReport } from "./extract-congbao.js";

// Six independent cross-checks between the gazette page, the PDF body and the
// extractor's own output. They catch INCONSISTENCY, not falsehood: if the PDF
// itself carries a typo, two extractors agree on the typo. What they do is
// shrink the human's job from "read everything" to "read what disagrees".
//
// Each check reports on its own. Nothing here collapses six answers into one
// "pass": a check that could not run says NOT_AVAILABLE, which is a different
// thing from having run and agreed.

export type CrossCheckId =
  | "DOCUMENT_NUMBER"
  | "ISSUE_DATE"
  | "EFFECTIVE_DATE"
  | "NUMBERING"
  | "SECOND_EXTRACTOR"
  | "CHARACTER_BALANCE";

export type CrossCheckStatus = "pass" | "flag" | "not_available";

export interface CrossCheckResult {
  readonly check: CrossCheckId;
  readonly status: CrossCheckStatus;
  readonly detail: string;
}

export interface CrossCheckReport {
  readonly results: readonly CrossCheckResult[];
  /** True only when every check ran and none flagged. NOT_AVAILABLE is not a pass. */
  readonly allPassed: boolean;
  readonly flagged: readonly CrossCheckId[];
  readonly notAvailable: readonly CrossCheckId[];
  /** Provisions the numbering check flagged individually; the rest of the document may still pass. */
  readonly flaggedProvisionVersionIds: readonly string[];
}

export interface CrossCheckInput {
  readonly reference: CongBaoDocumentReference;
  readonly pdfText: PdfTextDocument;
  readonly draft: ManualDatasetFile;
  readonly report: CongBaoDraftReport;
  /**
   * Text of the same PDF from an independent extractor (pdftotext, or the
   * vbpl.vn HTML rendering of the same document). Absent means the check
   * cannot run, and says so.
   */
  readonly secondExtraction?: string | null;
}

function compact(text: string): string {
  return text.normalize("NFC").replaceAll(/\s+/gu, "").toUpperCase();
}

/**
 * Two spellings occur and both are ordinary drafting: "ngày 19 tháng 8 năm
 * 2026" in a signing line, "kể từ ngày 01/07/2026" in an effective-date
 * clause. Reading only the first reported the second as "no readable date",
 * which sent documents to a human reviewer over a date written plainly on the
 * page. Both forms require the word "ngày", so a pair of numbers elsewhere in
 * the sentence cannot be mistaken for a date.
 */
function isoFromVietnameseDate(text: string): string | null {
  const match =
    /ngày[ ]+([0-9]{1,2})[ ]+tháng[ ]+([0-9]{1,2})[ ]+năm[ ]+([0-9]{4})/iu.exec(text) ??
    /ngày[ ]+([0-9]{1,2})[/-]([0-9]{1,2})[/-]([0-9]{4})/iu.exec(text);
  if (match === null) {
    return null;
  }
  const [, day, month, year] = match;
  if (day === undefined || month === undefined || year === undefined) {
    return null;
  }
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function checkDocumentNumber(input: CrossCheckInput): CrossCheckResult {
  const wanted = compact(input.reference.documentNumber);
  const haystack = compact(input.report.preambleText.join(" "));
  if (haystack.includes(`SỐ:${wanted}`) || haystack.includes(wanted)) {
    return {
      check: "DOCUMENT_NUMBER",
      detail: `trang Công báo và PDF cùng ghi ${input.reference.documentNumber}`,
      status: "pass",
    };
  }
  return {
    check: "DOCUMENT_NUMBER",
    detail: `trang Công báo ghi ${input.reference.documentNumber} nhưng lời nói đầu của PDF không có số hiệu đó`,
    status: "flag",
  };
}

function checkIssueDate(input: CrossCheckInput): CrossCheckResult {
  // The signing line reads "Hà Nội, ngày 19 tháng 8 năm 2026" and sits in the
  // preamble; the first Vietnamese date there is the issue date.
  const found = input.report.preambleText
    .map((line) => isoFromVietnameseDate(line))
    .find((value) => value !== null);
  if (found === undefined || found === null) {
    return {
      check: "ISSUE_DATE",
      detail: "lời nói đầu của PDF không có dòng ngày ký dạng 'ngày … tháng … năm …'",
      status: "not_available",
    };
  }
  if (found === input.reference.issuedOn) {
    return { check: "ISSUE_DATE", detail: `trang và PDF cùng ghi ${found}`, status: "pass" };
  }
  return {
    check: "ISSUE_DATE",
    detail: `trang Công báo ghi ban hành ${input.reference.issuedOn}, PDF ghi ${found}`,
    status: "flag",
  };
}

function checkEffectiveDate(input: CrossCheckInput): CrossCheckResult {
  const sentences = input.draft.provisionVersions
    .map((version) => version.legalText)
    .join(String.fromCharCode(10))
    .split(String.fromCharCode(10));
  // Every line carrying the phrase, not the first one. "có hiệu lực" is
  // ordinary Vietnamese and appears in body text - "quyết định giải quyết đã
  // có hiệu lực pháp luật" - so taking the first match read a sentence about
  // something else, found no date in it, and reported the document as having
  // no readable effective date while the real clause sat further down.
  const candidates = sentences.filter((line) => /có hiệu lực/iu.test(line));
  if (candidates.length === 0) {
    return {
      check: "EFFECTIVE_DATE",
      detail: "văn bản không có câu 'có hiệu lực …' để đối soát",
      status: "not_available",
    };
  }
  const dated = candidates
    .map((line) => ({ date: isoFromVietnameseDate(line), line }))
    .filter((entry) => entry.date !== null);
  if (dated.length > 0) {
    const agreeing = dated.find((entry) => entry.date === input.reference.effectiveFrom);
    if (agreeing !== undefined) {
      return {
        check: "EFFECTIVE_DATE",
        detail: `trang và Điều hiệu lực cùng ghi ${input.reference.effectiveFrom}`,
        status: "pass",
      };
    }
    const found = [...new Set(dated.map((entry) => String(entry.date)))].join(", ");
    return {
      check: "EFFECTIVE_DATE",
      detail: `trang Công báo ghi hiệu lực ${input.reference.effectiveFrom}, văn bản ghi ${found}`,
      status: "flag",
    };
  }
  if (candidates.some((line) => /ngày ký/iu.test(line))) {
    if (input.reference.effectiveFrom === input.reference.issuedOn) {
      return {
        check: "EFFECTIVE_DATE",
        detail: `văn bản nói 'kể từ ngày ký'; trang ghi hiệu lực = ban hành = ${input.reference.issuedOn}`,
        status: "pass",
      };
    }
    return {
      check: "EFFECTIVE_DATE",
      detail: `văn bản nói 'kể từ ngày ký' (${input.reference.issuedOn}) nhưng trang ghi hiệu lực ${input.reference.effectiveFrom}`,
      status: "flag",
    };
  }
  return {
    check: "EFFECTIVE_DATE",
    detail: `${String(candidates.length)} câu có cụm 'có hiệu lực' nhưng không câu nào nêu ngày: "${String(candidates[0]).slice(0, 70)}"`,
    status: "not_available",
  };
}

// Vietnamese legal drafting letters its points a, b, c, d, đ, e, g, h, … -
// skipping f, j, w, z. Continuity is checked against this order, not ASCII.
const pointLetters = "abcdđeghiklmnopqrstuvxy";

function checkNumbering(input: CrossCheckInput): {
  readonly result: CrossCheckResult;
  readonly flaggedProvisionVersionIds: readonly string[];
} {
  const flaggedProvisionVersionIds: string[] = [];
  const problems: string[] = [];
  for (const version of input.draft.provisionVersions) {
    const lines = version.legalText.split("\n");
    let expectedClause = 1;
    let expectedPoint = 0;
    let broken = false;
    for (const line of lines) {
      // The space after the number is not guaranteed. 131/2026/TT-BCA prints
      // "2.Xử lý sự cố về an ninh mạng" with none, so a pattern requiring one
      // skipped clause 2 and reported the article as jumping from 1 to 3 - a
      // typography detail read as a defect in the law. The lookahead keeps
      // "2.1." out: that is a sub-heading inside an annex, not a clause.
      const clause = /^([0-9]+)[.](?![0-9])[ ]*/u.exec(line);
      if (clause !== null) {
        const number = Number(clause[1]);
        if (number !== expectedClause) {
          problems.push(
            `${version.provisionVersionId}: khoản ${String(expectedClause)} → ${String(number)}`,
          );
          broken = true;
        }
        expectedClause = number + 1;
        expectedPoint = 0;
        continue;
      }
      const point = /^([a-zđ])[)][ ]*/u.exec(line);
      if (point !== null) {
        const letter = point[1] ?? "";
        const index = pointLetters.indexOf(letter);
        if (index !== expectedPoint) {
          problems.push(
            `${version.provisionVersionId}: điểm ${pointLetters[expectedPoint] ?? "?"} → ${letter}`,
          );
          broken = true;
        }
        expectedPoint = index + 1;
      }
    }
    if (broken) {
      flaggedProvisionVersionIds.push(version.provisionVersionId);
    }
  }
  if (problems.length === 0) {
    return {
      flaggedProvisionVersionIds,
      result: {
        check: "NUMBERING",
        detail: `khoản và điểm liên tục trong cả ${String(input.draft.provisionVersions.length)} Điều`,
        status: "pass",
      },
    };
  }
  return {
    flaggedProvisionVersionIds,
    result: {
      check: "NUMBERING",
      detail: `đánh số đứt ở ${String(flaggedProvisionVersionIds.length)} Điều: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? "; …" : ""}`,
      status: "flag",
    },
  };
}

function wordBag(text: string): Map<string, number> {
  const bag = new Map<string, number>();
  for (const word of text
    .normalize("NFC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? []) {
    bag.set(word, (bag.get(word) ?? 0) + 1);
  }
  return bag;
}

// Dice coefficient over word multisets. Two honest extractions of the same PDF
// differ only in whitespace and the odd ligature; anything under the threshold
// means one of them dropped or invented text.
const secondExtractorThreshold = 0.97;

function checkSecondExtractor(input: CrossCheckInput): CrossCheckResult {
  if (input.secondExtraction === undefined || input.secondExtraction === null) {
    return {
      check: "SECOND_EXTRACTOR",
      detail: "không có bộ bóc độc lập thứ hai trên máy này; phép này chưa chạy",
      status: "not_available",
    };
  }
  const ours = wordBag(input.pdfText.lines.map((line) => line.text).join(" "));
  const theirs = wordBag(input.secondExtraction);
  let shared = 0;
  for (const [word, count] of ours) {
    shared += Math.min(count, theirs.get(word) ?? 0);
  }
  const total = [...ours.values()].reduce((sum, count) => sum + count, 0);
  const otherTotal = [...theirs.values()].reduce((sum, count) => sum + count, 0);
  const dice = total + otherTotal === 0 ? 1 : (2 * shared) / (total + otherTotal);
  const percent = `${(dice * 100).toFixed(2)}%`;
  if (dice >= secondExtractorThreshold) {
    return {
      check: "SECOND_EXTRACTOR",
      detail: `hai bộ bóc trùng ${percent} từ`,
      status: "pass",
    };
  }
  return {
    check: "SECOND_EXTRACTOR",
    detail: `hai bộ bóc chỉ trùng ${percent} từ (ngưỡng ${String(secondExtractorThreshold * 100)}%)`,
    status: "flag",
  };
}

function checkCharacterBalance(input: CrossCheckInput): CrossCheckResult {
  const sourceCharacters = input.pdfText.lines.reduce((sum, line) => sum + line.text.length, 0);
  const inArticles = input.draft.provisionVersions.reduce(
    (sum, version) => sum + version.legalText.replaceAll("\n", "").length,
    0,
  );
  const elsewhere =
    input.report.preambleText.reduce((sum, line) => sum + line.length, 0) +
    input.report.structureHeadings.reduce((sum, line) => sum + line.length, 0) +
    input.report.unassignedLines.reduce((sum, line) => sum + line.text.length, 0) +
    input.report.apparatusLines.reduce((sum, line) => sum + line.text.length, 0) +
    input.report.runningLines.reduce((sum, line) => sum + line.length, 0) +
    input.report.closingBlockLines.reduce((sum, line) => sum + line.length, 0) +
    input.report.annexLines.reduce((sum, line) => sum + line.text.length, 0);
  const accounted = inArticles + elsewhere;
  if (accounted === sourceCharacters) {
    return {
      check: "CHARACTER_BALANCE",
      detail: `${String(sourceCharacters)} ký tự nguồn, tất cả có tên bucket`,
      status: "pass",
    };
  }
  return {
    check: "CHARACTER_BALANCE",
    detail: `nguồn ${String(sourceCharacters)} ký tự, phân loại được ${String(accounted)}; lệch ${String(sourceCharacters - accounted)}`,
    status: "flag",
  };
}

export function crossCheckCongBao(input: CrossCheckInput): CrossCheckReport {
  const numbering = checkNumbering(input);
  const results: CrossCheckResult[] = [
    checkDocumentNumber(input),
    checkIssueDate(input),
    checkEffectiveDate(input),
    numbering.result,
    checkSecondExtractor(input),
    checkCharacterBalance(input),
  ];
  const flagged = results.filter((r) => r.status === "flag").map((r) => r.check);
  const notAvailable = results.filter((r) => r.status === "not_available").map((r) => r.check);
  return {
    allPassed: flagged.length === 0 && notAvailable.length === 0,
    flagged,
    flaggedProvisionVersionIds: numbering.flaggedProvisionVersionIds,
    notAvailable,
    results,
  };
}
