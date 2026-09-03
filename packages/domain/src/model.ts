import type {
  AmendmentId,
  DatasetReleaseId,
  DocumentId,
  EvidenceId,
  ProvisionId,
  ProvisionVersionId,
} from "./ids.js";
import type { HalfOpenInterval, IsoInstant, LegalDate } from "./temporal.js";

/**
 * How far a record has been checked, from strongest to weakest.
 *
 * - `verified`: a named human compared the record against its source.
 * - `machine_checked`: every automated cross-check passed (P-018) and no human
 *   has looked yet. Servable, but every surface must say so - a reader acts on
 *   this distinction, and it is the one thing separating this from a chatbot.
 * - `under_review`: a machine draft awaiting either of the above.
 * - `unverified`: recorded, and not checked at all.
 */
export type ReviewStatus = "verified" | "machine_checked" | "under_review" | "unverified";
export type ServableReviewStatus = "verified" | "machine_checked";
export type ValidityStatus = "effective" | "not_effective" | "unknown";

export interface EvidenceReference {
  readonly evidenceId: EvidenceId;
  readonly officialSourceUrl: string;
  readonly sourceSha256: string;
  readonly retrievedAt: IsoInstant;
  readonly locator: string | null;
}

export interface PublishedProvisionVersion {
  readonly documentId: DocumentId;
  readonly provisionId: ProvisionId;
  readonly provisionVersionId: ProvisionVersionId;
  readonly datasetReleaseId: DatasetReleaseId;
  readonly documentNumber: string;
  readonly heading: string | null;
  readonly legalText: string;
  readonly legalTextSha256: string;
  readonly validTime: HalfOpenInterval<LegalDate>;
  readonly systemTime: HalfOpenInterval<IsoInstant>;
  readonly reviewStatus: ReviewStatus;
  readonly primaryEvidenceId: EvidenceId;
  readonly evidence: readonly [EvidenceReference, ...EvidenceReference[]];
}

export interface VerifiedPublishedProvisionVersion extends PublishedProvisionVersion {
  readonly reviewStatus: "verified";
}

/** A version the resolver may answer with: human-verified or machine-checked. */
export interface ServablePublishedProvisionVersion extends PublishedProvisionVersion {
  readonly reviewStatus: ServableReviewStatus;
}

export function isServableReviewStatus(status: ReviewStatus): status is ServableReviewStatus {
  return status === "verified" || status === "machine_checked";
}

export interface LegalCitation {
  readonly provisionId: ProvisionId;
  readonly provisionVersionId: ProvisionVersionId;
  readonly documentNumber: string;
  readonly sourceUrl: string;
  readonly sourceSha256: string;
  readonly retrievedAt: IsoInstant;
  readonly validAt: LegalDate;
  readonly validityStatus: ValidityStatus;
  readonly checkedAt: IsoInstant;
  readonly datasetReleaseId: DatasetReleaseId;
  readonly reviewStatus: ReviewStatus;
  readonly locator: string | null;
}

export interface AmendmentRelation {
  readonly amendmentId: AmendmentId;
  readonly sourceProvisionId: ProvisionId;
  readonly targetProvisionId: ProvisionId;
  readonly effectiveFrom: LegalDate;
  readonly relationType: "amends" | "repeals" | "replaces" | "corrects";
  readonly reviewStatus: ReviewStatus;
  readonly evidence: readonly [EvidenceReference, ...EvidenceReference[]];
}
