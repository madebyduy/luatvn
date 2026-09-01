import type { DatasetReleaseId, ProvisionId, ProvisionVersionId } from "./ids.js";
import type { PublishedProvisionVersion, VerifiedPublishedProvisionVersion } from "./model.js";
import { assertValidInterval, contains, type IsoInstant, type LegalDate } from "./temporal.js";

export interface ResolveProvisionAtInput {
  readonly versions: readonly PublishedProvisionVersion[];
  readonly provisionId: ProvisionId;
  readonly validAt: LegalDate;
  readonly knownAt: IsoInstant;
  readonly datasetReleaseId: DatasetReleaseId;
}

export type ResolveProvisionAtResult =
  | {
      readonly status: "resolved";
      readonly version: VerifiedPublishedProvisionVersion;
    }
  | {
      readonly status: "unknown";
      readonly reason: "NO_MATCHING_VERSION" | "MATCH_ONLY_UNVERIFIED";
      readonly candidateVersionIds: readonly ProvisionVersionId[];
    }
  | {
      readonly status: "conflict";
      readonly reason: "MULTIPLE_VERIFIED_VERSIONS";
      readonly candidateVersionIds: readonly ProvisionVersionId[];
    };

export function resolveProvisionAt(input: ResolveProvisionAtInput): ResolveProvisionAtResult {
  const temporalMatches = input.versions.filter((version) => {
    assertValidInterval(version.validTime, "validTime");
    assertValidInterval(version.systemTime, "systemTime");
    return (
      version.provisionId === input.provisionId &&
      version.datasetReleaseId === input.datasetReleaseId &&
      contains(version.validTime, input.validAt) &&
      contains(version.systemTime, input.knownAt)
    );
  });

  const verifiedMatches = temporalMatches.filter(
    (version): version is VerifiedPublishedProvisionVersion =>
      version.reviewStatus === "verified" && version.evidence.length > 0,
  );

  if (verifiedMatches.length === 1) {
    const version = verifiedMatches[0];
    if (version === undefined) {
      throw new Error("Resolver invariant failed after a single-match check");
    }
    return { status: "resolved", version };
  }

  if (verifiedMatches.length > 1) {
    return {
      status: "conflict",
      reason: "MULTIPLE_VERIFIED_VERSIONS",
      candidateVersionIds: verifiedMatches.map((version) => version.provisionVersionId),
    };
  }

  if (temporalMatches.length > 0) {
    return {
      status: "unknown",
      reason: "MATCH_ONLY_UNVERIFIED",
      candidateVersionIds: temporalMatches.map((version) => version.provisionVersionId),
    };
  }

  return {
    status: "unknown",
    reason: "NO_MATCHING_VERSION",
    candidateVersionIds: [],
  };
}
