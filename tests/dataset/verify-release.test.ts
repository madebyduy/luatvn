import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractVbplDraft, mergeDrafts, verifyReleaseChain } from "@luatvn/ingest";
import {
  loadPublishedRelease,
  promoteRecordToVerified,
  publishRelease,
  ReleaseStoreError,
  sha256HexOfBytes,
  sha256HexOfText,
  type ReleaseAttachment,
} from "@luatvn/manual-dataset";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const releaseId = "rel_drill_verify";
const provisionUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const loadOptions = { allowedHosts: ["drill.invalid"], includeAttachments: true } as const;
const reviewer = "drill reviewer";

let dataDirectory = "";

function drillPayload(text: string): string {
  const metadata = {
    docNum: "VERIFY-DRILL-01",
    effFrom: "2020-01-01T00:00:00",
    effTo: null,
    id: "drill-doc",
    title: "Tài liệu diễn tập kiểm chứng",
  };
  const html = [
    "<html><body>",
    `<p class="prov-article" id="${provisionUuid}"><span><strong>Điều 1. Nội dung diễn tập</strong></span></p>`,
    `<p class="prov-clause" id="${provisionUuid}"><span>${text}</span></p>`,
    "</body></html>",
  ].join("\n");
  const chunkLength = Buffer.byteLength(html, "utf8").toString(16);
  return `0:["drill",null]\n1:${JSON.stringify(metadata)}\n2:T${chunkLength},${html}\n`;
}

interface DrillOptions {
  readonly attachSources?: boolean;
  readonly promoteAll?: boolean;
}

async function publishDrillRelease(options: DrillOptions = {}): Promise<void> {
  const flight = drillPayload("Nội dung diễn tập, không phải văn bản pháp luật.");
  const sourceSha256 = sha256HexOfText(flight);
  const { draft } = extractVbplDraft(flight, {
    datasetReleaseId: releaseId,
    evidence: {
      officialSourceUrl: "https://drill.invalid/van-ban/drill-doc",
      retrievedAt: "2026-08-31T00:00:00.000Z",
      sourceSha256,
    },
  });
  const merged = mergeDrafts([draft], []);
  if (!merged.ok) {
    throw new Error("drill draft did not satisfy the dataset schema");
  }

  let stagingText = `${JSON.stringify(merged.value, null, 2)}\n`;
  const reviewLog = [];
  for (const version of merged.value.provisionVersions) {
    const promoted = promoteRecordToVerified({
      datasetText: stagingText,
      provisionVersionId: version.provisionVersionId,
      reviewedBy: reviewer,
    });
    stagingText = promoted.updatedDatasetText;
    if (options.promoteAll !== false) {
      reviewLog.push(promoted.audit);
    }
  }

  const sources: ReleaseAttachment[] =
    options.attachSources === false
      ? []
      : [{ bytes: Buffer.from(flight, "utf8"), path: `${sourceSha256.slice(0, 12)}.rsc.txt` }];

  await publishRelease(dataDirectory, stagingText, {
    allowedHosts: ["drill.invalid"],
    reviewLog,
    reviewedBy: reviewer,
    sources,
  });
}

// A determined tamperer would also repair the manifest hash, so the tests do
// exactly that. Anything the manifest alone would catch is not the interesting
// case; what matters is whether the derivation check still notices.
async function rewriteReleaseFile(filePath: string, bytes: Uint8Array): Promise<void> {
  const releaseDirectory = join(dataDirectory, "releases", releaseId);
  await writeFile(join(releaseDirectory, filePath), bytes);
  const manifestPath = join(releaseDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    files: { path: string; sha256: string }[];
  };
  for (const file of manifest.files) {
    if (file.path === filePath) {
      file.sha256 = sha256HexOfBytes(bytes);
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function readDatasetText(): Promise<string> {
  return readFile(join(dataDirectory, "releases", releaseId, "dataset.json"), "utf8");
}

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "luatvn-verify-"));
});

afterEach(async () => {
  await rm(dataDirectory, { force: true, recursive: true });
});

