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
import { z } from "zod";

export type VbplExtractErrorCode =
  "METADATA_NOT_FOUND" | "EFFECTIVE_DATE_MISSING" | "NO_PROVISIONS" | "DRAFT_INVALID";

export class VbplExtractError extends Error {
  public constructor(
    public readonly code: VbplExtractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VbplExtractError";
  }
}

const vbplMetadataSchema = z.object({
  docNum: z.string().min(1).max(256),
  effFrom: z.string().nullable().optional(),
  effStatus: z
    .object({ name: z.string().max(256).optional() })
    .nullable()
    .optional(),
  effTo: z.string().nullable().optional(),
  id: z.string().min(1).max(128).optional(),
  issueDate: z.string().nullable().optional(),
  key: z.string().min(1).max(128).optional(),
  title: z.string().min(1).max(2_048),
});

type VbplMetadata = z.infer<typeof vbplMetadataSchema>;

function scanJsonObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

function findMetadata(flightText: string): VbplMetadata | null {
  const anchor = flightText.indexOf('"docNum"');
  if (anchor === -1) {
    return null;
  }
  let candidate = flightText.lastIndexOf("{", anchor);
  for (let attempts = 0; candidate !== -1 && attempts < 64; attempts += 1) {
    const objectText = scanJsonObject(flightText, candidate);
    if (objectText !== null && objectText.includes('"docNum"')) {
      try {
        const parsed = vbplMetadataSchema.safeParse(JSON.parse(objectText));
        if (parsed.success) {
          return parsed.data;
        }
      } catch {
        // Not valid JSON from this candidate; widen the window.
      }
    }
    candidate = flightText.lastIndexOf("{", candidate - 1);
  }
  return null;
}

function extractTextChunks(flightText: string): readonly string[] {
  const bytes = Buffer.from(flightText, "utf8");
  const marker = /(?:^|\n)\d+:T([0-9a-f]+),/gu;
  const chunks: string[] = [];
  let match = marker.exec(flightText);
  while (match !== null) {
    const chunkLength = Number.parseInt(match[1] ?? "0", 16);
    const startCharacter = match.index + match[0].length;
    const startByte = Buffer.byteLength(flightText.slice(0, startCharacter), "utf8");
    if (chunkLength > 0 && startByte + chunkLength <= bytes.byteLength) {
      chunks.push(bytes.subarray(startByte, startByte + chunkLength).toString("utf8"));
    }
    match = marker.exec(flightText);
  }
  return chunks;
}

function decodeEntities(text: string): string {
  return text
    .replaceAll(/&#x([0-9a-fA-F]+);/gu, (_all, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replaceAll(/&#(\d+);/gu, (_all, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replaceAll("&nbsp;", " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function htmlToText(html: string): string {
  const withBreaks = html.replaceAll(/<br\s*\/?>/gu, "\n");
  const stripped = withBreaks.replaceAll(/<[^>]+>/gu, "");
  return decodeEntities(stripped)
    .replaceAll(String.fromCharCode(0xa0), " ")
    .replaceAll(/[ \t]+\n/gu, "\n")
    .trim();
}

// vbpl.vn marks each paragraph with its structural role. Classes observed on
// 2026-09-01: prov-chapter and prov-section carry structure headings,
// prov-article starts an article, and prov-clause / prov-item / prov-content
// carry the text of khoan and diem. A class outside this list is treated as
// content so no legal text is lost, and reported so a human sees the novelty.
const contentClasses = new Set(["prov-content", "prov-clause", "prov-item"]);
const structureClasses = new Set(["prov-chapter", "prov-section"]);

export type ParagraphRole = "article" | "content" | "structure" | "unknown";

export interface RawParagraph {
  readonly role: ParagraphRole;
  readonly className: string;
  readonly sourceId: string | null;
  readonly text: string;
}

function roleOf(className: string): ParagraphRole {
  if (className === "prov-article") return "article";
  if (contentClasses.has(className)) return "content";
  if (structureClasses.has(className)) return "structure";
  return "unknown";
}

function extractParagraphs(bodyHtml: string): readonly RawParagraph[] {
  const paragraphPattern = /<p([^>]*class="([^"]*)"[^>]*)>([\s\S]*?)<\/p>/gu;
  const paragraphs: RawParagraph[] = [];
  let match = paragraphPattern.exec(bodyHtml);
  while (match !== null) {
    const classMatch = /\bprov-[a-z-]+/u.exec(match[2] ?? "");
    if (classMatch !== null) {
      const className = classMatch[0];
      const idMatch = /id="([^"]+)"/u.exec(match[1] ?? "");
      paragraphs.push({
        className,
        role: roleOf(className),
        sourceId: idMatch === null ? null : (idMatch[1] ?? null),
        text: htmlToText(match[3] ?? ""),
      });
    }
    match = paragraphPattern.exec(bodyHtml);
  }
  return paragraphs;
}

interface GroupedProvision {
  readonly sourceId: string | null;
  readonly heading: string;
  readonly contents: readonly string[];
}

function groupProvisions(paragraphs: readonly RawParagraph[]): readonly GroupedProvision[] {
  const grouped: { sourceId: string | null; heading: string; contents: string[] }[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.role === "article") {
      grouped.push({ contents: [], heading: paragraph.text, sourceId: paragraph.sourceId });
      continue;
    }
    if (paragraph.role === "structure") {
      continue;
    }
    const current = grouped.at(-1);
    if (current !== undefined && paragraph.text.length > 0) {
      current.contents.push(paragraph.text);
    }
  }
  return grouped;
}

function datePartOf(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length < 10) {
    return null;
  }
  return value.slice(0, 10);
}

