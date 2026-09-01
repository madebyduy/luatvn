import { parseIsoInstant, type IsoInstant } from "@luatvn/domain";

import { decodeManualDatasetFile, type ManualDatasetFile } from "./dataset-schema.js";
import { stripByteOrderMark } from "./release-store.js";

export type ReviewErrorCode =
  | "DATASET_PARSE_FAILED"
  | "DATASET_INVALID"
  | "TARGET_REQUIRED"
  | "RECORD_NOT_FOUND"
  | "ALREADY_VERIFIED"
  | "REVIEWER_REQUIRED";

export class ReviewError extends Error {
  public constructor(
    public readonly code: ReviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

export interface PromoteRecordInput {
  readonly datasetText: string;
  readonly provisionVersionId?: string;
  readonly amendmentId?: string;
  readonly reviewedBy: string;
  readonly now?: IsoInstant;
}

export interface ReviewAuditEntry {
  readonly reviewedAt: IsoInstant;
  readonly reviewedBy: string;
  readonly target: string;
}

export interface PromoteRecordResult {
  readonly audit: ReviewAuditEntry;
  readonly updatedDatasetText: string;
}

function decodeDatasetText(datasetText: string): ManualDatasetFile {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stripByteOrderMark(datasetText));
  } catch {
    throw new ReviewError("DATASET_PARSE_FAILED", "Staging dataset is not valid JSON");
  }
  const decoded = decodeManualDatasetFile(parsedJson);
  if (!decoded.ok) {
    const [first] = decoded.issues;
    throw new ReviewError(
      "DATASET_INVALID",
      `Staging dataset does not match the dataset schema (${first.path}: ${first.message})`,
    );
  }
  return decoded.value;
}

// Human review gate (ADR-0004): machine drafts stay under_review; this is the
// single code path that raises a record to verified, and it always records the
// reviewer's name and time.
export function promoteRecordToVerified(input: PromoteRecordInput): PromoteRecordResult {
  const reviewedBy = input.reviewedBy.trim();
  if (reviewedBy.length === 0) {
    throw new ReviewError("REVIEWER_REQUIRED", "Promotion requires the human reviewer's name");
  }
  const targetCount =
    (input.provisionVersionId === undefined ? 0 : 1) + (input.amendmentId === undefined ? 0 : 1);
  if (targetCount !== 1) {
    throw new ReviewError(
      "TARGET_REQUIRED",
      "Promotion targets exactly one provisionVersionId or one amendmentId",
    );
  }

  const dataset = decodeDatasetText(input.datasetText);
  const reviewedAt = input.now ?? parseIsoInstant(new Date().toISOString());

  let target: string;
  let updated: ManualDatasetFile;
  if (input.provisionVersionId !== undefined) {
    const record = dataset.provisionVersions.find(
      (version) => version.provisionVersionId === input.provisionVersionId,
    );
    if (record === undefined) {
      throw new ReviewError(
        "RECORD_NOT_FOUND",
        `No provision version ${input.provisionVersionId} exists in the staging dataset`,
      );
    }
    if (record.reviewStatus === "verified") {
      throw new ReviewError(
        "ALREADY_VERIFIED",
        `Provision version ${input.provisionVersionId} is already verified`,
      );
    }
    target = record.provisionVersionId;
    updated = {
      ...dataset,
      provisionVersions: dataset.provisionVersions.map((version) =>
        version.provisionVersionId === record.provisionVersionId
          ? Object.assign({}, version, { reviewStatus: "verified" as const })
          : version,
      ),
    };
  } else {
    const record = dataset.amendments.find(
      (amendment) => amendment.amendmentId === input.amendmentId,
    );
    if (record === undefined) {
      throw new ReviewError(
        "RECORD_NOT_FOUND",
        `No amendment ${input.amendmentId ?? ""} exists in the staging dataset`,
      );
    }
    if (record.reviewStatus === "verified") {
      throw new ReviewError(
        "ALREADY_VERIFIED",
        `Amendment ${record.amendmentId} is already verified`,
      );
    }
    target = record.amendmentId;
    updated = {
      ...dataset,
      amendments: dataset.amendments.map((amendment) =>
        amendment.amendmentId === record.amendmentId
          ? Object.assign({}, amendment, { reviewStatus: "verified" as const })
          : amendment,
      ),
    };
  }

  return {
    audit: { reviewedAt, reviewedBy, target },
    updatedDatasetText: `${JSON.stringify(updated, null, 2)}\n`,
  };
}
