import type {
  AmendmentRelation,
  DatasetReleaseId,
  ProvisionId,
  ProvisionVersionId,
  PublishedProvisionVersion,
  IsoInstant,
} from "@luatvn/domain";

export interface LegalReadOperation {
  readonly requestId: string;
  readonly deadlineAt: IsoInstant;
  readonly signal: AbortSignal;
}

export interface LegalReadRepository {
  listPublishedProvisionVersions(
    provisionId: ProvisionId,
    datasetReleaseId: DatasetReleaseId,
    operation: LegalReadOperation,
  ): Promise<readonly PublishedProvisionVersion[]>;

  getPublishedProvisionVersion(
    provisionVersionId: ProvisionVersionId,
    datasetReleaseId: DatasetReleaseId,
    operation: LegalReadOperation,
  ): Promise<PublishedProvisionVersion | null>;

  // Every published version in the release, so a client can offer a chooser
  // instead of asking a person to type an identifier. Bounded by the caller.
  listCatalogVersions(
    datasetReleaseId: DatasetReleaseId,
    operation: LegalReadOperation,
  ): Promise<readonly PublishedProvisionVersion[]>;

  listVerifiedAmendments(
    provisionId: ProvisionId,
    datasetReleaseId: DatasetReleaseId,
    maxDepth: 1 | 2,
    operation: LegalReadOperation,
  ): Promise<readonly AmendmentRelation[]>;
}
