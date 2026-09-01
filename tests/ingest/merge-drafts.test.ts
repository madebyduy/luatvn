import { parseDatasetReleaseId } from "@luatvn/domain";
import { mergeDrafts, MergeDraftsError } from "@luatvn/ingest";
import { decodeManualDatasetFile, sha256HexOfText } from "@luatvn/manual-dataset";
import { describe, expect, it } from "vitest";

import { syntheticVersionOne, syntheticVersionTwo } from "../fixtures/synthetic-legal-data.js";

function draftWith(releaseId: string, versions: (typeof syntheticVersionOne)[]) {
  const decoded = decodeManualDatasetFile({
    amendments: [],
    datasetReleaseId: releaseId,
    provisionVersions: versions.map((version) =>
      Object.assign({}, version, {
        datasetReleaseId: parseDatasetReleaseId(releaseId),
        legalTextSha256: sha256HexOfText(version.legalText),
        reviewStatus: "under_review",
      }),
    ),
    schemaVersion: 1,
  });
  if (!decoded.ok) {
    throw new Error(`fixture draft invalid: ${decoded.issues[0].path}`);
  }
  return decoded.value;
}

describe("mergeDrafts", () => {
  it("combines drafts of the same release and drops duplicates", () => {
    const first = draftWith("rel_synthetic_merge1", [syntheticVersionOne]);
    const second = draftWith("rel_synthetic_merge1", [syntheticVersionOne, syntheticVersionTwo]);
    const merged = mergeDrafts([first, second], []);
    expect(merged.ok).toBe(true);
    if (!merged.ok) throw new Error("expected merge to succeed");
    expect(merged.value.provisionVersions).toHaveLength(2);
    expect(merged.value.datasetReleaseId).toBe("rel_synthetic_merge1");
  });

  it("refuses drafts that belong to different releases", () => {
    expect(() =>
      mergeDrafts(
        [
          draftWith("rel_synthetic_merge1", [syntheticVersionOne]),
          draftWith("rel_synthetic_merge2", [syntheticVersionTwo]),
        ],
        [],
      ),
    ).toThrowError(MergeDraftsError);
  });

  it("requires at least one draft", () => {
    expect(() => mergeDrafts([], [])).toThrowError(MergeDraftsError);
  });
});