describe("release verification chain", () => {
  it("passes on a release published through the normal pipeline", async () => {
    await publishDrillRelease();
    const release = await loadPublishedRelease(dataDirectory, loadOptions);
    const report = verifyReleaseChain(release);

    expect(report.issues).toEqual([]);
    expect(report.archivedSources).toBe(1);
    expect(report.derivedProvisions).toBe(release.dataset.provisionVersions.length);
    expect(report.vouchedProvisions).toBe(release.dataset.provisionVersions.length);
  });

  it("refuses to load when an archived source is altered without repairing the manifest", async () => {
    await publishDrillRelease();
    const archiveDirectory = join(dataDirectory, "archive");
    const [archiveName] = await readFile(
      join(dataDirectory, "releases", releaseId, "manifest.json"),
      "utf8",
    ).then((text) =>
      (JSON.parse(text) as { archives: { path: string }[] }).archives.map((entry) => entry.path),
    );
    if (archiveName === undefined) {
      throw new Error("drill release has no archived source");
    }
    await writeFile(join(archiveDirectory, archiveName), "đã bị sửa", "utf8");

    const outcome = await loadPublishedRelease(dataDirectory, loadOptions).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(ReleaseStoreError);
    if (outcome instanceof ReleaseStoreError) {
      expect(outcome.code).toBe("RELEASE_FILE_HASH_MISMATCH");
    }
  });

  it("catches an archived source swapped together with its manifest hash", async () => {
    await publishDrillRelease();
    const manifest = JSON.parse(
      await readFile(join(dataDirectory, "releases", releaseId, "manifest.json"), "utf8"),
    ) as { archives: { path: string; sha256: string }[] };
    const archive = manifest.archives[0];
    if (archive === undefined) {
      throw new Error("drill release has no archived source");
    }
    // Swap the bytes AND the digest that names them, the way a tamperer with
    // write access to both would: the file still matches its own hash, so only
    // re-deriving the text catches it.
    const swapped = Buffer.from(drillPayload("Nội dung đã bị thay."), "utf8");
    const swappedDigest = sha256HexOfText(drillPayload("Nội dung đã bị thay."));
    const extension = archive.path.slice(archive.path.indexOf("."));
    await rm(join(dataDirectory, "archive", archive.path));
    await writeFile(join(dataDirectory, "archive", `${swappedDigest}${extension}`), swapped);
    const manifestPath = join(dataDirectory, "releases", releaseId, "manifest.json");
    const full = JSON.parse(await readFile(manifestPath, "utf8")) as {
      files: { path: string; sha256: string }[];
      archives: { path: string; sha256: string }[];
    };
    full.archives = [{ path: `${swappedDigest}${extension}`, sha256: swappedDigest }];
    await rewriteReleaseFile(
      "manifest.json",
      Buffer.from(`${JSON.stringify(full, null, 2)}\n`, "utf8"),
    );

    const release = await loadPublishedRelease(dataDirectory, loadOptions);
    const report = verifyReleaseChain(release);
    expect(report.issues.map((issue) => issue.code)).toContain("EVIDENCE_NOT_ARCHIVED");
    expect(report.derivedProvisions).toBe(0);
  });

  it("catches legal text edited after extraction even when every hash is repaired", async () => {
    await publishDrillRelease();
    const dataset = JSON.parse(await readDatasetText()) as {
      provisionVersions: { legalText: string; legalTextSha256: string }[];
    };
    const target = dataset.provisionVersions[0];
    if (target === undefined) {
      throw new Error("drill release has no provisions");
    }
    target.legalText = "Nội dung đã bị sửa sau khi bóc tách.";
    target.legalTextSha256 = sha256HexOfText(target.legalText);
    await rewriteReleaseFile(
      "dataset.json",
      Buffer.from(`${JSON.stringify(dataset, null, 2)}\n`, "utf8"),
    );

    const release = await loadPublishedRelease(dataDirectory, loadOptions);
    const report = verifyReleaseChain(release);
    expect(report.issues.map((issue) => issue.code)).toEqual(["TEXT_MISMATCH"]);
    expect(report.derivedProvisions).toBe(0);
  });

  it("reports a verified record that no reviewer entry vouches for", async () => {
    await publishDrillRelease();
    await rewriteReleaseFile("review-log.json", Buffer.from("[]\n", "utf8"));

    const release = await loadPublishedRelease(dataDirectory, loadOptions);
    const report = verifyReleaseChain(release);
    expect(report.issues.map((issue) => issue.code)).toEqual(["UNVOUCHED_RECORD"]);
    expect(report.vouchedProvisions).toBe(0);
  });

  it("reports records whose source was never archived", async () => {
    await publishDrillRelease({ attachSources: false });
    const release = await loadPublishedRelease(dataDirectory, loadOptions);
    const report = verifyReleaseChain(release);

    expect(report.issues.map((issue) => issue.code)).toEqual(["EVIDENCE_NOT_ARCHIVED"]);
    expect(report.archivedSources).toBe(0);
    expect(report.derivedProvisions).toBe(0);
  });

  it("separates a record it could not check from a record that failed", async () => {
    await publishDrillRelease();
    const manifest = JSON.parse(
      await readFile(join(dataDirectory, "releases", releaseId, "manifest.json"), "utf8"),
    ) as { archives: { path: string }[] };
    await Promise.all(
      manifest.archives.map(async (archive) => rm(join(dataDirectory, "archive", archive.path))),
    );

    // With no local copy of the sources, nothing can be re-derived. That must
    // read as "not checked", never as "checked and fine" - the whole promise of
    // this release is that somebody can tell those apart.
    const release = await loadPublishedRelease(dataDirectory, {
      ...loadOptions,
      archivePolicy: "optional",
    });
    const report = verifyReleaseChain(release);
    expect(new Set(report.issues.map((issue) => issue.code))).toEqual(
      new Set(["ARCHIVE_NOT_PRESENT"]),
    );
    expect(report.uncheckedProvisions).toBe(release.dataset.provisionVersions.length);
    expect(report.derivedProvisions).toBe(0);
    expect(report.issues[0]?.message).toContain("no local copy");
  });
  it("reports an archived source that no record refers to", async () => {
    await publishDrillRelease();
    const strayText = drillPayload("Nguồn thừa không ai trỏ tới.");
    const strayDigest = sha256HexOfText(strayText);
    const strayPath = `${strayDigest}.rsc.txt`;
    await mkdir(join(dataDirectory, "archive"), { recursive: true });
    await writeFile(join(dataDirectory, "archive", strayPath), strayText, "utf8");
    const manifestPath = join(dataDirectory, "releases", releaseId, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      files: { path: string; sha256: string }[];
      archives: { path: string; sha256: string }[];
    };
    manifest.archives.push({ path: strayPath, sha256: strayDigest });
    await rewriteReleaseFile(
      "manifest.json",
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    );

    const release = await loadPublishedRelease(dataDirectory, loadOptions);
    const report = verifyReleaseChain(release);
    expect(report.issues.map((issue) => issue.code)).toEqual(["ORPHAN_ARCHIVE"]);
  });
});
