import { createHash } from "node:crypto";

import type { PublishedProvisionVersion } from "@luatvn/domain";

import type { ManualDatasetFile } from "./dataset-schema.js";

export interface ReleaseValidationIssue {
  readonly locator: string;
  readonly message: string;
}

// Registered official hosts per docs/06-source-register.md SR-003 (owner decision 2026-08-31).
// Ministry portals are matched through the gov.vn suffix; congbao.chinhphu.vn matches chinhphu.vn.
export const registeredSourceHosts: readonly string[] = ["vbpl.vn", "chinhphu.vn", "gov.vn"];

export interface ValidateReleaseOptions {
  readonly now: string;
  readonly allowedHosts?: readonly string[];
}

export function sha256HexOfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256HexOfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hostIsRegistered(url: string, allowedHosts: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

interface IntervalLike {
  readonly from: string;
  readonly to: string | null;
}

function intervalsOverlap(first: IntervalLike, second: IntervalLike): boolean {
  return (
    (second.to === null || first.from < second.to) && (first.to === null || second.from < first.to)
  );
}

function versionsCollide(
  first: PublishedProvisionVersion,
  second: PublishedProvisionVersion,
): boolean {
  return (
    intervalsOverlap(first.validTime, second.validTime) &&
    intervalsOverlap(first.systemTime, second.systemTime)
  );
}

export function validateReleaseForPublish(
  dataset: ManualDatasetFile,
  options: ValidateReleaseOptions,
): readonly ReleaseValidationIssue[] {
  const allowedHosts = options.allowedHosts ?? registeredSourceHosts;
  const issues: ReleaseValidationIssue[] = [];
  const report = (locator: string, message: string): void => {
    issues.push({ locator, message });
  };

  const checkEvidence = (
    locator: string,
    evidence: PublishedProvisionVersion["evidence"],
  ): void => {
    evidence.forEach((reference, referenceIndex) => {
      const evidenceLocator = `${locator} evidence[${referenceIndex}] ${reference.evidenceId}`;
      if (!hostIsRegistered(reference.officialSourceUrl, allowedHosts)) {
        report(
          evidenceLocator,
          "officialSourceUrl host is not a registered source (docs/06-source-register.md)",
        );
      }
      if (reference.retrievedAt > options.now) {
        report(evidenceLocator, "retrievedAt must not be in the future");
      }
    });
  };

  const knownProvisionIds = new Set<string>(
    dataset.provisionVersions.map((version) => version.provisionId),
  );

  const versionsByProvision = new Map<string, PublishedProvisionVersion[]>();
  dataset.provisionVersions.forEach((version, index) => {
    const locator = `provisionVersions[${index}] ${version.provisionVersionId}`;
    if (version.reviewStatus !== "verified") {
      report(locator, "reviewStatus must be verified before publish");
    }
    if (sha256HexOfText(version.legalText) !== version.legalTextSha256) {
      report(locator, "legalTextSha256 does not match the legal text");
    }
    checkEvidence(locator, version.evidence);

    const grouped = versionsByProvision.get(version.provisionId);
    if (grouped === undefined) {
      versionsByProvision.set(version.provisionId, [version]);
    } else {
      for (const other of grouped) {
        if (versionsCollide(other, version)) {
          report(
            locator,
            `valid/system intervals overlap with ${other.provisionVersionId}; the resolver would report a conflict`,
          );
        }
      }
      grouped.push(version);
    }
  });

  dataset.amendments.forEach((amendment, index) => {
    const locator = `amendments[${index}] ${amendment.amendmentId}`;
    if (amendment.reviewStatus !== "verified") {
      report(locator, "reviewStatus must be verified before publish");
    }
    if (!knownProvisionIds.has(amendment.targetProvisionId)) {
      report(locator, "targetProvisionId is not present in this release");
    }
    checkEvidence(locator, amendment.evidence);
  });

  return issues;
}
