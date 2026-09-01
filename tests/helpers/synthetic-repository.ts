import type { LegalReadOperation, LegalReadRepository } from "@luatvn/application";
import type {
  AmendmentRelation,
  DatasetReleaseId,
  ProvisionId,
  ProvisionVersionId,
  PublishedProvisionVersion,
} from "@luatvn/domain";

export class SyntheticLegalReadRepository implements LegalReadRepository {
  public constructor(
    private readonly versions: readonly PublishedProvisionVersion[],
    private readonly amendments: readonly AmendmentRelation[] = [],
  ) {}

  public async listPublishedProvisionVersions(
    provisionId: ProvisionId,
    datasetReleaseId: DatasetReleaseId,
    _operation: LegalReadOperation,
  ): Promise<readonly PublishedProvisionVersion[]> {
    return this.versions.filter(
      (version) =>
        version.provisionId === provisionId && version.datasetReleaseId === datasetReleaseId,
    );
  }

  public async getPublishedProvisionVersion(
    provisionVersionId: ProvisionVersionId,
    datasetReleaseId: DatasetReleaseId,
    _operation: LegalReadOperation,
  ): Promise<PublishedProvisionVersion | null> {
    return (
      this.versions.find(
        (version) =>
          version.provisionVersionId === provisionVersionId &&
          version.datasetReleaseId === datasetReleaseId,
      ) ?? null
    );
  }

  public async listVerifiedAmendments(
    provisionId: ProvisionId,
    datasetReleaseId: DatasetReleaseId,
    _maxDepth: 1 | 2,
    _operation: LegalReadOperation,
  ): Promise<readonly AmendmentRelation[]> {
    const hasRelease = this.versions.some(
      (version) => version.datasetReleaseId === datasetReleaseId,
    );
    if (!hasRelease) return [];

    return this.amendments.filter(
      (relation) =>
        relation.sourceProvisionId === provisionId || relation.targetProvisionId === provisionId,
    );
  }
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Synthetic repository operation aborted"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("Synthetic repository operation aborted")),
      { once: true },
    );
  });
}

export class AbortAwareSyntheticLegalReadRepository implements LegalReadRepository {
  public listPublishedProvisionVersions(
    _provisionId: ProvisionId,
    _datasetReleaseId: DatasetReleaseId,
    operation: LegalReadOperation,
  ): Promise<readonly PublishedProvisionVersion[]> {
    return rejectWhenAborted(operation.signal);
  }

  public getPublishedProvisionVersion(
    _provisionVersionId: ProvisionVersionId,
    _datasetReleaseId: DatasetReleaseId,
    operation: LegalReadOperation,
  ): Promise<PublishedProvisionVersion | null> {
    return rejectWhenAborted(operation.signal);
  }

  public listVerifiedAmendments(
    _provisionId: ProvisionId,
    _datasetReleaseId: DatasetReleaseId,
    _maxDepth: 1 | 2,
    operation: LegalReadOperation,
  ): Promise<readonly AmendmentRelation[]> {
    return rejectWhenAborted(operation.signal);
  }
}
