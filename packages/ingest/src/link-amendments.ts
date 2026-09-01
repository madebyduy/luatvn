import {
  parseAmendmentId,
  parseEvidenceId,
  parseIsoInstant,
  type AmendmentRelation,
  type EvidenceReference,
  type LegalDate,
  type PublishedProvisionVersion,
  type ProvisionId,
} from "@luatvn/domain";

import type { VbplRelationType } from "./extract-relations.js";

export interface UnlinkedAmendment {
  readonly locator: string;
  readonly reason: string;
}

export interface LinkAmendmentsInput {
  readonly amendingProvisions: readonly PublishedProvisionVersion[];
  readonly targetProvisions: readonly PublishedProvisionVersion[];
  readonly relationType: VbplRelationType;
  readonly effectiveFrom: LegalDate;
  readonly evidence: readonly [EvidenceReference, ...EvidenceReference[]];
}

export interface LinkAmendmentsResult {
  readonly amendments: readonly AmendmentRelation[];
  readonly unlinked: readonly UnlinkedAmendment[];
}

const ownArticlePattern = /^\s*Điều\s+(\d+)\s*[.:]?/u;
const referencePattern = /Điều\s+(\d+)/gu;

// "Điều 1. Sửa đổi, bổ sung khoản 1 Điều 2" -> 2. The provision's own number is
// stripped first, and only a digit-bearing reference counts, so wording such as
// "Điều khoản thi hành" yields nothing instead of a false link.
export function referencedArticleNumber(heading: string): number | null {
  const body = heading.replace(ownArticlePattern, "");
  const matches = [...body.matchAll(referencePattern)];
  const last = matches.at(-1);
  if (last === undefined) return null;
  const value = Number(last[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function articleNumberOf(heading: string | null): number | null {
  if (heading === null) return null;
  const match = ownArticlePattern.exec(heading);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function uuidPartOf(provisionId: ProvisionId): string {
  const separator = provisionId.lastIndexOf("_");
  return separator === -1 ? provisionId : provisionId.slice(separator + 1);
}

// Turns document-level relations into provision-level amendment drafts by
// resolving the article each amending provision names. Every draft stays
// under_review and every unresolved provision is reported for the reviewer -
// nothing is linked on a guess.
export function linkAmendments(input: LinkAmendmentsInput): LinkAmendmentsResult {
  const targetByArticle = new Map<number, PublishedProvisionVersion>();
  for (const provision of input.targetProvisions) {
    const article = articleNumberOf(provision.heading);
    if (article !== null && !targetByArticle.has(article)) {
      targetByArticle.set(article, provision);
    }
  }

  const amendments: AmendmentRelation[] = [];
  const unlinked: UnlinkedAmendment[] = [];
  const seenIds = new Set<string>();

  for (const provision of input.amendingProvisions) {
    const heading = provision.heading ?? "";
    const locator = `${provision.provisionVersionId} (${heading.slice(0, 60)})`;
    const referenced = referencedArticleNumber(heading);
    if (referenced === null) {
      unlinked.push({ locator, reason: "heading names no target article" });
      continue;
    }
    const target = targetByArticle.get(referenced);
    if (target === undefined) {
      unlinked.push({
        locator,
        reason: `target document has no Điều ${String(referenced)}`,
      });
      continue;
    }
    const amendmentId = parseAmendmentId(
      `amd_vbpl_${uuidPartOf(provision.provisionId)}_${uuidPartOf(target.provisionId)}`,
    );
    if (seenIds.has(amendmentId)) {
      unlinked.push({ locator, reason: "duplicate source/target pair" });
      continue;
    }
    seenIds.add(amendmentId);
    amendments.push({
      amendmentId,
      effectiveFrom: input.effectiveFrom,
      evidence: input.evidence,
      relationType: input.relationType,
      reviewStatus: "under_review",
      sourceProvisionId: provision.provisionId,
      targetProvisionId: target.provisionId,
    });
  }

  return { amendments, unlinked };
}

export interface RelationEvidenceInput {
  readonly sourceDocumentId: string;
  readonly officialSourceUrl: string;
  readonly retrievedAt: string;
  readonly sourceSha256: string;
}

// Evidence for an amendment draft is the relation payload itself: the exact URL,
// hash and retrieval time of the response that stated the relation.
export function relationEvidenceFrom(
  input: RelationEvidenceInput,
): readonly [EvidenceReference, ...EvidenceReference[]] {
  return [
    {
      evidenceId: parseEvidenceId(`ev_vbplrel_${input.sourceDocumentId}`),
      locator: "luoc-do relations payload",
      officialSourceUrl: input.officialSourceUrl,
      retrievedAt: parseIsoInstant(input.retrievedAt),
      sourceSha256: input.sourceSha256,
    },
  ];
}
