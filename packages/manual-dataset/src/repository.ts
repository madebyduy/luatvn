import type { LegalReadOperation, LegalReadRepository } from "@luatvn/application";
import type {
  AmendmentRelation,
  DatasetReleaseId,
  ProvisionId,
  ProvisionVersionId,
  PublishedProvisionVersion,
} from "@luatvn/domain";

import type { ManualDatasetFile } from "./dataset-schema.js";

export interface PublishedReleaseData {
  readonly datasetReleaseId: DatasetReleaseId;
  readonly dataset: ManualDatasetFile;
}

export class ManualDatasetRepository implements LegalReadRepository {
  private readonly datasetReleaseId: DatasetReleaseId;
  private readonly versionsByProvisionId: ReadonlyMap<
    ProvisionId,
    readonly PublishedProvisionVersion[]
  >;
  private readonly versionsByVersionId: ReadonlyMap<ProvisionVersionId, PublishedProvisionVersion>;
  private readonly amendmentsByProvisionId: ReadonlyMap<ProvisionId, readonly AmendmentRelation[]>;

  public constructor(release: PublishedReleaseData) {
    this.datasetReleaseId = release.datasetReleaseId;

    const versionsByProvisionId = new Map<ProvisionId, PublishedProvisionVersion[]>();
    const versionsByVersionId = new Map<ProvisionVersionId, PublishedProvisionVersion>();
    for (const version of release.dataset.provisionVersions) {
      const grouped = versionsByProvisionId.get(version.provisionId);
      if (grouped === undefined) {
        versionsByProvisionId.set(version.provisionId, [version]);
      } else {
        grouped.push(version);
      }
      versionsByVersionId.set(version.provisionVersionId, version);
    }

    const amendmentsByProvisionId = new Map<ProvisionId, AmendmentRelation[]>();
    const index = (provisionId: ProvisionId, relation: AmendmentRelation): void => {
      const grouped = amendmentsByProvisionId.get(provisionId);
      if (grouped === undefined) {
        amendmentsByProvisionId.set(provisionId, [relation]);
      } else {
        grouped.push(relation);
      }
    };
    for (const relation of release.dataset.amendments) {
      if (relation.reviewStatus !== "verified") {
        continue;
      }
      index(relation.targetProvisionId, relation);
      if (relation.sourceProvisionId !== relation.targetProvisionId) {
        index(relation.sourceProvisionId, relation);
      }
    }

    this.versionsByProvisionId = versionsByProvisionId;
    this.versionsByVersionId = versionsByVersionId;
    this.amendmentsByProvisionId = amendmentsByProvisionId;
  }

  private assertOperationActive(operation: LegalReadOperation): void {
    if (operation.signal.aborted) {
      throw new Error("Manual dataset read was aborted");
    }
  }

  public async listPublishedProvisionVersions(
    provisionId: ProvisionId,
    datasetReleaseId: DatasetReleaseId,
    operation: LegalReadOperation,
  ): Promise<readonly PublishedProvisionVersion[]> {
    this.assertOperationActive(operation);
    if (datasetReleaseId !== this.datasetReleaseId) {
      return [];
    }
    return this.versionsByProvisionId.get(provisionId) ?? [];
  }

  public async getPublishedProvisionVersion(
    provisionVersionId: ProvisionVersionId,
    datasetReleaseId: DatasetReleaseId,
    operation: LegalReadOperation,
  ): Promise<PublishedProvisionVersion | null> {
    this.assertOperationActive(operation);
    if (datasetReleaseId !== this.datasetReleaseId) {
      return null;
    }
    return this.versionsByVersionId.get(provisionVersionId) ?? null;
  }

  public async listVerifiedAmendments(
    provisionId: ProvisionId,
    datasetReleaseId: DatasetReleaseId,
    maxDepth: 1 | 2,
    operation: LegalReadOperation,
  ): Promise<readonly AmendmentRelation[]> {
    this.assertOperationActive(operation);
    if (datasetReleaseId !== this.datasetReleaseId) {
      return [];
    }

    const direct = this.amendmentsByProvisionId.get(provisionId) ?? [];
    if (maxDepth === 1) {
      return direct;
    }

    const collected = new Map<string, AmendmentRelation>();
    for (const relation of direct) {
      collected.set(relation.amendmentId, relation);
    }
    for (const relation of direct) {
      const chained = this.amendmentsByProvisionId.get(relation.sourceProvisionId) ?? [];
      for (const next of chained) {
        collected.set(next.amendmentId, next);
      }
    }
    return [...collected.values()];
  }
}
