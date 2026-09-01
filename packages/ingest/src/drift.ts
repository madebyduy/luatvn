import type { PublishedProvisionVersion } from "@luatvn/domain";

export type DriftCode =
  "PROVISION_CHANGED" | "PROVISION_MISSING_AT_SOURCE" | "PROVISION_ADDED_AT_SOURCE";

export interface DriftIssue {
  readonly code: DriftCode;
  readonly locator: string;
  readonly message: string;
}

// Compares provisions of a published release against a freshly extracted copy
// of the same document. It proves the source changed after publication - not
// that either side is legally correct. A published release is immutable, so a
// drift report is an instruction to review and publish a new release.
export function detectProvisionDrift(
  published: readonly PublishedProvisionVersion[],
  current: readonly PublishedProvisionVersion[],
): readonly DriftIssue[] {
  const currentByProvisionId = new Map(
    current.map((provision) => [provision.provisionId, provision]),
  );
  const publishedProvisionIds = new Set(published.map((provision) => provision.provisionId));
  const issues: DriftIssue[] = [];

  for (const provision of published) {
    const now = currentByProvisionId.get(provision.provisionId);
    if (now === undefined) {
      issues.push({
        code: "PROVISION_MISSING_AT_SOURCE",
        locator: provision.provisionVersionId,
        message: `${provision.heading ?? provision.provisionId} is no longer present at the source`,
      });
      continue;
    }
    if (now.legalTextSha256 !== provision.legalTextSha256) {
      issues.push({
        code: "PROVISION_CHANGED",
        locator: provision.provisionVersionId,
        message: `${provision.heading ?? provision.provisionId} differs from the published text`,
      });
    }
  }

  for (const provision of current) {
    if (!publishedProvisionIds.has(provision.provisionId)) {
      issues.push({
        code: "PROVISION_ADDED_AT_SOURCE",
        locator: provision.provisionId,
        message: `${provision.heading ?? provision.provisionId} exists at the source but not in the release`,
      });
    }
  }
  return issues;
}
