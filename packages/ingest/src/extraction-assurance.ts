import type { PublishedProvisionVersion } from "@luatvn/domain";

import { sourceProvisionParagraphs, type RawParagraph } from "./extract-vbpl.js";
import { articleNumberOf } from "./link-amendments.js";

export type AssuranceCode =
  | "UNKNOWN_PARAGRAPH_CLASS"
  | "UNCOVERED_SOURCE_PARAGRAPH"
  | "UNNUMBERED_ARTICLE"
  | "DUPLICATE_ARTICLE_NUMBER"
  | "ARTICLE_NUMBER_GAP";

export interface AssuranceIssue {
  readonly code: AssuranceCode;
  readonly locator: string;
  readonly message: string;
}

function normalize(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

// Every provision paragraph the source rendered must appear in the extraction.
// This is what catches a dropped article or a truncated provision: the source
// paragraph simply will not be found. It compares the extractor against the
// payload it was given, so it proves the extraction is complete - not that the
// payload itself states the law correctly.
export function checkExtractionCoverage(
  flightText: string,
  provisions: readonly PublishedProvisionVersion[],
): readonly AssuranceIssue[] {
  const headings = new Set(
    provisions
      .map((provision) => normalize(provision.heading ?? ""))
      .filter((text) => text.length > 0),
  );
  const contentLines = new Set<string>();
  for (const provision of provisions) {
    for (const line of provision.legalText.split("\n")) {
      const normalized = normalize(line);
      if (normalized.length > 0) {
        contentLines.add(normalized);
      }
    }
  }

  // A source paragraph containing <br> becomes several lines once extracted, so
  // an exact line lookup can miss it. The joined text is the fallback haystack;
  // it stays a fallback because the line lookup is the cheaper common path.
  const joinedText = provisions.map((provision) => normalize(provision.legalText)).join(" | ");
  const isCovered = (text: string): boolean => contentLines.has(text) || joinedText.includes(text);

  const issues: AssuranceIssue[] = [];
  const paragraphs: readonly RawParagraph[] = sourceProvisionParagraphs(flightText);
  const reportedClasses = new Set<string>();
  paragraphs.forEach((paragraph, index) => {
    const locator = `source ${paragraph.className}[${String(index)}] ${paragraph.sourceId ?? "no-id"}`;
    if (paragraph.role === "unknown" && !reportedClasses.has(paragraph.className)) {
      reportedClasses.add(paragraph.className);
      issues.push({
        code: "UNKNOWN_PARAGRAPH_CLASS",
        locator,
        message: `Source uses paragraph class "${paragraph.className}" that this extractor does not classify; a human must decide what it means`,
      });
    }
    const text = normalize(paragraph.text);
    if (text.length === 0 || paragraph.role === "structure") {
      return;
    }
    const covered = paragraph.role === "article" ? headings.has(text) : isCovered(text);
    if (!covered) {
      issues.push({
        code: "UNCOVERED_SOURCE_PARAGRAPH",
        locator,
        message: `Source text is not covered by the extracted provisions: "${text.slice(0, 80)}"`,
      });
    }
  });
  return issues;
}

// Article numbering is advisory: real documents do insert articles such as
// "Dieu 3a", which reads as a duplicate here. Gaps and duplicates are reported
// so a reviewer can judge them, never silently corrected.
export function checkArticleNumbering(
  provisions: readonly PublishedProvisionVersion[],
): readonly AssuranceIssue[] {
  const issues: AssuranceIssue[] = [];
  const numbers: number[] = [];

  for (const provision of provisions) {
    const number = articleNumberOf(provision.heading);
    if (number === null) {
      issues.push({
        code: "UNNUMBERED_ARTICLE",
        locator: provision.provisionVersionId,
        message: `Heading does not start with a numbered article: "${(provision.heading ?? "").slice(0, 60)}"`,
      });
      continue;
    }
    if (numbers.includes(number)) {
      issues.push({
        code: "DUPLICATE_ARTICLE_NUMBER",
        locator: provision.provisionVersionId,
        message: `Article number ${String(number)} appears more than once; check for an inserted article such as "Điều ${String(number)}a"`,
      });
    }
    numbers.push(number);
  }

  const sorted = numbers.toSorted((left, right) => left - right);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous === undefined || current === undefined) continue;
    if (current - previous > 1) {
      issues.push({
        code: "ARTICLE_NUMBER_GAP",
        locator: `between Điều ${String(previous)} and Điều ${String(current)}`,
        message: `Article numbers jump from ${String(previous)} to ${String(current)}; an article may have been dropped`,
      });
    }
  }
  return issues;
}

export function checkExtraction(
  flightText: string,
  provisions: readonly PublishedProvisionVersion[],
): readonly AssuranceIssue[] {
  return [...checkExtractionCoverage(flightText, provisions), ...checkArticleNumbering(provisions)];
}
