import type { PublishedProvisionVersion } from "@luatvn/domain";
import { sha256HexOfBytes, type LoadedRelease } from "@luatvn/manual-dataset";
import { extractPdfLines, PdfTextError } from "@luatvn/pdf-text";

import type { CongBaoDocumentReference } from "./congbao-client.js";
import { CongBaoExtractError, extractCongBaoDraft } from "./extract-congbao.js";
import { extractVbplDraft, VbplExtractError } from "./extract-vbpl.js";

export type VerificationCode =
  | "EVIDENCE_NOT_ARCHIVED"
  | "ARCHIVE_NOT_PRESENT"
  | "SOURCE_NOT_DERIVABLE"
  | "TEXT_MISMATCH"
  | "PROVISION_NOT_IN_SOURCE"
  | "UNVOUCHED_RECORD"
  | "WRONG_VOUCHER"
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
const pdfMagic = "%PDF";

function looksLikePdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 4)).toString("latin1") === pdfMagic;
}

/**
 * Re-derives the legal text of a release from the bytes archived for it and
 * compares the hashes. Passing means: this text was produced by this
 * extractor from that archived source, and something named vouched for each
 * record at the tier the record claims. It does not mean the source itself
 * states the law correctly - that remains a question for the official source
 * the evidence points at.
 *
 * Two source shapes are re-derivable, matching the two ingest paths: the flight
 * payload of a vbpl.vn detail page, and the signed PDF a gazette published.
 * A gazette PDF is re-derived using a reference rebuilt from the release's own
 * records - document number and effective date come from the record, source URL
 * and locator from its evidence - so a release remains checkable from itself,
 * with no second file and no network.
 */
export async function verifyReleaseChain(
  release: LoadedRelease,
): Promise<ReleaseVerificationReport> {
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

  const provisionsByArchive = new Map<string, PublishedProvisionVersion[]>();
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
      if (looksLikePdf(archive.bytes)) {
        // Everything the gazette extractor needs about the document, taken
        // from the release itself. issuedOn and title do not affect the text
        // it derives; they are filled from the record so the shape is complete.
        const reference: CongBaoDocumentReference = {
          documentNumber: first.documentNumber,
          effectiveFrom: first.validTime.from,
          issuedOn: first.validTime.from,
          locator: primary.locator ?? "",
          pdfUrl: primary.officialSourceUrl,
          title: first.heading ?? first.documentNumber,
        };
        // eslint-disable-next-line no-await-in-loop -- archives are re-derived one at a time so a failure names the archive that caused it
        const pdfText = await extractPdfLines(archive.bytes);
        const { draft } = extractCongBaoDraft(pdfText, {
          datasetReleaseId: release.datasetReleaseId,
          evidence: {
            locator: reference.locator,
            officialSourceUrl: primary.officialSourceUrl,
            retrievedAt: primary.retrievedAt,
            sourceSha256: primary.sourceSha256,
          },
          reference,
        });
        derivedByProvisionId = new Map(
          draft.provisionVersions.map((version) => [version.provisionId, version.legalTextSha256]),
        );
      } else {
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
      }
    } catch (error) {
      const detail =
        error instanceof VbplExtractError ||
        error instanceof CongBaoExtractError ||
        error instanceof PdfTextError
          ? ` (${error.code})`
          : "";
      issues.push({
        code: "SOURCE_NOT_DERIVABLE",
        locator: archivePath,
        message: `Archived source cannot be re-processed${detail}; the text in this release cannot be checked against it`,
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

  // Every servable record must be vouched for, and by the right kind of
  // voucher. A record claiming a person read it needs a human audit entry; a
  // machine_checked record needs a machine one. Without the second half, a
  // record could be marked verified while only the cross-check ever looked.
  const vouchersByTarget = new Map<string, Set<string>>();
  for (const entry of release.reviewLog) {
    const methods = vouchersByTarget.get(entry.target) ?? new Set<string>();
    methods.add(entry.method ?? "human");
    vouchersByTarget.set(entry.target, methods);
  }
  let vouchedProvisions = 0;
  for (const provision of release.dataset.provisionVersions) {
    if (provision.reviewStatus !== "verified" && provision.reviewStatus !== "machine_checked") {
      continue;
    }
    const methods = vouchersByTarget.get(provision.provisionVersionId);
    if (methods === undefined) {
      issues.push({
        code: "UNVOUCHED_RECORD",
        locator: provision.provisionVersionId,
        message: `Record is marked ${provision.reviewStatus} but no reviewer entry in this release vouches for it`,
      });
      continue;
    }
    const wanted = provision.reviewStatus === "verified" ? "human" : "machine";
    if (!methods.has(wanted)) {
      issues.push({
        code: "WRONG_VOUCHER",
        locator: provision.provisionVersionId,
        message: `Record is marked ${provision.reviewStatus} but its only reviewer entries are ${[...methods].join(", ")}; a ${wanted} entry is required`,
      });
      continue;
    }
    vouchedProvisions += 1;
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
    derivedProvisions,
    issues,
    uncheckedProvisions,
    vouchedProvisions,
  };
}
