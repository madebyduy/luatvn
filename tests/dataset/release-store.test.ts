import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDatasetReleaseId, type PublishedProvisionVersion } from "@luatvn/domain";
import {
  getPublishedPointer,
  loadPublishedRelease,
  publishRelease,
  ReleaseStoreError,
  rollbackPublishedRelease,
  sha256HexOfText,
} from "@luatvn/manual-dataset";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  syntheticAmendment,
  syntheticVersionOne,
  syntheticVersionTwo,
} from "../fixtures/synthetic-legal-data.js";

const storeOptions = { allowedHosts: ["example.invalid"] } as const;

let dataDirectory = "";

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "luatvn-store-"));
});

afterEach(async () => {
  await rm(dataDirectory, { force: true, recursive: true });
});

function datasetTextFor(
  releaseId: string,
  mutate: (version: PublishedProvisionVersion) => PublishedProvisionVersion = (version) => version,
): string {
  const versions = [syntheticVersionOne, syntheticVersionTwo].map((version) =>
    mutate({
      ...version,
      datasetReleaseId: parseDatasetReleaseId(releaseId),
      legalTextSha256: sha256HexOfText(version.legalText),
    }),
  );
  return JSON.stringify(
    {
      schemaVersion: 1,
      datasetReleaseId: releaseId,
      provisionVersions: versions,
      amendments: [syntheticAmendment],
    },
    null,
    2,
  );
}

async function publish(releaseId: string, text?: string): Promise<void> {
  await publishRelease(dataDirectory, text ?? datasetTextFor(releaseId), {
    reviewedBy: "synthetic reviewer",
    ...storeOptions,
  });
}

async function expectStoreError(
  work: Promise<unknown>,
  code: ReleaseStoreError["code"],
): Promise<ReleaseStoreError> {
  const outcome = await work.then(
    () => null,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(ReleaseStoreError);
  if (!(outcome instanceof ReleaseStoreError)) {
    throw new Error("Expected a ReleaseStoreError");
  }
  expect(outcome.code).toBe(code);
  return outcome;
}

describe("release store", () => {
  it("publishes a validated release and loads it back intact", async () => {
    await publish("rel_synthetic_store1");
    const release = await loadPublishedRelease(dataDirectory, storeOptions);
    expect(release.datasetReleaseId).toBe("rel_synthetic_store1");
    expect(release.dataset.provisionVersions).toHaveLength(2);
    expect(release.manifest.reviewedBy).toBe("synthetic reviewer");
    const pointer = await getPublishedPointer(dataDirectory);
    expect(pointer.currentReleaseId).toBe("rel_synthetic_store1");
  });

  it("refuses to publish the same immutable release twice", async () => {
    await publish("rel_synthetic_store1");
    await expectStoreError(
      publishRelease(dataDirectory, datasetTextFor("rel_synthetic_store1"), {
        reviewedBy: "synthetic reviewer",
        ...storeOptions,
      }),
      "RELEASE_ALREADY_EXISTS",
    );
  });

  it("refuses to publish a record that is not human-verified, with a record locator", async () => {
    const error = await expectStoreError(
      publishRelease(
        dataDirectory,
        datasetTextFor("rel_synthetic_store1", (version) =>
          version.provisionVersionId === syntheticVersionOne.provisionVersionId
            ? { ...version, reviewStatus: "under_review" }
            : version,
        ),
        { reviewedBy: "synthetic reviewer", ...storeOptions },
      ),
      "RELEASE_VALIDATION_FAILED",
    );
    expect(
      error.issues.some((issue) =>
        issue.locator.includes(String(syntheticVersionOne.provisionVersionId)),
      ),
    ).toBe(true);
  });

  it("accepts a staging file that starts with a Windows byte order mark", async () => {
    await publish(
      "rel_synthetic_store1",
      String.fromCharCode(0xfe_ff) + datasetTextFor("rel_synthetic_store1"),
    );
    const release = await loadPublishedRelease(dataDirectory, storeOptions);
    expect(release.datasetReleaseId).toBe("rel_synthetic_store1");
  });

  it("requires the reviewer name", async () => {
    await expectStoreError(
      publishRelease(dataDirectory, datasetTextFor("rel_synthetic_store1"), {
        reviewedBy: "  ",
        ...storeOptions,
      }),
      "REVIEWER_REQUIRED",
    );
  });

  it("fails closed when a published dataset file is mutated", async () => {
    await publish("rel_synthetic_store1");
    const datasetPath = join(dataDirectory, "releases", "rel_synthetic_store1", "dataset.json");
    await writeFile(datasetPath, `${await readFile(datasetPath, "utf8")} `, "utf8");
    await expectStoreError(
      loadPublishedRelease(dataDirectory, storeOptions),
      "RELEASE_FILE_HASH_MISMATCH",
    );
  });

  it("fails closed when the manifest review state is downgraded", async () => {
    await publish("rel_synthetic_store1");
    const manifestPath = join(dataDirectory, "releases", "rel_synthetic_store1", "manifest.json");
    const manifestText = await readFile(manifestPath, "utf8");
    await writeFile(
      manifestPath,
      manifestText.replace('"reviewState": "verified"', '"reviewState": "under_review"'),
      "utf8",
    );
    await expectStoreError(
      loadPublishedRelease(dataDirectory, storeOptions),
      "RELEASE_NOT_REVIEWED",
    );
  });

  it("reports a missing pointer instead of inventing a release", async () => {
    await expectStoreError(loadPublishedRelease(dataDirectory, storeOptions), "POINTER_MISSING");
  });

  it("rolls back to the previous immutable release", async () => {
    await publish("rel_synthetic_store1");
    await publish("rel_synthetic_store2");
    expect((await loadPublishedRelease(dataDirectory, storeOptions)).datasetReleaseId).toBe(
      "rel_synthetic_store2",
    );

    const rolledBack = await rollbackPublishedRelease(dataDirectory, storeOptions);
    expect(rolledBack.restoredReleaseId).toBe("rel_synthetic_store1");
    expect((await loadPublishedRelease(dataDirectory, storeOptions)).datasetReleaseId).toBe(
      "rel_synthetic_store1",
    );

    await expectStoreError(
      rollbackPublishedRelease(dataDirectory, storeOptions),
      "ROLLBACK_UNAVAILABLE",
    );
  });

  it("refuses to roll back onto a corrupted release and keeps the pointer", async () => {
    await publish("rel_synthetic_store1");
    await publish("rel_synthetic_store2");
    const previousDatasetPath = join(
      dataDirectory,
      "releases",
      "rel_synthetic_store1",
      "dataset.json",
    );
    await writeFile(previousDatasetPath, "{}", "utf8");

    await expectStoreError(
      rollbackPublishedRelease(dataDirectory, storeOptions),
      "RELEASE_FILE_HASH_MISMATCH",
    );
    const pointer = await getPublishedPointer(dataDirectory);
    expect(pointer.currentReleaseId).toBe("rel_synthetic_store2");
  });
});
