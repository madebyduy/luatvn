import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  parseDatasetReleaseId,
  parseIsoInstant,
  type PublishedProvisionVersion,
} from "@luatvn/domain";
import { publishRelease, sha256HexOfText } from "@luatvn/manual-dataset";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { syntheticVersionOne, syntheticVersionTwo } from "../fixtures/synthetic-legal-data.js";

const storeOptions = { allowedHosts: ["example.invalid"] } as const;

const runCli = promisify(execFile);

let dataDirectory = "";

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "luatvn-cumulate-"));
});

afterEach(async () => {
  await rm(dataDirectory, { force: true, recursive: true });
});

function datasetOf(releaseId: string, versions: readonly PublishedProvisionVersion[]): string {
  return JSON.stringify(
    {
      amendments: [],
      datasetReleaseId: releaseId,
      provisionVersions: versions.map((version) => ({
        ...version,
        datasetReleaseId: parseDatasetReleaseId(releaseId),
        legalTextSha256: sha256HexOfText(version.legalText),
      })),
      schemaVersion: 1,
    },
    null,
    2,
  );
}

async function cumulate(stagingFile: string, releaseId: string): Promise<string> {
  const { stdout } = await runCli(process.execPath, [
    join("tools", "dataset-cli.mjs"),
    "cumulate",
    stagingFile,
    "--release",
    releaseId,
    "--data-dir",
    dataDirectory,
  ]);
  return stdout;
}

describe("building the next release as the whole corpus", () => {
  // A release is a snapshot the server answers from, not a changelog. Getting
  // this wrong does not fail loudly: the new release publishes and verifies,
  // and every document from before it silently stops being served.
  it("carries the published corpus into the release built from a new crawl", async () => {
    await publishRelease(dataDirectory, datasetOf("rel_base", [syntheticVersionOne]), {
      reviewLog: [
        {
          method: "machine",
          reviewedAt: parseIsoInstant("2026-01-01T00:00:00.000Z"),
          reviewedBy: "machine:cross-check",
          target: syntheticVersionOne.provisionVersionId,
        },
      ],
      reviewedBy: "synthetic publisher",
      sources: [],
      ...storeOptions,
    });

    const stagingFile = join(dataDirectory, "staging-new.json");
    await writeFile(stagingFile, datasetOf("rel_new", [syntheticVersionTwo]), "utf8");
    await writeFile(
      `${stagingFile}.review-log.json`,
      JSON.stringify([
        {
          method: "machine",
          reviewedAt: "2026-02-02T00:00:00.000Z",
          reviewedBy: "machine:cross-check",
          target: syntheticVersionTwo.provisionVersionId,
        },
      ]),
      "utf8",
    );

    await cumulate(stagingFile, "rel_merged");

    const merged = JSON.parse(
      await readFile(join(dataDirectory, "staging-rel-merged.json"), "utf8"),
    ) as {
      datasetReleaseId: string;
      provisionVersions: { datasetReleaseId: string; provisionVersionId: string }[];
    };
    expect(
      merged.provisionVersions.map((version) => version.provisionVersionId).toSorted(),
    ).toEqual(
      [syntheticVersionOne.provisionVersionId, syntheticVersionTwo.provisionVersionId].toSorted(),
    );
    // Every record must claim the release it is being published into, or the
    // repository will not find it when the server asks for that release.
    for (const version of merged.provisionVersions) {
      expect(version.datasetReleaseId).toBe("rel_merged");
    }

    const log = JSON.parse(
      await readFile(join(dataDirectory, "staging-rel-merged.json.review-log.json"), "utf8"),
    ) as { target: string }[];
    expect(log.map((entry) => entry.target).toSorted()).toEqual(
      [syntheticVersionOne.provisionVersionId, syntheticVersionTwo.provisionVersionId].toSorted(),
    );
  });

  it("lets a re-extraction replace the text already published for that record", async () => {
    await publishRelease(dataDirectory, datasetOf("rel_base", [syntheticVersionOne]), {
      reviewLog: [],
      reviewedBy: "synthetic publisher",
      sources: [],
      ...storeOptions,
    });

    const corrected: PublishedProvisionVersion = {
      ...syntheticVersionOne,
      legalText: `${syntheticVersionOne.legalText} (bản bóc lại)`,
    };
    const stagingFile = join(dataDirectory, "staging-fix.json");
    await writeFile(stagingFile, datasetOf("rel_fix", [corrected]), "utf8");

    await cumulate(stagingFile, "rel_merged2");

    const merged = JSON.parse(
      await readFile(join(dataDirectory, "staging-rel-merged2.json"), "utf8"),
    ) as { provisionVersions: { legalText: string }[] };
    expect(merged.provisionVersions).toHaveLength(1);
    expect(merged.provisionVersions[0]?.legalText).toContain("bản bóc lại");
  });
});
