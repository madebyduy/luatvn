import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDatasetReleaseId, type PublishedProvisionVersion } from "@luatvn/domain";
import {
  loadPublishedRelease,
  publishRelease,
  sha256HexOfBytes,
  sha256HexOfText,
} from "@luatvn/manual-dataset";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  syntheticAmendment,
  syntheticVersionOne,
  syntheticVersionTwo,
} from "../fixtures/synthetic-legal-data.js";

const storeOptions = { allowedHosts: ["example.invalid"] } as const;
const sourceBytes = new TextEncoder().encode("bytes nguồn diễn tập, không phải nội dung pháp luật");
const sourceDigest = sha256HexOfBytes(sourceBytes);

let dataDirectory = "";

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "luatvn-archive-"));
});

afterEach(async () => {
  await rm(dataDirectory, { force: true, recursive: true });
});

function datasetTextFor(releaseId: string): string {
  const versions: PublishedProvisionVersion[] = [syntheticVersionOne, syntheticVersionTwo].map(
    (version) =>
      Object.assign({}, version, {
        datasetReleaseId: parseDatasetReleaseId(releaseId),
        legalTextSha256: sha256HexOfText(version.legalText),
      }),
  );
  return JSON.stringify(
    {
      amendments: [syntheticAmendment],
      datasetReleaseId: releaseId,
      provisionVersions: versions,
      schemaVersion: 1,
    },
    null,
    2,
  );
}

async function publishWithSource(releaseId: string): Promise<void> {
  await publishRelease(dataDirectory, datasetTextFor(releaseId), {
    reviewedBy: "synthetic reviewer",
    sources: [{ bytes: sourceBytes, path: "nguon.txt" }],
    ...storeOptions,
  });
}

describe("archived sources are stored once and addressed by their digest", () => {
  it("writes the source under its own SHA-256, in a store no release owns", async () => {
    await publishWithSource("rel_archive_one");
    const stored = await readdir(join(dataDirectory, "archive"));
    expect(stored).toEqual([`${sourceDigest}.txt`]);
    // The release keeps only what it must: data, manifest, review trail.
    const inRelease = await readdir(join(dataDirectory, "releases", "rel_archive_one"));
    expect(inRelease.toSorted()).toEqual(["dataset.json", "manifest.json"]);
  });

  it("does not write a second copy when another release cites the same source", async () => {
    await publishWithSource("rel_archive_one");
    await publishWithSource("rel_archive_two");
    const stored = await readdir(join(dataDirectory, "archive"));
    expect(stored).toHaveLength(1);
    // Both releases still name it, so neither depends on the other existing.
    const second = await loadPublishedRelease(dataDirectory, {
      ...storeOptions,
      includeAttachments: true,
    });
    expect(second.manifest.archives[0]?.sha256).toBe(sourceDigest);
    expect(second.files.get(`archive/${sourceDigest}.txt`)).toBeDefined();
  });
});

describe("an absent archive is not the same as a corrupted one", () => {
  it("refuses to load by default when a named archive has no local copy", async () => {
    await publishWithSource("rel_archive_strict");
    await rm(join(dataDirectory, "archive", `${sourceDigest}.txt`));
    // Strict is the default: the guarantee that a release which loads is a
    // release whose evidence is intact stays on unless someone turns it off.
    await expect(loadPublishedRelease(dataDirectory, storeOptions)).rejects.toThrowError(
      expect.objectContaining({ code: "RELEASE_FILES_MISSING" }) as Error,
    );
  });

  it("serves queries without the archive when asked, and says what is absent", async () => {
    await publishWithSource("rel_archive_lenient");
    await rm(join(dataDirectory, "archive", `${sourceDigest}.txt`));
    const release = await loadPublishedRelease(dataDirectory, {
      ...storeOptions,
      archivePolicy: "optional",
    });
    expect(release.dataset.provisionVersions.length).toBeGreaterThan(0);
    expect(release.missingArchives).toEqual([`${sourceDigest}.txt`]);
  });

  it("still refuses an archive whose bytes were altered, under every policy", async () => {
    await publishWithSource("rel_archive_tampered");
    await writeFile(join(dataDirectory, "archive", `${sourceDigest}.txt`), "bytes đã bị sửa");
    // Absent means "not fetched here". Present and wrong means somebody changed
    // the evidence. Only the first is tolerable, and only when asked for.
    await Promise.all(
      (["required", "optional"] as const).map(async (archivePolicy) =>
        expect(
          loadPublishedRelease(dataDirectory, { ...storeOptions, archivePolicy }),
        ).rejects.toThrowError(
          expect.objectContaining({ code: "RELEASE_FILE_HASH_MISMATCH" }) as Error,
        ),
      ),
    );
  });

  it("reports no missing archives when everything is present", async () => {
    await publishWithSource("rel_archive_complete");
    const release = await loadPublishedRelease(dataDirectory, {
      ...storeOptions,
      archivePolicy: "optional",
    });
    expect(release.missingArchives).toEqual([]);
  });
});
