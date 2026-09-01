import type { AmendmentRelation } from "@luatvn/domain";
import {
  decodeManualDatasetFile,
  type DecodeResult,
  type ManualDatasetFile,
} from "@luatvn/manual-dataset";

export class MergeDraftsError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MergeDraftsError";
  }
}

// Combines drafts of several documents into one staging release and attaches the
// linked amendment drafts. Duplicates are dropped by id and the result is put
// back through the dataset decoder, so a merge can never widen the schema.
export function mergeDrafts(
  drafts: readonly ManualDatasetFile[],
  amendments: readonly AmendmentRelation[],
): DecodeResult<ManualDatasetFile> {
  const [first] = drafts;
  if (first === undefined) {
    throw new MergeDraftsError("At least one draft is required");
  }
  const releaseId = first.datasetReleaseId;
  for (const draft of drafts) {
    if (draft.datasetReleaseId !== releaseId) {
      throw new MergeDraftsError(
        `Drafts belong to different releases (${releaseId} and ${draft.datasetReleaseId})`,
      );
    }
  }

  const provisionVersions = new Map<string, unknown>();
  for (const draft of drafts) {
    for (const version of draft.provisionVersions) {
      if (!provisionVersions.has(version.provisionVersionId)) {
        provisionVersions.set(version.provisionVersionId, version);
      }
    }
  }

  const mergedAmendments = new Map<string, unknown>();
  for (const draft of drafts) {
    for (const amendment of draft.amendments) {
      mergedAmendments.set(amendment.amendmentId, amendment);
    }
  }
  for (const amendment of amendments) {
    mergedAmendments.set(amendment.amendmentId, amendment);
  }

  return decodeManualDatasetFile({
    amendments: [...mergedAmendments.values()],
    datasetReleaseId: releaseId,
    provisionVersions: [...provisionVersions.values()],
    schemaVersion: 1,
  });
}