// Returns the provision paragraphs exactly as the source rendered them, so an
// assurance pass can compare them against what the extractor produced.
export function sourceProvisionParagraphs(flightText: string): readonly RawParagraph[] {
  const chunks = extractTextChunks(flightText);
  const bodyHtml = chunks.find((chunk) => chunk.includes("prov-article")) ?? flightText;
  return extractParagraphs(bodyHtml);
}

export interface VbplDraftEvidence {
  readonly officialSourceUrl: string;
  readonly retrievedAt: string;
  readonly sourceSha256: string;
}

export interface VbplDraftOptions {
  readonly datasetReleaseId: string;
  readonly evidence: VbplDraftEvidence;
}

export interface VbplDraftReport {
  readonly documentNumber: string;
  readonly effectiveFrom: string | null;
  readonly effectiveStatus: string | null;
  readonly provisionCount: number;
  readonly skipped: readonly { readonly locator: string; readonly reason: string }[];
  readonly sourceDocumentId: string;
  readonly title: string;
}

export interface VbplDraftResult {
  readonly draft: ManualDatasetFile;
  readonly report: VbplDraftReport;
}

// Extracts a machine draft from the flight payload of a vbpl.vn detail page.
// Every record is capped at reviewStatus "under_review"; effective dates come
// only from the source metadata - the extractor never invents them.
export function extractVbplDraft(flightText: string, options: VbplDraftOptions): VbplDraftResult {
  const metadata = findMetadata(flightText);
  if (metadata === null) {
    throw new VbplExtractError(
      "METADATA_NOT_FOUND",
      "The payload carries no recognizable document metadata (docNum/title)",
    );
  }
  const sourceDocumentId = metadata.id ?? metadata.key ?? null;
  if (sourceDocumentId === null) {
    throw new VbplExtractError("METADATA_NOT_FOUND", "Document metadata carries no stable id");
  }

  const effectiveFrom = datePartOf(metadata.effFrom);
  if (effectiveFrom === null) {
    throw new VbplExtractError(
      "EFFECTIVE_DATE_MISSING",
      `Document ${metadata.docNum} has no effFrom in the source metadata; a human must supply the effective date`,
    );
  }
  const effectiveTo = datePartOf(metadata.effTo);

  const chunks = extractTextChunks(flightText);
  const bodyHtml = chunks.find((chunk) => chunk.includes("prov-article")) ?? flightText;
  const grouped = groupProvisions(extractParagraphs(bodyHtml));

  const skipped: { locator: string; reason: string }[] = [];
  const retrievedAt = parseIsoInstant(options.evidence.retrievedAt);
  const validFrom = parseLegalDate(effectiveFrom);
  const validTo = effectiveTo === null ? null : parseLegalDate(effectiveTo);
  const documentId = parseDocumentId(`doc_vbpl_${sourceDocumentId}`);
  const evidenceId = parseEvidenceId(`ev_vbpl_${sourceDocumentId}`);

  type DraftVersionWithoutRelease = Omit<PublishedProvisionVersion, "datasetReleaseId">;
  const provisionVersions: DraftVersionWithoutRelease[] = [];
  grouped.forEach((provision, index) => {
    const locator = `provision[${index}] ${provision.heading.slice(0, 60)}`;
    if (provision.sourceId === null) {
      skipped.push({ locator, reason: "prov-article has no stable id attribute" });
      return;
    }
    if (provision.heading.length === 0) {
      skipped.push({ locator, reason: "empty heading" });
      return;
    }
    const legalText =
      provision.contents.length > 0 ? provision.contents.join("\n") : provision.heading;
    const evidence: EvidenceReference = {
      evidenceId,
      locator: `prov-article ${provision.sourceId}`,
      officialSourceUrl: options.evidence.officialSourceUrl,
      retrievedAt,
      sourceSha256: options.evidence.sourceSha256,
    };
    provisionVersions.push({
      documentId,
      documentNumber: metadata.docNum,
      evidence: [evidence],
      heading: provision.heading,
      legalText,
      legalTextSha256: sha256HexOfText(legalText),
      primaryEvidenceId: evidenceId,
      provisionId: parseProvisionId(`prov_vbpl_${provision.sourceId}`),
      provisionVersionId: parseProvisionVersionId(
        `pv_vbpl_${provision.sourceId}_e${effectiveFrom.replaceAll("-", "")}`,
      ),
      reviewStatus: "under_review",
      systemTime: { from: retrievedAt, to: null },
      validTime: { from: validFrom, to: validTo },
    });
  });

  if (provisionVersions.length === 0) {
    throw new VbplExtractError(
      "NO_PROVISIONS",
      `Document ${metadata.docNum} yielded no extractable provisions (${String(skipped.length)} skipped)`,
    );
  }

  const draftInput = {
    amendments: [],
    datasetReleaseId: options.datasetReleaseId,
    provisionVersions: provisionVersions.map((version) =>
      Object.assign({}, version, { datasetReleaseId: options.datasetReleaseId }),
    ),
    schemaVersion: 1,
  };
  const decoded = decodeManualDatasetFile(draftInput);
  if (!decoded.ok) {
    const [first] = decoded.issues;
    throw new VbplExtractError(
      "DRAFT_INVALID",
      `Generated draft does not satisfy the dataset schema (${first.path}: ${first.message})`,
    );
  }

  return {
    draft: decoded.value,
    report: {
      documentNumber: metadata.docNum,
      effectiveFrom,
      effectiveStatus: metadata.effStatus?.name ?? null,
      provisionCount: decoded.value.provisionVersions.length,
      skipped,
      sourceDocumentId,
      title: metadata.title,
    },
  };
}
