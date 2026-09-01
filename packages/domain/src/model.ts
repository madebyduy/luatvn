import type {
  AmendmentId,
  DatasetReleaseId,
  DocumentId,
  EvidenceId,
  ProvisionId,
  ProvisionVersionId,
} from "./ids.js";
import type { HalfOpenInterval, IsoInstant, LegalDate } from "./temporal.js";

export type ReviewStatus = "verified" | "under_review" | "unverified";
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
