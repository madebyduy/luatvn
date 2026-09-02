import { sha256HexOfBytes, type LoadedRelease } from "@luatvn/manual-dataset";

import { extractVbplDraft, VbplExtractError } from "./extract-vbpl.js";

export type VerificationCode =
  | "EVIDENCE_NOT_ARCHIVED"
  | "ARCHIVE_NOT_PRESENT"
  | "SOURCE_NOT_DERIVABLE"
  | "TEXT_MISMATCH"
  | "PROVISION_NOT_IN_SOURCE"
  | "UNVOUCHED_RECORD"
  | "ORPHAN_ARCHIVE";

export interface VerificationIssue {
  readonly code: VerificationCode;
  readonly locator: string;
  readonly message: string;
}

export interface ReleaseVerificationReport {
  readonly issues: readonly VerificationIssue[];
  readonly derivedProvisions: number;
  readonly vouchedProvisions: number;
  readonly archivedSources: number;
  /**
   * Archives this release names that have no local copy. These are the records
   * that could not be checked - which is not the same as records that failed.
   * A caller that collapses the two turns "I have not looked" into "I looked
   * and it was fine".
   */
  readonly uncheckedProvisions: number;
}

const archivePrefix = "archive/";

// Re-derives the legal text of a release from the bytes archived inside that
// release and compares the hashes. Passing means: this text was produced by
// this extractor from that archived source, and a named human vouched for each
// record. It does not mean the source itself states the law correctly - that
// remains a question for the official source the evidence points at.
export function verifyReleaseChain(release: LoadedRelease): ReleaseVerificationReport {
  const issues: VerificationIssue[] = [];
  const archives = new Map<string, { readonly bytes: Uint8Array; readonly sha256: string }>();
  for (const [path, bytes] of release.files) {
    if (path.startsWith(archivePrefix)) {
      archives.set(path, { bytes, sha256: sha256HexOfBytes(bytes) });
    }
  }

  const archiveByHash = new Map<string, string>();
  for (const [path, archive] of archives) {
    if (!archiveByHash.has(archive.sha256)) {
      archiveByHash.set(archive.sha256, path);
    }
  }

  // An archive the manifest lists but the disk does not hold. Distinguished
  // from an archive that was never recorded: one means "not fetched here", the
  // other means "no evidence exists". Only the second is a defect in the
  // release.
  const missingByHash = new Map<string, string>();
  for (const path of release.missingArchives) {
    const digest = path.split(".")[0] ?? path;
    missingByHash.set(digest, path);
  }

  const provisionsByArchive = new Map<string, typeof release.dataset.provisionVersions>();
  const usedArchives = new Set<string>();
  let uncheckedProvisions = 0;

  for (const provision of release.dataset.provisionVersions) {
    const primary = provision.evidence.find(
      (entry) => entry.evidenceId === provision.primaryEvidenceId,
    );
    if (primary === undefined) {
      issues.push({
        code: "EVIDENCE_NOT_ARCHIVED",
        locator: provision.provisionVersionId,
        message:
          "Record names a primary evidence entry that its own evidence list does not contain",
      });
      continue;
    }
    const archivePath = archiveByHash.get(primary.sourceSha256);
    if (archivePath === undefined) {
      const absent = missingByHash.get(primary.sourceSha256);
      if (absent !== undefined) {
        uncheckedProvisions += 1;
        issues.push({
          code: "ARCHIVE_NOT_PRESENT",
          locator: provision.provisionVersionId,
          message: `Archived source ${absent} is recorded in the manifest but has no local copy, so this record was not checked - fetch the archive and verify again`,
        });
        continue;
      }
      issues.push({
        code: "EVIDENCE_NOT_ARCHIVED",
        locator: provision.provisionVersionId,
        message: `No archived source in this release hashes to ${primary.sourceSha256.slice(0, 16)}…, so the text cannot be re-derived`,
      });
      continue;
    }
    usedArchives.add(archivePath);
    const existing = provisionsByArchive.get(archivePath) ?? [];
    provisionsByArchive.set(archivePath, [...existing, provision]);
  }

  let derivedProvisions = 0;

  for (const [archivePath, provisions] of provisionsByArchive) {
    const archive = archives.get(archivePath);
    const first = provisions[0];
    if (archive === undefined || first === undefined) {
      continue;
    }
    const primary = first.evidence.find((entry) => entry.evidenceId === first.primaryEvidenceId);
    if (primary === undefined) {
      continue;
    }

    let derivedByProvisionId: ReadonlyMap<string, string>;
    try {
      const { draft } = extractVbplDraft(Buffer.from(archive.bytes).toString("utf8"), {
        datasetReleaseId: release.datasetReleaseId,
        evidence: {
          officialSourceUrl: primary.officialSourceUrl,
          retrievedAt: primary.retrievedAt,
          sourceSha256: primary.sourceSha256,
        },
      });
      derivedByProvisionId = new Map(
        draft.provisionVersions.map((version) => [version.provisionId, version.legalTextSha256]),
      );
    } catch (error) {
      issues.push({
        code: "SOURCE_NOT_DERIVABLE",
        locator: archivePath,
        message:
          error instanceof VbplExtractError
            ? `Archived source cannot be re-processed (${error.code}); the text in this release cannot be checked against it`
            : "Archived source cannot be re-processed; the text in this release cannot be checked against it",
      });
      continue;
    }

    for (const provision of provisions) {
      const derivedHash = derivedByProvisionId.get(provision.provisionId);
      if (derivedHash === undefined) {
        issues.push({
          code: "PROVISION_NOT_IN_SOURCE",
          locator: provision.provisionVersionId,
          message: "Re-processing the archived source does not produce this provision at all",
        });
        continue;
      }
      if (derivedHash !== provision.legalTextSha256) {
        issues.push({
          code: "TEXT_MISMATCH",
          locator: provision.provisionVersionId,
          message:
            "Text in this release differs from what the archived source re-derives to; the record was altered after extraction",
        });
        continue;
      }
      derivedProvisions += 1;
    }
  }

  const vouchedTargets = new Set(release.reviewLog.map((entry) => entry.target));
  let vouchedProvisions = 0;
  for (const provision of release.dataset.provisionVersions) {
    if (provision.reviewStatus !== "verified") {
      continue;
    }
    if (vouchedTargets.has(provision.provisionVersionId)) {
      vouchedProvisions += 1;
      continue;
    }
    issues.push({
      code: "UNVOUCHED_RECORD",
      locator: provision.provisionVersionId,
      message: "Record is marked verified but no reviewer entry in this release vouches for it",
    });
  }

  for (const archivePath of archives.keys()) {
    if (!usedArchives.has(archivePath)) {
      issues.push({
        code: "ORPHAN_ARCHIVE",
        locator: archivePath,
        message: "Archived source is not referenced by the evidence of a record in this release",
      });
    }
  }

  return {
    archivedSources: archives.size,
    uncheckedProvisions,
    derivedProvisions,
    issues,
    vouchedProvisions,
  };
}
